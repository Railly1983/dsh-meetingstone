// @ts-check
/**
 * 角色 id 与别名的规范化工具。
 *
 * 纯函数模块：不读文件、不读环境、不 import 任何东西，便于单测与后续接 DSH Config。
 * 设计约束见 docs/开发计划.md §7.1：roleId 稳定不变，别名跨角色全局唯一。
 */

/**
 * 合法的角色 id：小写字母/数字开头，后续可含小写字母、数字、连字符。
 * 例：`role-sashi`、`role-lead-2`。
 */
export const ROLE_ID_PATTERN = /^role-[a-z0-9][a-z0-9-]*$/

/**
 * 判断 roleId 是否合法（大小写敏感：`Role-Sashi` 不合法）。
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidRoleId(id) {
  return typeof id === 'string' && ROLE_ID_PATTERN.test(id)
}

/**
 * 别名的比较键：去首尾空白 → 内部连续空白压成一个 → 转小写。
 *
 * 返回值只用于比较/索引；展示时请用原始字符串。
 * 非字符串或空白串返回空串，调用方应把空串当作「无别名」跳过。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAlias(value) {
  if (typeof value !== 'string') return ''
  const collapsed = value.trim().replace(/\s+/g, ' ')
  return collapsed.toLowerCase()
}
