// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRunStore,
  truncateUtf8,
  RunStoreError,
  MAX_RESULT_BYTES,
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
