// @ts-check
/**
 * D1 视觉验收的**自动化替代**：静态核对 + 生产契约核对。
 *
 * 2026-11-14 修正：原实现声称「把设置页真实渲染出来」，实际上从未把快照
 * 喂给任何渲染函数；还硬编码读取开发者私有 profile，断言「至少 5 个角色」、
 * 「CodeBuddy / Codex 必须有模型」等某台机器某时刻的状态。用户删角色就红、
 * 产品代码改坏却可能绿 —— 属于伪测试。现改为：
 *   - 静态核对：client 源码里的用户可见文案与控件结构（不依赖任何机器路径）
 *   - 生产契约核对：直接 import 生产模块，验证 CLI_IDS / STATIC_CATALOG /
 *     QUOTA / ROLE_COLOR / deriveRoleColor 的真实导出
 * 这些断言能因生产代码回归而失败；负对照见 docs/review/independent-recheck-2026-11-14.md。
 *
 * 本脚本能自动验证的：
 * - 设置页两个区（外部 CLI 连接 / 全局角色库）、角色管理按钮与二次确认
 * - 无「右侧栏」「本对话角色」等已下线文案
 * - 两色（green/gray）、额度枚举不含 exhausted、颜色派生不依赖额度
 * - 能力目录固定 4 个 CLI、静态表不伪造 DSH 模型
 *
 * 不能自动验证的（仍需人眼 / 真机）：
 * - 视觉布局、间距、对齐、颜色实际像素
 * - 交互手感、宿主 Gateway 真实往返
 * （动态交互核对由 verify-d1-interaction.mjs 承担）
 *
 * 用法：node scripts/verify-d1-render.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// 加载真实的 client 源码做静态核对；生产契约断言则直接 import 生产模块。
// 不模拟宿主 Cordis（真实渲染由 verify-d1-interaction.mjs 与真机验收负责）。
const clientPath = join(root, 'src', 'client', 'index.js')
const source = readFileSync(clientPath, 'utf8')

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

// ── 契约核对：生产代码的能力目录 / 状态模型 ──────────────
//
// 原实现在这里断言的是 buildSnapshot() 自己造的假数据（「至少 5 个角色」
// 「CodeBuddy 必须有模型」…），既绑定开发者私有 profile，又从未把快照喂给
// 任何渲染函数 —— 产品代码改坏它照样绿，用户删个角色反而红。
// 改为直接验证**生产导出**：这些断言会因生产代码回归而失败。
const { CLI_IDS, CLI_LABELS, STATIC_CATALOG } = await import(
  pathToFileURL(join(root, 'src', 'cli', 'capabilities.js')).href
)
const { QUOTA, ROLE_COLOR, deriveRoleColor } = await import(
  pathToFileURL(join(root, 'src', 'gui', 'state-model.js')).href
)

record(
  '生产 CLI_IDS 固定为 4 个且顺序稳定',
  CLI_IDS.length === 4 && CLI_IDS.join(',') === 'dsh,claude,codex,codebuddy',
  `${CLI_IDS.length} 个：${CLI_IDS.join(' / ')}`,
)
record(
  '4 个 CLI 都有用户可见名称',
  CLI_IDS.every((id) => typeof CLI_LABELS[id] === 'string' && CLI_LABELS[id].length > 0),
  CLI_IDS.map((id) => `${id}=${CLI_LABELS[id] ?? '❌'}`).join(', '),
)
record(
  '静态目录覆盖全部 4 个 CLI（缺项必须显式为空而不是漏掉）',
  CLI_IDS.every((id) => Object.hasOwn(STATIC_CATALOG, id)),
  CLI_IDS.map((id) => `${id}:${Object.hasOwn(STATIC_CATALOG, id) ? 'ok' : '❌ 缺'}`).join(' '),
)
record(
  '静态目录没有伪造的 dsh 模型（DSH 模型必须走宿主 / 探测，不写死）',
  (STATIC_CATALOG.dsh?.models ?? []).length === 0,
  `dsh 静态模型数=${(STATIC_CATALOG.dsh?.models ?? []).length}`,
)
record(
  'Claude 静态别名与强度档位非空',
  (STATIC_CATALOG.claude?.models ?? []).length > 0 && (STATIC_CATALOG.claude?.strengths ?? []).length > 0,
  `models=${(STATIC_CATALOG.claude?.models ?? []).length} strengths=${(STATIC_CATALOG.claude?.strengths ?? []).length}`,
)

// 状态模型：两色 + 三档额度，且颜色只由「偏好 / 就绪」决定，不碰额度。
record(
  'QUOTA 只有三档且不含 exhausted',
  QUOTA.AVAILABLE === 'available' &&
    QUOTA.UNKNOWN === 'unknown' &&
    QUOTA.NOT_APPLICABLE === 'not_applicable' &&
    QUOTA.EXHAUSTED === undefined,
  JSON.stringify(QUOTA),
)
record(
  'ROLE_COLOR 只有 green/gray',
  Object.values(ROLE_COLOR).join(',') === 'gray,green',
  JSON.stringify(ROLE_COLOR),
)
record(
  '启用+就绪派生绿色，禁用派生灰色（负对照）',
  deriveRoleColor({ userPreference: 'enabled', readiness: 'ready' }) === 'green' &&
    deriveRoleColor({ userPreference: 'disabled', readiness: 'blocked' }) === 'gray',
  `enabled/ready=${deriveRoleColor({ userPreference: 'enabled', readiness: 'ready' })} disabled=${deriveRoleColor({ userPreference: 'disabled', readiness: 'blocked' })}`,
)
record(
  '额度不影响颜色（颜色契约不受 quota 干扰）',
  deriveRoleColor({ userPreference: 'enabled', readiness: 'ready', quota: 'unknown' }) === 'green',
  `quota=unknown → ${deriveRoleColor({ userPreference: 'enabled', readiness: 'ready', quota: 'unknown' })}`,
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
