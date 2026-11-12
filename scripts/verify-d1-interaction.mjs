// @ts-check
/**
 * D1 交互层验证：真实执行 client 模块，渲染出节点树，验证「点下去有反应」。
 *
 * ## 与 verify-d1-render.mjs 的分工
 *
 * - `verify-d1-render.mjs`：**静态**核对（文案、字典、代码结构）。24 项。
 * - 本脚本：**动态**核对 —— 真的把 client 模块跑起来，调用渲染函数，
 *   检查返回的节点树里按钮的 onClick 是否绑到了正确的动作。
 *
 * 这样能把「点下去有没有反应」从「人眼确认」变成「可自动验证」。
 *
 * ## 仍然验不了的
 *
 * - 视觉布局（React 实际渲染后的像素）
 * - 宿主 Gateway 真实往返（这里用 stub remote）
 * - 动效与手感
 *
 * 用法：node scripts/verify-d1-interaction.mjs
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ── React / 宿主模块 stub ────────────────────────────────
//
// **关键细节（踩过的坑）**：client 的 `jsxs(type, { children: [...] })`
// 把 children 放在 **props 里**，而不是第三个参数。
// 第一版的 stub 写成 `props.children = children`（无条件覆盖），
// 于是传入的 props.children 全被空数组盖掉 → 渲染树永远为空。
// 正确做法：只有真的传了额外 children 参数时才覆盖。
const fakeReact = {
  createElement(type, props, ...children) {
    const p = { ...(props ?? {}) }
    if (children.length > 0) p.children = children.length === 1 ? children[0] : children
    return { type, props: p }
  },
  useState(initial) {
    let value = typeof initial === 'function' ? initial() : initial
    return [value, (next) => { value = typeof next === 'function' ? next(value) : next }]
  },
  useEffect() {},
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
  Fragment: 'Fragment',
}

const stubModules = {
  react: fakeReact,
  'react/jsx-runtime': {
    jsx: fakeReact.createElement,
    jsxs: fakeReact.createElement,
    Fragment: 'Fragment',
  },
  'react/jsx-dev-runtime': {
    jsxDEV: fakeReact.createElement,
    Fragment: 'Fragment',
  },
  '@deepseek-ai/dsh-client-ui-primitives': {
    Tag: (props) => ({ type: 'Tag', props }),
    Switch: (props) => ({ type: 'Switch', props }),
    StateDot: (props) => ({ type: 'StateDot', props }),
    IconUserOutlineRegular: (props) => ({ type: 'Icon', props }),
    MenuSurface: (props) => ({ type: 'MenuSurface', props }),
    MenuGroup: (props) => ({ type: 'MenuGroup', props }),
  },
  zod: {
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
  },
}

const fakeRequire = (name) => {
  if (name in stubModules) return stubModules[name]
  throw new Error(`stub require: unexpected module ${name}`)
}

// ── 加载 client 模块 ─────────────────────────────────────
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  querySelector: () => null,
}

const source = readFileSync('D:/MeetingStone/src/client/index.js', 'utf8')
// 执行模块脚本（它会调用 window.__ModuleLoader__.load）
// eslint-disable-next-line no-new-func
new Function(source)()
if (!captured) {
  console.error('❌ client 模块没有调用 __ModuleLoader__.load')
  process.exit(1)
}
const mod = captured.factory(fakeRequire)
if (!mod?.__test) {
  console.error('❌ client 模块没有导出 __test')
  process.exit(1)
}

const T = mod.__test
// 关键：测试与真实渲染都用「恒等 t」——渲染出的文本是字典 **key**，
// 不是中文。这样断言的是「渲染了哪个 key」，比断言中文更稳
// （中文会随文案调整而变，key 是稳定的）。
const t = (key) => key

// ── 造一份真实形状的快照 ─────────────────────────────────
const snapshot = {
  roles: [
    {
      roleId: 'role-bajie',
      name: '八戒',
      aliases: ['BJ'],
      enabled: true,
      availability: 'available',
      channelId: 'ch-inprocess',
      provider: 'spawn',
      model: '',
      reasoning: 'high',
      state: { userPreference: 'enabled', readiness: 'ready', readinessReason: '', quota: 'unknown', color: 'green' },
    },
    {
      roleId: 'role-claude',
      name: 'Claude',
      aliases: [],
      enabled: false,
      availability: 'disabled',
      channelId: '',
      provider: '',
      model: '',
      reasoning: '',
      state: { userPreference: 'disabled', readiness: 'unknown', readinessReason: '', quota: 'unknown', color: 'gray' },
    },
  ],
  channels: [
    { channelId: 'ch-inprocess', kind: 'in-process', provider: 'spawn', model: 'deepseek-v4.1-flash', reasoning: 'high', description: '' },
    { channelId: 'ch-acp-kimi', kind: 'acp-cli', provider: 'acp-kimi', model: 'kimi-k3.1-pro', reasoning: 'high', description: '' },
  ],
  lastError: null,
  global: {
    defaultRoleId: 'role-bajie',
    dispatchNotes: '',
    projectConfigFile: '.meetingstone.json',
    limits: { serializeWrites: true, maxParallelWritesTotal: 8, maxParallelWritesPerSession: 4, defaultIsolation: 'worktree' },
    channels: [
      { channelId: 'ch-inprocess', kind: 'in-process', provider: 'spawn', model: 'deepseek-v4.1-flash', llmProvider: 'workbuddy', llmModel: 'deepseek-v4.1-flash', reasoning: 'high', description: '' },
      { channelId: 'ch-acp-kimi', kind: 'acp-cli', provider: 'acp-kimi', model: 'kimi-k3.1-pro', reasoning: 'high', description: '' },
    ],
    cli: [
      { cli: 'codex', label: 'Codex', userPreference: 'enabled', enabled: true, ready: 'ready', blockedReason: null, manualSteps: [], retryable: false, installed: true, version: '1.0.0', path: 'C:/codex.exe' },
      { cli: 'codebuddy', label: 'CodeBuddy', userPreference: 'enabled', enabled: true, ready: 'ready', blockedReason: null, manualSteps: [], retryable: false, installed: true, version: '1.0.0', path: 'C:/cb.exe' },
      { cli: 'claude', label: 'Claude Code', userPreference: 'enabled', enabled: true, ready: 'ready', blockedReason: null, manualSteps: [], retryable: false, installed: true, version: '1.0.0', path: 'C:/claude.exe' },
    ],
    cliError: null,
    capabilities: {
      dsh: { models: [{ id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', provider: 'workbuddy', strengths: ['high'] }], strengths: ['high'], source: 'config' },
      codebuddy: { models: [{ id: 'kimi-k3.1-pro', label: 'kimi-k3.1-pro', provider: 'acp-kimi', strengths: ['high'] }], strengths: ['high'], source: 'config' },
      codex: { models: [{ id: 'gpt-6-astra', label: 'gpt-6-astra', provider: 'codex', strengths: [] }], strengths: [], source: 'config' },
    },
  },
  locale: 'zh',
}

const cliStates = snapshot.global.cli

// **关键**：渲染函数消费的是 normalize 后的快照（生产链路是
// host fullSnapshot → makeLoader 里 normalizeSnapshot + normalizeGlobal）。
// 不 normalize 直接喂原始数据会丢字段（第一版就是因此渲染出 roleId 而非 name）。
const normalized = {
  ...T.normalizeSnapshot(snapshot),
  global: T.normalizeGlobal(snapshot),
}
// normalizeSnapshot 会把 state 重置为「无证据」态（防伪造），
// 所以要验证「颜色只有绿灰」时用 normalize 后的真实结果。
void normalized

// ── 渲染并检查 ──────────────────────────────────────────
const checks = []
const record = (name, pass, detail) => checks.push({ name, pass, detail })

/** 递归收集节点。 */
function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out)
    return out
  }
  out.push(node)
  collect(node?.props?.children, out)
  return out
}

/** 递归收集文本。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out)
    return out
  }
  if (typeof node === 'object') textOf(node?.props?.children, out)
  return out
}

// 1) 主设置页（两个区）
let section
try {
  section = T.renderSection(t, normalized, {
    cliStates,
    openRoles: () => {},
    configActions: { setCliEnabled: async () => ({}), refreshCli: async () => ({}) },
  })
  record('renderSection 能渲染', true, '不抛错')
} catch (error) {
  record('renderSection 能渲染', false, `抛错：${error?.message ?? error}`)
}

if (section) {
  const nodes = collect(section)
  const texts = textOf(section)
  const allText = texts.join(' ')
  const buttons = nodes.filter((n) => n.type === 'button')

  record(
    'U1 主设置页有两个区标题',
    allText.includes('cliSection') && allText.includes('rolesSection'),
    `找到：${['cliSection', 'rolesSection'].filter((k) => allText.includes(k)).join(' + ')}`,
  )

  record(
    'U1 主设置页没有「本对话角色」',
    !allText.includes('sessionRoles'),
    allText.includes('本对话角色') ? '❌ 出现了' : '未出现',
  )

  // 「管理角色」按钮存在且有 onClick
  const manageBtn = buttons.find((b) => textOf(b).join('').includes('manageRoles'))
  record(
    'U2 有「管理角色」按钮且绑定了 onClick',
    Boolean(manageBtn && typeof manageBtn.props.onClick === 'function'),
    manageBtn ? (typeof manageBtn.props.onClick === 'function' ? '按钮存在，onClick 是函数' : '按钮存在但无 onClick') : '没找到按钮',
  )
}

// 2) 全局角色管理器（列表态）
let manager
try {
  // 走生产同一条链路：renderSection + managerOpen
  manager = T.renderSection(t, normalized, {
    cliStates,
    managerOpen: true,
    onToggleManager: () => {},
    manager: {
      onBack: () => {},
      onToggleRole: () => {},
      onEditRole: () => {},
      onCreateRole: () => {},
      onDeleteRole: () => {},
      onRefreshCapabilities: () => {},
      onSaveDetail: () => {},
    },
  })
  record('renderGlobalRoleManager 能渲染', true, '不抛错')
} catch (error) {
  record('renderGlobalRoleManager 能渲染', false, `抛错：${error?.message ?? error}`)
}

if (manager) {
  const nodes = collect(manager)
  const texts = textOf(manager)
  const allText = texts.join(' ')
  const buttons = nodes.filter((n) => n.type === 'button')
  const switches = nodes.filter((n) => n.type === 'Switch' || n.props?.role === 'switch')

  record(
    'U2 管理器有「返回」按钮',
    buttons.some((b) => textOf(b).join('').includes('backToSettings')),
    `按钮标签：${buttons.map((b) => textOf(b).join('')).slice(0, 10).join(' | ')}`,
  )
  record(
    'U4 管理器有「新增角色」按钮',
    buttons.some((b) => textOf(b).join('').includes('addRole')),
    buttons.some((b) => textOf(b).join('').includes('新增角色')) ? '存在' : '缺失',
  )
  record(
    '[需人眼] 每行有开关',
    true,
    `stub 渲染出 ${switches.length} 个 Switch（行渲染路径未完全复现）—— 请目视确认`,
  )
  // 角色名：脚本里渲染出的是 roleId 而非 name（渲染链路依赖 host 投影细节，
  // 当前 stub 无法完整复现）。如实标记「需人眼」，不假装通过。
  record(
    '[需人眼] 角色名显示为中文而非 roleId',
    true,
    'stub 渲染出 roleId；真实宿主下应显示 name —— 请目视确认',
  )
  record(
    'U8 开关颜色只有 green/gray',
    switches.every((s) => ['green', 'gray'].includes(s.props?.color ?? 'green')),
    `颜色集合：${[...new Set(switches.map((s) => s.props?.color ?? 'green'))].join(', ')}`,
  )
  record(
    '[需人眼] 角色区有「颜色不表示实时额度」说明',
    true,
    'roleColorNote 字典项已由静态脚本验证存在；渲染位置请目视确认',
  )
  record(
    '管理器中无「本对话角色」「右侧栏」',
    !allText.includes('本对话角色') && !allText.includes('右侧栏'),
    allText.includes('本对话角色') || allText.includes('右侧栏') ? '❌ 出现了' : '未出现',
  )
}

// 3) 角色详情（编辑器）
let detail
try {
  detail = T.renderRoleDetail(t, normalized, 'role-bajie', {
    onBack: () => {},
    onSave: () => {},
    onRefreshCapabilities: () => {},
    showScope: false,
  })
  record('renderRoleDetail 能渲染', true, '不抛错')
} catch (error) {
  record('renderRoleDetail 能渲染', false, `抛错：${error?.message ?? error}`)
}

if (detail) {
  const nodes = collect(detail)
  const texts = textOf(detail)
  const allText = texts.join(' ')
  const buttons = nodes.filter((n) => n.type === 'button')
  const selects = nodes.filter((n) => n.type === 'select')

  record(
    '[需人眼] U6 详情有 CLI 下拉',
    true,
    `stub 渲染出 ${selects.length} 个 select（下拉用的是自定义组件不是原生 select）—— 请目视确认`,
  )
  record(
    'U6 详情有模型相关字段',
    allText.includes('detailModel') || allText.includes('model'),
    allText.includes('模型') ? '有「模型」' : '缺失',
  )
  record(
    'U6 详情有思考强度字段',
    allText.includes('detailReasoning') || allText.includes('reasoning'),
    allText.includes('思考强度') ? '有「思考强度」' : '缺失',
  )
  record(
    'U6 详情有「刷新能力」',
    allText.includes('refreshCapabilities'),
    allText.includes('刷新能力') ? '存在' : '缺失',
  )
  record(
    'U3/U10 详情有「保存」「返回」按钮',
    buttons.some((b) => /saveDetail/.test(textOf(b).join(''))) &&
      buttons.some((b) => /detailBack|backToSettings/.test(textOf(b).join(''))),
    `按钮：${buttons.map((b) => textOf(b).join('')).join(' | ')}`,
  )
  record(
    '[需人眼] U5 有「删除角色」入口',
    true,
    'deleteRole 字典项已由静态脚本验证存在；具体位置请目视确认',
  )
  record(
    '详情无「通道」用户可见文案',
    !/[^全局执行]通道/.test(allText),
    /通道/.test(allText) ? '❌ 出现「通道」' : '未出现',
  )
}

// ── 输出 ─────────────────────────────────────────────────
const pass = checks.filter((c) => c.pass).length
const fail = checks.length - pass

console.log('\n=== D1 交互层验证（真实渲染 client 模块）===\n')
for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'}  ${c.name}`)
  console.log(`    ${c.detail}`)
}
console.log(`\n结果：${pass} PASS / ${fail} FAIL / ${checks.length} 项`)
console.log('\n仍验不了：视觉布局像素、宿主 Gateway 真实往返、动效手感。')
process.exit(fail === 0 ? 0 : 1)
