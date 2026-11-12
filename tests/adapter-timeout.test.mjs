// @ts-check
/**
 * 任务超时行为测试（2026-11-12 发现是测试盲区）。
 *
 * ## 为什么这个文件存在
 *
 * 翻遍 `tests/` 发现：所有 adapter 测试都用 `timeoutMs: 0`（不装定时器），
 * 目的是「避免测试进程被挂住」。结果是**超时路径从未被任何测试覆盖**。
 *
 * 但超时是 P0 能力：
 * - 角色的 `timeoutMs` 默认 1 小时，配了就该生效
 * - 超时后必须写终态、释放并发槽位，否则任务永久占位
 *
 * ## 实现机制（`src/dsh/adapter.js`）
 *
 * ```js
 * let timer = null
 * if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
 *   timer = setTimeout(() => controller.abort(new Error('meetingstone: timeout')), timeoutMs)
 * }
 * ```
 *
 * `controller.signal` 传给宿主 `startActivation`（`:1162`），宿主据此停止任务；
 * 我们的 `onFinish` 负责写终态与释放槽位。
 *
 * 本文件验证：定时器真的装上了、真的 abort 了、abort 后不留悬挂。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshAdapter } from '../src/dsh/adapter.js'

/** 造一个能观察 signal 的假 subagents 服务。 */
function fakeSubagents({ onStart } = {}) {
  /** @type {any[]} */
  const calls = []
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true },
    inheritsParentContext: false,
  }
  return {
    calls,
    getProvider: (name) => (name === 'spawn' ? provider : undefined),
    async startActivation(spec) {
      calls.push(spec)
      if (typeof onStart === 'function') return onStart(spec)
      return {
        childId: 'child-1',
        name: 'child-1',
        messageId: 'msg-1',
        result: new Promise(() => {}), // 永不落定：模拟长任务
        dispose: async () => {},
      }
    },
  }
}

const ROLE = {
  roleId: 'role-a',
  name: 'A',
  enabled: true,
  channel: { channelId: 'c1', kind: 'in-process', provider: 'spawn', llmProvider: 'p', llmModel: 'm' },
  timeoutMs: 60_000,
}

const CTX = {
  subagents: null,
  logger: { info() {}, warn() {}, error() {} },
}

/** 造一个最小 adapter。 */
function makeAdapter(subagents) {
  return createDshAdapter(
    { ...CTX, subagents },
    { getParent: () => ({ id: 'parent' }) },
  )
}

test('timeoutMs > 0 时确实装了定时器（可观测：signal 会在超时后 abort）', async () => {
  const subagents = fakeSubagents()
  const adapter = makeAdapter(subagents)
  await adapter.start({ role: ROLE, task: 't', timeoutMs: 50, context: { agent: { id: 'p' } } })
  assert.equal(subagents.calls.length, 1, '应该启动了一次 activation')
  const signal = subagents.calls[0].signal
  assert.ok(signal, 'spec.signal 必须存在')
  assert.equal(signal.aborted, false, '刚启动时不该 abort')

  // 等超时触发
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(signal.aborted, true, '超时后 signal 必须 aborted')
  assert.match(
    String(signal.reason?.message ?? ''),
    /meetingstone: timeout/,
    'abort 原因要能看出来是超时（不是取消）',
  )
})

test('timeoutMs: 0 时不装定时器（signal 永不 abort）', async () => {
  const subagents = fakeSubagents()
  const adapter = makeAdapter(subagents)
  await adapter.start({ role: ROLE, task: 't', timeoutMs: 0, context: { agent: { id: 'p' } } })
  const signal = subagents.calls[0].signal
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(signal.aborted, false, 'timeoutMs=0 表示不装定时器')
})

test('timeoutMs 非数字/负数时不装定时器（防御）', async () => {
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const subagents = fakeSubagents()
    const adapter = makeAdapter(subagents)
    await adapter.start({ role: ROLE, task: 't', timeoutMs: bad, context: { agent: { id: 'p' } } })
    const signal = subagents.calls[0].signal
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(signal.aborted, false, `timeoutMs=${bad} 不该装定时器`)
  }
})

test('超时与取消的 abort 原因可区分（诊断需要）', async () => {
  // 超时：reason 含 'meetingstone: timeout'
  const s1 = fakeSubagents()
  const a1 = makeAdapter(s1)
  await a1.start({ role: ROLE, task: 't', timeoutMs: 40, context: { agent: { id: 'p' } } })
  await new Promise((r) => setTimeout(r, 100))
  const timeoutReason = String(s1.calls[0].signal.reason?.message ?? '')
  assert.match(timeoutReason, /timeout/)

  // 取消：reason 含 'meetingstone: cancelled'
  const s2 = fakeSubagents()
  const a2 = makeAdapter(s2)
  await a2.start({ role: ROLE, task: 't', timeoutMs: 0, context: { agent: { id: 'p' } } })
  await a2.cancel({ childId: 'child-1' })
  const cancelReason = String(s2.calls[0].signal.reason?.message ?? '')
  assert.match(cancelReason, /cancelled/)
  assert.notEqual(timeoutReason, cancelReason, '两种原因必须能区分')
})

test('超时后 cancel 仍然幂等（不抛）', async () => {
  const subagents = fakeSubagents()
  const adapter = makeAdapter(subagents)
  await adapter.start({ role: ROLE, task: 't', timeoutMs: 40, context: { agent: { id: 'p' } } })
  await new Promise((r) => setTimeout(r, 100))
  // 超时已 abort；再 cancel 不该抛
  await assert.doesNotReject(async () => {
    await adapter.cancel({ childId: 'child-1' })
  })
})

// ── interrupted 投影（2026-11-12 补，属于「取消/进程清理」的配套证据）──
// 设计：run 记录带 runtimeId。读取时若记录属于**别的** runtimeId，
// status=running 会被投影为 interrupted —— 否则重启后永远显示「还在跑」。
// 这是避免「僵尸任务占位误判」的关键机制。

test('interrupted 投影：不同 runtimeId 的 running 记录读出来是 interrupted', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createRunStore } = await import('../src/run-store.js')

  const root = await mkdtemp(join(tmpdir(), 'ms-proj-'))
  try {
    // 手工造一条属于旧 runtimeId 的 running 记录
    const runsDir = join(root, '.meetingstone', 'runs')
    await mkdir(runsDir, { recursive: true })
    const childId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeFile(
      join(runsDir, childId + '.json'),
      JSON.stringify({
        schemaVersion: 1,
        childId,
        runtimeId: 'old-runtime',
        role: 'role-a',
        provider: 'spawn',
        model: null,
        status: 'running',
        createdAt: 1,
      }),
      'utf8',
    )

    // 用新 runtimeId 读 → 应投影为 interrupted
    const fresh = createRunStore({ root, runtimeId: 'new-runtime' })
    const asFresh = await fresh.loadRun(childId)
    assert.equal(asFresh.status, 'interrupted', '旧进程的 running 必须投影为 interrupted')
    assert.equal(asFresh.interrupted, true)

    // 用同一个 runtimeId 读 → 保持 running
    const same = createRunStore({ root, runtimeId: 'old-runtime' })
    const asSame = await same.loadRun(childId)
    assert.equal(asSame.status, 'running', '同进程读自己的 running 不该被改')
    assert.equal(asSame.interrupted, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
