// @ts-check
/**
 * `meetingstone_steer_task` 的外部 CLI 路径（restart-with-output）测试。
 *
 * 背景（2026-11-12 真机测试暴露的三个缺陷）：
 *
 * 1. **`childId` 恒为 null** —— steer 重开时只传了 `role/task/upstreamChildId`，
 *    缺 `context.agent`（parent agent）与 `projectKey`，dispatcher 直接返回
 *    `PARENT_AGENT_UNAVAILABLE`。
 * 2. **`stopConfirmed` 取值错误** —— 用了 `cancelOutcome?.ok ?? false`，
 *    但 `dispatcher.cancel` 返回的是 `{ stopConfirmed, reason }`，不是 `{ ok }`。
 *    于是明明停成功了（记录里 stopConfirmed=true），回执却说 false。
 * 3. **原任务没停也照样重开** —— 会出现两个任务同时写同一工作区。
 *
 * 这三条都是「没有测试覆盖」导致的，本文件把行为钉死。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerTools } from '../src/dsh/register.js'
import { TOOL_NAMES } from '../src/dsh/register.js'

/** 造一个最小可用的 ctx / deps。 */
function harness({ record, cancelOutcome, dispatchResult } = {}) {
  /** @type {any[]} */
  const registered = []
  const ctx = { tools: { register: (def) => registered.push(def) } }
  /** @type {any[]} */
  const cancels = []
  /** @type {any[]} */
  const dispatches = []
  const deps = {
    registry: {
      list: () => [{ roleId: 'role-sashi', name: '沙僧', enabled: true }],
      resolve: () => ({ roleId: 'role-sashi', name: '沙僧', enabled: true }),
    },
    probe: { probe: async () => ({ installed: false }), probeAll: async () => [] },
    loadPersistedRun: async () => record ?? null,
    listPersistedRuns: async () => ({ runs: [] }),
    dispatcher: {
      dispatch: async (input) => {
        dispatches.push(input)
        return dispatchResult ?? { ok: true, taskRef: { childId: 'new-child' } }
      },
      cancel: async (ref) => {
        cancels.push(ref)
        return cancelOutcome ?? { stopConfirmed: true }
      },
    },
  }
  registerTools(ctx, deps)
  const tool = registered.find((t) => t.name === TOOL_NAMES.STEER_TASK)
  assert.ok(tool, '必须注册 steer 工具')
  return { tool, cancels, dispatches }
}

/** 一条外部 CLI 的 running 记录。 */
const ACP_RECORD = {
  childId: 'old-child',
  role: 'role-sashi',
  provider: 'acp',
  status: 'running',
  projectRoot: 'D:/proj',
  projectKey: 'd:/proj',
  isolation: 'worktree',
  result: '已完成第 1 步，得到 42 行',
}

const EXEC = { agent: { id: 'session-1' } }

test('外部 CLI：正常重开，返回新 childId（修复前恒为 null）', async () => {
  const { tool, dispatches } = harness({ record: ACP_RECORD })
  const out = await tool.execute({ childId: 'old-child', instruction: '只统计第一个' }, EXEC)
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'restart-with-output')
  assert.equal(out.childId, 'new-child', '必须回传新 childId，不能是 null')
  assert.equal(out.previousChildId, 'old-child')
  assert.equal(dispatches.length, 1)
})

test('外部 CLI：dispatch 必须带 context.agent（修复前缺这个导致 PARENT_AGENT_UNAVAILABLE）', async () => {
  const { tool, dispatches } = harness({ record: ACP_RECORD })
  await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  const input = dispatches[0]
  assert.ok(input.context, '必须带 context')
  assert.equal(input.context.agent, EXEC.agent, 'context.agent 必须是调用方 agent')
  assert.equal(input.projectKey, 'd:/proj', '必须带 projectKey（并发计数按项目隔离）')
  assert.equal(input.projectRoot, 'D:/proj')
  assert.equal(input.sessionId, 'session-1', '单会话并发上限需要 sessionId')
})

test('外部 CLI：沿用原任务的 isolation，不混跑', async () => {
  const { tool, dispatches } = harness({ record: ACP_RECORD })
  await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(dispatches[0].isolation, 'worktree')
})

test('外部 CLI：带上已有产出重放 + upstreamChildId 关联', async () => {
  const { tool, dispatches } = harness({ record: ACP_RECORD })
  const out = await tool.execute({ childId: 'old-child', instruction: '新指示' }, EXEC)
  const task = dispatches[0].task
  assert.match(task, /新指示/, '必须含新指示')
  assert.match(task, /已完成第 1 步/, '必须含上次产出')
  assert.match(task, /不是指令/, '重放块要标明不是指令')
  assert.equal(dispatches[0].upstreamChildId, 'old-child', '必须关联原任务')
  assert.ok(out.replayedBytes > 0)
})

test('stopConfirmed 取 cancel 的 stopConfirmed（修复前误用 .ok 导致恒 false）', async () => {
  const { tool } = harness({ record: ACP_RECORD, cancelOutcome: { stopConfirmed: true } })
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.stopConfirmed, true, 'cancel 说停成功了，回执就该是 true')
})

test('关键门禁：原任务停不干净 → 拒绝重开，不启动第二个写入任务', async () => {
  const { tool, dispatches } = harness({
    record: ACP_RECORD,
    cancelOutcome: { stopConfirmed: false, reason: 'adapter did not confirm' },
  })
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.error, 'STOP_UNCONFIRMED')
  assert.equal(out.stopConfirmed, false)
  assert.match(out.message, /未能确认停止/)
  assert.equal(dispatches.length, 0, '绝不能启动第二个任务')
})

test('重开派单失败时如实报错，不谎报成功', async () => {
  const { tool } = harness({
    record: ACP_RECORD,
    dispatchResult: { ok: false, code: 'WRITE_LIMIT_TOTAL', message: '已达上限' },
  })
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.ok, undefined)
  assert.equal(out.error, 'WRITE_LIMIT_TOTAL')
  assert.match(out.message, /已达上限/)
  assert.equal(out.stopConfirmed, true, '原任务确实已停')
})

test('cancel 抛错时按「未确认停止」处理，不重开', async () => {
  /** @type {any[]} */
  const dispatches = []
  const registered = []
  const ctx = { tools: { register: (d) => registered.push(d) } }
  registerTools(ctx, {
    registry: { list: () => [], resolve: () => null },
    probe: { probe: async () => ({}), probeAll: async () => [] },
    loadPersistedRun: async () => ACP_RECORD,
    listPersistedRuns: async () => ({ runs: [] }),
    dispatcher: {
      dispatch: async (input) => {
        dispatches.push(input)
        return { ok: true, taskRef: { childId: 'x' } }
      },
      cancel: async () => {
        throw new Error('cancel boom')
      },
    },
  })
  const tool = registered.find((t) => t.name === TOOL_NAMES.STEER_TASK)
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.error, 'STOP_UNCONFIRMED', 'cancel 抛错 → 视为未确认停止')
  assert.match(out.message, /cancel boom/, '原始错误要透传')
  assert.equal(dispatches.length, 0, '绝不能启动第二个任务')
})

test('进程内任务：走 steer 而不是 restart', async () => {
  const spawnRecord = {
    ...ACP_RECORD,
    provider: 'spawn',
    channel: 'in-process',
  }
  const registered = []
  const ctx = { tools: { register: (d) => registered.push(d) } }
  registerTools(ctx, {
    registry: { list: () => [], resolve: () => null },
    probe: { probe: async () => ({}), probeAll: async () => [] },
    loadPersistedRun: async () => spawnRecord,
    listPersistedRuns: async () => ({ runs: [] }),
    dispatcher: {
      dispatch: async () => {
        throw new Error('进程内任务不该走 restart')
      },
      cancel: async () => ({ stopConfirmed: true }),
    },
  })
  const steerTool = registered.find((t) => t.name === TOOL_NAMES.STEER_TASK)
  assert.ok(steerTool)
  // 没有 subagents 时进程内路径会如实报 STEER_UNAVAILABLE，而不会去 restart
  const out = await steerTool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.notEqual(out.mode, 'restart-with-output', '进程内任务不该走 restart')
  assert.ok(out.error, '应该如实报错（缺 subagents）')
})

// ── 2026-11-12 真机测试暴露的第四个问题 ──────────────────────────────
// adapter.cancelActivation 在「没有存活句柄」时返回 stopConfirmed:false
// （正确的谨慎行为，但对 steer 是误判：任务可能已自行结束）。
// 修法：先看记录是否已终态；cancel 报没有句柄时再回查一次记录。

test('任务已自行结束（记录是 cancelled）→ 视为已停，允许重开', async () => {
  const ended = { ...ACP_RECORD, status: 'cancelled', stopConfirmed: true }
  const { tool, dispatches } = harness({
    record: ended,
    // cancel 会说不确定（因为没有存活句柄），但记录说已终态
    cancelOutcome: { stopConfirmed: false, reason: '没有该任务的存活句柄，无法确认停止状态' },
  })
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.ok, true, '已终态的任务不该被 STOP_UNCONFIRMED 拦住')
  assert.equal(out.mode, 'restart-with-output')
  assert.equal(out.stopConfirmed, true)
  assert.equal(dispatches.length, 1)
})

test('任务已 completed 时同理（不必 cancel 也能重开）', async () => {
  const done = { ...ACP_RECORD, status: 'completed' }
  const { tool, dispatches } = harness({
    record: done,
    cancelOutcome: { stopConfirmed: false, reason: '没有该任务的存活句柄' },
  })
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.ok, true)
  assert.equal(dispatches.length, 1)
})

test('cancel 报没有句柄，但记录仍是 running → 仍拒绝（保守）', async () => {
  const stillRunning = { ...ACP_RECORD, status: 'running' }
  const { tool, dispatches } = harness({
    record: stillRunning,
    cancelOutcome: { stopConfirmed: false, reason: '没有该任务的存活句柄' },
  })
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.error, 'STOP_UNCONFIRMED', '拿不到证据就不能重开')
  assert.equal(dispatches.length, 0)
})

test('派单前内存说还在跑、磁盘已 cancelled → 拒绝（不信过时快照）', async () => {
  // 真实分层：loadPersistedRun 返回**磁盘**记录（无 liveStatus），
  // resolveRun/dispatcher.getTask 返回**内存**视图。
  // 这里模拟「派单前」：磁盘已 cancelled（旧快照），但内存说还在跑。
  const diskRecord = { ...ACP_RECORD, status: 'cancelled' }
  const registered = []
  const dispatches = []
  const ctx = { tools: { register: (d) => registered.push(d) } }
  registerTools(ctx, {
    registry: { list: () => [], resolve: () => null },
    probe: { probe: async () => ({}), probeAll: async () => [] },
    loadPersistedRun: async () => diskRecord,
    listPersistedRuns: async () => ({ runs: [] }),
    // 内存视图：还在跑
    dispatcher: {
      getTask: async () => ({ status: 'running' }),
      dispatch: async (i) => {
        dispatches.push(i)
        return { ok: true, taskRef: { childId: 'new' } }
      },
      // cancel 也说没停 —— 两层证据都说没停
      cancel: async () => ({ stopConfirmed: false, reason: '句柄仍在运行' }),
    },
  })
  const tool = registered.find((t) => t.name === TOOL_NAMES.STEER_TASK)
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.error, 'STOP_UNCONFIRMED', '两层证据都说没停，必须拒绝')
  assert.equal(dispatches.length, 0)
})

test('cancel 报没有句柄、但磁盘已终态 → 允许重开（不被异步 dispose 卡住）', async () => {
  // 真机场景（childId 0b14ca77）：cancel 成功了，记录变 cancelled，
  // 但适配器内存里的句柄还没 dispose 完，getTask 仍返回 running。
  // 此时**不能**因为内存还显示 running 就拒绝 —— 那会让外部 CLI 永远无法重开。
  const diskRecord = { ...ACP_RECORD, status: 'cancelled', stopConfirmed: true }
  const registered = []
  const dispatches = []
  const ctx = { tools: { register: (d) => registered.push(d) } }
  registerTools(ctx, {
    registry: { list: () => [], resolve: () => null },
    probe: { probe: async () => ({}), probeAll: async () => [] },
    loadPersistedRun: async () => diskRecord,
    listPersistedRuns: async () => ({ runs: [] }),
    dispatcher: {
      // 内存句柄还没清（异步 dispose 的窗口期）
      getTask: async () => ({ status: 'running' }),
      dispatch: async (i) => {
        dispatches.push(i)
        return { ok: true, taskRef: { childId: 'new' } }
      },
      cancel: async () => ({ stopConfirmed: false, reason: '没有该任务的存活句柄' }),
    },
  })
  const tool = registered.find((t) => t.name === TOOL_NAMES.STEER_TASK)
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.ok, true, '磁盘已终态 + cancel 说没句柄 = 已停')
  assert.equal(out.stopConfirmed, true)
  assert.equal(dispatches.length, 1)
})

// ── 接替说明（2026-11-12 第七轮真机测试暴露）─────────────────────────
// 新任务是全新会话，不知道有原任务。若原任务无产出，它只看到裸指令，
// 会判断「这要求我虚构结果」并合理拒绝执行。

test('重开任务必须带接替说明（否则新任务会拒绝执行）', async () => {
  const noOutput = { ...ACP_RECORD, result: null }
  const { tool, dispatches } = harness({ record: noOutput })
  await tool.execute({ childId: 'old-child', instruction: '输出「验证通过」' }, EXEC)
  const task = dispatches[0].task
  assert.match(task, /任务接替说明/, '必须告诉它这是接替')
  assert.match(task, /old-child/, '必须给出原任务 id')
  assert.match(task, /尚未产出任何结果/, '必须说明没有上一轮上下文')
  assert.match(task, /不需要复述或"验证"任何历史过程/, '要明确叫它别虚构验证')
  assert.match(task, /新指示/, '要有明确的分段')
  assert.match(task, /输出「验证通过」/, '新指示本身要保留')
})

test('有产出时：接替说明仍然有，但措辞不同（指向重放块）', async () => {
  const { tool, dispatches } = harness({ record: ACP_RECORD }) // ACP_RECORD 有 result
  await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  const task = dispatches[0].task
  assert.match(task, /任务接替说明/)
  assert.match(task, /已有产出附在下方/)
  assert.doesNotMatch(task, /尚未产出任何结果/)
})

test('无产出时 note 要提示「新任务只能看到你的新指示」', async () => {
  const noOutput = { ...ACP_RECORD, result: null }
  const { tool } = harness({ record: noOutput })
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.equal(out.replayedBytes, 0)
  assert.match(out.note, /尚无产出/, 'note 必须提示这一点')
  assert.match(out.note, /建议把必要背景写进 instruction/)
})

test('有产出时 note 不追加「无产出」提示', async () => {
  const { tool } = harness({ record: ACP_RECORD })
  const out = await tool.execute({ childId: 'old-child', instruction: 'x' }, EXEC)
  assert.doesNotMatch(out.note, /尚无产出/)
})
