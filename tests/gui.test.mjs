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
import { z } from 'zod'

import { createRegistry } from '../src/roles/registry.js'
import {
  createGuiState,
  registerGuiRemote,
  markRemoteMethod,
  GUI_REMOTE_SERVICE,
} from '../src/gui/host.js'
import { SESSION_REMOTE_TYPES } from '../src/gui/typert-spec.js'

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

test('Host 全局快照：cliStates 提供「偏好 + preflight + 人工步骤」，全部 JSON-safe', async () => {
  const gui = createGuiState({
    ctx: hostCtx,
    registry: makeRegistry(),
    channels,
    config: {},
    cliStates: async () => [
      {
        cli: 'codex',
        userPreference: 'enabled',
        enabled: true,
        ready: 'ready',
        blockedReason: null,
        manualSteps: [],
        retryable: false,
        installed: true,
        version: '1.2.3',
        path: 'C:/x/codex.exe',
        source: 'path',
        login: 'unknown',
        hostIntegration: true,
        firstDetection: false,
        notes: ['ok'],
        checkedAt: 1_700_000_000_000,
      },
      {
        cli: 'claude',
        userPreference: 'disabled',
        enabled: false,
        ready: 'blocked',
        blockedReason: 'not-installed',
        manualSteps: ['安装对应 CLI（本项目不自动安装）'],
        retryable: true,
        installed: false,
        version: null,
        path: null,
        source: null,
        login: 'unknown',
        hostIntegration: 'unknown',
        firstDetection: false,
        notes: [],
        checkedAt: 1_700_000_000_000,
      },
    ],
  })
  const snapshot = await gui.fullSnapshot()
  assert.deepEqual(snapshot.global.cliPreferences, { codex: 'enabled', claude: 'disabled' })
  assert.equal(snapshot.global.cli.length, 2)
  assert.equal(snapshot.global.cli[0].label, 'Codex CLI')
  assert.equal(snapshot.global.cli[0].userPreference, 'enabled')
  assert.equal(snapshot.global.cli[0].enabled, true)
  assert.equal(snapshot.global.cli[0].ready, 'ready')
  assert.equal(snapshot.global.cli[0].autoFix, false)
  assert.equal(snapshot.global.cli[0].checkedAt, new Date(1_700_000_000_000).toISOString())
  assert.equal(snapshot.global.cli[1].ready, 'blocked')
  assert.equal(snapshot.global.cli[1].blockedReason, 'not-installed')
  assert.ok(snapshot.global.cli[1].manualSteps.length > 0)
  assert.equal(snapshot.global.cli[1].retryable, true)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})

test('Host 全局快照：cliStates 抛错时如实降级，不拖垮角色列表', async () => {
  const gui = createGuiState({
    ctx: hostCtx,
    registry: makeRegistry(),
    channels,
    config: {},
    cliStates: async () => {
      throw new Error('preflight boom')
    },
  })
  const snapshot = await gui.fullSnapshot()
  assert.equal(snapshot.global.cli, null)
  assert.equal(snapshot.global.cliError, 'preflight boom')
  assert.equal(snapshot.roles.length, 2)
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
  const result = registerGuiRemote({}, { snapshot: () => ({ roles: [], channels: [], lastError: null }), protocol: null })
  assert.equal(typeof result.registered, 'boolean')
  assert.equal(result.registered, false, '本地单测环境没有 @deepseek-ai/dsh-typert-protocol')
  assert.match(String(result.reason), /TYPERT_UNAVAILABLE|REMOTE_REGISTER_FAILED/)
  assert.equal(GUI_REMOTE_SERVICE, 'meetingstone')
})

/** 用假 loader/require/ctx 执行浏览器 half，返回捕获到的注册与 Remote 调用面。 */
async function loadClientHarness(values = {}) {
  const registrations = []
  const mounted = []
  const injectCalls = []
  const logs = []
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
                channelId: 'ch-acp-flash',
                provider: 'acp',
                model: 'flash-1',
              },
            ],
            channels: [{ channelId: 'ch-acp-flash', kind: 'acp-cli' }],
            lastError: { code: 'ROLE_NOT_FOUND', message: '没有这个角色', at: null, source: 'dispatch' },
          },
        }

  // 有状态的极简 React：支持 useState 更新 + 手动 reset 后重渲染，用于验证点击提示。
  const fakeReact = {
    _hooks: [],
    _index: 0,
    reset() {
      this._index = 0
    },
    useState(initial) {
      const i = this._index++
      if (this._hooks.length <= i) this._hooks[i] = initial
      return [
        this._hooks[i],
        (next) => {
          this._hooks[i] = typeof next === 'function' ? next(this._hooks[i]) : next
        },
      ]
    },
    useEffect: () => {},
    useId: () => 'stub-id',
  }
  const fakeRequire = (name) => {
    if (name === 'react/jsx-runtime') {
      return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
    }
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      // U1a：primitives 不在 asar node_modules，官方禁止第三方插件 require；
      // client 必须自绘 Tag/图标。这里故意让 require 失败，回归“又粘回来”。
      throw new Error('stub require: primitives must not be required')
    }
    // 宿主 web 模块表的平台 seed 词；官方 client bundle 同样 require("zod")。
    if (name === 'zod') {
      if (values.omitZod) throw new Error('stub: zod unavailable')
      return { z }
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
  const sessionCalls = []
  const sessionWrites = []
  const sessionClears = []
  const cliCalls = []
  const globalWrites = []
  const sessionValue =
    values.sessionValue !== undefined
      ? values.sessionValue
      : {
          ok: true,
          value: {
            effective: {
              roles: [
                {
                  roleId: 'role-sashi',
                  name: '沙僧',
                  aliases: ['SS'],
                  description: '骨干',
                  prompt: '少说多做',
                  channel: {
                    channelId: 'ch-acp-flash',
                    kind: 'acp-cli',
                    provider: 'acp',
                    model: 'flash-1',
                    reasoning: 'low',
                  },
                  enabled: true,
                },
              ],
              channels: [],
              defaultRoleId: 'role-sashi',
              dispatchNotes: '',
              projectRules: [],
            },
            // role-sashi 在会话层覆盖了 channel；来源层是 project。
            overrides: { 'role-sashi': { channel: { model: 'flash-2' } } },
            sources: {
              roles: {
                'role-sashi': {
                  layer: 'session',
                  fields: {
                    name: 'global',
                    aliases: 'global',
                    description: 'project',
                    prompt: 'global',
                    'channel.channelId': 'global',
                    'channel.kind': 'global',
                    'channel.provider': 'global',
                    'channel.model': 'session',
                    'channel.reasoning': 'global',
                  },
                },
              },
              defaultRoleId: 'project',
              dispatchNotes: 'default',
              projectRules: [],
            },
            channels: [
              {
                channelId: 'ch-acp-flash',
                description: 'ACP 快速通道',
                kind: 'acp-cli',
                provider: 'acp',
                model: 'flash-1',
                reasoning: 'low',
              },
              {
                channelId: 'ch-codex-sol',
                description: 'Codex 通道',
                kind: 'codex',
                provider: 'codex',
                model: 'sol-1',
                reasoning: 'high',
              },
            ],
            roleStates: [
              {
                roleId: 'role-sashi',
                userPreference: 'enabled',
                readiness: 'ready',
                readinessReason: 'PROVIDER_AVAILABLE',
                quota: 'unknown',
                color: 'green',
                availability: 'available',
              },
            ],
            warnings: [],
          },
        }
  const remote = {
    async $mount(contribution) {
      mounted.push(contribution)
      if (values.mountError) throw values.mountError
      return async () => {}
    },
    // 无参 list + strict 会话方法 + 配置方法（U2）。
    meetingstone: {
      async list() {
        return remoteValue
      },
      async getSessionConfig(sessionId) {
        sessionCalls.push(sessionId)
        if (values.sessionThrows) throw values.sessionThrows
        return sessionValue
      },
      async setSessionOverride(sessionId, roleId, field, value) {
        sessionWrites.push({ sessionId, roleId, field, value })
        if (values.setOverrideError) return values.setOverrideError
        return { ok: true, value: { ok: true, written: true, scope: 'field' } }
      },
      async clearSessionOverride(sessionId, roleId, field) {
        sessionClears.push({ sessionId, roleId, field })
        if (values.clearOverrideError) return values.clearOverrideError
        return { ok: true, value: { ok: true, written: true, removed: true } }
      },
      async setCliEnabled(cli, enabled) {
        cliCalls.push({ method: 'setCliEnabled', cli, enabled })
        if (values.setCliError) return { ok: true, value: values.setCliError }
        return {
          ok: true,
          value: {
            ok: true,
            written: true,
            enabled,
            state: {
              cli,
              enabled,
              ready: 'ready',
              userPreference: enabled ? 'enabled' : 'disabled',
              blockedReason: null,
              manualSteps: [],
              retryable: false,
            },
          },
        }
      },
      async refreshCli(cli, force) {
        cliCalls.push({ method: 'refreshCli', cli, force })
        return { ok: true, value: { ok: true, cli: { cli, enabled: false, ready: 'blocked', blockedReason: 'not-installed', manualSteps: ['安装 CLI'], retryable: true } } }
      },
      async updateGlobalRole(roleId, patch) {
        globalWrites.push({ roleId, patch })
        if (values.globalWriteError) return { ok: true, value: values.globalWriteError }
        return { ok: true, value: { ok: true, written: true, config: {} } }
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
    slots: values.omitSlots
      ? undefined
      : {
          inject(_name, fn) {
            fn()
          },
          register(options, Component) {
            if (values.failRegisterFor && options.name === values.failRegisterFor) {
              throw new Error(`register ${options.name} boom`)
            }
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
    remote: values.omitRemote ? {} : remote,
    logger: {
      info(line) {
        logs.push(['info', line])
      },
      warn(line) {
        logs.push(['warn', line])
      },
      error(line) {
        logs.push(['error', line])
      },
    },
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
    sessionCalls,
    sessionWrites,
    sessionClears,
    cliCalls,
    globalWrites,
    react: fakeReact,
    logs,
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
  // list（无参 SRC）+ 会话 3 个 strict 方法 + 配置 5 个 strict 方法（U2 + B1b）。
  assert.equal(mounted[0].descriptors.length, 9)
  assert.deepEqual(
    mounted[0].descriptors.map((d) => d.method),
    [
      'list',
      'getSessionConfig',
      'setSessionOverride',
      'clearSessionOverride',
      'setCliEnabled',
      'refreshCli',
      'updateGlobalRole',
      'createGlobalRole',
      'deleteGlobalRole',
    ],
  )
  assert.deepEqual(mounted[0].descriptors[0].parameters, [], 'list 必须无参')
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

  // 参数 codec 必须是 strict + 真实 zod，且 typeSymbol 与 Host 契约逐字一致。
  const getDesc = mounted[0].descriptors.find((d) => d.method === 'getSessionConfig')
  const setDesc = mounted[0].descriptors.find((d) => d.method === 'setSessionOverride')
  const clearDesc = mounted[0].descriptors.find((d) => d.method === 'clearSessionOverride')
  assert.equal(getDesc.parameters.length, 1)
  assert.equal(getDesc.parameters[0].codec.mode, 'strict')
  assert.equal(getDesc.parameters[0].codec.typeSymbol, SESSION_REMOTE_TYPES.sessionId)
  assert.equal(typeof getDesc.parameters[0].codec.create, 'function')
  assert.doesNotThrow(() => getDesc.parameters[0].codec.create().parse('sess-1'))
  assert.throws(() => getDesc.parameters[0].codec.create().parse(''))
  assert.throws(() => getDesc.parameters[0].codec.create().parse(123))

  assert.deepEqual(
    setDesc.parameters.map((p) => p.wire),
    ['sessionId', 'roleId', 'field', 'value'],
  )
  assert.ok(setDesc.parameters.every((p) => p.codec.mode === 'strict' && p.codec.typeSymbol))
  assert.equal(setDesc.parameters[1].codec.typeSymbol, SESSION_REMOTE_TYPES.roleId)
  assert.equal(setDesc.parameters[2].codec.typeSymbol, SESSION_REMOTE_TYPES.field)
  assert.equal(setDesc.parameters[3].codec.typeSymbol, SESSION_REMOTE_TYPES.value)

  assert.deepEqual(
    clearDesc.parameters.map((p) => p.wire),
    ['sessionId', 'roleId', 'field'],
  )
  assert.equal(clearDesc.parameters[2].acceptsUndefined, true, 'clear.field 可省略')
  assert.ok(clearDesc.parameters.every((p) => p.codec.mode === 'strict' && p.codec.typeSymbol))

  const injected = options.inject()
  // B1：设置页内联全局角色管理复用 updateGlobalRole 写路径；不再注入 openRoles
  // （旧实现会把「管理角色」错跳到会话级右侧栏面板，settings.section 是 root 无 sessionId）。
  assert.equal(typeof injected.updateGlobalRole, 'function', '设置页注入全局角色写入口')
  // B1b：新增/删除全局角色同样从设置页注入（同一 global writer 路径）。
  assert.equal(typeof injected.createGlobalRole, 'function', '设置页注入新增全局角色')
  assert.equal(typeof injected.deleteGlobalRole, 'function', '设置页注入删除全局角色')
  assert.equal(injected.openRoles, undefined, '设置页不再注入 openRoles（不跳右侧栏）')
  const snapshot = await injected.list()
  // B1：roleView 增补 description/prompt/fieldSources/sourceLayer/channel(嵌套)，
  // 设置页内联全局角色管理需要这些字段（原实现只投影展示/通道字段）。
  const allDefaultSources = Object.fromEntries(
    [
      'name',
      'aliases',
      'setting',
      'enabled',
      'channel.channelId',
      'channel.kind',
      'channel.provider',
      'channel.cli',
      'channel.model',
      'channel.reasoning',
    ].map((field) => [field, 'default']),
  )
  assert.deepEqual(snapshot.roles, [
    {
      roleId: 'role-sashi',
      name: '沙僧',
      aliases: ['SS'],
      setting: '',
      description: '',
      prompt: '',
      enabled: true,
      availability: 'available',
      channelId: 'ch-acp-flash',
      kind: '',
      provider: 'acp',
      model: 'flash-1',
      reasoning: '',
      sourceLayer: 'default',
      fieldSources: allDefaultSources,
      state: {
        userPreference: 'unset',
        readiness: 'unknown',
        readinessReason: 'PROVIDER_EVIDENCE_MISSING',
        quota: 'unknown',
        color: 'gray',
        availability: 'available',
      },
      channel: {
        channelId: 'ch-acp-flash',
        kind: '',
        provider: 'acp',
        model: 'flash-1',
        reasoning: '',
      },
    },
  ])
  assert.deepEqual(snapshot.channels, [{ channelId: 'ch-acp-flash', kind: 'acp-cli' }])
  assert.equal(snapshot.lastError.code, 'ROLE_NOT_FOUND')
  // 该用例的 remote 是 mock（不带 global）→ 客户端 normalizeGlobal 回退空能力目录。
  // 真实 Host 的 4 CLI 能力目录在 tests/cli-capabilities.test.mjs 里对 createGuiState 验证。
  assert.deepEqual(snapshot.global, {
    defaultRoleId: '',
    dispatchNotes: '',
    projectConfigFile: '.meetingstone.json',
    limits: { serializeWrites: true, maxParallelWritesTotal: 4, defaultIsolation: 'worktree' },
    channels: [],
    capabilities: [],
    cli: null,
    cliError: null,
  })
})

test('Browser half：Remote 失败时 list() 抛错，页面走 loadFailed 而不是伪装数据', async () => {
  const { registrations } = await loadClientHarness({
    remoteValue: { ok: false, error: { code: 'TYPERT_UNAVAILABLE', message: 'no host' } },
  })
  const section = registrations.find((r) => r.options.name === 'settings.section')
  const injected = section.options.inject()
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
    capabilities: [],
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
  // U2：固定三行（Codex / CodeBuddy / Claude），缺失项按 unknown/关闭呈现。
  assert.deepEqual(
    global.cli.map((row) => [row.cli, row.label, row.installed, row.version, row.enabled]),
    [
      ['codex', 'Codex', true, '1.2.3', false],
      ['codebuddy', 'CodeBuddy', false, '', false],
      ['claude', 'Claude Code', false, '', false],
    ],
  )
  assert.equal(global.cli[0].ready, 'unknown')
  assert.equal(global.cli[0].notes.join(','), 'a,2')
  assert.equal(global.cli[0].checkedAt, '2026-11-11T00:00:00.000Z')
  assert.equal(global.cli[1].retryable, true, '缺失行允许重新检测')
  assert.equal(global.cliError, null)
})

test('Browser half：本地 Tag / 内联 SVG 只用宿主 token（无 primitives）', async () => {
  const { exports } = await loadClientHarness()
  const Tag = exports.__test.Tag

  const info = Tag({ tone: 'info', children: 'ok' })
  assert.equal(info.type, 'span')
  assert.equal(info.props['data-tone'], 'info')
  assert.match(info.props.style.color, /--dsw-alias-state-business-primary/)
  assert.match(info.props.style.background, /color-mix/)

  const danger = Tag({ tone: 'danger', children: 'bad' })
  assert.match(danger.props.style.color, /--dsw-alias-state-error-primary/)

  // 未知 tone 回退 outline，不产生不存在的 token。
  const unknown = Tag({ tone: 'nope', children: 'x' })
  assert.equal(unknown.props['data-tone'], 'outline')
  assert.match(unknown.props.style.border, /--dsw-alias-border-l4/)

  const icon = exports.__test.IconUsers({ size: 16 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props['aria-hidden'], 'true')
  assert.equal(icon.props.focusable, 'false')
  assert.equal(icon.props.stroke, 'currentColor')
  assert.equal(icon.props.width, 16)
  assert.equal(icon.props.height, 16)
})

test('Browser half：normalizeSessionConfigView 收窄脏数据（未知来源→unknown）', async () => {
  const { exports } = await loadClientHarness()
  assert.deepEqual(exports.__test.normalizeSessionConfigView(null), {
    roles: [],
    defaultRoleId: '',
    defaultRoleSource: 'default',
    channels: [],
    capabilities: [],
    warnings: [],
  })

  const view = exports.__test.normalizeSessionConfigView({
    effective: {
      roles: [
        null,
        1,
        { roleId: 'r1', name: 'A', aliases: 'x', channel: null },
        { roleId: 'r2', channel: { model: 'm' } },
      ],
      defaultRoleId: 'r1',
    },
    overrides: { r1: {}, r2: { model: 'm' } },
    sources: {
      roles: { r1: { layer: 'session' }, r2: { layer: 'bogus' } },
      defaultRoleId: 'session',
    },
  })
  assert.deepEqual(
    view.roles.map((role) => [role.roleId, role.sourceLayer, role.overrideFields]),
    [
      ['r1', 'session', []],
      ['r2', 'unknown', ['model']],
    ],
  )
  assert.deepEqual(view.roles[0].aliases, [])
  assert.equal(view.defaultRoleSource, 'session')
  // 字段来源缺失 → default；三色状态缺失 → 灰/unknown（不伪造 ready）。
  assert.equal(view.roles[0].fieldSources.name, 'default')
  assert.equal(view.roles[0].state.color, 'gray')
  assert.equal(view.roles[0].state.readiness, 'unknown')
  assert.deepEqual(view.channels, [])
})

test('Browser half：渲染期错误走统一日志（module/phase/version/stack），返回回退节点', async () => {
  const { exports, logs } = await loadClientHarness()
  const fallback = exports.__test.safeRender(
    'sidebar',
    'render',
    () => {
      throw new Error('render boom')
    },
    () => ({ type: 'p', props: { role: 'alert', children: 'fallback' } }),
  )
  assert.equal(fallback.type, 'p', '渲染失败必须返回回退节点（不抛）')

  const errLine = logs.find(([level]) => level === 'error')?.[1] ?? ''
  assert.match(errLine, /^\[meetingstone\] gui module=sidebar phase=render version=0\.1\.0-alpha /)
  assert.match(errLine, /error=render boom/)
  assert.match(errLine, /stack=/)
  assert.doesNotMatch(errLine, /token|secret|password|api[_-]?key/i, '日志不记录凭证')
})

test('Browser half：$mount 失败时 header/section/sidebar 都注册，header 不消失且可提示', async () => {
  const { registrations, injectCalls, react } = await loadClientHarness({
    mountError: new Error('mount boom'),
  })
  assert.equal(injectCalls.length, 0, 'mount 失败不得进入动态注入')
  const names = registrations.map((r) => r.options.name)
  assert.deepEqual(names, [
    'conversation.session.header.actions',
    'settings.section',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ])
  assert.equal(registrations[0].options.name, 'conversation.session.header.actions', 'header 必须最先注册')

  const section = registrations.find((r) => r.options.name === 'settings.section')
  const snapshot = await section.options.inject().list()
  assert.equal(snapshot.unavailable.code, 'REMOTE_MOUNT_FAILED')
  assert.match(snapshot.unavailable.message, /mount boom/)
  assert.deepEqual(snapshot.roles, [])

  const pane = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab')
  const paneResult = await pane.options.inject('sess-1').loadSession()
  assert.equal(paneResult.ok, false, 'mount 失败时侧栏 loader 返回错误结果而不是抛')
  assert.equal(paneResult.error.code, 'REMOTE_MOUNT_FAILED')
  assert.match(paneResult.error.message, /mount boom/)

  // header 仍在：render 时 remoteReady=false，点击显示「远程不可用」。
  const header = registrations[0]
  const props = header.options.inject('sess-h1')
  assert.equal(props.remoteReady, false)
  react.reset()
  const first = header.Component(props)
  const button = first.props.children.find((c) => c && c.type === 'button')
  assert.equal(button.props.title, 'remoteUnavailableHint')
  button.props.onClick()
  react.reset()
  const strings = []
  collectStrings(header.Component(props), strings)
  assert.ok(strings.includes('remoteUnavailableHint'), '点击后出现远程不可用提示')
})

test('Browser half：单个模块注册失败不影响其他模块（独立 guard）', async () => {
  const { registrations, logs } = await loadClientHarness({ failRegisterFor: 'settings.section' })
  const names = registrations.map((r) => r.options.name)
  assert.ok(names.includes('conversation.session.header.actions'), 'header 不受 section 失败影响')
  assert.ok(!names.includes('settings.section'), 'section 注册确实失败')
  assert.ok(names.includes('sidebar.right.pane.tab'), 'sidebar 不受 section 失败影响')

  const errorLine = logs.find(([level]) => level === 'error')?.[1] ?? ''
  assert.match(errorLine, /^\[meetingstone\] gui module=section phase=register version=0\.1\.0-alpha /)
  assert.match(errorLine, /register settings\.section boom/)
  assert.match(errorLine, /stack=/)
  assert.doesNotMatch(errorLine, /token|secret|password|api[_-]?key/i, '日志不记录凭证')
})

test('Browser half：缺少 slots 能力时 apply 不抛，三个模块各自记录错误', async () => {
  const { registrations, logs } = await loadClientHarness({ omitSlots: true })
  assert.deepEqual(registrations, [])
  const errors = logs.filter(([level]) => level === 'error').map(([, line]) => line)
  assert.equal(errors.length, 3, 'header / section / sidebar 各一条，互不影响')
  for (const line of errors) {
    assert.match(line, /^\[meetingstone\] gui module=(header|section|sidebar) phase=register version=0\.1\.0-alpha /)
    assert.match(line, /CAPABILITY_MISSING/)
    assert.doesNotMatch(line, /token|secret|password|api[_-]?key/i, '日志不记录凭证')
  }
})

test('Browser half：GUI 注册日志统一格式（模块/阶段/版本），成功也记录', async () => {
  const { logs } = await loadClientHarness()
  const infos = logs.filter(([level]) => level === 'info').map(([, line]) => line)
  for (const [module, phase] of [
    ['remote', 'mount'],
    ['header', 'register'],
    ['section', 'register'],
    ['sidebar', 'register'],
  ]) {
    assert.ok(
      infos.includes(`[meetingstone] gui module=${module} phase=${phase} version=0.1.0-alpha status=ok`),
      `缺少 ${module}/${phase} 日志`,
    )
  }
  assert.ok(infos.every((line) => !/token|secret|password|api[_-]?key/i.test(line)), '日志不记录凭证')
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
  assert.equal(props.remoteReady, true, 'remote 就绪时入口可用')
  assert.equal(typeof props.openRolePanel, 'function')
  const element = Component(props)
  const button = element.props.children.find((c) => c && c.type === 'button')
  assert.ok(button, '入口是按钮')
  // 无障碍：可访问名在外层 button，SVG 自身 aria-hidden。
  assert.equal(button.props['aria-label'], 'headerTitle')
  assert.equal(button.props.title, 'headerDesc')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.className, 'dsh-meetingstone-header-entry')
  // 宿主 token 样式：去掉默认粗边框 + 0.5px border token + 官方 sm toolbar 背景/圆角 + hover/focus 钩子。
  assert.match(button.props.style.border, /0\.5px solid var\(--dsw-alias-border-l3\)/)
  assert.match(button.props.style.background, /--dsw-alias-button-tool-bar-fill/)
  assert.match(button.props.style.borderRadius, /--dsw-radius-sm/)
  assert.equal(typeof button.props.onMouseEnter, 'function')
  assert.equal(typeof button.props.onFocus, 'function')
  // 内联 SVG（不再依赖 primitives.Icon）：16px、aria-hidden、focusable=false。
  const findSvg = (node) => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'svg') return node
    // stub jsx 不执行函数组件；展开一次（IconUsers）后再找。
    if (typeof node.type === 'function' && node.props?.children === undefined) {
      return findSvg(node.type(node.props))
    }
    const children = node.props?.children
    const list = Array.isArray(children) ? children : children ? [children] : []
    for (const child of list) {
      const found = findSvg(child)
      if (found) return found
    }
    return null
  }
  const svgNode = findSvg(button)
  assert.ok(svgNode, 'header 必须渲染内联 SVG')
  assert.equal(svgNode.props['aria-hidden'], 'true')
  assert.equal(svgNode.props.focusable, 'false')
  assert.equal(svgNode.props.width, 16)
  // 文案「角色」在按钮内可见（测试 locale 用 key 回退，真实 zh 字典在源码断言）。
  const buttonStrings = []
  collectStrings(button, buttonStrings)
  assert.ok(buttonStrings.includes('headerTitle'), '顶部入口显示文案')
  assert.equal(typeof button.props.onClick, 'function')
  button.props.onClick()
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
  // 官方契约：priority 是档位字符串 extension|builtin|fallback，不是数字。
  assert.equal(tab.priority, 'extension')
  assert.equal(typeof tab.priority, 'string')
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

test('Browser half：右侧栏列表只有名称 + 三色二态开关；详情展示字段来源并可恢复继承', async () => {
  const { exports, registrations, sessionCalls } = await loadClientHarness()
  const pane = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab')
  const props = pane.options.inject('sess-p1')
  assert.equal(props.sessionId, 'sess-p1')
  assert.equal(typeof props.loadSession, 'function')
  assert.equal(props.list, undefined, '侧栏不再消费无参 list 快照')
  assert.equal(typeof props.setOverride, 'function', '列表开关只写会话覆盖')
  assert.equal(typeof props.clearOverride, 'function', '字段可恢复继承')
  // B1：右侧栏只承载会话覆盖；全局角色编辑已移到设置页内联管理器，
  // 不再从这里注入 global writer（全局与会话入口彻底分离）。
  assert.equal(props.updateGlobalRole, undefined, '右侧栏不再承载全局写入')

  const result = await props.loadSession()
  assert.deepEqual(sessionCalls, ['sess-p1'], '必须带 sessionId 调 strict getSessionConfig')
  assert.equal(result.ok, true)
  const role = result.view.roles[0]
  assert.equal(role.roleId, 'role-sashi')
  assert.equal(role.sourceLayer, 'session', '来源层来自 sources.roles[].layer')
  assert.deepEqual(role.overrideFields, ['channel'], '覆盖来自 overrides[roleId]')
  assert.equal(role.state.color, 'green', '三色来自 Host roleStates')
  assert.equal(role.fieldSources['channel.model'], 'session')
  assert.equal(role.fieldSources.name, 'global')
  assert.equal(result.view.defaultRoleSource, 'project')

  const t = (k) => k
  const listTree = exports.__test.renderRolePane(t, result.view)
  const listStrings = []
  collectStringsDeep(listTree, listStrings)
  assert.ok(listStrings.includes('沙僧'), '角色名可见')
  assert.ok(listStrings.includes('roleListNote'), '面板说明可见')
  const switchNode = findNodeDeep(
    listTree,
    (node) => node.type === 'button' && node.props && node.props.role === 'switch',
  )
  assert.ok(switchNode, '每行有原生 role=switch 控件')
  assert.equal(switchNode.props['aria-checked'], true)
  assert.match(String(switchNode.props.style.background), /state-success-primary/, '绿色=启用且正常/未知')
  assert.ok(!listStrings.includes('SS'), '列表不显示别名')
  assert.ok(!listStrings.includes('flash-1') && !listStrings.includes('flash-2'), '列表不显示模型')
  assert.ok(!listStrings.includes('ch-acp-flash'), '列表不显示通道细节')

  const detailTree = exports.__test.renderRolePane(t, result.view, {
    selectedRoleId: 'role-sashi',
    scope: 'session',
    showScope: false,
    draft: exports.__test.draftOfRole(role),
  })
  const detailStrings = []
  collectStringsDeep(detailTree, detailStrings)
  // B2：单一角色设定 + CLI/模型/强度；不再有「通道」用户概念
  for (const key of ['fieldName', 'fieldAliases', 'fieldSetting', 'fieldCli', 'fieldModel', 'fieldReasoning']) {
    assert.ok(detailStrings.includes(key), `详情字段 ${key} 可见`)
  }
  assert.ok(detailStrings.includes('sourceGlobal'), '字段来源（全局）可见')
  assert.ok(detailStrings.includes('sourceSession'), '字段来源（会话）可见')
  assert.ok(detailStrings.includes('restoreInherit'), '会话覆盖字段有恢复继承')
  assert.ok(findNodeDeep(detailTree, (node) => node.type === 'input'), '详情可编辑（input）')
  assert.ok(findNodeDeep(detailTree, (node) => node.type === 'select'), 'CLI/模型是真实选项（select）')
  assert.ok(findNodeDeep(detailTree, (node) => node.type === 'textarea'), '角色设定可编辑（textarea）')
  // B1：不再渲染「本会话 / 全局」scope 切换按钮（全局编辑在设置页内联面板）。
  assert.ok(!detailStrings.includes('scopeSession'), '右侧栏无会话 scope 按钮')
  assert.ok(!detailStrings.includes('scopeGlobal'), '右侧栏无全局 scope 按钮')
})


test('Browser half：getSessionConfig 失败时 pane 只显示一行错误摘要（不抛、不空白）', async () => {
  const failure = {
    ok: false,
    error: { code: 'SESSION_GUI_SESSION_ROOT_UNKNOWN', message: '无法定位项目根' },
  }
  const { exports, registrations } = await loadClientHarness({ sessionValue: failure })
  const pane = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab')
  const result = await pane.options.inject('sess-x').loadSession()
  assert.equal(result.ok, false, 'loader 返回错误结果而不是 reject')
  assert.equal(result.error.code, 'SESSION_GUI_SESSION_ROOT_UNKNOWN')

  const t = (k) => k
  const tree = exports.__test.renderPaneError(t, result.error)
  const strings = []
  collectStringsDeep(tree, strings)
  assert.ok(strings.includes('paneTitle'), '标题仍在（不是空白）')
  assert.ok(strings.includes('roleListNote'), '面板说明仍在')
  assert.ok(
    strings.join(' ').includes('[SESSION_GUI_SESSION_ROOT_UNKNOWN] 无法定位项目根'),
    '错误码 + 摘要可见',
  )
  assert.ok(findNode(tree, (n) => n.props && n.props.role === 'alert'), '失败时是 alert')
  assert.ok(
    findNode(tree, (n) => n.props && n.props.style && n.props.style.whiteSpace === 'nowrap'),
    '错误摘要保持一行（nowrap）',
  )
})

test('Browser half：getSessionConfig 抛错时 loader 收口为 REMOTE_CALL_FAILED，不冒泡', async () => {
  const { registrations } = await loadClientHarness({ sessionThrows: new Error('gateway boom') })
  const pane = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab')
  const result = await pane.options.inject('sess-y').loadSession()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'REMOTE_CALL_FAILED')
  assert.match(result.error.message, /gateway boom/)
})

test('Browser half：list 失败（ok!==true）时 loader 抛错而非伪装', async () => {
  const { exports } = await loadClientHarness()
  const loader = exports.__test.makeLoader({
    async list() {
      return { ok: false, error: { code: 'SESSION_GUI_SESSION_ROOT_UNKNOWN', message: 'no root' } }
    },
  })
  await assert.rejects(() => loader(), /SESSION_GUI_SESSION_ROOT_UNKNOWN/)
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
  // P0-S0：带参会话 Remote 恢复，且必须使用真实 zod strict codec。
  assert.match(source, /method: 'getSessionConfig'/)
  assert.match(source, /method: 'setSessionOverride'/)
  assert.match(source, /method: 'clearSessionOverride'/)
  assert.match(source, /require\('zod'\)/, '浏览器侧必须复用宿主平台 seed 的 zod')
  assert.match(source, /mode: 'strict'/, '参数 codec 必须 strict')
  assert.doesNotMatch(source, /src-json[^\n]*parameters/, '不得用 src-json 伪造带参方法')
  // U1a：合规化——不再 require primitives，改为自绘控件 + 宿主 token。
  assert.doesNotMatch(
    source,
    /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/,
    '不得 require primitives（不在 asar node_modules，官方 practices.md:35 禁止）',
  )
  assert.doesNotMatch(source, /\bprimitives\./, '不得再使用 primitives.* 导出面')
  assert.match(source, /function Tag\(/, '本地最小 Tag')
  assert.match(source, /function IconUsers\(/, '内联 SVG 图标')
  assert.match(source, /var\(--dsw-alias-/, '样式使用宿主 token')
  assert.match(source, /priority: 'extension'/, 'priority 必须是官方档位字符串')
  // U1a：侧栏只读接 strict getSessionConfig；失败不抛。
  assert.match(source, /loadSession:/, '侧栏 seat 注入会话 loader')
  assert.match(source, /service\.getSessionConfig\(sessionId\)/, '调用 strict getSessionConfig')
  assert.match(source, /function makeSessionConfigLoader\(/, '独立的不抛 loader')
  // 顶部文案「角色」+ SVG（无 Icon 依赖）。
  assert.match(source, /headerTitle: '角色'/)
  assert.match(source, /IconUsers, \{ size: 16 \}/)
  // 渲染期错误也走统一日志（module/phase/version/stack）。
  assert.match(source, /function safeRender\(/, '渲染期 guard')
  assert.match(source, /guiLog\('error', module, phase/, '渲染错误走统一日志')
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

/**
 * 收集文本并展开“纯渲染组件”（如 CliList / RoleReadonlyCard）：
 * stub jsx 不会真正调用函数组件，需要测试手动展开才能看到其 children。
 */
function collectStringsDeep(node, acc) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    node.forEach((c) => collectStringsDeep(c, acc))
    return
  }
  if (typeof node === 'object') {
    const props = node.props || {}
    if (typeof node.type === 'function' && props.children === undefined) {
      const rendered = node.type(props)
      if (rendered !== undefined) {
        collectStringsDeep(rendered, acc)
        return
      }
    }
    if (props.children !== undefined) collectStringsDeep(props.children, acc)
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

/** 收集所有满足条件的节点（含函数组件展开一次）。 */
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

/** 返回第一个满足条件的节点（含函数组件展开一次），便于断言控件 props。 */
function findNodeDeep(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (pred(node)) return node
  const props = node.props || {}
  if (typeof node.type === 'function' && props.children === undefined) {
    return findNodeDeep(node.type(props), pred)
  }
  const children = Array.isArray(props.children) ? props.children : props.children ? [props.children] : []
  for (const child of children) {
    const found = findNodeDeep(child, pred)
    if (found) return found
  }
  return null
}

test('Browser half：设置页只剩两区（外部 CLI 连接 / 默认角色配置）+ 错误一行摘要', async () => {
  const { exports } = await loadClientHarness()
  const t = (k) => k
  const noop = () => {}

  const cliStates = [
    {
      cli: 'codex',
      label: 'Codex',
      userPreference: 'enabled',
      enabled: true,
      ready: 'ready',
      blockedReason: null,
      manualSteps: [],
      retryable: false,
      installed: true,
      version: '1.2.3',
      path: 'C:/codex.exe',
    },
    {
      cli: 'codebuddy',
      label: 'CodeBuddy',
      enabled: false,
      ready: 'blocked',
      blockedReason: 'not-installed',
      manualSteps: ['安装 CodeBuddy'],
      retryable: true,
    },
    {
      cli: 'claude',
      label: 'Claude Code',
      enabled: false,
      ready: 'unknown',
      blockedReason: 'evidence-missing',
      manualSteps: [],
      retryable: true,
    },
  ]
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
      cli: cliStates,
      cliError: null,
    },
  }

  const tree = exports.__test.renderSection(t, snapshot, { cliStates, openRoles: noop })
  const strings = []
  collectStringsDeep(tree, strings)

  // 只有两区
  assert.ok(strings.includes('cliSection'), '区 1 外部 CLI 连接存在')
  assert.ok(strings.includes('rolesSection'), '区 2 默认角色配置存在')
  for (const removed of [
    'collab',
    'advanced',
    'openAdvanced',
    'parallelLimit',
    'serializeWrites',
    'dispatchNotes',
    'limits',
    'rules',
    'models',
    'categoryHost',
    'hostName',
    'cliPaths',
    'channelInstances',
    'configFile',
    'projectConfigFile',
    'isolation',
  ]) {
    assert.ok(!strings.includes(removed), `已删除的区块/字段不再渲染：${removed}`)
  }

  // 三行只有名称 + Switch：不显示版本、路径、额度、通道 ID、徽章。
  for (const label of ['Codex', 'CodeBuddy', 'Claude Code']) {
    assert.ok(strings.includes(label), `${label} 行存在`)
  }
  assert.ok(!strings.includes('1.2.3'), '不显示版本')
  assert.ok(!strings.includes('C:/codex.exe'), '不显示路径')
  const switches = collectNodes(tree, (node) => node.type === 'button' && node.props && node.props.role === 'switch')
  assert.equal(switches.length, 3, '三行各一个原生 Switch')
  assert.deepEqual(
    switches.map((node) => node.props['aria-checked']),
    [true, false, false],
    'Switch 反映 Host 派生的 enabled（unset+ready 默认开）',
  )
  assert.match(String(switches[0].props.style.background), /state-success-primary/, '开启态绿色 token')

  // 区 2：模板名 + 一句说明 + 角色数量 + 管理入口。
  assert.ok(strings.includes('templateName'), '模板名存在')
  assert.ok(strings.includes('templateDesc'), '模板说明存在')
  assert.ok(strings.includes('roleCount'), '角色数量存在')
  assert.equal(
    strings.filter((value) => value === '2').length,
    1,
    '角色数量来自 snapshot.roles.length',
  )
  assert.ok(
    findNode(tree, (node) => {
      if (!node.props || node.type !== 'button') return false
      const tmp = []
      collectStrings(node, tmp)
      return tmp.includes('manageRoles')
    }),
    '「管理角色」入口存在',
  )

  // 无错误不占位。
  assert.ok(!findNode(tree, (node) => node.props && node.props.role === 'alert'), '无错误不渲染 alert')

  // 错误：一行摘要 + 详情默认折叠。
  const withError = {
    ...snapshot,
    lastError: { code: 'ROLE_NOT_FOUND', message: '没有这个角色', at: '2026-11-11T00:00:00.000Z', source: 'dispatch' },
  }
  const errTree = exports.__test.renderSection(t, withError, { cliStates, openRoles: noop })
  const errStrings = []
  collectStringsDeep(errTree, errStrings)
  assert.ok(findNode(errTree, (node) => node.props && node.props.role === 'alert'), '有错误时 alert')
  assert.ok(errStrings.join(' ').includes('ROLE_NOT_FOUND'), '错误码在摘要中可见')
  assert.ok(errStrings.includes('errorDetails'), '查看详情入口存在')
  assert.ok(!errStrings.includes('2026-11-11T00:00:00.000Z'), '详情默认折叠')
  assert.ok(
    findNode(
      errTree,
      (node) =>
        node.props &&
        node.props.style &&
        node.props.style.whiteSpace === 'nowrap' &&
        String(node.props.children).includes('ROLE_NOT_FOUND'),
    ),
    '摘要一行（nowrap）',
  )
  const expanded = exports.__test.renderSection(t, withError, {
    cliStates,
    errorOpen: true,
    openRoles: noop,
  })
  const expandedStrings = []
  collectStringsDeep(expanded, expandedStrings)
  assert.ok(expandedStrings.includes('errorHideDetails'))
  assert.ok(expandedStrings.includes('2026-11-11T00:00:00.000Z'))

  // preflight 失败：开关保持关 + 一行摘要 + 人工步骤 + 重新检测。
  const failed = exports.__test.renderSection(t, snapshot, {
    cliStates,
    cliFailures: {
      codex: {
        code: 'CLI_PREFERENCE_PREFLIGHT_FAILED',
        message: '检测未通过（not-installed），保持关闭',
        manualSteps: ['安装对应 CLI', '点「重新检测」'],
        retryable: true,
      },
    },
    openRoles: noop,
  })
  const failedStrings = []
  collectStringsDeep(failed, failedStrings)
  assert.ok(failedStrings.join(' ').includes('保持关闭'), '失败摘要可见')
  assert.ok(failedStrings.includes('manualSteps：安装对应 CLI；点「重新检测」') || failedStrings.some((value) => String(value).startsWith('manualSteps')), '人工步骤标签可见')
  assert.ok(failedStrings.includes('cliRetry'), '重新检测入口可见')
  const failedSwitches = collectNodes(failed, (node) => node.type === 'button' && node.props && node.props.role === 'switch')
  assert.equal(failedSwitches[0].props['aria-checked'], false, '失败后开关保持关（不做乐观假开启）')
})

test('B1：设置页「管理角色」内联展开全局角色管理（不打开右侧栏、无会话 scope）', async () => {
  const { exports, registrations, sidebarOpenCalls } = await loadClientHarness()
  const t = (k) => k
  const section = registrations.find((r) => r.options.name === 'settings.section')
  const injected = section.options.inject()
  assert.equal(typeof injected.updateGlobalRole, 'function')
  assert.equal(typeof injected.createGlobalRole, 'function', 'B1b：注入新增全局角色')
  assert.equal(typeof injected.deleteGlobalRole, 'function', 'B1b：注入删除全局角色')
  assert.equal(injected.openRoles, undefined, '不再注入会跳右侧栏的入口')

  const snapshot = exports.__test.normalizeSnapshot({
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

  // 列表态：内联在设置页渲染，不调用 sidebarRight.openTab。
  const listTree = exports.__test.renderSection(t, snapshot, {
    cliStates: [],
    managerOpen: true,
    manager: { onSelect: () => {} },
  })
  const listStrings = []
  collectStringsDeep(listTree, listStrings)
  assert.ok(listStrings.includes('globalRolesTitle'), '全局角色管理内联标题')
  assert.ok(listStrings.includes('globalRolesNote'), '说明写全局、会话覆盖在右侧栏')
  assert.ok(listStrings.includes('沙僧'), '全局角色列表可见')
  assert.ok(listStrings.includes('globalRoleBadge'), '全局标识可见')
  assert.deepEqual(sidebarOpenCalls, [], '设置页内联管理不打开右侧栏 tab')

  // 详情态：全局 scope 字段可编辑，无 scope 切换按钮（入口分离）。
  const detailTree = exports.__test.renderSection(t, snapshot, {
    cliStates: [],
    managerOpen: true,
    manager: {
      selectedRoleId: 'role-sashi',
      draft: exports.__test.draftOfRole(snapshot.roles[0]),
      onSelect: () => {},
      onDraft: () => {},
      onSave: () => {},
    },
  })
  const detailStrings = []
  collectStringsDeep(detailTree, detailStrings)
  for (const key of ['fieldName', 'fieldSetting', 'scopeGlobalNote']) {
    assert.ok(detailStrings.includes(key), `全局详情应含 ${key}`)
  }
  assert.ok(!detailStrings.includes('scopeSession'), '无会话 scope 按钮')
  assert.ok(!detailStrings.includes('scopeGlobal'), '无全局 scope 按钮（已是全局面板）')
  assert.ok(findNodeDeep(detailTree, (node) => node.type === 'textarea'), '角色设定可编辑')
})

test('strict 契约：Host descriptor 与 Client contribution 的 method/参数/typeSymbol 完全一致', async () => {
  const { createTypertRemoteInfo } = await import('@deepseek-ai/dsh-typert-protocol/remote-info')
  const { createSessionRemoteSpec } = await import('../src/gui/typert-spec.js')
  const host = createTypertRemoteInfo(createSessionRemoteSpec(z), z).descriptors
  const { exports, mounted } = await loadClientHarness()
  assert.deepEqual(exports.__test.SESSION_TYPES, SESSION_REMOTE_TYPES, '全部 typeSymbol 必须与 Host 契约一致')
  const client = mounted[0].descriptors.filter((d) => d.method !== 'list')

  assert.deepEqual(client.map((d) => d.method), host.map((d) => d.method))
  for (const hostDesc of host) {
    const clientDesc = client.find((d) => d.method === hostDesc.method)
    assert.ok(clientDesc, `client 缺少 ${hostDesc.method}`)
    assert.equal(clientDesc.id, hostDesc.id)
    assert.equal(clientDesc.parameters.length, hostDesc.parameters.length)
    for (let i = 0; i < hostDesc.parameters.length; i += 1) {
      assert.equal(clientDesc.parameters[i].wire, hostDesc.parameters[i].wire)
      assert.equal(clientDesc.parameters[i].source, hostDesc.parameters[i].source)
      assert.equal(
        clientDesc.parameters[i].acceptsUndefined ?? false,
        hostDesc.parameters[i].acceptsUndefined ?? false,
      )
      assert.equal(
        clientDesc.parameters[i].codec.typeSymbol,
        hostDesc.parameters[i].codec.typeSymbol,
        `${hostDesc.method}.${hostDesc.parameters[i].wire} typeSymbol 必须与 Host 一致`,
      )
      assert.equal(clientDesc.parameters[i].codec.mode, 'strict')
    }
  }
})

test('Browser half：zod 不可用时只挂无参 list（不伪造 strict）', async () => {
  const { mounted, logs } = await loadClientHarness({ omitZod: true })
  assert.equal(mounted.length, 1)
  assert.deepEqual(mounted[0].descriptors.map((d) => d.method), ['list'])
  const hasStrictLog = logs.some(([level, line]) => level === 'warn' && line.includes('ZOD_UNAVAILABLE'))
  assert.equal(hasStrictLog, true, 'zod 不可用时必须留下明确降级日志')
})
