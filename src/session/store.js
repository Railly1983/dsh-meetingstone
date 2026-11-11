// @ts-check
/**
 * 会话级覆盖的存储：`.meetingstone/sessions/<sessionId>.json`。
 *
 * ⚠️ 暂不接入客户端（2026-11-11）：会话级编辑 GUI 的带参 Remote 被宿主 Gateway
 * 的 strict codec 校验拒绝（真机错误见 docs/gui-0.2.0.md §6）；存储仍供派单时的
 * 会话配置解析读取，但 GUI 不再写入。
 *
 * 为什么不用宿主的 session 元数据（证据见 src/session/config.js 文件头与
 * docs/configuration.md）：`@deepseek-ai/dsh-session` 的 header 是创建时深冻结的
 * 只读快照，没有插件可写的 per-session KV；`dsh-storage-domain` 需要 zod 且不是
 * 所有 composition 都挂载。因此退化为项目内文件，**按 sessionId 隔离**。
 *
 * 边界：
 * - IO 全部可注入，便于单测（内存假文件系统）
 * - 读**永不抛异常**：文件不存在 → 空配置；坏 JSON / 版本不认识 → 空配置 + errors
 * - 写原子替换（tmp + rename，Windows 上对 EPERM/EBUSY 短重试）
 * - 已有文件损坏时拒绝写入（fail-safe：不覆盖用户手写内容）
 * - `.meetingstone/` 已在仓库 .gitignore 中：覆盖文件属于本机数据，不入库
 *
 * 局限（docs/configuration.md 同步说明）：
 * - 文件不随宿主会话删除/归档而清理；换项目路径后看不到旧覆盖
 * - 多进程同时写同一 session 文件没有跨进程锁（最后写入者胜出）
 */
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  SESSION_CONFIG_ERRORS,
  diffRoleOverride,
  emptySessionConfig,
  isEmptyPatch,
  mergeRolePatch,
  normalizeFieldPath,
  normalizeSessionConfig,
  removePatchField,
  sanitizeRolePatch,
} from './config.js'
import { isValidRoleId } from '../roles/ids.js'

/** 相对项目根的目录。 */
export const SESSIONS_RELATIVE_DIR = '.meetingstone/sessions'

/** sessionId 只接受安全字符，避免路径穿越。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** @param {unknown} value */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/**
 * 覆盖文件路径。项目根或 sessionId 不合法时返回 null（调用方负责报错）。
 * @param {unknown} projectRoot
 * @param {unknown} sessionId
 * @returns {string | null}
 */
export function sessionConfigPath(projectRoot, sessionId) {
  if (typeof projectRoot !== 'string' || !projectRoot) return null
  if (!isValidSessionId(sessionId)) return null
  return join(projectRoot, SESSIONS_RELATIVE_DIR, `${sessionId}.json`)
}

/**
 * 原子替换；Windows 上目标可能正被读取/占用，rename 会偶发 EPERM/EBUSY。
 * @param {(from: string, to: string) => Promise<void>} renameFile
 * @param {string} from
 * @param {string} to
 */
async function renameWithRetry(renameFile, from, to) {
  /** @type {any} */
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await renameFile(from, to)
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
 * @typedef {object} SessionOverrideStoreDeps
 * @property {(path: string) => string} [readText]
 * @property {(path: string, text: string) => Promise<void>} [writeText]
 * @property {(from: string, to: string) => Promise<void>} [renameFile]
 * @property {(path: string) => Promise<void>} [removeFile]
 * @property {(dir: string) => Promise<void>} [ensureDir]
 * @property {() => number} [now]
 */

/**
 * 创建会话覆盖存储。默认 deps 直接读写磁盘（Node 环境）。
 * @param {SessionOverrideStoreDeps} [deps]
 */
export function createSessionOverrideStore(deps = {}) {
  const readText = deps.readText ?? ((path) => readFileSync(path, 'utf8'))
  const writeText = deps.writeText ?? ((path, text) => fs.writeFile(path, text, 'utf8'))
  const renameFile = deps.renameFile ?? ((from, to) => fs.rename(from, to))
  const removeFile = deps.removeFile ?? ((path) => fs.rm(path, { force: true }))
  const ensureDir = deps.ensureDir ?? ((dir) => fs.mkdir(dir, { recursive: true }))
  const now = deps.now ?? (() => Date.now())

  /**
   * 读一个会话的覆盖配置。永不抛异常。
   * @param {unknown} projectRoot
   * @param {unknown} sessionId
   * @returns {{ config: import('./config.js').SessionConfig, errors: any[], path: string | null, exists: boolean, corrupt: boolean }}
   */
  function get(projectRoot, sessionId) {
    const empty = () => {
      const config = emptySessionConfig()
      return { config, errors: [], path: null, exists: false, corrupt: false }
    }

    if (typeof projectRoot !== 'string' || !projectRoot) {
      const base = empty()
      return {
        ...base,
        errors: [
          {
            code: SESSION_CONFIG_ERRORS.PROJECT_ROOT_UNKNOWN,
            message: '无法确定项目根目录，已跳过会话级配置（仅使用全局+项目角色表）',
          },
        ],
      }
    }
    if (!isValidSessionId(sessionId)) {
      const base = empty()
      return {
        ...base,
        errors: [
          {
            code: SESSION_CONFIG_ERRORS.INVALID_SESSION_ID,
            message: `会话 id 不合法：${String(sessionId)}，已跳过会话级配置`,
          },
        ],
      }
    }

    const path = /** @type {string} */ (sessionConfigPath(projectRoot, sessionId))
    let text
    try {
      text = readText(path)
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') {
        return { config: emptySessionConfig(), errors: [], path, exists: false, corrupt: false }
      }
      return {
        config: emptySessionConfig(),
        errors: [
          {
            code: SESSION_CONFIG_ERRORS.READ_FAILED,
            message: `读取会话配置失败：${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        path,
        exists: true,
        corrupt: true,
      }
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return {
        config: emptySessionConfig(),
        errors: [
          {
            code: SESSION_CONFIG_ERRORS.INVALID_JSON,
            message: `会话配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        path,
        exists: true,
        corrupt: true,
      }
    }

    const normalized = normalizeSessionConfig(parsed)
    const corrupt = normalized.errors.some((error) =>
      [
        SESSION_CONFIG_ERRORS.NOT_OBJECT,
        SESSION_CONFIG_ERRORS.UNSUPPORTED_VERSION,
      ].includes(error.code),
    )
    return { ...normalized, path, exists: true, corrupt }
  }

  /**
   * 原子写一个会话配置。抛 `SESSION_CONFIG_WRITE_FAILED`。
   * @param {unknown} projectRoot
   * @param {unknown} sessionId
   * @param {import('./config.js').SessionConfig} config
   */
  async function write(projectRoot, sessionId, config) {
    const path = sessionConfigPath(projectRoot, sessionId)
    if (!path) {
      const error = /** @type {any} */ (new Error('会话配置路径不合法（项目根或 sessionId 缺失）'))
      error.code = SESSION_CONFIG_ERRORS.INVALID_SESSION_ID
      throw error
    }
    const payload = `${JSON.stringify(config, null, 2)}\n`
    const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
    try {
      await ensureDir(dirname(path))
      await writeText(temp, payload)
      await renameWithRetry(renameFile, temp, path)
    } catch (error) {
      await removeFile(temp).catch(() => {})
      const wrapped = /** @type {any} */ (
        new Error(`写会话配置失败：${error instanceof Error ? error.message : String(error)}`)
      )
      wrapped.code = SESSION_CONFIG_ERRORS.WRITE_FAILED
      throw wrapped
    }
    return { ok: true, path, bytes: Buffer.byteLength(payload, 'utf8'), at: now() }
  }

  /**
   * 设置一个字段覆盖。只写差异：值等于继承值 → 删除该键（恢复继承）。
   *
   * `inherited` 是"全局+项目"解析后的角色（不含会话层）；角色是会话内新建的
   * 则传 null。找不到角色时按"没有继承值"处理（全部写入）。
   *
   * @param {unknown} projectRoot
   * @param {unknown} sessionId
   * @param {{ roleId: string, patch: Record<string, any>, inherited?: object | null }} input
   */
  async function setOverride(projectRoot, sessionId, input) {
    const roleId = input?.roleId
    const loaded = get(projectRoot, sessionId)
    if (loaded.corrupt) {
      return {
        ok: false,
        written: false,
        config: loaded.config,
        errors: [
          ...loaded.errors,
          {
            code: SESSION_CONFIG_ERRORS.CORRUPT,
            message: '已有会话配置文件损坏，拒绝覆盖（请先手工修复或删除）',
          },
        ],
      }
    }
    if (!loaded.path) {
      // 项目根缺失 / sessionId 非法：没有可写路径，按读取错误原样返回。
      return { ok: false, written: false, config: loaded.config, errors: loaded.errors }
    }
    /** 非致命告警（未知字段等）：照常写入，但如实带回，不假装文件完全干净。 */
    const inheritedErrors = [...loaded.errors]
    if (!isValidRoleId(roleId)) {
      return {
        ok: false,
        written: false,
        config: loaded.config,
        errors: [
          {
            code: SESSION_CONFIG_ERRORS.BAD_FIELD,
            roleId: typeof roleId === 'string' ? roleId : '',
            field: 'roleId',
            message: `角色 id 非法：${String(roleId)}`,
          },
        ],
      }
    }

    /** @type {any[]} */
    const errors = []
    const sanitized = sanitizeRolePatch(input?.patch, {
      roleId,
      path: `roleOverrides.${roleId}`,
      errors,
    })
    const { patch: diff, restored } = diffRoleOverride(input?.inherited ?? null, sanitized)

    const config = /** @type {import('./config.js').SessionConfig} */ ({
      ...loaded.config,
      roleOverrides: { ...loaded.config.roleOverrides },
    })
    const existing = config.roleOverrides[roleId] ?? {}
    let nextPatch = mergeRolePatch(existing, diff)
    for (const field of restored) nextPatch = removePatchField(nextPatch, field)
    if (isEmptyPatch(nextPatch)) delete config.roleOverrides[roleId]
    else config.roleOverrides[roleId] = nextPatch

    const unchanged = JSON.stringify(config) === JSON.stringify(loaded.config)
    if (unchanged) {
      return {
        ok: errors.length === 0,
        written: false,
        config,
        errors,
        warnings: inheritedErrors,
        patch: nextPatch,
      }
    }
    const written = await write(projectRoot, sessionId, config)
    return {
      ok: errors.length === 0,
      written: true,
      config,
      errors,
      warnings: inheritedErrors,
      patch: nextPatch,
      path: written.path,
    }
  }

  /**
   * 恢复继承：`field` 省略时删除整个角色的覆盖；否则只删该字段。
   * @param {unknown} projectRoot
   * @param {unknown} sessionId
   * @param {{ roleId: string, field?: string }} input
   */
  async function clearOverride(projectRoot, sessionId, input) {
    const roleId = input?.roleId
    const loaded = get(projectRoot, sessionId)
    if (loaded.corrupt) {
      return {
        ok: false,
        written: false,
        removed: false,
        config: loaded.config,
        errors: [
          ...loaded.errors,
          {
            code: SESSION_CONFIG_ERRORS.CORRUPT,
            message: '已有会话配置文件损坏，拒绝改写（请先手工修复或删除）',
          },
        ],
      }
    }
    if (!loaded.path) {
      return { ok: false, written: false, removed: false, config: loaded.config, errors: loaded.errors }
    }
    /** 非致命告警（未知字段等）：照常改写，但如实带回。 */
    const inheritedErrors = [...loaded.errors]
    if (!isValidRoleId(roleId)) {
      return {
        ok: false,
        written: false,
        removed: false,
        config: loaded.config,
        errors: [
          {
            code: SESSION_CONFIG_ERRORS.BAD_FIELD,
            roleId: typeof roleId === 'string' ? roleId : '',
            field: 'roleId',
            message: `角色 id 非法：${String(roleId)}`,
          },
        ],
      }
    }

    /** @type {any[]} */
    const errors = []
    const config = /** @type {import('./config.js').SessionConfig} */ ({
      ...loaded.config,
      roleOverrides: { ...loaded.config.roleOverrides },
    })
    const existing = config.roleOverrides[roleId]
    if (!existing) {
      return { ok: true, written: false, removed: false, config, errors, warnings: inheritedErrors }
    }

    if (input?.field === undefined || input?.field === null) {
      delete config.roleOverrides[roleId]
    } else {
      const field = normalizeFieldPath(input.field)
      if (!field) {
        errors.push({
          code: SESSION_CONFIG_ERRORS.INVALID_FIELD,
          roleId,
          field: String(input.field),
          message: `不支持的字段 ${String(input.field)}（可用：角色字段或 channel.model 这类通道字段）`,
        })
        return { ok: false, written: false, removed: false, config: loaded.config, errors }
      }
      const nextPatch = removePatchField(existing, field)
      if (isEmptyPatch(nextPatch)) delete config.roleOverrides[roleId]
      else config.roleOverrides[roleId] = nextPatch
    }

    if (JSON.stringify(config) === JSON.stringify(loaded.config)) {
      return { ok: true, written: false, removed: false, config, errors, warnings: inheritedErrors }
    }
    const written = await write(projectRoot, sessionId, config)
    return {
      ok: true,
      written: true,
      removed: true,
      config,
      errors,
      warnings: inheritedErrors,
      path: written.path,
    }
  }

  return { get, write, setOverride, clearOverride }
}

/** 生产环境用的 store（真读磁盘）。 */
export function createNodeSessionOverrideStore() {
  return createSessionOverrideStore()
}
