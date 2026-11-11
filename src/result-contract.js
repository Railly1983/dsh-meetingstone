// @ts-check
/**
 * 结构化结果契约（P0-C）。
 *
 * 子 Agent 被要求在回复末尾给出一个 JSON 对象（status/summary/evidence/artifacts/
 * changedFiles/tests/openIssues/nextAction）。这里负责：
 * - 把「输出契约」渲染进提示词（不新增任何 AI 调用）
 * - 从结果文本里**容错**提取 JSON：整段 JSON / ```json 代码块 / 文本中的第一个平衡对象
 * - 提取不到就退回纯文本：`summary` = 原文（不是空、不是报错）
 * - 生成落盘字段与 handoff 摘要（结论/证据/产物/未决/下一步）
 *
 * 边界：解析失败不改变任务本身的状态，也不丢原文——完整输出仍然落盘。
 */
import { MAX_SUMMARY_BYTES, truncateUtf8 } from './run-store.js'

/** 子 Agent 允许自报的状态闭集（与记录 status 分开，不覆盖宿主终态）。 */
export const RESULT_STATUSES = Object.freeze(['completed', 'partial', 'blocked', 'failed'])

/** summary 落盘上限（UTF-8 字节）。约 2k token，够 300–500 token 的目标。 */
export const SUMMARY_MAX_BYTES = MAX_SUMMARY_BYTES
/** 数组字段的条数上限。 */
export const MAX_RESULT_ITEMS = 50
/** 单条字符串上限（字符）。 */
const MAX_ITEM_CHARS = 1000

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  const text = typeof value === 'string' ? value : ''
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 扫描文本里所有**平衡的顶层 `{...}`**（跳过字符串与转义）。
 * 用于「结果里夹着说明文字、JSON 在后面」的容错；不解析、不校验。
 *
 * 必须扫描全部对象：输出契约要求"回复的最后给出结果"，只扫前几个会让正文示例
 * 冒充最终结论（P0-C 审计 F6）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function balancedObjects(text) {
  /** @type {string[]} */
  const out = []
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return out
}

/** 结果对象的已知键；至少命中一个才认为是"结构化结果"。 */
const KNOWN_KEYS = Object.freeze([
  'status',
  'summary',
  'evidence',
  'artifacts',
  'changedFiles',
  'tests',
  'openIssues',
  'nextAction',
])

/** @param {Record<string, unknown>} value */
function hasKnownKey(value) {
  return KNOWN_KEYS.some((key) => Object.hasOwn(value, key))
}

/**
 * 从结果文本里提取结构化对象。
 *
 * 选择规则（P0-C 审计 F6）：**取文档顺序里最后一个合法结构化结果**。
 * 输出契约把结果放在回复末尾；正文中间经常有示例 JSON，取第一个会被示例冒充结论。
 * 同时扫描全部平衡对象（不再限制前三个），代码块里的多个对象也会被逐个尝试。
 *
 * @param {string} text
 * @returns {{ value: Record<string, unknown> | null, sawCandidate: boolean }}
 */
function extractJsonObject(text) {
  /** @type {string[]} */
  const candidates = []
  /** @type {Set<string>} */
  const seen = new Set()
  /** @param {unknown} candidate */
  const push = (candidate) => {
    if (typeof candidate !== 'string' || !candidate) return
    if (seen.has(candidate)) return
    seen.add(candidate)
    candidates.push(candidate)
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) push(trimmed)
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = match[1].trim()
    if (body.startsWith('{')) push(body)
  }
  for (const candidate of balancedObjects(text)) push(candidate)
  const sawCandidate = candidates.length > 0
  /** @type {Record<string, unknown> | null} */
  let selected = null
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (isPlainObject(value) && hasKnownKey(/** @type {Record<string, unknown>} */ (value))) {
        selected = /** @type {Record<string, unknown>} */ (value)
      }
    } catch {
      /* 坏 JSON：继续试下一个候选 */
    }
  }
  return { value: selected, sawCandidate }
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function readStringList(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  for (const item of value) {
    if (out.length >= MAX_RESULT_ITEMS) break
    if (typeof item === 'string' && item.trim()) out.push(item.trim().slice(0, MAX_ITEM_CHARS))
  }
  return out
}

/**
 * evidence 支持两种形状：字符串，或 `{ file, line, finding }`。
 * 字符串统一折成 `{ finding }`，让下游不用再分支。
 * @param {unknown} value
 * @returns {Array<{ file?: string, line?: number, finding?: string }>}
 */
function readEvidence(value) {
  if (!Array.isArray(value)) return []
  /** @type {Array<{ file?: string, line?: number, finding?: string }>} */
  const out = []
  for (const item of value) {
    if (out.length >= MAX_RESULT_ITEMS) break
    if (typeof item === 'string' && item.trim()) {
      out.push({ finding: item.trim().slice(0, MAX_ITEM_CHARS) })
      continue
    }
    if (!isPlainObject(item)) continue
    const source = /** @type {Record<string, unknown>} */ (item)
    /** @type {{ file?: string, line?: number, finding?: string }} */
    const entry = {}
    if (typeof source.file === 'string' && source.file.trim()) entry.file = source.file.trim().slice(0, 500)
    if (Number.isInteger(source.line)) entry.line = Number(source.line)
    const finding =
      typeof source.finding === 'string'
        ? source.finding
        : typeof source.note === 'string'
          ? source.note
          : ''
    if (finding.trim()) entry.finding = finding.trim().slice(0, MAX_ITEM_CHARS)
    if (entry.file || entry.line !== undefined || entry.finding) out.push(entry)
  }
  return out
}

/**
 * 解析子 Agent 的结果文本。
 *
 * @param {unknown} text
 * @returns {{ structured: boolean, status: string | null, summary: string,
 *   evidence: Array<{ file?: string, line?: number, finding?: string }>,
 *   artifacts: string[], changedFiles: string[], tests: string[],
 *   openIssues: string[], nextAction: string | null, sawCandidate: boolean }}
 */
export function parseStructuredResult(text) {
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text)
  const empty = {
    structured: false,
    status: null,
    summary: raw,
    evidence: [],
    artifacts: [],
    changedFiles: [],
    tests: [],
    openIssues: [],
    nextAction: null,
    sawCandidate: false,
  }
  if (!raw.trim()) return empty

  const extracted = extractJsonObject(raw)
  if (!extracted.value) return { ...empty, sawCandidate: extracted.sawCandidate }
  const value = extracted.value

  const rawSummary = typeof value.summary === 'string' ? value.summary.trim() : ''
  const nextAction =
    typeof value.nextAction === 'string' && value.nextAction.trim()
      ? value.nextAction.trim().slice(0, MAX_ITEM_CHARS)
      : null
  return {
    structured: true,
    status:
      typeof value.status === 'string' && RESULT_STATUSES.includes(value.status) ? value.status : null,
    // 结构化结果里没写 summary 时退回原文：宁可多给一点，也不要交空白
    summary: rawSummary || raw,
    evidence: readEvidence(value.evidence),
    artifacts: readStringList(value.artifacts),
    changedFiles: readStringList(value.changedFiles),
    tests: readStringList(value.tests),
    openIssues: readStringList(value.openIssues),
    nextAction,
    sawCandidate: extracted.sawCandidate,
  }
}

/**
 * Handoff 摘要：结论 / 证据 / 产物 / 未决 / 下一步。
 * 没有可用内容时返回 null（不写空壳）。
 *
 * @param {{ summary?: string, evidence?: Array<object>, artifacts?: string[],
 *   openIssues?: string[], nextAction?: string | null }} parsed
 */
export function buildHandoff(parsed) {
  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : ''
  const evidence = Array.isArray(parsed?.evidence) ? parsed.evidence.slice(0, 10) : []
  const artifacts = Array.isArray(parsed?.artifacts) ? parsed.artifacts.slice(0, 10) : []
  const openIssues = Array.isArray(parsed?.openIssues) ? parsed.openIssues.slice(0, 10) : []
  const nextAction =
    typeof parsed?.nextAction === 'string' && parsed.nextAction.trim() ? parsed.nextAction.trim() : null
  if (!summary && evidence.length === 0 && artifacts.length === 0 && openIssues.length === 0 && !nextAction) {
    return null
  }
  return {
    conclusion: clip(summary, 500),
    evidence,
    artifacts,
    openIssues,
    nextAction,
  }
}

/**
 * 解析结果 → 可直接写进 run 记录的字段。
 *
 * 注意：子 Agent 自报的 `changedFiles` 落到 `reportedChangedFiles`，
 * **不覆盖**记录里由 git 计算的 `changedFiles`（重叠检测依赖后者）。
 *
 * @param {{ structured: boolean, status: string | null, summary: string,
 *   evidence: Array<object>, artifacts: string[], changedFiles: string[],
 *   tests: string[], openIssues: string[], nextAction: string | null }} parsed
 * @returns {Record<string, unknown>}
 */
export function resultRecordFields(parsed) {
  if (!parsed || typeof parsed !== 'object') return {}
  const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
  if (!summary && parsed.structured !== true) return {}
  const truncated = truncateUtf8(summary, SUMMARY_MAX_BYTES, { headBytes: 6 * 1024 })
  const handoff = buildHandoff({ ...parsed, summary: truncated.text })
  return {
    structuredResult: parsed.structured === true,
    ...(parsed.status ? { resultStatus: parsed.status } : {}),
    summary: truncated.text,
    summaryBytes: Buffer.byteLength(summary, 'utf8'),
    summaryTruncated: truncated.truncated,
    ...(parsed.evidence.length > 0 ? { evidence: parsed.evidence } : {}),
    ...(parsed.artifacts.length > 0 ? { artifacts: parsed.artifacts } : {}),
    ...(parsed.changedFiles.length > 0 ? { reportedChangedFiles: parsed.changedFiles } : {}),
    ...(parsed.tests.length > 0 ? { resultTests: parsed.tests } : {}),
    ...(parsed.openIssues.length > 0 ? { openIssues: parsed.openIssues } : {}),
    ...(parsed.nextAction ? { nextAction: parsed.nextAction } : {}),
    ...(handoff ? { handoff } : {}),
  }
}

/**
 * 渲染给子 Agent 的输出契约（固定文本，不含 AI 调用）。
 * @returns {string}
 */
export function renderOutputContract() {
  return [
    '[OUTPUT CONTRACT — 必须遵守]',
    '回复的最后给出一个 JSON 对象（可放在 ```json 代码块里），字段：',
    '- status: completed | partial | blocked | failed',
    '- summary: 结论摘要，约 300–500 token；不要复述任务背景或过程',
    '- evidence: [{ file, line, finding }]（文件路径、行号、结论/命令结果）',
    '- artifacts: 完整报告 / 补丁 / 日志等文件路径',
    '- changedFiles: 本次修改的文件路径；只读任务为空数组',
    '- tests: 运行过的测试及结果',
    '- openIssues: 未解决问题、风险、后续建议',
    '- nextAction: 需要主控或下一角色执行的动作',
    '完整内容写入项目产物目录（如 .meetingstone/runs/），回复里只给路径；不要粘贴长文。',
    '[END OUTPUT CONTRACT]',
  ].join('\n')
}
