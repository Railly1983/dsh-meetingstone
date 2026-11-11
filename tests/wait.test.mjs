// @ts-check
/**
 * `meetingstone_wait` / `adapter.waitForSettled` 单测。
 *
 * 覆盖验收点：
 * - 已完成任务立即返回（不注册监听、不轮询）
 * - 多个任务部分完成 / 全部完成
 * - 超时返回 running + timedOut，且撤销监听
 * - 未知 childId → UNKNOWN_CHILD，不阻塞
 * - 取消 / 失败终态正确映射
 * - 同一任务多次 wait 不重复注册监听
 * - 插件卸载清理监听并唤醒等待者
 * - 工具层参数校验（数组 / 默认 300000 / 上限 600000）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDshAdapter,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
} from '../src/dsh/adapter.js'
import { registerTools, TOOL_NAMES } from '../src/dsh/register.js'
import { createDispatcher } from '../src/dispatch/dispatcher.js'

/** 等适配器的 result.then 回调跑完（不是轮询任务状态）。 */
const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

const role = () => ({
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  channel: { kind: 'acp-cli' },
  enabled: true,
  timeoutMs: 0,
})

/** 可控 activation：每个任务暴露 resolve/reject，测试自己决定何时结算。 */
function makeHarness() {
  /** @type {Array<{ childId: string, resolve: (v: any) => void, reject: (e: any) => void, disposeCalls: number }>} */
  const activations = []
  const disposers = []
  const subagents = {
    getProvider: () => ({ name: 'acp' }),
    async startActivation() {
      /** @type {(v: any) => void} */
      let resolve = () => {}
      /** @type {(e: any) => void} */
      let reject = () => {}
      const result = new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
      const entry = { childId: `child-${activations.length + 1}`, resolve, reject, disposeCalls: 0 }
      activations.push(entry)
      return {
        childId: entry.childId,
        name: entry.childId,
        result,
        async dispose() {
          entry.disposeCalls += 1
        },
      }
    },
  }
  const ctx = {
    subagents,
    effect: (/** @type {() => any} */ fn) => {
      disposers.push(fn())
    },
    logger: { warn() {} },
  }
  const adapter = createDshAdapter(ctx, { now: () => 1 })
  return { adapter, subagents, activations, disposers }
}

/** @param {any} adapter @param {string} [task] */
async function start(adapter, task = 'x') {
  const res = await adapter.start({
    role: role(),
    task,
    timeoutMs: 0,
    context: {
      projectRoot: 'D:/MeetingStone',
      agent: { session: { header: { cwd: 'D:/MeetingStone' } } },
    },
  })
  return res.taskRef.childId
}

/** @param {Array<any>} results */
const byId = (results) => Object.fromEntries(results.map((r) => [r.childId, r]))

// ─── 已完成 / 多任务 ─────────────────────────────────────────────────────────

test('wait：已完成的多个任务立即返回，不注册等待监听', async () => {
  const { adapter, activations } = makeHarness()
  const a = await start(adapter, 'a')
  const b = await start(adapter, 'b')
  activations[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'AAA' }] })
  activations[1].resolve({
    stopReason: 'completed',
    output: [{ type: 'text', text: '{"status":"completed","summary":"ok-b"}' }],
  })
  await flush()

  const before = adapter.waitStats()
  const startedAt = Date.now()
  const out = await adapter.waitForSettled([a, b], 5000)
  const elapsed = Date.now() - startedAt

  assert.equal(out.ok, true)
  assert.equal(out.timedOut, false)
  assert.ok(elapsed < 100, `已完成任务必须立即返回，实际 ${elapsed}ms`)
  assert.equal(adapter.waitStats().registrations - before.registrations, 0, '不得注册监听')

  const map = byId(out.results)
  assert.equal(map[a].status, 'completed')
  assert.equal(map[a].stopReason, 'completed')
  assert.equal(map[a].timedOut, false)
  assert.equal(map[a].resultBytes, Buffer.byteLength('AAA', 'utf8'))
  assert.equal(Object.hasOwn(map[a], 'summary'), false, '纯文本不重复回 summary')

  assert.equal(map[b].status, 'completed')
  assert.equal(map[b].summary, 'ok-b', '结构化 summary 必须返回')
  assert.equal(map[b].resultBytes, Buffer.byteLength('{"status":"completed","summary":"ok-b"}', 'utf8'))
})

test('wait：部分完成时超时标 running，剩余完成后再次 wait 全部终态', async () => {
  const { adapter, activations } = makeHarness()
  const a = await start(adapter, 'a')
  const b = await start(adapter, 'b')
  activations[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'DONE-A' }] })
  await flush()

  const partial = await adapter.waitForSettled([a, b], 30)
  assert.equal(partial.ok, true)
  assert.equal(partial.timedOut, true)
  const first = byId(partial.results)
  assert.equal(first[a].status, 'completed')
  assert.equal(first[a].timedOut, false)
  assert.equal(first[b].status, 'running')
  assert.equal(first[b].timedOut, true)
  assert.equal(first[b].resultBytes, 0)

  activations[1].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'DONE-B' }] })
  await flush()

  const all = await adapter.waitForSettled([a, b], 30)
  assert.equal(all.timedOut, false)
  for (const result of all.results) {
    assert.equal(result.status, 'completed')
    assert.equal(result.timedOut, false)
  }
})

// ─── 超时 / 未知 ────────────────────────────────────────────────────────────

test('wait：超时返回 running + timedOut，并撤销监听（不泄漏）', async () => {
  const { adapter } = makeHarness()
  const a = await start(adapter)
  const before = adapter.waitStats()

  const out = await adapter.waitForSettled([a], 20)

  assert.equal(out.ok, true)
  assert.equal(out.timedOut, true)
  assert.equal(out.timeoutMs, 20)
  assert.equal(out.results[0].status, 'running')
  assert.equal(out.results[0].timedOut, true)
  assert.equal(adapter.waitStats().pendingWaiters, 0, '超时后必须撤销监听')
  assert.equal(adapter.waitStats().registrations - before.registrations, 1)
})

test('wait：未知 childId 立即报 UNKNOWN_CHILD，不阻塞、不注册监听', async () => {
  const { adapter } = makeHarness()
  const a = await start(adapter)
  const before = adapter.waitStats()

  const startedAt = Date.now()
  const out = await adapter.waitForSettled([a, 'missing-child'], 5000)
  const elapsed = Date.now() - startedAt

  assert.equal(out.ok, false)
  assert.equal(out.code, 'UNKNOWN_CHILD')
  assert.deepEqual(out.unknownChildIds, ['missing-child'])
  assert.ok(elapsed < 100, `未知 childId 不得等待，实际 ${elapsed}ms`)
  assert.equal(adapter.waitStats().registrations, before.registrations, '未注册任何监听')
})

// ─── 终态映射：取消 / 失败 ──────────────────────────────────────────────────

test('wait：取消 → cancelled，失败 → failed，映射正确', async () => {
  const { adapter, activations } = makeHarness()
  const a = await start(adapter, 'a')
  const b = await start(adapter, 'b')

  const cancelled = await adapter.cancel(a)
  assert.equal(cancelled.stopConfirmed, true)
  activations[1].reject(new Error('boom'))
  await flush()

  const out = await adapter.waitForSettled([a, b], 1000)
  assert.equal(out.timedOut, false)
  const map = byId(out.results)
  assert.equal(map[a].status, 'cancelled')
  assert.equal(map[a].stopReason, 'cancelled')
  assert.equal(map[a].resultBytes, 0)
  assert.equal(map[b].status, 'failed')
  assert.equal(map[b].stopReason, 'error')
  assert.equal(map[b].resultBytes, 0)
})

// ─── 并发安全 / 卸载 ────────────────────────────────────────────────────────

test('wait：同一任务被多次 wait 只注册一个监听，结算后一起唤醒', async () => {
  const { adapter, activations } = makeHarness()
  const a = await start(adapter)
  const before = adapter.waitStats()

  const p1 = adapter.waitForSettled([a], 5000)
  const p2 = adapter.waitForSettled([a], 5000)
  const during = adapter.waitStats()
  assert.equal(during.registrations - before.registrations, 1, '同一 childId 只能注册一次监听')
  assert.equal(during.pendingWaiters, 1)

  activations[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'OK' }] })
  const [r1, r2] = await Promise.all([p1, p2])

  for (const out of [r1, r2]) {
    assert.equal(out.ok, true)
    assert.equal(out.results[0].status, 'completed')
  }
  assert.equal(adapter.waitStats().pendingWaiters, 0)
})

test('wait：短超时的 wait 先返回，不会破坏另一个长 wait 的监听', async () => {
  const { adapter, activations } = makeHarness()
  const a = await start(adapter)

  const longWait = adapter.waitForSettled([a], 5000)
  const shortWait = await adapter.waitForSettled([a], 10)
  assert.equal(shortWait.timedOut, true)
  assert.equal(adapter.waitStats().pendingWaiters, 1, '长 wait 的监听必须保留')

  activations[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'OK' }] })
  const long = await longWait
  assert.equal(long.timedOut, false)
  assert.equal(long.results[0].status, 'completed')
  assert.equal(adapter.waitStats().pendingWaiters, 0)
})

test('wait：插件卸载会唤醒等待者并清空监听', async () => {
  const { adapter, disposers } = makeHarness()
  const a = await start(adapter)

  const waiting = adapter.waitForSettled([a], 5000)
  assert.equal(adapter.waitStats().pendingWaiters, 1)

  for (const dispose of disposers) await dispose()
  const out = await waiting

  assert.equal(out.ok, true)
  assert.equal(out.timedOut, false)
  assert.equal(out.results[0].status, 'interrupted')
  assert.equal(out.results[0].stopReason, 'plugin-disposed')
  assert.equal(adapter.waitStats().pendingWaiters, 0, '卸载后不得留下监听')
})

// ─── dispatcher 透传 ────────────────────────────────────────────────────────

test('dispatcher.waitForSettled：适配器不支持时如实返回 WAIT_UNAVAILABLE', async () => {
  const dispatcher = createDispatcher({
    registry: { resolve: () => null, list: () => [] },
    adapter: { start: async () => ({ taskRef: {} }) },
  })
  const out = await dispatcher.waitForSettled(['x'], 10)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'WAIT_UNAVAILABLE')
})

test('dispatcher.waitForSettled：原样透传适配器结果', async () => {
  const dispatcher = createDispatcher({
    registry: { resolve: () => null, list: () => [] },
    adapter: {
      start: async () => ({ taskRef: {} }),
      waitForSettled: async (childIds, timeoutMs) => ({ ok: true, childIds, timeoutMs }),
    },
  })
  const out = await dispatcher.waitForSettled(['a'], 42)
  assert.deepEqual(out, { ok: true, childIds: ['a'], timeoutMs: 42 })
})

// ─── 工具层 ─────────────────────────────────────────────────────────────────

/** @param {Record<string, any>} [dispatcherOver] */
function makeTools(dispatcherOver = {}) {
  const registered = new Map()
  /** @type {Array<{ childIds: string[], timeoutMs?: number }>} */
  const calls = []
  registerTools(
    { tools: { register: (/** @type {any} */ spec) => registered.set(spec.name, spec) } },
    {
      registry: { list: () => [], errors: [] },
      dispatcher: {
        dispatch: async () => ({ ok: false, code: 'UNUSED', message: 'unused' }),
        waitForSettled: async (/** @type {string[]} */ childIds, /** @type {number} */ timeoutMs) => {
          calls.push({ childIds, timeoutMs })
          return { ok: true, timedOut: false, timeoutMs, results: [] }
        },
        ...dispatcherOver,
      },
      probe: { probe: async () => ({}), probeAll: async () => [] },
    },
  )
  return { registered, calls }
}

test('meetingstone_wait：注册参数是数组 + timeout，默认 300000、上限 600000', async () => {
  const { registered, calls } = makeTools()
  const tool = registered.get(TOOL_NAMES.WAIT)
  assert.ok(tool, '必须注册 meetingstone_wait')
  assert.equal(tool.parameters.properties.childIds.type, 'array')
  assert.equal(tool.parameters.properties.childIds.items.type, 'string')
  assert.ok(tool.parameters.required.includes('childIds'))
  assert.equal(tool.parameters.properties.timeoutMs.type, 'number')

  const out = await tool.execute({ childIds: ['c1', ' c1 ', 'c2'] })
  assert.equal(out.ok, true)
  assert.deepEqual(calls[0], { childIds: ['c1', 'c2'], timeoutMs: DEFAULT_WAIT_TIMEOUT_MS })

  await tool.execute({ childIds: ['c1'], timeoutMs: MAX_WAIT_TIMEOUT_MS + 999999 })
  assert.equal(calls[1].timeoutMs, MAX_WAIT_TIMEOUT_MS, '超过上限必须截断')
})

test('meetingstone_wait：空数组 / 非字符串 / 非法 timeout 拒绝，未知 childId 原样透传', async () => {
  const { registered, calls } = makeTools()
  const tool = registered.get(TOOL_NAMES.WAIT)

  for (const args of [{}, { childIds: [] }, { childIds: [''] }, { childIds: ['a', 3] }]) {
    const out = await tool.execute(args)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'INVALID_CHILD_IDS')
  }
  const badTimeout = await tool.execute({ childIds: ['a'], timeoutMs: 0 })
  assert.equal(badTimeout.code, 'INVALID_TIMEOUT')
  assert.equal(calls.length, 0, '非法参数不得触达 dispatcher')

  const unknown = makeTools({
    waitForSettled: async () => ({
      ok: false,
      code: 'UNKNOWN_CHILD',
      message: '未知',
      unknownChildIds: ['nope'],
    }),
  })
  const out = await unknown.registered.get(TOOL_NAMES.WAIT).execute({ childIds: ['nope'] })
  assert.equal(out.code, 'UNKNOWN_CHILD')
  assert.deepEqual(out.unknownChildIds, ['nope'])
})
