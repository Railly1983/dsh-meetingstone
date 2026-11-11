// @ts-check
/**
 * 确定性角色路由（P1-B）。
 *
 * 只做一件事：把「任务文本」按**显式关键词规则表**映射到一个角色 ID，并给出可解释的
 * `reason`。边界（勿扩大）：
 * - **不是 AI 分类器**：不调用模型、不做语义相似度、不学历史；
 * - **不改变 provider / model / 权限**：角色决定执行通道，这里只选角色；
 * - **只从 `enabled` 且 `availability === 'available'` 的角色中选**：不可用/停用/歧义角色
 *   一律不参与自动路由（失败关闭，不猜）；
 * - **确定性**：同一任务文本 + 同一角色表 + 同一规则表，结果永远一致。优先级为
 *   「关键词在任务中首次出现的位置」→ 规则表顺序 → 角色表顺序。
 *
 * 规则表可配置（插件配置 `routingRules` 覆盖内置表）；内置表见
 * `DEFAULT_ROUTING_RULES`，文档见 `docs/configuration.md` §1.2。
 */

/** 自动路由错误码：没有可用角色 / 没有默认角色可兜底。 */
export const ROUTING_ERRORS = Object.freeze({
  AUTO_ROUTE_FAILED: 'AUTO_ROUTE_FAILED',
})

/**
 * 内置规则表（顺序 = 同名次时的优先级）。
 *
 * 每条的字段：
 * - `taskType`：任务类型标识（会写进 reason，便于审计）
 * - `label`：人类可读的类型名
 * - `keywords`：命中「这是哪类任务」的关键词（大小写不敏感；ASCII 按词边界匹配）
 * - `roleKeywords`：用来在角色表里找对应角色的关键词（匹配 roleId / name / aliases，
 *   其次 description，最后才看 prompt；prompt 只作为弱信号兜底，不把整段人设当成路由依据）
 * - `roleIds`：可选，直接钉死角色 ID（优先级高于 roleKeywords）
 */
export const DEFAULT_ROUTING_RULES = Object.freeze([
  Object.freeze({
    taskType: 'architecture',
    label: '评审/决策',
    keywords: Object.freeze([
      'architecture',
      'architect',
      '架构',
      '决策',
      '选型',
      '技术方案',
    ]),
    roleKeywords: Object.freeze([
      'architect',
      'architecture',
      '架构',
      '决策',
      '设计',
      'lead',
      '领导',
    ]),
    roleIds: Object.freeze([]),
  }),
  Object.freeze({
    taskType: 'review',
    label: '评审',
    keywords: Object.freeze([
      'review',
      'code review',
      '审查',
      '评审',
      '复核',
      '审核',
      '审计',
      '验收',
    ]),
    roleKeywords: Object.freeze([
      'review',
      'reviewer',
      '审查',
      '评审',
      '复核',
      '审核',
      '审计',
      '验收',
    ]),
    roleIds: Object.freeze([]),
  }),
  Object.freeze({
    taskType: 'research',
    label: '调研',
    keywords: Object.freeze([
      'research',
      'investigate',
      'explore',
      '调研',
      '研究',
      '调查',
      '探索',
      '分析',
      '检索',
    ]),
    roleKeywords: Object.freeze([
      'research',
      'researcher',
      'scout',
      '调研',
      '研究',
      '调查',
      '探索',
      '分析',
      '检索',
    ]),
    roleIds: Object.freeze([]),
  }),
  Object.freeze({
    taskType: 'edit',
    label: '执行',
    keywords: Object.freeze([
      'edit',
      'implement',
      'implementation',
      'fix',
      'bugfix',
      'refactor',
      'patch',
      '实现',
      '修复',
      '修改',
      '编辑',
      '开发',
      '重构',
      '编写',
      '改',
      '写',
    ]),
    roleKeywords: Object.freeze([
      'implement',
      'implementer',
      'developer',
      'dev',
      'worker',
      '执行',
      '实现',
      '修复',
      '开发',
      '主力',
      '干活',
      '骨干',
    ]),
    roleIds: Object.freeze([]),
  }),
])

/** @param {unknown} value @returns {string[]} */
function asStringList(value) {
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

/** @param {unknown} value @returns {string} */
function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 规范化规则表：配置为空/非法时退回内置表；非法条目跳过（不因一条坏规则整体失效）。
 * 返回值是深拷贝后的纯数据，调用方改它不会影响内置表。
 *
 * @param {unknown} rules
 * @returns {Array<{ taskType: string, label: string, keywords: string[],
 *   roleKeywords: string[], roleIds: string[] }>}
 */
export function normalizeRoutingRules(rules) {
  const source = Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_ROUTING_RULES
  /** @type {Array<{ taskType: string, label: string, keywords: string[],
   *   roleKeywords: string[], roleIds: string[] }>} */
  const out = []
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue
    const input = /** @type {Record<string, unknown>} */ (raw)
    const taskType = asText(input.taskType)
    const keywords = asStringList(input.keywords)
    if (!taskType || keywords.length === 0) continue
    out.push({
      taskType,
      label: asText(input.label) || taskType,
      keywords,
      roleKeywords: asStringList(input.roleKeywords),
      roleIds: asStringList(input.roleIds),
    })
  }
  return out.length > 0 ? out : normalizeRoutingRules(DEFAULT_ROUTING_RULES)
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 关键词在文本中的首次出现位置；找不到返回 -1。
 * ASCII 关键词按「非字母数字边界」匹配，避免 `fix` 命中 `prefix`；
 * 含中文的关键词直接做子串匹配。
 *
 * @param {string} text 已小写化的任务文本
 * @param {string} keyword 原始关键词
 */
function keywordIndex(text, keyword) {
  const needle = keyword.toLowerCase()
  if (!needle) return -1
  // 全 ASCII：加左右边界（lookaround 不消费字符，索引仍是关键词起点）
  if (/^[\x20-\x7e]+$/.test(needle)) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`, 'i')
    const match = re.exec(text)
    return match ? match.index : -1
  }
  return text.indexOf(needle)
}

/**
 * 找到「首次出现位置最靠前」的任务类型规则；同位置时规则表里靠前的胜出。
 * 任务里多个类型关键词同时出现时，**以最先出现的为准**（如「修复 review 发现的问题」
 * 归执行，「review 并修复」归评审），比固定类型优先级更贴近任务的主语动词。
 *
 * @param {string} task
 * @param {ReturnType<typeof normalizeRoutingRules>} rules
 * @returns {{ rule: ReturnType<typeof normalizeRoutingRules>[number], keyword: string, index: number } | null}
 */
function matchTaskRule(task, rules) {
  const text = task.toLowerCase()
  /** @type {{ rule: any, keyword: string, index: number } | null} */
  let best = null
  for (const rule of rules) {
    /** @type {{ keyword: string, index: number } | null} */
    let local = null
    for (const keyword of rule.keywords) {
      const index = keywordIndex(text, keyword)
      if (index < 0) continue
      if (!local || index < local.index) local = { keyword, index }
    }
    if (local && (!best || local.index < best.index)) {
      best = { rule, keyword: local.keyword, index: local.index }
    }
  }
  return best
}

/** @param {unknown} value */
function roleToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** 可用于自动路由的角色：启用 + 可用。 */
function isRoutable(role) {
  return (
    Boolean(role) &&
    typeof role === 'object' &&
    role.enabled !== false &&
    role.disabled !== true &&
    role.availability === 'available'
  )
}

/** 角色 token / 描述里是否含某个关键词（ASCII 按词边界，中文按子串）。 */
function tokenContains(token, keyword) {
  const lowered = token.toLowerCase()
  const needle = keyword.toLowerCase()
  if (!needle) return false
  if (/^[\x20-\x7e]+$/.test(needle)) {
    return new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`, 'i').test(lowered)
  }
  return lowered.includes(needle)
}

/** roleId / name / aliases：强匹配来源。 */
function roleIdentityTokens(role) {
  /** @type {string[]} */
  const raw = [
    role.roleId,
    role.name,
    ...(Array.isArray(role.aliases) ? role.aliases : []),
  ]
  return [...new Set(raw.map(roleToken).filter(Boolean))]
}

/**
 * 在候选角色里为某条规则找角色。
 * 优先级：规则显式 roleIds → roleId/name/aliases 命中 → description 命中 → 角色表顺序。
 *
 * @param {{ roleIds: string[], roleKeywords: string[] }} rule
 * @param {any[]} candidates
 * @returns {{ role: any, how: string } | null}
 */
function matchRoleForRule(rule, candidates) {
  const byId = new Map()
  for (const role of candidates) byId.set(roleToken(role.roleId), role)

  for (const id of rule.roleIds) {
    const role = byId.get(roleToken(id))
    if (role) return { role, how: `规则 roleIds 指定「${id}」` }
  }

  const keywords = rule.roleKeywords.map(roleToken).filter(Boolean)
  if (keywords.length === 0) return null

  for (const role of candidates) {
    for (const token of roleIdentityTokens(role)) {
      const hit = keywords.find((keyword) => tokenContains(token, keyword))
      if (hit) return { role, how: `角色标识/名称/别名含「${hit}」` }
    }
  }
  for (const role of candidates) {
    const description = roleToken(role.description)
    if (!description) continue
    const hit = keywords.find((keyword) => tokenContains(description, keyword))
    if (hit) return { role, how: `角色描述含「${hit}」` }
  }
  // 最后才看人设：老配置里职责说明可能很泛（如「什么都会干」），具体能力写在 prompt 里。
  // 这是弱信号兜底，只在标识/别名/描述都没命中时使用。
  for (const role of candidates) {
    const prompt = roleToken(role.prompt)
    if (!prompt) continue
    const hit = keywords.find((keyword) => tokenContains(prompt, keyword))
    if (hit) return { role, how: `角色人设含「${hit}」` }
  }
  return null
}

/**
 * @param {any[]} candidates
 * @param {unknown} defaultRoleId
 */
function findDefaultRole(candidates, defaultRoleId) {
  const id = roleToken(defaultRoleId)
  if (!id) return null
  return candidates.find((role) => roleToken(role.roleId) === id) ?? null
}

/**
 * 按规则给任务选一个角色。
 *
 * @param {object} input
 * @param {unknown} input.task 任务文本
 * @param {any[]} [input.roles] 角色表；每项可带 `availability`（register 层用
 *   `roleAvailability()` 标注）。只有 `enabled !== false && availability === 'available'` 才参与。
 * @param {unknown} [input.defaultRoleId] 兜底角色 ID
 * @param {unknown} [input.rules] 自定义规则表；空/非法时用内置表
 * @returns {{ ok: true, roleId: string, reason: string, source: 'rule' | 'default',
 *   taskType?: string, matchedKeyword?: string }
 *   | { ok: false, code: string, message: string }}
 */
export function routeTask({ task, roles, defaultRoleId, rules } = {}) {
  const allRoles = Array.isArray(roles) ? roles.filter((role) => role && typeof role === 'object') : []
  const candidates = allRoles.filter(isRoutable)
  const effectiveRules = normalizeRoutingRules(rules)
  const taskText = typeof task === 'string' ? task : ''

  if (candidates.length === 0) {
    return {
      ok: false,
      code: ROUTING_ERRORS.AUTO_ROUTE_FAILED,
      message:
        `没有可参与自动路由的角色：角色表共 ${allRoles.length} 个，` +
        '只有 enabled 且 availability=available 的角色能被选中；' +
        '请先启用/安装对应 provider，或显式指定 role',
    }
  }

  const matched = matchTaskRule(taskText, effectiveRules)
  if (matched) {
    const picked = matchRoleForRule(matched.rule, candidates)
    if (picked) {
      return {
        ok: true,
        roleId: picked.role.roleId,
        source: 'rule',
        taskType: matched.rule.taskType,
        matchedKeyword: matched.keyword,
        reason:
          `任务含关键词「${matched.keyword}」→ ${matched.rule.label}规则（${matched.rule.taskType}），` +
          `选择「${picked.role.name ?? picked.role.roleId}」（${picked.role.roleId}；${picked.how}）`,
      }
    }

    const fallback = findDefaultRole(candidates, defaultRoleId)
    if (fallback) {
      return {
        ok: true,
        roleId: fallback.roleId,
        source: 'default',
        taskType: matched.rule.taskType,
        matchedKeyword: matched.keyword,
        reason:
          `任务含关键词「${matched.keyword}」→ ${matched.rule.label}规则（${matched.rule.taskType}），` +
          `但没有匹配到可用的${matched.rule.label}角色；回退 defaultRoleId「${fallback.roleId}」` +
          `（${fallback.name ?? fallback.roleId}）`,
      }
    }

    return {
      ok: false,
      code: ROUTING_ERRORS.AUTO_ROUTE_FAILED,
      message:
        `任务命中${matched.rule.label}规则（关键词「${matched.keyword}」），` +
        '但可用角色里没有匹配项，且 defaultRoleId 未配置或不可用；' +
        '请显式指定 role，或补配置可用角色/defaultRoleId',
    }
  }

  const fallback = findDefaultRole(candidates, defaultRoleId)
  if (fallback) {
    return {
      ok: true,
      roleId: fallback.roleId,
      source: 'default',
      reason:
        `没有命中任务类型关键词；回退 defaultRoleId「${fallback.roleId}」` +
        `（${fallback.name ?? fallback.roleId}）`,
    }
  }

  return {
    ok: false,
    code: ROUTING_ERRORS.AUTO_ROUTE_FAILED,
    message:
      '没有命中任务类型关键词，且 defaultRoleId 未配置或不可用；' +
      '请显式指定 role，或补配置可用角色/defaultRoleId',
  }
}
