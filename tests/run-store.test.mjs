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

      // 后写的记录必须把重叠写进原始 JSON；先写的记录字段存在（当时对方还不存在，允许为空）
      const rawFirst = JSON.parse(await readFile(join(root, RUNS_RELATIVE_DIR, `${first}.json`), 'utf8'))
      const rawSecond = JSON.parse(await readFile(join(root, RUNS_RELATIVE_DIR, `${second}.json`), 'utf8'))
      assert.ok(Array.isArray(rawFirst.overlapWarnings), `${first} 磁盘记录必须含 overlapWarnings 字段`)
      assert.deepEqual(rawFirst.overlapWarnings, [], '先写入时对方尚不存在，交集为空')
      const warning = rawSecond.overlapWarnings.find((w) => w.childId === first)
      assert.ok(warning, `${second} 的原始 JSON 必须记录与 ${first} 的重叠：${JSON.stringify(rawSecond.overlapWarnings)}`)
      assert.deepEqual(warning.files.slice().sort(), shared.slice().sort(), '换行/制表符文件名必须原样往来')

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
