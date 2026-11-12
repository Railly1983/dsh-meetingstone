// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, PACKAGE_NAME, PLUGIN_VERSION } from '../src/index.js'

/**
 * 最小 ctx 替身：只实现插件当前会用到的那一小块。
 * 注意：apply 会挂 2 个 effect —— 一个是插件的生命周期，一个是适配器的子任务清理，
 * 所以断言用「至少 1 个」而不是「恰好 1 个」。
 */
function makeCtx() {
  const disposers = []
  const logs = []
  const tools = []
  const ctx = {
    effect(fn, label) {
      assert.equal(typeof fn, 'function', 'effect 必须收函数')
      assert.equal(typeof label, 'string', 'effect 需要标签，便于排查')
      disposers.push(fn())
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    logger: {
      info(line) {
        logs.push(line)
      },
    },
  }
  return { ctx, disposers, logs, tools }
}

const disposeAll = (disposers) => {
  for (const d of disposers) if (typeof d === 'function') d()
}

test('导出契约：name / PACKAGE_NAME / apply', () => {
  assert.equal(name, 'meetingstone')
  assert.equal(PACKAGE_NAME, 'dsh-meetingstone')
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(typeof apply, 'function')
})

test('apply 注册 effect 与九个工具', () => {
  const { ctx, disposers, tools } = makeCtx()
  apply(ctx)
  assert.ok(disposers.length >= 1)
  for (const d of disposers) assert.equal(typeof d, 'function', '每个 effect 都必须返回 disposer')
  assert.equal(tools.length, 9)
})

test('生命周期：loaded 后 disposed，且整体 dispose 幂等', () => {
  const { ctx, disposers, logs } = makeCtx()
  apply(ctx)
  assert.ok(logs.some((l) => l.includes(`loaded v${PLUGIN_VERSION}`)))

  disposeAll(disposers)
  assert.ok(logs.some((l) => /disposed/.test(l)))

  // 再调一轮不得重复输出（宿主可能重复触发清理）
  const before = logs.length
  disposeAll(disposers)
  assert.equal(logs.length, before, 'dispose 必须幂等')
})

test('没有 logger 时不抛错（降级到 console）', () => {
  const ctx = {
    effect: (/** @type {() => any} */ fn) => fn(),
    tools: { register: () => () => {} },
  }
  assert.doesNotThrow(() => apply(/** @type {any} */ (ctx)))
})

test('没有 tools 服务时明确报错，而不是静默半加载', () => {
  const ctx = { effect: (/** @type {() => any} */ fn) => fn(), logger: { info() {} } }
  assert.throws(() => apply(/** @type {any} */ (ctx)), /TOOLS_UNAVAILABLE/)
})
