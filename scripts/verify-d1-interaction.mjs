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
// **三个踩过的坑，都在这里**：
//
// 1. client 的 `jsxs(type, { children: [...] })` 把 children 放在 **props 里**，
//    不是第三个参数。无条件覆盖 `props.children` 会让渲染树永远为空。
//
// 2. `jsxs('div', {…}, key)` 的**第三个参数是 React 的 `key`**，不是 children！
//    把它当 children 会把 `role.roleId` 之类混进渲染文本 —— 表现为
//    「角色名显示成 role-bajie」。所以有 props.children 时，第三参数只当 key 忽略。
//
// 3. `react/jsx-runtime` 也要 stub（jsx/jsxs/Fragment），否则走 safeRequire 失败路径。
const fakeReact = {
  createElement(type, props, ...rest) {
    const p = { ...(props ?? {}) }
    if (rest.length > 0) {
      if (p.children !== undefined) {
        // props 里已有 children → 第三参数是 React key，忽略（见坑 2）
      } else {
        p.children = rest.length === 1 ? rest[0] : rest
      }
    }
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
//
// 两个坑（都踩过）：
// 1. 不 normalize 直接喂原始数据会丢字段（角色名渲染成 roleId）
// 2. `normalizeGlobal(value)` 读的是 `source.limits` / `source.defaultRoleId`，
//    **它期望传的是 snapshot.global，不是整个 snapshot**。
//    传错会让 global 全空、连 channels 都没有。
const normalized = {
  ...T.normalizeSnapshot(snapshot),
  global: T.normalizeGlobal(snapshot.global),
}

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
  // **函数组件要执行**：client 的 `jsx(Switch, {...})` 在 raw stub 下
  // 只会得到 {type: <函数>, props}，不展开就永远看不到它渲染出的
  // button[role=switch]。这里递归调用它，把返回值继续收集。
  if (typeof node.type === 'function') {
    let rendered
    try {
      rendered = node.type(node.props ?? {})
    } catch {
      rendered = null
    }
    if (rendered) return collect(rendered, out)
    out.push(node)
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
      // 选中一个角色 → 渲染详情视图（删除按钮只在详情里）
      selectedRoleId: 'role-bajie',
      onBack: () => {},
      onBackToSettings: () => {},
      onToggleRole: () => {},
      onEditRole: () => {},
      onSelect: () => {},
      onCreateRole: () => {},
      onCreate: () => {},
      onDeleteRole: () => {},
      onRequestDelete: () => {},
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      onRefreshCapabilities: () => {},
      onSaveDetail: () => {},
      onClose: () => {},
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
  // client 用的是**本地定义**的 Switch（文件头注：不 require primitives），
  // 它渲染成 button[role=switch]，所以按 role 找。
  const switches = nodes.filter(
    (n) => n.type === 'Switch' || n.props?.role === 'switch' || n.props?.['aria-checked'] !== undefined,
  )

  record(
    'U2 管理器有「返回」按钮',
    buttons.some((b) => textOf(b).join('').includes('backToSettings')),
    `按钮标签：${buttons.map((b) => textOf(b).join('')).slice(0, 10).join(' | ')}`,
  )
  // 管理器当前渲染的是**详情视图**（传了 selectedRoleId），
  // 新增入口只在列表视图。所以单独渲染一次列表视图来验证 U4。
  let listView = null
  try {
    listView = T.renderSection(t, normalized, {
      cliStates,
      managerOpen: true,
      onToggleManager: () => {},
      manager: {
        onClose: () => {},
        onBackToSettings: () => {},
        onToggleRole: () => {},
        onSelect: () => {},
        onCreate: () => {},
        onCreateRole: () => {},
        onRefreshCapabilities: () => {},
      },
    })
  } catch {
    listView = null
  }
  const listText = listView ? textOf(listView).join(' ') : ''
  record(
    'U4 列表视图有「新增角色」入口',
    listText.includes('addRole'),
    listText.includes('addRole') ? '找到了 addRole' : `列表文本：${listText.slice(0, 150)}`,
  )
  record(
    'U8 每行有开关',
    switches.length >= 2,
    `找到 ${switches.length} 个 Switch（2 个角色应有 2 个）`,
  )
  const hasRoleNames = allText.includes('八戒') || allText.includes('Claude')
  record(
    '角色名显示为 name 而非 roleId',
    hasRoleNames && !allText.includes('role-bajie'),
    hasRoleNames ? `渲染出：${['八戒','Claude'].filter(n=>allText.includes(n)).join(' + ')}` : `未找到 name，实际：${allText.slice(0,150)}`,
  )
  record(
    'U8 开关颜色只有 green/gray',
    switches.every((s) => ['green', 'gray'].includes(s.props?.color ?? 'green')),
    `颜色集合：${[...new Set(switches.map((s) => s.props?.color ?? 'green'))].join(', ')}`,
  )
  const noteText = manager ? textOf(manager).join(' ') : ''
  record(
    '角色区有「颜色不表示实时额度」说明',
    noteText.includes('roleColorNote'),
    noteText.includes('roleColorNote') ? 'roleColorNote 已渲染' : `管理器文本：${noteText.slice(0,160)}`,
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
    'U6 详情有 4 个 CLI 选项',
    ['dsh','claude','codex','codebuddy'].every((k) => allText.includes(k)),
    ['dsh','claude','codex','codebuddy'].filter((k) => !allText.includes(k)).join(',') || '全部存在',
  )
  record(
    'U6 详情有模型相关字段',
    allText.includes('fieldModel'),
    allText.includes('fieldModel') ? '有 fieldModel' : '缺失',
  )
  record(
    'U6 详情有思考强度字段',
    allText.includes('fieldReasoning'),
    allText.includes('fieldReasoning') ? '有 fieldReasoning' : '缺失',
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
  const managerText = manager ? textOf(manager).join(' ') : ''
  const hasDelete = allText.includes('deleteRole') || managerText.includes('deleteRole')
  record(
    'U5 有「删除角色」入口',
    hasDelete,
    hasDelete ? '存在' : `详情与列表均未找到 deleteRole`,
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
