// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, PACKAGE_NAME, PLUGIN_VERSION } from '../src/index.js'

/** 最小 ctx 替身：只实现插件当前会用到的那一小块。 */
function makeCtx() {
  const disposers = []
  const logs = []
  const ctx = {
    effect(fn, label) {
      assert.equal(typeof fn, 'function', 'effect 必须收函数')
      assert.equal(typeof label, 'string', 'effect 需要标签，便于排查')
      disposers.push(fn())
    },
    logger: {
      info(line) {
        logs.push(line)
      },
    },
  }
  return { ctx, disposers, logs }
}

test('导出契约：name / PACKAGE_NAME / apply', () => {
  assert.equal(name, 'meetingstone')
  assert.equal(PACKAGE_NAME, 'dsh-meetingstone')
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/)
  assert.equal(typeof apply, 'function')
})

test('apply 注册且只注册一个 effect', () => {
  const { ctx, disposers } = makeCtx()
  apply(ctx)
  assert.equal(disposers.length, 1)
  assert.equal(typeof disposers[0], 'function', '必须返回 disposer')
})

test('生命周期：loaded 后 disposed，且 dispose 幂等', () => {
  const { ctx, disposers, logs } = makeCtx()
  apply(ctx)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /loaded v0\.0\.1/)

  disposers[0]()
  assert.equal(logs.length, 2)
  assert.match(logs[1], /disposed/)

  // 再调一次不得重复输出（宿主可能重复触发清理）
  disposers[0]()
  assert.equal(logs.length, 2, 'dispose 必须幂等')
})

test('没有 logger 时不抛错（降级到 console）', () => {
  const ctx = { effect: (/** @type {() => any} */ fn) => fn() }
  assert.doesNotThrow(() => apply(/** @type {any} */ (ctx)))
})
