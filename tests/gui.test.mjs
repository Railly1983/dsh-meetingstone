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
  const remote = {
    async $mount(contribution) {
      mounted.push(contribution)
      return async () => {}
    },
    meetingstone: {
      async list() {
        return remoteValue
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
    remote,
    logger: { info() {}, warn() {} },
  }

  await exports.apply(ctx)
  return { exports, registrations, mounted, remote }
}

test('Browser half：注册 settings.section 并通过 remote.meetingstone.list 取真实快照', async () => {
  const { exports, registrations, mounted } = await loadClientHarness()

  assert.equal(registrations.length, 1)
  const { options, Component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'meetingstone')
  assert.equal(options.order, 100)
  assert.equal(options.locale, 'settings.meetingstone')
  assert.equal(typeof Component, 'function')
  assert.equal(options.label(), 'nav')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'remote'])

  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].package, 'dsh-meetingstone')
  assert.deepEqual(mounted[0].descriptors, [
    {
      id: 'dsh-meetingstone#meetingstone/list',
      service: 'meetingstone',
      namespace: 'meetingstone',
      method: 'list',
      parameters: [],
      invocation: { kind: 'direct' },
      result: { mode: 'src-json' },
    },
  ])

  const injected = options.inject()
  const snapshot = await injected.list()
  assert.deepEqual(snapshot.roles, [
    { roleId: 'role-sashi', name: '沙僧', aliases: ['SS'], enabled: true, availability: 'available' },
  ])
  assert.deepEqual(snapshot.channels, [{ channelId: 'ch-acp-flash', kind: 'acp-cli' }])
  assert.equal(snapshot.lastError.code, 'ROLE_NOT_FOUND')
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
  assert.deepEqual(exports.__test.normalizeSnapshot(null), {
    roles: [],
    channels: [],
    lastError: null,
  })
  assert.deepEqual(exports.__test.normalizeSnapshot({ roles: [null, 1], channels: 'x', lastError: 3 }), {
    roles: [],
    channels: [],
    lastError: null,
  })
})

test('client 源文件不再内置占位角色/通道快照', async () => {
  const source = await readFile(join(root, 'src/client/index.js'), 'utf8')
  assert.doesNotMatch(source, /SNAPSHOT/, '不应保留占位 SNAPSHOT')
  assert.doesNotMatch(source, /占位数据/, '不应保留占位文案')
  assert.match(source, /ctx\.remote\[REMOTE_SERVICE\]\.list\(\)/)
})
