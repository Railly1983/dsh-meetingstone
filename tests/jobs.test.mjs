// @ts-check
/**
 * 原生 Jobs 接入测试（假 jobs 服务，不加载宿主包）。
 *
 * 覆盖任务 A 的验收点：
 * - Job 被创建，kind/label/owner 正确（标签含角色 · 通道 · ≤40 字任务摘要）
 * - 完成 / 失败 / 取消三种终态 → hooks.done 映射正确
 * - 无 jobs 服务、jobs.start 抛错时派单照常，不伪造 jobId
 * - meetingstone_cancel_task 触发 hooks.cancel（不是绕过 Job 直接 cancel）
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

/** 假 subagents：activation.result 由测试控制，dispose 记为已停止。 */
function fakeSubagents() {
  const calls = []
  let pending = null
  return {
    calls,
    get pending() {
      return pending
    },
    getProvider(name) {
      return name === 'codex' ? { name } : undefined
    },
    async startActivation(spec) {
      calls.push(spec)
      let resolveResult
      let rejectResult
      const result = new Promise((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
      })
      pending = { resolveResult, rejectResult, spec }
      return {
        childId: 'child-1',
        name: 'agent-1',
        result,
        async dispose() {},
      }
    },
  }
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
  assert.equal(job.spec.label, '悟空 · codex · 审核登录模块')
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

test('取消：hooks.done 映射为 cancelled，并且 Job 的 cancel 被调用一次', async () => {
  const jobs = fakeJobs()
  const { adapter } = makeAdapter({ jobs })
  const res = await adapter.start(startInput())
  const outcome = await adapter.cancel(res.taskRef)
  assert.equal(outcome.stopConfirmed, true)
  const done = await jobs.jobs[0].hooks.done
  assert.equal(done.status, 'cancelled')
  assert.equal(jobs.jobs[0].cancelCalls, 1)
  assert.match(jobs.jobs[0].progress.at(-1), /已取消/)
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

test('无 jobs 服务：派单照常，不创建 Job、不伪造 jobId', async () => {
  const { adapter } = makeAdapter({})
  const res = await adapter.start(startInput())
  assert.ok(res.taskRef.childId)
  assert.equal(Object.hasOwn(res.taskRef, 'jobId'), false)
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

test('meetingstone_cancel_task：优先走 Job 的 cancel（hooks.cancel）', async () => {
  const jobs = fakeJobs()
  const { adapter } = makeAdapter({ jobs })
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
  assert.equal((await jobs.jobs[0].hooks.done).status, 'cancelled')
})

test('插件卸载：存活 Job 的 done 结算为 cancelled（不留假 running）', async () => {
  const jobs = fakeJobs()
  const { adapter, ctx } = makeAdapter({ jobs })
  // makeAdapter 的 ctx.effect 为 null；这里补一个可手动触发的 effect
  const disposers = []
  ctx.effect = (fn) => {
    disposers.push(fn())
  }
  const withEffect = createDshAdapter(ctx, { channels: [] })
  await withEffect.start(startInput())
  assert.equal(jobs.jobs.length, 1)
  for (const dispose of disposers) if (typeof dispose === 'function') await dispose()
  const done = await jobs.jobs[0].hooks.done
  assert.equal(done.status, 'cancelled')
})
