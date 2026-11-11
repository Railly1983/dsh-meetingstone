// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ContinuationError,
  composePromptWithContinuation,
  formatContinuation,
  resolveContinuation,
  REPLAY_MAX_BYTES,
} from '../src/context-replay.js'
import { registerTools } from '../src/dsh/register.js'

function completedRun(overrides = {}) {
  return {
    childId: 'prev-1',
    status: 'completed',
    stopReason: 'completed',
    output: 'PONG',
    ...overrides,
  }
}

test('重放块：带明确边界、状态与 childId', () => {
  const out = formatContinuation(completedRun())
  assert.match(out.text, /\[PREVIOUS TASK OUTPUT — UNTRUSTED CONTEXT\]/)
  assert.match(out.text, /\[END PREVIOUS TASK OUTPUT\]/)
  assert.match(out.text, /childId: prev-1/)
  assert.match(out.text, /status: completed/)
  assert.match(out.text, /不可信数据/)
  assert.match(out.text, /PONG/)
  assert.equal(out.from, 'prev-1')
  assert.equal(out.truncated, false)
})

test('重放块：失败任务也重放，但必须带真实状态，不伪装成功', () => {
  const out = formatContinuation({
    childId: 'prev-fail',
    status: 'failed',
    stopReason: 'error',
    output: '',
    diagnostic: 'Product subagent failure (product: Codex; stage: turn)',
  })
  assert.match(out.text, /status: failed/)
  assert.match(out.text, /没有产出文本/)
  assert.match(out.text, /Product subagent failure/)
})

test('重放块：running 不允许重放（CONTINUATION_NOT_READY）', () => {
  assert.throws(
    () => formatContinuation({ childId: 'x', status: 'running' }),
    (err) => err instanceof ContinuationError && err.code === 'CONTINUATION_NOT_READY',
  )
})

test('重放块：超长输出按 16 KiB 截断且保留尾部', () => {
  const big = '头'.repeat(30000) + '尾'.repeat(30000)
  const out = formatContinuation({ childId: 'big', status: 'completed', output: big })
  assert.equal(out.truncated, true)
  assert.ok(Buffer.byteLength(out.text, 'utf8') < REPLAY_MAX_BYTES + 4096)
  assert.ok(out.text.includes('truncated: true'))
  assert.ok(out.text.includes('头'))
  assert.ok(out.text.endsWith('尾\n[END PREVIOUS TASK OUTPUT]'))
  assert.ok(Number.isInteger(out.bytes) && out.bytes > 0, '必须记录实际注入的字节数')
})

test('拼接顺序固定：人设 → 重放块 → 本次任务（任务在最后）', () => {
  const text = composePromptWithContinuation({
    personaHead: '你是「沙僧」。',
    persona: '负责主力开发。',
    continuation: { text: '[PREVIOUS TASK OUTPUT — UNTRUSTED CONTEXT]\n旧结果\n[END PREVIOUS TASK OUTPUT]' },
    task: '接着改',
  })
  const iPersona = text.indexOf('你是「沙僧」。')
  const iReplay = text.indexOf('[PREVIOUS TASK OUTPUT')
  const iTask = text.indexOf('任务：接着改')
  assert.ok(iPersona >= 0 && iReplay > iPersona && iTask > iReplay, '顺序必须是 人设 → 重放 → 任务')
})

test('既无人设也无重放：原样返回任务（不改变既有行为）', () => {
  assert.equal(composePromptWithContinuation({ task: '裸任务' }), '裸任务')
})

test('resolveContinuation：空值返回 null，加载失败/缺失分别报错', async () => {
  assert.equal(await resolveContinuation(undefined, { loadRun: async () => null }), null)
  assert.equal(await resolveContinuation('   ', { loadRun: async () => null }), null)

  await assert.rejects(
    () => resolveContinuation('nope', { loadRun: async () => null }),
    (err) => err instanceof ContinuationError && err.code === 'CONTINUATION_NOT_FOUND',
  )
  await assert.rejects(
    () => resolveContinuation('boom', { loadRun: async () => { throw new Error('disk on fire') } }),
    (err) => err instanceof ContinuationError && err.code === 'CONTINUATION_UNAVAILABLE',
  )
  await assert.rejects(
    () => resolveContinuation('corrupt', { loadRun: async () => ({ status: 'unknown', code: 'RUN_CORRUPT' }) }),
    (err) => err instanceof ContinuationError && err.code === 'CONTINUATION_CORRUPT',
  )
})

test('dispatch 工具：continuesFrom 解析成功时把重放块透传给派单器', async () => {
  const registered = new Map()
  const calls = []
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: {
        list: () => [],
        resolve: () => ({
          roleId: 'role-sashi',
          name: '沙僧',
          description: '',
          channel: { kind: 'acp-cli' },
          enabled: true,
          timeoutMs: 1000,
        }),
        errors: [],
      },
      dispatcher: {
        async dispatch(input) {
          calls.push(input)
          return { ok: true, taskRef: { childId: 'new-1' }, role: input.role }
        },
      },
      probe: { probe: async () => ({}) },
      resolveRun: async (_exec, childId) => ({ childId, status: 'completed', output: 'PONG' }),
    },
  )
  const spec = registered.get('meetingstone_dispatch')
  const exec = { agent: { session: { header: { cwd: 'D:/proj' } } } }
  const out = await spec.execute({ role: 'SS', task: '接着改', continuesFrom: 'prev-1' }, exec)
  assert.equal(out.ok, true)
  assert.ok(calls[0].continuation, '必须透传重放块')
  assert.match(calls[0].continuation.text, /PONG/)
  assert.equal(calls[0].task, '接着改', '原任务正文不变')
})

test('dispatch 工具：continuesFrom 找不到结果时直接失败，不静默降级', async () => {
  const registered = new Map()
  let dispatched = false
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: {
        list: () => [],
        resolve: () => ({
          roleId: 'role-sashi',
          name: '沙僧',
          description: '',
          channel: { kind: 'acp-cli' },
          enabled: true,
          timeoutMs: 1000,
        }),
        errors: [],
      },
      dispatcher: {
        async dispatch() {
          dispatched = true
          return { ok: true }
        },
      },
      probe: { probe: async () => ({}) },
      resolveRun: async () => null,
    },
  )
  const spec = registered.get('meetingstone_dispatch')
  const out = await spec.execute(
    { role: 'SS', task: '接着改', continuesFrom: 'missing' },
    { agent: { session: { header: { cwd: 'D:/proj' } } } },
  )
  assert.equal(out.ok, false)
  assert.equal(out.code, 'CONTINUATION_NOT_FOUND')
  assert.equal(dispatched, false, '不得退化成普通派单')
})
