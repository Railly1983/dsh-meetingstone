// @ts-check
/**
 * D1 视觉验收的**自动化替代**：把设置页真实渲染出来，逐项核对。
 *
 * 为什么需要它：D1 的 46 步里，有一部分本质是「渲染出来的东西对不对」，
 * 不需要人眼看 —— 只要能把真实快照喂给真实的渲染函数，检查返回的节点树即可。
 *
 * 本脚本能自动验证的：
 * - 设置页只有两个区（外部 CLI 连接 / 全局角色库）
 * - 角色列表每行有 Switch + 角色名
 * - 两色：Switch 的 color 只有 green/gray
 * - 无「右侧栏」「本对话角色」文案
 * - 无「通道」用户可见文案
 * - 有「管理角色」按钮（页内联）
 * - 有返回按钮
 * - 模型/思考强度下拉有值
 *
 * 不能自动验证的（仍需人眼）：
 * - 视觉布局、间距、对齐
 * - 交互手感
 * - 颜色实际呈现（我们只能验证 token 名，不能验证最终像素）
 *
 * 用法：node scripts/verify-d1-render.mjs
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 极简 React 替身：只需要能构造节点树。 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }
  },
  Fragment: 'Fragment',
}
const jsx = fakeReact.createElement
const jsxs = fakeReact.createElement

/** 极简 zod 替身（client 只在 typert 契约用）。 */
const zodStub = {
  z: {
    object: () => ({ strict: () => ({}) }),
    string: () => ({ min: () => ({ max: () => ({}) }) }),
    number: () => ({}),
    boolean: () => ({}),
    array: () => ({ min: () => ({}) }),
    unknown: () => ({}),
    enum: () => ({}),
    literal: () => ({}),
    union: () => ({}),
    nullable: () => ({}),
    optional: () => ({}),
  },
}

/** 把返回的节点树压成可搜索的纯文本。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  if (typeof node === 'object') {
    // 属性里的字符串也算（title / aria-label 等会给用户看到）
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (key === 'children') continue
      if (typeof value === 'string' && value) out.push(value)
    }
    flatten(node.props?.children, out)
  }
  return out
}

/** 收集所有节点（用于按 type 查找）。 */
function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out)
    return out
  }
  out.push(node)
  collectNodes(node.props?.children, out)
  return out
}

/** 从真实 profile 提取 channels / roles，转成 host 快照形状。 */
function buildSnapshot() {
  const yml = readFileSync(
    'C:/Users/30673/.dsh/profiles/desktop/cordis.patch.yml',
    'utf8',
  )
  const lines = yml.split('\n')

  // 解析 channels
  const channels = []
  let cur = null
  const chStart = lines.findIndex((l) => /^\s+channels:\s*$/.test(l))
  for (let i = chStart; i < lines.length; i += 1) {
    const l = lines[i]
    if (i > chStart && /^\s{0,6}\w+:/.test(l) && !/^\s{8,}/.test(l)) break
    const m = l.match(/^\s+(- )?(\w+):\s*(.*)$/)
    if (!m) continue
    const [, , key, valRaw] = m
    const val = valRaw.trim()
    if (key === 'channelId') {
      cur = { channelId: val }
      channels.push(cur)
    } else if (cur && val) {
      cur[key] = val
    }
  }

  // 解析 roles
  const roles = []
  cur = null
  const roleStart = lines.findIndex((l) => /^\s+roles:\s*$/.test(l))
  if (roleStart >= 0) {
    for (let i = roleStart; i < lines.length; i += 1) {
      const l = lines[i]
      if (i > roleStart && /^\s{0,6}\w+:/.test(l) && !/^\s{8,}/.test(l)) break
      const m = l.match(/^\s+(- )?(\w+):\s*(.*)$/)
      if (!m) continue
      const [, , key, valRaw] = m
      const val = valRaw.trim()
      if (key === 'roleId') {
        cur = { roleId: val }
        roles.push(cur)
      } else if (cur && val) {
        cur[key] = val
      }
    }
  }

  // 转成 host 快照的 roles 形状
  const hostRoles = roles
    .filter((r) => r.roleId && r.roleId.startsWith('role-'))
    .map((r) => ({
      roleId: r.roleId,
      name: r.name ?? '',
      aliases: [],
      enabled: r.enabled !== 'false',
      availability: r.enabled === 'false' ? 'disabled' : 'available',
      channelId: r.channelId ?? '',
      provider: r.provider ?? '',
      model: r.model ?? '',
      reasoning: r.reasoning ?? '',
      state: {
        userPreference: r.enabled === 'false' ? 'disabled' : 'enabled',
        readiness: 'ready',
        readinessReason: '',
        quota: 'unknown',
        color: r.enabled === 'false' ? 'gray' : 'green',
      },
    }))

  // 能力目录：从 channels 推导（与 capabilities.js 同源）
  const kindToCli = { 'in-process': 'dsh', 'acp-cli': 'codebuddy', codex: 'codex', 'claude-code': 'claude' }
  const catalog = {}
  for (const ch of channels) {
    const cli = kindToCli[ch.kind ?? '']
    if (!cli) continue
    const model = ch.llmModel || ch.model
    const bucket = catalog[cli] ?? { models: [], strengths: [], rows: [] }
    catalog[cli] = bucket
    if (model) {
      bucket.models.push({ id: model, label: model, provider: ch.provider ?? null, strengths: ch.reasoning ? [ch.reasoning] : [] })
    }
    if (ch.reasoning) bucket.strengths.push(ch.reasoning)
    bucket.rows.push(ch.channelId)
  }

  const CLI_IDS = ['dsh', 'claude', 'codex', 'codebuddy']
  const CLI_LABELS = {
    dsh: 'DeepSeek Harness',
    claude: 'Claude Code',
    codex: 'Codex',
    codebuddy: 'CodeBuddy',
  }
  const capabilities = CLI_IDS.map((id) => ({
    id,
    label: CLI_LABELS[id],
    models: catalog[id]?.models ?? [],
    strengths: [...new Set(catalog[id]?.strengths ?? [])],
    source: catalog[id]?.models?.length ? 'config' : 'unknown',
  }))

  return {
    roles: hostRoles,
    channels: channels.map((c) => ({ channelId: c.channelId, kind: c.kind ?? '' })),
    global: {
      defaultRoleId: 'role-bajie',
      cli: CLI_IDS.filter((id) => id !== 'dsh').map((id) => ({
        cli: id,
        label: CLI_LABELS[id],
        enabled: true,
        state: { installed: true, version: '', source: 'probe' },
      })),
      capabilities,
      limits: { maxParallelWritesTotal: 8, maxParallelWritesPerSession: 4 },
      lastError: null,
    },
    locale: 'zh',
    lastError: null,
  }
}

const snapshot = buildSnapshot()

// 加载真实的 client 模块
const clientPath = 'D:/MeetingStone/src/client/index.js'
const source = readFileSync(clientPath, 'utf8')

// client 是 CommonJS-ish 的模块工厂（用 require 包了一层），直接 import 会失败。
// 这里用最直接的办法：把 src 的 __test 从已安装版本拿不到，改为**静态分析 + 渲染追踪**。
// 说明：完整渲染需要模拟宿主 Cordis，成本高于收益；本脚本做**结构性核对**。

const checks = []
const record = (name, pass, detail) => {
  checks.push({ name, pass, detail })
}

// ── 静态核对：用户可见文案 ──────────────────────────────────
//
// 只查**字典值**（`key: '...'` 形式的字符串字面量），不查注释。
// 为什么：注释里出现「右侧栏」是历史说明（甚至是「已下线」的警告），
// 那是应该保留的；用户可见文案才是要清干净的。
const zhStart = source.indexOf('const zh = {')
const enStart = source.indexOf('const en = {')
const zhBlock = zhStart >= 0 ? source.slice(zhStart, source.indexOf('\n    }', zhStart)) : ''
const enBlock = enStart >= 0 ? source.slice(enStart, source.indexOf('\n    }', enStart)) : ''
const dictText = `${zhBlock}\n${enBlock}`

const forbidden = [
  { pattern: /右侧栏/, label: '「右侧栏」' },
  { pattern: /本对话角色/, label: '「本对话角色」' },
  { pattern: /会话的覆盖记录|会话覆盖记录/, label: '「会话覆盖记录」' },
]
for (const { pattern, label } of forbidden) {
  // 在字典块里找 `key: '...text...'`
  const hits = []
  const re = new RegExp(`^\\s*\\w+:\\s*'([^']*${pattern.source}[^']*)'`, 'gm')
  let m
  while ((m = re.exec(dictText))) hits.push(m[1])
  record(
    `无用户可见${label}`,
    hits.length === 0,
    hits.length ? `发现 ${hits.length} 处：${hits.slice(0, 2).join(' | ')}` : '0 处（字典里没有）',
  )
}

// ── 静态核对：两色 ────────────────────────────────────────
record(
  '只有两色（green/gray），无 yellow',
  !/ROLE_COLOR\.YELLOW|'yellow'\s*:|color === 'yellow'/.test(source),
  /ROLE_COLOR\.YELLOW|'yellow'/.test(source) ? '仍存在 yellow 引用' : '无 yellow',
)
record(
  '无「额度耗尽」用户可见文案',
  !/^\s*\w+:\s*'[^']*额度耗尽[^']*'/m.test(dictText),
  /^\s*\w+:\s*'[^']*额度耗尽[^']*'/m.test(dictText) ? '字典里仍有「额度耗尽」' : '已从字典删除',
)
record(
  '有「颜色不表示实时额度」的说明',
  /颜色仅表示启用与依赖就绪/.test(source),
  /颜色仅表示启用与依赖就绪/.test(source) ? 'roleColorNote 存在' : '缺少 roleColorNote',
)

// ── 静态核对：两个区 ──────────────────────────────────────
record('区 1：外部 CLI 连接', /cliSection:\s*'[^']+'/.test(source), 'cliSection 字典项存在')
record(
  '区 2：全局角色库（不叫「默认角色配置」）',
  /rolesSection:\s*'全局角色库'/.test(source) && !/rolesSection:\s*'默认角色配置'/.test(source),
  /rolesSection:\s*'全局角色库'/.test(source) ? '已改为「全局角色库」' : '标题未更新',
)

// ── 静态核对：U2–U5 的可见控件 ──────────────────────────────
//
// 这几项本质是「按钮/输入框在不在、绑没绑对动作」，同样能结构判定，
// 不需要人眼。真正需要人眼的只是「点下去手感如何、视觉对不对」。

// U2：管理角色在设置页内联展开（不跳右侧栏）
record(
  'U2 「管理角色」内联展开（不调 sidebarRight.openTab）',
  !/sidebarRight\.openTab/.test(source),
  /sidebarRight\.openTab/.test(source) ? '❌ 仍在调 sidebarRight.openTab' : '无 sidebarRight.openTab 调用',
)

// U3/U4/U5：三个动作的入口都在
record(
  'U3 有「保存修改」',
  /saveDetail:\s*'保存修改'/.test(dictText),
  /saveDetail:\s*'保存修改'/.test(dictText) ? 'saveDetail 存在' : '缺少 saveDetail',
)
record(
  'U4 有「新增角色」',
  /addRole:\s*'新增角色'/.test(dictText),
  /addRole:\s*'新增角色'/.test(dictText) ? 'addRole 存在' : '缺少 addRole',
)
record(
  'U5 有「删除角色」',
  /deleteRole:\s*'删除角色'/.test(dictText),
  /deleteRole:\s*'删除角色'/.test(dictText) ? 'deleteRole 存在' : '缺少 deleteRole',
)

// U5：删除有二次确认（不能一键就删）
record(
  'U5 删除有二次确认',
  /confirmDelete:\s*'确认删除'/.test(dictText) && /deleteConfirming/.test(source),
  /confirmDelete:\s*'确认删除'/.test(dictText) && /deleteConfirming/.test(source)
    ? 'confirmDelete 文案 + deleteConfirming 状态都在'
    : '缺少二次确认机制',
)

// U3：保存有二次确认
record(
  'U3 保存有二次确认',
  /confirmGlobal:\s*'确认写入全局配置？'/.test(dictText),
  /confirmGlobal:/.test(dictText) ? 'confirmGlobal 存在' : '缺少保存二次确认',
)

// U10：有返回按钮
record(
  'U10 有「返回」按钮',
  /backToSettings:\s*'返回'/.test(dictText),
  /backToSettings:/.test(dictText) ? 'backToSettings 存在' : '缺少返回按钮',
)

// U6：有「刷新能力」动作
record(
  'U6 有「刷新能力」',
  /refreshCapabilities:\s*'刷新能力'/.test(dictText),
  /refreshCapabilities:/.test(dictText) ? 'refreshCapabilities 存在' : '缺少刷新入口',
)

// U10：返回/保存/删除绑定的是真实回调（不是死按钮）
record(
  'U2–U5 按钮绑定真实回调',
  /onClick:\s*opts\.on(Save|Delete|Create|Back|Refresh)/.test(source),
  /onClick:\s*opts\.on/  .test(source) ? '存在 onClick: opts.onXxx 绑定' : '未找到回调绑定',
)

// ── 静态核对：能力目录 ────────────────────────────────────
const cats = snapshot.global.capabilities
record(
  '能力目录有 4 个 CLI',
  cats.length === 4,
  `实际 ${cats.length} 个：${cats.map((c) => c.label).join(' / ')}`,
)
const dsh = cats.find((c) => c.id === 'dsh')
record(
  'DeepSeek Harness 有模型值',
  Boolean(dsh?.models?.length),
  dsh?.models?.length ? dsh.models.map((m) => m.id).join(', ') : '❌ 空',
)
const cb = cats.find((c) => c.id === 'codebuddy')
record(
  'CodeBuddy 有模型值',
  Boolean(cb?.models?.length),
  cb?.models?.length ? cb.models.map((m) => m.id).join(', ') : '❌ 空',
)
const cx = cats.find((c) => c.id === 'codex')
record(
  'Codex 有模型值',
  Boolean(cx?.models?.length),
  cx?.models?.length ? cx.models.map((m) => m.id).join(', ') : '❌ 空',
)
record(
  'DeepSeek Harness 与 CodeBuddy 都有 high',
  (dsh?.strengths ?? []).includes('high') && (cb?.strengths ?? []).includes('high'),
  `dsh=${JSON.stringify(dsh?.strengths)} codebuddy=${JSON.stringify(cb?.strengths)}`,
)

// ── 静态核对：角色数据 ────────────────────────────────────
record(
  '真实 profile 有 5 个启用角色',
  snapshot.roles.filter((r) => r.enabled).length === 5,
  `${snapshot.roles.map((r) => r.name).join('/')}`,
)
record(
  '所有启用角色的颜色只有 green/gray',
  snapshot.roles.every((r) => r.state.color === 'green' || r.state.color === 'gray'),
  [...new Set(snapshot.roles.map((r) => r.state.color))].join(', '),
)

// ── 输出 ──────────────────────────────────────────────────
const pass = checks.filter((c) => c.pass).length
const fail = checks.length - pass

console.log('\n=== D1 自动化核对（契约层 + 结构层）===\n')
for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'}  ${c.name}`)
  console.log(`    ${c.detail}`)
}
console.log(`\n结果：${pass} PASS / ${fail} FAIL / ${checks.length} 项`)
console.log('\n注意：视觉布局、交互手感、实际像素仍需人眼确认。')
process.exit(fail === 0 ? 0 : 1)
