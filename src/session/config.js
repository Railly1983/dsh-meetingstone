// @ts-check
/**
 * 会话级配置（session 覆盖）的纯逻辑：白名单、规范化、差异计算与三层继承。
 *
 * ⚠️ 暂不接入客户端（2026-11-11）：会话级编辑 GUI 的带参 Remote 被宿主 Gateway
 * 的 strict codec 校验拒绝（真机错误见 docs/gui-0.2.0.md §6），本模块仍被派单时的
 * 会话配置解析使用，但不再经由 GUI 写入。
 *
 * 继承顺序：全局（profile 的 `meetingstone` 行）→ 项目（`.meetingstone.json`）
 * → 当前会话（本文件处理的那一层）。会话层**只影响当前 Session**：
 * B3 已下线会话级文件存储与 GUI 读写路径；本模块只保留纯合并能力（无生产调用方传入 session）。
 *
 * 边界（勿破坏）：
 * - 纯函数：不读文件、不碰宿主 API；本文件**不含任何 IO**（B3 已删除 `store.js`，
 *   会话覆盖的持久化路径不存在了）
 * - 只接受白名单字段；未知字段**拒绝并报错**，不静默生效
 * - 会话层只保存差异：值等于继承值时不写入
 * - 不做别名冲突判定：生效角色表交给 `createRegistry()`，冲突在那里统一报告
 *
 * 为什么不用宿主的 session 级存储（2026-11-11 查阅宿主 0.2.2-rc.1 的实际 API）：
 * - `@deepseek-ai/dsh-session` 的 `SessionHeader` 是创建时快照并深冻结的元数据
 *   （仅 `cwd` 等），没有插件可写的 per-session KV；会话日志是事件溯源，
 *   `appendPluginRecord()` 只允许仓库内 experimental 包调用，外部插件不得使用。
 * - `@deepseek-ai/dsh-storage-domain` 是宿主侧 KV，但需要 `defineDomain` + zod
 *   schema，本插件是**零依赖**的（见 src/schema.js 的设计说明），且该服务不是
 *   所有 composition 都挂载。
 * 因此曾退化为项目内 `.meetingstone/sessions/<sessionId>.json`（历史说明：该路径的
 * 读写代码已随 B3 整体下线，`src/` 下无任何代码再读它；局限见 docs/configuration.md）。
 */
import { isValidRoleId } from '../roles/ids.js'
import { CHANNEL_KINDS, createRegistry } from '../roles/registry.js'
import { toRegistryInput } from '../project/config-file.js'

/** 会话配置文件的 schema 版本。 */
export const SESSION_CONFIG_VERSION = 1

/** 会话配置允许的顶层字段（未知字段会被拒绝）。 */
export const SESSION_CONFIG_KEYS = Object.freeze([
  'version',
  'roles',
  'roleOverrides',
  'defaultRoleId',
  'dispatchNotes',
  'projectRules',
])

/** 会话覆盖允许的角色字段（别名用 `alias` 或 `aliases` 都行；
 *  B2：`setting` 是合并后的唯一设定字段，description/prompt 仅作旧字段迁移入口）。 */
export const ROLE_PATCH_KEYS = Object.freeze([
  'roleId',
  'name',
  'alias',
  'aliases',
  'setting',
  'description',
  'prompt',
  'channel',
  'enabled',
  'fallbackRoleId',
  'timeoutMs',
])

/** 会话覆盖允许的通道字段：CLI、模型、思考强度都只能改这里。 */
export const CHANNEL_PATCH_KEYS = Object.freeze([
  'kind',
  'channelId',
  'provider',
  'cli',
  'model',
  'reasoning',
])

/** 角色级字段（sources 用；别名统一记作 `aliases`）。
 *  B2：description/prompt 已合并进 setting，不再作为独立来源字段（旧字段只在写入时迁移）。 */
export const ROLE_SOURCE_FIELDS = Object.freeze([
  'name',
  'aliases',
  'setting',
  'enabled',
  'fallbackRoleId',
  'timeoutMs',
])

/** 通道字段（sources 里记作 `channel.<key>`）。 */
export const CHANNEL_SOURCE_FIELDS = Object.freeze([...CHANNEL_PATCH_KEYS])

/** 错误码（全部带中文可读 message，直接可展示）。 */
export const SESSION_CONFIG_ERRORS = Object.freeze({
  NOT_OBJECT: 'SESSION_CONFIG_NOT_OBJECT',
  UNSUPPORTED_VERSION: 'SESSION_CONFIG_UNSUPPORTED_VERSION',
  UNKNOWN_FIELD: 'SESSION_CONFIG_UNKNOWN_FIELD',
  BAD_FIELD: 'SESSION_CONFIG_BAD_FIELD',
  INVALID_JSON: 'SESSION_CONFIG_INVALID_JSON',
  READ_FAILED: 'SESSION_CONFIG_READ_FAILED',
  WRITE_FAILED: 'SESSION_CONFIG_WRITE_FAILED',
  CORRUPT: 'SESSION_CONFIG_CORRUPT',
  INVALID_FIELD: 'SESSION_CONFIG_INVALID_FIELD',
  INVALID_SESSION_ID: 'SESSION_CONFIG_INVALID_SESSION_ID',
  PROJECT_ROOT_UNKNOWN: 'PROJECT_ROOT_UNKNOWN',
})

/**
 * @typedef {object} SessionConfig
 * @property {number} version
 * @property {object[]} roles 会话内新增/覆盖的角色定义
 * @property {Record<string, object>} roleOverrides 按 roleId 的字段级补丁
 * @property {string | undefined} defaultRoleId
 * @property {string | undefined} dispatchNotes
 * @property {string[]} projectRules
 */

/**
 * @typedef {object} SessionSourceMap
 * @property {'global' | 'project' | 'session' | 'default'} layer 角色整体来源
 * @property {Record<string, string>} [fields]
 */

/** @param {unknown} v */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 空配置（文件不存在或不可用时使用；undefined 字段表示"未覆盖"）。 */
export function emptySessionConfig() {
  return /** @type {SessionConfig} */ ({
    version: SESSION_CONFIG_VERSION,
    roles: [],
    roleOverrides: {},
    defaultRoleId: undefined,
    dispatchNotes: undefined,
    projectRules: [],
  })
}

/**
 * 深比较（只看可 JSON 化的值；数组按顺序）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
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

/**
 * 规范化别名字段：字符串 → 单元素数组；过滤空串、去重、保持顺序。
 * 非法输入返回 null（由调用方报 BAD_FIELD）。
 * @param {unknown} value
 * @returns {string[] | null}
 */
function readAliases(value) {
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list)) return null
  /** @type {string[]} */
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') return null
    const trimmed = item.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * 清洗一个角色补丁：只保留白名单字段，类型不对的字段丢弃并报错。
 * 返回的对象可直接交给 `mergeRole` 使用（未知键已剔除，`alias` 已映射为 `aliases`）。
 *
 * @param {unknown} raw
 * @param {{ roleId?: string, path?: string, errors?: any[] }} [options]
 * @returns {Record<string, any>}
 */
export function sanitizeRolePatch(raw, options = {}) {
  const roleId = options.roleId ?? ''
  const path = options.path ?? (roleId ? `roleOverrides.${roleId}` : 'role')
  const errors = options.errors
  /** @type {Record<string, any>} */
  const out = {}
  if (!isPlainObject(raw)) {
    errors?.push({
      code: SESSION_CONFIG_ERRORS.BAD_FIELD,
      roleId,
      field: path,
      message: '角色覆盖必须是 JSON 对象，已忽略',
    })
    return out
  }

  const input = /** @type {Record<string, unknown>} */ (raw)
  /** @param {string} field @param {string} message */
  const bad = (field, message) => {
    errors?.push({
      code: SESSION_CONFIG_ERRORS.BAD_FIELD,
      roleId,
      field: `${path}.${field}`,
      message,
    })
  }

  const hasAliases = Object.hasOwn(input, 'aliases')
  const hasAlias = Object.hasOwn(input, 'alias')
  if (hasAliases && hasAlias) bad('alias', '`alias` 与 `aliases` 只能写一个，已忽略 `alias`')

  for (const [key, value] of Object.entries(input)) {
    if (key === 'roleId' || key === 'aliases' || key === 'alias') continue

    if (!ROLE_PATCH_KEYS.includes(key)) {
      errors?.push({
        code: SESSION_CONFIG_ERRORS.UNKNOWN_FIELD,
        roleId,
        field: `${path}.${key}`,
        message: `不支持的会话覆盖字段 ${key}，已拒绝`,
      })
      continue
    }

    if (key === 'channel') {
      if (!isPlainObject(value)) {
        bad('channel', 'channel 必须是 JSON 对象，已忽略')
        continue
      }
      /** @type {Record<string, string>} */
      const channel = {}
      for (const [channelKey, channelValue] of Object.entries(value)) {
        if (!CHANNEL_PATCH_KEYS.includes(channelKey)) {
          errors?.push({
            code: SESSION_CONFIG_ERRORS.UNKNOWN_FIELD,
            roleId,
            field: `${path}.channel.${channelKey}`,
            message: `不支持的通道字段 ${channelKey}，已拒绝`,
          })
          continue
        }
        if (channelKey === 'kind') {
          if (typeof channelValue === 'string' && CHANNEL_KINDS.includes(/** @type {any} */ (channelValue))) {
            channel.kind = channelValue
          } else {
            bad(`channel.kind`, `必须是 ${CHANNEL_KINDS.join(' | ')} 之一`)
          }
          continue
        }
        if (typeof channelValue === 'string' && channelValue.trim()) {
          channel[channelKey] = channelValue.trim()
        } else if (channelValue === null) {
          // 2026-11-16：`null` = 显式清空该通道字段。
          // 全局配置是字段合并（无法删键），如果不支持清空，改模型时会残留旧的
          // channelId，写出「channelId=旧实例 + model=新模型」的矛盾组合。
          // 写入器会在合并时删除这些键（见 global-writer.updateRole）。
          channel[channelKey] = null
        } else {
          bad(`channel.${channelKey}`, '必须是非空字符串或 null（null=清空该字段）')
        }
      }
      if (Object.keys(channel).length > 0) out.channel = channel
      continue
    }

    switch (key) {
      case 'name': {
        const name = typeof value === 'string' ? value.trim() : ''
        if (name) out.name = name
        else bad('name', '必须是非空字符串')
        break
      }
      case 'setting':
        if (typeof value === 'string') out.setting = value
        else bad('setting', '必须是字符串')
        break
      case 'description':
        // B2 迁移入口：旧字段统一写进 setting（不再维护两份）
        if (typeof value === 'string') out.setting = value
        else bad('description', '必须是字符串')
        break
      case 'prompt':
        // B2 迁移入口：旧 prompt 合并进 setting
        if (typeof value === 'string' && value.trim()) out.setting = value
        else bad('prompt', '必须是非空字符串（恢复继承请用 clearOverride）')
        break
      case 'enabled':
        if (typeof value === 'boolean') out.enabled = value
        else bad('enabled', '必须是布尔值')
        break
      case 'fallbackRoleId':
        if (value === null) out.fallbackRoleId = null
        else if (typeof value === 'string') out.fallbackRoleId = value.trim() || null
        else bad('fallbackRoleId', '必须是字符串或 null')
        break
      case 'timeoutMs':
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) out.timeoutMs = value
        else bad('timeoutMs', '必须是正数（毫秒）')
        break
      default:
        break
    }
  }

  const aliasValue = hasAliases ? input.aliases : input.alias
  if (hasAliases || hasAlias) {
    const aliases = readAliases(aliasValue)
    if (aliases === null) bad(hasAliases ? 'aliases' : 'alias', '必须是字符串或字符串数组')
    else out.aliases = aliases
  }

  return out
}

/**
 * 把任意 JSON 解析结果规范化为会话配置。
 * 未知字段 / 类型错误 → 字段级丢弃 + errors；版本不认识 → 整体降级。
 *
 * @param {unknown} raw
 * @returns {{ config: SessionConfig, errors: any[] }}
 */
export function normalizeSessionConfig(raw) {
  /** @type {any[]} */
  const errors = []
  const config = emptySessionConfig()

  if (raw === undefined || raw === null) return { config, errors }
  if (!isPlainObject(raw)) {
    errors.push({
      code: SESSION_CONFIG_ERRORS.NOT_OBJECT,
      message: '会话配置必须是 JSON 对象',
    })
    return { config, errors }
  }

  const input = /** @type {Record<string, any>} */ (raw)

  for (const key of Object.keys(input)) {
    if (!SESSION_CONFIG_KEYS.includes(key)) {
      errors.push({
        code: SESSION_CONFIG_ERRORS.UNKNOWN_FIELD,
        field: `session.${key}`,
        message: `不支持的会话配置字段 ${key}，已拒绝`,
      })
    }
  }

  if (input.version !== undefined && input.version !== SESSION_CONFIG_VERSION) {
    errors.push({
      code: SESSION_CONFIG_ERRORS.UNSUPPORTED_VERSION,
      field: 'version',
      message: `不支持的会话配置版本 ${JSON.stringify(input.version)}，当前只支持 ${SESSION_CONFIG_VERSION}`,
    })
    return { config, errors }
  }
  config.version = SESSION_CONFIG_VERSION

  if (input.roles !== undefined) {
    if (!Array.isArray(input.roles)) {
      errors.push({
        code: SESSION_CONFIG_ERRORS.BAD_FIELD,
        field: 'roles',
        message: 'roles 必须是数组，已忽略',
      })
    } else {
      input.roles.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          errors.push({
            code: SESSION_CONFIG_ERRORS.BAD_FIELD,
            field: `roles[${index}]`,
            message: '角色定义必须是对象，已跳过该项',
          })
          return
        }
        const roleId = typeof entry.roleId === 'string' ? entry.roleId : ''
        const patch = sanitizeRolePatch(entry, { roleId, path: `roles[${index}]`, errors })
        patch.roleId = entry.roleId
        config.roles.push(patch)
      })
    }
  }

  if (input.roleOverrides !== undefined) {
    if (!isPlainObject(input.roleOverrides)) {
      errors.push({
        code: SESSION_CONFIG_ERRORS.BAD_FIELD,
        field: 'roleOverrides',
        message: 'roleOverrides 必须是对象，已忽略',
      })
    } else {
      for (const [roleId, patch] of Object.entries(input.roleOverrides)) {
        if (!isValidRoleId(roleId)) {
          errors.push({
            code: SESSION_CONFIG_ERRORS.BAD_FIELD,
            roleId,
            field: `roleOverrides.${roleId}`,
            message: `roleOverrides 的键不是合法角色 id：${roleId}，已跳过`,
          })
          continue
        }
        config.roleOverrides[roleId] = sanitizeRolePatch(patch, {
          roleId,
          path: `roleOverrides.${roleId}`,
          errors,
        })
      }
    }
  }

  if (input.defaultRoleId !== undefined) {
    if (typeof input.defaultRoleId === 'string' && input.defaultRoleId.trim()) {
      config.defaultRoleId = input.defaultRoleId.trim()
    } else {
      errors.push({
        code: SESSION_CONFIG_ERRORS.BAD_FIELD,
        field: 'defaultRoleId',
        message: 'defaultRoleId 必须是非空字符串，已忽略',
      })
    }
  }

  if (input.dispatchNotes !== undefined) {
    if (typeof input.dispatchNotes === 'string') {
      config.dispatchNotes = input.dispatchNotes
    } else {
      errors.push({
        code: SESSION_CONFIG_ERRORS.BAD_FIELD,
        field: 'dispatchNotes',
        message: 'dispatchNotes 必须是字符串，已忽略',
      })
    }
  }

  if (input.projectRules !== undefined) {
    if (!Array.isArray(input.projectRules)) {
      errors.push({
        code: SESSION_CONFIG_ERRORS.BAD_FIELD,
        field: 'projectRules',
        message: 'projectRules 必须是字符串数组，已忽略',
      })
    } else {
      config.projectRules = input.projectRules.filter((rule) => typeof rule === 'string')
      if (config.projectRules.length !== input.projectRules.length) {
        errors.push({
          code: SESSION_CONFIG_ERRORS.BAD_FIELD,
          field: 'projectRules',
          message: 'projectRules 里非字符串项已丢弃',
        })
      }
    }
  }

  return { config, errors }
}

/**
 * 读一个字段的来源层（`global` / `project` / `session` / `default`）。
 *
 * `sources` 来自 `resolveEffectiveConfig().sources`。字段不存在或没有来源记录时
 * 按 `default` 处理——这正是「schema 默认值不等于用户显式偏好」的判定依据。
 *
 * @param {any} sources
 * @param {string} roleId
 * @param {string} [field] 角色字段或 `channel.<key>`
 * @returns {'global' | 'project' | 'session' | 'default'}
 */
export function fieldSource(sources, roleId, field = 'enabled') {
  const entry = sources && typeof sources === 'object' ? sources.roles?.[roleId] : null
  const fields = entry && typeof entry === 'object' ? entry.fields : null
  if (!fields || !Object.hasOwn(fields, field)) return 'default'
  const layer = fields[field]
  return layer === 'global' || layer === 'project' || layer === 'session' ? layer : 'default'
}

/** @param {any} raw @param {string} field */
function hasExplicit(raw, field) {
  if (!isPlainObject(raw)) return false
  if (field === 'aliases') return Object.hasOwn(raw, 'aliases') || Object.hasOwn(raw, 'alias')
  // B2：setting 的显式来源也包含旧字段（description/prompt 会在写入/读取时迁移）
  if (field === 'setting') {
    return Object.hasOwn(raw, 'setting') || Object.hasOwn(raw, 'description') || Object.hasOwn(raw, 'prompt')
  }
  return Object.hasOwn(raw, field)
}

/** @param {any} raw @param {string} key */
function hasExplicitChannel(raw, key) {
  return isPlainObject(raw?.channel) && Object.hasOwn(raw.channel, key)
}

/**
 * 计算两个已规范化角色之间的差异字段路径（session 覆盖来源用）。
 * @param {any} before
 * @param {any} after
 * @returns {Set<string>}
 */
function diffFieldPaths(before, after) {
  /** @type {Set<string>} */
  const changed = new Set()
  for (const field of ROLE_SOURCE_FIELDS) {
    if (!deepEqual(before?.[field], after?.[field])) changed.add(field)
  }
  for (const key of CHANNEL_SOURCE_FIELDS) {
    if (!deepEqual(before?.channel?.[key], after?.channel?.[key])) changed.add(`channel.${key}`)
  }
  return changed
}

/**
 * 解析配置，返回生效角色表与每个字段的来源。
 *
 * ── B3 之后：角色配置只有**全局一层** ──────────────────────────────────
 * 用户 2026-11-12 决定：本插件只有全局角色设定，没有项目级/会话级角色覆盖。
 *
 * 但本函数**历史上**支持过三层合并（global + project + session），那套代码还在，
 * 且实测仍然有效（传 `project: { roleOverrides: { 'role-a': { name: 'X' } } }`
 * 会把角色改名）。当前之所以「不生效」，**仅仅因为 src/index.js 的两个调用点
 * 都不传 `project`** —— 这是靠调用方纪律，不是代码保证。
 *
 * 这种「死代码但活的」状态是隐患（产品体验复核 2026-11-12 抓到）：
 * 任何人给调用点加上一个 `project:` 参数，项目覆盖就会**悄悄生效**，
 * 与用户的决定矛盾，且不会有任何报错。
 *
 * 因此这里加一道显式闸：传了 `project` 且其中含角色相关内容时，**记录一条
 * 明确的错误**（`PROJECT_ROLES_NOT_SUPPORTED`），而不是静默应用。
 * 调用方可以据此立刻发现「有人在用已下线的能力」。
 *
 * `project` 里的**非角色**字段（projectRules / dispatchNotes）仍然允许读 ——
 * 项目文件继续承载这些。
 *
 * @param {object} [input]
 * @param {object} [input.global] 全局插件配置（roles/channels/defaultRoleId/dispatchNotes）
 * @param {object | object[]} [input.globalRaw] 规范化前的全局原始配置；用于判断
 *   `enabled` 等字段是「用户显式写的」还是「schema 默认值填的」。省略时退回 `global`。
 *   生产入口（src/index.js）必须在 `Config()` 之前保留原始配置并传入，否则默认值会被
 *   误标成 `global`，`userPreference` 就无法区分 unset 与 enabled。
 * @param {object} [input.project] 项目配置。**角色相关字段（roles/roleOverrides）
 *   自 B3 起不再支持**，传入会被忽略并记录 `PROJECT_ROLES_NOT_SUPPORTED` 错误。
 * @param {object} [input.session] 会话配置。**自 B3 起不再支持**，传入会被忽略并
 *   记录 `SESSION_ROLES_NOT_SUPPORTED` 错误。
 * @returns {{ effective: object, sources: object, errors: any[] }}
 */
export function resolveEffectiveConfig({ global, project, session, globalRaw } = {}) {
  /** @type {any[]} */
  const errors = []
  const globalConfig = isPlainObject(global) ? /** @type {any} */ (global) : {}

  // B3（2026-11-12 用户决定）：角色配置只有全局一层。
  //
  // 这里**主动剥掉**项目/会话配置里的角色相关字段，而不是依赖「调用方别传」。
  // 原因：历史实现支持三层合并且仍然有效，靠纪律不传是脆弱的 ——
  // 任何人加一个 `project:` 参数就会悄悄让项目覆盖生效（产品体验复核抓到）。
  // 现在改为：剥掉 + 记录错误，让「有人在用已下线能力」立刻可见。
  const rawProject = isPlainObject(project) ? /** @type {any} */ (project) : {}
  const projectHasRoles =
    (Array.isArray(rawProject.roles) && rawProject.roles.length > 0) ||
    (isPlainObject(rawProject.roleOverrides) && Object.keys(rawProject.roleOverrides).length > 0)
  if (projectHasRoles) {
    errors.push({
      code: 'PROJECT_ROLES_NOT_SUPPORTED',
      message:
        'B3 之后本插件只有全局角色设定，项目级 roles/roleOverrides 已被忽略；请改到全局配置。',
    })
  }
  // 只保留非角色字段（projectRules / dispatchNotes 等仍由项目文件承载）。
  const projectConfig = isPlainObject(project)
    ? (() => {
        const { roles: _r, roleOverrides: _o, ...rest } = /** @type {any} */ (project)
        return rest
      })()
    : {}

  // B3：不再支持会话级角色覆盖。**连内容一起清空**，只记错误 ——
  // 早先只报错不清空，导致会话覆盖依然生效（被 B3 测试抓到）。
  const normalizedSession = normalizeSessionConfig(session)
  const rawSessionConfig = normalizedSession.config
  if (session !== undefined && session !== null) {
    errors.push({
      code: 'SESSION_ROLES_NOT_SUPPORTED',
      message: 'B3 之后不再支持会话级角色覆盖；传入的 session 配置已被忽略。',
    })
  }
  errors.push(...normalizedSession.errors)
  // 清空角色相关字段，但保留结构形状（下游会读 sessionConfig.roles 等）。
  const sessionConfig = {
    ...rawSessionConfig,
    roles: [],
    roleOverrides: {},
  }

  // 1) 只剩全局：项目角色字段已在上面剥掉。
  const inherited = createRegistry(toRegistryInput(globalConfig, projectConfig))
  for (const error of inherited.errors) {
    // 别名冲突在最终生效角色表上统一判定（会话可能改名/改别名）。
    if (error.code !== 'ALIAS_CONFLICT') errors.push(error)
  }

  const roles = inherited.list()
  const byId = new Map(roles.map((role) => [role.roleId, role]))

  // 全局单独的规范化结果：用于判断某个字段到底是"全局显式写的"还是默认值。
  const globalRolesRaw = Array.isArray(globalConfig.roles) ? globalConfig.roles : []
  const globalById = new Map(
    createRegistry({ globalRoles: globalRolesRaw }).list().map((role) => [role.roleId, role]),
  )
  // 来源判定用**原始**配置：Config() 会把 enabled 默认填成 true，直接看规范化结果
  // 会把所有角色都误标成"显式启用"。
  const globalSourceRoles = Array.isArray(globalRaw)
    ? globalRaw
    : Array.isArray(/** @type {any} */ (globalRaw)?.roles)
      ? /** @type {any} */ (globalRaw).roles
      : globalRolesRaw
  /** @type {Map<string, any>} */
  const globalRawById = new Map()
  for (const raw of globalSourceRoles) {
    if (isPlainObject(raw) && typeof raw.roleId === 'string' && !globalRawById.has(raw.roleId)) {
      globalRawById.set(raw.roleId, raw)
    }
  }

  const projectRolesRaw = Array.isArray(projectConfig.roles) ? projectConfig.roles : []
  /** @type {Map<string, any>} */
  const projectRawById = new Map()
  for (const raw of projectRolesRaw) {
    if (isPlainObject(raw) && typeof raw.roleId === 'string' && !projectRawById.has(raw.roleId)) {
      projectRawById.set(raw.roleId, raw)
    }
  }
  const projectOverrides = isPlainObject(projectConfig.roleOverrides)
    ? projectConfig.roleOverrides
    : {}

  /** @type {Record<string, { layer: string, fields: Record<string, string> }>} */
  const roleSources = {}

  // 2) 先给继承层的每个字段标来源（global / project / default）。
  for (const role of roles) {
    const globalRole = globalById.get(role.roleId)
    const globalRawRole = globalRawById.get(role.roleId)
    const projectRaw = projectRawById.get(role.roleId)
    const projectPatch = projectOverrides[role.roleId]
    const isNewAtProject = !globalRole && Boolean(projectRaw)

    /** @type {Record<string, string>} */
    const fields = {}
    for (const field of ROLE_SOURCE_FIELDS) {
      if (/** @type {any} */ (role)[field] === undefined) continue
      let layer = 'default'
      if (isNewAtProject) {
        if (hasExplicit(projectRaw, field)) layer = 'project'
      } else if (globalRole) {
        if (hasExplicit(globalRawRole, field)) layer = 'global'
        const projectExplicit = hasExplicit(projectRaw, field) || hasExplicit(projectPatch, field)
        if (projectExplicit && !deepEqual(globalRole[field], /** @type {any} */ (role)[field])) {
          layer = 'project'
        }
      }
      fields[field] = layer
    }
    for (const key of CHANNEL_SOURCE_FIELDS) {
      if (role.channel?.[key] === undefined) continue
      let layer = 'default'
      if (isNewAtProject) {
        if (hasExplicitChannel(projectRaw, key)) layer = 'project'
      } else if (globalRole) {
        if (hasExplicitChannel(globalRawRole, key)) layer = 'global'
        const projectExplicit =
          hasExplicitChannel(projectRaw, key) || hasExplicitChannel(projectPatch, key)
        if (projectExplicit && !deepEqual(globalRole.channel?.[key], role.channel?.[key])) {
          layer = 'project'
        }
      }
      fields[`channel.${key}`] = layer
    }

    roleSources[role.roleId] = {
      layer: role.source === 'project' ? 'project' : 'global',
      fields,
    }
  }

  /**
   * 把一个会话补丁应用到生效角色表。新角色走完整校验，已有角色走字段级覆盖。
   * @param {string} roleId
   * @param {Record<string, any>} patch
   */
  function applySessionPatch(roleId, patch) {
    const before = byId.get(roleId)
    if (!before) {
      const scratch = createRegistry({ globalRoles: [patch] })
      errors.push(...scratch.errors)
      const created = scratch.list()[0]
      if (!created) return
      created.source = /** @type {any} */ ('session')
      roles.push(created)
      byId.set(roleId, created)
      /** @type {Record<string, string>} */
      const fields = {}
      for (const field of ROLE_SOURCE_FIELDS) {
        if (/** @type {any} */ (created)[field] === undefined) continue
        fields[field] = hasExplicit(patch, field) ? 'session' : 'default'
      }
      for (const key of CHANNEL_SOURCE_FIELDS) {
        if (created.channel?.[key] === undefined) continue
        fields[`channel.${key}`] = hasExplicitChannel(patch, key) ? 'session' : 'default'
      }
      roleSources[roleId] = { layer: 'session', fields }
      return
    }

    const scratch = createRegistry({
      globalRoles: [before],
      projectOverrides: { [roleId]: patch },
    })
    errors.push(...scratch.errors)
    const after = scratch.list().find((role) => role.roleId === roleId)
    if (!after) return

    const changed = diffFieldPaths(before, after)
    after.source = changed.size > 0 ? /** @type {any} */ ('session') : before.source
    const index = roles.findIndex((role) => role.roleId === roleId)
    if (index >= 0) roles[index] = after
    byId.set(roleId, after)

    const entry = roleSources[roleId] ?? { layer: after.source ?? 'global', fields: {} }
    if (changed.size > 0) entry.layer = 'session'
    for (const field of changed) entry.fields[field] = 'session'
    roleSources[roleId] = entry
  }

  // 3) 会话新增/覆盖的角色定义（同 roleId = 字段级覆盖，与项目层一致）。
  /** @type {Set<string>} */
  const seenSessionRoles = new Set()
  for (const patch of sessionConfig.roles) {
    const roleId = typeof patch.roleId === 'string' ? patch.roleId : ''
    if (!isValidRoleId(roleId)) {
      const scratch = createRegistry({ globalRoles: [patch] })
      errors.push(...scratch.errors)
      continue
    }
    if (seenSessionRoles.has(roleId)) {
      errors.push({
        code: 'DUPLICATE_ROLE_ID',
        roleId,
        field: 'roleId',
        message: `会话角色 id 重复：${roleId}（保留第一条）`,
      })
      continue
    }
    seenSessionRoles.add(roleId)
    applySessionPatch(roleId, patch)
  }

  // 4) 会话覆盖表（按 roleId 的字段补丁）。
  for (const [roleId, patch] of Object.entries(sessionConfig.roleOverrides)) {
    if (!byId.has(roleId)) {
      errors.push({
        code: 'UNKNOWN_ROLE_ID',
        roleId,
        field: `roleOverrides.${roleId}`,
        message: `roleOverrides 指向不存在的角色：${roleId}`,
      })
      continue
    }
    applySessionPatch(roleId, patch)
  }

  // 5) 顶层字段：defaultRoleId / dispatchNotes / projectRules。
  /** @param {string} key */
  const sessionHas = (key) =>
    Object.hasOwn(sessionConfig, key) && /** @type {any} */ (sessionConfig)[key] !== undefined
  /** @param {string} key */
  const projectHas = (key) =>
    Object.hasOwn(projectConfig, key) &&
    projectConfig[key] !== undefined &&
    projectConfig[key] !== ''
  /** @param {string} key */
  const globalHas = (key) => globalConfig[key] !== undefined && globalConfig[key] !== ''

  /** @param {string} key @param {any} fallback */
  function pickScalar(key, fallback) {
    if (sessionHas(key)) return { value: /** @type {any} */ (sessionConfig)[key], layer: 'session' }
    if (projectHas(key)) return { value: projectConfig[key], layer: 'project' }
    if (globalHas(key)) return { value: globalConfig[key], layer: 'global' }
    return { value: fallback, layer: 'default' }
  }

  const defaultRoleId = pickScalar('defaultRoleId', undefined)
  const dispatchNotes = pickScalar('dispatchNotes', '')

  /** @type {string[]} */
  const projectRules = []
  /** @type {string[]} */
  const projectRuleSources = []
  for (const rule of Array.isArray(projectConfig.projectRules) ? projectConfig.projectRules : []) {
    if (typeof rule !== 'string' || projectRules.includes(rule)) continue
    projectRules.push(rule)
    projectRuleSources.push('project')
  }
  for (const rule of sessionConfig.projectRules) {
    if (projectRules.includes(rule)) continue
    projectRules.push(rule)
    projectRuleSources.push('session')
  }

  const effective = {
    roles,
    channels: Array.isArray(globalConfig.channels)
      ? globalConfig.channels.map((channel) => ({ ...channel }))
      : [],
    defaultRoleId: defaultRoleId.value,
    dispatchNotes: dispatchNotes.value,
    projectRules,
  }

  const sources = {
    roles: roleSources,
    defaultRoleId: defaultRoleId.layer,
    dispatchNotes: dispatchNotes.layer,
    projectRules: projectRuleSources,
  }

  // 别名冲突不在这里判定：会话可能新增/改名，必须由调用方在**最终生效角色表**上
  // 建注册表（createRegistry({ globalRoles: effective.roles })）后再报告，避免旧表误报。

  return { effective, sources, errors }
}
