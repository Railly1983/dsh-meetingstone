// @ts-check
/**
 * GUI 只读数据 · stub harness（结构级，不是真机渲染）。
 *
 * 覆盖两段：
 * 1) Host 快照形状：`createGuiState().snapshot()` 只投影真实 registry / channels，
 *    lastError 来自注册表/派单/落盘，且整体是无损 JSON。
 * 2) Browser half：用假的 `window.__ModuleLoader__` / `require` / `ctx` 执行
 *    src/client/index.js，确认 settings.section 注册、Remote contribution 挂载、
 *    `list()` 走 `ctx.remote.meetingstone.list()` 并收窄数据形状。
 *
 * 不覆盖：React 实际渲染、宿主 Gateway 传输、真机 Settings 页面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRegistry } from '../src/roles/registry.js'
import {
  createGuiState,
  registerGuiRemote,
  markRemoteMethod,
  GUI_REMOTE_SERVICE,
} from '../src/gui/host.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 极简 subagents：只有 acp 可用。 */
const hostCtx = {
  subagents: {
    getProvider(name) {
      return name === 'acp' ? { name: 'acp' } : null
    },
  },
}

const channels = [
  { channelId: 'ch-acp-flash', kind: 'acp-cli' },
  { channelId: 'ch-codex-sol', kind: 'codex' },
]

function makeRegistry() {
  return createRegistry({
    globalRoles: [
      {
        roleId: 'role-sashi',
        name: '沙僧',
        aliases: ['SS', '主力执行'],
        channel: { kind: 'acp-cli', provider: 'acp' },
        enabled: true,
      },
      {
        roleId: 'role-bajie',
        name: '八戒',
        aliases: ['BJ'],
        channel: { kind: 'codex', provider: 'codex' },
        enabled: false,
      },
    ],
  })
}

test('Host 快照：角色可用性来自 subagents，通道来自 cfg.channels，且为无损 JSON', () => {
  const gui = createGuiState({ ctx: hostCtx, registry: makeRegistry(), channels })
  const snapshot = gui.snapshot()

  assert.deepEqual(snapshot.roles.map((r) => r.roleId), ['role-sashi', 'role-bajie'])
  assert.equal(snapshot.roles[0].availability, 'available')
  assert.equal(snapshot.roles[1].availability, 'disabled')
  assert.deepEqual(snapshot.roles[0].aliases, ['SS', '主力执行'])
  assert.deepEqual(snapshot.channels, [
    { channelId: 'ch-acp-flash', kind: 'acp-cli' },
    { channelId: 'ch-codex-sol', kind: 'codex' },
  ])
  assert.equal(snapshot.lastError, null)
  // Remote 返回值必须能无损走 JSON（不夹带 undefined / 函数 / 循环引用）。
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})

test('Host 全局快照：投影 cfg（默认角色/调度/并发）与本机 CLI 探测', async () => {
  const probe = {
    calls: 0,
    async probeAll() {
      this.calls += 1
      return [
        {
          cli: 'codex',
          installed: true,
          path: 'C:\\Apps\\codex.exe',
          version: '1.2.3',
          source: 'appx',
          notes: ['ok'],
          checkedAt: 1_700_000_000_000,
        },
        {
          cli: 'claude',
          installed: false,
          path: null,
          version: null,
          source: null,
          notes: ['not found'],
          checkedAt: 1_700_000_000_000,
        },
      ]
    },
  }
  const gui = createGuiState({
    ctx: hostCtx,
    registry: makeRegistry(),
    channels: [
      { channelId: 'ch-acp-flash', kind: 'acp-cli', provider: 'acp', model: 'flash-1', reasoning: 'low' },
      { channelId: 'ch-codex-sol', kind: 'codex', provider: 'codex-sol', model: 'sol-1', reasoning: 'high' },
    ],
    config: {
      defaultRoleId: 'role-sashi',
      dispatchNotes: '高难任务优先悟空',
      projectConfigFile: '.meetingstone.json',
      limits: { serializeWrites: false, maxParallelWritesTotal: 6, defaultIsolation: 'none' },
    },
    probe,
  })
  const snapshot = await gui.fullSnapshot()
  assert.equal(probe.calls, 1)
  assert.equal(snapshot.roles[0].model, '')
  assert.equal(snapshot.global.defaultRoleId, 'role-sashi')
  assert.equal(snapshot.global.dispatchNotes, '高难任务优先悟空')
  assert.deepEqual(snapshot.global.limits, {
    serializeWrites: false,
    maxParallelWritesTotal: 6,
    defaultIsolation: 'none',
  })
  assert.deepEqual(snapshot.global.channels[0], {
    channelId: 'ch-acp-flash',
    description: '',
    kind: 'acp-cli',
    provider: 'acp',
    model: 'flash-1',
    reasoning: 'low',
  })
  assert.deepEqual(snapshot.global.cli.map((c) => [c.cli, c.installed, c.version]), [
    ['codex', true, '1.2.3'],
    ['claude', false, ''],
  ])
  assert.equal(snapshot.global.cli[0].label, 'Codex CLI')
  assert.equal(snapshot.global.cli[0].checkedAt, new Date(1_700_000_000_000).toISOString())
  assert.equal(snapshot.global.cliError, null)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})

test('Host 全局快照：探测失败/缺失时如实降级，不拖垮角色列表', async () => {
  const noProbe = createGuiState({ ctx: hostCtx, registry: makeRegistry(), channels })
  const a = await noProbe.fullSnapshot()
  assert.equal(a.global.cli, null)
  assert.equal(a.global.cliError, null)
  assert.equal(a.roles.length, 2)

  const failing = createGuiState({
    ctx: hostCtx,
    registry: makeRegistry(),
    channels,
    probe: {
      async probeAll() {
        throw new Error('probe boom')
      },
    },
  })
  const b = await failing.fullSnapshot()
  assert.equal(b.global.cli, null)
  assert.equal(b.global.cliError, 'probe boom')
  assert.equal(b.roles.length, 2)
})

test('Host 最近错误：注册表错误初始化；派单失败覆盖；长消息截断', () => {
  const broken = createRegistry({
    globalRoles: [{ roleId: 'BAD ID', name: '坏角色', channel: { kind: 'in-process' } }],
  })
  assert.ok(broken.errors.length > 0, '前置：坏 roleId 应产生注册表错误')

  const gui = createGuiState({ ctx: hostCtx, registry: broken, channels: [] })
  assert.equal(gui.snapshot().lastError.code, 'INVALID_ROLE_ID')

  gui.recordDispatch({ ok: false, code: 'ROLE_NOT_FOUND', message: '没有这个角色' })
  const after = gui.snapshot().lastError
  assert.equal(after.code, 'ROLE_NOT_FOUND')
  assert.equal(after.source, 'dispatch')
  assert.match(after.at, /^\d{4}-\d{2}-\d{2}T/)

  gui.recordError({ code: 'HUGE', message: 'x'.repeat(5000) }, 'test')
  const huge = gui.snapshot().lastError
  assert.equal(huge.code, 'HUGE')
  assert.ok(huge.message.length <= 2001, '长消息应被截断')

  // 成功派单不应把历史错误清掉（“最近错误”不是“最近结果”）。
  gui.recordDispatch({ ok: true })
  assert.equal(gui.snapshot().lastError.code, 'HUGE')
})

test('Host Remote marker：按 Stage-3 装饰器顺序调用 Remote(method) 返回的 decorator', () => {
  // 复刻 protocol 的 Remote 语义：Remote(name) 返回 decorator；
  // decorator(value, context) 才注册 initializer；initializer 用 this 的原型打标记。
  function fakeRemote(method) {
    assert.equal(typeof method, 'string')
    return function decorator(_value, context) {
      assert.equal(context.kind, 'method')
      assert.equal(context.name, method)
      context.addInitializer(function initializer() {
        Object.defineProperty(Object.getPrototypeOf(this), 'stubMarker', {
          configurable: true,
          value: method,
        })
      })
    }
  }

  class BaseService {}
  class GuiService extends BaseService {
    async list() {
      return { ok: true }
    }
  }
  markRemoteMethod(GuiService.prototype, 'list', fakeRemote)
  assert.equal(GuiService.prototype.stubMarker, 'list')

  assert.throws(
    () => markRemoteMethod(GuiService.prototype, 'list', () => {}),
    /did not return a decorator/,
  )
})

test('Host Remote 注册：缺少宿主 Typert 协议时安全降级，不抛错', () => {
  const result = registerGuiRemote({}, { snapshot: () => ({ roles: [], channels: [], lastError: null }) })
  assert.equal(typeof result.registered, 'boolean')
  assert.equal(result.registered, false, '本地单测环境没有 @deepseek-ai/dsh-typert-protocol')
  assert.equal(result.reason, 'TYPERT_UNAVAILABLE')
  assert.equal(GUI_REMOTE_SERVICE, 'meetingstone')
})

/** 用假 loader/require/ctx 执行浏览器 half，返回捕获到的注册与 Remote 调用面。 */
async function loadClientHarness(values = {}) {
  const registrations = []
  const mounted = []
  const injectCalls = []
  const remoteValue =
    values.remoteValue !== undefined
      ? values.remoteValue
      : {
          ok: true,
          value: {
            roles: [
              {
                roleId: 'role-sashi',
                name: '沙僧',
                aliases: ['SS'],
                enabled: true,
                availability: 'available',
              },
            ],
            channels: [{ channelId: 'ch-acp-flash', kind: 'acp-cli' }],
            lastError: { code: 'ROLE_NOT_FOUND', message: '没有这个角色', at: null, source: 'dispatch' },
          },
        }

  const fakeReact = {
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useId: () => 'stub-id',
  }
  const fakeRequire = (name) => {
    if (name === 'react/jsx-runtime') {
      return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
    }
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Tag: function Tag() {} }
    }
    throw new Error(`stub require: unexpected module ${name}`)
  }

  let captured = null
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
  }
  try {
    const source = pathToFileURL(join(root, 'src/client/index.js')).href
    await import(`${source}?stub=${Math.random()}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.equal(captured?.id, 'dsh-meetingstone', 'lazy-CJS 入口 id 必须是包名')

  const exports = captured.factory(fakeRequire)
  const sidebarTabRegisters = []
  const sidebarOpenCalls = []
  const sessionRemoteCalls = []
  const SAMPLE_SESSION_VIEW = {
    effective: {
      roles: [{ roleId: 'role-sashi', name: '沙僧', aliases: ['SS'], channel: { model: 'm1' } }],
      channels: [],
      defaultRoleId: undefined,
      dispatchNotes: '',
      projectRules: [],
    },
    overrides: { 'role-sashi': { channel: { model: 'm1' } } },
    sources: { roles: { 'role-sashi': { layer: 'session', fields: { 'channel.model': 'session' } } } },
  }
  const remote = {
    async $mount(contribution) {
      mounted.push(contribution)
      if (values.mountError) throw values.mountError
      return async () => {}
    },
    meetingstone: {
      async list() {
        return remoteValue
      },
      async getSessionConfig(sessionId) {
        sessionRemoteCalls.push(['getSessionConfig', sessionId])
        return { ok: true, value: SAMPLE_SESSION_VIEW }
      },
      async setSessionOverride(sessionId, roleId, field, value) {
        sessionRemoteCalls.push(['setSessionOverride', sessionId, roleId, field, value])
        return { ok: true, value: { written: true, patch: { channel: { model: value } } } }
      },
      async clearSessionOverride(sessionId, roleId, field) {
        sessionRemoteCalls.push(['clearSessionOverride', sessionId, roleId, field])
        return { ok: true, value: { removed: true } }
      },
    },
    pluginInventory: {
      async list() {
        return { ok: false, error: { code: 'WRONG_FACE', message: '不应调用' } }
      },
    },
  }
  const ctx = {
    effect(fn) {
      return fn()
    },
    // 忠实模拟 Cordis 的动态注入契约：deps + callback；stub 在依赖已提供时
    // 同步执行 callback（真实 Cordis 由 fiber 调度，语义相同：未就绪不执行）。
    inject(deps, callback) {
      injectCalls.push(deps)
      callback(ctx)
      return {}
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(_name, fn) {
        fn()
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(options) {
        sidebarTabRegisters.push(options)
        return () => {}
      },
      open(id) {
        sidebarOpenCalls.push(id)
        return () => {}
      },
    },
    remote,
    logger: { info() {}, warn() {} },
  }

  await exports.apply(ctx)
  return {
    exports,
    registrations,
    mounted,
    injectCalls,
    remote,
    sidebarTabRegisters,
    sidebarOpenCalls,
    sessionRemoteCalls,
  }
}

test('Browser half：注册 settings.section 并通过 remote.meetingstone.list 取真实快照', async () => {
  const { exports, registrations, mounted, injectCalls } = await loadClientHarness()

  const byName = (name) => registrations.filter((r) => r.options.name === name)
  assert.equal(byName('settings.section').length, 1, 'settings.section 注册一次')
  const section = byName('settings.section')[0]
  const { options, Component } = section
  assert.equal(options.id, 'meetingstone')
  assert.equal(options.order, 100)
  assert.equal(options.locale, 'settings.meetingstone')
  assert.equal(typeof Component, 'function')
  assert.equal(options.label(), 'nav')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'remote'])
  // 动态注入：mount 后必须声明命名空间服务 `remote.meetingstone` 才读取。
  assert.deepEqual(injectCalls, [['remote.meetingstone']])
  assert.equal(exports.__test.REMOTE_INJECT, 'remote.meetingstone')

  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].package, 'dsh-meetingstone')
  // 现有 1 个只读方法 + 3 个会话级方法，共 4 个 descriptor。
  assert.equal(mounted[0].descriptors.length, 4)
  assert.deepEqual(
    mounted[0].descriptors.map((d) => d.method).sort(),
    ['clearSessionOverride', 'getSessionConfig', 'list', 'setSessionOverride'],
  )
  const listDesc = mounted[0].descriptors.find((d) => d.method === 'list')
  assert.deepEqual(listDesc, {
    id: 'dsh-meetingstone#meetingstone/list',
    service: 'meetingstone',
    namespace: 'meetingstone',
    method: 'list',
    parameters: [],
    invocation: { kind: 'direct' },
    result: { mode: 'src-json' },
  })

  const injected = options.inject()
  const snapshot = await injected.list()
  assert.deepEqual(snapshot.roles, [
    {
      roleId: 'role-sashi',
      name: '沙僧',
      aliases: ['SS'],
      enabled: true,
      availability: 'available',
      channelId: '',
      provider: '',
      model: '',
      reasoning: '',
    },
  ])
  assert.deepEqual(snapshot.channels, [{ channelId: 'ch-acp-flash', kind: 'acp-cli' }])
  assert.equal(snapshot.lastError.code, 'ROLE_NOT_FOUND')
  assert.deepEqual(snapshot.global, {
    defaultRoleId: '',
    dispatchNotes: '',
    projectConfigFile: '.meetingstone.json',
    limits: { serializeWrites: true, maxParallelWritesTotal: 4, defaultIsolation: 'worktree' },
    channels: [],
    cli: null,
    cliError: null,
  })
})

test('Browser half：Remote 失败时 list() 抛错，页面走 loadFailed 而不是伪装数据', async () => {
  const { registrations } = await loadClientHarness({
    remoteValue: { ok: false, error: { code: 'TYPERT_UNAVAILABLE', message: 'no host' } },
  })
  const injected = registrations[0].options.inject()
  await assert.rejects(() => injected.list(), /TYPERT_UNAVAILABLE/)
})

test('Browser half：normalizeSnapshot 对脏数据回退为空数组/无错误', async () => {
  const { exports } = await loadClientHarness()
  const emptyGlobal = {
    defaultRoleId: '',
    dispatchNotes: '',
    projectConfigFile: '.meetingstone.json',
    limits: { serializeWrites: true, maxParallelWritesTotal: 4, defaultIsolation: 'worktree' },
    channels: [],
    cli: null,
    cliError: null,
  }
  assert.deepEqual(exports.__test.normalizeSnapshot(null), {
    roles: [],
    channels: [],
    lastError: null,
    global: emptyGlobal,
  })
  assert.deepEqual(exports.__test.normalizeSnapshot({ roles: [null, 1], channels: 'x', lastError: 3 }), {
    roles: [],
    channels: [],
    lastError: null,
    global: emptyGlobal,
  })
})

test('Browser half：normalizeGlobal 收窄全局配置/CLI 数据', async () => {
  const { exports } = await loadClientHarness()
  const global = exports.__test.normalizeGlobal({
    defaultRoleId: 'role-sashi',
    dispatchNotes: 42,
    projectConfigFile: '',
    limits: { serializeWrites: 0, maxParallelWritesTotal: 0, defaultIsolation: 'bogus' },
    channels: [{ channelId: 'ch-1', model: 'm1', extra: 1 }, null],
    cli: [
      { cli: 'codex', installed: true, version: '1.2.3', notes: ['a', 2], checkedAt: '2026-11-11T00:00:00.000Z' },
      'bad',
    ],
    cliError: '',
  })
  assert.equal(global.defaultRoleId, 'role-sashi')
  assert.equal(global.dispatchNotes, '')
  assert.equal(global.projectConfigFile, '.meetingstone.json')
  // maxParallelWritesTotal 为 0/非法时回退 4；serializeWrites 非 false 即 true。
  assert.deepEqual(global.limits, {
    serializeWrites: true,
    maxParallelWritesTotal: 4,
    defaultIsolation: 'worktree',
  })
  assert.deepEqual(global.channels, [
    {
      channelId: 'ch-1',
      description: '',
      kind: '',
      provider: '',
      model: 'm1',
      reasoning: '',
    },
  ])
  assert.deepEqual(global.cli, [
    {
      cli: 'codex',
      label: 'codex',
      installed: true,
      path: '',
      version: '1.2.3',
      source: '',
      notes: ['a', '2'],
      checkedAt: '2026-11-11T00:00:00.000Z',
    },
  ])
  assert.equal(global.cliError, null)
})

test('Browser half：$mount 失败时仍注册 section，并以 unavailable 快照解释原因', async () => {
  const { registrations, injectCalls } = await loadClientHarness({
    mountError: new Error('mount boom'),
  })
  assert.equal(registrations.length, 1)
  assert.equal(injectCalls.length, 0, 'mount 失败不得进入动态注入')
  const snapshot = await registrations[0].options.inject().list()
  assert.equal(snapshot.unavailable.code, 'REMOTE_MOUNT_FAILED')
  assert.match(snapshot.unavailable.message, /mount boom/)
  assert.deepEqual(snapshot.roles, [])
})

test('Browser half：顶部集合石入口（conversation.session.header.actions）注册，点击打开右侧栏', async () => {
  const { exports, registrations, sidebarOpenCalls } = await loadClientHarness()
  const TAB_ID = exports.__test.TAB_ID

  const header = registrations.filter((r) => r.options.name === 'conversation.session.header.actions')
  assert.equal(header.length, 1, 'header.action 注册一次')
  const { options, Component } = header[0]
  assert.equal(options.id, exports.__test.HEADER_ACTION_ID)
  assert.equal(typeof options.order, 'number')
  assert.equal(options.locale, 'settings.meetingstone')
  assert.equal(typeof options.inject, 'function', 'host 用 inject(sessionId) 注入 props')
  assert.equal(typeof Component, 'function')

  // 模拟 host 用 inject(sessionId) 拿到 props 并渲染，再触发点击。
  const props = options.inject('sess-h1')
  assert.equal(props.sessionId, 'sess-h1')
  assert.equal(typeof props.openRolePanel, 'function')
  const element = Component(props)
  assert.equal(element.type, 'button', '入口是图标按钮')
  assert.equal(typeof element.props.onClick, 'function')
  element.props.onClick()
  assert.deepEqual(sidebarOpenCalls, [TAB_ID], '点击应打开右侧栏 tab')
})

test('Browser half：右侧栏两步式注册（sidebarRightTabs + 两个 keyed seat）', async () => {
  const { exports, registrations, sidebarTabRegisters } = await loadClientHarness()
  const TAB_ID = exports.__test.TAB_ID

  // 第 1 步：tab 本体
  assert.equal(sidebarTabRegisters.length, 1)
  const tab = sidebarTabRegisters[0]
  assert.equal(tab.id, TAB_ID)
  assert.equal(tab.kind, 'meetingstone-roles')
  assert.equal(typeof tab.priority, 'number')
  assert.equal(typeof tab.title, 'function')

  // 第 2 步：keyed seat（内容 + 标题，scope session）
  const pane = registrations.filter((r) => r.options.name === 'sidebar.right.pane.tab')
  const title = registrations.filter((r) => r.options.name === 'sidebar.right.pane.tab.title')
  assert.equal(pane.length, 1)
  assert.equal(title.length, 1)
  assert.equal(pane[0].options.id, TAB_ID, 'seat 用 tab id 对齐到右侧栏')
  assert.equal(title[0].options.id, TAB_ID)
  assert.equal(pane[0].options.locale, 'settings.meetingstone')
  assert.equal(typeof pane[0].Component, 'function')
})

test('Browser half：右侧栏 pane 通过 remote 方法读取/写入会话角色覆盖', async () => {
  const { exports, remote, sessionRemoteCalls } = await loadClientHarness()
  const service = remote.meetingstone

  const loader = exports.__test.makeSessionLoader(service)
  const view = await loader('sess-p1')
  assert.deepEqual(sessionRemoteCalls[0], ['getSessionConfig', 'sess-p1'])
  assert.equal(view.effective.roles[0].roleId, 'role-sashi')

  await exports.__test.applySessionOverride(service, 'sess-p1', 'role-sashi', 'model', 'm-x')
  assert.deepEqual(
    sessionRemoteCalls[sessionRemoteCalls.length - 1],
    ['setSessionOverride', 'sess-p1', 'role-sashi', 'model', 'm-x'],
  )

  await exports.__test.clearSessionOverride(service, 'sess-p1', 'role-sashi', 'model')
  assert.deepEqual(
    sessionRemoteCalls[sessionRemoteCalls.length - 1],
    ['clearSessionOverride', 'sess-p1', 'role-sashi', 'model'],
  )
})

test('Browser half：remote 方法失败时（ok!==true）loader 抛错而非伪装', async () => {
  const { exports } = await loadClientHarness()
  const failingService = {
    async getSessionConfig() {
      return { ok: false, error: { code: 'SESSION_GUI_SESSION_ROOT_UNKNOWN', message: 'no root' } }
    },
  }
  await assert.rejects(
    () => exports.__test.makeSessionLoader(failingService)('sess-z'),
    /SESSION_GUI_SESSION_ROOT_UNKNOWN/,
  )
})

test('client 源文件：无占位数据，且命名空间读取走动态注入', async () => {
  const source = await readFile(join(root, 'src/client/index.js'), 'utf8')
  assert.doesNotMatch(source, /SNAPSHOT/, '不应保留占位 SNAPSHOT')
  assert.doesNotMatch(source, /占位数据/, '不应保留占位文案')
  // 修复前的裸访问（父 fiber 未声明 remote.meetingstone）必须消失。
  assert.doesNotMatch(source, /ctx\.remote\[REMOTE_SERVICE\]\.list\(\)/)
  assert.match(source, /ctx\.inject\(\[REMOTE_INJECT\]/, '必须在 mount 后动态注入命名空间服务')
  assert.match(source, /service\.list\(\)/, '数据读取应发生在就绪子 ctx 捕获的服务上')
})
