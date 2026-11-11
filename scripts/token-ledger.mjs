#!/usr/bin/env node
// @ts-check
/**
 * MeetingStone 效率账本（runs 维度）。
 *
 * 只读扫描 `.meetingstone/runs/*.json`，输出可复现的派单统计：
 * 任务数、结果分布、失败分类、resultBytes 分位、耗时、按角色/通道聚合。
 *
 * 口径声明：
 * - **字节 ≠ Token**。本脚本不估算 Token，不输出 approxTokens。
 * - runs 记录里没有 Provider Usage 字段；Provider Usage 一律标「未知」。
 * - 失败分类是从 stopReason / diagnostic / error / resultStatus 推导的启发式分类，
 *   不是宿主提供的专用字段。
 *
 * 零依赖：仅 Node 内置模块，Node 20+。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

export const LEDGER_SCHEMA_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000

/** 用法错误：退出码 2，不打印堆栈。 */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 定位 runs 目录。
 * 优先 `<cwd>/.meetingstone/runs`；若当前目录是 git worktree（`.git` 是文件），
 * 回退到主仓库的 `.meetingstone/runs`，这样在隔离工作树里也能直接跑。
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveRunsDir(cwd = process.cwd()) {
  const direct = join(cwd, '.meetingstone', 'runs')
  if (isDirectory(direct)) return direct

  const gitPath = join(cwd, '.git')
  try {
    if (existsSync(gitPath)) {
      const content = readFileSync(gitPath, 'utf8')
      const match = /^gitdir:\s*(.+)$/m.exec(content)
      if (match) {
        // <repo>/.git/worktrees/<id> -> <repo>/.git -> <repo>
        const gitDir = resolve(cwd, match[1].trim())
        const commonDir = resolve(gitDir, '..', '..')
        const repoRoot = dirname(commonDir)
        const candidate = join(repoRoot, '.meetingstone', 'runs')
        if (isDirectory(candidate)) return candidate
      }
    }
  } catch {
    // `.git` 不是可读文件（普通目录或权限不足）：保持 direct，由调用方报错。
  }
  return direct
}

/**
 * 读取 runs 目录。坏 JSON / 非 run 记录跳过并计数，不中断整份统计。
 *
 * @param {string} dir
 * @returns {{ records: any[], files: number, invalid: { file: string, reason: string }[] }}
 */
export function loadRuns(dir) {
  if (!isDirectory(dir)) {
    throw new UsageError(`runs 目录不存在或不可读: ${dir}`)
  }
  /** @type {{ records: any[], files: number, invalid: { file: string, reason: string }[] }} */
  const result = { records: [], files: 0, invalid: [] }
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()

  for (const name of names) {
    result.files += 1
    const full = join(dir, name)
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8'))
      // 只认真正的 run 记录，避免把同目录下的其他 JSON 产物当成任务。
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        result.invalid.push({ file: name, reason: '不是 JSON 对象' })
        continue
      }
      if (typeof parsed.childId !== 'string' || !parsed.childId) {
        result.invalid.push({ file: name, reason: '缺少 childId，不是 run 记录' })
        continue
      }
      result.records.push({ ...parsed, __file: name })
    } catch (error) {
      result.invalid.push({ file: name, reason: /** @type {Error} */ (error).message })
    }
  }
  return result
}

/**
 * 解析 `--since`：`7d` / `24h` / `30m`、`YYYY-MM-DD`（UTC 零点）、ISO 时间或毫秒时间戳。
 *
 * @param {string} value
 * @param {number} [now]
 * @returns {number}
 */
export function parseSince(value, now = Date.now()) {
  const raw = String(value).trim()
  if (!raw) throw new UsageError('--since 不能为空')

  const relative = /^(\d+)([mhd])$/.exec(raw)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2] === 'm' ? 60 * 1000 : relative[2] === 'h' ? 60 * 60 * 1000 : DAY_MS
    return now - amount * unit
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ms = Date.parse(`${raw}T00:00:00.000Z`)
    if (Number.isNaN(ms)) throw new UsageError(`无法解析 --since: ${value}`)
    return ms
  }

  if (/^\d+$/.test(raw)) {
    const ms = Number(raw)
    if (ms < 1e12) throw new UsageError('纯数字 --since 需为毫秒时间戳（例如 1794377274308）')
    return ms
  }

  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) throw new UsageError(`无法解析 --since: ${value}（支持 7d/24h/30m、YYYY-MM-DD、ISO、毫秒时间戳）`)
  return ms
}

/**
 * 过滤 + 排序（新的在前）+ limit。
 *
 * @param {any[]} records
 * @param {{ since?: number | null, limit?: number | null }} [options]
 * @returns {any[]}
 */
export function filterRuns(records, options = {}) {
  const since = isFiniteNumber(options.since) ? options.since : null
  const limit = isFiniteNumber(options.limit) ? Math.max(1, Math.floor(options.limit)) : null

  const filtered = records.filter((record) => {
    if (since === null) return true
    // 没有 createdAt 的记录无法证明落在窗口内，--since 下排除。
    return isFiniteNumber(record.createdAt) && record.createdAt >= since
  })

  filtered.sort((a, b) => {
    const at = isFiniteNumber(a.createdAt) ? a.createdAt : -Infinity
    const bt = isFiniteNumber(b.createdAt) ? b.createdAt : -Infinity
    if (bt !== at) return bt - at
    return String(a.__file ?? '').localeCompare(String(b.__file ?? ''))
  })

  return limit === null ? filtered : filtered.slice(0, limit)
}

/**
 * 线性插值分位（R-7）。空数组返回 null。
 *
 * @param {number[]} values
 * @param {number} p 0–100
 * @returns {number | null}
 */
export function percentile(values, p) {
  const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

/** @param {any} record */
export function durationMs(record) {
  if (!isFiniteNumber(record.createdAt) || !isFiniteNumber(record.finishedAt)) return null
  if (record.finishedAt < record.createdAt) return null
  return record.finishedAt - record.createdAt
}

const SUCCESS_STOP_REASONS = new Set(['', 'completed'])
const FAILED_RESULT_STATUSES = new Set(['failed', 'blocked'])

/**
 * 归并后的结果分类。宿主终态 `completed` 但 stopReason 为 refusal/error 的记录
 * 计入 failed，避免「完成了但没干活」被算成成功。
 *
 * @param {any} record
 * @returns {'success' | 'failed' | 'cancelled' | 'interrupted' | 'running' | 'unknown'}
 */
export function outcomeOf(record) {
  const status = record.status
  const stopReason = typeof record.stopReason === 'string' ? record.stopReason : null
  const resultStatus = typeof record.resultStatus === 'string' ? record.resultStatus : null

  if (status === 'cancelled' || stopReason === 'cancelled') return 'cancelled'
  if (status === 'running') return 'running'
  if (status === 'interrupted' || stopReason === 'plugin-disposed' || stopReason === 'interrupted') {
    return 'interrupted'
  }
  if (status === 'failed' || FAILED_RESULT_STATUSES.has(resultStatus ?? '')) return 'failed'
  if (status === 'completed') {
    if (stopReason !== null && !SUCCESS_STOP_REASONS.has(stopReason)) return 'failed'
    return 'success'
  }
  return 'unknown'
}

/**
 * 失败分类：按 stopReason / diagnostic / error / resultStatus 的文本信号归入
 * 文档表格 9 的类别。无信号时为 `unspecified`，不猜具体原因。
 *
 * @param {any} record
 * @returns {string | null} 非 failed 返回 null
 */
export function classifyFailure(record) {
  if (outcomeOf(record) !== 'failed') return null
  const parts = [
    record.stopReason,
    record.resultStatus,
    record.diagnostic,
    record.error?.code,
    record.error?.name,
    record.error?.message,
    typeof record.error === 'string' ? record.error : null,
  ].filter((value) => typeof value === 'string' && value)
  const signal = parts.join(' ').toLowerCase()

  // stopReason=refusal 是宿主的确定信号；诊断里「可能是 429」只是提示，
  // 不据此升级为 rate-limit（不把猜测当结论）。
  if (/refus|拒答|拒绝执行/.test(signal)) return 'refusal'
  if (/429|rate[\s_-]?limit|too many requests|quota|限流|配额/.test(signal)) return 'rate-limit'
  if (/timeout|timed out|etimedout|deadline|超时/.test(signal)) return 'timeout'
  if (/auth|unauthor|invalid api key|401|403|forbidden|permission|认证|权限/.test(signal)) {
    return 'auth-or-permission'
  }
  if (/cancel|取消/.test(signal)) return 'cancelled'
  if (/dispose|interrupt|中断/.test(signal)) return 'interrupted'
  if (/error|fail|失败|异常/.test(signal)) return 'error'
  return 'unspecified'
}

/** 计数并按次数降序。 */
function countBy(values) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }))
}

/**
 * 单组核心统计（总量 / 分布 / 耗时 / 结果字节）。
 *
 * @param {any[]} records
 */
function coreStats(records) {
  const outcomes = { success: 0, failed: 0, cancelled: 0, interrupted: 0, running: 0, unknown: 0 }
  /** @type {string[]} */
  const failureClasses = []
  /** @type {number[]} */
  const durations = []
  /** @type {number[]} */
  const successBytes = []
  /** @type {number[]} */
  const changedFileCounts = []
  let changedFilesUnknown = 0
  let changedFilesRecords = 0

  for (const record of records) {
    outcomes[outcomeOf(record)] += 1
    const failureClass = classifyFailure(record)
    if (failureClass) failureClasses.push(failureClass)

    const duration = durationMs(record)
    if (duration !== null) durations.push(duration)

    if (outcomeOf(record) === 'success' && isFiniteNumber(record.resultBytes)) {
      successBytes.push(record.resultBytes)
    }

    if (Array.isArray(record.changedFiles)) {
      changedFilesRecords += 1
      changedFileCounts.push(record.changedFiles.length)
    } else if (record.changedFilesUnknown === true) {
      // 明确标记无法判断的记录单独计数，不当作 0 个改动。
      changedFilesUnknown += 1
    }
  }

  const avgDuration = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : null
  const byteP50 = percentile(successBytes, 50)
  const byteP90 = percentile(successBytes, 90)
  const byteMax = successBytes.length ? Math.max(...successBytes) : null

  return {
    total: records.length,
    outcomes,
    failureClasses: countBy(failureClasses),
    duration: {
      sampleCount: durations.length,
      avgMs: avgDuration,
      p50Ms: percentile(durations, 50),
      p90Ms: percentile(durations, 90),
      maxMs: durations.length ? Math.max(...durations) : null,
    },
    resultBytes: {
      sampleCount: successBytes.length,
      p50: byteP50 === null ? null : Math.round(byteP50),
      p90: byteP90 === null ? null : Math.round(byteP90),
      max: byteMax,
      mean: successBytes.length
        ? Math.round(successBytes.reduce((sum, value) => sum + value, 0) / successBytes.length)
        : null,
      total: successBytes.length ? successBytes.reduce((sum, value) => sum + value, 0) : null,
    },
    changedFiles: {
      knownRecords: changedFilesRecords,
      unknownRecords: changedFilesUnknown,
      files: changedFileCounts.reduce((sum, value) => sum + value, 0),
      maxPerRecord: changedFileCounts.length ? Math.max(...changedFileCounts) : null,
    },
  }
}

/**
 * 按角色 / 通道分组。空值归入 `(unknown)`。
 *
 * @param {any[]} records
 * @param {(record: any) => unknown} selector
 */
function groupStats(records, selector) {
  /** @type {Map<string, any[]>} */
  const groups = new Map()
  for (const record of records) {
    const raw = selector(record)
    const key = typeof raw === 'string' && raw ? raw : '(unknown)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  return [...groups.entries()]
    .map(([name, groupRecords]) => ({ name, ...coreStats(groupRecords) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

/**
 * 生成账本报告对象。
 *
 * @param {any[]} records 已过滤的样本
 * @param {{ runsDir: string, files: number, invalid: { file: string, reason: string }[], filters: { since: number | null, limit: number | null } }} meta
 */
export function buildReport(records, meta) {
  const core = coreStats(records)
  const createdTimes = records.map((record) => record.createdAt).filter(isFiniteNumber)
  const failureTotal = core.failureClasses.reduce((sum, item) => sum + item.count, 0)

  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      runsDir: meta.runsDir,
      scannedFiles: meta.files,
      invalidFiles: meta.invalid,
      hostUsage: {
        available: false,
        status: 'unknown',
        reason: 'runs 记录不含 Provider Usage；脚本不读取宿主会话/工具调用统计，Token 记未知',
      },
    },
    filters: {
      since: meta.filters.since === null ? null : new Date(meta.filters.since).toISOString(),
      sinceMs: meta.filters.since,
      limit: meta.filters.limit,
    },
    sample: {
      records: records.length,
      timeRange: createdTimes.length
        ? {
            from: new Date(Math.min(...createdTimes)).toISOString(),
            to: new Date(Math.max(...createdTimes)).toISOString(),
          }
        : null,
    },
    caveats: {
      bytesAreNotTokens: true,
      providerUsage: 'unknown',
      tokenEstimate: 'not-calculated',
      failureClasses: 'derived from stopReason/diagnostic/error/resultStatus (heuristic)',
      resultBytes: 'status=completed 且 outcome=success 的记录（含 0 字节）',
      duration: '有 createdAt 与 finishedAt 的终态记录',
    },
    outcomes: core.outcomes,
    total: core.total,
    statusDistribution: countBy(records.map((record) => (typeof record.status === 'string' ? record.status : 'unknown'))),
    stopReasonDistribution: countBy(
      records.map((record) =>
        typeof record.stopReason === 'string' && record.stopReason ? record.stopReason : '(none)',
      ),
    ),
    failureClasses: {
      total: failureTotal,
      byClass: core.failureClasses,
      unspecified: core.failureClasses.find((item) => item.name === 'unspecified')?.count ?? 0,
    },
    duration: core.duration,
    resultBytes: core.resultBytes,
    changedFiles: core.changedFiles,
    byRole: groupStats(records, (record) => record.role),
    byChannel: groupStats(records, (record) => record.channel),
  }
}

/** 终端显示宽度（CJK 宽字符按 2 列）。 */
function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(
      char,
    )
      ? 2
      : 1
  }
  return width
}

/** @param {string[]} headers @param {string[][]} rows */
function formatTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  )
  const renderRow = (cells) =>
    cells
      .map((cell, index) => String(cell) + ' '.repeat(Math.max(0, widths[index] - displayWidth(cell))))
      .join('  ')
      .trimEnd()
  return [renderRow(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(renderRow)]
}

function formatBytes(value) {
  if (!isFiniteNumber(value)) return '—'
  if (Math.abs(value) < 1024) return `${value} B`
  if (Math.abs(value) < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function formatDuration(value) {
  if (!isFiniteNumber(value)) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60 * 1000) return `${(value / 1000).toFixed(1)}s`
  if (value < 60 * 60 * 1000) return `${(value / 60000).toFixed(1)}min`
  return `${(value / 3600000).toFixed(2)}h`
}

function formatClassList(items) {
  if (items.length === 0) return '无'
  return items.map((item) => `${item.name} ${item.count}`).join('，')
}

/**
 * 人类可读表格。
 *
 * @param {ReturnType<typeof buildReport>} report
 */
export function renderTable(report) {
  const lines = []
  lines.push('MeetingStone 效率账本（runs 维度）')
  lines.push(`数据源: ${report.source.runsDir}`)
  const invalidNote = report.source.invalidFiles.length
    ? `，跳过坏/非 run JSON ${report.source.invalidFiles.length} 个`
    : ''
  lines.push(
    `样本: ${report.sample.records} 条${invalidNote}` +
      (report.sample.timeRange
        ? `；时间: ${report.sample.timeRange.from} ~ ${report.sample.timeRange.to}`
        : ''),
  )
  if (report.filters.since !== null || report.filters.limit !== null) {
    lines.push(
      `筛选: since=${report.filters.since ?? '不限'}，limit=${report.filters.limit ?? '不限'}`,
    )
  }
  lines.push('口径: 字节 ≠ Token；Provider Usage: 未知（不估算、不以字节冒充 Token）')
  lines.push('')

  const { outcomes } = report
  lines.push('总体')
  lines.push(
    `  任务 ${report.total} | 成功 ${outcomes.success} | 失败 ${outcomes.failed} | 取消 ${outcomes.cancelled} | 中断 ${outcomes.interrupted} | 运行中 ${outcomes.running} | 未知 ${outcomes.unknown}`,
  )
  lines.push(
    `  平均耗时 ${formatDuration(report.duration.avgMs)}（n=${report.duration.sampleCount}）` +
      ` | 结果字节 p50 ${formatBytes(report.resultBytes.p50)} / p90 ${formatBytes(report.resultBytes.p90)} / max ${formatBytes(report.resultBytes.max)}（n=${report.resultBytes.sampleCount}）`,
  )
  lines.push(
    `  改动文件: 已知 ${report.changedFiles.knownRecords} 条 / 合计 ${report.changedFiles.files} 个 / 单任务最多 ${report.changedFiles.maxPerRecord ?? '—'}` +
      (report.changedFiles.unknownRecords ? `；标记 unknown ${report.changedFiles.unknownRecords} 条` : ''),
  )
  lines.push('')

  lines.push('失败分类（启发式，来源 stopReason/diagnostic/error/resultStatus）')
  lines.push(`  ${formatClassList(report.failureClasses.byClass)}`)
  lines.push('')

  lines.push('状态分布（原始 status，未归并）')
  lines.push(
    `  ${report.statusDistribution.map((item) => `${item.name} ${item.count}`).join('，') || '无'}`,
  )
  lines.push('')

  const groupRows = (groups, label) => {
    const rows = groups.map((group) => [
      group.name,
      String(group.total),
      String(group.outcomes.success),
      String(group.outcomes.failed),
      String(group.outcomes.cancelled),
      String(group.outcomes.interrupted),
      String(group.outcomes.running),
      formatDuration(group.duration.avgMs),
      formatBytes(group.resultBytes.p50),
    ])
    return formatTable(
      [label, '任务', '成功', '失败', '取消', '中断', '运行', '平均耗时', '结果p50'],
      rows,
    )
  }

  lines.push('按角色')
  lines.push(...groupRows(report.byRole, '角色'))
  lines.push('')
  lines.push('按通道')
  lines.push(...groupRows(report.byChannel, '通道'))
  lines.push('')
  lines.push('说明: 成功=status completed 且 stopReason completed/null 且 resultStatus 非 failed/blocked；')
  lines.push('      completed 但 stopReason=refusal/error 的记录计入失败。')
  lines.push('      resultBytes 只统计成功记录（含 0 字节）；失败/取消/中断/运行中不计入。')

  return lines.join('\n')
}

const HELP = `用法: node scripts/token-ledger.mjs [选项]

选项:
  --dir <path>       runs 目录（默认自动定位 .meetingstone/runs；worktree 会回退主仓库）
  --since <value>    只统计 createdAt >= 该时间；支持 7d / 24h / 30m、YYYY-MM-DD(UTC)、ISO、毫秒时间戳
  --limit <n>        只统计最近 n 条（按 createdAt 降序）
  --json             输出机器可读 JSON
  --help             显示本帮助

口径:
  字节 ≠ Token；Provider Usage 不可得时标「未知」，不做估算。
  失败分类为启发式（stopReason/diagnostic/error/resultStatus），不是宿主专用字段。
`

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ dir: string | null, since: string | null, limit: number | null, json: boolean, help: boolean }} */
  const options = { dir: null, since: null, limit: null, json: false, help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const [flag, inlineValue] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null]
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} 需要一个值`)
      index += 1
      return next
    }

    switch (flag) {
      case '--dir':
        options.dir = takeValue()
        break
      case '--since':
        options.since = takeValue()
        break
      case '--limit': {
        const raw = takeValue()
        if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new UsageError('--limit 需为正整数')
        options.limit = Number(raw)
        break
      }
      case '--json':
        if (inlineValue !== null) throw new UsageError('--json 不接受值')
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new UsageError(`未知参数: ${arg}`)
    }
  }
  return options
}

/**
 * @param {string[]} [argv]
 * @returns {{ text: string, exitCode: number }}
 */
export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) return { text: HELP, exitCode: 0 }

  const runsDir = options.dir ? resolve(options.dir) : resolveRunsDir()
  const loaded = loadRuns(runsDir)
  const since = options.since === null ? null : parseSince(options.since)
  const records = filterRuns(loaded.records, { since, limit: options.limit })
  const report = buildReport(records, {
    runsDir,
    files: loaded.files,
    invalid: loaded.invalid,
    filters: { since, limit: options.limit },
  })

  return { text: options.json ? JSON.stringify(report, null, 2) : renderTable(report), exitCode: 0 }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()

if (invokedDirectly) {
  try {
    const { text, exitCode } = runCli()
    process.stdout.write(`${text}\n`)
    process.exitCode = exitCode
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误: ${error.message}\n\n${HELP}`)
      process.exitCode = 2
    } else {
      process.stderr.write(`未预期错误: ${/** @type {Error} */ (error).stack ?? error}\n`)
      process.exitCode = 1
    }
  }
}
