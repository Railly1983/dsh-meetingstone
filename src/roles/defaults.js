// @ts-check
/**
 * 开箱即用的默认角色（2026-11-14 用户决策）。
 *
 * ## 为什么要有这个模块
 *
 * 之前 `roles` 默认是空数组，新用户装完插件进设置页看到「0 个角色」，
 * 不知道该建什么、怎么填，谈不上开箱即用。
 *
 * ## 设计约束（勿破坏）
 *
 * 1. **只在用户没有任何角色时生效**。用户一旦自己配置过角色（哪怕只有一个），
 *    这里就完全不介入 —— 绝不合并、绝不覆盖、绝不"补一个"。
 * 2. **纯内存注入，不写盘**。默认角色不会出现在 profile 的 `cordis.patch.yml` 里，
 *    用户不点保存就不会被固化。这样升级插件时默认值可以改进，也不会把
 *    用户从没同意过的东西写进他的配置。
 * 3. **不绑定外部 CLI / 模型**。四个默认角色全部走 `in-process`（DSH 原生子 Agent），
 *    而且**不写 `llmProvider` / `llmModel`** —— 让子 Agent 跟随用户当前的会话默认模型。
 *    这样新用户不需要先配任何 CLI 就能立刻派单。
 *    注意这不违反计费事故的修复：那次事故的成因是"角色声明了便宜通道、实际按父会话
 *    计费通道扣钱"；默认角色**不声明任何通道**，所以不存在"声明与实际不一致"，
 *    属于「用户没指定，就用用户自己的默认设置」，这正是用户要求的行为。
 * 4. **角色数量克制**。默认只给 3 个，覆盖「干活 / 复核 / 调研」三类最常见的用法，
 *    再多就是负担。用户需要更多角色时自己加。
 *
 * @module src/roles/defaults
 */

/** 默认角色 ID（固定，改名不改 ID）。 */
export const DEFAULT_ROLE_IDS = Object.freeze(['role-worker', 'role-reviewer', 'role-researcher'])

/**
 * 默认角色定义。
 *
 * 全部 `kind: 'in-process'`、不带 `provider` / `cli` / `model` / `llmProvider` / `llmModel`，
 * 因此 `buildChildAgentOptions()` 返回空对象，宿主沿用用户当前会话的路由。
 */
export const DEFAULT_ROLES = Object.freeze(
  [
    {
      roleId: 'role-worker',
      name: '执行者',
      aliases: ['干活', 'worker', 'dev'],
      setting:
        '负责具体的实现与修改工作。动手前先确认任务范围，只改被授权的文件；' +
        '完成后必须报告改了哪些文件、做了什么、如何验证（测试命令与结果）。' +
        '拿不到证据就写「未验证」，不要猜、不要编。',
      enabled: true,
    },
    {
      roleId: 'role-reviewer',
      name: '审查员',
      aliases: ['复核', 'reviewer', 'review'],
      setting:
        '负责独立复核他人的改动或结论，重点找真实缺陷：逻辑错误、边界条件、' +
        '并发与权限问题、回归风险。必须自己动手核对证据，不得照抄被审对象或前一个任务的结论。' +
        '只报有证据的问题，没问题就明说没问题，不要为了凑数而挑刺。',
      enabled: true,
    },
    {
      roleId: 'role-researcher',
      name: '调研员',
      aliases: ['调研', 'researcher', 'research'],
      setting:
        '负责只读调研与信息收集：读代码、查文档、对比方案，输出结论与依据。' +
        '不修改任何文件。结论要区分「已验证的事实」与「推测」，并给出可核查的来源。',
      enabled: true,
    },
  ].map((role) =>
    Object.freeze({
      ...role,
      aliases: Object.freeze([...role.aliases]),
      // 不声明具体通道：由派单层落到 in-process 默认通道，跟随用户会话设置。
      channel: Object.freeze({ kind: 'in-process' }),
    }),
  ),
)

/** @param {unknown} value */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 判断用户是否已经有自己的角色配置。
 *
 * 判据刻意保守：只要有任何一个**形状合法的角色对象**，就认为用户已经自己配过，
 * 默认角色完全不介入。不接受字符串、null 等噪声。
 *
 * @param {unknown} roles
 * @returns {boolean}
 */
export function hasUserRoles(roles) {
  if (!Array.isArray(roles)) return false
  return roles.some((role) => isPlainObject(role) && typeof /** @type {any} */ (role).roleId === 'string' && /** @type {any} */ (role).roleId.trim() !== '')
}

/**
 * 按需给出默认角色：用户没有任何角色时返回默认表，否则返回空数组。
 *
 * 调用方把它与用户角色拼接即可，不需要判断分支。
 *
 * @param {unknown} existingRoles 用户配置里的角色（`cfg.roles`）
 * @returns {ReadonlyArray<object>} 可直接使用的角色数组（已深拷贝可写副本）
 */
export function defaultRolesFor(existingRoles) {
  if (hasUserRoles(existingRoles)) return []
  return DEFAULT_ROLES.map((role) => ({
    ...role,
    aliases: [...role.aliases],
    channel: { ...role.channel },
  }))
}

/**
 * 解析出最终生效的角色表：用户角色优先，没有用户角色时才用默认角色。
 *
 * @param {unknown} existingRoles
 * @returns {object[]}
 */
export function resolveEffectiveRoles(existingRoles) {
  if (hasUserRoles(existingRoles)) {
    return /** @type {any[]} */ (existingRoles).filter(isPlainObject)
  }
  return defaultRolesFor(existingRoles)
}

export default DEFAULT_ROLES
