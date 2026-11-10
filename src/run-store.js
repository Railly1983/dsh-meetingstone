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
/** 默认保留条数 / 时长。 */
export const DEFAULT_MAX_RUNS = 100
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** 读取时允许的最大文件体积（防止被塞进巨型文件）。 */
const MAX_FILE_BYTES = 1024 * 1024
const CHILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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
 * 建一个绑定到某项目根的存储。
 *
 * @param {object} options
 * @param {string} options.root 项目根（绝对路径）
 * @param {string} [options.dir] 相对 root 的目录，默认 `.meetingstone/runs`
 * @param {number} [options.maxRuns]
 * @param {number} [options.maxAgeMs]
 * @param {number} [options.maxResultBytes]
 * @param {() => number} [options.now]
 */
export function createRunStore(options) {
  const root = String(options?.root ?? '')
  if (!root) throw new RunStoreError('RUN_STORE_NO_ROOT', '缺少项目根，无法落盘派单结果')
  const dir = join(root, options.dir ?? RUNS_RELATIVE_DIR)
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const maxResultBytes = options.maxResultBytes ?? MAX_RESULT_BYTES
  const now = options.now ?? Date.now

  /** @param {string} childId */
  function fileFor(childId) {
    if (!CHILD_ID_PATTERN.test(childId)) {
      throw new RunStoreError('RUN_ID_INVALID', `childId 不合法：${JSON.stringify(childId)}`)
    }
    return join(dir, `${childId}.json`)
  }

  /**
   * 把调用方给的记录规范化成落盘形状（白名单字段，避免意外写入敏感内容）。
   * @param {any} record
   */
  function normalize(record) {
    const result = truncateUtf8(record?.result ?? '', maxResultBytes, {
      headBytes: Math.floor(maxResultBytes * 0.75),
    })
    const err = record?.error
      ? {
          code: truncateUtf8(err_code(err), MAX_ERROR_BYTES).text,
          message: truncateUtf8(err_message(err), MAX_ERROR_BYTES).text,
        }
      : null
    return {
      schemaVersion: 1,
      childId: String(record.childId),
      role: record.role ?? null,
      channel: record.channel ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      status: record.status,
      stopReason: record.stopReason ?? null,
      createdAt: record.createdAt ?? now(),
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      result: result.text,
      resultBytes: result.bytes,
      resultTruncated: result.truncated,
      error: err,
      continuation: record.continuation ?? null,
      worktree: record.worktree ?? null,
    }
  }

  /**
   * 写一条记录（原子替换）。失败抛 `RunStoreError`，由调用方转成 `persistenceWarning`。
   * @param {any} record
   */
  async function writeRun(record) {
    const childId = String(record?.childId ?? '')
    const target = fileFor(childId)
    const payload = `${JSON.stringify(normalize({ ...record, childId }), null, 2)}\n`
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(tmp, payload, 'utf8')
      await fs.rename(tmp, target)
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
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
      return parsed
    } catch (error) {
      throw new RunStoreError('RUN_CORRUPT', `记录文件不是合法 JSON：${childId}`, error)
    }
  }

  /**
   * 清理：先按条数，再按时长。只处理本目录下的 `.json`。
   */
  async function pruneRuns() {
    let names
    try {
      names = await fs.readdir(dir)
    } catch {
      return { removed: 0 }
    }
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
    const doomed = []
    entries.forEach((entry, index) => {
      const tooMany = index >= maxRuns
      const tooOld = nowMs - entry.mtimeMs > maxAgeMs
      if (tooMany || tooOld) doomed.push(entry.name)
    })
    let removed = 0
    for (const name of doomed) {
      try {
        await fs.rm(join(dir, name), { force: true })
        removed += 1
      } catch {
        /* 删不掉就留着，下次再试 */
      }
    }
    return { removed }
  }

  return { root, dir, writeRun, loadRun, pruneRuns, truncateUtf8 }
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
