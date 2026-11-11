// @ts-check
/**
 * 五人角色模板（P0-S1）：唐僧 / 悟空 / 八戒 / 沙僧 / 小白。
 *
 * 边界（勿破坏）：
 * - **只定义职责与身份，不绑定外部 CLI、provider、channel 或具体模型**；
 *   模型选择属于通道实例（src/config.js 的 `channels`），由用户后续配置
 * - 纯函数：不读文件、不写配置、不探测宿主；初始化只是"给出待配置的角色表"
 * - **不伪造 ready**：模板角色没有可用通道证据，`setupState` 只能是
 *   `pending-config`（展示为「待配置」），绝不输出 `ready`
 * - 初始化不覆盖用户已有角色：同 roleId 已存在时原样保留，只补缺失项
 *
 * 宿主能力不可得（未 inject / provider 查询缺失）时，待配置原因记为
 * `HOST_CAPABILITY_UNKNOWN`；宿主能力可用但角色还没选通道时记为
 * `CHANNEL_NOT_CONFIGURED`。两者都仍是「待配置」。
 */

/** 模板角色 ID（固定，改名不改 ID）。 */
export const FIVE_ROLE_IDS = Object.freeze([
  'role-tangtang',
  'role-wukong',
  'role-bajie',
  'role-sashi',
  'role-xiaobai',
])

/** 初始化状态：只有待配置 / 已配置，没有 ready。 */
export const TEMPLATE_SETUP = Object.freeze({
  PENDING: 'pending-config',
  CONFIGURED: 'configured',
})

/** 「待配置」的中文展示文案。 */
export const TEMPLATE_PENDING_LABEL = '待配置'

/** 待配置原因。 */
export const TEMPLATE_PENDING_REASON = Object.freeze({
  HOST_CAPABILITY_UNKNOWN: 'HOST_CAPABILITY_UNKNOWN',
  HOST_CAPABILITY_UNAVAILABLE: 'HOST_CAPABILITY_UNAVAILABLE',
  CHANNEL_NOT_CONFIGURED: 'CHANNEL_NOT_CONFIGURED',
})

/**
 * 固定职责。**不写 channel / model / provider / cli / reasoning**：
 * 模板不是"某个 CLI 的五个分身"，而是用户自己的团队骨架。
 */
export const FIVE_ROLE_TEMPLATE = Object.freeze(
  [
    {
      roleId: 'role-tangtang',
      name: '唐僧',
      aliases: ['TT', '领导'],
      duty: '架构、战略、关键决策、最终质量把关',
      description: '团队领导：架构、战略、关键决策、最终质量把关',
    },
    {
      roleId: 'role-wukong',
      name: '悟空',
      aliases: ['WK', '专家'],
      duty: '疑难问题、审核验收、长时间 Agent 任务',
      description: '核心资深专家：疑难问题、审核验收、长时间 Agent 任务',
    },
    {
      roleId: 'role-bajie',
      name: '八戒',
      aliases: ['BJ', '调度'],
      duty: '调度、监工、整合（主 Agent 本体，不参与派单）',
      description: '技术主管：调度、监工、整合（主 Agent 本体，不参与派单）',
    },
    {
      roleId: 'role-sashi',
      name: '沙僧',
      aliases: ['SS', '主力执行'],
      duty: '主力开发、苦工、各类实现任务',
      description: '技术骨干：主力开发、苦工、各类实现任务（纯文字模型，快且质量稳）',
    },
    {
      roleId: 'role-xiaobai',
      name: '小白',
      aliases: ['XB', '打杂'],
      duty: '打杂、辅助、杂项实现',
      description: '牛马：主力干活、打杂、什么都会干（会的杂）',
    },
  ].map((role) => Object.freeze({ ...role, aliases: Object.freeze([...role.aliases]) })),
)

/** @param {unknown} value */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 把宿主能力归一化成三态。
 * 接受字符串（available / unavailable / unknown）、布尔值或 `{ available }`。
 *
 * @param {unknown} capability
 * @returns {'available' | 'unavailable' | 'unknown'}
 */
export function normalizeHostCapability(capability) {
  if (capability === true || capability === 'available') return 'available'
  if (capability === false || capability === 'unavailable') return 'unavailable'
  if (isPlainObject(capability)) {
    const available = /** @type {any} */ (capability).available
    if (available === true) return 'available'
    if (available === false) return 'unavailable'
  }
  return 'unknown'
}

/**
 * 生成五个模板角色（全部标记为待配置）。
 *
 * 注意：返回对象里带 `setupState` / `setupLabel` / `setupReason` 三个**派生标记**，
 * 它们不是角色配置字段；写盘前用 `toConfigRoles()` 剥掉。
 *
 * @param {{ hostCapability?: unknown }} [options]
 * @returns {Array<{
 *   roleId: string, name: string, aliases: string[], duty: string, description: string,
 *   setupState: 'pending-config', setupLabel: string, setupReason: string,
 * }>}
 */
export function createTemplateRoles({ hostCapability } = {}) {
  const capability = normalizeHostCapability(hostCapability)
  const reason =
    capability === 'available'
      ? TEMPLATE_PENDING_REASON.CHANNEL_NOT_CONFIGURED
      : capability === 'unavailable'
        ? TEMPLATE_PENDING_REASON.HOST_CAPABILITY_UNAVAILABLE
        : TEMPLATE_PENDING_REASON.HOST_CAPABILITY_UNKNOWN

  return FIVE_ROLE_TEMPLATE.map((role) => ({
    roleId: role.roleId,
    name: role.name,
    aliases: [...role.aliases],
    duty: role.duty,
    description: role.description,
    setupState: TEMPLATE_SETUP.PENDING,
    setupLabel: TEMPLATE_PENDING_LABEL,
    setupReason: reason,
  }))
}

/**
 * 初始化五人模板：补缺失角色，不覆盖用户已定义的同 ID 角色。
 *
 * @param {unknown[]} [existingRoles]
 * @param {{ hostCapability?: unknown }} [options]
 * @returns {{
 *   roles: object[],
 *   added: object[],
 *   pending: Array<{ roleId: string, setupState: string, setupReason: string }>,
 * }}
 */
export function seedFiveRoleTemplate(existingRoles = [], options = {}) {
  const existing = Array.isArray(existingRoles)
    ? existingRoles.filter((role) => isPlainObject(role))
    : []
  const existingIds = new Set(
    existing
      .map((role) => (typeof /** @type {any} */ (role).roleId === 'string' ? /** @type {any} */ (role).roleId : ''))
      .filter(Boolean),
  )
  const added = createTemplateRoles(options).filter((role) => !existingIds.has(role.roleId))

  return {
    // 已有角色对象原样保留（不复制、不改写），避免把用户的配置改成模板值。
    roles: [...existing, ...added],
    added,
    pending: added.map((role) => ({
      roleId: role.roleId,
      setupState: role.setupState,
      setupReason: role.setupReason,
    })),
  }
}

/**
 * 剥掉派生标记，得到可以写进配置/注册表的角色对象。
 *
 * @param {unknown[]} roles
 * @returns {object[]}
 */
export function toConfigRoles(roles) {
  if (!Array.isArray(roles)) return []
  return roles.filter(isPlainObject).map((role) => {
    const { setupState, setupLabel, setupReason, ...config } = /** @type {any} */ (role)
    return config
  })
}

export default FIVE_ROLE_TEMPLATE
