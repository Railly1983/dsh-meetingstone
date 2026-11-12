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

/** B2c：4 CLI 能力目录 fixture（与 Host `global.capabilities` 形状一致）。 */
const CAPABILITIES = [
  {
    id: 'dsh', label: 'DeepSeek Harness', provider: 'spawn',
    models: [], strengths: [],
    sources: { models: 'unknown', strengths: 'unknown' }, refreshedAt: null, errors: [],
  },
  {
    id: 'claude', label: 'Claude Code', provider: 'claude-code',
    models: [{ id: 'sonnet', label: 'Sonnet', provider: 'claude-code', source: 'static' }],
    strengths: [{ id: 'medium', label: 'Medium', source: 'static' }],
    sources: { models: 'static', strengths: 'static' }, refreshedAt: null, errors: [],
  },
  {
    id: 'codex', label: 'Codex', provider: 'codex',
    models: [{ id: 'sol-1', label: 'Sol-1', provider: 'codex', source: 'static' }],
    strengths: [{ id: 'high', label: 'High', source: 'static' }],
    sources: { models: 'static', strengths: 'static' }, refreshedAt: null, errors: [],
  },
  {
    id: 'codebuddy', label: 'CodeBuddy', provider: 'acp',
    models: [{ id: 'm1', label: 'M1', provider: 'acp', source: 'static' }],
    strengths: [{ id: 'low', label: 'Low', source: 'static' }],
    sources: { models: 'static', strengths: 'static' }, refreshedAt: null, errors: [],
  },
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



test('buildGlobalPatch：只写差异；设定/组合变更写 setting 与内部 channel', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const same = __test.draftOfRole(ROLE)
  assert.deepEqual(__test.buildGlobalPatch(t, ROLE, same, CAPABILITIES, CHANNELS).patch, {})

  const changed = __test.buildGlobalPatch(t, ROLE, { ...same, setting: '新设定' }, CAPABILITIES, CHANNELS)
  assert.equal(changed.error, null)
  assert.deepEqual(changed.patch, { setting: '新设定' })

  const combo = __test.buildGlobalPatch(
    t,
    ROLE,
    { ...same, cli: 'codex', model: 'sol-1', reasoning: 'high' },
    CAPABILITIES,
    CHANNELS,
  )
  assert.equal(combo.error, null)
  assert.deepEqual(combo.patch, {
    channel: { channelId: 'ch-codex', kind: 'codex', provider: 'codex', model: 'sol-1', reasoning: 'high' },
  })
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
    cli: 'codebuddy',
    model: 'm1',
    reasoning: 'low',
  }
  const built = __test.buildCreateRolePayload(t, draft, CAPABILITIES, CHANNELS, ['role-sashi'])
  assert.equal(built.error, null)
  assert.deepEqual(built.payload, {
    roleId: 'role-deck-hand',
    name: 'Deck Hand',
    aliases: ['DH', '甲板'],
    setting: '负责甲板',
    channel: { channelId: 'ch-acp', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low' },
    enabled: true,
  })

  const noName = __test.buildCreateRolePayload(t, { ...draft, name: '  ' }, CAPABILITIES, CHANNELS, [])
  assert.equal(noName.error, 'detailInvalidName')
  assert.equal(noName.payload, null)

  const noCli = __test.buildCreateRolePayload(t, { ...draft, cli: '', model: '', reasoning: '' }, CAPABILITIES, CHANNELS, [])
  assert.equal(noCli.error, 'pendingConfig', '不选 CLI 不得伪造组合')

  // 组合在 channels 中不存在 → 待配置（与编辑保存一致），不写假 channel。
  const ghost = __test.buildCreateRolePayload(
    t,
    { ...draft, cli: 'codex', model: 'ghost', reasoning: '' },
    CAPABILITIES,
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

test('B2c channelForCombo：CLI/模型 → 内部 channel（provider 映射 + 目录外组合拒绝）', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const caps = [
    {
      id: 'codex', label: 'Codex', provider: 'codex',
      models: [{ id: 'gpt-6.1-sol', label: 'Sol', provider: 'codex-sol', source: 'discovered' }],
      strengths: [{ id: 'high', label: 'High', source: 'discovered' }],
      sources: { models: 'discovered', strengths: 'discovered' }, refreshedAt: 1, errors: [],
    },
    {
      id: 'codebuddy', label: 'CodeBuddy', provider: 'acp',
      models: [{ id: 'hy3', label: 'Hy3', provider: 'acp-hy4', source: 'static' }],
      strengths: [],
      sources: { models: 'static', strengths: 'unknown' }, refreshedAt: null, errors: [],
    },
  ]
  const hit = __test.channelForCombo(
    t,
    { cli: 'codex', model: 'gpt-6.1-sol', reasoning: 'high' },
    caps,
    CHANNELS,
  )
  assert.equal(hit.error, null)
  assert.deepEqual(hit.channel, {
    kind: 'codex',
    provider: 'codex-sol',
    model: 'gpt-6.1-sol',
    reasoning: 'high',
  })

  const ghost = __test.channelForCombo(
    t,
    { cli: 'codex', model: 'nope', reasoning: '' },
    caps,
    CHANNELS,
  )
  assert.equal(ghost.error, 'pendingConfig', '目录外模型不得伪造组合')

  const noCli = __test.channelForCombo(t, { cli: '', model: '', reasoning: '' }, caps, CHANNELS)
  assert.equal(noCli.error, 'pendingConfig')
})

test('B2c buildGlobalPatch：切到无对应实例的 CLI 明确拒绝（不写半套组合）', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const role = {
    roleId: 'role-sashi',
    name: '沙僧',
    aliases: [],
    setting: '骨干',
    channel: { channelId: 'ch-acp', kind: 'acp-cli', provider: 'acp' },
  }
  // claude 在 CHANNELS 里没有实例；旧 channelId 无法在全局层删除 → 明确拒绝。
  const built = __test.buildGlobalPatch(
    t,
    role,
    { name: '沙僧', aliases: '', setting: '骨干', cli: 'claude', model: 'sonnet', reasoning: '' },
    CAPABILITIES,
    CHANNELS,
  )
  assert.equal(built.error, 'comboChannelUnsupported')
})

test('B2c renderRoleDetail：4 CLI 选项（无 ch-*）+ 模型/强度来源 + 未知置灰 + 刷新按钮', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const view = viewWith([ROLE], { capabilities: CAPABILITIES })
  const detail = __test.renderRoleDetail(t, view, 'role-sashi', {
    scope: 'session',
    draft: __test.draftOfRole(ROLE),
    onRefreshCapabilities: () => {},
  })
  const strings = collectStrings(detail)
  for (const label of ['DeepSeek Harness', 'Claude Code', 'Codex', 'CodeBuddy']) {
    assert.ok(strings.includes(label), `CLI 选项应包含 ${label}`)
  }
  assert.ok(!strings.some((value) => String(value).startsWith('ch-')), '不得把 ch-* 当 CLI 显示')
  assert.ok(strings.includes('refreshCapabilities'), '有「刷新能力」动作')
  assert.ok(
    strings.some((value) => String(value).includes('capabilitySource')),
    '显示能力来源',
  )
  assert.ok(
    strings.some(
      (value) =>
        String(value).includes('M1') &&
        (String(value).includes('sourceStatic') || String(value).includes('sourceConfig')),
    ),
    '模型选项带来源标注',
  )

  // dsh 目录为空 → 模型/强度两个下拉置灰并标「不支持」。
  const dshDetail = __test.renderRoleDetail(t, view, 'role-sashi', {
    scope: 'session',
    draft: { ...__test.draftOfRole(ROLE), cli: 'dsh', model: '', reasoning: '' },
  })
  const disabledSelects = collectNodes(dshDetail, (node) => node.type === 'select' && node.props?.disabled === true)
  assert.ok(disabledSelects.length >= 2, '无模型/强度时置灰而非伪造选项')
  assert.ok(
    collectStrings(dshDetail).some((value) => String(value).startsWith('unsupported')),
    '置灰项标「不支持」',
  )
})

test('B2c renderGlobalRoleManager：每行启用开关（状态来自 enabled，pending 时禁用）', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const snapshot = __test.normalizeSnapshot({
    roles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        aliases: [],
        setting: '骨干',
        enabled: true,
        channelId: 'ch-acp',
        kind: 'acp-cli',
        provider: 'acp',
        model: 'm1',
        reasoning: 'low',
      },
      {
        roleId: 'role-bajie',
        name: '八戒',
        aliases: [],
        setting: '调度',
        enabled: false,
        channelId: 'ch-inprocess',
        kind: 'in-process',
        provider: 'spawn',
      },
    ],
    channels: [],
    global: { capabilities: CAPABILITIES },
  })
  const tree = __test.renderGlobalRoleManager(t, snapshot, {})
  const switches = collectNodes(
    tree,
    (node) => node.type === 'button' && node.props?.role === 'switch',
  )
  assert.equal(switches.length, 2, '每个全局角色行一个开关')
  assert.deepEqual(switches.map((node) => node.props['aria-checked']), [true, false])

  const pendingTree = __test.renderGlobalRoleManager(t, snapshot, { pendingRoleIds: ['role-sashi'] })
  const pendingSwitches = collectNodes(
    pendingTree,
    (node) => node.type === 'button' && node.props?.role === 'switch',
  )
  assert.equal(pendingSwitches[0].props.disabled, true, 'pending 时开关禁用（不做乐观假切换）')
})

test('B3：设置页角色区有「返回」按钮（回到集合石主区，不引入新路由）', async () => {
  const { __test } = await loadClient()
  const t = (key) => key
  const snapshot = __test.normalizeSnapshot({ roles: [], channels: [], global: { capabilities: CAPABILITIES } })
  let closed = 0
  const tree = __test.renderGlobalRoleManager(t, snapshot, {
    onBackToSettings: () => {
      closed += 1
    },
  })
  const back = collectNodes(
    tree,
    (node) => node.type === 'button' && String(node.props?.children ?? '').includes('backToSettings'),
  )
  assert.equal(back.length, 1, '管理器头部有返回按钮')
  back[0].props.onClick()
  assert.equal(closed, 1, '点击返回调用 onBackToSettings')
})
