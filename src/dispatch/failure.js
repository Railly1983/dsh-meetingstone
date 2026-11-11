// @ts-check
/**
 * 失败快分类（P1-A）。
 *
 * 目标：任务失败后，主控能立刻知道「失败属于哪一类、下一步该做什么」，
 * 而不是只拿到一个 `stopReason` 就盲目原样重派。
 *
 * **只分类、只建议，不执行**：
 * - 不自动重试
 * - 不自动切换模型 / 角色 / provider
 * - 不维护冷却计时器
 *
 * 为什么不自动处置：额度耗尽要等重置、认证失败要人工换 key、权限被拒可能要改沙箱或
 * 审批策略——这些都是「需要人/主控拍板」的动作。插件自作主张重试只会把同一个错误
 * 再烧一遍额度，并让真实原因淹没在重试日志里。处置建议写进 `hint`，由主控决定。
 *
 * 分类闭集（`FAILURE_CLASS_VALUES`）：
 *   quota     额度/频率限制（Codex `category: limit`、ACP 429、refusal 且空输出）
 *   auth      认证失败（401、无效 API key、登录失效）
 *   permission 权限拒绝（403、EACCES/EPERM、无权限）
 *   timeout   超时（ETIMEDOUT、deadline exceeded）
 *   refusal   安全拒答且**非**额度问题（有输出、命中 safety/refusal）
 *   crash     进程异常 / 非零退出 / 被信号杀死
 *   network   网络异常（ECONNRESET、DNS、502/503/504）
 *   unknown   已判定失败但无法归入以上类别
 *
 * 成功任务返回 `{ failureClass: null, hint: null }`，绝不为了「有分类可展示」而误判。
 */

/** 失败分类白名单。落盘/读取都按它校验，避免写入任意字符串。 */
export const FAILURE_CLASSES = Object.freeze({
  QUOTA: 'quota',
  AUTH: 'auth',
  PERMISSION: 'permission',
  TIMEOUT: 'timeout',
  REFUSAL: 'refusal',
  CRASH: 'crash',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
})

/** @type {readonly string[]} */
export const FAILURE_CLASS_VALUES = Object.freeze(Object.values(FAILURE_CLASSES))

/**
 * 每类失败给主控的一句话建议。**只描述可执行动作，不承诺自动执行**。
 * 模板里的「：」会在有 provider 时替换为「（provider）：」。
 */
const HINTS = Object.freeze({
  quota:
    '额度/频率限制：等待额度重置，或改派其他 provider 的角色；不要原样重派',
  auth: '认证失败：先检查该 provider 的登录 / API key 是否有效，再重新派单',
  permission: '权限被拒：确认工作目录与命令权限（沙箱 / 审批）后重派',
  timeout: '执行超时：缩小任务范围或拆成子任务后重派，不要原样重试',
  network: '网络异常：检查到 provider 的连通性后再重试，别当成额度问题',
  refusal: '安全拒答（非额度）：改写任务措辞或换模型 / 角色；必要时人工确认',
  crash: '进程异常退出：查看 provider 日志与退出码后换角色重派，保留现场',
  unknown: '未知失败：先读 diagnostic 与 provider 日志，判断原因后再决定是否重派',
})

/** @param {unknown} value */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 把 error 统一成一段可检索文本（字符串错误、Error 形状、`{ code, message }` 都接受）。
 * @param {unknown} error
 */
function errorTextOf(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const source = /** @type {{ code?: unknown, message?: unknown, name?: unknown }} */ (error)
  return [textOf(source.name), textOf(source.code), textOf(source.message)]
    .filter(Boolean)
    .join(': ')
}

/**
 * 按固定优先级匹配。顺序很重要：
 * - 429 先归 quota，不能落到 network/refusal；
 * - 401 先归 auth，403 归 permission；
 * - ETIMEDOUT 先归 timeout，ECONNRESET 归 network；
 * - refusal+空输出按需求归 quota（真实场景是 CodeBuddy 429 的表现）。
 */
const MATCHERS = Object.freeze([
  [
    FAILURE_CLASSES.QUOTA,
    /(quota|rate[\s_-]?limit|too\s+many\s+requests|\b429\b|usage[\s_-]?limit|insufficient[\s_-]?(?:quota|credits?|balance)|category\s*:\s*limit|额度|配额|余额|频率限制|限流)/i,
  ],
  [
    FAILURE_CLASSES.AUTH,
    /(unauthori[sz]ed|invalid[\s_-]*(?:api[\s_-]*)?key|api[\s_-]*key[\s_-]*(?:invalid|missing|expired)|authentication\s*(?:fail|error|required)|authorization\s*(?:fail|error|denied)|credential|not\s+logged\s+in|login\s+(?:required|failed)|\b401\b|认证失败|未授权|登录失效|令牌(?:无效|过期)|凭证)/i,
  ],
  [
    FAILURE_CLASSES.PERMISSION,
    /(permission\s*(?:denied|error)|access\s*denied|forbidden|\b403\b|\beacces\b|\beperm\b|operation\s+not\s+permitted|not\s+allowed|权限|拒绝访问|无权限)/i,
  ],
  [
    FAILURE_CLASSES.TIMEOUT,
    /(timeout|time[\s_-]?out|timed\s+out|deadline\s+exceeded|\betimedout\b|超时)/i,
  ],
  [
    FAILURE_CLASSES.NETWORK,
    /(network|econnreset|econnrefused|enotfound|eai_again|socket|upstream|bad\s+gateway|\b502\b|\b503\b|\b504\b|网络|连接(?:失败|被拒|超时)|断网)/i,
  ],
  [
    FAILURE_CLASSES.REFUSAL,
    /(refus|safety|content[\s_-]*policy|blocked\s+by|拒答|安全拒|拒绝回答|内容政策)/i,
  ],
  [
    FAILURE_CLASSES.CRASH,
    /(crash|segfault|abnormal(?:ly)?\s+(?:exit|terminat)|non[\s_-]*zero|exit\s*(?:code|status)\s*[:=]?\s*[1-9]|signal\s*(?:sig)?(?:kill|term|segv|abrt)|\b(?:killed|terminated)\b|崩溃|异常退出|进程.*退出)/i,
  ],
])

/**
 * 给某类失败生成一句话建议。未知类别按 `unknown` 给，绝不返回空。
 * @param {string} failureClass
 * @param {string | null} [provider]
 */
export function hintForFailure(failureClass, provider = null) {
  const base = HINTS[/** @type {keyof typeof HINTS} */ (failureClass)] ?? HINTS.unknown
  const name = textOf(provider).trim()
  if (!name) return base
  return base.replace('：', `（${name}）：`)
}

/**
 * 是否属于白名单里的失败分类。run-store 读取旧记录/校验落盘字段时使用。
 * @param {unknown} value
 * @returns {value is string}
 */
export function isFailureClass(value) {
  return typeof value === 'string' && FAILURE_CLASS_VALUES.includes(value)
}

/**
 * 判断这次结算是否算「失败」。
 *
 * 失败的定义保持保守：
 * - `status` 是 failed → 失败；
 * - 带 `error` 对象 → 失败；
 * - `stopReason` 既不是空/completed，也不是取消/卸载（cancelled、plugin-disposed）→ 失败。
 *
 * 取消是用户主动动作，不算失败；成功的 completed 即使 diagnostic 里出现 429 字样，
 * 只要没有失败信号也不分类——避免把正常输出里的文本当成故障。
 *
 * @param {{ status?: unknown, stopReason?: unknown, error?: unknown }} input
 */
function looksLikeFailure(input) {
  const status = textOf(input.status).trim().toLowerCase()
  if (status === 'cancelled' || status === 'interrupted') return false
  if (status === 'failed') return true
  if (input.error) return true
  const stopReason = textOf(input.stopReason).trim().toLowerCase()
  if (!stopReason) return false
  if (stopReason === 'completed' || stopReason === 'cancelled' || stopReason === 'plugin-disposed') {
    return false
  }
  return true
}

/**
 * 失败快分类。
 *
 * @param {{
 *   status?: unknown,
 *   stopReason?: unknown,
 *   diagnostic?: unknown,
 *   error?: unknown,
 *   output?: unknown,
 *   provider?: unknown,
 * }} [input]
 * @returns {{ failureClass: string | null, hint: string | null }}
 */
export function classifyFailure(input = {}) {
  if (!looksLikeFailure(input)) return { failureClass: null, hint: null }

  const stopReason = textOf(input.stopReason).trim().toLowerCase()
  const output = textOf(input.output)
  const provider = textOf(input.provider).trim() || null

  // 真实故障：CodeBuddy 429 时 ACP 只回 refusal + 空输出，不带任何原因。
  // 需求明确把「refusal 且空输出」归入额度类，而不是泛化的安全拒答。
  if (stopReason === 'refusal' && output.trim() === '') {
    return { failureClass: FAILURE_CLASSES.QUOTA, hint: hintForFailure(FAILURE_CLASSES.QUOTA, provider) }
  }

  const haystack = [textOf(input.diagnostic), errorTextOf(input.error)]
    .filter((part) => part.trim() !== '')
    .join('\n')

  for (const [failureClass, pattern] of MATCHERS) {
    if (pattern.test(haystack)) {
      return { failureClass, hint: hintForFailure(failureClass, provider) }
    }
  }

  // 有输出、命中 stopReason=refusal，但文本里没有限流/安全关键词：按安全拒答处理。
  // 空输出的 refusal 已在上面按额度处理，不会落到这里。
  if (stopReason === 'refusal') {
    return {
      failureClass: FAILURE_CLASSES.REFUSAL,
      hint: hintForFailure(FAILURE_CLASSES.REFUSAL, provider),
    }
  }

  // 已判定失败但无任何可识别特征：给 unknown，主控仍需看日志，不能当成成功。
  return {
    failureClass: FAILURE_CLASSES.UNKNOWN,
    hint: hintForFailure(FAILURE_CLASSES.UNKNOWN, provider),
  }
}
