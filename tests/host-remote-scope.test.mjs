// @ts-check
/**
 * Host Remote 方法的**作用域完整性**测试。
 *
 * ## 为什么需要这个文件
 *
 * 2026-11-12 用户真机报告：「刷新能力一点就红字报错」，
 * 报错原文 `gateway/internal capabilityCatalog is not defined`。
 *
 * 根因：`refreshCli` 在 `registerGuiRemote` 的作用域里引用了
 * `capabilityCatalog`，而那个变量定义在 `createGuiState` 的闭包里。
 * 两个函数在两个作用域，**引用即崩溃**。
 *
 * ## 为什么原有测试没抓到
 *
 * 之前的 `gui.test.mjs` 测的是「注册是否成功」「返回形状对不对」，
 * 但**没有真正调用带参方法**（refreshCli / updateGlobalRole / ...）。
 * 一个方法只有在被调用时才会求值函数体，未定义的变量才会暴露。
 *
 * 所以本文件的核心手法：**把每个 remote 方法都真的调一遍**，
 * 用最小可用 deps，断言它不抛 ReferenceError。
 *
 * 这类缺陷的特征是「静态检查发现不了、只有执行才发现」，所以必须真调。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createGuiState, registerGuiRemote } from '../src/gui/host.js'

/**
 * 造一组最小可用依赖。
 *
 * @param {{ capabilities?: any }} [overrides]
 */
function makeDeps(overrides = {}) {
  /** @type {any[]} */
  const refreshCalls = []
  const capabilityCatalog =
    overrides.capabilities === undefined
      ? {
          async refresh(cli, opts) {
            refreshCalls.push({ cli, opts })
            return { ok: true, refreshed: [cli ?? 'all'], refreshedAt: 1, errors: [] }
          },
          snapshot() {
            return {
              capabilities: [
                { id: 'dsh', label: 'DeepSeek Harness', models: [], strengths: [], source: 'unknown' },
                { id: 'codex', label: 'Codex', models: [], strengths: [], source: 'unknown' },
              ],
              refreshedAt: 1,
              errors: [],
            }
          },
        }
      : overrides.capabilities

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
      ...(capabilityCatalog ? { capabilities: capabilityCatalog } : {}),
    },
  }
}

/**
 * 取一个可调用的 remote 实例。
 *
 * `registerGuiRemote` 在无 Typert 宿主时返回 `registered:false`，
 * 此时它内部已 `return`，拿不到实例 —— 这类环境下本测试跳过（返回 null）。
 */
function makeRemote(deps) {
  /** @type {any[]} */
  const registered = []
  const fakeCtx = {
    typert: {
      register(spec) {
        registered.push(spec)
        return spec
      },
    },
    effect() {},
    get() {
      return null
    },
  }
  const outcome = registerGuiRemote(fakeCtx, deps)
  return { outcome, registered }
}

test('createGuiState 必须向外暴露 capabilities（registerGuiRemote 依赖它）', () => {
  const gui = createGuiState({})
  assert.ok(
    gui.capabilities && typeof gui.capabilities.refresh === 'function',
    'createGuiState 的返回值必须带 capabilities，否则 registerGuiRemote 里的 refreshCli 会抛 ReferenceError',
  )
  assert.ok(typeof gui.capabilities.snapshot === 'function', 'capabilities 要有 snapshot')
})

test('refreshCli 在 capabilities 缺失时抛 RemoteError，不抛 ReferenceError', async () => {
  // 关键断言：错误**必须是可识别的 RemoteError**，不是 ReferenceError。
  // ReferenceError 会被宿主包成 `gateway/internal xxx is not defined` 红字。
  const { deps } = makeDeps({ capabilities: null })
  const { outcome, registered } = makeRemote(deps)

  if (outcome.registered !== true) {
    assert.ok(true, `跳过（本机无 Typert）：${outcome.reason ?? 'unknown'}`)
    return
  }

  const spec = registered.find((s) => s && typeof s.refreshCli === 'function')
  assert.ok(spec, 'refreshCli 应已注册')
  await assert.rejects(
    () => spec.refreshCli('codex', true),
    (error) => {
      const message = String(error?.message ?? error)
      assert.ok(
        !/is not defined/.test(message),
        `不允许抛 ReferenceError 形态的错误（宿主会包成红字）：${message}`,
      )
      return true
    },
  )
})

test('源码契约：src/index.js 必须把 gui.capabilities 传给 registerGuiRemote', async () => {
  // **这条是专门钉死 2026-11-12 那个真机缺陷的。**
  //
  // 缺陷形态：`registerGuiRemote` 里的 refreshCli 用了 `capabilityCatalog`，
  // 但调用方没把能力目录传进来 → ReferenceError → 宿主包成红字。
  //
  // 上面几条运行时测试抓不到它，因为 makeDeps 是我们自己拼的 deps，
  // 而真实缺陷在 **src/index.js 的调用点**。所以这里直接查源码契约。
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /registerGuiRemote\s*\(\s*ctx\s*,\s*\{[\s\S]*?capabilities\s*:/,
    'src/index.js 的 registerGuiRemote 调用必须传 capabilities —— ' +
      '不传的话 refreshCli 会引用到未定义变量，真机表现为「刷新能力一点就红字」',
  )
})

test('refreshCli 正常路径：dsh 只刷能力，不调 preflight', async () => {
  const { deps, refreshCalls } = makeDeps()
  const { outcome, registered } = makeRemote(deps)
  if (outcome.registered !== true) return

  const spec = registered.find((s) => s && typeof s.refreshCli === 'function')
  assert.ok(spec, 'refreshCli 应已注册')
  const result = await spec.refreshCli('dsh', true)
  assert.equal(result.ok, true)
  assert.equal(result.cli, null, 'dsh 是内置通道，不该返回 CLI 状态')
  assert.ok(Array.isArray(result.capabilities), '要回能力目录')
  assert.equal(refreshCalls.length, 1, '要真的调一次 capabilityCatalog.refresh')
  assert.equal(refreshCalls[0].cli, 'dsh')
})

test('refreshCli 正常路径：外部 CLI 走 preflight + 刷能力', async () => {
  const { deps, refreshCalls } = makeDeps()
  const { outcome, registered } = makeRemote(deps)
  if (outcome.registered !== true) return

  const spec = registered.find((s) => s && typeof s.refreshCli === 'function')
  assert.ok(spec)
  const result = await spec.refreshCli('codex', true)
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.capabilities))
  assert.equal(refreshCalls.length, 1)
})

test('所有带参 remote 方法都能被真实调用而不抛 ReferenceError', async () => {
  // 这是本文件的核心：**逐个真调**。
  // 静态检查发现不了「引用了别的作用域变量」这类缺陷，只有执行才暴露。
  const { deps } = makeDeps()
  const { outcome, registered } = makeRemote(deps)
  if (outcome.registered !== true) return

  const spec = registered.find((s) => s && typeof s === 'object')
  if (!spec) return

  const methodNames = ['refreshCli', 'setCliEnabled', 'updateGlobalRole', 'createGlobalRole', 'deleteGlobalRole']
  /** @type {Record<string, any[]>} */
  const callArgs = {
    refreshCli: ['codex', true],
    setCliEnabled: ['codex', true],
    updateGlobalRole: ['role-x', { name: 'n' }],
    createGlobalRole: [{ roleId: 'role-x', name: 'n' }],
    deleteGlobalRole: ['role-x'],
  }

  for (const name of methodNames) {
    const fn = spec[name]
    if (typeof fn !== 'function') continue
    try {
      await fn(...(callArgs[name] ?? []))
    } catch (error) {
      const message = String(error?.message ?? error)
      assert.ok(
        !/is not defined/.test(message),
        `${name} 抛了 ReferenceError 形态的错误（说明引用了别的作用域的变量）：${message}`,
      )
    }
  }
})
