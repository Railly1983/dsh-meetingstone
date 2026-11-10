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
import { createDispatcher } from '../src/dispatch/dispatcher.js'
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
function makeDispatchPair(subagents, adapterOptions = {}) {
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
  const dispatcher = createDispatcher({ registry, adapter })
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

test('A2：dispose 抛错也要释放槽位，并把 ADAPTER_DISPOSE_FAILED 记进终态', async () => {
  const subagents = fakeSubagents({ disposeError: new Error('teardown boom') })
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
  await a.cancel(res.taskRef)

  assert.equal(started.length, 1)
  assert.equal(finished.length, 1, '取消必须写终态')
  assert.equal(finished[0].status, 'cancelled')
  assert.equal(finished[0].error.code, ADAPTER_ERRORS.DISPOSE_FAILED)
  assert.match(finished[0].diagnostic, /teardown boom/)
  assert.equal(released, 1, 'dispose 抛错也必须释放槽位')
  assert.ok(warns.some((l) => l.includes(ADAPTER_ERRORS.DISPOSE_FAILED)), '错误必须记录')
})

test('A3：dispose 卡死时按 ADAPTER_DISPOSE_TIMEOUT 兜底，不会永久占槽', async () => {
  const subagents = fakeSubagents({ disposeHangs: true })
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
  await a.cancel(res.taskRef)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1000, `超时兜底应立即返回，实际 ${elapsed}ms`)
  assert.equal(finished[0].error.code, ADAPTER_ERRORS.DISPOSE_TIMEOUT)
  assert.equal(released, 1, '超时后也必须释放槽位')
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

    // 给最后一条终态写入留出排队时间，然后一次性验最终态
    await delay(300)
    for (const childId of ids) {
      const record = await readRunEventually(root, childId)
      assert.equal(record.status, RUN_STATUS.COMPLETED, `${childId} 最终必须是 completed`)
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
