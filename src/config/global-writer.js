// @ts-check
/**
 * 全局配置（profile 的 `cordis.patch.yml` → 插件 `meetingstone` 行）写入（P0-S2）。
 *
 * 官方 API（已在本机 `app.asar` 核验，见 docs/audit/07-config-extension.md §3.4）：
 *
 * ```js
 * ctx.get('configEditor').edit(ctx.fiber.entry, (current) => nextConfig)
 * ```
 *
 * `dsh-config-editor` 的事实（`dsh-config-editor/lib/index.js:69-134`）：
 * - `change(current, inherited)` 同步返回**完整** raw config；`current` 是当前 entry 的
 *   `entry.options.config` 深拷贝（含用户手写的未知字段）。
 * - patch 是**整值替换**：只返回自己认识的字段会把未来字段/手写字段抹掉。
 *   因此本模块所有 mutation 都以 `current` 为底做不可变合并。
 * - 更高层（home patch / 命令行 overlay）覆盖时抛
 *   `Configuration for "..." is overridden by ...`；entry 失效会抛
 *   `Configuration entry is no longer available` / `changed during reload`。
 *   这些失败**必须透传**，不能静默当成功（P0-S2 验收）。
 * - 写入与 HMR 串行；本模块再把同一插件的多次保存按提交顺序排队。
 *
 * 边界：
 * - 不直接改 YAML 文件（绕过校验与 HMR 协调）
 * - 不做自动修复；拿不到 `configEditor` / entry 时返回明确错误码
 */

import { isValidRoleId } from '../roles/ids.js'
import { DEFAULT_ROLES, hasUserRoles } from '../roles/defaults.js'
import { CLI_PREFERENCE, applyCliPreference, isKnownCli } from '../cli/preferences.js'
import { sanitizeRolePatch } from '../session/config.js'

/** 错误码（带中文 message，可直接展示）。 */
export const GLOBAL_CONFIG_ERRORS = Object.freeze({
  EDITOR_UNAVAILABLE: 'GLOBAL_CONFIG_EDITOR_UNAVAILABLE',
  ENTRY_UNAVAILABLE: 'GLOBAL_CONFIG_ENTRY_UNAVAILABLE',
  INVALID_CLI: 'GLOBAL_CONFIG_INVALID_CLI',
  INVALID_PREFERENCE: 'GLOBAL_CONFIG_INVALID_PREFERENCE',
  INVALID_ROLE_ID: 'GLOBAL_CONFIG_INVALID_ROLE_ID',
  INVALID_ROLE_PATCH: 'GLOBAL_CONFIG_INVALID_ROLE_PATCH',
  ROLE_NOT_FOUND: 'GLOBAL_CONFIG_ROLE_NOT_FOUND',
  ROLE_EXISTS: 'GLOBAL_CONFIG_ROLE_EXISTS',
  OVERRIDDEN: 'GLOBAL_CONFIG_OVERRIDDEN',
  ENTRY_STALE: 'GLOBAL_CONFIG_ENTRY_STALE',
  ENTRY_INACTIVE: 'GLOBAL_CONFIG_ENTRY_INACTIVE',
  WRITE_FAILED: 'GLOBAL_CONFIG_WRITE_FAILED',
})

/** @param {unknown} value */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 取「可写副本」的角色列表，并补齐开箱即用的默认角色。
 *
 * ## 为什么需要这个函数（2026-11-14）
 *
 * 默认角色只存在于内存，磁盘上的 `roles` 是空的。如果用户直接编辑或删除
 * 一个默认角色（设置在界面上是看得见、可点的），写入器按 roleId 在磁盘数组里
 * 找不到它，就会报 `ROLE_NOT_FOUND` —— 用户看得见却改不了，违背开箱即用。
 *
 * 处理方式：写之前先把默认角色**物化**进当前角色表（深拷贝，避免常量被改），
 * 这样「编辑/删除一个默认角色」就等价于「先落盘再改」，语义自然。
 * 注意只在写路径这样做：**读取**路径仍然只是内存注入，不会主动写盘。
 *
 * @param {any} current 当前全局配置
 * @returns {any[]} 可直接修改的角色数组（已拷贝）
 */
function currentRoleListForUpdate(current) {
  const raw = current && Array.isArray(current.roles) ? current.roles : []
  const copied = raw.map((role) => {
    if (!isPlainObject(role)) return role
    const next = { ...role }
    if (isPlainObject(role.channel)) next.channel = { ...role.channel }
    if (Array.isArray(role.aliases)) next.aliases = [...role.aliases]
    return next
  })
  // 用户已经配过角色：完全按用户的来，不掺默认值。
  if (hasUserRoles(copied)) return copied
  const existingIds = new Set(
    copied
      .filter(isPlainObject)
      .map((role) => (typeof role.roleId === 'string' ? role.roleId : ''))
      .filter(Boolean),
  )
  const materialized = DEFAULT_ROLES.filter((role) => !existingIds.has(role.roleId)).map((role) => ({
    ...role,
    aliases: [...role.aliases],
    channel: { ...role.channel },
  }))
  return [...copied, ...materialized]
}

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

/** 构造一个结果对象（永不抛到 Remote 边界，由调用方决定如何展示）。 */
function fail(code, message) {
  return { ok: false, code, message }
}

/**
 * 把 configEditor 抛出的错误映射成稳定错误码。
 * @param {unknown} error
 */
function classifyEditorError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/overridden by a home patch or command-line overlay/i.test(message)) {
    return { code: GLOBAL_CONFIG_ERRORS.OVERRIDDEN, message }
  }
  if (/no longer available|changed during reload/i.test(message)) {
    return { code: GLOBAL_CONFIG_ERRORS.ENTRY_STALE, message }
  }
  if (/no longer active|not active/i.test(message)) {
    return { code: GLOBAL_CONFIG_ERRORS.ENTRY_INACTIVE, message }
  }
  return { code: GLOBAL_CONFIG_ERRORS.WRITE_FAILED, message }
}

/**
 * 创建全局配置写入器。
 *
 * @param {{
 *   getConfigEditor?: () => any,
 *   getEntry?: () => any,
 *   log?: (level: 'info' | 'warn' | 'error', line: string) => void,
 * }} [deps]
 */
export function createGlobalConfigWriter(deps = {}) {
  const getConfigEditor = deps.getConfigEditor ?? (() => undefined)
  const getEntry = deps.getEntry ?? (() => undefined)
  const log = deps.log

  /** 同一插件的保存按提交顺序串行（对齐官方 AgentDefaultModelConfig 的 saves 链）。 */
  let chain = Promise.resolve()

  /** @param {() => any} reader */
  function safeRead(reader) {
    try {
      return reader()
    } catch {
      return undefined
    }
  }

  /**
   * 在一次 `configEditor.edit` 里应用不可变变更。
   *
   * @param {(current: Record<string, any>) => Record<string, any>} mutate 必须同步、不可变
   * @returns {Promise<any>}
   */
  function update(mutate) {
    const run = async () => {
      const editor = safeRead(getConfigEditor)
      if (!editor || typeof editor.edit !== 'function') {
        return fail(GLOBAL_CONFIG_ERRORS.EDITOR_UNAVAILABLE, '宿主没有配置编辑器（configEditor），无法写全局配置')
      }
      const entry = safeRead(getEntry)
      if (!entry) {
        return fail(GLOBAL_CONFIG_ERRORS.ENTRY_UNAVAILABLE, '当前插件没有可写的 profile 配置行（entry 不可用）')
      }

      /** @type {Record<string, any> | undefined} */
      let nextConfig
      let changed = false
      try {
        await editor.edit(entry, (current) => {
          const base = isPlainObject(current) ? /** @type {Record<string, any>} */ (structuredClone(current)) : {}
          nextConfig = mutate(base)
          changed = !deepEqual(nextConfig, base)
          return nextConfig
        })
      } catch (error) {
        const errorCode = /** @type {any} */ (error)?.code
        const message = error instanceof Error ? error.message : String(error)
        if (
          typeof errorCode === 'string' &&
          Object.values(GLOBAL_CONFIG_ERRORS).includes(/** @type {any} */ (errorCode))
        ) {
          // mutation 自己抛出的业务错误（如角色不存在）：保留稳定 code。
          return fail(errorCode, message)
        }
        const classified = classifyEditorError(error)
        log?.('error', `[meetingstone] global config write failed: ${classified.code} ${classified.message}`)
        return fail(classified.code, classified.message)
      }

      if (nextConfig === undefined) {
        return fail(GLOBAL_CONFIG_ERRORS.WRITE_FAILED, '配置编辑器没有应用变更（change 未被调用）')
      }
      return {
        ok: true,
        written: changed,
        idempotent: !changed,
        config: nextConfig,
      }
    }

    const next = chain.then(run, run)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 写一个外部 CLI 的显式偏好。
   * `preference` 省略或传 `'unset'` 表示删除该键（恢复 unset）。
   *
   * @param {string} cli
   * @param {'enabled' | 'disabled' | 'unset'} [preference]
   */
  async function setCliPreference(cli, preference = CLI_PREFERENCE.UNSET) {
    if (!isKnownCli(cli)) {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_CLI, `未知的外部 CLI：${String(cli)}`)
    }
    if (!Object.values(CLI_PREFERENCE).includes(/** @type {any} */ (preference))) {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_PREFERENCE, `非法的 CLI 偏好：${String(preference)}`)
    }
    return update((current) => applyCliPreference(current, cli, preference))
  }

  /**
   * 改一个全局角色的字段（字段级合并；`channel` 按字段合并）。
   *
   * @param {string} roleId
   * @param {Record<string, any>} patch
   */
  async function updateRole(roleId, patch) {
    if (!isValidRoleId(roleId)) {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_ROLE_ID, `角色 id 不合法：${String(roleId)}`)
    }
    if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH, '角色补丁必须是非空 JSON 对象')
    }
    if (Object.hasOwn(patch, 'roleId') && patch.roleId !== roleId) {
      return fail(
        GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH,
        `补丁里的 roleId（${String(patch.roleId)}）与目标角色（${roleId}）不一致`,
      )
    }
    /** @type {any[]} */
    const errors = []
    const sanitized = sanitizeRolePatch(patch, { roleId, path: `roles.${roleId}`, errors })
    if (errors.length > 0) {
      return fail(
        GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH,
        errors.map((error) => error.message).join('；'),
      )
    }

    return update((current) => {
      const roles = currentRoleListForUpdate(current)
      const index = roles.findIndex((role) => isPlainObject(role) && role.roleId === roleId)
      if (index < 0) {
        throw Object.assign(new Error(`全局角色不存在：${roleId}`), {
          code: GLOBAL_CONFIG_ERRORS.ROLE_NOT_FOUND,
        })
      }
      const existing = /** @type {Record<string, any>} */ (roles[index])
      /** @type {Record<string, any>} */
      const merged = { ...existing, ...sanitized }
      if (sanitized.channel && isPlainObject(existing.channel)) {
        merged.channel = { ...existing.channel, ...sanitized.channel }
      }
      roles[index] = merged
      return { ...current, roles }
    })
  }

  /**
   * 开/关一个全局角色。
   * @param {string} roleId
   * @param {boolean} enabled
   */
  async function setRoleEnabled(roleId, enabled) {
    if (typeof enabled !== 'boolean') {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH, 'enabled 必须是布尔值')
    }
    return updateRole(roleId, { enabled })
  }

  /**
   * 新增一个全局角色（B1b）。与 updateRole 共用同一 `configEditor.edit` 写路径；
   * roleId 由调用方生成（`role-<slug>`，冲突由调用方加序号），这里只做合法性/唯一性校验。
   *
   * @param {Record<string, any>} input 新角色对象（roleId/name/aliases/setting/channel…）
   */
  async function createRole(input) {
    if (!isPlainObject(input)) {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH, '新角色必须是 JSON 对象')
    }
    const roleId = input.roleId
    if (!isValidRoleId(roleId)) {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_ROLE_ID, `角色 id 不合法：${String(roleId)}`)
    }
    /** @type {any[]} */
    const errors = []
    const sanitized = sanitizeRolePatch(input, { roleId, path: `roles.${roleId}`, errors })
    if (errors.length > 0) {
      return fail(
        GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH,
        errors.map((error) => error.message).join('；'),
      )
    }
    if (typeof sanitized.name !== 'string' || !sanitized.name.trim()) {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_ROLE_PATCH, '新角色必须有名称 name')
    }

    return update((current) => {
      // 与 updateRole/deleteRole 同一套角色表语义：默认角色已物化，
      // 因此「新增一个与默认角色同 ID 的角色」会正确报 ROLE_EXISTS 而不是产生重复。
      const roles = currentRoleListForUpdate(current)
      if (roles.some((role) => isPlainObject(role) && role.roleId === roleId)) {
        throw Object.assign(new Error(`全局角色已存在：${roleId}`), {
          code: GLOBAL_CONFIG_ERRORS.ROLE_EXISTS,
        })
      }
      // 默认值与 RoleSchema 对齐：aliases [] / setting '' / enabled true；
      // channel 由调用方按 CLI→模型→强度解析出的组合传入（不在这里猜）。
      const nextRole = {
        roleId,
        aliases: [],
        setting: '',
        enabled: true,
        ...sanitized,
        roleId,
      }
      roles.push(nextRole)
      return { ...current, roles }
    })
  }

  /**
   * 删除一个全局角色（B1b）。只删 profile 里的全局定义；
   * **不**清理会话 `roleOverrides`（无跨会话枚举能力，删除前由 UI 二次确认并提示）。
   *
   * @param {string} roleId
   */
  async function deleteRole(roleId) {
    if (!isValidRoleId(roleId)) {
      return fail(GLOBAL_CONFIG_ERRORS.INVALID_ROLE_ID, `角色 id 不合法：${String(roleId)}`)
    }
    return update((current) => {
      const roles = currentRoleListForUpdate(current)
      const index = roles.findIndex((role) => isPlainObject(role) && role.roleId === roleId)
      if (index < 0) {
        throw Object.assign(new Error(`全局角色不存在：${roleId}`), {
          code: GLOBAL_CONFIG_ERRORS.ROLE_NOT_FOUND,
        })
      }
      roles.splice(index, 1)
      return { ...current, roles }
    })
  }

  return { update, setCliPreference, updateRole, setRoleEnabled, createRole, deleteRole }
}
