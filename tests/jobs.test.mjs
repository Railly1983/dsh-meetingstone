// @ts-check
/**
 * 原生 Jobs 接入测试（假 jobs 服务，不加载宿主包）。
 *
 * 覆盖任务 A 的验收点：
 * - Job 被创建，kind/label/owner 正确（标签含角色 · 通道 · ≤40 字任务摘要）
 * - 完成 / 失败 / 取消三种终态 → hooks.done 映射正确
 *   （宿主原生 Job 取消终态必须是 killed；插件 run 记录仍是 cancelled）
 * - 无 jobs 服务（只告警一次）、jobs.start 抛错时派单照常，不伪造 jobId
 * - meetingstone_cancel_task 触发 hooks.cancel（不是绕过 Job 直接 cancel）
 * - 取消链必须真的 abort + dispose（空实现会被断言链拒绝）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshAdapter } from '../src/dsh/adapter.js'
import { createDispatcher } from '../src/dispatch/dispatcher.js'
import { createRegistry } from '../src/roles/registry.js'
import { registerTools, TOOL_NAMES } from '../src/dsh/register.js'

const ROLE = {
  roleId: 'role-wukong',
  name: '悟空',
  aliases: ['WK'],
  channel: { kind: 'codex' },
  enabled: true,
  timeoutMs: 0,
}

const PROJECT_ROOT = 'D:/MeetingStone'
const PARENT = {
  id: 'sess-parent',
  session: { id: 'sess-parent', header: { cwd: PROJECT_ROOT } },
}

/** 假 jobs：按宿主契约同步返回 hooks，并记录进度/取消调用。 */
function fakeJobs() {
  const jobs = []
  return {
    jobs,
    start(spec) {
      const id = `meetingstone-dispatch-${String(jobs.length + 1).padStart(4, '0')}`
      const record = {
        id,
        spec,
        progress: [],
        cancelCalls: 0,
        cancelledBy: null,
        hooks: null,
      }
      jobs.push(record)
      const handle = {
        append() {},
        updateProgress(line) {
          record.progress.push(line)
        },
      }
      record.hooks = spec.run(handle)
      return id
    },
    kill(id, caller) {
      const record = jobs.find((job) => job.id === id)
      if (!record) throw new Error(`unknown job ${id}`)
      if (record.spec.owner !== caller) throw new Error(`job ${id} belongs to another session`)
      record.cancelCalls += 1
      record.cancelledBy = caller
      record.hooks.cancel('meetingstone_cancel_task')
      return 'requested'
    },
  }
}

/** 假 subagents：activation.result 由测试控制，dispose 真调用并记录顺序证据。 */
function fakeSubagents() {
  const calls = []
  const stats = { disposeCalls: 0, abortedAtDispose: [] }
  let pending = null
  let seq = 0
  return {
    calls,
    stats,
    get pending() {
      return pending
    },
    getProvider(name) {
      return name === 'codex' ? { name } : undefined
    },
    async startActivation(spec) {
      calls.push(spec)
      seq += 1
      const childId = `child-${seq}`
      let resolveResult
      let rejectResult
      const result = new Promise((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
      })
      pending = { childId, resolveResult, rejectResult, spec }
      return {
        childId,
        name: `agent-${seq}`,
        result,
        async dispose() {
          stats.disposeCalls += 1
          // 顺序证据：取消必须先 abort 宿主 signal，再 dispose。
          stats.abortedAtDispose.push(spec.signal.aborted === true)
        },
      }
    },
  }
}

/** 有上限的等待：done promise 不 settle 时测试失败，而不是永远挂住。 */
function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 未在 ${ms}ms 内 settle`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 取消契约断言链（第 4 项）：任何一条不满足都说明取消路径已退化。
 * 反例测试拿「空 cancel」喂它，证明这套断言确实会失败，而不是永远通过。
 */
async function assertCancelContract({ job, subagents, finished }) {
  const hookResult = await withTimeout(job.hooks.cancel('assert'), 1000, 'hooks.cancel')
  assert.equal(
    hookResult?.stopConfirmed,
    true,
    'hooks.cancel 必须真正驱动取消（返回 stopConfirmed）',
  )
  assert.equal(subagents.stats.disposeCalls, 1, 'hooks.cancel 必须调用宿主 activation.dispose')
  assert.equal(
    subagents.stats.abortedAtDispose[0],
    true,
    '取消必须先 abort 宿主 signal 再 dispose',
  )
  const done = await withTimeout(job.hooks.done, 1000, 'hooks.done')
  assert.equal(done.status, 'killed', '宿主原生 Job 取消终态必须是 killed')
  assert.equal(finished.at(-1)?.status, 'cancelled', '插件 run 记录必须仍是 cancelled')
}

/** @param {object} [over] */
function fakeCtx(over = {}) {
  const warns = []
  const ctx = {
    subagents: null,
    logger: { info() {}, warn: (line) => warns.push(line) },
    effect: null,
    ...over,
    warns,
  }
  return ctx
}

/** @param {{ jobs?: any, subagents?: any, onRunStart?: Function, onRunFinish?: Function }} [over] */
function makeAdapter(over = {}) {
  const subagents = over.subagents ?? fakeSubagents()
  const jobs = over.jobs
  const ctx = fakeCtx({
    subagents,
    ...(jobs
      ? {
          get(name) {
            return name === 'jobs' ? jobs : undefined
          },
        }
      : {}),
  })
  const adapter = createDshAdapter(ctx, {
    channels: [],
    onRunStart: over.onRunStart,
    onRunFinish: over.onRunFinish,
  })
  return { adapter, subagents, jobs, ctx }
}

const startInput = (over = {}) => ({
  role: ROLE,
  task: '审核登录模块',
  timeoutMs: 0,
  context: { projectRoot: PROJECT_ROOT, agent: PARENT },
  ...over,
})

test('派单成功后创建原生 Job：kind/label/owner 正确，taskRef 与 running 记录带 jobId', async () => {
  const jobs = fakeJobs()
  const started = []
  const { adapter } = makeAdapter({ jobs, onRunStart: (record) => started.push(record) })

  const res = await adapter.start(startInput())

  assert.equal(jobs.jobs.length, 1, '必须创建一个 Job')
  const job = jobs.jobs[0]
  assert.equal(job.spec.kind, 'meetingstone-dispatch')
  assert.equal(job.spec.label, '悟空 · 审核登录模块')
  assert.equal(job.spec.owner, PARENT.id, 'owner 是宿主 SessionId（parent.id）')
  assert.equal(res.taskRef.jobId, job.id, 'taskRef 必须带 jobId')
  assert.equal(started.length, 1)
  assert.equal(started[0].jobId, job.id, 'running 记录必须带 jobId')
  assert.match(job.progress[0], /已启动/)
})

test('Job 标签的任务摘要不超过 40 字（超长用省略号）', async () => {
  const jobs = fakeJobs()
  const { adapter } = makeAdapter({ jobs })
  const task = '一'.repeat(100)
  await adapter.start(startInput({ task }))
  const summary = jobs.jobs[0].spec.label.split(' · ').at(-1)
  assert.ok(Array.from(summary).length <= 40, `摘要必须 ≤40 字，实际 ${Array.from(summary).length}`)
  assert.ok(summary.endsWith('…'))
})

test('完成：hooks.done 映射为 completed，detail 带结果摘要，进度更新为已完成', async () => {
  const jobs = fakeJobs()
  const { adapter, subagents } = makeAdapter({ jobs })
  const res = await adapter.start(startInput())
  subagents.pending.resolveResult({
    stopReason: 'completed',
    output: [{ type: 'text', text: '登录模块审核通过' }],
  })
  const outcome = await jobs.jobs[0].hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.detail, /登录模块审核通过/)
  assert.match(jobs.jobs[0].progress.at(-1), /已完成/)
  assert.ok(res.taskRef.childId)
})

test('失败：hooks.done 映射为 failed，detail 带错误信息', async () => {
  const jobs = fakeJobs()
  const { adapter, subagents } = makeAdapter({ jobs })
  await adapter.start(startInput())
  subagents.pending.rejectResult(new Error('provider boom'))
  const outcome = await jobs.jobs[0].hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /provider boom/)
  assert.match(jobs.jobs[0].progress.at(-1), /失败/)
})

test('取消：hooks.done 为宿主契约的 killed，run 记录仍是 cancelled，且 dispose 真被调用', async () => {
  const jobs = fakeJobs()
  const finished = []
  const subagents = fakeSubagents()
  const { adapter } = makeAdapter({
    jobs,
    subagents,
    onRunFinish: (record) => finished.push(record),
  })
  const res = await adapter.start(startInput())
  const outcome = await adapter.cancel(res.taskRef)
  assert.equal(outcome.stopConfirmed, true)

  // 第 4 项：dispose 计数与顺序（空 cancel / 跳过 dispose 的变异必须在这里失败）
  assert.equal(subagents.stats.disposeCalls, 1, '取消必须调用一次宿主 activation.dispose')
  assert.equal(subagents.stats.abortedAtDispose[0], true, '必须先 abort signal 再 dispose')
  assert.equal(jobs.jobs[0].cancelCalls, 1, '取消必须经过 Job 的 hooks.cancel')

  // 第 1 项：宿主原生 Job 状态是 killed；插件 run 记录仍是 cancelled（两者不混用）
  const done = await withTimeout(jobs.jobs[0].hooks.done, 1000, 'hooks.done')
  assert.equal(done.status, 'killed')
  assert.match(done.detail, /cancelled/)
  assert.equal(finished.at(-1)?.status, 'cancelled', 'run 记录不得被改写成 killed')
  assert.equal((await adapter.getTask(res.taskRef)).status, 'cancelled')
  assert.match(jobs.jobs[0].progress.at(-1), /已取消/)

  // hooks.cancel 的返回值必须真实反映取消结果（重复调用不重复 dispose）
  await assertCancelContract({ job: jobs.jobs[0], subagents, finished })
  assert.equal(subagents.stats.disposeCalls, 1, '重复取消不得重复 dispose')
})

test('反例：空 cancel 实现必须让取消契约断言失败（防止测试退化）', async () => {
  const deadJob = {
    hooks: {
      done: new Promise(() => {}),
      cancel: () => {},
    },
  }
  const deadSubagents = { stats: { disposeCalls: 0, abortedAtDispose: [] } }
  await assert.rejects(
    () => assertCancelContract({ job: deadJob, subagents: deadSubagents, finished: [] }),
    /stopConfirmed/,
    '空 cancel 必须被断言链拒绝；若这里通过，说明测试已退化',
  )
})

test('兼容 jobs.start() 返回 { id, append, updateProgress } 的宿主形状', async () => {
  const jobs = {
    start(spec) {
      const handle = { id: 'job-object-shape', append() {}, updateProgress() {} }
      spec.run(handle)
      return handle
    },
  }
  const { adapter } = makeAdapter({ jobs })
  const res = await adapter.start(startInput())
  assert.equal(res.taskRef.jobId, 'job-object-shape')
})

test('无 jobs 服务：派单照常、不伪造 jobId，且每实例只告警一次', async () => {
  const subagents = fakeSubagents()
  const { adapter, ctx } = makeAdapter({ subagents })
  const res = await adapter.start(startInput())
  assert.ok(res.taskRef.childId)
  assert.equal(Object.hasOwn(res.taskRef, 'jobId'), false, '没有 jobs 服务不得伪造 jobId')

  // 第 3 项：jobs 缺失必须告警（之前是静默 return null）
  const lines = ctx.warns.filter((line) =>
    /jobs unavailable, task continues without native Job/.test(line),
  )
  assert.equal(lines.length, 1, `每个适配器实例只告警一次，实际：${ctx.warns.join(' | ')}`)

  // 第二次派单不得重复刷同一行
  await adapter.start(startInput())
  assert.equal(
    ctx.warns.filter((line) => /jobs unavailable, task continues without native Job/.test(line))
      .length,
    1,
    '重复派单不得重复告警',
  )
})

test('jobs.start 抛错：派单照常，只记录 warning，不伪造 jobId', async () => {
  const broken = {
    start() {
      throw new Error('background jobs unavailable: no job controller')
    },
  }
  const { adapter, ctx } = makeAdapter({ jobs: broken })
  const res = await adapter.start(startInput())
  assert.ok(res.taskRef.childId, 'Job 创建失败不能影响派单')
  assert.equal(Object.hasOwn(res.taskRef, 'jobId'), false)
  assert.ok(
    ctx.warns.some((line) => /创建原生 Job 失败/.test(line)),
    `必须记录 warning，实际：${ctx.warns.join(' | ')}`,
  )
})

test('meetingstone_cancel_task：优先走 Job 的 cancel（hooks.cancel），done 状态为 killed', async () => {
  const jobs = fakeJobs()
  const subagents = fakeSubagents()
  const { adapter } = makeAdapter({ jobs, subagents })
  const registry = createRegistry({ globalRoles: [ROLE] })
  const dispatcher = createDispatcher({ registry, adapter })
  const registered = new Map()
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry,
      dispatcher,
      probe: { probe: async () => ({}), probeAll: async () => [] },
    },
  )

  const dispatched = await dispatcher.dispatch({
    role: 'WK',
    task: '审核登录模块',
    projectRoot: PROJECT_ROOT,
    projectKey: PROJECT_ROOT,
    context: { agent: PARENT, projectRoot: PROJECT_ROOT },
  })
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  assert.equal(jobs.jobs.length, 1)

  const cancel = registered.get(TOOL_NAMES.CANCEL_TASK)
  const out = await cancel.execute({ childId: dispatched.taskRef.childId })
  assert.equal(out.ok, true)
  assert.equal(out.stopConfirmed, true)
  assert.equal(jobs.jobs[0].cancelCalls, 1, '取消工具必须触发 Job 的 hooks.cancel')
  assert.equal(subagents.stats.disposeCalls, 1, '取消工具必须真的 dispose 宿主 activation')
  assert.equal((await jobs.jobs[0].hooks.done).status, 'killed')
})

test('插件卸载：存活 Job 的 done 结算为 killed，run 记录为 interrupted（不留假 running）', async () => {
  const jobs = fakeJobs()
  const finished = []
  const { ctx } = makeAdapter({ jobs })
  // makeAdapter 的 ctx.effect 为 null；这里补一个可手动触发的 effect
  const disposers = []
  ctx.effect = (fn) => {
    disposers.push(fn())
  }
  const withEffect = createDshAdapter(ctx, {
    channels: [],
    onRunFinish: (record) => finished.push(record),
  })
  await withEffect.start(startInput())
  assert.equal(jobs.jobs.length, 1)
  for (const dispose of disposers) if (typeof dispose === 'function') await dispose()
  const done = await withTimeout(jobs.jobs[0].hooks.done, 1000, 'hooks.done')
  assert.equal(done.status, 'killed', '卸载也必须是宿主可识别的 killed，不能是 cancelled')
  assert.equal(finished.at(-1)?.status, 'interrupted', '插件 run 记录必须写 interrupted')
})
