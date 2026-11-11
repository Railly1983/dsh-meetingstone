// @ts-check
/**
 * U2+U3 最终 UI 的行为单测（stub harness，不依赖 React 真渲染）。
 *
 * 覆盖验收点：
 * - 设置页只剩两区、CLI 开关预检失败保持关（渲染 + 客户端收口）；
 * - 角色列表三色派生（来自 Host roleStates）与二态开关；
 * - 会话写只产生当前会话覆盖（只写差异、失败不 reload）；
 * - 恢复继承 / 详情字段来源 / 全局 patch 二次确认前的差异计算；
 * - 详情选项只列真实通道（不新增模型注册表）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 极简 React：只给 __test 纯函数用，不渲染状态机。 */
function fakeReact() {
  return {
    useState(initial) {
      return [initial, () => {}]
    },
    useEffect() {},
    useId: () => 'stub-id',
  }
}

/** 执行浏览器 half，只取 exports（不 apply，不需要 ctx）。 */
async function loadClient() {
  const fakeRequire = (name) => {
    if (name === 'react/jsx-runtime') {
      return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
    }
    if (name === 'react') return fakeReact()
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      throw new Error('must not require primitives')
    }
    if (name === 'zod') return { z }
    throw new Error(`unexpected module ${name}`)
  }
  let captured = null
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } }
  try {
    const source = pathToFileURL(join(ROOT, 'src/client/index.js')).href
    await import(`${source}?u2=${Math.random()}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.ok(captured, 'client factory 必须被捕获')
  return captured.factory(fakeRequire)
}

/** 递归收集文本（函数组件展开一次）。 */
function collectStrings(node, acc = []) {
  if (node === null || node === undefined) return acc
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node))
    return acc
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, acc)
    return acc
  }
  if (typeof node === 'object') {
    const props = node.props || {}
    if (typeof node.type === 'function' && props.children === undefined) {
      collectStrings(node.type(props), acc)
      return acc
    }
    if (props.children !== undefined) collectStrings(props.children, acc)
  }
  return acc
}

/** 收集全部匹配节点（函数组件展开一次）。 */
function collectNodes(node, pred, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (pred(node)) acc.push(node)
  const props = node.props || {}
  if (typeof node.type === 'function' && props.children === undefined) {
    collectNodes(node.type(props), pred, acc)
    return acc
  }
  const children = Array.isArray(props.children) ? props.children : props.children ? [props.children] : []
  for (const child of children) collectNodes(child, pred, acc)
  return acc
}

const ROLE = {
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  description: '骨干',
  prompt: '少说多做',
  enabled: true,
  channel: {
    channelId: 'ch-acp',
    kind: 'acp-cli',
    provider: 'acp',
    model: 'm1',
    reasoning: 'low',
  },
}

const CHANNELS = [
  { channelId: 'ch-acp', description: '', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low' },
  { channelId: 'ch-codex', description: '', kind: 'codex', provider: 'codex', model: 'sol-1', reasoning: 'high' },
]

function viewWith(roles, extra = {}) {
  return {
    roles,
    defaultRoleId: '',
    defaultRoleSource: 'default',
    channels: CHANNELS,
    warnings: [],
    ...extra,
  }
}

test('buildSessionChanges：只产生真实差异；等值 → 空；空名称/清空 Prompt 有明确语义', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const same = __test.draftOfRole(ROLE)
  assert.deepEqual(__test.buildSessionChanges(t, ROLE, same, CHANNELS).changes, [], '没有修改就不写')

  const changed = __test.buildSessionChanges(
    t,
    ROLE,
    { ...same, name: '沙僧2', model: 'm2', prompt: '' },
    CHANNELS,
  )
  assert.equal(changed.error, null)
  assert.deepEqual(changed.changes, [
    { field: 'name', value: '沙僧2' },
    { field: 'prompt', restore: true },
    { field: 'channel.model', value: 'm2' },
  ])

  const invalid = __test.buildSessionChanges(t, ROLE, { ...same, name: '   ' }, CHANNELS)
  assert.equal(invalid.error, 'detailInvalidName')
  assert.deepEqual(invalid.changes, [])
})

test('buildSessionChanges：切换通道实例时对齐 kind/provider/model/reasoning', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const draft = { ...__test.draftOfRole(ROLE), channelId: 'ch-codex' }
  const built = __test.buildSessionChanges(t, ROLE, draft, CHANNELS)
  assert.equal(built.error, null)
  assert.deepEqual(built.changes, [
    { field: 'channel.channelId', value: 'ch-codex' },
    { field: 'channel.kind', value: 'codex' },
    { field: 'channel.provider', value: 'codex' },
    { field: 'channel.model', value: 'sol-1' },
    { field: 'channel.reasoning', value: 'high' },
  ])
})

test('buildGlobalPatch：只写差异；清空 Prompt 在全局层无效（不伪造删除）', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const same = __test.draftOfRole(ROLE)
  assert.deepEqual(__test.buildGlobalPatch(t, ROLE, same, CHANNELS).patch, {})

  const changed = __test.buildGlobalPatch(
    t,
    ROLE,
    { ...same, description: '新描述', model: 'm2' },
    CHANNELS,
  )
  assert.deepEqual(changed.patch, { description: '新描述', channel: { model: 'm2' } })

  const cleared = __test.buildGlobalPatch(t, ROLE, { ...same, prompt: '' }, CHANNELS)
  assert.equal(cleared.error, 'detailInvalidPrompt')
})

test('toggleSessionRole：只写 enabled 会话覆盖；失败不 reload、不做乐观更新', async () => {
  const { __test } = await loadClient()
  const writes = []
  let reloads = 0
  const failure = { ok: false, error: { code: 'SESSION_CONFIG_WRITE_FAILED', message: '写失败' } }

  const failed = await __test.toggleSessionRole({
    roleId: 'role-sashi',
    next: true,
    setOverride: async (...args) => {
      writes.push(args)
      return failure
    },
    reload: async () => {
      reloads += 1
      return { ok: true, view: { roles: [] } }
    },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'SESSION_CONFIG_WRITE_FAILED')
  assert.equal(reloads, 0, '失败不得 reload（否则会掩盖未写入）')
  assert.deepEqual(writes, [['role-sashi', 'enabled', true]], '只写当前会话 enabled')

  const okView = viewWith([{ ...ROLE, enabled: false }])
  const ok = await __test.toggleSessionRole({
    roleId: 'role-sashi',
    next: false,
    setOverride: async (...args) => {
      writes.push(args)
      return { ok: true, value: { ok: true, written: true } }
    },
    reload: async () => {
      reloads += 1
      return { ok: true, view: okView }
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(reloads, 1)
  assert.equal(ok.view, okView)
})

test('saveSessionChanges：逐字段只写差异；失败立即停止且不 reload', async () => {
  const { __test } = await loadClient()
  const writes = []
  let reloads = 0
  const reload = async () => {
    reloads += 1
    return { ok: true, view: viewWith([]) }
  }

  const saved = await __test.saveSessionChanges({
    roleId: 'role-sashi',
    changes: [
      { field: 'name', value: 'A' },
      { field: 'channel.model', value: 'm2' },
    ],
    setOverride: async (...args) => {
      writes.push(['set', ...args])
      return { ok: true }
    },
    clearOverride: async () => ({ ok: true }),
    reload,
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.applied, 2)
  assert.equal(reloads, 1)
  assert.deepEqual(writes, [
    ['set', 'role-sashi', 'name', 'A'],
    ['set', 'role-sashi', 'channel.model', 'm2'],
  ])

  const stopped = await __test.saveSessionChanges({
    roleId: 'role-sashi',
    changes: [{ field: 'name', value: 'A' }, { field: 'description', value: 'x' }],
    setOverride: async () => ({ ok: false, error: { code: 'BAD', message: 'bad' } }),
    clearOverride: async () => ({ ok: true }),
    reload,
  })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.applied, 0)
  assert.equal(reloads, 1, '第一次成功后才 reload；失败路径不 reload')

  const restored = await __test.saveSessionChanges({
    roleId: 'role-sashi',
    changes: [{ field: 'prompt', restore: true }],
    setOverride: async () => {
      throw new Error('不应写 setOverride')
    },
    clearOverride: async (...args) => {
      writes.push(['clear', ...args])
      return { ok: true }
    },
    reload: async () => ({ ok: true, view: viewWith([]) }),
  })
  assert.equal(restored.ok, true)
  assert.deepEqual(writes.at(-1), ['clear', 'role-sashi', 'prompt'])
})

test('normalizeSessionConfigView：三色派生 + 字段来源 + 选项只来自真实通道', async () => {
  const { __test } = await loadClient()
  const view = __test.normalizeSessionConfigView({
    effective: {
      roles: [
        { ...ROLE, roleId: 'r-green', name: '绿' },
        { ...ROLE, roleId: 'r-yellow', name: '黄' },
        { ...ROLE, roleId: 'r-gray', name: '灰', enabled: false },
      ],
    },
    overrides: {},
    sources: {
      roles: {
        'r-green': { layer: 'global', fields: { name: 'global', 'channel.model': 'session' } },
      },
    },
    channels: CHANNELS,
    roleStates: [
      { roleId: 'r-green', userPreference: 'enabled', readiness: 'ready', quota: 'unknown', color: 'green' },
      { roleId: 'r-yellow', userPreference: 'enabled', readiness: 'ready', quota: 'exhausted', color: 'yellow' },
      { roleId: 'r-gray', userPreference: 'disabled', readiness: 'blocked', quota: 'unknown', color: 'gray' },
    ],
  })
  assert.deepEqual(view.roles.map((role) => role.state.color), ['green', 'yellow', 'gray'])
  assert.equal(view.roles[0].fieldSources['channel.model'], 'session')
  assert.equal(view.roles[0].fieldSources.name, 'global')
  assert.equal(view.roles[0].fieldSources.description, 'default')
  assert.deepEqual(view.channels.map((channel) => channel.channelId), ['ch-acp', 'ch-codex'])
})

test('renderRoleList：只有名称 + 三色二态开关；阻断原因给出说明', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const view = viewWith([
    {
      ...__test.normalizeSessionConfigView({
        effective: { roles: [ROLE] },
        sources: { roles: {} },
        roleStates: [{ roleId: 'role-sashi', readiness: 'ready', color: 'green' }],
      }).roles[0],
    },
    {
      ...__test.normalizeSessionConfigView({
        effective: { roles: [{ ...ROLE, roleId: 'role-bajie', name: '八戒' }] },
        sources: { roles: {} },
        roleStates: [{ roleId: 'role-bajie', readiness: 'blocked', readinessReason: 'PROVIDER_UNAVAILABLE', color: 'gray' }],
      }).roles[0],
    },
    {
      ...__test.normalizeSessionConfigView({
        effective: { roles: [{ ...ROLE, roleId: 'role-xiaobai', name: '小白', enabled: false }] },
        sources: { roles: {} },
        roleStates: [{ roleId: 'role-xiaobai', readiness: 'ready', color: 'gray', userPreference: 'disabled' }],
      }).roles[0],
    },
  ])
  const tree = __test.renderRolePane(t, view)
  const strings = collectStrings(tree)
  assert.ok(strings.includes('沙僧') && strings.includes('八戒'))
  assert.ok(!strings.includes('SS'), '列表不显示别名')
  assert.ok(!strings.includes('m1'), '列表不显示模型')
  const switches = collectNodes(tree, (node) => node.type === 'button' && node.props?.role === 'switch')
  assert.equal(switches.length, 3)
  assert.deepEqual(switches.map((node) => node.props['aria-checked']), [true, true, false])
  assert.ok(strings.some((value) => String(value).startsWith('roleBlocked')), '阻断原因可见')
  assert.ok(strings.includes('roleDisabled'), '关闭原因可见')
  assert.equal(__test.renderRolePane(t, viewWith([])).props.children.length > 0, true, '空列表仍渲染说明')
})

test('renderRoleDetail：字段来源/恢复继承/真实选项；无选项显示不支持', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const normalized = __test.normalizeSessionConfigView({
    effective: { roles: [ROLE] },
    sources: {
      roles: {
        'role-sashi': {
          layer: 'session',
          fields: { name: 'global', aliases: 'global', description: 'project', prompt: 'global', 'channel.model': 'session' },
        },
      },
    },
    channels: CHANNELS,
    roleStates: [{ roleId: 'role-sashi', readiness: 'ready', color: 'green' }],
  })
  const detail = __test.renderRoleDetail(t, normalized, 'role-sashi', {
    scope: 'session',
    draft: __test.draftOfRole(normalized.roles[0]),
  })
  const strings = collectStrings(detail)
  for (const key of [
    'fieldName',
    'fieldAliases',
    'fieldDescription',
    'fieldChannel',
    'fieldModel',
    'fieldReasoning',
    'fieldPrompt',
    'sourceGlobal',
    'sourceProject',
    'sourceSession',
    'restoreInherit',
  ]) {
    assert.ok(strings.includes(key), `详情应包含 ${key}`)
  }
  const modelSelect = collectNodes(detail, (node) => node.type === 'select')
  assert.ok(modelSelect.length >= 2, '通道 + 模型都是真实 select')
  const inputs = collectNodes(detail, (node) => node.type === 'input')
  assert.ok(inputs.length >= 3, '名称/别名/描述可编辑')
  assert.ok(collectNodes(detail, (node) => node.type === 'textarea').length === 1)

  // 无可用通道：模型/强度显示「不支持」而不是伪造选项。
  const noOptions = __test.renderRoleDetail(
    t,
    viewWith([{ ...normalized.roles[0], channelId: 'ghost', channel: { channelId: 'ghost', kind: '', provider: '' } }]),
    'role-sashi',
    { scope: 'session', draft: { ...__test.draftOfRole(ROLE), channelId: '', model: '', reasoning: '' } },
  )
  const noOptionStrings = collectStrings(noOptions)
  assert.ok(
    noOptionStrings.some((value) => String(value).startsWith('unsupported')),
    '没有真实选项时显示不支持',
  )

  // 全局 scope：保存前显示二次确认。
  const confirming = __test.renderRoleDetail(t, normalized, 'role-sashi', {
    scope: 'global',
    draft: __test.draftOfRole(normalized.roles[0]),
    confirming: true,
  })
  const confirmStrings = collectStrings(confirming)
  assert.ok(confirmStrings.includes('scopeGlobalNote'))
  assert.ok(confirmStrings.includes('confirmGlobal'))
  assert.ok(confirmStrings.includes('confirm') && confirmStrings.includes('cancel'))
})
