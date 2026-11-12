// @ts-check
/**
 * host 实现层的**真实执行**测试 —— 专门抓「方法体写了但一调就崩」这类缺陷。
 *
 * ## 为什么需要这个文件（2026-11-12 用户真机缺陷）
 *
 * 用户点「刷新能力」→ 红字 `gateway/internal capabilityCatalog is not defined`。
 *
 * 根因：`refreshCli`（`registerGuiRemote` 作用域）引用了 `capabilityCatalog`
 * （`createGuiState` 作用域）。**只有真的调用这个方法，函数体才会求值，
 * 未定义变量才会暴露。**
 *
 * ## 与 tests/host-remote-scope.test.mjs 的区别
 *
 * 那个文件用 `registerGuiRemote` 的返回值判断（`registered !== true` 就 return）。
 * 但在普通 Node 环境里 `@deepseek-ai/dsh-typert-protocol` **不可用**
 * （它只在宿主 app.asar 里），于是 `registerGuiRemote` 返回
 * `{ registered: false, reason: 'TYPERT_UNAVAILABLE' }` —— **所有断言被静默跳过**。
 *
 * 本文件改用**桩协议**注入，让 `registerGuiRemote` 真正跑完、
 * 拿到真实 `instance`，然后**真的调 refreshCli**。
 *
 * 这正是小白的审计报告（`2026-11-12-verification-audit.md` §3.2）指出的
 * 「host 实现层」缺口：之前的验证全在渲染层，实现体零覆盖。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Module } from 'node:module'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)

/**
 * 桩掉 `@deepseek-ai/dsh-typert-protocol`，返回最小可用的协议形状。
 *
 * 只复刻 `host.js` 真正用到的三样东西：
 * - `TypertRemoteService`：一个可被 class 继承的基类
 * - `Remote`：装饰器工厂，`Remote(name)` 返回可被调用的 decorator
 * - `RemoteError`：带 code 的 Error 子类
 *
 * **不动 host.js 的任何实现**，只替换这个外部依赖 —— 这样测到的就是真实实现体。
 */
function installProtocolStub() {
  class RemoteError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
      super(message)
      this.name = 'RemoteError'
      this.code = code
    }
  }

  class TypertRemoteService {
    constructor() {}
  }

  /** 复刻 host.js 期望的 Remote 形状：`Remote(name)` → decorator(value, context) */
  function Remote(/** @type {string} */ _name) {
    return function decorator(/** @type {any} */ _value, /** @type {any} */ context) {
      if (context && typeof context.addInitializer === 'function') {
        context.addInitializer(function () {
          // marker 打到原型上；测试里不校验 marker 内容
          const proto = Object.getPrototypeOf(this)
          if (!proto.__meetingstoneSrcMethods) proto.__meetingstoneSrcMethods = []
          proto.__meetingstoneSrcMethods.push(_name)
        })
      }
    }
  }

  const stub = { TypertRemoteService, Remote, RemoteError }

  const originalLoad = Module._load
  // @ts-expect-error 运行时打补丁
  Module._load = function patched(request, parent, isMain) {
    if (request === '@deepseek-ai/dsh-typert-protocol') return stub
    return originalLoad.call(this, request, parent, isMain)
  }
  return () => {
    // @ts-expect-error 还原
    Module._load = originalLoad
  }
}

/** 造一套最小可用 deps（configApi + capabilityCatalog）。 */
function makeDeps(overrides = {}) {
  /** @type {any[]} */
  const refreshCalls = []
  const capabilityCatalog = {
    async refresh(cli, opts) {
      refreshCalls.push({ cli, opts })
      return { ok: true, refreshed: [cli ?? 'all'], refreshedAt: 1700000000000, errors: [] }
    },
    snapshot() {
      return {
        capabilities: [
          {
            id: 'dsh',
            label: 'DeepSeek Harness',
            provider: 'spawn',
            models: [{ id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', provider: 'workbuddy', source: 'discovered' }],
            strengths: [{ id: 'high', label: 'high', source: 'discovered' }],
            sources: { models: 'discovered', strengths: 'discovered' },
            refreshedAt: 1700000000000,
            errors: [],
          },
        ],
        refreshedAt: 1700000000000,
        errors: [],
      }
    },
  }

  const configApi = {
    async preflightCli(cli) {
      return { ok: true, cli, preflight: { installed: true, version: '1.0.0', path: `C:/${cli}.exe` } }
    },
    getCliPreference() {
      return { ok: true, preference: 'enabled' }
    },
    async setCliEnabled(cli, enabled) {
      return { ok: true, cli, enabled }
    },
    async updateGlobalRole(roleId, patch) {
      return { ok: true, roleId, patch }
    },
    async createGlobalRole(role) {
      return { ok: true, role }
    },
    async deleteGlobalRole(roleId) {
      return { ok: true, roleId }
    },
  }

  return {
    refreshCalls,
    capabilityCatalog,
    deps: {
      snapshot: async () => ({ roles: [], channels: [], lastError: null, global: {} }),
      configApi,
      ...(overrides.omitCapabilities === true ? {} : { capabilities: capabilityCatalog }),
    },
  }
}

/**
 * 用桩协议注册 remote，返回真实实例。
 * @param {any} deps
 */
async function makeInstance(deps) {
  const restore = installProtocolStub()
  try {
    // 每次都要拿到**新加载**的模块，否则 Module._load 桩来不及生效
    const url = new URL('../src/gui/host.js', import.meta.url).href
    const mod = await import(url + '?t=' + Math.random())
    const outcome = mod.registerGuiRemote(
      {
        typert: { register: (spec) => spec },
        effect: () => {},
        get: () => null,
        logger: { info() {}, warn() {}, error() {} },
      },
      deps,
    )
    return { outcome, instance: outcome.instance ?? null, mod }
  } finally {
    restore()
  }
}

test('【真调】registerGuiRemote 能注册成功（桩协议下）', async () => {
  const { deps } = makeDeps()
  const { outcome, instance } = await makeInstance(deps)
  assert.equal(
    outcome.registered,
    true,
    `注册失败会让后续所有实现体测试被静默跳过（reason=${outcome.reason}）`,
  )
  assert.ok(instance, '必须拿到 instance 才能真调方法')
})

test('【真调】refreshCli 不抛 ReferenceError（这就是用户看到的红字）', async () => {
  const { deps } = makeDeps()
  const { instance } = await makeInstance(deps)
  assert.ok(instance, '前提：注册成功')

  // 这一行就是 2026-11-12 真机崩溃的位置。
  // 旧代码在这里抛 `ReferenceError: capabilityCatalog is not defined`，
  // 被宿主包成 `gateway/internal capabilityCatalog is not defined` 显示成红字。
  let error = null
  try {
    await instance.refreshCli('codex', true)
  } catch (e) {
    error = e
  }
  if (error) {
    const message = String(error?.message ?? error)
    assert.ok(
      !/is not defined/.test(message),
      `refreshCli 抛了 ReferenceError 形态的错误（作用域越界）：${message}`,
    )
  }
})

test('【真调】refreshCli("dsh") 返回能力目录且可 JSON 往返', async () => {
  const { deps, refreshCalls } = makeDeps()
  const { instance } = await makeInstance(deps)
  assert.ok(instance)

  const result = await instance.refreshCli('dsh', true)
  assert.equal(result.ok, true)
  assert.equal(result.cli, null, 'dsh 是内置通道，不该返回 CLI 状态')
  assert.ok(Array.isArray(result.capabilities), '要回能力目录')
  assert.equal(refreshCalls.length, 1, '要真的调一次 capabilityCatalog.refresh')
  assert.equal(refreshCalls[0].cli, 'dsh')

  // 序列化边界：gateway 用 JSON 传输，返回值必须能无损往返
  const roundTrip = JSON.parse(JSON.stringify(result))
  assert.deepEqual(roundTrip, result, 'refreshCli 的返回值必须能 JSON 无损往返')
})

test('【真调】refreshCli 外部 CLI 走 preflight 且返回值可序列化', async () => {
  const { deps } = makeDeps()
  const { instance } = await makeInstance(deps)
  assert.ok(instance)

  const result = await instance.refreshCli('codex', true)
  assert.equal(result.ok, true)
  assert.ok(result.cli, '外部 CLI 要返回状态')
  assert.ok(Array.isArray(result.capabilities))
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('【真调】capabilities 缺失时抛 RemoteError 而非 ReferenceError', async () => {
  const { deps } = makeDeps({ omitCapabilities: true })
  const { instance } = await makeInstance(deps)
  assert.ok(instance)

  await assert.rejects(
    () => instance.refreshCli('codex', true),
    (error) => {
      const message = String(error?.message ?? error)
      assert.ok(
        !/is not defined/.test(message),
        `不允许 ReferenceError 形态（宿主会包成红字）：${message}`,
      )
      // 应该是可识别的业务错误
      assert.ok(
        error?.code === 'MEETINGSTONE_GUI_CAPABILITIES_UNAVAILABLE' ||
          /能力目录未装配/.test(message),
        `应是可识别的 RemoteError，实际 code=${error?.code} message=${message}`,
      )
      return true
    },
  )
})

test('【真调】其余 remote 方法都能被调用且不抛 ReferenceError', async () => {
  const { deps } = makeDeps()
  const { instance } = await makeInstance(deps)
  assert.ok(instance)

  const calls = [
    ['setCliEnabled', ['codex', true]],
    ['updateGlobalRole', ['role-x', { name: 'n' }]],
    ['createGlobalRole', [{ roleId: 'role-x', name: 'n' }]],
    ['deleteGlobalRole', ['role-x']],
  ]
  for (const [name, args] of calls) {
    const fn = instance[name]
    if (typeof fn !== 'function') continue
    try {
      // @ts-expect-error 动态调用
      await fn.apply(instance, args)
    } catch (error) {
      const message = String(error?.message ?? error)
      assert.ok(
        !/is not defined/.test(message),
        `${name} 抛 ReferenceError 形态（引用了别的作用域的变量）：${message}`,
      )
    }
  }
})


test('【全量】列出并调用所有 remote 方法，报告可序列化性', async () => {
  const { deps } = makeDeps()
  const { instance } = await makeInstance(deps)
  assert.ok(instance, '前提：注册成功')
  const proto = Object.getPrototypeOf(instance)
  const methods = Object.getOwnPropertyNames(proto).filter(
    (n) => n !== 'constructor' && typeof instance[n] === 'function',
  )
  console.log('    [methods] ' + methods.join(', '))
  const args = {
    list: [],
    setCliEnabled: ['codex', true],
    refreshCli: ['codex', true],
    updateGlobalRole: ['role-x', {}],
    createGlobalRole: [{}],
    deleteGlobalRole: ['role-x'],
  }
  for (const name of methods) {
    if (!(name in args)) continue
    const r = await instance[name](...args[name])
    const ser = JSON.stringify(r)
    assert.notEqual(ser, undefined, name + ' 的返回值必须可 JSON 序列化')
    assert.ok(!/is not defined/.test(JSON.stringify(r || {})), name + ' 返回值里不该含未定义错误')
  }
})
