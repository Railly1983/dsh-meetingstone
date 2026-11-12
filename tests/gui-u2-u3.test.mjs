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

  // B2：单一角色设定；清空 → 恢复继承（不再有独立 prompt 字段）
  const changed = __test.buildSessionChanges(
    t,
    ROLE,
    { ...same, name: '沙僧2', setting: '' },
    CHANNELS,
  )
  assert.equal(changed.error, null)
  assert.deepEqual(changed.changes, [
    { field: 'name', value: '沙僧2' },
    { field: 'setting', restore: true },
  ])

  const invalid = __test.buildSessionChanges(t, ROLE, { ...same, name: '   ' }, CHANNELS)
  assert.equal(invalid.error, 'detailInvalidName')
  assert.deepEqual(invalid.changes, [])
})

test('buildSessionChanges：切换 CLI+模型+强度组合时对齐内部 channel 字段', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  // B2：用户只改 CLI/模型/强度；内部由唯一匹配的已配置组合解析出 channel
  const draft = { ...__test.draftOfRole(ROLE), cli: 'codex', model: 'sol-1', reasoning: 'high' }
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

test('buildGlobalPatch：只写差异；设定/组合变更写 setting 与内部 channel', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const same = __test.draftOfRole(ROLE)
  assert.deepEqual(__test.buildGlobalPatch(t, ROLE, same, CHANNELS).patch, {})

  const changed = __test.buildGlobalPatch(t, ROLE, { ...same, setting: '新设定' }, CHANNELS)
  assert.equal(changed.error, null)
  assert.deepEqual(changed.patch, { setting: '新设定' })

  const combo = __test.buildGlobalPatch(
    t,
    ROLE,
    { ...same, cli: 'codex', model: 'sol-1', reasoning: 'high' },
    CHANNELS,
  )
  assert.equal(combo.error, null)
  assert.deepEqual(combo.patch, {
    channel: { channelId: 'ch-codex', kind: 'codex', provider: 'codex', model: 'sol-1', reasoning: 'high' },
  })
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
  assert.equal(view.roles[0].fieldSources.setting, 'default')
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
          fields: { name: 'global', aliases: 'global', setting: 'project', 'channel.model': 'session' },
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
    'fieldSetting',
    'fieldCli',
    'fieldModel',
    'fieldReasoning',
    'sourceGlobal',
    'sourceProject',
    'sourceSession',
    'restoreInherit',
  ]) {
    assert.ok(strings.includes(key), `详情应包含 ${key}`)
  }
  const modelSelect = collectNodes(detail, (node) => node.type === 'select')
  assert.ok(modelSelect.length >= 3, 'CLI/模型/强度都是真实 select')
  const inputs = collectNodes(detail, (node) => node.type === 'input')
  assert.ok(inputs.length >= 2, '名称/别名可编辑')
  assert.ok(collectNodes(detail, (node) => node.type === 'textarea').length === 1, '设定是唯一多行文本')

  // 无可用组合：模型/强度显示「不支持」而不是伪造选项。
  const noOptions = __test.renderRoleDetail(
    t,
    viewWith([{ ...normalized.roles[0], channelId: 'ghost', channel: { channelId: 'ghost', kind: '', provider: '' } }]),
    'role-sashi',
    { scope: 'session', draft: { ...__test.draftOfRole(ROLE), cli: '', model: '', reasoning: '' } },
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

test('saveGlobalPatch：一次 patch 写入 + reload；失败不 reload（B1 设置页全局管理器复用）', async () => {
  const { __test } = await loadClient()
  const calls = []
  let reloads = 0
  const reload = async () => {
    reloads += 1
    return { ok: true, view: viewWith([]) }
  }

  const ok = await __test.saveGlobalPatch({
    roleId: 'role-sashi',
    patch: { description: '新描述' },
    updateGlobalRole: async (...args) => {
      calls.push(args)
      return { ok: true, value: { written: true } }
    },
    reload,
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(calls, [['role-sashi', { description: '新描述' }]], '全局保存只调一次 updateGlobalRole')
  assert.equal(reloads, 1, '成功后 reload 一次')

  const failed = await __test.saveGlobalPatch({
    roleId: 'role-sashi',
    patch: { description: 'x' },
    updateGlobalRole: async () => ({
      ok: false,
      error: { code: 'GLOBAL_CONFIG_WRITE_FAILED', message: '写失败' },
    }),
    reload,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'GLOBAL_CONFIG_WRITE_FAILED')
  assert.equal(reloads, 1, '失败不得 reload（否则会掩盖未写入）')
})

test('B1：设置页内联全局角色管理渲染（列表 + 全局详情，无 scope 切换）', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const snapshot = __test.normalizeSnapshot({
    roles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        aliases: ['SS'],
        description: '骨干',
        prompt: '少说多做',
        enabled: true,
        channelId: 'ch-acp',
        kind: 'acp-cli',
        provider: 'acp',
        model: 'm1',
        reasoning: 'low',
        sourceLayer: 'global',
      },
    ],
    channels: [{ channelId: 'ch-acp', kind: 'acp-cli' }],
    lastError: null,
    global: {
      channels: [{ channelId: 'ch-acp', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low' }],
    },
  })
  // 列表：只显示名称/状态，点击进入全局面板（不跳会话）。
  const list = __test.renderGlobalRoleManager(t, snapshot, { onSelect: () => {} })
  const listStrings = collectStrings(list)
  assert.ok(listStrings.includes('globalRolesTitle'), '标题')
  assert.ok(listStrings.includes('globalRolesNote'), '全局写入口径')
  assert.ok(listStrings.includes('沙僧'), '角色名')
  assert.ok(listStrings.includes('globalRoleBadge'), '全局标识')
  assert.ok(!listStrings.includes('SS'), '列表不显示别名')

  // 详情：字段可编辑 → 走全局 patch（无会话/全局 scope 按钮）。
  const detail = __test.renderGlobalRoleManager(t, snapshot, {
    selectedRoleId: 'role-sashi',
    draft: __test.draftOfRole(snapshot.roles[0]),
    onDraft: () => {},
    onSave: () => {},
  })
  const detailStrings = collectStrings(detail)
  for (const key of ['fieldName', 'fieldSetting', 'scopeGlobalNote']) {
    assert.ok(detailStrings.includes(key), `全局详情含 ${key}`)
  }
  assert.ok(!detailStrings.includes('scopeSession'), '无会话 scope 按钮')
  assert.ok(!detailStrings.includes('scopeGlobal'), '无全局 scope 按钮')
  assert.ok(collectNodes(detail, (node) => node.type === 'input').length >= 2, '名称/别名可编辑')
  assert.ok(collectNodes(detail, (node) => node.type === 'textarea').length === 1, '设定可编辑')

  // 空全局角色：显示空态而不是空白。
  const empty = __test.renderGlobalRoleManager(t, __test.normalizeSnapshot({ roles: [] }), {})
  assert.ok(collectStrings(empty).includes('globalRolesEmpty'))
})

test('B1b generateRoleId：role-<slug>、中文回退 role-custom、冲突自动加序号', async () => {
  const { __test } = await loadClient()
  assert.equal(__test.generateRoleId('Deck Hand'), 'role-deck-hand')
  assert.equal(__test.generateRoleId('  '), 'role-custom')
  assert.equal(__test.generateRoleId('沙僧'), 'role-custom', '无 ASCII slug 时回退')
  assert.equal(__test.generateRoleId('沙僧', ['role-custom']), 'role-custom-2')
  assert.equal(__test.generateRoleId('沙僧', ['role-custom', 'role-custom-2']), 'role-custom-3')
  assert.equal(__test.generateRoleId('deck hand', ['role-deck-hand']), 'role-deck-hand-2')
})

test('B1b buildCreateRolePayload：必须名称+真实组合；payload 与编辑保存同口径', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const draft = {
    name: 'Deck Hand',
    aliases: 'DH, 甲板',
    setting: '负责甲板',
    cli: 'acp-cli',
    model: 'm1',
    reasoning: 'low',
  }
  const built = __test.buildCreateRolePayload(t, draft, CHANNELS, ['role-sashi'])
  assert.equal(built.error, null)
  assert.deepEqual(built.payload, {
    roleId: 'role-deck-hand',
    name: 'Deck Hand',
    aliases: ['DH', '甲板'],
    setting: '负责甲板',
    channel: { channelId: 'ch-acp', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low' },
    enabled: true,
  })

  const noName = __test.buildCreateRolePayload(t, { ...draft, name: '  ' }, CHANNELS, [])
  assert.equal(noName.error, 'detailInvalidName')
  assert.equal(noName.payload, null)

  const noCli = __test.buildCreateRolePayload(t, { ...draft, cli: '', model: '', reasoning: '' }, CHANNELS, [])
  assert.equal(noCli.error, 'pendingConfig', '不选 CLI 不得伪造组合')

  // 组合在 channels 中不存在 → 待配置（与编辑保存一致），不写假 channel。
  const ghost = __test.buildCreateRolePayload(
    t,
    { ...draft, cli: 'codex', model: 'ghost', reasoning: '' },
    CHANNELS,
    [],
  )
  assert.equal(ghost.error, 'pendingConfig')
})

test('B1b saveCreateGlobalRole / saveDeleteGlobalRole：一次写入 + reload；失败不 reload', async () => {
  const { __test } = await loadClient()
  const createCalls = []
  const deleteCalls = []
  let reloads = 0
  const reload = async () => {
    reloads += 1
    return { ok: true, view: viewWith([]) }
  }

  const created = await __test.saveCreateGlobalRole({
    role: { roleId: 'role-new', name: '新角色' },
    createGlobalRole: async (...args) => {
      createCalls.push(args)
      return { ok: true, value: { written: true } }
    },
    reload,
  })
  assert.equal(created.ok, true)
  assert.equal(created.roleId, 'role-new')
  assert.deepEqual(createCalls, [[{ roleId: 'role-new', name: '新角色' }]])
  assert.equal(reloads, 1)

  const createFailed = await __test.saveCreateGlobalRole({
    role: { roleId: 'role-new', name: '新角色' },
    createGlobalRole: async () => ({ ok: false, error: { code: 'GLOBAL_CONFIG_WRITE_FAILED', message: 'x' } }),
    reload,
  })
  assert.equal(createFailed.ok, false)
  assert.equal(createFailed.error.code, 'GLOBAL_CONFIG_WRITE_FAILED')
  assert.equal(reloads, 1, '新增失败不得 reload')

  const deleted = await __test.saveDeleteGlobalRole({
    roleId: 'role-new',
    deleteGlobalRole: async (...args) => {
      deleteCalls.push(args)
      return { ok: true, value: { written: true } }
    },
    reload,
  })
  assert.equal(deleted.ok, true)
  assert.deepEqual(deleteCalls, [['role-new']])
  assert.equal(reloads, 2)

  const deleteFailed = await __test.saveDeleteGlobalRole({
    roleId: 'role-new',
    deleteGlobalRole: async () => ({ ok: false, error: { code: 'GLOBAL_CONFIG_ROLE_NOT_FOUND', message: 'x' } }),
    reload,
  })
  assert.equal(deleteFailed.ok, false)
  assert.equal(reloads, 2, '删除失败不得 reload（不乐观删除）')
})

test('B1b renderGlobalRoleManager：新增入口/新建态/删除二次确认', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const snapshot = __test.normalizeSnapshot({
    roles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        aliases: ['SS'],
        setting: '骨干',
        enabled: true,
        channelId: 'ch-acp',
        kind: 'acp-cli',
        provider: 'acp',
        model: 'm1',
        reasoning: 'low',
      },
    ],
    channels: [{ channelId: 'ch-acp', kind: 'acp-cli' }],
    lastError: null,
    global: {
      channels: [{ channelId: 'ch-acp', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low' }],
    },
  })

  // 列表新增入口。
  const listStrings = collectStrings(__test.renderGlobalRoleManager(t, snapshot, {}))
  assert.ok(listStrings.includes('addRole'), '列表有「新增角色」')
  assert.ok(listStrings.includes('managerClose'), '列表可收起')

  // 新建态：标题/提示/创建按钮，无删除按钮；空 draft 时字段控件仍在。
  const createTree = __test.renderGlobalRoleManager(t, snapshot, {
    creating: true,
    draft: __test.emptyRoleDraft(),
    onDraft: () => {},
    onSave: () => {},
  })
  const createStrings = collectStrings(createTree)
  for (const key of ['createRoleTitle', 'createRoleHint', 'createRole', 'fieldName', 'fieldSetting']) {
    assert.ok(createStrings.includes(key), `新建态包含 ${key}`)
  }
  assert.ok(!createStrings.includes('deleteRole'), '新建态不出现删除')

  // 编辑态 + 删除确认态。
  const editTree = __test.renderGlobalRoleManager(t, snapshot, {
    selectedRoleId: 'role-sashi',
    draft: __test.draftOfRole(snapshot.roles[0]),
    onDraft: () => {},
    onSave: () => {},
    onRequestDelete: () => {},
  })
  assert.ok(collectStrings(editTree).includes('deleteRole'), '编辑态有删除入口')
  const confirmTree = __test.renderGlobalRoleManager(t, snapshot, {
    selectedRoleId: 'role-sashi',
    draft: __test.draftOfRole(snapshot.roles[0]),
    deleteConfirming: true,
  })
  const confirmStrings = collectStrings(confirmTree)
  assert.ok(confirmStrings.includes('confirmDeleteRole'), '删除二次确认文案')
  assert.ok(confirmStrings.includes('confirmDelete') && confirmStrings.includes('cancel'))
})

test('B1b global-writer create/delete：同一 configEditor.edit 路径、角色不存在/重复有稳定错误码', async () => {
  const { createGlobalConfigWriter } = await import('../src/config/global-writer.js')
  /** @type {any} */
  let config = {
    roles: [{ roleId: 'role-sashi', name: '沙僧', setting: '骨干', enabled: true }],
  }
  const writer = createGlobalConfigWriter({
    getConfigEditor: () => ({
      async edit(_entry, change) {
        config = change(structuredClone(config))
      },
    }),
    getEntry: () => ({ id: 'meetingstone' }),
  })

  const created = await writer.createRole({
    roleId: 'role-deck-hand',
    name: 'Deck Hand',
    aliases: ['DH'],
    setting: '甲板',
    channel: { channelId: 'ch-acp', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low' },
  })
  assert.equal(created.ok, true)
  assert.equal(config.roles.length, 2)
  const added = config.roles.find((role) => role.roleId === 'role-deck-hand')
  assert.equal(added.name, 'Deck Hand')
  assert.deepEqual(added.aliases, ['DH'])
  assert.equal(added.enabled, true, '新角色默认启用')
  assert.equal(added.channel.model, 'm1')

  const duplicate = await writer.createRole({ roleId: 'role-deck-hand', name: '重复' })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.code, 'GLOBAL_CONFIG_ROLE_EXISTS')
  assert.equal(config.roles.length, 2, '重复新增不写入')

  const badName = await writer.createRole({ roleId: 'role-x', name: '  ' })
  assert.equal(badName.ok, false)
  assert.equal(badName.code, 'GLOBAL_CONFIG_INVALID_ROLE_PATCH')

  const deleted = await writer.deleteRole('role-deck-hand')
  assert.equal(deleted.ok, true)
  assert.deepEqual(config.roles.map((role) => role.roleId), ['role-sashi'])

  const missing = await writer.deleteRole('role-deck-hand')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'GLOBAL_CONFIG_ROLE_NOT_FOUND', '删除失败不改变配置')
})
