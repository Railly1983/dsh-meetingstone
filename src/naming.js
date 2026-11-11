// @ts-check
/**
 * 派单标签命名（P0-1）。
 *
 * 一个名字，三处复用：
 * - `startActivation({ label })` → 宿主 `subagent/descriptor` / `subagent/catalog`
 *   → Subagents 面板行标题（官方字段，见 docs/gui-0.2.0.md §6）；
 * - `ctx.jobs.start({ label })` → Background Tasks 面板行标题；
 * - 工具回执 / 落盘记录里的短任务名。
 *
 * 规则：`角色简称 · 简短目标（≤14 字）`
 * - 目标优先取 TaskSpec.title（结构化简报里的短任务名），否则取任务首个有效行；
 * - 去掉 Markdown 符号（`* _ # ` [ ] ( ) { } < > | ~ \`）与控制字符；
 * - 去掉 `meetingstone:` 内部前缀（历史 label 是 `meetingstone:<roleId>`）；
 * - 去掉 `任务：` / `Task:` 这类正文标签；
 * - 空标题回退 `未命名任务`，空角色回退 `未知角色`；
 * - 英文 / 数字原样保留；按码点截断，不会切坏 emoji/汉字。
 *
 * 本模块只做纯字符串处理：不读配置、不查注册表、不产生副作用。
 */

/** 任务摘要的最大字符数（含省略号）。 */
export const TASK_TITLE_MAX_CHARS = 14

/** 空任务标题的兜底（调用方不得展示空标签）。 */
export const UNKNOWN_TASK_TITLE = '未命名任务'

/** 空角色名的兜底。 */
export const UNKNOWN_ROLE_NAME = '未知角色'

/** 角色与目标之间的分隔符。 */
export const LABEL_SEPARATOR = ' · '

const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_LINK = /!?\[([^\]]*)\]\([^)]*\)/g
const HEADING = /^[ \t]*#{1,6}[ \t]+/gm
const BLOCKQUOTE = /^[ \t]*>[ \t]?/gm
// 行内 Markdown 装饰字符：直接删除，不参与截断
const INLINE_MARKUP = /[*_~#`|\\]/g
// 括号类字符替换成空格：`[P0-B]（证据）` → `P0-B 证据`
const BRACKETS = /[[\](){}<>]/g
// 控制字符：保留 \t \n \r，先按行处理列表标记，最后再折叠空白
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const INTERNAL_PREFIX = /meetingstone:\s*/gi
const TASK_LABEL_PREFIX = /^(?:任务|task)\s*[:：]\s*/i
// 行首列表标记（`- 修复` / `1. 修复`）；不碰任务正文里的 `F1–F8` 连字符
const LINE_LIST_MARKER = /^[ \t]*(?:[-+]|\d+[.)])[ \t]+/gm
const LEADING_NOISE = /^[\s·:：,，、;；|]+/u
const TRAILING_NOISE = /[\s·:：,，、;；|]+$/u

/**
 * 把任意值当作文本读；非字符串一律视为空（不把对象序列化成 `[object Object]`）。
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 清理一行展示文本：去 Markdown 符号、内部前缀、正文标签、控制字符。
 * 返回空串表示这一行没有可展示内容（由调用方决定回退）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripMarkdown(value) {
  let text = asText(value)
  // 围栏代码块整体丢弃：标签里不需要多行代码
  text = text.replace(FENCED_CODE, ' ')
  // 链接/图片只保留可见文字
  text = text.replace(INLINE_LINK, '$1')
  text = text.replace(HEADING, '')
  text = text.replace(BLOCKQUOTE, '')
  text = text.replace(INLINE_MARKUP, '')
  // 先换成空格再折叠，避免 `修复（证据）` 变成 `修复证据`
  text = text.replace(BRACKETS, ' ')
  text = text.replace(CONTROL_CHARS, ' ')
  text = text.replace(INTERNAL_PREFIX, '')
  text = text.replace(TASK_LABEL_PREFIX, '')
  text = text.replace(LINE_LIST_MARKER, '')
  text = text.replace(/\s+/gu, ' ').trim()
  text = text.replace(LEADING_NOISE, '')
  text = text.replace(TRAILING_NOISE, '')
  return text.trim()
}

/**
 * 取任务的首个有效行（跳过只由 Markdown 符号构成的空行）。
 * @param {unknown} task
 * @returns {string}
 */
function firstMeaningfulLine(task) {
  const text = asText(task)
  for (const line of text.split(/\r?\n/u)) {
    const cleaned = stripMarkdown(line)
    if (cleaned) return cleaned
  }
  return ''
}

/**
 * 按码点截断；超长时保留 `max - 1` 个字符 + 省略号，总长仍 ≤ max。
 * `max` 非法时回退到 {@link TASK_TITLE_MAX_CHARS}。
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function clipChars(value, max = TASK_TITLE_MAX_CHARS) {
  const limit =
    typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : TASK_TITLE_MAX_CHARS
  const text = String(value ?? '')
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  return `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`
}

/**
 * 角色简称：优先 `role.name`；没有名字时退回 `roleId`（去掉 `role-` 前缀）。
 * 只做展示清洗，不猜角色语义。
 *
 * @param {any} role
 * @returns {string}
 */
export function roleShortName(role) {
  const name = stripMarkdown(role?.name)
  if (name) return name

  const roleId = stripMarkdown(role?.roleId)
  if (roleId) {
    const withoutRolePrefix = roleId.replace(/^role[-_:]/i, '')
    return withoutRolePrefix || roleId
  }
  return UNKNOWN_ROLE_NAME
}

/**
 * 简短目标：TaskSpec.title 优先，其次任务首个有效行；都为空时回退 `未命名任务`。
 *
 * @param {unknown} task
 * @param {any} [taskSpec]
 * @param {number} [max]
 * @returns {string}
 */
export function taskShortTitle(task, taskSpec = null, max = TASK_TITLE_MAX_CHARS) {
  const specTitle = stripMarkdown(taskSpec?.title)
  if (specTitle) return clipChars(specTitle, max)

  const first = firstMeaningfulLine(task)
  if (first) return clipChars(first, max)

  return UNKNOWN_TASK_TITLE
}

/**
 * 统一命名：`角色简称 · 简短目标（≤14 字）`。
 * 同时用于 Subagents 的 `startActivation.label` 与 Background Tasks 的 Job label。
 *
 * @param {any} role
 * @param {unknown} task
 * @param {any} [taskSpec]
 * @returns {string}
 */
export function buildTaskLabel(role, task, taskSpec = null) {
  return `${roleShortName(role)}${LABEL_SEPARATOR}${taskShortTitle(task, taskSpec)}`
}

export default buildTaskLabel
