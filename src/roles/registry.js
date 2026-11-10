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
 * - 别名（含 name）跨角色唯一，冲突时降级为不可解析，而不是让整张表失败。
 *
 * 本项目**不提供只读通道**：宿主 subagent spec 没有权限字段，做不到绝对只读，
 * 所以角色上不再有 permissionPreset，也不要再实现（2026-11-11 用户决策）。
 */

import { isValidRoleId, normalizeAlias } from './ids.js'

/**
 * @typedef {'in-process' | 'acp-cli' | 'codex' | 'claude-code'} ChannelKind
 */

/**
 * 执行通道。只有 kind 必填，其余字段由具体 provider 决定。
 *
 * @typedef {object} RoleChannel
 * @property {ChannelKind} kind
 * @property {string} [channelId]
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
 * @property {string} [prompt] 人设/工作守则；派单时作为前缀注入
 * @property {RoleChannel} channel
 * @property {boolean} enabled
 * @property {string | null} fallbackRoleId
 * @property {number} timeoutMs
 * @property {'global' | 'project'} [source] 来源：全局配置还是项目配置
 * @property {boolean} [ambiguous] 仅在同名/别名冲突时出现且为 true
 */

/**
 * 注册表错误码。前 5 个是 P2-01 要求必须覆盖的。
 *
 * @typedef {'INVALID_ROLE_ID' | 'DUPLICATE_ROLE_ID' | 'ALIAS_CONFLICT' | 'MISSING_NAME'
 *   | 'INVALID_ROLE' | 'INVALID_CHANNEL' | 'INVALID_CHANNEL_KIND'
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
  MISSING_NAME: 'MISSING_NAME',
  INVALID_ROLE: 'INVALID_ROLE',
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
 * 解析 channel 字段。
 * - 完整角色（默认）：缺失时给 `in-process`（原生子 Agent 是最保守的选择）
 * - 字段级覆盖（`partial: true`）：**不给默认 kind**，否则只覆盖 model 会把 acp-cli 打回 in-process
 *
 * @param {unknown} value
 * @param {RegistryError[]} errors
 * @param {string} roleId
 * @param {{ partial?: boolean }} [opts]
 * @returns {Partial<RoleChannel> & { kind?: ChannelKind }}
 */
function readChannel(value, errors, roleId, opts = {}) {
  const partial = opts.partial === true
  if (value === undefined || value === null) return partial ? {} : { kind: 'in-process' }
  if (typeof value !== 'object') {
    errors.push({ code: 'INVALID_CHANNEL', roleId, message: `角色 ${roleId} 的 channel 必须是对象` })
    return partial ? {} : { kind: 'in-process' }
  }

  const input = /** @type {Record<string, unknown>} */ (value)
  /** @type {Partial<RoleChannel> & { kind?: ChannelKind }} */
  const channel = {}

  if (typeof input.kind === 'string') {
    if (CHANNEL_KINDS.includes(/** @type {ChannelKind} */ (input.kind))) {
      channel.kind = /** @type {ChannelKind} */ (input.kind)
    } else {
      errors.push({
        code: 'INVALID_CHANNEL_KIND',
        roleId,
        field: 'channel.kind',
        message: `角色 ${roleId} 的通道类型 ${input.kind} 不在允许列表内`,
      })
    }
  }

  for (const key of /** @type {const} */ (['provider', 'cli', 'model', 'reasoning', 'channelId'])) {
    const raw = input[key]
    if (typeof raw === 'string' && raw.trim()) channel[key] = raw.trim()
  }

  // 完整角色必须带 kind；覆盖时没写就保持原值（由合并方处理）
  if (!partial && !channel.kind) channel.kind = 'in-process'
  return channel
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

  // permissionPreset 已随只读通道一起移除（2026-11-11）：未知字段按 schema 约定忽略。
  const timeout = Number(input.timeoutMs)

  return {
    roleId: id,
    name,
    aliases: readAliases(input.aliases),
    description: typeof input.description === 'string' ? input.description : '',
    ...(typeof input.prompt === 'string' && input.prompt.trim() ? { prompt: input.prompt } : {}),
    channel: readChannel(input.channel, errors, id),
    source: /** @type {const} */ ('global'),
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
  if (Object.hasOwn(input, 'prompt') && typeof input.prompt === 'string' && input.prompt.trim()) {
    next.prompt = input.prompt
  }
  if (Object.hasOwn(input, 'channel')) {
    // 通道按字段合并：只改 model 时不该把 provider/cli/kind 抹掉
    const overridden = readChannel(input.channel, errors, base.roleId, { partial: true })
    next.channel = { ...next.channel, ...overridden }
  }

  // 未知字段（含已移除的 permissionPreset）按 schema 约定忽略，旧配置不会阻断派单。
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
 * @param {Set<string>} conflicted 输出参数：冲突 token 集合（供上层区分「不存在」与「有歧义」）
 * @param {Map<string, string[]>} conflicts 输出参数：冲突 token → 涉及的 roleId 列表
 * @returns {Map<string, string>}
 */
function buildAliasIndex(roles, byId, errors, conflicted, conflicts) {
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

    conflicted.add(token)
    const involved = [...owners]
    conflicts.set(token, involved)
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
 * → projectOverrides（按 roleId 的字段级覆盖）。
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
      merged.source = /** @type {const} */ ('project')
      const index = roles.findIndex((role) => role.roleId === roleId)
      roles[index] = merged
      byId.set(roleId, merged)
      continue
    }

    const role = readRole(raw, errors)
    if (!role) continue
    // 项目清单里新增的角色，来源标为 project
    role.source = /** @type {const} */ ('project')
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
    // 被项目覆盖过的角色，来源标为 project（便于 list_roles 区分"这是谁定义的"）
    merged.source = /** @type {const} */ ('project')
    const index = roles.findIndex((role) => role.roleId === roleId)
    roles[index] = merged
    byId.set(roleId, merged)
  }

  /** @type {Set<string>} */
  const conflictedTokens = new Set()
  /** @type {Map<string, string[]>} */
  const conflictMap = new Map()
  const aliasIndex = buildAliasIndex(roles, byId, errors, conflictedTokens, conflictMap)

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

  /**
   * 这个引用是否「有歧义」（名字/别名被多个角色占用）。
   * 用于让上层区分 ROLE_NOT_FOUND 与 ROLE_AMBIGUOUS——否则纠错提示无从给出。
   * @param {unknown} ref
   */
  function isAmbiguousRef(ref) {
    if (typeof ref !== 'string') return false
    const key = normalizeAlias(ref)
    return key ? conflictedTokens.has(key) : false
  }

  /**
   * 冲突 token 涉及哪些 roleId（用于给出"请改用 roleId"的具体选项）。
   * @param {unknown} ref
   * @returns {string[]}
   */
  function conflictsFor(ref) {
    if (typeof ref !== 'string') return []
    const key = normalizeAlias(ref)
    return key ? (conflictMap.get(key) ?? []) : []
  }

  return { list, resolve, get, errors, isAmbiguousRef, conflictsFor }
}
