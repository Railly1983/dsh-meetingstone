// @ts-check
/**
 * 角色注册表：把「全局角色表 + 项目新增 + 项目覆盖」合并成一份可解析的角色集合。
 *
 * 纯逻辑模块的边界（勿破坏）：
 * - 不读文件、不读环境、不 import 任何运行时依赖；
 * - 不抛异常表达业务错误，全部进 `errors`，由上层决定怎么报；
 * - 不做权限判定、不派单，只回答「这个名字是谁」。
 *
 * 合并规则（docs/开发计划.md §7.1）：
 * - 项目 > 全局；同 roleId 视为同一角色的字段级覆盖；
 * - permissionPreset 只能收紧不能放宽；
 * - 别名（含 name）跨角色唯一，冲突时降级为不可解析，而不是让整张表失败。
 */

import { isValidRoleId, normalizeAlias } from './ids.js'

/**
 * @typedef {'read-only' | 'restricted' | 'project-write' | 'approval'} PermissionPreset
 * @typedef {'in-process' | 'acp-cli' | 'codex' | 'claude-code'} ChannelKind
 */

/**
 * 执行通道。只有 kind 必填，其余字段由具体 provider 决定。
 *
 * @typedef {object} RoleChannel
 * @property {ChannelKind} kind
 * @property {string} [provider]
 * @property {string} [cli]
 * @property {string} [model]
 * @property {string} [reasoning]
 */

/**
 * 一个角色。
 *
 * @typedef {object} Role
 * @property {string} roleId
 * @property {string} name
 * @property {string[]} aliases
 * @property {string} description
 * @property {RoleChannel} channel
 * @property {PermissionPreset} permissionPreset
 * @property {boolean} enabled
 * @property {string | null} fallbackRoleId
 * @property {number} timeoutMs
 * @property {boolean} [ambiguous] 仅在同名/别名冲突时出现且为 true
 */

/**
 * 注册表错误码。前 5 个是 P2-01 要求必须覆盖的。
 *
 * @typedef {'INVALID_ROLE_ID' | 'DUPLICATE_ROLE_ID' | 'ALIAS_CONFLICT' | 'PERMISSION_WIDENED' | 'MISSING_NAME'
 *   | 'INVALID_ROLE' | 'INVALID_PERMISSION_PRESET' | 'INVALID_CHANNEL' | 'INVALID_CHANNEL_KIND'
 *   | 'UNKNOWN_ROLE_ID' | 'INVALID_OVERRIDE'} RegistryErrorCode
 */

/**
 * 一条校验/合并错误。字段按需出现，便于上层直接转成用户可读提示。
 *
 * @typedef {object} RegistryError
 * @property {RegistryErrorCode} code
 * @property {string} message 中文可读说明（面向日志/设置页）
 * @property {string} [roleId]
 * @property {string} [field]
 * @property {string} [alias] 冲突的规范化别名
 * @property {string[]} [roles] 冲突涉及的角色 id
 */

/**
 * 注册表实例。
 *
 * @typedef {object} RoleRegistry
 * @property {() => Role[]} list 按合并顺序返回全部角色（含 disabled / ambiguous）
 * @property {(ref: unknown) => Role | null} resolve 按 roleId / name / 别名解析
 * @property {(roleId: string) => Role | null} get 按 roleId 精确取角色
 * @property {RegistryError[]} errors 合并与校验过程中累积的错误（只增不减）
 */

/** 权限档位由严到宽；数组顺序即宽松度顺序。 */
export const PERMISSION_PRESETS = Object.freeze(
  /** @type {PermissionPreset[]} */ (['read-only', 'restricted', 'project-write', 'approval']),
)

/** 宽松度数值：越小越严。项目覆盖只允许把数值改小或不变。 */
export const PERMISSION_RANK = Object.freeze(
  /** @type {Record<string, number>} */ ({
    'read-only': 0,
    restricted: 1,
    'project-write': 2,
    approval: 3,
  }),
)

/** 默认超时：30 分钟（与计划 §7.1 的示例值一致）。 */
export const DEFAULT_TIMEOUT_MS = 1_800_000

/** 通道 kind 的合法枚举。 */
export const CHANNEL_KINDS = Object.freeze(
  /** @type {ChannelKind[]} */ (['in-process', 'acp-cli', 'codex', 'claude-code']),
)

/** 仅用于错误文案展示的示例 id。 */
const ROLE_ID_SAMPLE = 'role-sashi'

/**
 * 注册表错误码常量，避免上层散落字符串字面量。
 */
export const ERROR_CODES = Object.freeze({
  INVALID_ROLE_ID: 'INVALID_ROLE_ID',
  DUPLICATE_ROLE_ID: 'DUPLICATE_ROLE_ID',
  ALIAS_CONFLICT: 'ALIAS_CONFLICT',
  PERMISSION_WIDENED: 'PERMISSION_WIDENED',
  MISSING_NAME: 'MISSING_NAME',
  INVALID_ROLE: 'INVALID_ROLE',
  INVALID_PERMISSION_PRESET: 'INVALID_PERMISSION_PRESET',
  INVALID_CHANNEL: 'INVALID_CHANNEL',
  INVALID_CHANNEL_KIND: 'INVALID_CHANNEL_KIND',
  UNKNOWN_ROLE_ID: 'UNKNOWN_ROLE_ID',
  INVALID_OVERRIDE: 'INVALID_OVERRIDE',
})

/**
 * 深拷贝一份角色（aliases 数组与 channel 对象都要拆开），
 * 防止调用方改坏注册表内部状态。
 *
 * @param {Role} role
 * @returns {Role}
 */
function cloneRole(role) {
  /** @type {Role} */
  const copy = { ...role, aliases: [...role.aliases], channel: { ...role.channel } }
  return copy
}

/**
 * 解析 aliases 字段：只保留非空字符串，去重（按原值），保持书写顺序。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function readAliases(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

/**
 * 解析 channel 字段；缺失时给 `in-process`（原生子 Agent 是最保守的选择）。
 *
 * @param {unknown} value
 * @param {RegistryError[]} errors
 * @param {string} roleId
 * @returns {RoleChannel}
 */
function readChannel(value, errors, roleId) {
  if (value === undefined || value === null) return { kind: 'in-process' }
  if (typeof value !== 'object') {
    errors.push({ code: 'INVALID_CHANNEL', roleId, message: `角色 ${roleId} 的 channel 必须是对象` })
    return { kind: 'in-process' }
  }

  const input = /** @type {Record<string, unknown>} */ (value)
  let kind = /** @type {ChannelKind} */ ('in-process')
  if (typeof input.kind === 'string') {
    if (CHANNEL_KINDS.includes(/** @type {ChannelKind} */ (input.kind))) {
      kind = /** @type {ChannelKind} */ (input.kind)
    } else {
      errors.push({
        code: 'INVALID_CHANNEL_KIND',
        roleId,
        field: 'channel.kind',
        message: `角色 ${roleId} 的通道类型 ${input.kind} 不在允许列表内`,
      })
    }
  }

  /** @type {RoleChannel} */
  const channel = { kind }
  for (const key of /** @type {const} */ (['provider', 'cli', 'model', 'reasoning'])) {
    const raw = input[key]
    if (typeof raw === 'string' && raw.trim()) channel[key] = raw.trim()
  }
  return channel
}

/**
 * 校验权限档位。返回 null 表示「无效，调用方应跳过该字段」。
 *
 * @param {unknown} value
 * @param {RegistryError[]} errors
 * @param {string} roleId
 * @returns {PermissionPreset | null}
 */
function readPermissionPreset(value, errors, roleId) {
  if (typeof value === 'string' && PERMISSION_PRESETS.includes(/** @type {PermissionPreset} */ (value))) {
    return /** @type {PermissionPreset} */ (value)
  }
  errors.push({
    code: 'INVALID_PERMISSION_PRESET',
    roleId,
    field: 'permissionPreset',
    message: `角色 ${roleId} 的 permissionPreset 非法：${String(value)}`,
  })
  return null
}

/**
 * 把一个原始条目读成完整角色；任何硬错误都会让该条目被丢弃。
 *
 * @param {unknown} raw
 * @param {RegistryError[]} errors
 * @returns {Role | null}
 */
function readRole(raw, errors) {
  if (typeof raw !== 'object' || raw === null) {
    errors.push({ code: 'INVALID_ROLE', message: '角色条目必须是对象' })
    return null
  }

  const input = /** @type {Record<string, unknown>} */ (raw)
  const roleId = input.roleId
  if (!isValidRoleId(roleId)) {
    errors.push({
      code: 'INVALID_ROLE_ID',
      roleId: typeof roleId === 'string' ? roleId : '',
      field: 'roleId',
      message: `角色 id 非法：${String(roleId)}（需匹配 ${String(ROLE_ID_SAMPLE)}）`,
    })
    return null
  }
  const id = /** @type {string} */ (roleId)

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) {
    errors.push({ code: 'MISSING_NAME', roleId: id, field: 'name', message: `角色 ${id} 缺少 name` })
    return null
  }

  // permissionPreset 缺省时给 project-write：可写但不出项目目录，符合「默认不放开」。
  const preset =
    input.permissionPreset === undefined
      ? /** @type {PermissionPreset} */ ('project-write')
      : readPermissionPreset(input.permissionPreset, errors, id) ??
        /** @type {PermissionPreset} */ ('project-write')

  const timeout = Number(input.timeoutMs)

  return {
    roleId: id,
    name,
    aliases: readAliases(input.aliases),
    description: typeof input.description === 'string' ? input.description : '',
    channel: readChannel(input.channel, errors, id),
    permissionPreset: preset,
    enabled: input.enabled !== false,
    fallbackRoleId:
      typeof input.fallbackRoleId === 'string' && input.fallbackRoleId.trim()
        ? input.fallbackRoleId.trim()
        : null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  }
}

/**
 * 在已有角色上做字段级覆盖；返回新对象，不改入参。
 *
 * 关键规则：permissionPreset 只允许收紧（rank 变小或不变），放宽则整字段拒绝。
 *
 * @param {Role} base
 * @param {unknown} patch
 * @param {RegistryError[]} errors
 * @returns {Role}
 */
function mergeRole(base, patch, errors) {
  /** @type {Role} */
  const next = cloneRole(base)
  if (typeof patch !== 'object' || patch === null) {
    errors.push({
      code: 'INVALID_OVERRIDE',
      roleId: base.roleId,
      message: `角色 ${base.roleId} 的覆盖值必须是对象`,
    })
    return next
  }

  const input = /** @type {Record<string, unknown>} */ (patch)

  if (Object.hasOwn(input, 'name')) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) {
      errors.push({
        code: 'MISSING_NAME',
        roleId: base.roleId,
        field: 'name',
        message: `角色 ${base.roleId} 的覆盖 name 不能为空`,
      })
    } else {
      next.name = name
    }
  }

  if (Object.hasOwn(input, 'aliases')) next.aliases = readAliases(input.aliases)
  if (Object.hasOwn(input, 'description') && typeof input.description === 'string') {
    next.description = input.description
  }
  if (Object.hasOwn(input, 'channel')) {
    // 通道按字段合并：只改 model 时不该把 provider/cli 抹掉。
    const overridden = readChannel(input.channel, errors, base.roleId)
    next.channel = { ...next.channel, ...overridden }
  }

  if (Object.hasOwn(input, 'permissionPreset')) {
    const preset = readPermissionPreset(input.permissionPreset, errors, base.roleId)
    if (preset !== null) {
      const current = PERMISSION_RANK[next.permissionPreset] ?? 0
      const wanted = PERMISSION_RANK[preset]
      if (wanted > current) {
        errors.push({
          code: 'PERMISSION_WIDENED',
          roleId: base.roleId,
          field: 'permissionPreset',
          message: `角色 ${base.roleId} 的权限从 ${next.permissionPreset} 放宽到 ${preset} 被拒绝`,
        })
      } else {
        next.permissionPreset = preset
      }
    }
  }

  if (Object.hasOwn(input, 'enabled') && typeof input.enabled === 'boolean') {
    next.enabled = input.enabled
  }

  if (Object.hasOwn(input, 'fallbackRoleId')) {
    next.fallbackRoleId =
      typeof input.fallbackRoleId === 'string' && input.fallbackRoleId.trim()
        ? input.fallbackRoleId.trim()
        : null
  }

  if (Object.hasOwn(input, 'timeoutMs')) {
    const timeout = Number(input.timeoutMs)
    if (Number.isFinite(timeout) && timeout > 0) next.timeoutMs = timeout
  }

  return next
}

/**
 * 构建「规范化名字/别名 → roleId」的解析索引。
 *
 * 冲突处理：一个 token 命中多个角色时，记录 ALIAS_CONFLICT、把涉及的每个角色标
 * `ambiguous: true`，并且**该 token 不进入索引**（解析时返回 null）。
 * 角色本体保留，仍可按 roleId 解析。
 *
 * @param {Role[]} roles
 * @param {Map<string, Role>} byId
 * @param {RegistryError[]} errors
 * @returns {Map<string, string>}
 */
function buildAliasIndex(roles, byId, errors) {
  /** @type {Map<string, Set<string>>} */
  const buckets = new Map()

  for (const role of roles) {
    /** @type {Set<string>} */
    const tokens = new Set()
    const nameKey = normalizeAlias(role.name)
    if (nameKey) tokens.add(nameKey)
    for (const alias of role.aliases) {
      const key = normalizeAlias(alias)
      if (key) tokens.add(key)
    }

    for (const token of tokens) {
      let owners = buckets.get(token)
      if (!owners) {
        owners = new Set()
        buckets.set(token, owners)
      }
      owners.add(role.roleId)
    }
  }

  /** @type {Map<string, string>} */
  const index = new Map()
  for (const [token, owners] of buckets) {
    if (owners.size === 1) {
      index.set(token, /** @type {string} */ ([...owners][0]))
      continue
    }

    const involved = [...owners]
    errors.push({
      code: 'ALIAS_CONFLICT',
      alias: token,
      roles: involved,
      message: `别名 ${token} 被多个角色占用：${involved.join(' / ')}`,
    })
    for (const id of involved) {
      const role = byId.get(id)
      if (role) role.ambiguous = true
    }
  }

  return index
}

/**
 * 创建角色注册表。
 *
 * 合并顺序：globalRoles（全量校验）→ projectRoles（同名 = 字段级覆盖，新 id = 新增）
 * → projectOverrides（按 roleId 的字段级覆盖）。后两步同样受「权限只能收紧」约束。
 *
 * @param {object} [options]
 * @param {unknown[]} [options.globalRoles]
 * @param {unknown[]} [options.projectRoles]
 * @param {Record<string, unknown>} [options.projectOverrides]
 * @returns {RoleRegistry}
 */
export function createRegistry({ globalRoles = [], projectRoles = [], projectOverrides = {} } = {}) {
  /** @type {RegistryError[]} */
  const errors = []
  /** @type {Role[]} */
  const roles = []
  /** @type {Map<string, Role>} */
  const byId = new Map()

  // 1) 全局角色：重复 id 只保留第一条，后续的整条丢弃。
  for (const raw of globalRoles) {
    const role = readRole(raw, errors)
    if (!role) continue
    if (byId.has(role.roleId)) {
      errors.push({
        code: 'DUPLICATE_ROLE_ID',
        roleId: role.roleId,
        field: 'roleId',
        message: `角色 id 重复：${role.roleId}（保留第一条）`,
      })
      continue
    }
    roles.push(role)
    byId.set(role.roleId, role)
  }

  // 2) 项目角色：与已有 id 相同则字段级覆盖；否则按新角色全量校验后追加。
  /** @type {Set<string>} */
  const seenProject = new Set()
  for (const raw of projectRoles) {
    if (typeof raw !== 'object' || raw === null) {
      errors.push({ code: 'INVALID_ROLE', message: '项目角色条目必须是对象' })
      continue
    }
    const input = /** @type {Record<string, unknown>} */ (raw)
    const id = input.roleId

    // 同一份项目清单里出现两次同 id：无论新增还是覆盖，都按重复处理。
    const projectId = typeof id === 'string' ? id : ''
    if (seenProject.has(projectId)) {
      errors.push({
        code: 'DUPLICATE_ROLE_ID',
        roleId: projectId,
        field: 'roleId',
        message: `项目角色 id 重复：${projectId}（保留第一条）`,
      })
      continue
    }
    seenProject.add(projectId)

    if (isValidRoleId(id) && byId.has(/** @type {string} */ (id))) {
      const roleId = /** @type {string} */ (id)
      const merged = mergeRole(/** @type {Role} */ (byId.get(roleId)), input, errors)
      const index = roles.findIndex((role) => role.roleId === roleId)
      roles[index] = merged
      byId.set(roleId, merged)
      continue
    }

    const role = readRole(raw, errors)
    if (!role) continue
    if (byId.has(role.roleId)) {
      errors.push({
        code: 'DUPLICATE_ROLE_ID',
        roleId: role.roleId,
        field: 'roleId',
        message: `项目角色 id 重复：${role.roleId}（保留第一条）`,
      })
      continue
    }
    roles.push(role)
    byId.set(role.roleId, role)
  }

  // 3) 项目覆盖表：键是 roleId，值是字段级补丁。
  for (const [roleId, patch] of Object.entries(projectOverrides ?? {})) {
    if (!isValidRoleId(roleId)) {
      errors.push({
        code: 'INVALID_ROLE_ID',
        roleId,
        field: 'projectOverrides',
        message: `projectOverrides 的键不是合法角色 id：${roleId}`,
      })
      continue
    }
    const base = byId.get(roleId)
    if (!base) {
      errors.push({
        code: 'UNKNOWN_ROLE_ID',
        roleId,
        field: 'projectOverrides',
        message: `projectOverrides 指向不存在的角色：${roleId}`,
      })
      continue
    }
    const merged = mergeRole(base, patch, errors)
    const index = roles.findIndex((role) => role.roleId === roleId)
    roles[index] = merged
    byId.set(roleId, merged)
  }

  const aliasIndex = buildAliasIndex(roles, byId, errors)

  /**
   * 按 roleId 取角色；未知返回 null。
   *
   * @param {string} roleId
   * @returns {Role | null}
   */
  function get(roleId) {
    if (typeof roleId !== 'string') return null
    const role = byId.get(roleId.trim().toLowerCase())
    return role ? cloneRole(role) : null
  }

  /**
   * 解析顺序：roleId 精确匹配 → 规范化后的名字/别名索引。
   * 找不到返回 null；角色被禁用时返回副本并带 `disabled: true`，由上层决定报错方式。
   *
   * @param {unknown} ref
   * @returns {Role | null}
   */
  function resolve(ref) {
    if (typeof ref !== 'string') return null
    const key = normalizeAlias(ref)
    if (!key) return null

    // roleId 本身也做一次小写匹配，兼容用户输入大写的场景。
    const direct = byId.get(key)
    if (direct) return finalize(direct)

    const resolvedId = aliasIndex.get(key)
    if (!resolvedId) return null
    const role = byId.get(resolvedId)
    return role ? finalize(role) : null
  }

  /**
   * @param {Role} role
   * @returns {Role}
   */
  function finalize(role) {
    const copy = cloneRole(role)
    return copy.enabled === false ? { ...copy, disabled: true } : copy
  }

  /** @returns {Role[]} */
  function list() {
    return roles.map(cloneRole)
  }

  return { list, resolve, get, errors }
}
