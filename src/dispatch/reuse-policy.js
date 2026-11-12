// @ts-check
/**
 * C2：同任务「复用上一轮上下文」判据（纯函数，不做 I/O，不自动接线）。
 *
 * 语义边界（必须诚实）：
 * - 这里的「复用」= 把上一轮终态用 `formatContinuation` 重放进新派单（`continuesFrom`），
 *   **不是**真续聊/真会话复用：外部 CLI 每次都是全新进程（见 `src/context-replay.js:3-8`）。
 * - 本模块只给**判断**（复用 / 新建 + 原因码）；是否真的传 `continuesFrom` 仍由调用方决定，
 *   当前 dispatcher 不自动套用（避免对小任务默认重放、多烧 token）。
 * - 判据来源：`docs/plan/verify/2026-11-12-c2-baseline.md` §5；不含真实 Token 统计。
 */

/** 判据版本：改动判据时同步升版本，便于记录/回放到 run 记录（C3 字段）。 */
export const REUSE_POLICY_VERSION = 1

/** 默认最大重放轮次（草案值，未做生产实测；超限建议新建）。 */
export const DEFAULT_MAX_CHAIN_LENGTH = 3

/** 与 `REPLAY_MAX_BYTES` 对齐的上下文预算（硬上限 16KiB）。 */
export const DEFAULT_MAX_CONTINUATION_BYTES = 16 * 1024

export const REUSE_DECISIONS = Object.freeze({
  REUSE: 'reuse',
  NEW: 'new',
})

export const REUSE_REASONS = Object.freeze({
  REUSE_ALLOWED: 'REUSE_ALLOWED',
  NO_PREVIOUS: 'NO_PREVIOUS',
  PREVIOUS_RUNNING: 'PREVIOUS_RUNNING',
  PREVIOUS_NOT_REUSABLE: 'PREVIOUS_NOT_REUSABLE',
  TASK_CHANGED: 'TASK_CHANGED',
  EXECUTION_COMBO_CHANGED: 'EXECUTION_COMBO_CHANGED',
  PROJECT_CHANGED: 'PROJECT_CHANGED',
  ISOLATION_CHANGED: 'ISOLATION_CHANGED',
  CHAIN_TOO_LONG: 'CHAIN_TOO_LONG',
  CONTEXT_BUDGET_EXCEEDED: 'CONTEXT_BUDGET_EXCEEDED',
})

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 执行组合签名：roleId + CLI(kind) + model + reasoning + channelId。
 * 任一不同都视为「换了执行组合」→ 不复用（避免用旧输出误导新 CLI）。
 *
 * @param {any} value role 对象或 { roleId, channel } 形状
 */
function comboSignature(value) {
  if (!value || typeof value !== 'object') return ''
  const channel = value.channel && typeof value.channel === 'object' ? value.channel : {}
  return [
    text(value.roleId),
    text(channel.kind),
    text(channel.model),
    text(channel.reasoning),
    text(channel.channelId),
  ].join('\u0000')
}

/**
 * 给出「是否复用上一轮上下文」的建议。
 *
 * @param {{
 *   previous?: { childId?: string, status?: string, stopReason?: string, resultStatus?: string, taskId?: string } | null,
 *   taskId?: string | null,
 *   role?: { roleId?: string, channel?: any } | null,
 *   nextRole?: { roleId?: string, channel?: any } | null,
 *   projectRoot?: string | null,
 *   nextProjectRoot?: string | null,
 *   isolation?: string | null,
 *   nextIsolation?: string | null,
 *   chainLength?: number,
 *   continuationBytes?: number,
 *   maxChainLength?: number,
 *   maxContinuationBytes?: number,
 * }} [input]
 */
export function recommendContinuation(input = {}) {
  const maxChainLength =
    Number.isInteger(input.maxChainLength) && /** @type {number} */ (input.maxChainLength) > 0
      ? /** @type {number} */ (input.maxChainLength)
      : DEFAULT_MAX_CHAIN_LENGTH
  const maxContinuationBytes =
    Number.isInteger(input.maxContinuationBytes) && /** @type {number} */ (input.maxContinuationBytes) > 0
      ? /** @type {number} */ (input.maxContinuationBytes)
      : DEFAULT_MAX_CONTINUATION_BYTES
  /** @param {string} reason @param {string} detail */
  const result = (reason, detail) => ({
    decision: reason === REUSE_REASONS.REUSE_ALLOWED ? REUSE_DECISIONS.REUSE : REUSE_DECISIONS.NEW,
    reuse: reason === REUSE_REASONS.REUSE_ALLOWED,
    reason,
    detail,
    policyVersion: REUSE_POLICY_VERSION,
    limits: { maxChainLength, maxContinuationBytes },
  })

  const previous = input.previous
  if (!previous || typeof previous !== 'object' || !text(previous.childId)) {
    return result(REUSE_REASONS.NO_PREVIOUS, '没有可复用的上一轮 run（childId 缺失）')
  }
  const status = text(previous.status) || 'unknown'
  if (status === 'running') {
    return result(REUSE_REASONS.PREVIOUS_RUNNING, `上一轮仍在运行：${text(previous.childId)}`)
  }
  const stopReason = text(previous.stopReason)
  const resultStatus = text(previous.resultStatus)
  const notReusable =
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted' ||
    status === 'unknown' ||
    stopReason === 'cancelled' ||
    stopReason === 'interrupted' ||
    stopReason === 'plugin-disposed' ||
    resultStatus === 'failed' ||
    resultStatus === 'blocked'
  if (notReusable) {
    return result(
      REUSE_REASONS.PREVIOUS_NOT_REUSABLE,
      `上一轮不可作为上下文：status=${status} stopReason=${stopReason || '-'} resultStatus=${resultStatus || '-'}`,
    )
  }

  // 同一任务谱系：两边都给了 taskId 且不同 → 新建。
  const taskId = text(input.taskId)
  const previousTaskId = text(previous.taskId)
  if (taskId && previousTaskId && taskId !== previousTaskId) {
    return result(REUSE_REASONS.TASK_CHANGED, `taskId 变化：${previousTaskId} → ${taskId}`)
  }

  // 执行组合一致性：只比较两边都声明了的字段（未知不阻断，但记录在 detail）。
  const previousRoleSig = comboSignature(input.role ?? previous)
  const nextRoleSig = comboSignature(input.nextRole)
  if (previousRoleSig && nextRoleSig && previousRoleSig !== nextRoleSig) {
    return result(
      REUSE_REASONS.EXECUTION_COMBO_CHANGED,
      'roleId/CLI/模型/思考强度/执行组合发生变化，禁止跨组合重放',
    )
  }

  const projectRoot = text(input.projectRoot)
  const nextProjectRoot = text(input.nextProjectRoot)
  if (projectRoot && nextProjectRoot && projectRoot !== nextProjectRoot) {
    return result(REUSE_REASONS.PROJECT_CHANGED, `项目根变化：${projectRoot} → ${nextProjectRoot}`)
  }

  const isolation = text(input.isolation)
  const nextIsolation = text(input.nextIsolation)
  if (isolation && nextIsolation && isolation !== nextIsolation) {
    return result(REUSE_REASONS.ISOLATION_CHANGED, `隔离方式变化：${isolation} → ${nextIsolation}`)
  }

  const chainLength = Number.isInteger(input.chainLength) ? /** @type {number} */ (input.chainLength) : 0
  if (chainLength >= maxChainLength) {
    return result(
      REUSE_REASONS.CHAIN_TOO_LONG,
      `已重放 ${chainLength} 轮，达到上限 ${maxChainLength}（草案值，未实测）`,
    )
  }

  const continuationBytes = Number.isInteger(input.continuationBytes)
    ? /** @type {number} */ (input.continuationBytes)
    : 0
  if (continuationBytes > maxContinuationBytes) {
    return result(
      REUSE_REASONS.CONTEXT_BUDGET_EXCEEDED,
      `重放块 ${continuationBytes}B 超过预算 ${maxContinuationBytes}B`,
    )
  }

  return result(REUSE_REASONS.REUSE_ALLOWED, '同一任务谱系 + 相同执行组合/项目/隔离，允许复用上一轮上下文')
}
