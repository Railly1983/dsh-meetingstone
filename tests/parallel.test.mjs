// @ts-check
/**
 * 并行多任务（工作树隔离）的派单/额度/查询测试。
 *
 * 分两层：
 * - dispatcher 层：注入假适配器 + 假工作树服务，验证两级额度、失败关闭、混跑纪律
 * - 插件层：真实临时 git 仓库 + 假 subagents，验证建树、changedFiles、取消/卸载、重叠预警
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { apply } from '../src/index.js'
import {
  createDispatcher,
  DISPATCH_ERRORS,
  resolveProjectKey,
} from '../src/dispatch/dispatcher.js'
import { createRegistry } from '../src/roles/registry.js'
import { createRunStore, RUNS_RELATIVE_DIR } from '../src/run-store.js'
import { WORKTREE_ERRORS } from '../src/worktree.js'
import { delay, git, makeRepo, removeRepo, waitFor } from './helpers.mjs'

const ROLE = {
  roleId: 'role-sashi',
  name: '沙僧',
  aliases: ['SS'],
  channel: { kind: 'acp-cli' },
  enabled: true,
  timeoutMs: 0,
}

/** @param {object} [over] */
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

/** 假适配器：start 立即成功，任务保持 active 直到测试主动结束/取消。 */
function fakeAdapter() {
  const started = []
  return {
    started,
    async start(input) {
      const childId = `child-${started.length + 1}`
      started.push({ childId, input })
      return { taskRef: { childId } }
    },
    async cancel(ref) {
      const childId = typeof ref === 'string' ? ref : ref?.childId
      const item = started.find((entry) => entry.childId === childId)
      // 模拟适配器终态回调；dispatcher.cancel 自己也会 release，验证幂等
      item?.input?.onFinish?.()
    },
  }
}

/** 假工作树服务：不碰磁盘，只记录创建参数。 */
function fakeWorktrees() {
  const created = []
  return {
    created,
    async create({ projectRoot, operationId }) {
      const worktree = {
        path: `${projectRoot}/.meetingstone/worktrees/${operationId}`,
        branch: `meetingstone/${operationId}`,
        baseSha: 'fake-base-sha',
        repositoryRoot: projectRoot,
        operationId,
      }
      created.push(worktree)
      return worktree
    },
  }
}

/** @param {{ limits?: object, worktrees?: any, adapter?: any }} [options] */
function makeDispatcher(options = {}) {
  const registry = createRegistry({ globalRoles: [ROLE] })
  const adapter = options.adapter ?? fakeAdapter()
  // 显式传 null 表示"服务缺失"，必须与"未传（用默认假服务）"区分开
  const worktrees = options.worktrees === undefined ? fakeWorktrees() : options.worktrees
  const dispatcher = createDispatcher({
    registry,
    adapter,
    worktrees,
    limits: options.limits ?? {},
  })
  return { dispatcher, adapter, worktrees, registry }
}

const req = (over = {}) => ({
  role: 'SS',
  task: '干活',
  projectKey: 'D:/proj-a',
  projectRoot: 'D:/proj-a',
  ...over,
})

// ─── 额度 ────────────────────────────────────────────────────────────────────

test('项目额度 2：第三个并行写请求被拒（WRITE_LIMIT_PROJECT），释放后可继续', async () => {
  const { dispatcher, worktrees } = makeDispatcher({
    limits: {
      defaultIsolation: 'worktree',
      maxParallelWritesPerProject: 2,
      maxParallelWritesTotal: 10,
    },
  })
  const a = await dispatcher.dispatch(req({ task: 'a' }))
  const b = await dispatcher.dispatch(req({ task: 'b' }))
  assert.equal(a.ok && b.ok, true)
  const c = await dispatcher.dispatch(req({ task: 'c' }))
  assert.equal(c.ok, false)
  assert.equal(c.code, DISPATCH_ERRORS.WRITE_LIMIT_PROJECT)
  assert.equal(worktrees.created.length, 2, '被额度拒绝的请求不得建树')

  dispatcher.release(a.taskRef)
  const d = await dispatcher.dispatch(req({ task: 'd' }))
  assert.equal(d.ok, true)
})

test('全局额度 4：跨项目合计超限被拒（WRITE_LIMIT_TOTAL）', async () => {
  const { dispatcher, worktrees } = makeDispatcher({
    limits: {
      defaultIsolation: 'worktree',
      maxParallelWritesPerProject: 10,
      maxParallelWritesTotal: 4,
    },
  })
  for (const projectKey of ['D:/p1', 'D:/p1', 'D:/p2', 'D:/p2']) {
    const res = await dispatcher.dispatch(req({ projectKey, projectRoot: projectKey }))
    assert.equal(res.ok, true, `${projectKey} 应成功`)
  }
  const fifth = await dispatcher.dispatch(req({ projectKey: 'D:/p3', projectRoot: 'D:/p3' }))
  assert.equal(fifth.ok, false)
  assert.equal(fifth.code, DISPATCH_ERRORS.WRITE_LIMIT_TOTAL)
  assert.equal(worktrees.created.length, 4)
})

test('跨项目可并行：不同 projectKey 各占各的项目额度', async () => {
  const { dispatcher } = makeDispatcher({
    limits: {
      defaultIsolation: 'worktree',
      maxParallelWritesPerProject: 2,
      maxParallelWritesTotal: 10,
    },
  })
  const a1 = await dispatcher.dispatch(req({ projectKey: 'D:/p1', projectRoot: 'D:/p1' }))
  const b1 = await dispatcher.dispatch(req({ projectKey: 'D:/p2', projectRoot: 'D:/p2' }))
  assert.equal(a1.ok && b1.ok, true)
  assert.equal(dispatcher.stats().active, 2)
})

test('同仓库路径别名不绕限：尾斜杠/Windows 大小写折叠到同一项目键', async () => {
  const { dispatcher } = makeDispatcher({
    limits: {
      defaultIsolation: 'worktree',
      maxParallelWritesPerProject: 1,
      maxParallelWritesTotal: 10,
    },
  })
  const first = await dispatcher.dispatch(req({ projectKey: 'D:/P', projectRoot: 'D:/P' }))
  assert.equal(first.ok, true)

  const trailing = await dispatcher.dispatch(req({ projectKey: 'D:/P/', projectRoot: 'D:/P/' }))
  assert.equal(trailing.code, DISPATCH_ERRORS.WRITE_LIMIT_PROJECT, '尾斜杠别名不得绕过项目额度')

  if (process.platform === 'win32') {
    const lower = await dispatcher.dispatch(req({ projectKey: 'd:/p', projectRoot: 'd:/p' }))
    assert.equal(lower.code, DISPATCH_ERRORS.WRITE_LIMIT_PROJECT, '大小写别名不得绕过项目额度')
    const backslash = await dispatcher.dispatch(
      req({ projectKey: 'D:\\P', projectRoot: 'D:\\P' }),
    )
    assert.equal(backslash.code, DISPATCH_ERRORS.WRITE_LIMIT_PROJECT, '反斜杠别名不得绕过项目额度')
  }

  // 也可以只用 projectRoot（不传 projectKey）计数
  dispatcher.release(first.taskRef)
  const byRoot = await dispatcher.dispatch({
    role: 'SS',
    task: 'x',
    projectRoot: 'D:/P',
  })
  assert.equal(byRoot.ok, true)
})

test('同目录别名（原路径 vs src/..）不绕项目额度与隔离互斥（realpath）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-alias-'))
  // 注意：不能用 join(root,'src','..')——path.join 会把它规范化成 root，
  // 等于根本没测到别名（悟空复核指出）。必须保留 `..` 字面量。
  const alias = `${root}${sep}src${sep}..`
  try {
    await mkdir(join(root, 'src'), { recursive: true })
    assert.notEqual(alias, root, '别名输入必须与真实路径字面不同，否则测不到归一化')
    assert.equal(
      await resolveProjectKey(alias),
      await resolveProjectKey(root),
      'realpath 必须把 src/.. 折回同一个项目键',
    )
    const { dispatcher } = makeDispatcher({
      limits: {
        defaultIsolation: 'worktree',
        maxParallelWritesPerProject: 1,
        maxParallelWritesTotal: 10,
      },
    })

    const first = await dispatcher.dispatch(
      req({ projectKey: root, projectRoot: root, isolation: 'worktree', task: 'a' }),
    )
    assert.equal(first.ok, true)
    const byAlias = await dispatcher.dispatch(
      req({ projectKey: alias, projectRoot: alias, isolation: 'worktree', task: 'b' }),
    )
    assert.equal(
      byAlias.code,
      DISPATCH_ERRORS.WRITE_LIMIT_PROJECT,
      '`原路径` 与 `原路径/src/..` 必须共享同一项目额度',
    )

    dispatcher.release(first.taskRef)
    const isolated = await dispatcher.dispatch(
      req({ projectKey: root, projectRoot: root, isolation: 'worktree', task: 'c' }),
    )
    assert.equal(isolated.ok, true)
    // 同一仓库身份下，隔离与未隔离也不能借别名混跑
    const plainByAlias = await dispatcher.dispatch(
      req({ projectKey: alias, projectRoot: alias, isolation: 'none', task: 'd' }),
    )
    assert.equal(
      plainByAlias.code,
      DISPATCH_ERRORS.WRITE_CONFLICT,
      '别名指向同一仓库时，未隔离任务必须与隔离任务互斥',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('目录 symlink/junction 与真实路径共享同一额度键', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mt-real-'))
  const link = `${root}-link`
  try {
    await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (err) {
    t.skip(`当前环境无法创建目录链接，跳过：${err instanceof Error ? err.message : String(err)}`)
    await rm(root, { recursive: true, force: true })
    return
  }
  try {
    const { dispatcher } = makeDispatcher({
      limits: {
        defaultIsolation: 'worktree',
        maxParallelWritesPerProject: 1,
        maxParallelWritesTotal: 10,
      },
    })
    const first = await dispatcher.dispatch(
      req({ projectKey: root, projectRoot: root, isolation: 'worktree' }),
    )
    assert.equal(first.ok, true)
    const viaLink = await dispatcher.dispatch(
      req({ projectKey: link, projectRoot: link, isolation: 'worktree' }),
    )
    assert.equal(
      viaLink.code,
      DISPATCH_ERRORS.WRITE_LIMIT_PROJECT,
      'junction/symlink 不得绕过项目额度',
    )
  } finally {
    await rm(link, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// ─── 失败关闭 / 混跑纪律 ─────────────────────────────────────────────────────

test('建树失败：拒绝派单、不启动适配器、额度回滚，并返回残留位置', async () => {
  const failingWorktrees = {
    async create({ projectRoot, operationId }) {
      const err = new Error('不是 git 仓库')
      // @ts-expect-error 测试构造带 code 的错误
      err.code = WORKTREE_ERRORS.NOT_GIT_REPOSITORY
      // @ts-expect-error 测试构造带 path 的错误
      err.path = `${projectRoot}/.meetingstone/worktrees/${operationId}`
      throw err
    },
  }
  const { dispatcher, adapter } = makeDispatcher({
    limits: { defaultIsolation: 'worktree' },
    worktrees: failingWorktrees,
  })
  const res = await dispatcher.dispatch(req())
  assert.equal(res.ok, false)
  assert.equal(res.code, WORKTREE_ERRORS.NOT_GIT_REPOSITORY)
  assert.equal(adapter.started.length, 0, '建树失败绝不能退回主工作区启动任务')
  assert.ok(res.residualPath && res.residualPath.startsWith('D:/proj-a/.meetingstone/worktrees/'))
  assert.equal(dispatcher.stats().active, 0, '失败后额度必须回滚')
})

test('工作树服务缺失：WORKTREE_UNAVAILABLE，拒绝派单', async () => {
  const { dispatcher, adapter } = makeDispatcher({
    limits: { defaultIsolation: 'worktree' },
    worktrees: null,
  })
  const res = await dispatcher.dispatch(req())
  assert.equal(res.ok, false)
  assert.equal(res.code, DISPATCH_ERRORS.WORKTREE_UNAVAILABLE)
  assert.equal(adapter.started.length, 0)
  assert.equal(dispatcher.stats().active, 0)
})

test('缺少项目根：WORKTREE_UNAVAILABLE 之外的失败关闭（PROJECT_ROOT_UNKNOWN）', async () => {
  const { dispatcher, adapter } = makeDispatcher({ limits: { defaultIsolation: 'worktree' } })
  const res = await dispatcher.dispatch({ role: 'SS', task: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.code, DISPATCH_ERRORS.PROJECT_ROOT_UNKNOWN)
  assert.equal(adapter.started.length, 0)
})

test('非法 isolation 值被拒绝（INVALID_ISOLATION）', async () => {
  const { dispatcher } = makeDispatcher({ limits: { defaultIsolation: 'worktree' } })
  const res = await dispatcher.dispatch(req({ isolation: 'sandbox' }))
  assert.equal(res.ok, false)
  assert.equal(res.code, DISPATCH_ERRORS.INVALID_ISOLATION)
})

test('隔离与未隔离不得混跑（双向）', async () => {
  const { dispatcher } = makeDispatcher({
    limits: {
      defaultIsolation: 'worktree',
      maxParallelWritesPerProject: 2,
      maxParallelWritesTotal: 10,
    },
  })
  const isolated = await dispatcher.dispatch(req({ isolation: 'worktree', task: '树里跑' }))
  assert.equal(isolated.ok, true)

  const plainWhileIsolated = await dispatcher.dispatch(req({ isolation: 'none', task: '主区跑' }))
  assert.equal(plainWhileIsolated.code, DISPATCH_ERRORS.WRITE_CONFLICT)

  dispatcher.release(isolated.taskRef)
  const plain = await dispatcher.dispatch(req({ isolation: 'none', task: '主区跑' }))
  assert.equal(plain.ok, true)

  const isolatedWhilePlain = await dispatcher.dispatch(req({ isolation: 'worktree', task: '树里跑' }))
  assert.equal(isolatedWhilePlain.code, DISPATCH_ERRORS.WRITE_CONFLICT)

  dispatcher.release(plain.taskRef)
  const isolatedAgain = await dispatcher.dispatch(req({ isolation: 'worktree', task: '树里跑' }))
  assert.equal(isolatedAgain.ok, true)
})

test('isolation=none + serializeWrites：同项目仍互斥；关闭串行时按额度并行', async () => {
  const serial = makeDispatcher({
    limits: { defaultIsolation: 'none', serializeWrites: true },
  })
  assert.equal((await serial.dispatcher.dispatch(req())).ok, true)
  const blocked = await serial.dispatcher.dispatch(req())
  assert.equal(blocked.code, DISPATCH_ERRORS.WRITE_CONFLICT)

  const parallel = makeDispatcher({
    limits: {
      defaultIsolation: 'none',
      serializeWrites: false,
      maxParallelWritesPerProject: 2,
      maxParallelWritesTotal: 4,
    },
  })
  assert.equal((await parallel.dispatcher.dispatch(req())).ok, true)
  assert.equal((await parallel.dispatcher.dispatch(req())).ok, true)
  const third = await parallel.dispatcher.dispatch(req())
  assert.equal(third.code, DISPATCH_ERRORS.WRITE_LIMIT_PROJECT)
})

test('取消只释放一次槽位：重复 cancel 不会把别人的额度也放掉', async () => {
  const { dispatcher } = makeDispatcher({
    limits: {
      defaultIsolation: 'worktree',
      maxParallelWritesPerProject: 2,
      maxParallelWritesTotal: 10,
    },
  })
  const a = await dispatcher.dispatch(req({ task: 'a' }))
  const b = await dispatcher.dispatch(req({ task: 'b' }))
  assert.equal(dispatcher.stats().active, 2)

  await dispatcher.cancel(a.taskRef)
  await dispatcher.cancel(a.taskRef) // 重复
  assert.equal(dispatcher.stats().active, 1, '只应释放 a 的槽位，b 仍在')

  const c = await dispatcher.dispatch(req({ task: 'c' }))
  assert.equal(c.ok, true, '空出的一个槽位应可用')
  const d = await dispatcher.dispatch(req({ task: 'd' }))
  assert.equal(d.code, DISPATCH_ERRORS.WRITE_LIMIT_PROJECT, 'b+c 已占满 2 个')
})

// ─── 插件层：真实 git 工作树 ─────────────────────────────────────────────────

/** 可控子 Agent：startActivation 返回 pending result，测试决定何时完成。 */
function controllableSubagents({ onStart } = {}) {
  const calls = []
  const pending = []
  let seq = 0
  return {
    calls,
    pending,
    getProvider() {
      return { name: 'acp' }
    },
    async startActivation(spec) {
      seq += 1
      const childId = `child-${seq}`
      let resolveResult
      /** @type {(value?: any) => void} */
      const resolveFn = (value) => resolveResult(value)
      const result = new Promise((resolvePromise) => {
        resolveResult = resolvePromise
      })
      const item = { childId, spec, resolve: resolveFn }
      calls.push(item)
      pending.push(item)
      if (onStart) await onStart(item)
      return {
        childId,
        name: childId,
        result,
        dispose: async () => {},
      }
    },
  }
}

/** @param {string} root */
const execFor = (root) => ({ agent: { session: { header: { cwd: root } } } })

/** 按插件 effect 顺序串行收尾，清掉 adapter 的 30 分钟超时定时器。 @param {any[]} disposers */
async function disposeAll(disposers) {
  for (const dispose of disposers) {
    if (typeof dispose === 'function') await dispose()
  }
}

/** @param {string} root @param {string} childId */
async function readRun(root, childId) {
  return JSON.parse(await readFile(join(root, RUNS_RELATIVE_DIR, `${childId}.json`), 'utf8'))
}

/**
 * 真实执行区间是否重叠：`A.start < B.end && B.start < A.end`。
 * 必须用落盘记录的 startedAt/finishedAt（真实执行区间），
 * 不能用“检查时的 Date.now()”——悟空已用变异证明那种写法可假通过。
 * @param {{ startedAt: number, finishedAt: number }} a
 * @param {{ startedAt: number, finishedAt: number }} b
 */
function intervalsOverlap(a, b) {
  return a.startedAt < b.finishedAt && b.startedAt < a.finishedAt
}

/** @param {string} root @param {string} childId */
function waitCompleted(root, childId, timeoutMs = 8000) {
  return waitFor(async () => {
    const record = await readRun(root, childId)
    return record.status === 'completed' ? record : null
  }, timeoutMs)
}

/**
 * @param {string} root
 * @param {any} subagents
 * @param {object} [limits]
 */
function applyPlugin(root, subagents, limits = {}) {
  const { ctx, disposers, tools } = fakeCtx({ subagents })
  apply(ctx, {
    roles: [ROLE],
    channels: [],
    limits: { defaultIsolation: 'worktree', ...limits },
  })
  // 每个测试结束都必须收尾：adapter 会给每个存活任务装 30 分钟超时定时器，
  // 不收尾会让 node --test 进程挂到定时器结束（且失败时更难排查）。
  pluginDisposers.push(...disposers)
  return {
    tools,
    disposers,
    tool: (/** @type {string} */ name) => tools.find((t) => t.name === name),
  }
}

/** @type {Array<() => any>} */
const pluginDisposers = []
afterEach(async () => {
  const pending = pluginDisposers.splice(0)
  await disposeAll(pending)
})

test('默认隔离：派单在独立工作树里启动，终态记录 worktree/changedFiles/stopConfirmed', async () => {
  const { root } = await makeRepo({ 'base.txt': 'base\n' })
  try {
    const subagents = controllableSubagents({
      onStart: async (item) => {
        // 子 Agent 在工作树里留下未跟踪文件；完成后应出现在 changedFiles
        await writeFile(join(item.spec.request.cwd, 'work.txt'), 'done\n', 'utf8')
      },
    })
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')
    const res = await dispatch.execute({ role: 'SS', task: '改点东西' }, execFor(root))
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.ok(res.operationId)
    assert.equal(res.taskRef.operationId, res.operationId, 'taskRef 必须携带 operationId → childId 映射')
    assert.ok(res.worktree && res.worktree.path, '返回里必须带工作树元数据')
    assert.equal(
      res.worktree.branch,
      `meetingstone/${res.operationId}`,
      '分支名必须由 operationId 派生',
    )
    assert.match(
      res.worktree.path.replace(/\\/g, '/'),
      /\.meetingstone\/worktrees\//,
      'cwd 必须指向隔离工作树',
    )
    assert.equal(subagents.calls.length, 1)
    assert.equal(
      subagents.calls[0].spec.request.cwd,
      res.worktree.path,
      'adapter 启动 cwd 必须是工作树路径',
    )

    const childId = res.taskRef.childId
    subagents.pending[0].resolve({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'done' }],
    })
    const record = await waitCompleted(root, childId)
    assert.equal(record.worktree.path, res.worktree.path)
    assert.equal(record.worktree.branch, res.worktree.branch)
    assert.equal(record.operationId, res.operationId)
    assert.equal(record.stopConfirmed, true)
    assert.ok(Array.isArray(record.changedFiles) && record.changedFiles.includes('work.txt'))
    assert.equal(record.changedFilesUnknown, false)
    assert.equal(existsSync(res.worktree.path), true, '终止后不得删除工作树')
    assert.equal(existsSync(join(root, 'work.txt')), false, '子 Agent 的改动不得直接落到主工作区')

    const getTask = tool('meetingstone_get_task')
    const got = await getTask.execute({ childId }, execFor(root))
    assert.equal(got.status, 'completed')
    assert.equal(got.worktree.path, res.worktree.path)
    assert.ok(got.changedFiles.includes('work.txt'))
    assert.deepEqual(got.overlapWarnings, [])

    const listRuns = tool('meetingstone_list_runs')
    const listed = await listRuns.execute({}, execFor(root))
    assert.equal(listed.runs.length, 1)
    assert.equal(listed.runs[0].worktree.path, res.worktree.path)
    assert.ok(listed.runs[0].changedFiles.includes('work.txt'))
  } finally {
    await removeRepo(root)
  }
})

test('真实并行：两任务时间重叠、两棵不同工作树、各自真实写文件', async () => {
  const { root } = await makeRepo({ '.gitignore': '.meetingstone/\n' })
  try {
    const subagents = controllableSubagents({
      onStart: async (item) => {
        const childId = item.childId
        await writeFile(join(item.spec.request.cwd, `${childId}.txt`), `${childId}\n`, 'utf8')
      },
    })
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')

    const a = await dispatch.execute({ role: 'SS', task: 'a' }, execFor(root))
    assert.equal(a.ok, true, JSON.stringify(a))
    await delay(169) // 悟空实测的重叠窗口：A 还在跑时启动 B
    const b = await dispatch.execute({ role: 'SS', task: 'b' }, execFor(root))
    assert.equal(b.ok, true, JSON.stringify(b))

    // 两棵不同的真实工作树，各自真实写入了自己的文件
    assert.notEqual(a.worktree.path, b.worktree.path, '两个任务必须使用不同工作树')
    assert.equal(existsSync(a.worktree.path), true)
    assert.equal(existsSync(b.worktree.path), true)
    const aFile = join(a.worktree.path, `${a.taskRef.childId}.txt`)
    const bFile = join(b.worktree.path, `${b.taskRef.childId}.txt`)
    assert.equal(existsSync(aFile), true, 'A 的文件必须写在自己的工作树里')
    assert.equal(existsSync(bFile), true, 'B 的文件必须写在自己的工作树里')
    assert.equal(existsSync(join(b.worktree.path, `${a.taskRef.childId}.txt`)), false, '两棵树不得串文件')
    assert.equal(existsSync(join(a.worktree.path, `${b.taskRef.childId}.txt`)), false)
    assert.equal(existsSync(join(root, `${a.taskRef.childId}.txt`)), false, '改动不得落主工作区')
    assert.equal(existsSync(join(root, `${b.taskRef.childId}.txt`)), false)

    // 真实时间重叠：用落盘记录里的 startedAt/finishedAt（真实执行区间），
    // 要求 A.start < B.end && B.start < A.end。
    // 不能只看「B 启动时 Date.now() 早于 A 被 resolve」——provider 在启动返回前完成时，
    // dispatch 返回的 startedAt 已经是执行结束之后，那种断言会假通过（悟空变异实证）。
    subagents.pending.find((p) => p.childId === a.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, a.taskRef.childId)
    subagents.pending.find((p) => p.childId === b.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, b.taskRef.childId)

    const aRecord = await readRun(root, a.taskRef.childId)
    const bRecord = await readRun(root, b.taskRef.childId)
    assert.equal(typeof aRecord.startedAt, 'number', '记录必须带真实 startedAt')
    assert.equal(typeof aRecord.finishedAt, 'number', '记录必须带真实 finishedAt')
    assert.equal(typeof bRecord.startedAt, 'number', '记录必须带真实 startedAt')
    assert.equal(typeof bRecord.finishedAt, 'number', '记录必须带真实 finishedAt')
    assert.ok(aRecord.startedAt <= bRecord.startedAt, 'A 先启动')
    assert.ok(
      intervalsOverlap(aRecord, bRecord),
      `两个任务的真实执行区间必须重叠：A=[${aRecord.startedAt},${aRecord.finishedAt}] ` +
        `B=[${bRecord.startedAt},${bRecord.finishedAt}]`,
    )
  } finally {
    await removeRepo(root)
  }
})

test('反例：串行执行（A 完成后再启动 B）必须被真实区间断言判为不重叠', async () => {
  const { root } = await makeRepo({ '.gitignore': '.meetingstone/\n' })
  try {
    const subagents = controllableSubagents()
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')

    const a = await dispatch.execute({ role: 'SS', task: 'a' }, execFor(root))
    assert.equal(a.ok, true, JSON.stringify(a))
    subagents.pending.find((p) => p.childId === a.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, a.taskRef.childId)
    const aRecord = await readRun(root, a.taskRef.childId)

    // A 的终态落盘后才启动 B：这是货真价实的串行
    const b = await dispatch.execute({ role: 'SS', task: 'b' }, execFor(root))
    assert.equal(b.ok, true, JSON.stringify(b))
    subagents.pending.find((p) => p.childId === b.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, b.taskRef.childId)
    const bRecord = await readRun(root, b.taskRef.childId)

    assert.ok(aRecord.finishedAt <= bRecord.startedAt, '串行区间必须首尾相接')
    assert.equal(
      intervalsOverlap(aRecord, bRecord),
      false,
      `串行执行不得被误判为重叠：A=[${aRecord.startedAt},${aRecord.finishedAt}] ` +
        `B=[${bRecord.startedAt},${bRecord.finishedAt}]`,
    )
  } finally {
    await removeRepo(root)
  }
})

test('主区保护：脏文件/未跟踪/索引/HEAD 在两个隔离任务前后逐项不变', async () => {
  const { root } = await makeRepo({
    '.gitignore': '.meetingstone/\n',
    'base.txt': 'base\n',
    'dirty.txt': 'original\n',
  })
  try {
    // 独立的脏文件、未跟踪文件、暂存样本（暂存后绝不 commit，确保是真正的 staged-only）
    await writeFile(join(root, 'dirty.txt'), 'dirty-in-main\n', 'utf8')
    await writeFile(join(root, 'untracked-main.txt'), 'untracked\n', 'utf8')
    await writeFile(join(root, 'staged-main.txt'), 'staged-only\n', 'utf8')
    git(root, 'add', 'staged-main.txt')

    const snapshot = async () => ({
      status: git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      index: git(root, 'ls-files', '--stage'),
      head: git(root, 'rev-parse', 'HEAD'),
      dirty: await readFile(join(root, 'dirty.txt'), 'utf8'),
      untracked: await readFile(join(root, 'untracked-main.txt'), 'utf8'),
      staged: await readFile(join(root, 'staged-main.txt'), 'utf8'),
    })

    const before = await snapshot()
    assert.match(before.status, /A  staged-main\.txt/, '样本必须处于真正的暂存态')
    assert.equal(git(root, 'ls-tree', '--name-only', 'HEAD', 'staged-main.txt').trim(), '', '暂存样本不得已被 commit')

    const subagents = controllableSubagents({
      onStart: async (item) => {
        await writeFile(join(item.spec.request.cwd, `${item.childId}.txt`), 'child\n', 'utf8')
      },
    })
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')
    const a = await dispatch.execute({ role: 'SS', task: 'a' }, execFor(root))
    const b = await dispatch.execute({ role: 'SS', task: 'b' }, execFor(root))
    assert.equal(a.ok && b.ok, true, JSON.stringify({ a, b }))
    for (const item of subagents.pending) item.resolve({ stopReason: 'completed', output: [] })
    await waitCompleted(root, a.taskRef.childId)
    await waitCompleted(root, b.taskRef.childId)

    const after = await snapshot()
    assert.equal(after.head, before.head, 'HEAD 不得变化')
    assert.equal(after.index, before.index, '索引（含暂存样本）必须逐字节不变')
    assert.equal(after.status, before.status, '主区状态（脏文件/未跟踪）必须逐字节不变')
    assert.equal(after.dirty, before.dirty, '已有脏文件内容不得被改动')
    assert.equal(after.untracked, before.untracked, '未跟踪文件内容不得被改动')
    assert.equal(after.staged, before.staged, '暂存样本内容不得被改动')
    assert.equal(git(root, 'ls-tree', '--name-only', 'HEAD', 'staged-main.txt').trim(), '', '暂存样本不得变成提交')
  } finally {
    await removeRepo(root)
  }
})


test('项目额度 2（插件层）：第三个被拒且不建树；完成后槽位释放', async () => {
  const { root } = await makeRepo()
  try {
    const subagents = controllableSubagents()
    const { tool } = applyPlugin(root, subagents, {
      maxParallelWritesPerProject: 2,
      maxParallelWritesTotal: 4,
    })
    const dispatch = tool('meetingstone_dispatch')
    const first = await dispatch.execute({ role: 'SS', task: 'a' }, execFor(root))
    const second = await dispatch.execute({ role: 'SS', task: 'b' }, execFor(root))
    assert.equal(first.ok && second.ok, true)
    const third = await dispatch.execute({ role: 'SS', task: 'c' }, execFor(root))
    assert.equal(third.ok, false)
    assert.equal(third.code, DISPATCH_ERRORS.WRITE_LIMIT_PROJECT)

    const worktreeNames = await readdir(join(root, '.meetingstone', 'worktrees'))
    assert.equal(worktreeNames.length, 2, '被拒的请求不得创建第三棵树')

    subagents.pending[0].resolve({ stopReason: 'completed', output: [] })
    await waitCompleted(root, first.taskRef.childId)
    await delay(100) // 等 adapter 的 onFinish 释放槽位
    const fourth = await dispatch.execute({ role: 'SS', task: 'd' }, execFor(root))
    assert.equal(fourth.ok, true, JSON.stringify(fourth))

    for (const pending of subagents.pending.slice(1)) {
      pending.resolve({ stopReason: 'completed', output: [] })
    }
  } finally {
    await removeRepo(root)
  }
})

test('总额度 4（插件层）：跨项目合计超限被拒', async () => {
  const repoA = await makeRepo()
  const repoB = await makeRepo()
  const repoC = await makeRepo()
  try {
    const subagents = controllableSubagents()
    const { tool } = applyPlugin(repoA.root, subagents, {
      maxParallelWritesPerProject: 2,
      maxParallelWritesTotal: 4,
    })
    const dispatch = tool('meetingstone_dispatch')
    for (const root of [repoA.root, repoA.root, repoB.root, repoB.root]) {
      const res = await dispatch.execute({ role: 'SS', task: 'x' }, execFor(root))
      assert.equal(res.ok, true, JSON.stringify(res))
    }
    // 第五个放到第三个项目：项目额度没满，但全局额度已满
    const fifth = await dispatch.execute({ role: 'SS', task: 'x' }, execFor(repoC.root))
    assert.equal(fifth.ok, false)
    assert.equal(fifth.code, DISPATCH_ERRORS.WRITE_LIMIT_TOTAL)
  } finally {
    await removeRepo(repoA.root)
    await removeRepo(repoB.root)
    await removeRepo(repoC.root)
  }
})

test('失败关闭（插件层）：非 git 项目拒绝派单，不启动 activation，额度不泄漏', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-not-git-plugin-'))
  try {
    const subagents = controllableSubagents()
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')
    const first = await dispatch.execute({ role: 'SS', task: 'x' }, execFor(root))
    assert.equal(first.ok, false)
    assert.equal(first.code, WORKTREE_ERRORS.NOT_GIT_REPOSITORY)
    assert.ok(first.residualPath, '失败结果要给出预期残留位置')
    assert.equal(subagents.calls.length, 0, '建树失败不得启动子 Agent')

    const second = await dispatch.execute({ role: 'SS', task: 'x' }, execFor(root))
    assert.equal(second.ok, false)
    assert.equal(second.code, WORKTREE_ERRORS.NOT_GIT_REPOSITORY, '第二次应是建树失败，不是额度超限')
  } finally {
    await removeRepo(root)
  }
})

test('取消：不删树，另一个任务不受影响，记录 cancelled + stopConfirmed', async () => {
  const { root } = await makeRepo()
  try {
    const subagents = controllableSubagents()
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')
    const a = await dispatch.execute({ role: 'SS', task: 'a' }, execFor(root))
    const b = await dispatch.execute({ role: 'SS', task: 'b' }, execFor(root))
    assert.equal(a.ok && b.ok, true)

    const cancel = tool('meetingstone_cancel_task')
    await cancel.execute({ childId: a.taskRef.childId }, execFor(root))
    const cancelled = await waitFor(async () => {
      const record = await readRun(root, a.taskRef.childId)
      return record.status === 'cancelled' ? record : null
    })
    assert.equal(cancelled.stopConfirmed, true)
    assert.equal(existsSync(a.worktree.path), true, '取消不得删除工作树')
    assert.equal(existsSync(b.worktree.path), true)

    const getTask = tool('meetingstone_get_task')
    const stillRunning = await getTask.execute({ childId: b.taskRef.childId }, execFor(root))
    assert.equal(stillRunning.status, 'running', '另一个任务不应被取消影响')

    // a 的槽位释放后应还能再派一个（b + c = 2）
    const c = await dispatch.execute({ role: 'SS', task: 'c' }, execFor(root))
    assert.equal(c.ok, true, JSON.stringify(c))

    subagents.pending.find((p) => p.childId === b.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, b.taskRef.childId)
  } finally {
    await removeRepo(root)
  }
})

test('卸载：写 interrupted 终态，不删除工作树', async () => {
  const { root } = await makeRepo()
  try {
    const subagents = controllableSubagents()
    const { tool, disposers } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')
    const res = await dispatch.execute({ role: 'SS', task: '长任务' }, execFor(root))
    assert.equal(res.ok, true)

    for (const dispose of disposers) if (typeof dispose === 'function') await dispose()

    const record = await waitFor(async () => {
      const parsed = await readRun(root, res.taskRef.childId)
      return parsed.status === 'interrupted' ? parsed : null
    })
    assert.equal(record.stopReason, 'plugin-disposed')
    assert.equal(record.stopConfirmed, true)
    assert.equal(existsSync(res.worktree.path), true, '卸载不得删除工作树')
  } finally {
    await removeRepo(root)
  }
})

// ─── 重叠预警 ────────────────────────────────────────────────────────────────

test('重叠：两棵树改同一文件 → 双方 overlapWarnings 命中；未跟踪与重命名也算', async () => {
  const { root } = await makeRepo({
    'shared.txt': 'shared\n',
    'old.txt': 'old\n',
    'base.txt': 'base\n',
  })
  try {
    const subagents = controllableSubagents({
      onStart: async (item) => {
        const cwd = item.spec.request.cwd
        if (item.childId === 'child-1') {
          git(cwd, 'mv', 'old.txt', 'renamed.txt')
          await writeFile(join(cwd, 'untracked-same.txt'), 'a\n', 'utf8')
        } else if (item.childId === 'child-2') {
          await writeFile(join(cwd, 'shared.txt'), 'shared-b\n', 'utf8')
          await writeFile(join(cwd, 'old.txt'), 'old-b\n', 'utf8')
          await writeFile(join(cwd, 'untracked-same.txt'), 'b\n', 'utf8')
          await writeFile(join(cwd, 'only-b.txt'), 'b\n', 'utf8')
        }
      },
    })
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')
    const a = await dispatch.execute({ role: 'SS', task: 'a' }, execFor(root))
    const b = await dispatch.execute({ role: 'SS', task: 'b' }, execFor(root))
    assert.equal(a.ok && b.ok, true, JSON.stringify({ a, b }))

    // 顺序完成：先 A 后 B，确保 B 的终态写入时 A 的记录已经落盘，
    // 这样"原始 JSON 必须含 overlapWarnings"可以严格断言（而不是靠读写时序碰运气）。
    subagents.pending.find((p) => p.childId === a.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, a.taskRef.childId)
    subagents.pending.find((p) => p.childId === b.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, b.taskRef.childId)

    // 原始磁盘记录对照（P2）：后写的 B 必须把与 A 的重叠写进 JSON
    const rawB = JSON.parse(
      await readFile(join(root, RUNS_RELATIVE_DIR, `${b.taskRef.childId}.json`), 'utf8'),
    )
    assert.ok(Array.isArray(rawB.overlapWarnings), '磁盘记录必须包含 overlapWarnings 字段')
    const rawWarning = rawB.overlapWarnings.find((w) => w.childId === a.taskRef.childId)
    assert.ok(rawWarning, `原始 JSON 必须记录与 A 的重叠：${JSON.stringify(rawB.overlapWarnings)}`)
    for (const file of ['old.txt', 'untracked-same.txt']) {
      assert.ok(rawWarning.files.includes(file), `原始 JSON 的预警应含 ${file}`)
    }

    const listRuns = tool('meetingstone_list_runs')
    const listed = await listRuns.execute({}, execFor(root))
    const byId = Object.fromEntries(listed.runs.map((run) => [run.childId, run]))

    const aWarning = byId[a.taskRef.childId].overlapWarnings.find(
      (w) => w.childId === b.taskRef.childId,
    )
    const bWarning = byId[b.taskRef.childId].overlapWarnings.find(
      (w) => w.childId === a.taskRef.childId,
    )
    assert.ok(aWarning, 'A 应警告与 B 的重叠')
    assert.ok(bWarning, 'B 应警告与 A 的重叠')
    for (const file of ['old.txt', 'untracked-same.txt']) {
      assert.ok(aWarning.files.includes(file), `A 的预警应含 ${file}：${aWarning.files}`)
      assert.ok(bWarning.files.includes(file), `B 的预警应含 ${file}：${bWarning.files}`)
    }
    assert.equal(aWarning.files.includes('shared.txt'), false, 'shared.txt 只有 B 改，不应误报给 A')
    assert.equal(bWarning.files.includes('renamed.txt'), false, 'renamed.txt 只有 A 改，不应误报给 B')

    const getTask = tool('meetingstone_get_task')
    const got = await getTask.execute({ childId: a.taskRef.childId }, execFor(root))
    assert.ok(
      got.overlapWarnings.some((w) => w.childId === b.taskRef.childId),
      'get_task 也必须返回 overlapWarnings',
    )

    // 不同文件不误报
    await delay(100) // 等 A/B 的 onFinish 释放项目额度
    const c = await dispatch.execute({ role: 'SS', task: 'c' }, execFor(root))
    const d = await dispatch.execute({ role: 'SS', task: 'd' }, execFor(root))
    assert.equal(c.ok && d.ok, true, JSON.stringify({ c, d }))
    await writeFile(join(c.worktree.path, 'only-c.txt'), 'c\n', 'utf8')
    await writeFile(join(d.worktree.path, 'only-d.txt'), 'd\n', 'utf8')
    subagents.pending.find((p) => p.childId === c.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    subagents.pending.find((p) => p.childId === d.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, c.taskRef.childId)
    await waitCompleted(root, d.taskRef.childId)

    const later = await listRuns.execute({}, execFor(root))
    const laterById = Object.fromEntries(later.runs.map((run) => [run.childId, run]))
    assert.equal(
      laterById[c.taskRef.childId].overlapWarnings.some((w) => w.childId === d.taskRef.childId),
      false,
      '不同文件不应误报',
    )
    assert.equal(
      laterById[d.taskRef.childId].overlapWarnings.some((w) => w.childId === c.taskRef.childId),
      false,
      '不同文件不应误报',
    )
  } finally {
    await removeRepo(root)
  }
})

test('并发 overlap：两棵真实工作树同时改 shared.txt，并发落盘后双方原始 JSON 都含交集（F3）', async () => {
  const { root } = await makeRepo({ 'shared.txt': 'shared\n' })
  try {
    const subagents = controllableSubagents({
      onStart: async (item) => {
        await writeFile(join(item.spec.request.cwd, 'shared.txt'), `${item.childId}\n`, 'utf8')
      },
    })
    const { tool } = applyPlugin(root, subagents)
    const dispatch = tool('meetingstone_dispatch')
    const a = await dispatch.execute({ role: 'SS', task: 'a' }, execFor(root))
    const b = await dispatch.execute({ role: 'SS', task: 'b' }, execFor(root))
    assert.equal(a.ok && b.ok, true, JSON.stringify({ a, b }))

    // 同时结束：两个终态写入必须互斥完成「写当前 + 回写对方」
    subagents.pending.find((p) => p.childId === a.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    subagents.pending.find((p) => p.childId === b.taskRef.childId)?.resolve({
      stopReason: 'completed',
      output: [],
    })
    await waitCompleted(root, a.taskRef.childId)
    await waitCompleted(root, b.taskRef.childId)

    for (const [own, other] of [
      [a, b],
      [b, a],
    ]) {
      const raw = await readRun(root, own.taskRef.childId)
      const warning = raw.overlapWarnings.find((w) => w.childId === other.taskRef.childId)
      assert.ok(
        warning,
        `${own.taskRef.childId} 的原始 JSON 必须记录与 ${other.taskRef.childId} 的交集：` +
          JSON.stringify(raw.overlapWarnings),
      )
      assert.ok(warning.files.includes('shared.txt'), '交集必须包含 shared.txt')
    }
  } finally {
    await removeRepo(root)
  }
})

test('changedFilesUnknown：记录标注未知且不参与重叠比较', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-overlap-unknown-'))
  try {
    const store = createRunStore({ root })
    await store.writeRun({
      childId: 'known',
      status: 'completed',
      worktree: { path: '/tmp/known', baseSha: 'b', branch: 'meetingstone/known', operationId: 'known' },
      changedFiles: ['shared.txt'],
      changedFilesUnknown: false,
    })
    await store.writeRun({
      childId: 'unknown',
      status: 'completed',
      worktree: { path: '/tmp/unknown', baseSha: 'b', branch: 'meetingstone/unknown', operationId: 'unknown' },
      changedFiles: ['shared.txt'],
      changedFilesUnknown: true,
    })

    const runs = await store.listRuns()
    const known = runs.find((run) => run.childId === 'known')
    const unknown = runs.find((run) => run.childId === 'unknown')
    assert.equal(known.changedFilesUnknown, false)
    assert.deepEqual(known.overlapWarnings, [], '未知记录不参与比较，不能当成有交集')
    assert.equal(unknown.changedFilesUnknown, true, '必须标注未知')
    assert.deepEqual(unknown.overlapWarnings, [])

    const loaded = await store.loadRun('unknown')
    assert.equal(loaded.changedFilesUnknown, true)
    assert.deepEqual(loaded.overlapWarnings, [])
  } finally {
    await removeRepo(root)
  }
})

test('淘汰保护：带 worktree 的记录不被 100 条/30 天清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-prune-worktree-'))
  try {
    let clock = Date.now()
    const store = createRunStore({ root, maxRuns: 2, maxAgeMs: 1000, now: () => clock })
    await store.writeRun({
      childId: 'wt-keep',
      status: 'completed',
      worktree: { path: '/tmp/wt-keep', baseSha: 'b', branch: 'meetingstone/wt-keep', operationId: 'wt-keep' },
      changedFiles: ['x.txt'],
    })
    for (let i = 0; i < 6; i += 1) {
      await store.writeRun({ childId: `plain-${i}`, status: 'completed' })
      await delay(5)
    }

    let names = await readdir(join(root, RUNS_RELATIVE_DIR))
    assert.ok(names.includes('wt-keep.json'), '带 worktree 的记录不得被条数清理')
    assert.equal(names.filter((name) => name.startsWith('plain-')).length, 2, '普通记录仍按 2 条上限清理')

    // 时长清理也不能删它
    clock += 60_000
    const result = await store.pruneRuns()
    assert.ok(result.protected >= 1)
    names = await readdir(join(root, RUNS_RELATIVE_DIR))
    assert.ok(names.includes('wt-keep.json'), '带 worktree 的记录不得被时长清理')
    assert.equal(names.filter((name) => name.startsWith('plain-')).length, 0)
  } finally {
    await removeRepo(root)
  }
})

test('重启后：list_runs 保留 worktree 元数据，旧 running 投影为 interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-restart-worktree-'))
  try {
    const oldStore = createRunStore({ root, runtimeId: 'runtime-old' })
    await oldStore.writeRun({
      childId: 'old-run',
      status: 'running',
      runtimeId: 'runtime-old',
      operationId: 'op-old',
      worktree: {
        path: join(root, '.meetingstone', 'worktrees', 'op-old'),
        branch: 'meetingstone/op-old',
        baseSha: 'abc',
        repositoryRoot: root,
        operationId: 'op-old',
      },
    })

    const newStore = createRunStore({ root, runtimeId: 'runtime-new' })
    const [run] = await newStore.listRuns()
    assert.equal(run.status, 'interrupted')
    assert.equal(run.interrupted, true)
    assert.equal(run.worktree.branch, 'meetingstone/op-old')
    assert.equal(run.operationId, 'op-old')

    const loaded = await newStore.loadRun('old-run')
    assert.equal(loaded.status, 'interrupted')
    assert.equal(loaded.worktree.path, join(root, '.meetingstone', 'worktrees', 'op-old'))
    assert.deepEqual(loaded.overlapWarnings, [])
  } finally {
    await removeRepo(root)
  }
})

test('listRuns 保留 worktree/changedFiles/operationId（悟空指出的丢失字段）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mt-list-worktree-'))
  try {
    const store = createRunStore({ root })
    await store.writeRun({
      childId: 'run-wt',
      status: 'completed',
      operationId: 'op-1',
      worktree: {
        path: '/tmp/wt',
        branch: 'meetingstone/op-1',
        baseSha: 'abc',
        repositoryRoot: '/tmp/repo',
        operationId: 'op-1',
      },
      changedFiles: ['a.txt', 'b.txt'],
      stopConfirmed: true,
    })
    const [run] = await store.listRuns()
    assert.equal(run.operationId, 'op-1')
    assert.equal(run.worktree.path, '/tmp/wt')
    assert.equal(run.worktree.branch, 'meetingstone/op-1')
    assert.equal(run.worktree.baseSha, 'abc')
    assert.deepEqual(run.changedFiles, ['a.txt', 'b.txt'])
    assert.equal(run.stopConfirmed, true)
  } finally {
    await removeRepo(root)
  }
})
