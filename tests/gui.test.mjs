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
  // B3：list（无参 SRC）+ 5 个配置方法；会话级 remote 已整体下线。
  assert.equal(mounted[0].descriptors.length, 6)
  assert.deepEqual(
    mounted[0].descriptors.map((d) => d.method),
    ['list', 'setCliEnabled', 'refreshCli', 'updateGlobalRole', 'createGlobalRole', 'deleteGlobalRole'],
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

  // 参数 codec 必须是 strict + 真实 zod（配置方法）。
  const byMethod = Object.fromEntries(mounted[0].descriptors.map((d) => [d.method, d]))
  assert.deepEqual(byMethod.setCliEnabled.parameters.map((p) => p.wire), ['cli', 'enabled'])
  assert.deepEqual(byMethod.refreshCli.parameters.map((p) => p.wire), ['cli', 'force'])
  assert.deepEqual(byMethod.updateGlobalRole.parameters.map((p) => p.wire), ['roleId', 'patch'])
  assert.deepEqual(byMethod.createGlobalRole.parameters.map((p) => p.wire), ['role'])
  assert.deepEqual(byMethod.deleteGlobalRole.parameters.map((p) => p.wire), ['roleId'])
  assert.ok(
    Object.entries(byMethod)
      .filter(([method]) => method !== 'list')
      .every(([, descriptor]) =>
        descriptor.parameters.every((p) => p.codec.mode === 'strict' && p.codec.typeSymbol),
      ),
    '配置方法参数全部 strict',
  )

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
    capabilitiesRefreshedAt: null,
    capabilitiesErrors: [],
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
    capabilitiesRefreshedAt: null,
    capabilitiesErrors: [],
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

test('Browser half：B2c 能力目录收窄（4 CLI 形状/来源）且 capabilitiesOf 补齐 4 项', async () => {
  const { exports } = await loadClientHarness()
  const entry = {
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', provider: 'codex-sol', source: 'discovered' }],
    strengths: [{ id: 'high', label: 'High', source: 'discovered' }],
    sources: { models: 'discovered', strengths: 'discovered' },
    refreshedAt: 1700000000000,
    errors: ['probe partial'],
  }
  const normalized = exports.__test.normalizeCapabilities([entry, { id: 'unknown-cli' }, null])
  assert.equal(normalized.length, 1)
  assert.equal(normalized[0].models[0].provider, 'codex-sol')
  assert.equal(normalized[0].sources.models, 'discovered')
  assert.equal(normalized[0].refreshedAt, 1700000000000)

  // capabilitiesOf：部分/缺失时仍返回固定 4 个 CLI（空目录标记 unknown），不把 ch-* 当 CLI。
  const four = exports.__test.capabilitiesOf({ capabilities: [entry] })
  assert.deepEqual(four.map((item) => item.id), ['dsh', 'claude', 'codex', 'codebuddy'])
  assert.equal(four.find((item) => item.id === 'codex').models.length, 1)
  assert.deepEqual(four.find((item) => item.id === 'dsh').models, [])
  assert.equal(exports.__test.capabilitySourceKey('discovered'), 'sourceDiscovered')
  assert.equal(exports.__test.capabilitySourceKey('static'), 'sourceStatic')
  assert.equal(exports.__test.capabilitySourceKey('bogus'), 'sourceUnknown')
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
  assert.match(errLine, /^\[meetingstone\] gui module=sidebar phase=render version=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? /)
  assert.match(errLine, /error=render boom/)
  assert.match(errLine, /stack=/)
  assert.doesNotMatch(errLine, /token|secret|password|api[_-]?key/i, '日志不记录凭证')
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
  // B3：会话级 remote / 角色 slot 必须不存在；只保留配置方法。
  assert.doesNotMatch(source, /method: '(getSessionConfig|setSessionOverride|clearSessionOverride)'/)
  assert.doesNotMatch(source, /registerHeaderAction|registerSidebarTab|SidebarRolePane/)
  assert.match(source, /method: 'updateGlobalRole'/)
  assert.match(source, /method: 'createGlobalRole'/)
  assert.match(source, /method: 'deleteGlobalRole'/)
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

test('B3：只注册 settings.section，无 header/sidebar 角色 slot', async () => {
  const { registrations } = await loadClientHarness()
  assert.deepEqual(
    registrations.map((r) => r.options.name),
    ['settings.section'],
    '对话页头入口与右侧栏角色面板已下线',
  )
})

test('B3：Remote 契约只剩 list + 5 个配置方法（无会话覆盖 remote）', async () => {
  const { mounted, exports } = await loadClientHarness()
  const methods = mounted[0].descriptors.map((d) => d.method)
  assert.deepEqual(methods, [
    'list',
    'setCliEnabled',
    'refreshCli',
    'updateGlobalRole',
    'createGlobalRole',
    'deleteGlobalRole',
  ])
  for (const forbidden of ['getSessionConfig', 'setSessionOverride', 'clearSessionOverride']) {
    assert.equal(methods.includes(forbidden), false, '会话级 remote 必须不存在：' + forbidden)
    assert.equal(
      exports.__test.REMOTE_CONTRIBUTION.descriptors.some((d) => d.method === forbidden),
      false,
    )
  }
})

test('B3：$mount 失败时仍注册 settings.section 并可解释错误', async () => {
  const { registrations } = await loadClientHarness({ mountError: new Error('mount boom') })
  assert.deepEqual(registrations.map((r) => r.options.name), ['settings.section'])
  const snapshot = await registrations[0].options.inject().list()
  assert.equal(snapshot.unavailable.code, 'REMOTE_MOUNT_FAILED')
  assert.match(snapshot.unavailable.message, /mount boom/)
})

test('B3：slots 缺失时只记录 section 一条注册错误', async () => {
  const { registrations, logs } = await loadClientHarness({ omitSlots: true })
  assert.deepEqual(registrations, [])
  const errors = logs.filter(([level]) => level === 'error').map(([, line]) => line)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /module=section phase=register/)
})

test('B3：注册日志只含 remote/section（无 header/sidebar）', async () => {
  const { logs, exports } = await loadClientHarness()
  const CLIENT_VERSION = exports.__test.PLUGIN_VERSION
  const infos = logs.filter(([level]) => level === 'info').map(([, line]) => line)
  for (const [module, phase] of [['remote', 'mount'], ['section', 'register']]) {
    assert.ok(
      infos.includes(
        `[meetingstone] gui module=${module} phase=${phase} version=${CLIENT_VERSION} status=ok`,
      ),
    )
  }
  assert.ok(infos.every((line) => !/module=(header|sidebar)/.test(line)))
})

test('B3：channels 声明合并进能力目录（config 优先于 static，不覆盖 discovered）', async () => {
  const { exports } = await loadClientHarness()
  const backend = [
    {
      id: 'codebuddy',
      label: 'CodeBuddy',
      provider: 'acp',
      models: [
        { id: 'old-static', label: 'old', provider: 'acp', source: 'static' },
        { id: 'discovered-1', label: 'd1', provider: 'acp', source: 'discovered' },
      ],
      strengths: [],
      sources: { models: 'static', strengths: 'unknown' },
      refreshedAt: null,
      errors: [],
    },
  ]
  const view = {
    capabilities: backend,
    global: {
      channels: [
        { channelId: 'ch-acp-flash', kind: 'acp-cli', provider: 'acp', model: 'glm-5.3-flash', reasoning: 'high' },
      ],
    },
  }
  const capabilities = exports.__test.capabilitiesOf(view)
  assert.deepEqual(capabilities.map((c) => c.id), ['dsh', 'claude', 'codex', 'codebuddy'])
  const codebuddy = capabilities.find((c) => c.id === 'codebuddy')
  const model = codebuddy.models.find((m) => m.id === 'glm-5.3-flash')
  assert.equal(model.source, 'config', 'channels 声明以 config 来源并入')
  assert.equal(model.provider, 'acp')
  assert.equal(codebuddy.models.find((m) => m.id === 'old-static').source, 'static', '静态项保留原来源')
  assert.equal(
    codebuddy.models.find((m) => m.id === 'discovered-1').source,
    'discovered',
    '不覆盖动态发现项',
  )
  assert.equal(codebuddy.sources.models, 'config')
  assert.equal(codebuddy.strengths.find((s) => s.id === 'high').source, 'config')
  assert.equal(codebuddy.sources.strengths, 'config')
  assert.equal(exports.__test.capabilitySourceKey('config'), 'sourceConfig')

  // 保存映射：config 模型 + 匹配实例 → 写回内部 channel（channelId 保留）
  const combo = exports.__test.channelForCombo(
    (key) => key,
    { cli: 'codebuddy', model: 'glm-5.3-flash', reasoning: 'high' },
    capabilities,
    view.global.channels.map((c) => ({ ...c })),
  )
  assert.equal(combo.error, null)
  assert.equal(combo.channel.channelId, 'ch-acp-flash')
  assert.equal(combo.channel.kind, 'acp-cli')
  assert.equal(combo.channel.provider, 'acp')
  assert.equal(combo.channel.model, 'glm-5.3-flash')
  assert.equal(combo.channel.reasoning, 'high')
})
