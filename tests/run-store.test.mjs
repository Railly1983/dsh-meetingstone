// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRunStore,
  truncateUtf8,
  RunStoreError,
  MAX_RESULT_BYTES,
  MAX_CHANGED_FILES,
  MAX_FILE_BYTES,
  MAX_OVERLAP_FILES,
  MAX_OVERLAP_BYTES,
  RUNS_RELATIVE_DIR,
} from '../src/run-store.js'
import { registerTools } from '../src/dsh/register.js'

const ID = 'aaaa1111-bbbb-2222-cccc-333344445555'

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'mt-runs-'))
}

test('写读往返：字段白名单、终态可读', async () => {
  const root = await tempRoot()
  const store = createRunStore({ root })
  await store.writeRun({
    childId: ID,
    role: 'role-sashi',
    channel: 'acp-cli',
    provider: 'acp',
    model: 'hy4',
    status: 'completed',
    stopReason: 'completed',
    startedAt: 1,
    finishedAt: 2,
    result: 'PONG',
    // 下面这些不该被写入
    task: 'SECRET TASK TEXT',
    persona: 'SECRET PERSONA',
  })
  const record = await store.loadRun(ID)
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.result, 'PONG')
  assert.equal(record.status, 'completed')
  assert.equal(record.role, 'role-sashi')
  assert.equal(record.task, undefined, '不得保存任务全文')
  assert.equal(record.persona, undefined, '不得保存人设')
})

test('原子写：目录里只留 .json，没有 .tmp 残留', async () => {
  const root = await tempRoot()
  const store = createRunStore({ root })
  await store.writeRun({ childId: ID, status: 'running', result: '' })
  const names = await readdir(join(root, RUNS_RELATIVE_DIR))
  assert.deepEqual(names, [`${ID}.json`])
})

test('非法 childId 被拒绝（防路径穿越）', async () => {
  const root = await tempRoot()
  const store = createRunStore({ root })
  for (const bad of ['../evil', 'a/b', '', '.hidden', 'x'.repeat(200)]) {
    await assert.rejects(
      () => store.writeRun({ childId: bad, status: 'running' }),
      (err) => err instanceof RunStoreError && err.code === 'RUN_ID_INVALID',
      `应拒绝 ${JSON.stringify(bad)}`,
    )
  }
})

test('读不到 / 读坏：分别给 RUN_NOT_FOUND 与 RUN_CORRUPT', async () => {
  const root = await tempRoot()
  const store = createRunStore({ root })
  await assert.rejects(
    () => store.loadRun(ID),
    (err) => err instanceof RunStoreError && err.code === 'RUN_NOT_FOUND',
  )
  await mkdir(join(root, RUNS_RELATIVE_DIR), { recursive: true })
  await writeFile(join(root, RUNS_RELATIVE_DIR, `${ID}.json`), '{not json', 'utf8')
  await assert.rejects(
    () => store.loadRun(ID),
    (err) => err instanceof RunStoreError && err.code === 'RUN_CORRUPT',
  )
})

test('超长结果被截断：保留头尾且 UTF-8 不破损', async () => {
  const root = await tempRoot()
  const store = createRunStore({ root, maxResultBytes: 1024 })
  const head = '头'.repeat(400)
  const tail = '尾'.repeat(400)
  await store.writeRun({ childId: ID, status: 'completed', result: head + tail })
  const record = await store.loadRun(ID)
  assert.equal(record.resultTruncated, true)
  assert.ok(record.result.includes('truncated'), '应有截断标记')
  assert.ok(record.result.startsWith('头'), '应保留头部')
  assert.ok(record.result.endsWith('尾'), '应保留尾部')
  assert.ok(!record.result.includes('\uFFFD'), '不得出现替换字符（UTF-8 破损）')
  assert.ok(record.resultBytes <= 1024 + 64)
})

test('truncateUtf8：不超限时原样返回', () => {
  const out = truncateUtf8('PONG', 1024)
  assert.deepEqual(out, { text: 'PONG', bytes: 4, truncated: false })
})

test('清理：超过条数上限时删最旧的', async () => {
  const root = await tempRoot()
  const store = createRunStore({ root, maxRuns: 3, maxAgeMs: 1e12 })
  for (let i = 0; i < 6; i += 1) {
    await store.writeRun({ childId: `run-${i}`, status: 'completed', result: String(i), createdAt: i })
    await new Promise((r) => setTimeout(r, 5))
  }
  const names = (await readdir(join(root, RUNS_RELATIVE_DIR))).filter((n) => n.endsWith('.json'))
  assert.equal(names.length, 3)
})

test('清理：超过保留时长的会删掉', async () => {
  const root = await tempRoot()
  let clock = Date.now()
  const store = createRunStore({ root, maxRuns: 100, maxAgeMs: 1000, now: () => clock })
  await store.writeRun({ childId: 'old-run', status: 'completed', result: 'x' })
  clock += 60_000
  const removed = await store.pruneRuns()
  assert.equal(removed.removed, 1)
})

test('默认上限符合约定（256 KiB / 100 条）', () => {
  assert.equal(MAX_RESULT_BYTES, 256 * 1024)
})

test('get_task：内存 unknown 时从磁盘兜底（模拟重启）', async () => {
  const root = await tempRoot()
  const store = createRunStore({ root })
  await store.writeRun({ childId: ID, status: 'completed', result: 'PONG', provider: 'acp' })

  const registered = new Map()
  registerTools(
    { tools: { register: (spec) => registered.set(spec.name, spec) } },
    {
      registry: { list: () => [], resolve: () => null, errors: [] },
      dispatcher: { dispatch: async () => ({}), getTask: async () => ({ status: 'unknown', childId: ID }) },
      probe: { probe: async () => ({}) },
      loadPersistedRun: async (exec, childId) => {
        assert.equal(exec.agent.session.header.cwd, root, '必须按执行上下文的项目根去读')
        return store.loadRun(childId)
      },
    },
  )
  const spec = registered.get('meetingstone_get_task')
  const out = await spec.execute({ childId: ID }, { agent: { session: { header: { cwd: root } } } })
  assert.equal(out.status, 'completed')
  assert.equal(out.output ?? out.result, 'PONG')
})

test('listRuns：新的在前、只给摘要、支持 limit', async () => {
  const root = await tempRoot()
  const store = createRunStore({ root })
  await store.writeRun({ childId: 'r1', role: 'role-a', status: 'completed', result: 'A'.repeat(500), createdAt: 1 })
  await store.writeRun({ childId: 'r2', role: 'role-b', status: 'failed', result: 'B', createdAt: 2, error: { code: 'X', message: 'boom' } })
  await store.writeRun({ childId: 'r3', role: 'role-c', status: 'running', createdAt: 3 })
  const all = await store.listRuns()
  assert.deepEqual(all.map((r) => r.childId), ['r3', 'r2', 'r1'])
  assert.equal(all[0].status, 'running')
  assert.equal(all[1].error.code, 'X')
  assert.equal(all[2].preview.length, 200, '预览必须截断到 200 字')
  assert.equal(all.length, 3)
  const limited = await store.listRuns({ limit: 1 })
  assert.equal(limited.length, 1)
  assert.equal(limited[0].childId, 'r3')
})

// ─── P1：大型 changedFiles 记录必须可读，且清理器 fail-safe 保护 ────────────────

test('changedFiles 超限：截断到 5000 条并记 total/truncated，记录仍可读', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root })
    // 16000 条 × 约 250 字节路径：原始记录会超过旧 1MB 读取上限（悟空实测 1.54MB 的场景）
    const files = Array.from(
      { length: 16_000 },
      (_, i) => `dir/${'x'.repeat(220)}-${i}.txt`,
    )
    await store.writeRun({
      childId: ID,
      status: 'completed',
      worktree: { path: '/tmp/wt', baseSha: 'b', branch: 'meetingstone/wt', operationId: 'wt' },
      changedFiles: files,
    })

    const record = await store.loadRun(ID)
    assert.ok(record.changedFiles.length <= MAX_CHANGED_FILES, '必须按条数上限截断')
    assert.equal(record.changedFilesTruncated, true)
    assert.equal(record.changedFilesTotal, files.length, '必须记录原始总数')
    assert.equal(record.changedFiles[0], files[0], '保留前面的改动文件（重叠检测优先）')

    const [listed] = await store.listRuns()
    assert.equal(listed.changedFilesTruncated, true, 'list_runs 也必须暴露截断标记')
    assert.equal(listed.changedFilesTotal, files.length, 'list_runs 也必须暴露原始总数')

    const { size } = await stat(join(root, RUNS_RELATIVE_DIR, `${ID}.json`))
    assert.ok(size <= MAX_FILE_BYTES, `记录体积必须受控，实际 ${size} 字节`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('changedFiles 字节预算：超长路径不会把记录撑爆', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root })
    // 每条 4KB，5000 条原始约 20MB；字节预算必须继续裁剪
    const files = Array.from({ length: 5000 }, (_, i) => `${'y'.repeat(4000)}-${i}`)
    await store.writeRun({ childId: ID, status: 'completed', changedFiles: files })
    const record = await store.loadRun(ID)
    assert.ok(record.changedFiles.length > 0)
    assert.ok(
      record.changedFiles.length < files.length,
      '字节预算必须继续裁剪，而不是只看条数',
    )
    assert.equal(record.changedFilesTruncated, true)
    assert.equal(record.changedFilesTotal, files.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('清理 fail-safe：超大或不可解析记录不得因读不了而被删', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root, maxRuns: 1, maxAgeMs: 1_000_000 })
    const dir = join(root, RUNS_RELATIVE_DIR)
    await mkdir(dir, { recursive: true })

    // 超大但仍是合法 JSON 的普通记录（没有 worktree）——旧实现会因 size 跳过解析，
    // 然后按"未保护"删掉；新实现必须 fail-safe 保护。
    await writeFile(
      join(dir, 'huge-run.json'),
      JSON.stringify({ childId: 'huge-run', status: 'completed', result: 'x'.repeat(MAX_FILE_BYTES + 1024) }),
      'utf8',
    )
    // 坏 JSON 记录：同样无法判断是否带 worktree
    await writeFile(join(dir, 'broken-run.json'), '{not json', 'utf8')
    // 一条可解析的普通记录，用来触发条数清理
    await store.writeRun({ childId: 'plain-run', status: 'completed' })
    // 再写一条，确保 maxRuns=1 触发淘汰
    await store.writeRun({ childId: 'plain-run-2', status: 'completed' })

    const names = await readdir(dir)
    assert.ok(names.includes('huge-run.json'), '超大记录必须被保护，不能因读不了而删')
    assert.ok(names.includes('broken-run.json'), '坏记录必须被保护，不能因解析失败而删')
    assert.equal(names.filter((name) => name.startsWith('plain-run')).length, 1, '普通记录仍按上限清理')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ─── P2：overlapWarnings 必须落盘（原始 JSON 自证） ───────────────────────────

test('overlap 落盘：A→B 与 B→A 两种写入顺序，原始 JSON 与读取结果都正确', async () => {
  const shared = ['line\nbreak.txt', 'tab\tname.txt', 'shared.txt']
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const root = await tempRoot()
    try {
      const store = createRunStore({ root })
      /** @type {Record<string, any>} */
      const make = (id) => ({
        childId: id,
        status: 'completed',
        worktree: {
          path: `/tmp/${id}`,
          baseSha: 'base',
          branch: `meetingstone/${id}`,
          operationId: id,
        },
        changedFiles: shared,
      })
      for (const id of order) await store.writeRun(make(id))
      const [first, second] = order

      // F3：后写记录不仅自己要有交集，还要**回写**先写记录——两份原始 JSON 都自证冲突；
      // 与并发结束顺序无关（下面另有并发用例）。
      const rawFirst = JSON.parse(await readFile(join(root, RUNS_RELATIVE_DIR, `${first}.json`), 'utf8'))
      const rawSecond = JSON.parse(await readFile(join(root, RUNS_RELATIVE_DIR, `${second}.json`), 'utf8'))
      for (const [owner, raw, otherId] of [
        [first, rawFirst, second],
        [second, rawSecond, first],
      ]) {
        assert.ok(Array.isArray(raw.overlapWarnings), `${owner} 磁盘记录必须含 overlapWarnings 字段`)
        const warning = raw.overlapWarnings.find((w) => w.childId === otherId)
        assert.ok(
          warning,
          `${owner} 的原始 JSON 必须记录与 ${otherId} 的重叠：${JSON.stringify(raw.overlapWarnings)}`,
        )
        assert.deepEqual(warning.files.slice().sort(), shared.slice().sort(), '换行/制表符文件名必须原样往来')
      }

      // 读取时重算：双方都能看到对方（与写入顺序无关）
      const loadedFirst = await store.loadRun(first)
      const loadedSecond = await store.loadRun(second)
      assert.ok(loadedFirst.overlapWarnings.some((w) => w.childId === second))
      assert.ok(loadedSecond.overlapWarnings.some((w) => w.childId === first))
      assert.deepEqual(
        loadedFirst.overlapWarnings.find((w) => w.childId === second).files.slice().sort(),
        shared.slice().sort(),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('overlap 并发落盘：同时写入两棵工作树的终态，两份原始 JSON 都含交集（F3）', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root })
    const shared = ['shared.txt', 'same-dir/file.txt']
    const make = (id) => ({
      childId: id,
      status: 'completed',
      worktree: {
        path: `/tmp/${id}`,
        baseSha: 'base',
        branch: `meetingstone/${id}`,
        operationId: id,
      },
      changedFiles: shared,
    })
    // 真正并发：两个 writeRun 同时进入，互斥必须保证“写当前 + 回写对方”都完成
    await Promise.all([store.writeRun(make('a')), store.writeRun(make('b'))])

    for (const [id, other] of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      const raw = JSON.parse(
        await readFile(join(root, RUNS_RELATIVE_DIR, `${id}.json`), 'utf8'),
      )
      const warning = raw.overlapWarnings.find((w) => w.childId === other)
      assert.ok(
        warning,
        `${id} 的原始 JSON 必须包含与 ${other} 的交集：${JSON.stringify(raw.overlapWarnings)}`,
      )
      assert.deepEqual(warning.files.slice().sort(), shared.slice().sort())
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('overlap 上限：5000 条共同路径不会撑爆记录，超限写 overlapTruncated/overlapTotal（F4）', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root })
    const files = Array.from(
      { length: 5000 },
      (_, i) => `dir/${'z'.repeat(200)}-${i}.txt`,
    )
    const make = (id) => ({
      childId: id,
      status: 'completed',
      worktree: {
        path: `/tmp/${id}`,
        baseSha: 'base',
        branch: `meetingstone/${id}`,
        operationId: id,
      },
      changedFiles: files,
    })
    // 旧实现第三份会 RUN_TOO_LARGE（overlap 各 1.4MB/2.8MB），磁盘遗留 running
    for (const id of ['r1', 'r2', 'r3']) await store.writeRun(make(id))

    for (const id of ['r1', 'r2', 'r3']) {
      const raw = JSON.parse(
        await readFile(join(root, RUNS_RELATIVE_DIR, `${id}.json`), 'utf8'),
      )
      assert.equal(raw.status, 'completed', `${id} 必须是终态，不能遗留 running`)
      const others = ['r1', 'r2', 'r3'].filter((candidate) => candidate !== id)
      for (const other of others) {
        const warning = raw.overlapWarnings.find((w) => w.childId === other)
        assert.ok(warning, `${id} 必须记录与 ${other} 的重叠`)
        assert.ok(
          warning.files.length <= MAX_OVERLAP_FILES,
          `每对最多 ${MAX_OVERLAP_FILES} 个文件，实际 ${warning.files.length}`,
        )
      }
      const bytes = Buffer.byteLength(JSON.stringify(raw.overlapWarnings), 'utf8')
      assert.ok(
        bytes <= MAX_OVERLAP_BYTES,
        `overlapWarnings 必须受 ${MAX_OVERLAP_BYTES} 字节约束，实际 ${bytes}`,
      )
      assert.equal(raw.overlapTruncated, true, '必须标注 overlap 被截断')
      assert.equal(
        raw.overlapTotal,
        others.length * files.length,
        '必须记录截断前的原始文件总数',
      )

      const size = (await stat(join(root, RUNS_RELATIVE_DIR, `${id}.json`))).size
      assert.ok(size <= MAX_FILE_BYTES, `${id} 记录体积必须可读，实际 ${size}`)
    }

    // 读取侧（get_task / list_runs）也不能返回超限的 overlap
    const [listed] = await store.listRuns({ limit: 1 })
    assert.ok(
      Buffer.byteLength(JSON.stringify(listed.overlapWarnings), 'utf8') <= MAX_OVERLAP_BYTES,
    )
    assert.equal(listed.overlapTruncated, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('体积闸兜底：超限时同时裁剪 changedFiles 与 overlapWarnings，记录仍可读（F4）', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root })
    const shared = Array.from({ length: MAX_OVERLAP_FILES }, (_, i) => `shared-${i}.txt`)
    // 先写一条真实存在交集的小记录，保证 huge-run 真的会算出 overlapWarnings
    await store.writeRun({
      childId: 'other',
      status: 'completed',
      worktree: {
        path: '/tmp/other',
        baseSha: 'base',
        branch: 'meetingstone/other',
        operationId: 'other',
      },
      changedFiles: shared,
    })
    const files = [...shared, ...Array.from({ length: 5000 }, (_, i) => `${'q'.repeat(500)}-${i}`)]
    // 用超长 worktree.path 把记录推过 MAX_FILE_BYTES（normalize 不裁剪 path）
    await store.writeRun({
      childId: 'huge-run',
      status: 'completed',
      result: 'x'.repeat(MAX_RESULT_BYTES),
      worktree: {
        path: `/tmp/${'p'.repeat(700 * 1024)}`,
        baseSha: 'base',
        branch: 'meetingstone/huge',
        operationId: 'huge',
      },
      changedFiles: files,
      overlapWarnings: [{ childId: 'other', files: shared }],
    })

    const record = await store.loadRun('huge-run')
    assert.deepEqual(record.changedFiles, [], '体积闸必须裁剪 changedFiles')
    assert.equal(record.changedFilesTruncated, true)
    assert.deepEqual(record.overlapWarnings, [], '体积闸必须同时裁剪 overlapWarnings')
    assert.equal(record.overlapTruncated, true)
    assert.equal(record.overlapTotal, shared.length, '必须保留截断前的原始总数')
    assert.equal(record.worktree.branch, 'meetingstone/huge', 'worktree 元数据必须保住')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('回写 overlap 不丢旧记录的 changedFilesTotal（截断记录被重写时）', async () => {
  const root = await tempRoot()
  try {
    const store = createRunStore({ root })
    const files = Array.from({ length: MAX_CHANGED_FILES + 1000 }, (_, i) => `f-${i}.txt`)
    const worktree = (id) => ({
      path: `/tmp/${id}`,
      baseSha: 'base',
      branch: `meetingstone/${id}`,
      operationId: id,
    })
    await store.writeRun({
      childId: 'old',
      status: 'completed',
      worktree: worktree('old'),
      changedFiles: files,
    })
    const before = JSON.parse(
      await readFile(join(root, RUNS_RELATIVE_DIR, 'old.json'), 'utf8'),
    )
    assert.equal(before.changedFilesTotal, files.length)
    assert.equal(before.changedFiles.length, MAX_CHANGED_FILES)

    // 新记录与 old 有交集 → 触发 old 的 overlap 回写（old 会被 normalize 重写一次）
    await store.writeRun({
      childId: 'new',
      status: 'completed',
      worktree: worktree('new'),
      changedFiles: files.slice(0, 3),
    })
    const after = JSON.parse(
      await readFile(join(root, RUNS_RELATIVE_DIR, 'old.json'), 'utf8'),
    )
    assert.equal(
      after.changedFilesTotal,
      files.length,
      '回写不得把原始总数从 6000 降成 5000',
    )
    assert.equal(after.changedFiles.length, MAX_CHANGED_FILES)
    assert.ok(after.overlapWarnings.some((w) => w.childId === 'new'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
