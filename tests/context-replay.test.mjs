// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ContinuationError,
  composePromptWithContinuation,
  formatContinuation,
  measurePromptSegments,
  resolveContinuation,
  REPLAY_MAX_BYTES,
} from '../src/context-replay.js'
import { truncateUtf8 } from '../src/run-store.js'
import { registerTools } from '../src/dsh/register.js'
import { composePrompt } from '../src/dsh/adapter.js'
import { renderTaskBrief } from '../src/taskspec.js'
import { renderOutputContract } from '../src/result-contract.js'
import {
  recommendContinuation,
  REUSE_DECISIONS,
  REUSE_REASONS,
} from '../src/dispatch/reuse-policy.js'

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

test('重放块：超长旧输出中间的验收/权限段与结构化保护字段不被截断', () => {
  const acceptance = ['取消后父子进程都必须退出']
  const middle = ['验收标准：', '- 取消后父子进程都必须退出', '权限限制：只读，不得写盘'].join('\n')
  const output = `${'头'.repeat(12000)}\n\n${middle}\n\n${'尾'.repeat(12000)}`
  const run = {
    childId: 'prev-protected',
    status: 'failed',
    stopReason: 'error',
    output,
    acceptance,
    scope: { include: ['src/dsh'], exclude: ['docs/'] },
    permissions: 'read-only',
    safetyPolicy: '不得修改宿主 profile',
    contextPack: { doNotRepeat: ['不要重跑全量测试'] },
  }
  const out = formatContinuation(run)
  assert.equal(out.truncated, true)
  assert.equal(out.protected, true)

  // 变异证据：纯首尾截断会丢掉中间段；删掉保护逻辑时下面断言必须失败。
  const headTail = truncateUtf8(output, REPLAY_MAX_BYTES, {
    headBytes: Math.floor(REPLAY_MAX_BYTES * 0.75),
  })
  assert.equal(headTail.text.includes('验收标准'), false, '纯截断本来会丢中间验收段')
  assert.ok(out.text.includes('验收标准'))
  assert.ok(out.text.includes('- 取消后父子进程都必须退出'))
  assert.ok(out.text.includes('权限限制：只读，不得写盘'))

  // 结构化保护字段必须原样出现（acceptance/scope/permissions/safetyPolicy/doNotRepeat）
  assert.ok(out.text.includes('acceptance:'))
  assert.ok(out.text.includes('- 取消后父子进程都必须退出'))
  assert.ok(out.text.includes('scope.include:'))
  assert.ok(out.text.includes('- src/dsh'))
  assert.ok(out.text.includes('permissions: read-only'))
  assert.ok(out.text.includes('safetyPolicy: 不得修改宿主 profile'))
  assert.ok(out.text.includes('doNotRepeat:'))
  assert.ok(out.text.includes('- 不要重跑全量测试'))

  // 变异证据：去掉保护字段后重放块不得凭空包含它（证明上面的断言依赖保护逻辑）
  const stripped = formatContinuation({
    childId: 'prev-stripped',
    status: 'completed',
    output: '短输出',
    acceptance: undefined,
    scope: undefined,
    permissions: undefined,
    safetyPolicy: undefined,
    contextPack: undefined,
  })
  assert.equal(stripped.text.includes('acceptance:'), false)
  assert.equal(stripped.protected, false)
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

// ─── C3：artifactPolicy 保护字段 + upstreamChildId + taskId 透传 ────────────────

test('C3：重放块保留 artifactPolicy 保护字段，并显式携带 upstreamChildId', () => {
  const out = formatContinuation({
    childId: 'prev-readonly',
    status: 'completed',
    output: '只读审计完成',
    taskSpec: { title: '只读审计', artifactPolicy: 'none' },
  })
  assert.equal(out.from, 'prev-readonly')
  assert.equal(out.upstreamChildId, 'prev-readonly')
  assert.equal(out.protected, true, 'artifactPolicy 属于保护字段，必须进入保护块')
  assert.match(out.text, /artifactPolicy: none/)
  assert.match(out.text, /\[STRUCTURED PROTECTION/)
})

test('C3：dispatch 工具透传 taskId 外键（空值忽略，不伪造）', async () => {
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
    },
  )
  const spec = registered.get('meetingstone_dispatch')
  const exec = { agent: { session: { header: { cwd: 'D:/proj' } } } }

  const out = await spec.execute({ role: 'SS', task: '干活', taskId: 'task-10' }, exec)
  assert.equal(out.ok, true)
  assert.equal(calls[0].taskId, 'task-10', 'taskId 必须透传到派单器（落 run 记录）')

  await spec.execute({ role: 'SS', task: '干活', taskId: '   ' }, exec)
  assert.equal(Object.hasOwn(calls[1], 'taskId'), false, '空 taskId 不得伪造外键')
})

// ────────────────────────────────────────────────────────────────────────────
// C2：缓存顺序断言固化 + 复用判据（不改 C1 契约字段）
// ────────────────────────────────────────────────────────────────────────────

/** C2 固定合成样本（无时间戳/随机值）。 */
function c2Spec() {
  return {
    title: 'C2 顺序检查',
    objective: '验证稳定前缀在前、动态在后',
    scope: { include: ['src/context-replay.js'], exclude: [] },
    acceptance: ['顺序正确'],
    evidence: ['测试断言'],
    contextRefs: ['docs/design/context-contract.md'],
    artifactPolicy: 'none',
  }
}

function c2Pack() {
  return {
    knownFacts: ['C1 契约定稿'],
    files: ['src/context-replay.js'],
    priorResults: [],
    doNotRepeat: ['不要调换提示词顺序'],
  }
}

test('C2：派单提示词五段顺序固定（人设最前、输出契约收尾；C1 禁止调换）', () => {
  const role = { name: '沙僧', prompt: '你是沙僧。只改授权文件，结论附证据。', channel: { kind: 'acp-cli' } }
  const continuation = formatContinuation(completedRun({ output: '上一轮结论：顺序正确。' }))
  const text = composePrompt(role, '核对派单顺序', continuation, c2Spec(), c2Pack())

  const iPersona = text.indexOf('你是「沙僧」。')
  const iBrief = text.indexOf('[TASK SPEC')
  const iContinuation = text.indexOf('[PREVIOUS TASK OUTPUT')
  const iEnd = text.indexOf('[END PREVIOUS TASK OUTPUT')
  const iTask = text.indexOf('任务：核对派单顺序')
  const iContract = text.indexOf('[OUTPUT CONTRACT')
  assert.equal(iPersona, 0, '人设必须是稳定前缀第一段')
  assert.ok(iPersona < iBrief, '简报在人设之后')
  assert.ok(iBrief < iContinuation, '交接块在简报之后')
  assert.ok(iContinuation < iEnd, '交接块边界成对')
  assert.ok(iEnd < iTask, '本次任务在交接块之后（防旧内容抢注意力）')
  assert.ok(iTask < iContract, '输出契约固定收尾')

  // 无 continuesFrom：不出现交接边界。
  const bare = composePrompt(role, '推进', null, c2Spec(), c2Pack())
  assert.equal(bare.indexOf('[PREVIOUS TASK OUTPUT'), -1)
})

test('C2：measurePromptSegments 报告段字节；稳定前缀跨任务一致、动态段随任务变化', () => {
  const common = {
    personaHead: '你是「沙僧」。',
    persona: '你是沙僧。只改授权文件，结论附证据。',
    taskBrief: renderTaskBrief(c2Spec(), c2Pack()),
    outputContract: renderOutputContract('runs'),
  }
  const taskA = measurePromptSegments({ ...common, task: '任务 A：只读核对' })
  const taskB = measurePromptSegments({ ...common, task: '任务 B：完全不同的更长任务文本，用来改变动态段字节' })
  assert.deepEqual(taskA.order, ['persona', 'taskBrief', 'task', 'outputContract'])
  assert.equal(taskA.bytes.persona, taskB.bytes.persona, '稳定前缀（persona）跨任务字节级一致')
  assert.notEqual(taskA.bytes.task, taskB.bytes.task, '任务正文随任务变化')
  assert.ok(taskA.stablePrefixBytes > 0)
  assert.equal(taskA.bytes.total, taskA.bytes.persona + taskA.bytes.taskBrief + taskA.bytes.task + taskA.bytes.outputContract + taskA.separatorsBytes)
  assert.equal(Object.hasOwn(taskA, 'tokens'), false, '只报字节，不输出 Token 估算')

  const withContinuation = measurePromptSegments({
    ...common,
    continuation: formatContinuation(completedRun({ output: '上一轮结论。' })),
    task: '续轮核对',
  })
  assert.deepEqual(withContinuation.order, [
    'persona',
    'taskBrief',
    'continuation',
    'task',
    'outputContract',
  ])
  assert.ok(withContinuation.bytes.continuation > 0)
})

test('C2：执行参数与聊天历史不进提示词（cwd/isolation/timeout/messages 均不出现）', () => {
  const role = {
    name: '沙僧',
    prompt: '你是沙僧。',
    channel: { kind: 'acp-cli', channelId: 'ch-acp', model: 'm1', reasoning: 'high' },
  }
  const text = composePrompt(role, '只读核对', null, c2Spec(), c2Pack())
  for (const forbidden of ['D:/proj', 'worktree', 'isolation', 'timeoutMs', 'messages', 'chatHistory', 'transcript']) {
    assert.equal(text.includes(forbidden), false, `提示词不应包含执行参数/聊天历史：${forbidden}`)
  }
  assert.ok(text.includes('你是「沙僧」。'), '人设仍在')
})

test('C2 reuse-policy：同一任务谱系才复用；组合/项目/隔离/预算/失败均新建', () => {
  const role = {
    roleId: 'role-sashi',
    channel: { kind: 'acp-cli', channelId: 'ch-acp', model: 'm1', reasoning: 'high' },
  }
  const previous = {
    childId: 'prev-1',
    status: 'completed',
    stopReason: 'completed',
    taskId: 'task-1',
  }
  const base = {
    previous,
    taskId: 'task-1',
    role,
    nextRole: role,
    projectRoot: 'D:/proj',
    nextProjectRoot: 'D:/proj',
    isolation: 'worktree',
    nextIsolation: 'worktree',
    chainLength: 0,
    continuationBytes: 1024,
  }
  const allowed = recommendContinuation(base)
  assert.equal(allowed.decision, REUSE_DECISIONS.REUSE)
  assert.equal(allowed.reason, REUSE_REASONS.REUSE_ALLOWED)
  assert.equal(allowed.policyVersion, 1)

  /** @type {Array<[any, string]>} */
  const cases = [
    [{ ...base, previous: null }, REUSE_REASONS.NO_PREVIOUS],
    [{ ...base, previous: { ...previous, status: 'running' } }, REUSE_REASONS.PREVIOUS_RUNNING],
    [{ ...base, previous: { ...previous, status: 'failed' } }, REUSE_REASONS.PREVIOUS_NOT_REUSABLE],
    [{ ...base, previous: { ...previous, status: 'cancelled' } }, REUSE_REASONS.PREVIOUS_NOT_REUSABLE],
    [{ ...base, taskId: 'task-2' }, REUSE_REASONS.TASK_CHANGED],
    [
      {
        ...base,
        nextRole: {
          roleId: 'role-bajie',
          channel: { kind: 'acp-cli', channelId: 'ch-acp', model: 'm1', reasoning: 'high' },
        },
      },
      REUSE_REASONS.EXECUTION_COMBO_CHANGED,
    ],
    [{ ...base, nextProjectRoot: 'D:/other' }, REUSE_REASONS.PROJECT_CHANGED],
    [{ ...base, nextIsolation: 'none' }, REUSE_REASONS.ISOLATION_CHANGED],
    [{ ...base, chainLength: 3 }, REUSE_REASONS.CHAIN_TOO_LONG],
    [{ ...base, continuationBytes: 16 * 1024 + 1 }, REUSE_REASONS.CONTEXT_BUDGET_EXCEEDED],
  ]
  for (const [input, reason] of cases) {
    const decision = recommendContinuation(input)
    assert.equal(decision.reason, reason)
    assert.equal(decision.decision, REUSE_DECISIONS.NEW, `${reason} 必须新建`)
    assert.equal(decision.reuse, false)
  }
})
