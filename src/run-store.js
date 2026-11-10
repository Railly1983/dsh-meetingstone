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
import { join } from 'node:path'

/** 相对项目根的默认目录。 */
export const RUNS_RELATIVE_DIR = '.meetingstone/runs'
/** 单条结果上限（UTF-8 字节）。 */
export const MAX_RESULT_BYTES = 256 * 1024
/** 单条错误信息上限。 */
export const MAX_ERROR_BYTES = 16 * 1024
/**
 * 单条记录里 `changedFiles` 的条数上限。
 * 为什么要设：大型仓库一次改动上万文件时，记录能涨到 1.5MB+，读取侧拒绝后
 * 清理器又会把它当"未保护"删掉，工作树元数据就丢了（P1）。
 * 超过时保留前 N 条，并记录 `changedFilesTruncated:true` / `changedFilesTotal`。
 */
export const MAX_CHANGED_FILES = 5000
/** changedFiles 的字节预算（按 JSON 转义后大小计，保证整条记录体积可控）。 */
const MAX_CHANGED_FILES_BYTES = 2 * 1024 * 1024
/** 默认保留条数 / 时长。 */
export const DEFAULT_MAX_RUNS = 100
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
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
 * @param {unknown} value
 * @param {number} maxBytes
 * @param {{ headBytes?: number, tailBytes?: number }} [options]
 * @returns {{ text: string, bytes: number, truncated: boolean }}
 */
export function truncateUtf8(value, maxBytes, options = {}) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, bytes: buffer.length, truncated: false }

  const headBytes = options.headBytes ?? Math.floor(maxBytes * 0.75)
  const tailBytes = options.tailBytes ?? maxBytes - headBytes
  const marker = `\n…[truncated ${buffer.length - maxBytes} bytes]…\n`
  const markerBytes = Buffer.byteLength(marker)

  const head = sliceUtf8(buffer, 0, Math.max(0, headBytes - markerBytes))
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
      changedFilesTotal: all.length,
    }
  }

  /**
   * 规范化 overlapWarnings（落盘白名单）。
   * @param {unknown} value
   */
  function normalizeOverlapWarnings(value) {
    if (!Array.isArray(value)) return null
    return value
      .filter((/** @type {any} */ item) => item && typeof item === 'object' && typeof item.childId === 'string')
      .map((/** @type {any} */ item) => ({
        childId: String(item.childId),
        files: Array.isArray(item.files)
          ? item.files.filter((/** @type {unknown} */ file) => typeof file === 'string')
          : [],
      }))
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
      diagnostic: record.diagnostic
        ? truncateUtf8(record.diagnostic, MAX_ERROR_BYTES).text
        : null,
      createdAt: record.createdAt ?? now(),
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      result: result.text,
      resultBytes: result.bytes,
      resultTruncated: result.truncated,
      error: err,
      continuation: record.continuation ?? null,
      // 并行隔离元数据（P0）：operationId 与 childId 的映射、工作树位置、改动文件
      operationId:
        typeof record.operationId === 'string' && record.operationId ? record.operationId : null,
      isolation:
        record.isolation === 'none' || record.isolation === 'worktree' ? record.isolation : null,
      worktree: normalizeWorktree(record.worktree),
      changedFiles: changed.changedFiles,
      changedFilesUnknown: record.changedFilesUnknown === true,
      changedFilesTruncated: changed.changedFilesTruncated,
      changedFilesTotal: changed.changedFilesTotal,
      // overlap 必须落盘（P2）：读取时仍可重算，但原始记录要能自证冲突。
      // 无交集/无法判断时写空数组（`changedFilesUnknown` 另有标记），保证字段始终存在。
      overlapWarnings: normalizeOverlapWarnings(record.overlapWarnings) ?? [],
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
   * 写一条记录（原子替换）。失败抛 `RunStoreError`，由调用方转成 `persistenceWarning`。
   * @param {any} record
   */
  async function writeRun(record) {
    const childId = String(record?.childId ?? '')
    const target = fileFor(childId)
    // P2：终态记录必须把 overlapWarnings 一起落盘（读取仍可重算，但原始 JSON 要自证冲突）。
    // 只对带工作树且有 changedFiles 的终态计算；running 记录没有改动列表，算不出交集。
    let toWrite = { ...record, childId }
    if (
      record?.worktree &&
      record.status !== RUN_STATUS.RUNNING &&
      Array.isArray(record.changedFiles)
    ) {
      const all = await readRecords()
      toWrite = { ...toWrite, overlapWarnings: overlapWarningsFor(record, all) }
    }
    let payload = `${JSON.stringify(normalize(toWrite), null, 2)}\n`
    // 最后一道体积闸：写入约束（result 截断 + changedFiles 条数/字节预算）之外，
    // 任何异常膨胀都先丢 changedFiles 保住 worktree 元数据，绝不写出自己读不回的记录。
    if (Buffer.byteLength(payload, 'utf8') > MAX_FILE_BYTES) {
      const trimmed = normalize(toWrite)
      trimmed.changedFiles = []
      trimmed.changedFilesTruncated = true
      payload = `${JSON.stringify(trimmed, null, 2)}\n`
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
    // 清理是"尽力而为"：失败不影响本次写入结果
    await pruneRuns().catch(() => {})
    return { ok: true, path: target, bytes: Buffer.byteLength(payload) }
  }

  /**
   * 读取目录里的全部合法记录（新的在前由调用方排序）。
   * 单条坏记录跳过，不影响列表；超过体积上限的记录也跳过（防止被塞巨型文件）。
   * @returns {Promise<any[]>}
   */
  async function readRecords() {
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
        const parsed = projectInterrupted(JSON.parse(text))
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
    if (!record.worktree) return { ...record, overlapWarnings: [] }
    const all = await readRecords()
    return { ...record, overlapWarnings: overlapWarningsFor(record, all) }
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
    const records = all.map((parsed) => ({
      childId: parsed.childId ?? 'unknown',
      runtimeId: parsed.runtimeId ?? null,
      role: parsed.role ?? null,
      channel: parsed.channel ?? null,
      provider: parsed.provider ?? null,
      model: parsed.model ?? null,
      status: parsed.status ?? 'unknown',
      ...(parsed.interrupted === true ? { interrupted: true } : {}),
      stopReason: parsed.stopReason ?? null,
      stopConfirmed: typeof parsed.stopConfirmed === 'boolean' ? parsed.stopConfirmed : null,
      // 诊断摘要：同样只取前 200 字符（与 preview 一致），避免列表膨胀
      diagnostic: typeof parsed.diagnostic === 'string' ? parsed.diagnostic.slice(0, 200) : '',
      createdAt: parsed.createdAt ?? null,
      finishedAt: parsed.finishedAt ?? null,
      resultBytes: parsed.resultBytes ?? 0,
      resultTruncated: parsed.resultTruncated === true,
      error: parsed.error ?? null,
      // 并行隔离：worktree 与改动文件必须在列表里可见（手动合并/清理依赖它）
      operationId: parsed.operationId ?? null,
      isolation: parsed.isolation ?? null,
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
      overlapWarnings: overlapWarningsFor(parsed, all),
      // 摘要：只取前 200 字符，避免把整份结果塞进列表
      preview: typeof parsed.result === 'string' ? parsed.result.slice(0, 200) : '',
    }))
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

  return { root, dir, writeRun, loadRun, listRuns, pruneRuns, truncateUtf8 }
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
