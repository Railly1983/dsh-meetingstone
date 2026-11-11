// @ts-check
/**
 * 派单结果落盘（P0）。
 *
 * 为什么需要：`get_task` 原来只在内存保留最近 20 条，DSH 一重启就查不到。
 * 但结果必须能被"上下文重放"（P1）和跨重启查询复用，所以终态要写进项目目录。
 *
 * 设计取舍：
 * - 一个任务一个 JSON 文件，文件名 = childId；读取按 ID 直取，不做索引（数据量小）
 * - **原子写**：先写 `.tmp` 再 rename，避免半截文件
 * - **写盘失败不篡改真实结果**：调用方拿到的仍是真实终态，另附 `persistenceWarning`
 * - 默认不保存任务全文、人设、命令行、环境变量（隐私最小化）
 * - `.meetingstone/` 由使用方加进 .gitignore（本模块不碰 git）
 *
 * 明文提示：文件是本机明文，输出可能包含源码片段。不要在文档里承诺"机密安全"。
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyFailure, hintForFailure, isFailureClass } from './dispatch/failure.js'
import { summarizeContextPack, summarizeTaskSpec } from './taskspec.js'

/** 相对项目根的默认目录。 */
export const RUNS_RELATIVE_DIR = '.meetingstone/runs'
/** 单条结果上限（UTF-8 字节）。 */
export const MAX_RESULT_BYTES = 256 * 1024
/** 单条错误信息上限。 */
export const MAX_ERROR_BYTES = 16 * 1024
/** 失败分类建议（hint）的落盘上限；一句话建议，正常远小于此值。 */
export const MAX_HINT_BYTES = 1024
/**
 * 单条记录里 `changedFiles` 的条数上限。
 * 为什么要设：大型仓库一次改动上万文件时，记录能涨到 1.5MB+，读取侧拒绝后
 * 清理器又会把它当"未保护"删掉，工作树元数据就丢了（P1）。
 * 超过时保留前 N 条，并记录 `changedFilesTruncated:true` / `changedFilesTotal`。
 */
export const MAX_CHANGED_FILES = 5000
/** changedFiles 的字节预算（按 JSON 转义后大小计，保证整条记录体积可控）。 */
const MAX_CHANGED_FILES_BYTES = 2 * 1024 * 1024
/**
 * `overlapWarnings` 的落盘上限（悟空复核 F4）：
 * - 每对记录最多保留 `MAX_OVERLAP_FILES` 个文件
 * - 整个字段最多 `MAX_OVERLAP_BYTES` 字节（JSON 转义后）
 * 没有上限时，三份记录各注入 5000 条共同路径就能把单条记录撑到 1.4MB/2.8MB，
 * 第三份直接 `RUN_TOO_LARGE`，磁盘遗留 running。
 * 超限时写 `overlapTruncated:true` / `overlapTotal:<原始文件总数>`。
 */
export const MAX_OVERLAP_FILES = 50
export const MAX_OVERLAP_BYTES = 64 * 1024
/** 单条记录最多保留多少对 overlap（字节预算之外的条数兜底）。 */
const MAX_OVERLAP_PAIRS = 50
/** 单次写入最多回写多少条历史记录（并发 overlap 的“有界”回写，F3）。 */
const MAX_OVERLAP_BACKFILL_RECORDS = 20
/** 默认保留条数 / 时长。 */
export const DEFAULT_MAX_RUNS = 100
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/**
 * 结构化结果 summary 的落盘上限（UTF-8 字节）。
 * 目标 300–500 token（≈2–4KiB）；8KiB 留出复杂任务的余量，超出按首尾截断。
 */
export const MAX_SUMMARY_BYTES = 8 * 1024
/** handoff 里单条结论/列表项的上限。 */
export const MAX_HANDOFF_ITEM_CHARS = 500
/** 记录里结构化数组字段的条数上限。 */
export const MAX_RECORD_ITEMS = 50
/** 记录里结构化数组单条的上限（字符）。 */
export const MAX_RECORD_ITEM_CHARS = 1000
/** 子 Agent 允许自报的状态闭集（与记录 status 分开）。 */
const RESULT_STATUS_VALUES = ['completed', 'partial', 'blocked', 'failed']
/**
 * 读取时允许的最大文件体积（防止被塞进巨型文件）。
 * 与写入约束对齐：结果 256KB + changedFiles 预算 2MB + 其他字段余量 ≈ 2.75MB。
 * 超过该值的记录读取会失败；清理器对这类记录 **fail-safe 保护**，不因读不了而删。
 */
export const MAX_FILE_BYTES = MAX_RESULT_BYTES + MAX_CHANGED_FILES_BYTES + 512 * 1024
const CHILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * 工作树元数据白名单：只保留契约里的字段，避免把调用方的任意对象写进记录。
 * @param {unknown} value
 * @returns {{ path: string, branch?: string, baseSha?: string, repositoryRoot?: string, operationId?: string } | null}
 */
function normalizeWorktree(value) {
  if (!value || typeof value !== 'object') return null
  const source = /** @type {Record<string, unknown>} */ (value)
  if (typeof source.path !== 'string' || !source.path) return null
  /** @type {{ path: string, branch?: string, baseSha?: string, repositoryRoot?: string, operationId?: string }} */
  const out = { path: source.path }
  for (const key of ['branch', 'baseSha', 'repositoryRoot', 'operationId']) {
    if (typeof source[key] === 'string' && source[key]) out[key] = /** @type {string} */ (source[key])
  }
  return out
}

/**
 * 角色路由元数据白名单（P1-B）。
 *
 * 只保留契约字段：`roleId` / `auto` / `reason`。手动指定角色时 `auto:false`，
 * **不落 reason**（避免把"人选的"伪装成"规则选的"）；自动路由的 reason 截断到 2KiB。
 *
 * @param {unknown} value
 * @returns {{ roleId: string, auto: boolean, reason?: string } | null}
 */
function normalizeRouting(value) {
  if (!value || typeof value !== 'object') return null
  const source = /** @type {Record<string, unknown>} */ (value)
  const roleId = typeof source.roleId === 'string' ? source.roleId.trim() : ''
  if (!roleId) return null
  const auto = source.auto === true
  const reason =
    auto && typeof source.reason === 'string' && source.reason.trim()
      ? truncateUtf8(source.reason.trim(), 2 * 1024).text
      : ''
  return { roleId, auto, ...(reason ? { reason } : {}) }
}

/**
 * 两个记录之间的改动文件交集。
 *
 * 规则（与 docs/plan/2026-11-11-parallel-plan.md §4 一致）：
 * - 只比较同项目、带工作树、仍保留在目录里的记录（同目录天然同项目）
 * - `changedFilesUnknown` 的记录不参与比较（无法判断，不能当成空集）
 * - 自己与自己不比
 *
 * @param {any} record
 * @param {any[]} all
 * @returns {Array<{ childId: string, files: string[] }>}
 */
export function overlapWarningsFor(record, all) {
  if (!record || !record.worktree) return []
  if (record.changedFilesUnknown === true) return []
  if (!Array.isArray(record.changedFiles) || record.changedFiles.length === 0) return []
  const mine = new Set(record.changedFiles.filter((/** @type {unknown} */ file) => typeof file === 'string'))
  if (mine.size === 0) return []
  /** @type {Array<{ childId: string, files: string[] }>} */
  const warnings = []
  for (const other of all) {
    if (!other || other === record) continue
    if (String(other.childId) === String(record.childId)) continue
    if (!other.worktree) continue
    if (other.changedFilesUnknown === true) continue
    if (!Array.isArray(other.changedFiles)) continue
    const files = other.changedFiles.filter(
      (/** @type {unknown} */ file) => typeof file === 'string' && mine.has(file),
    )
    if (files.length > 0) {
      warnings.push({ childId: String(other.childId), files: [...new Set(files)].sort() })
    }
  }
  return warnings.sort((a, b) => a.childId.localeCompare(b.childId))
}

/** 任务状态常量（`interrupted` 只出现在读取投影里，不会写回磁盘）。 */
export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
})

/** 带错误码的失败，便于工具层如实返回。 */
export class RunStoreError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message)
    this.name = 'RunStoreError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * 按 UTF-8 字节截断，保留头部与尾部（中间用标记替代）。
 * 为什么留尾部：错误信息和结论常常在末尾，只截头会丢掉最有用的部分。
 *
 * 预算纪律（P0-C 审计 F8）：返回值**绝不超过 maxBytes**（含截断标记），
 * 且头部优先完整保留。小窗口（例如 headBytes=8 / tailBytes=6）放不下完整标记时，
 * 退化成单字符省略号；连省略号都放不下时宁可不写标记，也不能丢头或超预算。
 *
 * @param {unknown} value
 * @param {number} maxBytes
 * @param {{ headBytes?: number, tailBytes?: number }} [options]
 * @returns {{ text: string, bytes: number, truncated: boolean }}
 */
export function truncateUtf8(value, maxBytes, options = {}) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, bytes: buffer.length, truncated: false }

  const headBytes = Math.min(options.headBytes ?? Math.floor(maxBytes * 0.75), maxBytes)
  // 头部优先：先按请求保留完整头部（字符边界对齐），剩余预算再给标记和尾部。
  const head = sliceUtf8(buffer, 0, headBytes)
  let remaining = Math.max(0, maxBytes - Buffer.byteLength(head))
  let marker = `\n…[truncated ${buffer.length - maxBytes} bytes]…\n`
  if (Buffer.byteLength(marker) > remaining) marker = '…'
  if (Buffer.byteLength(marker) > remaining) marker = ''
  const tailBytes = Math.max(0, remaining - Buffer.byteLength(marker))
  const tail = sliceUtf8(buffer, Math.max(0, buffer.length - tailBytes), buffer.length)
  const out = `${head}${marker}${tail}`
  return { text: out, bytes: Buffer.byteLength(out), truncated: true }
}

/**
 * 按字节窗口切 UTF-8，切点落在字符中间时向前/向后找边界，避免产生乱码。
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 */
function sliceUtf8(buffer, start, end) {
  let s = Math.max(0, Math.min(start, buffer.length))
  let e = Math.max(s, Math.min(end, buffer.length))
  // 头部：若 s 落在续字节上则前进到下一个字符起点
  while (s < e && (buffer[s] & 0b1100_0000) === 0b1000_0000) s += 1
  // 尾部：若 e 落在字符中间则回退到该字符起点
  while (e > s && (buffer[e] & 0b1100_0000) === 0b1000_0000) e -= 1
  return buffer.subarray(s, e).toString('utf8')
}

/**
 * 单行文本字段归一化：空值 → null，超长按 UTF-8 首尾截断。
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string | null}
 */
function recordText(value, maxBytes) {
  if (typeof value !== 'string' || !value) return null
  return truncateUtf8(value, maxBytes).text
}

/**
 * 字符串数组归一化（白名单 + 条数/长度上限）。
 * @param {unknown} value
 * @param {number} [maxItems]
 * @returns {string[]}
 */
function recordStringList(value, maxItems = MAX_RECORD_ITEMS) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  for (const item of value) {
    if (out.length >= maxItems) break
    if (typeof item !== 'string' || !item) continue
    // 按码点切，避免把 emoji/汉字切坏
    const chars = Array.from(item)
    out.push(chars.length <= MAX_RECORD_ITEM_CHARS ? item : chars.slice(0, MAX_RECORD_ITEM_CHARS).join(''))
  }
  return out
}

/**
 * evidence：`{ file?, line?, finding? }` 白名单，不落调用方的任意字段。
 * @param {unknown} value
 * @returns {Array<{ file?: string, line?: number, finding?: string }>}
 */
function recordEvidence(value) {
  if (!Array.isArray(value)) return []
  /** @type {Array<{ file?: string, line?: number, finding?: string }>} */
  const out = []
  for (const item of value) {
    if (out.length >= MAX_RECORD_ITEMS) break
    if (!item || typeof item !== 'object') continue
    const source = /** @type {Record<string, unknown>} */ (item)
    /** @type {{ file?: string, line?: number, finding?: string }} */
    const entry = {}
    if (typeof source.file === 'string' && source.file) {
      entry.file = Array.from(source.file).slice(0, 500).join('')
    }
    if (Number.isInteger(source.line)) entry.line = Number(source.line)
    if (typeof source.finding === 'string' && source.finding) {
      entry.finding = Array.from(source.finding)
        .slice(0, MAX_RECORD_ITEM_CHARS)
        .join('')
    }
    if (entry.file || entry.line !== undefined || entry.finding) out.push(entry)
  }
  return out
}

/**
 * handoff：结论 / 证据 / 产物 / 未决 / 下一步（有界）。
 * @param {unknown} value
 * @returns {{ conclusion: string, evidence: Array<object>, artifacts: string[],
 *   openIssues: string[], nextAction: string | null } | null}
 */
function recordHandoff(value) {
  if (!value || typeof value !== 'object') return null
  const source = /** @type {Record<string, unknown>} */ (value)
  const conclusion = recordText(source.conclusion, 2 * 1024)
  const evidence = recordEvidence(source.evidence).slice(0, 10)
  const artifacts = recordStringList(source.artifacts, 10)
  const openIssues = recordStringList(source.openIssues, 10)
  const nextAction = recordText(source.nextAction, 2 * 1024)
  if (!conclusion && evidence.length === 0 && artifacts.length === 0 && openIssues.length === 0 && !nextAction) {
    return null
  }
  return {
    conclusion: conclusion ?? '',
    evidence,
    artifacts,
    openIssues,
    nextAction,
  }
}

/**
 * 原子替换目标文件；Windows 上目标可能正被读取/占用，rename 会偶发 EPERM/EBUSY。
 * 短重试而不是立刻放弃：一次占用不应该让终态退回 running。
 * @param {string} from
 * @param {string} to
 */
async function renameWithRetry(from, to) {
  /** @type {any} */
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = /** @type {any} */ (error)?.code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  throw lastError
}

/**
 * 项目级写锁（按 runs 目录索引，跨 store 实例共享）。
 *
 * F3：并发终态写入必须串行「读现有记录 → 写当前记录 → 回写交集记录」。
 * 否则两个任务都读到对方尚不存在，各自写出的原始 JSON 里 overlapWarnings 都是 []，
 * 只有读取时重算才能看到交集。
 *
 * @type {Map<string, Promise<void>>}
 */
const runWriteLocks = new Map()

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withRunLock(key, task) {
  const previous = runWriteLocks.get(key) ?? Promise.resolve()
  /** @type {() => void} */
  let release = () => {}
  const gate = new Promise((resolveGate) => {
    release = /** @type {() => void} */ (resolveGate)
  })
  const queued = previous.then(() => gate)
  runWriteLocks.set(key, queued)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (runWriteLocks.get(key) === queued) runWriteLocks.delete(key)
  }
}

/**
 * 建一个绑定到某项目根的存储。
 *
 * @param {object} options
 * @param {string} options.root 项目根（绝对路径）
 * @param {string} [options.dir] 相对 root 的目录，默认 `.meetingstone/runs`
 * @param {number} [options.maxRuns]
 * @param {number} [options.maxAgeMs]
 * @param {number} [options.maxResultBytes]
 * @param {string} [options.runtimeId] 本次插件启动的运行时 ID；读取时用于识别"上一个进程留下的 running"
 * @param {() => number} [options.now]
 */
export function createRunStore(options) {
  const root = String(options?.root ?? '')
  if (!root) throw new RunStoreError('RUN_STORE_NO_ROOT', '缺少项目根，无法落盘派单结果')
  const dir = join(root, options.dir ?? RUNS_RELATIVE_DIR)
  // 同一目录的不同 store 实例（例如同一项目的不同别名路径）必须共享同一把写锁
  const lockKey = process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir)
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const maxResultBytes = options.maxResultBytes ?? MAX_RESULT_BYTES
  const runtimeId = typeof options.runtimeId === 'string' && options.runtimeId ? options.runtimeId : null
  const now = options.now ?? Date.now

  /** @param {string} childId */
  function fileFor(childId) {
    if (!CHILD_ID_PATTERN.test(childId)) {
      throw new RunStoreError('RUN_ID_INVALID', `childId 不合法：${JSON.stringify(childId)}`)
    }
    return join(dir, `${childId}.json`)
  }

  /**
   * 规范化 changedFiles：条数 + 字节双上限，并给出 total/truncated。
   * 字节按 JSON 转义后的大小计算（换行/制表符/反斜杠会翻倍），保证整条记录体积可控。
   *
   * @param {unknown} value
   * @param {unknown} existingTotal
   * @param {unknown} existingTruncated
   */
  function normalizeChangedFiles(value, existingTotal, existingTruncated) {
    if (!Array.isArray(value)) {
      return {
        changedFiles: null,
        changedFilesTruncated: existingTruncated === true,
        changedFilesTotal: Number.isInteger(existingTotal) ? /** @type {number} */ (existingTotal) : null,
      }
    }
    const all = value.filter((/** @type {unknown} */ file) => typeof file === 'string')
    let truncated = false
    let files = all
    if (files.length > MAX_CHANGED_FILES) {
      files = files.slice(0, MAX_CHANGED_FILES)
      truncated = true
    }
    let bytes = 0
    let kept = 0
    for (const file of files) {
      // +1 是本条在 JSON 数组里的逗号/换行开销上界
      const size = Buffer.byteLength(JSON.stringify(file), 'utf8') + 1
      if (bytes + size > MAX_CHANGED_FILES_BYTES) {
        truncated = true
        break
      }
      bytes += size
      kept += 1
    }
    if (kept < files.length) files = files.slice(0, kept)
    return {
      changedFiles: files,
      changedFilesTruncated: truncated || existingTruncated === true,
      // 回写旧记录时必须保留原始总数：磁盘上的 changedFiles 已经截断过一次，
      // 再 normalize 时不能把 changedFilesTotal 从 16000 降成 5000。
      changedFilesTotal:
        existingTruncated === true && Number.isInteger(existingTotal)
          ? Math.max(all.length, /** @type {number} */ (existingTotal))
          : all.length,
    }
  }

  /**
   * 规范化 overlapWarnings（落盘白名单 + 条数/字节双上限）。
   *
   * 上限的目的不是省空间，而是**保证记录可读**：overlap 与 changedFiles 一样可能膨胀到
   * MB 级，超过读取上限后整条记录会被读取侧拒绝（F4）。
   * 超限时保留前面的文件（重叠检测优先），并写 `overlapTruncated` / `overlapTotal`。
   *
   * @param {unknown} value
   * @param {unknown} [existingTruncated]
   * @param {unknown} [existingTotal]
   * @returns {{ overlapWarnings: Array<{ childId: string, files: string[] }>, overlapTruncated: boolean, overlapTotal: number }}
   */
  function normalizeOverlapWarnings(value, existingTruncated, existingTotal) {
    const priorTotal = Number.isInteger(existingTotal) ? /** @type {number} */ (existingTotal) : 0
    if (!Array.isArray(value)) {
      return {
        overlapWarnings: [],
        overlapTruncated: existingTruncated === true,
        overlapTotal: priorTotal,
      }
    }
    let total = 0
    let truncated = false
    let bytes = 0
    /** @type {Array<{ childId: string, files: string[] }>} */
    const warnings = []
    /** @type {Array<{ childId: string, files: string[] }>} */
    const items = []
    for (const item of value) {
      if (!item || typeof item !== 'object' || typeof item.childId !== 'string') continue
      const files = Array.isArray(item.files)
        ? item.files.filter((/** @type {unknown} */ file) => typeof file === 'string')
        : []
      items.push({ childId: String(item.childId), files })
      // 先完整统计原始总数（即使后面被截断/丢弃），overlapTotal 要如实反映规模
      total += files.length
    }
    outer: for (const item of items) {
      const { childId, files: allFiles } = item
      if (warnings.length >= MAX_OVERLAP_PAIRS) {
        truncated = true
        continue
      }
      // 预扣这一对的结构开销，保证整个字段（含 childId）不超预算
      let pairBytes = Buffer.byteLength(
        JSON.stringify({ childId, files: [] }),
        'utf8',
      )
      /** @type {string[]} */
      const files = []
      for (const file of allFiles) {
        if (files.length >= MAX_OVERLAP_FILES) {
          truncated = true
          break
        }
        const size = Buffer.byteLength(JSON.stringify(file), 'utf8') + 1
        if (bytes + pairBytes + size > MAX_OVERLAP_BYTES) {
          truncated = true
          break outer
        }
        pairBytes += size
        files.push(file)
      }
      if (files.length < allFiles.length) truncated = true
      if (files.length === 0) {
        truncated = true
        continue
      }
      bytes += pairBytes
      warnings.push({ childId, files })
    }
    // 最终保证整个字段（含外层括号/逗号）不超过字节预算：
    // 逐项累加时只算了文件本身，这里按真实 JSON 体积兜底裁剪。
    let payloadBytes = Buffer.byteLength(JSON.stringify(warnings), 'utf8')
    while (payloadBytes > MAX_OVERLAP_BYTES && warnings.length > 0) {
      const last = warnings[warnings.length - 1]
      if (last.files.length > 0) last.files.pop()
      if (last.files.length === 0) warnings.pop()
      truncated = true
      payloadBytes = Buffer.byteLength(JSON.stringify(warnings), 'utf8')
    }
    return {
      overlapWarnings: warnings,
      overlapTruncated: truncated || existingTruncated === true,
      overlapTotal:
        existingTruncated === true ? Math.max(total, priorTotal) : total,
    }
  }

  /**
   * P1-A 失败分类字段（白名单 + 旧记录兼容）。
   *
   * - 记录里已有合法 `failureClass`：信任它；`hint` 缺失时按类别补一句（旧版本记录）。
   * - 没有分类（旧记录 / 调用方未提供）：用 stopReason/diagnostic/error/result 现算。
   *   取消/成功的记录会得到 `{ failureClass: null, hint: null }`，不会被误判为失败。
   *
   * @param {any} record
   * @returns {{ failureClass: string | null, hint: string | null }}
   */
  function failureFieldsFor(record) {
    if (isFailureClass(record?.failureClass)) {
      const stored = record.failureClass
      const hint =
        typeof record?.hint === 'string' && record.hint.trim()
          ? truncateUtf8(record.hint, MAX_HINT_BYTES).text
          : hintForFailure(stored, typeof record?.provider === 'string' ? record.provider : null)
      return { failureClass: stored, hint }
    }
    const classified = classifyFailure({
      status: record?.status,
      stopReason: record?.stopReason,
      diagnostic: record?.diagnostic,
      error: record?.error,
      // 某些路径只有 result（磁盘字段名），用它判断 refusal 是否空输出
      output: record?.result,
      provider: record?.provider,
    })
    return {
      failureClass: classified.failureClass,
      hint: classified.hint ? truncateUtf8(classified.hint, MAX_HINT_BYTES).text : null,
    }
  }

  /**
   * 把调用方给的记录规范化成落盘形状（白名单字段，避免意外写入敏感内容）。
   * @param {any} record
   */
  function normalize(record) {
    const result = truncateUtf8(record?.result ?? '', maxResultBytes, {
      headBytes: Math.floor(maxResultBytes * 0.75),
    })
    const rawError = record?.error
    // 注意：不能在初始化式里引用 err 自身（TDZ）。用 rawError 取字段。
    const err = rawError
      ? {
          code: truncateUtf8(err_code(rawError), MAX_ERROR_BYTES).text,
          message: truncateUtf8(err_message(rawError), MAX_ERROR_BYTES).text,
        }
      : null
    const changed = normalizeChangedFiles(
      record?.changedFiles,
      record?.changedFilesTotal,
      record?.changedFilesTruncated,
    )
    const overlap = normalizeOverlapWarnings(
      record?.overlapWarnings,
      record?.overlapTruncated,
      record?.overlapTotal,
    )
    const routing = normalizeRouting(record?.routing)
    return {
      schemaVersion: 1,
      childId: String(record.childId),
      runtimeId: record.runtimeId ?? runtimeId,
      role: record.role ?? null,
      channel: record.channel ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      status: record.status,
      stopReason: record.stopReason ?? null,
      // 宿主原生 Job id（可选）：派单成功且宿主 jobs 服务可用时写入，
      // 供 get_task / 取消路径定位原生任务；没有 Job 时为 null（不伪造）。
      jobId: typeof record.jobId === 'string' && record.jobId ? record.jobId : null,
      diagnostic: record.diagnostic
        ? truncateUtf8(record.diagnostic, MAX_ERROR_BYTES).text
        : null,
      // P1-A：失败分类与给主控的一句话建议（成功/取消为 null；旧记录读取时现算）
      ...failureFieldsFor(record),
      createdAt: record.createdAt ?? now(),
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      result: result.text,
      resultBytes: result.bytes,
      resultTruncated: result.truncated,
      error: err,
      // P0-C：结构化结果（子 Agent 自报；不覆盖宿主终态 status 与 git changedFiles）
      structuredResult: record.structuredResult === true,
      resultStatus: RESULT_STATUS_VALUES.includes(record.resultStatus) ? record.resultStatus : null,
      summary: recordText(record.summary, MAX_SUMMARY_BYTES),
      summaryBytes: Number.isInteger(record.summaryBytes)
        ? record.summaryBytes
        : typeof record.summary === 'string'
          ? Buffer.byteLength(record.summary, 'utf8')
          : null,
      summaryTruncated:
        record.summaryTruncated === true ||
        (typeof record.summary === 'string' &&
          Buffer.byteLength(record.summary, 'utf8') > MAX_SUMMARY_BYTES),
      evidence: recordEvidence(record.evidence),
      artifacts: recordStringList(record.artifacts),
      reportedChangedFiles: recordStringList(record.reportedChangedFiles),
      resultTests: recordStringList(record.resultTests),
      openIssues: recordStringList(record.openIssues),
      nextAction: recordText(record.nextAction, 2 * 1024),
      handoff: recordHandoff(record.handoff),
      // P0-B：TaskSpec / ContextPack 摘要（已经是截断后的形状，这里再白名单一次）
      taskSpec: summarizeTaskSpec(record.taskSpec),
      contextPack: summarizeContextPack(record.contextPack),
      title: recordText(record.title, 1024),
      continuation: record.continuation ?? null,
      // 上下文重放实际注入的字节数：只在本次派单带 continuation 时写入，
      // 没有就省略该字段（不写 null，避免把"没重放"伪装成"重放了 0 字节"）。
      ...(Number.isInteger(record.continuationBytes)
        ? { continuationBytes: record.continuationBytes }
        : {}),
      // 并行隔离元数据（P0）：operationId 与 childId 的映射、工作树位置、改动文件
      operationId:
        typeof record.operationId === 'string' && record.operationId ? record.operationId : null,
      isolation:
        record.isolation === 'none' || record.isolation === 'worktree' ? record.isolation : null,
      // P1-B：自动路由的可解释性（谁选的、为什么）。手动指定时为 { roleId, auto:false }。
      ...(routing ? { routing } : {}),
      worktree: normalizeWorktree(record.worktree),
      changedFiles: changed.changedFiles,
      changedFilesUnknown: record.changedFilesUnknown === true,
      changedFilesTruncated: changed.changedFilesTruncated,
      changedFilesTotal: changed.changedFilesTotal,
      // overlap 必须落盘（P2）：读取时仍可重算，但原始记录要能自证冲突。
      // 无交集/无法判断时写空数组（`changedFilesUnknown` 另有标记），保证字段始终存在。
      // 有上限（F4）：每对 ≤50 文件 / 整个字段 ≤64KB，超限写 truncated/total。
      overlapWarnings: overlap.overlapWarnings,
      overlapTruncated: overlap.overlapTruncated,
      overlapTotal: overlap.overlapTotal,
      stopConfirmed: typeof record.stopConfirmed === 'boolean' ? record.stopConfirmed : null,
    }
  }

  /**
   * 读取时的「假 running」投影：磁盘上 status=running，但记录的 runtimeId 不是当前进程，
   * 说明那次启动已经结束（或进程崩了），任务不可能还在跑。
   *
   * 只改返回值，**不回写磁盘**：真值保持原样，便于排查；下次真正写入时才会带新的 runtimeId。
   * @param {any} record
   */
  function projectInterrupted(record) {
    if (!runtimeId || !record || typeof record !== 'object') return record
    if (record.status === RUN_STATUS.RUNNING && record.runtimeId !== runtimeId) {
      return { ...record, status: RUN_STATUS.INTERRUPTED, interrupted: true }
    }
    return record
  }

  /**
   * 原子写一条记录（内部先 normalize）。失败抛 `RunStoreError`。
   *
   * 体积闸兜底（F4）：超限时**同时**裁剪 changedFiles 与 overlapWarnings，
   * 只丢 changedFiles 的话 overlap 仍可能把记录撑到读不回来。
   *
   * @param {any} record
   */
  async function persistRecord(record) {
    const childId = String(record?.childId ?? '')
    const target = fileFor(childId)
    const normalized = normalize(record)
    let payload = `${JSON.stringify(normalized, null, 2)}\n`
    if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) {
      normalized.changedFiles = []
      normalized.changedFilesTruncated = true
      const hadOverlap = normalized.overlapWarnings.length > 0 || normalized.overlapTotal > 0
      normalized.overlapWarnings = []
      if (hadOverlap) normalized.overlapTruncated = true
      payload = `${JSON.stringify(normalized, null, 2)}\n`
      if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) {
        throw new RunStoreError(
          'RUN_TOO_LARGE',
          `派单记录超过读取上限 ${MAX_FILE_BYTES} 字节，拒绝写入（避免产生读不回的记录）`,
        )
      }
    }
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(tmp, payload, 'utf8')
      await renameWithRetry(tmp, target)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw new RunStoreError(
        'RUN_WRITE_FAILED',
        `写派单结果失败：${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }
    return { ok: true, path: target, bytes: Buffer.byteLength(payload) }
  }

  /**
   * 两组 overlapWarnings 是否等价（childId + files 顺序都要一致）。
   * 只用于决定是否需要回写，不做语义合并。
   * @param {Array<{ childId: string, files: string[] }>} a
   * @param {Array<{ childId: string, files: string[] }>} b
   */
  function sameOverlap(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (String(a[i].childId) !== String(b[i].childId)) return false
      const af = Array.isArray(a[i].files) ? a[i].files : []
      const bf = Array.isArray(b[i].files) ? b[i].files : []
      if (af.length !== bf.length) return false
      for (let j = 0; j < af.length; j += 1) {
        if (af[j] !== bf[j]) return false
      }
    }
    return true
  }

  /**
   * 把当前记录与历史记录的交集**回写**到历史记录（F3）。
   *
   * 有界：只处理「与当前记录有交集、且字段确实变化」的记录，最多
   * `MAX_OVERLAP_BACKFILL_RECORDS` 条。这样并发结束顺序任意，
   * 双方原始 JSON 都包含交集，同时不会因为一次写入重写整个目录。
   *
   * @param {any} current 刚写入的记录（带 overlapWarnings）
   * @param {any[]} others 历史记录（不含当前 childId）
   */
  async function backfillOverlap(current, others) {
    const warnings = Array.isArray(current.overlapWarnings) ? current.overlapWarnings : []
    if (warnings.length === 0) return
    const participants = new Set(warnings.map((/** @type {any} */ item) => String(item.childId)))
    const all = [...others, current]
    let written = 0
    for (const other of others) {
      if (written >= MAX_OVERLAP_BACKFILL_RECORDS) break
      if (!participants.has(String(other.childId))) continue
      const computed = overlapWarningsFor(other, all)
      const capped = normalizeOverlapWarnings(
        computed,
        other.overlapTruncated,
        other.overlapTotal,
      )
      const stored = normalizeOverlapWarnings(
        other.overlapWarnings,
        other.overlapTruncated,
        other.overlapTotal,
      )
      if (
        sameOverlap(stored.overlapWarnings, capped.overlapWarnings) &&
        stored.overlapTruncated === capped.overlapTruncated &&
        stored.overlapTotal === capped.overlapTotal
      ) {
        continue
      }
      await persistRecord({ ...other, overlapWarnings: computed })
      written += 1
    }
  }

  /**
   * 写一条记录（原子替换）。失败抛 `RunStoreError`，由调用方转成 `persistenceWarning`。
   *
   * 整个「读现有记录 → 写当前 → 回写交集」在同一把项目级异步互斥里完成（F3）：
   * 并发结束顺序任意，两份磁盘 JSON 都必须含交集。
   *
   * @param {any} record
   */
  async function writeRun(record) {
    const childId = String(record?.childId ?? '')
    fileFor(childId) // 先校验 childId（防路径穿越），再排队
    // 只有「带工作树的终态 + changedFiles」才需要 overlap 计算/回写；
    // running 记录与普通记录直接写，避免每次派单都全量读目录。
    const wantsOverlap =
      record?.worktree &&
      record.status !== RUN_STATUS.RUNNING &&
      Array.isArray(record.changedFiles)
    if (!wantsOverlap) {
      return withRunLock(lockKey, async () => {
        const result = await persistRecord({ ...record, childId })
        // 清理是"尽力而为"：失败不影响本次写入结果
        await pruneRuns().catch(() => {})
        return result
      })
    }
    return withRunLock(lockKey, async () => {
      // 用原始记录（不投影 interrupted）：回写不能把读取投影写回磁盘（C1）。
      const existing = await readRecords({ project: false })
      const others = existing.filter((/** @type {any} */ item) => String(item.childId) !== childId)
      // P2：终态记录必须把 overlapWarnings 一起落盘（读取仍可重算，但原始 JSON 要自证冲突）。
      const base = { ...record, childId }
      const toWrite = { ...base, overlapWarnings: overlapWarningsFor(base, others) }
      const result = await persistRecord(toWrite)
      await backfillOverlap(toWrite, others)
      // 清理是"尽力而为"：失败不影响本次写入结果
      await pruneRuns().catch(() => {})
      return result
    })
  }

  /**
   * 读取目录里的全部合法记录（新的在前由调用方排序）。
   * 单条坏记录跳过，不影响列表；超过体积上限的记录也跳过（防止被塞巨型文件）。
   *
   * @param {{ project?: boolean }} [options] `project:false` 返回磁盘原样记录
   *   （不把旧 runtimeId 的 running 投影成 interrupted；写入/回写路径必须用它，
   *   否则会把投影状态写回磁盘）。
   * @returns {Promise<any[]>}
   */
  async function readRecords(options = {}) {
    const project = options.project !== false
    let names
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    /** @type {any[]} */
    const records = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = join(dir, name)
      try {
        const stat = await fs.stat(full)
        if (stat.size > MAX_FILE_BYTES) continue
        const text = await fs.readFile(full, 'utf8')
        const raw = JSON.parse(text)
        const parsed = project ? projectInterrupted(raw) : raw
        if (parsed && typeof parsed === 'object') {
          // 兼容旧记录/坏记录：childId 缺失时退回文件名
          if (typeof parsed.childId !== 'string' || !parsed.childId) {
            parsed.childId = name.replace(/\.json$/, '')
          }
          records.push(parsed)
        }
      } catch {
        /* 单条坏记录跳过，不影响其余记录 */
      }
    }
    return records
  }

  /**
   * 读一条记录。
   * @param {string} childId
   */
  async function loadRun(childId) {
    const target = fileFor(String(childId))
    /** @type {import('node:fs').Stats} */
    let stat
    try {
      stat = await fs.stat(target)
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') {
        throw new RunStoreError('RUN_NOT_FOUND', `没有该任务的落盘记录：${childId}`)
      }
      throw new RunStoreError('RUN_READ_FAILED', `读取派单结果失败：${errorMessage(error)}`, error)
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new RunStoreError('RUN_TOO_LARGE', `记录文件超过 ${MAX_FILE_BYTES} 字节，拒绝读取`)
    }
    let text
    try {
      text = await fs.readFile(target, 'utf8')
    } catch (error) {
      throw new RunStoreError('RUN_READ_FAILED', `读取派单结果失败：${errorMessage(error)}`, error)
    }
    let record
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
      record = projectInterrupted(parsed)
    } catch (error) {
      throw new RunStoreError('RUN_CORRUPT', `记录文件不是合法 JSON：${childId}`, error)
    }

    // 单条查询也要给出重叠预警：需要同项目的其他记录一起比较。
    // 没有工作树的旧记录不必多读一遍目录。
    if (!record.worktree) {
      return { ...record, ...failureFieldsFor(record), overlapWarnings: [] }
    }
    const all = await readRecords()
    // 读取侧同样应用条数/字节上限：避免 get_task 返回 MB 级 overlap（F4）。
    const overlap = normalizeOverlapWarnings(
      overlapWarningsFor(record, all),
      record.overlapTruncated,
      record.overlapTotal,
    )
    return {
      ...record,
      ...failureFieldsFor(record),
      overlapWarnings: overlap.overlapWarnings,
      overlapTruncated: overlap.overlapTruncated,
      overlapTotal: overlap.overlapTotal,
    }
  }

  /**
   * 列出最近的派单记录（新的在前），只返回摘要，不返回完整结果。
   * 目的：让 `meetingstone_list_runs` 能回答"我派过哪些任务、现在什么状态"，
   * 而不是只能靠 childId 逐个查。
   *
   * @param {{ limit?: number }} [options]
   */
  async function listRuns(options = {}) {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)))
    const all = await readRecords()
    const records = all.map((parsed) => {
      const overlap = normalizeOverlapWarnings(
        overlapWarningsFor(parsed, all),
        parsed.overlapTruncated,
        parsed.overlapTotal,
      )
      const failure = failureFieldsFor(parsed)
      const routing = normalizeRouting(parsed.routing)
      return {
        childId: parsed.childId ?? 'unknown',
        runtimeId: parsed.runtimeId ?? null,
        role: parsed.role ?? null,
        channel: parsed.channel ?? null,
        provider: parsed.provider ?? null,
        model: parsed.model ?? null,
        status: parsed.status ?? 'unknown',
        ...(parsed.interrupted === true ? { interrupted: true } : {}),
        // P0-B/P0-C：列表里展示任务名与结构化结果摘要（不返回长文）
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : null,
        structuredResult: parsed.structuredResult === true,
        resultStatus: typeof parsed.resultStatus === 'string' ? parsed.resultStatus : null,
        summaryPreview: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : '',
        // 原生 Job id（无 Job 时省略）：列表里能直接看到面板中的任务
        ...(typeof parsed.jobId === 'string' && parsed.jobId ? { jobId: parsed.jobId } : {}),
        stopReason: parsed.stopReason ?? null,
        stopConfirmed: typeof parsed.stopConfirmed === 'boolean' ? parsed.stopConfirmed : null,
        // 诊断摘要：同样只取前 200 字符（与 preview 一致），避免列表膨胀
        diagnostic: typeof parsed.diagnostic === 'string' ? parsed.diagnostic.slice(0, 200) : '',
        // P1-A：失败分类与建议（成功/取消为 null），列表默认可见，主控不必再翻全文
        failureClass: failure.failureClass,
        hint: failure.hint,
        createdAt: parsed.createdAt ?? null,
        finishedAt: parsed.finishedAt ?? null,
        resultBytes: parsed.resultBytes ?? 0,
        resultTruncated: parsed.resultTruncated === true,
        error: parsed.error ?? null,
        // 并行隔离：worktree 与改动文件必须在列表里可见（手动合并/清理依赖它）
        operationId: parsed.operationId ?? null,
        isolation: parsed.isolation ?? null,
        // P1-B：列表里能看到"这次为什么派给这个角色"（自动路由才有 reason）
        ...(routing ? { routing } : {}),
        worktree: parsed.worktree ?? null,
        changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles : null,
        changedFilesUnknown: parsed.changedFilesUnknown === true,
        changedFilesTruncated: parsed.changedFilesTruncated === true,
        changedFilesTotal:
          typeof parsed.changedFilesTotal === 'number'
            ? parsed.changedFilesTotal
            : Array.isArray(parsed.changedFiles)
              ? parsed.changedFiles.length
              : null,
        overlapWarnings: overlap.overlapWarnings,
        overlapTruncated: overlap.overlapTruncated,
        overlapTotal: overlap.overlapTotal,
        // 摘要：只取前 200 字符，避免把整份结果塞进列表
        preview: typeof parsed.result === 'string' ? parsed.result.slice(0, 200) : '',
      }
    })
    records.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return records.slice(0, limit)
  }

  /**
   * 清理：先按条数，再按时长。只处理本目录下的 `.json`。
   *
   * **带 worktree 的记录永不参与清理**（既不被删，也不占用 100 条额度）：
   * 工作树里可能有未合并的成果，元数据是人工合并/清理的唯一线索。
   * 代价是这类记录会一直保留；请人工合并后自行删除记录与工作树。
   */
  async function pruneRuns() {
    let names
    try {
      names = await fs.readdir(dir)
    } catch {
      return { removed: 0 }
    }
    /** @type {Array<{ name: string, mtimeMs: number }>} */
    const entries = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const stat = await fs.stat(join(dir, name))
        entries.push({ name, mtimeMs: stat.mtimeMs })
      } catch {
        /* 单个文件探测失败就跳过 */
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const nowMs = now()
    const tooManyPossible = entries.length > maxRuns
    const tooOldPossible = entries.some((entry) => nowMs - entry.mtimeMs > maxAgeMs)
    // 快速路径：没有候选就不读文件内容。每次写盘都会触发 prune，
    // 全量解析会让快速连续派单明显变慢（B1 回归过）。
    if (!tooManyPossible && !tooOldPossible) return { removed: 0, protected: 0 }

    /** @type {Array<{ name: string, mtimeMs: number, protected: boolean }>} */
    const classified = []
    for (const entry of entries) {
      const full = join(dir, entry.name)
      // fail-safe：默认保护。只有**成功解析且确认没有工作树**的记录才允许清理。
      // 超大文件/坏 JSON 读不了，就无从判断它是不是未合并成果的元数据——宁可留着。
      let protectedRecord = true
      try {
        const stat = await fs.stat(full)
        if (stat.size <= MAX_FILE_BYTES) {
          try {
            const parsed = JSON.parse(await fs.readFile(full, 'utf8'))
            protectedRecord = Boolean(
              parsed &&
                typeof parsed === 'object' &&
                parsed.worktree &&
                typeof parsed.worktree.path === 'string' &&
                parsed.worktree.path,
            )
          } catch {
            /* 坏记录：无法判断 → 保持保护 */
          }
        }
        // stat.size > MAX_FILE_BYTES：读取侧会拒绝，清理侧同样无法判断 → 保持保护
      } catch {
        continue
      }
      classified.push({ ...entry, protected: protectedRecord })
    }

    // 受保护记录不参与清理：既不会被删，也不占用 100 条额度
    const unprotected = classified.filter((entry) => !entry.protected)
    const doomed = []
    if (tooManyPossible) {
      unprotected.forEach((entry, index) => {
        if (index >= maxRuns || nowMs - entry.mtimeMs > maxAgeMs) doomed.push(entry.name)
      })
    } else {
      for (const entry of unprotected) {
        if (nowMs - entry.mtimeMs > maxAgeMs) doomed.push(entry.name)
      }
    }

    let removed = 0
    for (const name of doomed) {
      try {
        await fs.rm(join(dir, name), { force: true })
        removed += 1
      } catch {
        /* 删不掉就留着，下次再试 */
      }
    }
    return { removed, protected: classified.length - unprotected.length }
  }

  return { root, dir, pathFor: fileFor, writeRun, loadRun, listRuns, pruneRuns, truncateUtf8 }
}

/** @param {any} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {any} error */
function err_code(error) {
  return typeof error?.code === 'string' ? error.code : 'UNKNOWN'
}

/** @param {any} error */
function err_message(error) {
  return typeof error?.message === 'string' ? error.message : String(error ?? '')
}
