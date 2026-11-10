// @ts-check
/**
 * 生命周期正确性（P0）回归：
 *
 * A. 取消顺序：先 await dispose（带超时兜底），再释放并发槽位
 * B. 落盘顺序：同一 childId 的 running / 终态串行写，终态不被覆盖
 * C. runtimeId / interrupted：重启后的假 running 投影为 interrupted；卸载写终态
 *
 * 全部使用假 ctx / 假 provider，不加载宿主包。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { createDshAdapter, ADAPTER_ERRORS } from '../src/dsh/adapter.js'
import { createDispatcher, DISPATCH_ERRORS } from '../src/dispatch/dispatcher.js'
import { createRunStore, RUN_STATUS, RUNS_RELATIVE_DIR } from '../src/run-store.js'

const delay = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假的 subagents：每次 start 一个唯一 childId，result 默认永不结束。 */
function fakeSubagents(options = {}) {
  const calls = []
  const disposed = []
  let seq = 0
  return {
    calls,
    disposed,
    getProvider(name) {
      calls.push({ method: 'getProvider', name })
      return { name }
    },
    async startActivation(spec) {
      seq += 1
      const childId = `child-${seq}`
      calls.push({ method: 'startActivation', spec, childId })
      if (options.startError) throw options.startError
      return {
        childId,
        name: childId,
        result:
          typeof options.result === 'function'
            ? options.result(childId)
            : new Promise(() => {}),
        async dispose() {
          disposed.push(childId)
          if (options.onDispose) await options.onDispose(childId)
          if (options.disposeError) throw options.disposeError
          if (options.disposeHangs) await new Promise(() => {})
        },
      }
    },
  }
}

/** 最小假 ctx：收集 effect disposer / 注册工具 / 日志。 */
function fakeCtx(over = {}) {
  const disposers = []
  const tools = []
  const warns = []
  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
    tools: {
      register(tool) {
        tools.push(tool)
      },
    },
    logger: { info() {}, warn: (line) => warns.push(line) },
    ...over,
  }
  return { ctx, disposers, tools, warns }
}

const role = (over = {}) => ({
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  channel: { kind: 'acp-cli' },
  enabled: true,
  timeoutMs: 0,
  ...over,
})

/** 直接组装 dispatcher + 适配器，用于并发槽位断言。 */
function makeDispatchPair(subagents, adapterOptions = {}, dispatcherOptions = {}) {
  const { ctx, disposers, warns } = fakeCtx({ subagents })
  const adapter = createDshAdapter(ctx, {
    getParent: () => ({ id: 'agent-root' }),
    ...adapterOptions,
  })
  const roleObj = role()
  const registry = {
    resolve: (ref) => (String(ref).toLowerCase() === 'ss' ? roleObj : null),
    list: () => [roleObj],
  }
  const dispatcher = createDispatcher({ registry, adapter, ...dispatcherOptions })
  return { adapter, dispatcher, ctx, disposers, warns, roleObj }
}

const dispatchContext = { projectRoot: 'D:/MeetingStone', agent: { id: 'agent-root' } }

// ─── A. 取消顺序 ─────────────────────────────────────────────────────────────

test('A1：dispose 未完成前同项目再派写任务必须 WRITE_CONFLICT；完成后才能派', async () => {
  let markDisposeStarted
  const disposeStarted = new Promise((resolve) => {
    markDisposeStarted = resolve
  })
  const order = []
  const subagents = fakeSubagents({
    onDispose: async () => {
      order.push('dispose-start')
      markDisposeStarted()
      await delay(200)
      order.push('dispose-end')
    },
  })
  const { dispatcher } = makeDispatchPair(subagents, { now: () => 1 })

  const first = await dispatcher.dispatch({
    role: 'SS',
    task: '写 A',
    projectKey: 'p1',
    context: dispatchContext,
  })
  assert.equal(first.ok, true)

  const canceling = dispatcher.cancel(first.taskRef)
  await disposeStarted

  const during = await dispatcher.dispatch({
    role: 'SS',
    task: '写 B',
    projectKey: 'p1',
    context: dispatchContext,
  })
  assert.equal(during.ok, false, 'dispose 未完成时不得再派写任务')
  assert.equal(during.code, 'WRITE_CONFLICT')

  await canceling
  order.push('slot-released')

  const after = await dispatcher.dispatch({
    role: 'SS',
    task: '写 C',
    projectKey: 'p1',
    context: dispatchContext,
  })
  assert.equal(after.ok, true, 'dispose 完成后应能继续派单')
  assert.deepEqual(order.slice(0, 2), ['dispose-start', 'dispose-end'], '必须先 dispose')
  assert.ok(order.indexOf('dispose-end') < order.indexOf('slot-released'), '槽位释放必须在 dispose 之后')
})

test('A2：dispose 抛错先写 cancelled + stopConfirmed:false，迟到结算回填 true 后才释放槽位', async () => {
  /** @type {(value?: any) => void} */
  let settle
  const subagents = fakeSubagents({
    disposeError: new Error('teardown boom'),
    result: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  })
  const started = []
  const finished = []
  const { ctx, warns } = fakeCtx({ subagents })
  const a = createDshAdapter(ctx, {
    getParent: () => ({ id: 'agent-root' }),
    onRunStart: (r) => started.push(r),
    onRunFinish: (r) => finished.push(r),
  })

  let released = 0
  const res = await a.start({
    role: role(),
    task: 'x',
    timeoutMs: 0,
    onFinish: () => {
      released += 1
    },
    context: dispatchContext,
  })
  const outcome = await a.cancel(res.taskRef)

  assert.equal(started.length, 1)
  assert.equal(outcome.stopConfirmed, false, 'dispose 失败不得报告已确认停止')
  assert.equal(finished.length, 1, '取消先写一次终态')
  assert.equal(finished[0].status, 'cancelled')
  assert.equal(finished[0].error.code, ADAPTER_ERRORS.DISPOSE_FAILED)
  assert.equal(finished[0].stopConfirmed, false, 'dispose 失败不能视为已确认停止')
  assert.match(finished[0].diagnostic, /teardown boom/)
  assert.equal(released, 0, 'dispose 未确认时槽位必须保留（P1）')
  assert.ok(warns.some((l) => l.includes(ADAPTER_ERRORS.DISPOSE_FAILED)), '错误必须记录')

  // 迟到结算：result 落定后再写一次 stopConfirmed:true + diagnostic 含 late settlement，
  // status 仍是 cancelled（不得被 completed 覆盖）；这时才释放槽位
  settle({ stopReason: 'completed', output: [{ type: 'text', text: 'late' }] })
  await delay(30)
  assert.equal(finished.length, 2, '迟到结算必须再写一次终态')
  assert.equal(finished[1].status, 'cancelled', '回填不得把 cancelled 改写成 completed')
  assert.equal(finished[1].stopConfirmed, true, 'result 落定 = 可验证停止证据，回填 true')
  assert.match(finished[1].diagnostic, /late settlement/)
  assert.equal(released, 1, '槽位在迟到结算后才释放')
})

test('A3：dispose 超时按 ADAPTER_DISPOSE_TIMEOUT 兜底返回，迟到结算回填 true 后才释放槽位', async () => {
  /** @type {(value?: any) => void} */
  let settle
  const subagents = fakeSubagents({
    disposeHangs: true,
    result: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  })
  const finished = []
  const { adapter, ctx } = fakeCtx({ subagents })
  const a = createDshAdapter(ctx, {
    getParent: () => ({ id: 'agent-root' }),
    disposeTimeoutMs: 30,
    onRunFinish: (r) => finished.push(r),
  })

  let released = 0
  const res = await a.start({
    role: role(),
    task: 'x',
    timeoutMs: 0,
    onFinish: () => {
      released += 1
    },
    context: dispatchContext,
  })

  const t0 = Date.now()
  const outcome = await a.cancel(res.taskRef)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1000, `超时兜底应立即返回，实际 ${elapsed}ms`)
  assert.equal(outcome.stopConfirmed, false)
  assert.equal(finished.length, 1, '超时先写一次终态')
  assert.equal(finished[0].status, 'cancelled')
  assert.equal(finished[0].error.code, ADAPTER_ERRORS.DISPOSE_TIMEOUT)
  assert.equal(finished[0].stopConfirmed, false, 'dispose 超时不能视为已确认停止')
  assert.equal(released, 0, '超时未确认停止时必须保留槽位（P1）')

  // 迟到结算：回填 stopConfirmed:true + late settlement，status 仍 cancelled，才释放槽位
  settle({ stopReason: 'completed', output: [] })
  await delay(30)
  assert.equal(finished.length, 2, '迟到结算必须再写一次终态')
  assert.equal(finished[1].status, 'cancelled', '回填不得把 cancelled 改写成 completed')
  assert.equal(finished[1].stopConfirmed, true, 'result 落定 = 可验证停止证据，回填 true')
  assert.match(finished[1].diagnostic, /late settlement/)
  assert.equal(released, 1, '槽位在迟到结算后才释放')
})

test('A5：dispose 未确认时 dispatcher 槽位与项目互斥保留，结果落定后才允许新派单', async () => {
  /** @type {(value?: any) => void} */
  let settle
  const subagents = fakeSubagents({
    disposeHangs: true,
    result: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  })
  const { dispatcher } = makeDispatchPair(subagents, { disposeTimeoutMs: 20 }, {
    limits: {
      defaultIsolation: 'none',
      serializeWrites: true,
      maxParallelWritesTotal: 10,
    },
  })

  const first = await dispatcher.dispatch({
    role: 'SS',
    task: '写 A',
    projectKey: 'p-retain',
    context: dispatchContext,
  })
  assert.equal(first.ok, true)
  assert.equal(dispatcher.stats().active, 1)

  const outcome = await dispatcher.cancel(first.taskRef)
  assert.equal(outcome.stopConfirmed, false)
  assert.equal(dispatcher.stats().active, 1, 'dispose 未确认不得释放槽位/隔离互斥')

  const blocked = await dispatcher.dispatch({
    role: 'SS',
    task: '写 B',
    projectKey: 'p-retain',
    context: dispatchContext,
  })
  assert.equal(blocked.ok, false, '槽位保留期间不得接受新的同项目写任务')
  assert.equal(blocked.code, 'WRITE_CONFLICT')

  settle({ stopReason: 'completed', output: [] })
  await delay(30)
  assert.equal(dispatcher.stats().active, 0, '结果落定后才释放')
  const after = await dispatcher.dispatch({
    role: 'SS',
    task: '写 C',
    projectKey: 'p-retain',
    context: dispatchContext,
  })
  assert.equal(after.ok, true, '释放后应能继续派单')
})

test('A4：并发重复取消只 dispose 一次，两次都等到同一个取消结果', async () => {
  const subagents = fakeSubagents({ onDispose: () => delay(30) })
  const { adapter, ctx } = fakeCtx({ subagents })
  const a = createDshAdapter(ctx, { getParent: () => ({ id: 'agent-root' }) })
  const res = await a.start({
    role: role(),
    task: 'x',
    timeoutMs: 0,
    context: dispatchContext,
  })

  await Promise.all([a.cancel(res.taskRef), a.cancel(res.taskRef)])
  assert.equal(subagents.disposed.length, 1, '重复取消不得重复 dispose')
})

// ─── B. 落盘顺序 ─────────────────────────────────────────────────────────────

/** 起一个完整插件（apply），用于验证 index.js 的落盘队列。 */
function applyPlugin(root, subagents, extraRoles = []) {
  const { ctx, disposers, tools } = fakeCtx({ subagents })
  apply(ctx, {
    roles: [role(), ...extraRoles],
    channels: [],
    // 这些用例不是 git 仓库，显式关闭隔离，保留原来的主工作区串行语义
    limits: { defaultIsolation: 'none' },
  })
  const tool = (/** @type {string} */ name) => tools.find((t) => t.name === name)
  return { tools, tool, disposers, ctx }
}

const execFor = (/** @type {string} */ root) => ({
  agent: { session: { header: { cwd: root } } },
})

/** 等到文件出现且状态不是 running（终态写入有链式排队，给一点时间）。 */
async function readRunEventually(root, childId, timeoutMs = 3000) {
  const file = join(root, RUNS_RELATIVE_DIR, `${childId}.json`)
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (err) {
      lastError = err
      await delay(10)
    }
  }
  throw lastError ?? new Error(`记录未出现：${childId}`)
}

/**
 * 等到记录进入指定状态。不要用固定 sleep：测试文件并行跑时机器负载高，
 * 终端写入可能晚于预期（B1 曾因此偶发把 running 当终态）。
 */
async function waitRunStatus(root, childId, status, timeoutMs = 10_000) {
  const file = join(root, RUNS_RELATIVE_DIR, `${childId}.json`)
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(file, 'utf8'))
      last = record
      if (record.status === status) return record
    } catch {
      /* 文件还没出现或正在原子替换，下一轮再读 */
    }
    await delay(20)
  }
  throw new Error(
    `记录 ${childId} 未在 ${timeoutMs}ms 内进入 ${status}；最后状态 ${last?.status ?? 'n/a'}`,
  )
}

test('B1：快速完成的任务落盘最终必须是 completed，result 不被 running 覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-lifecycle-fast-'))
  try {
    const subagents = fakeSubagents({
      result: async () => ({
        stopReason: 'completed',
        output: [{ type: 'text', text: 'PONG' }],
      }),
    })
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')
    assert.ok(dispatch)

    const ids = []
    // 连续多次「runStart 与 onRunFinish 几乎同时」的快速任务，专门打原来的竞态
    for (let i = 0; i < 8; i += 1) {
      const res = await dispatch.execute(
        { role: 'SS', task: `快速任务 ${i}` },
        execFor(root),
      )
      assert.equal(res.ok, true, `第 ${i} 次派单应成功`)
      ids.push(res.taskRef.childId)
    }

    // 给最后一条终态写入留出排队时间，然后逐个等待终态（并发测试文件会拖慢磁盘写入）
    for (const childId of ids) {
      const record = await waitRunStatus(root, childId, RUN_STATUS.COMPLETED)
      assert.equal(record.result, 'PONG', `${childId} 的 result 不能被 running 覆盖`)
      assert.equal(typeof record.runtimeId, 'string')
      assert.ok(record.runtimeId.length > 0, '每条记录都必须带 runtimeId')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ─── C. runtimeId 与 interrupted ─────────────────────────────────────────────

test('C1：旧 runtimeId 的 running 记录读取时投影为 interrupted，且不回写磁盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-lifecycle-interrupt-'))
  try {
    const oldStore = createRunStore({ root, runtimeId: 'runtime-old' })
    await oldStore.writeRun({
      childId: 'legacy-run',
      status: RUN_STATUS.RUNNING,
      runtimeId: 'runtime-old',
      createdAt: 1,
    })

    const newStore = createRunStore({ root, runtimeId: 'runtime-new' })
    const loaded = await newStore.loadRun('legacy-run')
    assert.equal(loaded.status, RUN_STATUS.INTERRUPTED)
    assert.equal(loaded.interrupted, true)

    const listed = await newStore.listRuns()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].status, RUN_STATUS.INTERRUPTED)
    assert.equal(listed[0].interrupted, true)

    // 不回写：磁盘仍是 running
    const raw = JSON.parse(
      await readFile(join(root, RUNS_RELATIVE_DIR, 'legacy-run.json'), 'utf8'),
    )
    assert.equal(raw.status, RUN_STATUS.RUNNING, '投影只影响读取，不得回写磁盘')

    // 同一 runtimeId 的 running 保持原样（可能真的还在跑）
    await newStore.writeRun({ childId: 'live-run', status: RUN_STATUS.RUNNING })
    const live = await newStore.loadRun('live-run')
    assert.equal(live.status, RUN_STATUS.RUNNING)
    assert.equal(live.interrupted, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('C2：插件卸载时给内存中存活任务写 interrupted 终态，不留假 running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-lifecycle-unload-'))
  try {
    const subagents = fakeSubagents() // result 永不结束，任务保持 running
    const { tool, disposers } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')

    const res = await dispatch.execute({ role: 'SS', task: '长任务' }, execFor(root))
    assert.equal(res.ok, true)
    const childId = res.taskRef.childId

    const running = await readRunEventually(root, childId)
    assert.equal(running.status, RUN_STATUS.RUNNING)

    for (const d of disposers) {
      if (typeof d === 'function') await d()
    }

    const record = await readRunEventually(root, childId)
    assert.equal(record.status, RUN_STATUS.INTERRUPTED, '卸载必须写终态')
    assert.equal(record.stopReason, 'plugin-disposed')
    assert.equal(record.stopConfirmed, true, 'dispose 成功应确认已停止')
    assert.match(record.diagnostic ?? '', /插件卸载/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('C3：get_task / list_runs 对上一个进程的 running 显示 interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-lifecycle-tools-'))
  try {
    const runsDir = join(root, RUNS_RELATIVE_DIR)
    await mkdir(runsDir, { recursive: true })
    await writeFile(
      join(runsDir, 'stale-run.json'),
      JSON.stringify({
        schemaVersion: 1,
        childId: 'stale-run',
        runtimeId: 'runtime-old',
        status: RUN_STATUS.RUNNING,
        createdAt: 1,
        startedAt: 1,
        result: '',
      }),
      'utf8',
    )

    const { tool } = applyPlugin(root, fakeSubagents())
    const getTask = tool('meetingstone_get_task')
    const listRuns = tool('meetingstone_list_runs')

    const got = await getTask.execute({ childId: 'stale-run' }, execFor(root))
    assert.equal(got.status, RUN_STATUS.INTERRUPTED)
    assert.equal(got.interrupted, true)

    const listed = await listRuns.execute({}, execFor(root))
    assert.equal(listed.runs.length, 1)
    assert.equal(listed.runs[0].status, RUN_STATUS.INTERRUPTED)
    assert.equal(listed.runs[0].interrupted, true)

    // 磁盘仍保持 running，投影不回写
    const raw = JSON.parse(await readFile(join(runsDir, 'stale-run.json'), 'utf8'))
    assert.equal(raw.status, RUN_STATUS.RUNNING)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('C4：卸载 dispose 失败时写 interrupted + stopConfirmed:false，且不释放槽位', async () => {
  const finished = []
  const subagents = fakeSubagents({ disposeError: new Error('unload boom') })
  const { ctx, disposers } = fakeCtx({ subagents })
  const a = createDshAdapter(ctx, {
    getParent: () => ({ id: 'agent-root' }),
    onRunFinish: (r) => finished.push(r),
  })
  let released = 0
  await a.start({
    role: role(),
    task: 'x',
    timeoutMs: 0,
    onFinish: () => {
      released += 1
    },
    context: dispatchContext,
  })

  for (const dispose of disposers) if (typeof dispose === 'function') await dispose()

  assert.equal(finished.length, 1, '卸载必须写终态')
  assert.equal(finished[0].status, 'interrupted')
  assert.equal(finished[0].stopConfirmed, false, 'dispose 失败不得视为已确认停止')
  assert.match(finished[0].diagnostic, /unload boom/)
  assert.equal(released, 0, '卸载未确认时不得释放槽位（P1）')
  assert.equal(subagents.disposed.length, 1, '重复卸载不得重复 dispose')
})

test('C5：启动中卸载——占位被冻结；activation 返回并 dispose 确认后才释放槽位，拒绝登记', async () => {
  /** @type {() => void} */
  let releaseStart
  const gate = new Promise((resolve) => {
    releaseStart = resolve
  })
  const disposed = []
  const subagents = {
    getProvider() {
      return { name: 'acp' }
    },
    async startActivation() {
      await gate
      return {
        childId: 'late-child',
        name: 'late-child',
        result: new Promise(() => {}),
        async dispose() {
          disposed.push('late-child')
        },
      }
    },
  }
  const started = []
  const finished = []
  const { ctx, disposers } = fakeCtx({ subagents })
  const a = createDshAdapter(ctx, {
    getParent: () => ({ id: 'agent-root' }),
    onRunStart: (r) => started.push(r),
    onRunFinish: (r) => finished.push(r),
  })

  let released = 0
  const starting = a.start({
    role: role(),
    task: '慢启动',
    timeoutMs: 0,
    onFinish: () => {
      released += 1
    },
    context: dispatchContext,
  })
  await delay(10) // 让 start 进入 startActivation 等待

  for (const dispose of disposers) if (typeof dispose === 'function') await dispose()
  assert.equal(
    released,
    0,
    '卸载后、迟到 activation 返回前不能释放槽位：停止状态尚未确认（F1）',
  )

  releaseStart()
  await assert.rejects(() => starting, /ADAPTER_DISPOSED/)
  assert.equal(disposed.length, 1, '启动返回后必须立即 dispose，不得留下存活 activation')
  assert.equal(released, 1, 'dispose 确认停止后才释放占位槽位')
  assert.equal(started.length, 0, '卸载后不得再登记 running 记录')
  assert.equal(finished.length, 0, '没有 childId 的启动不应写终态')

  const late = await a.getTask('late-child')
  assert.equal(late.status, 'unknown', '卸载后不得出现新的存活句柄')

  // 卸载后一律拒绝新启动
  await assert.rejects(
    () => a.start({ role: role(), task: 'x', timeoutMs: 0, context: dispatchContext }),
    /ADAPTER_DISPOSED/,
  )
})

// ─── D. 第二轮复核：迟到 activation 与卸载交错（F1/F2） ──────────────────────

for (const mode of ['抛错', '超时']) {
  test(`D1（${mode}）：启动中卸载后迟到 activation 的 dispose 未确认——保留槽位、写终态、错误码透传（F1）`, async () => {
    /** @type {() => void} */
    let releaseStart
    const gate = new Promise((resolve) => {
      releaseStart = resolve
    })
    /** @type {(value?: any) => void} */
    let settleResult
    const disposed = []
    const subagents = {
      getProvider() {
        return { name: 'acp' }
      },
      async startActivation() {
        await gate
        return {
          childId: 'late-child',
          name: 'late-child',
          result: new Promise((resolve) => {
            settleResult = resolve
          }),
          async dispose() {
            disposed.push('late-child')
            if (mode === '抛错') throw new Error('late dispose boom')
            await new Promise(() => {}) // 永不完成 → 走超时兜底
          },
        }
      },
    }
    const finished = []
    const { dispatcher, disposers, warns } = makeDispatchPair(subagents, {
      disposeTimeoutMs: 30,
      onRunFinish: (r) => finished.push(r),
    })

    const pending = dispatcher.dispatch({
      role: 'SS',
      task: '慢启动',
      projectKey: 'p-late',
      context: dispatchContext,
    })
    await delay(10) // 让 start 进入 startActivation 等待

    for (const dispose of disposers) if (typeof dispose === 'function') await dispose()
    assert.equal(
      dispatcher.stats().active,
      1,
      '卸载后、迟到 activation 返回前不能释放槽位（停止状态未确认）',
    )

    releaseStart()
    const res = await pending
    assert.equal(res.ok, false)
    assert.equal(
      res.code,
      DISPATCH_ERRORS.ADAPTER_DISPOSED,
      'ADAPTER_DISPOSED 必须原样透传，不能被归为 ADAPTER_FAILED',
    )
    assert.equal(disposed.length, 1)
    assert.equal(dispatcher.stats().active, 1, 'dispose 未确认必须保留并发槽位')

    assert.equal(finished.length, 1, '迟到 activation 必须写终态，不能只留 running')
    assert.equal(finished[0].childId, 'late-child')
    assert.equal(finished[0].status, 'interrupted')
    assert.equal(finished[0].stopReason, 'plugin-disposed')
    assert.equal(finished[0].stopConfirmed, false, 'dispose 未确认不得报告已停止')
    assert.ok(
      String(finished[0].error?.code ?? '').startsWith('ADAPTER_DISPOSE_'),
      `终态必须带 dispose 错误码：${JSON.stringify(finished[0].error)}`,
    )
    assert.match(String(finished[0].diagnostic ?? ''), /dispose/)
    assert.ok(
      warns.some((line) => line.includes('ADAPTER_DISPOSE')),
      'dispose 错误必须记录日志，不能静默丢弃',
    )

    const got = await dispatcher.getTask('late-child')
    assert.equal(got.status, 'interrupted', '迟到 activation 必须可查，不能是 unknown')
    assert.equal(got.stopConfirmed, false)

    // result 落定 = 可验证停止：这时才释放保留的槽位
    settleResult({ stopReason: 'completed', output: [] })
    await delay(30)
    assert.equal(dispatcher.stats().active, 0, 'result 落定后才释放保留的槽位')
  })
}

test('D2：卸载时前一个 dispose 阻塞，不影响后一个的终态落盘（F2）', async () => {
  /** @type {Array<{ childId: string, settle: (value?: any) => void }>} */
  const items = []
  const subagents = {
    getProvider() {
      return { name: 'acp' }
    },
    async startActivation() {
      const seq = items.length + 1
      const childId = `child-${seq}`
      /** @type {any} */
      const item = { childId }
      item.result = new Promise((resolve) => {
        item.settle = resolve
      })
      items.push(item)
      return {
        childId,
        name: childId,
        result: item.result,
        async dispose() {
          // 第一个 dispose 阻塞到超时；第二个立即成功
          if (childId === 'child-1') await new Promise(() => {})
        },
      }
    },
  }
  const finished = []
  const { ctx, disposers } = fakeCtx({ subagents })
  const a = createDshAdapter(ctx, {
    getParent: () => ({ id: 'agent-root' }),
    disposeTimeoutMs: 200,
    onRunFinish: (r) => finished.push(r),
  })
  let released = 0
  const first = await a.start({
    role: role(),
    task: '长任务 A',
    timeoutMs: 0,
    onFinish: () => {
      released += 1
    },
    context: dispatchContext,
  })
  const second = await a.start({
    role: role(),
    task: '长任务 B',
    timeoutMs: 0,
    onFinish: () => {
      released += 1
    },
    context: dispatchContext,
  })

  // 开始卸载（不 await）：第一个 dispose 会阻塞到 200ms 超时
  const unloading = Promise.all(
    disposers.map((dispose) => (typeof dispose === 'function' ? dispose() : undefined)),
  )
  await delay(20)
  // 卸载进行中，第二个任务的 result 落定 → 旧实现会 cleanup 后跳过它，磁盘遗留 running
  items[1].settle({ stopReason: 'completed', output: [] })
  await unloading

  const firstRecord = finished.find((r) => r.childId === first.taskRef.childId)
  const secondRecord = finished.find((r) => r.childId === second.taskRef.childId)
  assert.ok(firstRecord, '第一个任务的终态必须写')
  assert.ok(secondRecord, '第二个任务的终态不得因共享 cleanup 被跳过')
  assert.equal(firstRecord.status, 'interrupted')
  assert.equal(firstRecord.stopConfirmed, false, '第一个 dispose 超时，不得报告已停止')
  assert.equal(secondRecord.status, 'interrupted')
  assert.equal(
    secondRecord.stopConfirmed,
    true,
    '第二个任务 result 已落定 = 可验证停止，终态必须如实记录 stopConfirmed:true',
  )
  assert.equal(released, 1, '第二个槽位因 result 落定释放；第一个仍保留')

  // 收尾：第一个 result 落定后释放保留的槽位
  items[0].settle({ stopReason: 'completed', output: [] })
  await delay(30)
  assert.equal(released, 2, '第一个 result 落定后释放保留的槽位')
})
