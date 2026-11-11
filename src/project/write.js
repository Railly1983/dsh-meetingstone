// @ts-check
/**
 * 项目级配置（`.meetingstone.json`）的**受限写入**（P0-S2）。
 *
 * 边界（对应 Kimi 拆解 §C P0-S2 与 docs/design/global-config.md §5.4）：
 * - 只允许写白名单字段；未知/不可写字段**拒绝并报错**，不静默丢弃
 * - **整值替换不丢未知字段**：写入前保留文件里所有未知顶层键，以及角色/覆盖对象里
 *   的未知键；只覆盖本次 patch 明确给出的字段
 * - 文件坏（JSON 非法 / 不是对象）时**拒绝覆盖**（fail-safe，不吞用户手写内容）
 * - IO 可注入，便于单测；原子写（tmp + rename）
 * - 不做自动修复，不向上找 `.git`
 *
 * 白名单（与 `src/project/config-file.js` 的 schema 对齐）：
 * - 顶层：`defaultRoleId` / `dispatchNotes` / `projectRules` / `roles` / `roleOverrides`
 * - 角色 / `roleOverrides` 内的字段：复用 `sanitizeRolePatch`（与全局/会话同一份白名单）
 *
 * `version` 刻意不可写：文件 schema 版本由代码维护，不接受外部 patch。
 */

import { promises as fs, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isValidRoleId } from '../roles/ids.js'
import { SESSION_CONFIG_ERRORS, sanitizeRolePatch } from '../session/config.js'
import { PROJECT_CONFIG_FILENAME } from './config-file.js'

/** 错误码（带中文 message，可直接展示）。 */
export const PROJECT_WRITE_ERRORS = Object.freeze({
  PATH_UNKNOWN: 'PROJECT_WRITE_PATH_UNKNOWN',
  READ_FAILED: 'PROJECT_WRITE_READ_FAILED',
  INVALID_JSON: 'PROJECT_WRITE_INVALID_JSON',
  NOT_OBJECT: 'PROJECT_WRITE_NOT_OBJECT',
  UNKNOWN_FIELD: 'PROJECT_WRITE_UNKNOWN_FIELD',
  INVALID_VALUE: 'PROJECT_WRITE_INVALID_VALUE',
  WRITE_FAILED: 'PROJECT_WRITE_WRITE_FAILED',
})

/** 允许写入的顶层字段。 */
export const PROJECT_WRITABLE_FIELDS = Object.freeze([
  'defaultRoleId',
  'dispatchNotes',
  'projectRules',
  'roles',
  'roleOverrides',
])

/** @param {unknown} value */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** @param {unknown} a @param {unknown} b */
function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        deepEqual(/** @type {any} */ (a)[key], /** @type {any} */ (b)[key]),
    )
  }
  return false
}

/** @param {string} field @param {string} message */
function bad(field, message) {
  return { code: PROJECT_WRITE_ERRORS.INVALID_VALUE, field, message }
}

/**
 * 把 `sanitizeRolePatch` 的错误码映射到项目写入的错误码，避免把会话层错误码
 * 漏给项目配置的调用方。
 * @param {any[]} patchErrors
 */
function mapRolePatchErrors(patchErrors) {
  return patchErrors.map((error) => ({
    code:
      error?.code === SESSION_CONFIG_ERRORS.UNKNOWN_FIELD
        ? PROJECT_WRITE_ERRORS.UNKNOWN_FIELD
        : PROJECT_WRITE_ERRORS.INVALID_VALUE,
    field: error?.field,
    message: error?.message ?? '角色补丁不合法',
  }))
}

/**
 * 纯函数：把白名单 patch 应用到原始项目配置对象上。
 *
 * @param {unknown} raw 文件解析出来的原始对象（保留未知字段）
 * @param {unknown} patch 只允许 `PROJECT_WRITABLE_FIELDS`
 * @returns {{ ok: true, config: Record<string, any> } | { ok: false, config: Record<string, any>, errors: any[] }}
 */
export function applyProjectPatch(raw, patch) {
  const base = isPlainObject(raw) ? /** @type {Record<string, any>} */ (structuredClone(raw)) : {}
  /** @type {any[]} */
  const errors = []

  if (!isPlainObject(patch)) {
    return {
      ok: false,
      config: base,
      errors: [{ code: PROJECT_WRITE_ERRORS.INVALID_VALUE, field: 'patch', message: 'patch 必须是 JSON 对象' }],
    }
  }

  const input = /** @type {Record<string, any>} */ (patch)
  for (const key of Object.keys(input)) {
    if (!PROJECT_WRITABLE_FIELDS.includes(key)) {
      errors.push({
        code: PROJECT_WRITE_ERRORS.UNKNOWN_FIELD,
        field: key,
        message: `项目配置不允许写字段 ${key}（只允许：${PROJECT_WRITABLE_FIELDS.join(', ')}）`,
      })
    }
  }
  if (errors.length > 0) return { ok: false, config: base, errors }

  const next = base
  if (!Object.hasOwn(next, 'version')) next.version = 1

  if (Object.hasOwn(input, 'defaultRoleId')) {
    const value = input.defaultRoleId
    if (value === null) {
      delete next.defaultRoleId
    } else if (typeof value === 'string' && value.trim()) {
      next.defaultRoleId = value.trim()
    } else {
      errors.push(bad('defaultRoleId', 'defaultRoleId 必须是非空字符串或 null'))
    }
  }

  if (Object.hasOwn(input, 'dispatchNotes')) {
    if (typeof input.dispatchNotes === 'string') next.dispatchNotes = input.dispatchNotes
    else errors.push(bad('dispatchNotes', 'dispatchNotes 必须是字符串'))
  }

  if (Object.hasOwn(input, 'projectRules')) {
    if (Array.isArray(input.projectRules) && input.projectRules.every((rule) => typeof rule === 'string')) {
      next.projectRules = [...input.projectRules]
    } else {
      errors.push(bad('projectRules', 'projectRules 必须是字符串数组'))
    }
  }

  if (Object.hasOwn(input, 'roleOverrides')) {
    if (!isPlainObject(input.roleOverrides)) {
      errors.push(bad('roleOverrides', 'roleOverrides 必须是对象'))
    } else {
      const existing = isPlainObject(next.roleOverrides)
        ? /** @type {Record<string, any>} */ (structuredClone(next.roleOverrides))
        : {}
      for (const [roleId, rolePatch] of Object.entries(input.roleOverrides)) {
        if (!isValidRoleId(roleId)) {
          errors.push(bad(`roleOverrides.${roleId}`, `角色 id 不合法：${roleId}`))
          continue
        }
        if (!isPlainObject(rolePatch)) {
          errors.push(bad(`roleOverrides.${roleId}`, '角色覆盖必须是 JSON 对象'))
          continue
        }
        /** @type {any[]} */
        const patchErrors = []
        const sanitized = sanitizeRolePatch(rolePatch, {
          roleId,
          path: `roleOverrides.${roleId}`,
          errors: patchErrors,
        })
        if (patchErrors.length > 0) {
          errors.push(...mapRolePatchErrors(patchErrors))
          continue
        }
        // 关键：以磁盘上的原始对象为底，保留未知字段。
        existing[roleId] = { ...(isPlainObject(existing[roleId]) ? existing[roleId] : {}), ...sanitized }
      }
      next.roleOverrides = existing
    }
  }

  if (Object.hasOwn(input, 'roles')) {
    if (!Array.isArray(input.roles)) {
      errors.push(bad('roles', 'roles 必须是数组'))
    } else {
      const existingRoles = Array.isArray(next.roles) ? /** @type {any[]} */ (structuredClone(next.roles)) : []
      const byId = new Map()
      existingRoles.forEach((role, index) => {
        if (isPlainObject(role) && typeof role.roleId === 'string') byId.set(role.roleId, index)
      })
      for (const [index, role] of input.roles.entries()) {
        if (!isPlainObject(role)) {
          errors.push(bad(`roles[${index}]`, '角色必须是 JSON 对象'))
          continue
        }
        const roleId = role.roleId
        if (!isValidRoleId(roleId)) {
          errors.push(bad(`roles[${index}].roleId`, `角色 id 不合法：${String(roleId)}`))
          continue
        }
        /** @type {any[]} */
        const patchErrors = []
        const sanitized = sanitizeRolePatch(role, { roleId, path: `roles[${index}]`, errors: patchErrors })
        if (patchErrors.length > 0) {
          errors.push(...mapRolePatchErrors(patchErrors))
          continue
        }
        const found = byId.get(roleId)
        if (found === undefined) {
          if (!sanitized.name) {
            errors.push(bad(`roles[${index}].name`, '新增项目角色必须提供 name'))
            continue
          }
          byId.set(roleId, existingRoles.length)
          existingRoles.push({ ...sanitized, roleId })
          continue
        }
        const previous = isPlainObject(existingRoles[found]) ? existingRoles[found] : {}
        const merged = { ...previous, ...sanitized, roleId }
        if (sanitized.channel && isPlainObject(previous.channel)) {
          merged.channel = { ...previous.channel, ...sanitized.channel }
        }
        existingRoles[found] = merged
      }
      next.roles = existingRoles
    }
  }

  if (errors.length > 0) return { ok: false, config: base, errors }
  return { ok: true, config: next }
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
 * 创建项目配置写入器。
 *
 * @param {{
 *   readText?: (path: string) => string,
 *   writeText?: (path: string, text: string) => Promise<void>,
 *   renameFile?: (from: string, to: string) => Promise<void>,
 *   removeFile?: (path: string) => Promise<void>,
 *   ensureDir?: (dir: string) => Promise<void>,
 *   onWrite?: (path: string) => void,
 * }} [deps]
 */
export function createProjectConfigWriter(deps = {}) {
  const readText = deps.readText ?? ((path) => readFileSync(path, 'utf8'))
  const writeText = deps.writeText ?? ((path, text) => fs.writeFile(path, text, 'utf8'))
  const renameFile = deps.renameFile ?? ((from, to) => fs.rename(from, to))
  const removeFile = deps.removeFile ?? ((path) => fs.rm(path, { force: true }))
  const ensureDir = deps.ensureDir ?? ((dir) => fs.mkdir(dir, { recursive: true }))
  const onWrite = deps.onWrite

  /**
   * 写一次项目配置 patch。
   *
   * @param {unknown} projectRoot
   * @param {Record<string, any>} patch
   * @param {string} [fileName]
   * @returns {Promise<any>}
   */
  async function update(projectRoot, patch, fileName = PROJECT_CONFIG_FILENAME) {
    if (typeof projectRoot !== 'string' || !projectRoot) {
      return {
        ok: false,
        code: PROJECT_WRITE_ERRORS.PATH_UNKNOWN,
        message: '无法确定项目根目录，拒绝写项目配置',
      }
    }
    const path = join(projectRoot, fileName)

    let text = ''
    let exists = false
    try {
      text = readText(path)
      exists = true
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') {
        return {
          ok: false,
          code: PROJECT_WRITE_ERRORS.READ_FAILED,
          message: `读取项目配置失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    /** @type {unknown} */
    let raw
    if (exists) {
      try {
        raw = JSON.parse(text)
      } catch (error) {
        return {
          ok: false,
          code: PROJECT_WRITE_ERRORS.INVALID_JSON,
          message: `项目配置不是合法 JSON，拒绝覆盖：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      if (!isPlainObject(raw)) {
        return {
          ok: false,
          code: PROJECT_WRITE_ERRORS.NOT_OBJECT,
          message: '项目配置必须是 JSON 对象，拒绝覆盖',
        }
      }
    }

    const applied = applyProjectPatch(raw, patch)
    if (!applied.ok) {
      return { ok: false, code: applied.errors[0]?.code ?? PROJECT_WRITE_ERRORS.INVALID_VALUE, errors: applied.errors, message: applied.errors[0]?.message ?? '项目配置写入被拒绝' }
    }

    const before = exists ? /** @type {Record<string, any>} */ (raw) : { version: 1 }
    if (deepEqual(applied.config, before)) {
      return {
        ok: true,
        written: false,
        idempotent: true,
        config: applied.config,
        path,
      }
    }

    const payload = `${JSON.stringify(applied.config, null, 2)}\n`
    const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
    try {
      await ensureDir(dirname(path))
      await writeText(temp, payload)
      await renameWithRetry(renameFile, temp, path)
    } catch (error) {
      await removeFile(temp).catch(() => {})
      return {
        ok: false,
        code: PROJECT_WRITE_ERRORS.WRITE_FAILED,
        message: `写项目配置失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    onWrite?.(path)
    return {
      ok: true,
      written: true,
      idempotent: false,
      config: applied.config,
      path,
      bytes: Buffer.byteLength(payload, 'utf8'),
    }
  }

  /**
   * 改一个项目级角色覆盖（`roleOverrides[roleId]`）。
   * @param {unknown} projectRoot
   * @param {string} roleId
   * @param {Record<string, any>} patch
   * @param {string} [fileName]
   */
  async function setRoleOverride(projectRoot, roleId, patch, fileName) {
    if (!isValidRoleId(roleId)) {
      return {
        ok: false,
        code: PROJECT_WRITE_ERRORS.INVALID_VALUE,
        message: `角色 id 不合法：${String(roleId)}`,
      }
    }
    return update(projectRoot, { roleOverrides: { [roleId]: patch } }, fileName)
  }

  return { update, setRoleOverride }
}

/** 生产环境用的写入器（真读磁盘）。 */
export function createNodeProjectConfigWriter(deps = {}) {
  return createProjectConfigWriter(deps)
}
