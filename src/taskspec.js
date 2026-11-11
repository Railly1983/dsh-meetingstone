// @ts-check
/**
 * TaskSpec + ContextPack（P0-B）。
 *
 * 目标（docs/reference/efficiency-v1.0.md §3.2 / §3.3）：
 * - 派单可以带一份**最小结构化简报**，让子 Agent 不必从全仓库重新探索
 * - 只拒绝「缺了就无法执行 / 无法验收」的关键字段，绝不把简单任务做成表单
 * - 纯字符串 task 仍然完全可用（不传任何结构化字段 = 旧路径，零行为变化）
 *
 * 设计边界：
 * - 这里只做校验、渲染和记录摘要，**不产生任何 AI 调用**
 * - 不读文件、不解析项目、不猜任务类型；所有判断都只看调用方给的字段
 * - 结构未知的键一律忽略（向前兼容）
 */

/** 结构化校验失败的错误码。 */
export const TASKSPEC_ERROR = 'TASKSPEC_INVALID'

/** 出现任意一个即进入「结构化模式」。 */
const STRUCTURED_FIELDS = Object.freeze([
  'title',
  'objective',
  'scope',
  'acceptance',
  'evidence',
  'contextRefs',
  'roleHint',
  'outputBudget',
  'contextPack',
])

/** 落盘摘要的单条上限（字符数，不是字节）。 */
const RECORD_LIST_ITEMS = 10
const RECORD_ITEM_CHARS = 200
const RECORD_TITLE_CHARS = 120
const RECORD_OBJECTIVE_CHARS = 400

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 按码点截断（不会切坏 emoji/汉字）。
 * @param {unknown} value
 * @param {number} max
 */
function clip(value, max) {
  const text = typeof value === 'string' ? value : ''
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 校验字符串数组；错误写进 issues，返回已清洗的数组。
 *
 * `strict:true` 用于**保护字段**（验收/范围/禁止重复）：绝不静默截断，
 * 超过单条长度或条数上限时写 issue 让调用方明确拒绝，而不是丢掉中间约束。
 *
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} issues
 * @param {{ maxItems?: number, maxChars?: number, strict?: boolean }} [options]
 * @returns {string[]}
 */
function readStringList(value, path, issues, options = {}) {
  const maxItems = options.maxItems ?? 50
  const maxChars = options.maxChars ?? 500
  const strict = options.strict === true
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    issues.push(`${path}（必须是字符串数组）`)
    return []
  }
  /** @type {string[]} */
  const out = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (typeof item !== 'string' || !item.trim()) {
      issues.push(`${path}[${index}]（必须是非空字符串）`)
      continue
    }
    if (out.length >= maxItems) {
      if (strict) {
        issues.push(
          `${path}（最多 ${maxItems} 条，收到 ${value.length} 条；保护字段不会被静默丢弃，请拆分为多次派单）`,
        )
      }
      break
    }
    if (strict) {
      const chars = Array.from(item.trim())
      if (chars.length > maxChars) {
        issues.push(
          `${path}[${index}]（长度 ${chars.length} 字符，超过上限 ${maxChars}；保护字段不会被静默截断，请拆分为多条）`,
        )
        continue
      }
      out.push(item.trim())
      continue
    }
    out.push(item.trim().slice(0, maxChars))
  }
  return out
}

/**
 * 校验并规范化一次派单的结构化字段。
 *
 * 只在这些情况下拒绝：
 * - 结构化模式下缺 `title`（Jobs / list_runs 无法展示任务名）
 * - 提供了 `scope`（声明了执行边界）却没有 `acceptance`（无法验收）
 * - 关键字段类型错误（布尔当数组、对象当字符串等）
 * 简单查询不传 scope/acceptance/evidence 一律放行。
 *
 * @param {Record<string, unknown>} args
 * @returns {{ ok: true, structured: boolean, spec: any | null, contextPack: any | null }
 *   | { ok: false, code: string, message: string, fields: string[] }}
 */
export function validateTaskSpec(args) {
  const source = isPlainObject(args) ? /** @type {Record<string, unknown>} */ (args) : {}
  const structured = STRUCTURED_FIELDS.some(
    (key) => Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null,
  )
  if (!structured) return { ok: true, structured: false, spec: null, contextPack: null }

  /** @type {string[]} */
  const issues = []

  /**
   * @param {string} field
   * @param {string} message
   */
  const reject = (field, message) => {
    issues.push(`${field}（${message}）`)
  }

  // title：结构化模式的唯一硬必填
  const rawTitle = source.title
  if (typeof rawTitle !== 'string' || !rawTitle.trim()) {
    reject('title', '结构化模式必须提供短任务名，用于 Jobs / list_runs 展示')
  }

  // objective：可选；缺省时任务正文即目标
  let objective = ''
  if (source.objective !== undefined && source.objective !== null) {
    if (typeof source.objective !== 'string' || !source.objective.trim()) {
      reject('objective', '必须是非空字符串（可省略，省略时任务正文即目标）')
    } else {
      objective = source.objective.trim()
    }
  }

  // scope：可选；给了就必须是 { include[], exclude[] }
  let include = []
  let exclude = []
  if (source.scope !== undefined && source.scope !== null) {
    if (!isPlainObject(source.scope)) {
      reject('scope', '必须是对象 { include: string[], exclude: string[] }')
    } else {
      const scope = /** @type {Record<string, unknown>} */ (source.scope)
      // scope 是任务边界：超长/超条数显式拒绝，不静默 slice
      include = readStringList(scope.include, 'scope.include', issues, {
        maxItems: 100,
        maxChars: 500,
        strict: true,
      })
      exclude = readStringList(scope.exclude, 'scope.exclude', issues, {
        maxItems: 100,
        maxChars: 500,
        strict: true,
      })
    }
  }

  const scopeDeclared = include.length > 0 || exclude.length > 0
  const acceptanceIssuesBefore = issues.length
  const acceptance = readStringList(source.acceptance, 'acceptance', issues, {
    maxItems: 50,
    maxChars: 500,
    strict: true,
  })
  if (scopeDeclared && acceptance.length === 0 && issues.length === acceptanceIssuesBefore) {
    reject('acceptance', '已声明 scope，必须给出至少一条验收标准，否则任务无法验收')
  }

  const evidence = readStringList(source.evidence, 'evidence', issues, { maxItems: 50, maxChars: 500 })
  const contextRefs = readStringList(source.contextRefs, 'contextRefs', issues, {
    maxItems: 50,
    maxChars: 500,
  })

  let roleHint = null
  if (source.roleHint !== undefined && source.roleHint !== null) {
    if (typeof source.roleHint !== 'string' || !source.roleHint.trim()) {
      reject('roleHint', '必须是非空字符串')
    } else {
      roleHint = source.roleHint.trim().slice(0, 200)
    }
  }

  /** @type {{ summaryTokens: number, notes: string } | null} */
  let outputBudget = null
  if (source.outputBudget !== undefined && source.outputBudget !== null) {
    if (typeof source.outputBudget === 'number') {
      if (!Number.isInteger(source.outputBudget) || source.outputBudget <= 0) {
        reject('outputBudget', '数字形式必须是正整数（摘要 token 预算）')
      } else {
        outputBudget = { summaryTokens: source.outputBudget, notes: '' }
      }
    } else if (!isPlainObject(source.outputBudget)) {
      reject('outputBudget', '必须是正整数或 { summaryTokens?: number, notes?: string }')
    } else {
      const budget = /** @type {Record<string, unknown>} */ (source.outputBudget)
      let summaryTokens = 400
      if (budget.summaryTokens !== undefined) {
        if (!Number.isInteger(budget.summaryTokens) || Number(budget.summaryTokens) <= 0) {
          reject('outputBudget.summaryTokens', '必须是正整数')
        } else {
          summaryTokens = Number(budget.summaryTokens)
        }
      }
      let notes = ''
      if (budget.notes !== undefined) {
        if (typeof budget.notes !== 'string') reject('outputBudget.notes', '必须是字符串')
        else notes = budget.notes.trim().slice(0, 500)
      }
      outputBudget = { summaryTokens, notes }
    }
  }

  // ContextPack：可选；只校验形状，不强制要求任何子字段
  let contextPack = null
  if (source.contextPack !== undefined && source.contextPack !== null) {
    if (!isPlainObject(source.contextPack)) {
      reject('contextPack', '必须是对象 { knownFacts[], files[], priorResults[], doNotRepeat[] }')
    } else {
      const pack = /** @type {Record<string, unknown>} */ (source.contextPack)
      const knownFacts = readStringList(pack.knownFacts, 'contextPack.knownFacts', issues, {
        maxItems: 100,
        maxChars: 500,
      })
      const files = readStringList(pack.files, 'contextPack.files', issues, {
        maxItems: 100,
        maxChars: 500,
      })
      const doNotRepeat = readStringList(pack.doNotRepeat, 'contextPack.doNotRepeat', issues, {
        maxItems: 100,
        maxChars: 300,
        strict: true,
      })
      /** @type {Array<{ summary: string, artifactRef: string | null }>} */
      const priorResults = []
      if (pack.priorResults !== undefined && pack.priorResults !== null) {
        if (!Array.isArray(pack.priorResults)) {
          reject('contextPack.priorResults', '必须是数组 [{ summary, artifactRef }]')
        } else {
          for (let index = 0; index < pack.priorResults.length; index += 1) {
            const item = pack.priorResults[index]
            if (!isPlainObject(item)) {
              reject(`contextPack.priorResults[${index}]`, '必须是对象 { summary, artifactRef }')
              continue
            }
            const entry = /** @type {Record<string, unknown>} */ (item)
            if (typeof entry.summary !== 'string' || !entry.summary.trim()) {
              reject(`contextPack.priorResults[${index}].summary`, '必须是非空字符串')
              continue
            }
            if (entry.artifactRef !== undefined && entry.artifactRef !== null && typeof entry.artifactRef !== 'string') {
              reject(`contextPack.priorResults[${index}].artifactRef`, '必须是字符串')
              continue
            }
            priorResults.push({
              summary: entry.summary.trim().slice(0, 500),
              artifactRef:
                typeof entry.artifactRef === 'string' && entry.artifactRef.trim()
                  ? entry.artifactRef.trim().slice(0, 500)
                  : null,
            })
            if (priorResults.length >= 20) break
          }
        }
      }
      contextPack = { knownFacts, files, priorResults, doNotRepeat }
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: TASKSPEC_ERROR,
      message: `任务简报（TaskSpec）不合法：${issues.join('；')}`,
      fields: [...new Set(issues.map((issue) => issue.split('（')[0].replace(/\[\d+\]/g, '')))],
    }
  }

  return {
    ok: true,
    structured: true,
    spec: {
      title: String(rawTitle).trim().slice(0, 200),
      objective,
      scope: { include, exclude },
      acceptance,
      evidence,
      contextRefs,
      roleHint,
      outputBudget,
    },
    contextPack,
  }
}

/**
 * 把 TaskSpec + ContextPack 渲染成**结构化文本块**，插在人设之后、任务正文之前。
 * 没有任何结构化字段时返回空串（旧路径的提示词一字不变）。
 *
 * @param {any} spec
 * @param {any} contextPack
 * @returns {string}
 */
export function renderTaskBrief(spec, contextPack) {
  if (!spec || typeof spec !== 'object' || !spec.title) return ''
  /** @type {string[]} */
  const lines = ['[TASK SPEC — 结构化任务简报]']
  lines.push(`title: ${spec.title}`)
  if (spec.objective) lines.push(`objective: ${spec.objective}`)
  const include = Array.isArray(spec.scope?.include) ? spec.scope.include : []
  const exclude = Array.isArray(spec.scope?.exclude) ? spec.scope.exclude : []
  if (include.length > 0) {
    lines.push('scope.include:')
    for (const item of include) lines.push(`- ${item}`)
  }
  if (exclude.length > 0) {
    lines.push('scope.exclude:')
    for (const item of exclude) lines.push(`- ${item}`)
  }
  if (Array.isArray(spec.acceptance) && spec.acceptance.length > 0) {
    lines.push('acceptance:')
    for (const item of spec.acceptance) lines.push(`- ${item}`)
  }
  if (Array.isArray(spec.evidence) && spec.evidence.length > 0) {
    lines.push('evidence:')
    for (const item of spec.evidence) lines.push(`- ${item}`)
  }
  if (Array.isArray(spec.contextRefs) && spec.contextRefs.length > 0) {
    lines.push('contextRefs:')
    for (const item of spec.contextRefs) lines.push(`- ${item}`)
  }
  if (spec.roleHint) lines.push(`roleHint: ${spec.roleHint}`)
  // 保护字段（§8）：有就原样出现在简报里，不依赖自由文本描述。
  for (const key of ['permissions', 'permissionPreset', 'safetyPolicy']) {
    const value = spec[key]
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${Array.isArray(value) ? value.join('; ') : String(value)}`)
  }
  if (spec.outputBudget) {
    const notes = spec.outputBudget.notes ? `（${spec.outputBudget.notes}）` : ''
    lines.push(`outputBudget: summary ≈ ${spec.outputBudget.summaryTokens} tokens${notes}`)
  }

  if (contextPack && typeof contextPack === 'object') {
    lines.push('[CONTEXT PACK — 已确认的最小上下文]')
    const knownFacts = Array.isArray(contextPack.knownFacts) ? contextPack.knownFacts : []
    if (knownFacts.length > 0) {
      lines.push('knownFacts:')
      for (const item of knownFacts) lines.push(`- ${item}`)
    }
    const files = Array.isArray(contextPack.files) ? contextPack.files : []
    if (files.length > 0) {
      lines.push('files:')
      for (const item of files) lines.push(`- ${item}`)
    }
    const priorResults = Array.isArray(contextPack.priorResults) ? contextPack.priorResults : []
    if (priorResults.length > 0) {
      lines.push('priorResults:')
      for (const item of priorResults) {
        lines.push(
          `- summary: ${item.summary}${item.artifactRef ? `（artifactRef: ${item.artifactRef}）` : ''}`,
        )
      }
    }
    const doNotRepeat = Array.isArray(contextPack.doNotRepeat) ? contextPack.doNotRepeat : []
    if (doNotRepeat.length > 0) {
      lines.push('doNotRepeat:')
      for (const item of doNotRepeat) lines.push(`- ${item}`)
    }
    for (const key of ['permissions', 'safetyPolicy']) {
      const value = contextPack[key]
      if (value === undefined || value === null) continue
      lines.push(`${key}: ${Array.isArray(value) ? value.join('; ') : String(value)}`)
    }
  }

  lines.push('[END TASK SPEC]')
  lines.push('约束：以上已知事实与文件清单视为已确认信息，不要重复探索整个仓库；回复只给结论、证据与产物引用，不要复述长文。')
  return lines.join('\n')
}

/**
 * 落盘用的 TaskSpec 摘要。
 *
 * **保护字段不参与截断**（docs/reference/efficiency-v1.0.md §8）：
 * acceptance / scope / permissions / safetyPolicy 原样保留，条数与单条长度都不裁剪；
 * 只有自由文本（title/objective/evidence/contextRefs/roleHint/outputBudget.notes）才裁剪。
 * 幂等：对已经摘要过的对象再调一次不会继续膨胀。
 * @param {any} spec
 */
export function summarizeTaskSpec(spec) {
  if (!spec || typeof spec !== 'object' || typeof spec.title !== 'string' || !spec.title) return null
  /** 自由文本：允许条数/长度裁剪。 */
  const list = (/** @type {unknown} */ value) =>
    Array.isArray(value)
      ? value
          .filter((/** @type {unknown} */ item) => typeof item === 'string' && item)
          .slice(0, RECORD_LIST_ITEMS)
          .map((/** @type {string} */ item) => clip(item, RECORD_ITEM_CHARS))
      : []
  /** 保护字段：原样保留（不裁剪、不去重）。 */
  const verbatimList = (/** @type {unknown} */ value) =>
    Array.isArray(value)
      ? value.filter((/** @type {unknown} */ item) => typeof item === 'string' && item)
      : []
  /** @type {Record<string, any>} */
  const summary = {
    title: clip(spec.title, RECORD_TITLE_CHARS),
    objective: clip(spec.objective, RECORD_OBJECTIVE_CHARS),
    scope: {
      include: verbatimList(spec.scope?.include),
      exclude: verbatimList(spec.scope?.exclude),
    },
    acceptance: verbatimList(spec.acceptance),
    evidence: list(spec.evidence),
    contextRefs: list(spec.contextRefs),
    roleHint: typeof spec.roleHint === 'string' && spec.roleHint ? clip(spec.roleHint, 100) : null,
    outputBudget:
      spec.outputBudget && Number.isInteger(spec.outputBudget.summaryTokens)
        ? {
            summaryTokens: spec.outputBudget.summaryTokens,
            notes: clip(spec.outputBudget.notes, 200),
          }
        : null,
  }
  // 权限/安全策略是保护字段：一旦提供就原样落盘（不裁剪、不改造）。
  if (spec.permissions !== undefined && spec.permissions !== null) summary.permissions = spec.permissions
  if (spec.permissionPreset !== undefined && spec.permissionPreset !== null) {
    summary.permissionPreset = spec.permissionPreset
  }
  if (spec.safetyPolicy !== undefined && spec.safetyPolicy !== null) summary.safetyPolicy = spec.safetyPolicy
  return summary
}

/**
 * 落盘用的 ContextPack 摘要。
 *
 * doNotRepeat 是保护字段（§8：不得重复的约束不能因摘要丢失），原样保留；
 * knownFacts/files/priorResults 属于自由文本，仍按条数/长度裁剪。
 * @param {any} pack
 */
export function summarizeContextPack(pack) {
  if (!pack || typeof pack !== 'object') return null
  const list = (/** @type {unknown} */ value, /** @type {number} */ max) =>
    Array.isArray(value)
      ? value
          .filter((/** @type {unknown} */ item) => typeof item === 'string' && item)
          .slice(0, max)
          .map((/** @type {string} */ item) => clip(item, RECORD_ITEM_CHARS))
      : []
  const priorResults = Array.isArray(pack.priorResults)
    ? pack.priorResults
        .filter((/** @type {any} */ item) => item && typeof item.summary === 'string' && item.summary)
        .slice(0, RECORD_LIST_ITEMS)
        .map((/** @type {any} */ item) => ({
          summary: clip(item.summary, RECORD_ITEM_CHARS),
          artifactRef:
            typeof item.artifactRef === 'string' && item.artifactRef
              ? clip(item.artifactRef, RECORD_ITEM_CHARS)
              : null,
        }))
    : []
  /** @type {Record<string, any>} */
  const summary = {
    knownFacts: list(pack.knownFacts, RECORD_LIST_ITEMS),
    files: list(pack.files, 30),
    priorResults,
    doNotRepeat: Array.isArray(pack.doNotRepeat)
      ? pack.doNotRepeat.filter((/** @type {unknown} */ item) => typeof item === 'string' && item)
      : [],
  }
  if (pack.permissions !== undefined && pack.permissions !== null) summary.permissions = pack.permissions
  if (pack.safetyPolicy !== undefined && pack.safetyPolicy !== null) summary.safetyPolicy = pack.safetyPolicy
  return summary
}
