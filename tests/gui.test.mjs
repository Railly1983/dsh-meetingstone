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
    sidebarRight: {
      openTab(kind, options) {
        sidebarOpenCalls.push(kind, options)
        return {}
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
    // 动态取名空间服务：生产代码用 ctx.get('remote.meetingstone')，不阻塞注册。
    get(key) {
      if (key === 'remote.meetingstone') return remote.meetingstone
      if (key === 'sidebarRightTabs') return ctx.sidebarRightTabs
      if (key === 'sidebarRight') return ctx.sidebarRight
      return undefined
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
  // 0.1.0-alpha 真机事故回归：注册必须**立即**发生，不能等 ctx.inject 回调。
  assert.deepEqual(injectCalls, [], '不应把注册阻塞在 ctx.inject 回调里')
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
  assert.deepEqual(sidebarOpenCalls, ['meetingstone-roles', { params: {} }], '点击应打开右侧栏 tab（openTab(kind, {params})）')
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
  assert.equal(pane[0].options.key, TAB_ID, 'seat 用 key（不是 id）对齐到右侧栏')
  assert.equal(title[0].options.key, TAB_ID)
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

test('client 源文件：无占位数据，且命名空间读取走 ctx.get 惰性获取', async () => {
  const source = await readFile(join(root, 'src/client/index.js'), 'utf8')
  assert.doesNotMatch(source, /SNAPSHOT/, '不应保留占位 SNAPSHOT')
  assert.doesNotMatch(source, /占位数据/, '不应保留占位文案')
  // 修复前的裸访问（父 fiber 未声明 remote.meetingstone）必须消失。
  assert.doesNotMatch(source, /ctx\.remote\[REMOTE_SERVICE\]\.list\(\)/)
  // 0.1.0-alpha 回归：不能把注册阻塞在 ctx.inject 回调里（会导致整块 UI 消失）。
  assert.doesNotMatch(source, /ctx\.inject\(\[REMOTE_INJECT\]/, '不得把注册阻塞在 ctx.inject 回调')
  assert.match(source, /ctx\.get\(/, '命名空间服务应通过 ctx.get 惰性获取')
  assert.match(source, /service\.list\(\)/, '数据读取应发生在惰性解析出的服务上')
})

// 递归收集 JSX 树中的文本节点。
function collectStrings(node, acc) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    node.forEach((c) => collectStrings(c, acc))
    return
  }
  if (node && typeof node === 'object') {
    const props = node.props || {}
    if (props.children !== undefined) collectStrings(props.children, acc)
  }
}

// 在 JSX 树中查找满足条件的元素（按 props/type 匹配）。
function findNode(node, pred) {
  if (!node || typeof node !== 'object') return false
  if (pred(node)) return true
  const props = node.props || {}
  if (Array.isArray(props.children)) return props.children.some((c) => findNode(c, pred))
  if (props.children && typeof props.children === 'object') return findNode(props.children, pred)
  return false
}

test('Browser half：V1 三区结构 + 删除区块不再渲染 + 错误条件 + 高级默认折叠', async () => {
  const { exports } = await loadClientHarness()
  const t = (k) => k
  const noop = () => {}

  // 模拟一个真实的 ready 快照（含角色/通道/CLI/全局配置/无错误）。
  const snapshot = {
    roles: [
      { roleId: 'role-sashi', name: '沙僧', aliases: ['SS'], enabled: true, availability: 'available', channelId: '', provider: '', model: '', reasoning: '' },
      { roleId: 'role-bajie', name: '八戒', aliases: [], enabled: false, availability: 'disabled', channelId: '', provider: '', model: '', reasoning: '' },
    ],
    channels: [{ channelId: 'ch-1', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low', description: '' }],
    lastError: null,
    global: {
      defaultRoleId: 'role-sashi',
      dispatchNotes: '补充说明',
      projectConfigFile: '.meetingstone.json',
      limits: { serializeWrites: true, maxParallelWritesTotal: 4, defaultIsolation: 'worktree' },
      channels: [{ channelId: 'ch-1', kind: 'acp-cli', provider: 'acp', model: 'm1', reasoning: 'low', description: '' }],
      cli: [
        { cli: 'codex', label: 'Codex CLI', installed: true, path: 'C:\\codex.exe', version: '1.2.3', source: 'appx', notes: [], checkedAt: null },
        { cli: 'claude', label: 'Claude Code CLI', installed: false, path: '', version: '', source: null, notes: ['nf'], checkedAt: null },
      ],
      cliError: null,
    },
  }

  // —— 默认（高级折叠） ——
  const collapsed = exports.__test.renderSection(t, snapshot, { advancedOpen: false, openRoles: noop })
  const collapsedStrings = []
  collectStrings(collapsed, collapsedStrings)

  // 三区标题存在
  assert.ok(collapsedStrings.includes('cli'), '区1 CLI 连接标题存在')
  assert.ok(collapsedStrings.includes('collab'), '区2 默认协作配置标题存在')
  assert.ok(collapsedStrings.includes('advanced'), '区3 高级设置标题存在')

  // 删除的区块不再渲染
  assert.ok(!collapsedStrings.includes('models'), '默认模型区域整体删除（标题不再渲染）')
  assert.ok(!collapsedStrings.includes('projectConfigFile'), '项目配置文件路径展示删除')
  assert.ok(!collapsedStrings.includes('limits'), '旧的「额度与并发策略」独立区删除')
  assert.ok(!collapsedStrings.includes('rules'), '旧的「全局调度规则」独立区删除')
  assert.ok(!collapsedStrings.includes('errors'), '旧的「最近错误」独立区删除')

  // 默认角色不重复：只在协作区出现一次
  assert.equal(
    collapsedStrings.filter((s) => s === 'defaultRole').length,
    1,
    '默认角色只在协作区出现一次（不重复）',
  )

  // 通道模型列表移入高级：折叠时不可见
  assert.ok(!collapsedStrings.includes('channelModels'), '通道模型列表移入高级（折叠时不可见）')

  // 高级默认折叠：展开后可见
  const expanded = exports.__test.renderSection(t, snapshot, { advancedOpen: true, openRoles: noop })
  const expandedStrings = []
  collectStrings(expanded, expandedStrings)
  assert.ok(expandedStrings.includes('channelModels'), '高级展开后通道模型映射可见')
  assert.ok(expandedStrings.includes('cliPaths'), '高级展开后 CLI 完整路径可见')
  assert.ok(expandedStrings.includes('configFile'), '高级展开后配置文件入口可见')
  assert.ok(expandedStrings.includes('isolation'), '高级展开后默认隔离可见')
  assert.ok(!collapsedStrings.includes('cliPaths'), '高级折叠时 CLI 完整路径不可见')
  assert.ok(!collapsedStrings.includes('configFile'), '高级折叠时配置文件入口不可见')
  assert.ok(!collapsedStrings.includes('isolation'), '高级折叠时默认隔离不可见')

  // 折叠切换按钮存在且 aria-expanded=false（默认折叠）
  assert.ok(
    findNode(collapsed, (n) => n.props && n.type === 'button' && (n.props.children === 'openAdvanced' || n.props.children === 'closeAdvanced')),
    '高级区有展开/收起按钮',
  )
  assert.ok(
    findNode(collapsed, (n) => n.props && n.props['aria-expanded'] === false),
    '折叠时 aria-expanded=false',
  )

  // 协作区「管理角色」入口按钮存在
  assert.ok(
    findNode(collapsed, (n) => {
      if (!n.props || n.type !== 'button') return false
      const tmp = []
      collectStrings(n, tmp)
      return tmp.includes('manageRoles')
    }),
    '协作区有「管理角色」入口按钮',
  )

  // 错误条件显示：有错误 → 一条 alert 警告 + 查看详情；无错误 → 不占位、不渲染 alert
  const withError = {
    ...snapshot,
    lastError: { code: 'ROLE_NOT_FOUND', message: '没有这个角色', at: '2026-11-11T00:00:00.000Z', source: 'dispatch' },
  }
  const errTree = exports.__test.renderSection(t, withError, { advancedOpen: true, openRoles: noop })
  const errStrings = []
  collectStrings(errTree, errStrings)
  assert.ok(findNode(errTree, (n) => n.props && n.props.role === 'alert'), '有错误时渲染 alert 警告')
  assert.ok(errStrings.join(' ').includes('ROLE_NOT_FOUND'), '错误码可见')
  assert.ok(errStrings.includes('errorDetails'), '查看详情入口存在')
  assert.ok(
    !findNode(collapsed, (n) => n.props && n.props.role === 'alert'),
    '无错误时不渲染 alert（不占位、不显示「无」）',
  )
})
