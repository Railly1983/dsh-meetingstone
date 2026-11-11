// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReport,
  classifyFailure,
  filterRuns,
  loadRuns,
  outcomeOf,
  parseSince,
  percentile,
  runCli,
} from '../scripts/token-ledger.mjs'

const SCRIPT = join(process.cwd(), 'scripts', 'token-ledger.mjs')
const BASE = 1_700_000_000_000

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'mt-ledger-'))
}

function record(overrides = {}) {
  return {
    childId: `child-${Math.random().toString(16).slice(2)}`,
    status: 'completed',
    stopReason: 'completed',
    resultStatus: null,
    createdAt: BASE,
    finishedAt: BASE + 1000,
    resultBytes: 100,
    role: 'role-sashi',
    channel: 'acp-cli',
    changedFiles: [],
    changedFilesUnknown: false,
    ...overrides,
  }
}

test('percentile：线性插值 p50/p90/max，空集返回 null', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([7], 90), 7)
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5)
  assert.equal(percentile([1, 2, 3, 4], 90), 3.7)
  assert.equal(percentile([4, 1, 3, 2], 100), 4)
  assert.equal(percentile([1, 2, 3, 4], 0), 1)
})

test('filterRuns：--since 按 createdAt 过滤，--limit 取最近 N 条', () => {
  const records = [
    record({ createdAt: 1000 }),
    record({ createdAt: 2000 }),
    record({ createdAt: 3000 }),
    record({ createdAt: 4000 }),
    record({ createdAt: undefined }),
  ]
  assert.equal(filterRuns(records, { since: 2500 }).length, 2)
  assert.deepEqual(
    filterRuns(records, { since: 2500 }).map((item) => item.createdAt),
    [4000, 3000],
  )
  assert.deepEqual(
    filterRuns(records, { limit: 2 }).map((item) => item.createdAt),
    [4000, 3000],
  )
  // since 下没有 createdAt 的记录无法证明落在窗口内，应排除
  assert.equal(filterRuns(records, { since: 0 }).length, 4)
  assert.equal(filterRuns(records, {}).length, 5)
})

test('parseSince：相对时间 / UTC 日期 / ISO / 毫秒时间戳', () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0)
  assert.equal(parseSince('1d', now), now - 24 * 60 * 60 * 1000)
  assert.equal(parseSince('2h', now), now - 2 * 60 * 60 * 1000)
  assert.equal(parseSince('30m', now), now - 30 * 60 * 1000)
  assert.equal(parseSince('2026-11-11', now), Date.UTC(2026, 10, 11))
  assert.equal(parseSince('2026-11-11T00:00:00.000Z', now), Date.UTC(2026, 10, 11))
  assert.equal(parseSince(String(BASE), now), BASE)
  assert.throws(() => parseSince('yesterday', now), /无法解析/)
  assert.throws(() => parseSince('123', now), /毫秒时间戳/)
})

test('loadRuns：坏 JSON / 非 run JSON 跳过并计数', async () => {
  const dir = await tempDir()
  try {
    await writeFile(join(dir, 'a.json'), JSON.stringify(record({ childId: 'ok-1' })))
    await writeFile(join(dir, 'broken.json'), '{"childId":')
    await writeFile(join(dir, 'not-run.json'), JSON.stringify({ hello: 'world' }))
    await writeFile(join(dir, 'ignored.txt'), 'not json')

    const loaded = loadRuns(dir)
    assert.equal(loaded.files, 3)
    assert.equal(loaded.records.length, 1)
    assert.equal(loaded.records[0].childId, 'ok-1')
    assert.equal(loaded.invalid.length, 2)
    assert.deepEqual(
      loaded.invalid.map((item) => item.file).sort(),
      ['broken.json', 'not-run.json'],
    )
    assert.match(loaded.invalid.find((item) => item.file === 'not-run.json')?.reason ?? '', /childId/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('outcome / classifyFailure：completed+refusal 归为失败，429 优先于 refusal', () => {
  assert.equal(outcomeOf(record()), 'success')
  assert.equal(outcomeOf(record({ stopReason: 'refusal', resultBytes: 0 })), 'failed')
  assert.equal(outcomeOf(record({ status: 'failed', stopReason: 'error' })), 'failed')
  assert.equal(outcomeOf(record({ status: 'cancelled', stopReason: null })), 'cancelled')
  assert.equal(outcomeOf(record({ status: 'running', finishedAt: null })), 'running')
  assert.equal(outcomeOf(record({ status: 'interrupted', stopReason: 'plugin-disposed' })), 'interrupted')
  assert.equal(outcomeOf(record({ status: 'completed', resultStatus: 'failed' })), 'failed')
  assert.equal(outcomeOf(record({ status: 'completed', resultStatus: 'partial' })), 'success')

  assert.equal(classifyFailure(record()), null)
  // stopReason=refusal 优先；诊断里的「可能 429」不升级为 rate-limit
  assert.equal(classifyFailure(record({ stopReason: 'refusal', diagnostic: '可能 429' })), 'refusal')
  assert.equal(
    classifyFailure(record({ status: 'failed', stopReason: 'error', diagnostic: '429 Too Many Requests' })),
    'rate-limit',
  )
  assert.equal(classifyFailure(record({ stopReason: 'refusal' })), 'refusal')
  assert.equal(classifyFailure(record({ status: 'failed', stopReason: 'error', diagnostic: 'timed out' })), 'timeout')
  assert.equal(classifyFailure(record({ status: 'failed', stopReason: 'error' })), 'error')
  assert.equal(classifyFailure(record({ status: 'failed', stopReason: null })), 'unspecified')
})

test('buildReport：结果字节只统计成功记录，并按角色/通道聚合', () => {
  const records = [
    record({ role: 'role-sashi', channel: 'acp-cli', resultBytes: 100 }),
    record({ role: 'role-sashi', channel: 'acp-cli', stopReason: 'refusal', resultBytes: 0, diagnostic: '429' }),
    record({ role: 'role-wukong', channel: 'codex', status: 'failed', stopReason: 'error', resultBytes: 500 }),
    record({ role: 'role-wukong', channel: 'codex', resultBytes: 300 }),
  ]
  const report = buildReport(records, {
    runsDir: '/tmp/runs',
    files: records.length,
    invalid: [],
    filters: { since: null, limit: null },
  })
  assert.equal(report.total, 4)
  assert.deepEqual(report.outcomes, {
    success: 2,
    failed: 2,
    cancelled: 0,
    interrupted: 0,
    running: 0,
    unknown: 0,
  })
  assert.equal(report.resultBytes.sampleCount, 2)
  assert.equal(report.resultBytes.p50, 200)
  assert.equal(report.resultBytes.max, 300)
  assert.equal(report.failureClasses.total, 2)
  assert.deepEqual(
    report.failureClasses.byClass.map((item) => item.name).sort(),
    ['error', 'refusal'],
  )
  assert.equal(report.byRole.length, 2)
  assert.equal(report.byRole[0].name, 'role-sashi')
  assert.equal(report.byRole[0].total, 2)
  assert.equal(report.source.hostUsage.status, 'unknown')
  assert.equal(report.caveats.bytesAreNotTokens, true)
})

test('CLI --json：空目录输出零样本且退出码 0', async () => {
  const dir = await tempDir()
  try {
    const result = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--json'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.total, 0)
    assert.equal(report.sample.records, 0)
    assert.equal(report.resultBytes.p50, null)
    assert.equal(report.duration.avgMs, null)
    assert.deepEqual(report.byRole, [])
    assert.equal(report.source.hostUsage.status, 'unknown')
    assert.equal(report.caveats.tokenEstimate, 'not-calculated')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CLI 表格 + 过滤：样本数随 --since/--limit 变化', async () => {
  const dir = await tempDir()
  try {
    await writeFile(
      join(dir, 'a.json'),
      JSON.stringify(
        record({
          childId: 'a',
          createdAt: BASE - 3000,
          finishedAt: BASE - 2000,
          resultBytes: 1000,
        }),
      ),
    )
    await writeFile(
      join(dir, 'b.json'),
      JSON.stringify(
        record({
          childId: 'b',
          createdAt: BASE - 2000,
          finishedAt: BASE - 1000,
          stopReason: 'refusal',
          diagnostic: '429 rate limit',
          resultBytes: 0,
        }),
      ),
    )
    await writeFile(
      join(dir, 'c.json'),
      JSON.stringify(
        record({
          childId: 'c',
          createdAt: BASE - 1000,
          finishedAt: BASE,
          resultBytes: 3000,
        }),
      ),
    )

    const table = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' })
    assert.equal(table.status, 0, table.stderr)
    assert.match(table.stdout, /任务 3 \| 成功 2 \| 失败 1/)
    assert.match(table.stdout, /字节 ≠ Token/)
    assert.match(table.stdout, /refusal 1/)
    // 表格可读，且不出现估算 Token 冒充
    assert.doesNotMatch(table.stdout, /approxTokens|估算 Token/i)

    const filtered = spawnSync(
      process.execPath,
      [SCRIPT, '--dir', dir, '--limit', '2', '--since', new Date(BASE - 2500).toISOString(), '--json'],
      { encoding: 'utf8' },
    )
    assert.equal(filtered.status, 0, filtered.stderr)
    const report = JSON.parse(filtered.stdout)
    assert.equal(report.total, 2)
    assert.deepEqual(
      report.sample.timeRange,
      { from: new Date(BASE - 2000).toISOString(), to: new Date(BASE - 1000).toISOString() },
    )
    assert.equal(report.filters.limit, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCli：帮助文本包含口径声明，未知参数退出码 2', () => {
  const help = runCli(['--help'])
  assert.equal(help.exitCode, 0)
  assert.match(help.text, /字节 ≠ Token/)
  assert.match(help.text, /Provider Usage 不可得时标「未知」/)

  assert.throws(() => runCli(['--nope']), /未知参数/)
  assert.throws(() => runCli(['--limit', '0']), /正整数/)
})
