// @ts-check
/**
 * 中途插话（steer）与续聊（resume）。
 *
 * ── 核心事实：宿主已内建，本插件只是没有接线 ─────────────────────────────
 *
 * `@deepseek-ai/dsh-subagent` 的 `sendMessage(sender, targetId, content, options)`
 * 内部走 `deliverToChild(..., { delivery: 'steer' })`，再进 `deliverFollowup`：
 *
 * ```js
 * const activation = this.resident.get(childId)
 * if (activation === undefined)
 *   return this.coldResume(parent, childId, content, options)   // 不在线 → 冷恢复
 * const messageId = this.submitAdmitted(activation, content, options, parent)
 * ```
 *
 * 也就是：
 * - 子 agent **还在跑** → 消息进它的 inbox，下个 step 边界被处理 = **真·中途插话**
 * - 子 agent **已结束/休眠** → `coldResume` 从持久化会话恢复后继续 = **真·续聊**
 *
 * ── 但只有进程内 spawn 支持 ──────────────────────────────────────────────
 *
 * | Provider | prepareContinuable | 能插话/续聊 |
 * | --- | --- | --- |
 * | spawn（进程内） | ✅ | ✅ |
 * | dsh-subagent-acp（CodeBuddy） | ❌ | ❌ |
 * | dsh-subagent-codex | ❌ | ❌ |
 * | dsh-subagent-claude-code | ❌ | ❌ |
 *
 * 外部 CLI 走 `coldResume` 会抛 `NOT_RESUMABLE`。因此本模块分两条路径：
 * - **A. 进程内**：直接 `sendMessage`，真插话/真续聊
 * - **B. 外部 CLI**：`cancel` + 取已有产出 + `context-replay` 重开，
 *   **明确标为 `restart-with-output`，不能伪装成真插话**
 *
 * ── 失败边界（必须如实透传，不能吞）──────────────────────────────────────
 * - 任务已终态 → 明确告知「已结束，无法插话」
 * - 子 agent 已提交结构化结果 → 宿主抛 `INPUT_CLOSED`，转成可读说明
 * - 外部 CLI 且已离线 → 宿主抛 `NOT_RESUMABLE`，转成「该通道不支持续聊」
 * - 宿主没有 sendMessage → 如实报 `STEER_UNAVAILABLE`，不静默降级
 */

/** 进程内能真 steer 的 provider 名。 */
const STEER_CAPABLE_PROVIDER = 'spawn'

/**
 * 从 run 记录里解析出 provider（通道类型）。
 *
 * 为什么需要多源回退：run 记录有 `provider` 顶层字段，但历史上不同版本
 * 还可能写在 `channel.kind`、`channel.provider`、`kind` 里；而适配器内存视图
 * 可能一个都没有。**宁可从更多地方找，也不要因为一个字段缺失就判定「不支持」**
 * （2026-11-12 实测踩到：spawn 任务被判成无法确认）。
 *
 * @param {any} record run 记录
 * @returns {string} provider 名，找不到时为空串
 */
export function resolveRecordProvider(record) {
  if (!record || typeof record !== 'object') return ''
  for (const value of [
    record.provider,
    record.channel?.kind,
    record.channel?.provider,
    record.kind,
    record.providerName,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * 判断一条 run 记录能不能真插话。
 *
 * @param {any} record run 记录（来自 dispatcher.getTask / run-store）
 * @returns {{ capable: boolean, reason: string }}
 */
export function steerCapability(record) {
  if (!record || typeof record !== 'object') {
    return { capable: false, reason: '没有找到该任务的记录，无法判断能否插话' }
  }
  // 状态优先看实时状态（内存视图更准），再退回落盘状态。
  const status =
    (typeof record.liveStatus === 'string' && record.liveStatus) ||
    (typeof record.status === 'string' ? record.status : '')
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    return { capable: false, reason: `任务已是终态（${status}），无法插话；可改用续聊或重新派单` }
  }
  const provider = resolveRecordProvider(record)
  if (!provider) {
    return {
      capable: false,
      reason: '该记录没有标注通道类型，无法确认是否支持插话；为安全起见按不支持处理',
    }
  }
  if (provider !== STEER_CAPABLE_PROVIDER) {
    return {
      capable: false,
      reason: `该任务走的是 ${provider} 通道，宿主没有为它实现 prepareContinuable，无法真插话；可用 restart-with-output 重开`,
    }
  }
  return { capable: true, reason: '' }
}

/**
 * 把宿主/适配器的错误翻译成用户能看懂的说明。
 *
 * 为什么需要：宿主抛的是内部错误码（`INPUT_CLOSED` / `NOT_RESUMABLE` 等），
 * 直接透给用户看不懂；但**也不能掩盖失败**，必须保留原始信息。
 *
 * @param {unknown} error
 * @returns {{ code: string, message: string, hint: string }}
 */
export function translateSteerError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  // 宿主错误形如 `<描述>` 且带 code 字段
  const code =
    error && typeof error === 'object' && typeof /** @type {any} */ (error).code === 'string'
      ? /** @type {any} */ (error).code
      : ''

  if (code === 'INPUT_CLOSED' || /has submitted its structured result/i.test(raw)) {
    return {
      code: 'INPUT_CLOSED',
      message: '该子任务已提交结构化结果，不再接受新输入',
      hint: '如需继续，请重新派单并把它的产出作为上下文带上',
    }
  }
  if (code === 'NOT_RESUMABLE' || /is unavailable|not resumable/i.test(raw)) {
    return {
      code: 'NOT_RESUMABLE',
      message: '该子任务已结束且无法恢复（外部 CLI 通道不支持续聊）',
      hint: '外部 CLI 每次都开新会话；如需继续请走 restart-with-output',
    }
  }
  if (code === 'UNAUTHORIZED' || /UNAUTHORIZED/i.test(raw)) {
    return {
      code: 'UNAUTHORIZED',
      message: '只能给自己派出的任务插话',
      hint: '确认 childId 是不是本会话派出的任务',
    }
  }
  if (code === 'ACTIVATION_CLOSING' || /being disposed/i.test(raw)) {
    return {
      code: 'ACTIVATION_CLOSING',
      message: '该子任务正在关闭，消息未被接受',
      hint: '稍后重试，或改用续聊',
    }
  }
  return {
    code: code || 'STEER_FAILED',
    message: raw || '插话失败（宿主没有给出原因）',
    hint: '可查看该任务的 run 记录确认状态',
  }
}

/**
 * 组装插话消息内容（模型面的文本）。
 *
 * 语义要明确：这是**父 agent 追加的指示**，不是新任务。
 * 不加边界标记的话，子 agent 可能把它当新任务重做一遍。
 *
 * @param {string} instruction 新指示
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function buildSteerContent(instruction) {
  const text = String(instruction ?? '').trim()
  return [{ type: 'text', text }]
}

/**
 * 路径 A：进程内真插话/续聊。
 *
 * @param {object} deps
 * @param {any} deps.subagents 宿主 subagents 服务（需 `sendMessage`）
 * @param {any} deps.parent 调用的父 Agent（必须精确等于派单时的父 agent）
 * @param {string} deps.childId 目标任务 id
 * @param {string} deps.instruction 新指示
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{ ok: true, mode: 'steer', messageId: string } | { ok: false, code: string, message: string, hint: string }>}
 */
export async function steerInProcess(deps) {
  const { subagents, parent, childId, instruction, signal } = deps ?? {}
  if (!subagents || typeof subagents.sendMessage !== 'function') {
    return {
      ok: false,
      code: 'STEER_UNAVAILABLE',
      message: '宿主没有提供 subagents.sendMessage，无法插话',
      hint: '该能力依赖宿主 @deepseek-ai/dsh-subagent 的 sendMessage',
    }
  }
  if (!parent) {
    return {
      ok: false,
      code: 'NO_AGENT',
      message: '拿不到调用方 Agent，无法证明插话权限',
      hint: '插话必须由派单的那个 agent 发起',
    }
  }
  if (!childId) {
    return { ok: false, code: 'CHILD_REQUIRED', message: '必须给 childId', hint: '' }
  }
  const text = String(instruction ?? '').trim()
  if (!text) {
    return { ok: false, code: 'INSTRUCTION_REQUIRED', message: '必须给 instruction', hint: '' }
  }
  try {
    const messageId = await subagents.sendMessage(parent, childId, buildSteerContent(text), {
      signal,
    })
    return { ok: true, mode: 'steer', messageId: String(messageId ?? '') }
  } catch (error) {
    return { ok: false, ...translateSteerError(error) }
  }
}

/**
 * 路径 B 的准备：判断能否用 restart-with-output 兜底。
 *
 * 只做**决策**，不执行重开（重开要复用 dispatcher，由工具层做，
 * 避免本模块耦合派单细节）。
 *
 * @param {any} record run 记录
 * @returns {{ ok: true } | { ok: false, code: string, message: string, hint: string }}
 */
export function canRestartWithOutput(record) {
  if (!record || typeof record !== 'object') {
    return {
      ok: false,
      code: 'RECORD_NOT_FOUND',
      message: '找不到该任务的记录，无法带上已有产出重开',
      hint: '只有本插件派出的任务支持带产出重开',
    }
  }
  // run 记录的顶层字段是 `role`（值为 roleId）；也兼容 roleId / routing.roleId。
  const roleId = resolveRecordRoleId(record)
  if (!roleId) {
    return {
      ok: false,
      code: 'ROLE_UNKNOWN',
      message: '记录里没有角色信息，无法判断重开给谁',
      hint: '请在调用时显式给 role 参数',
    }
  }
  return { ok: true }
}

/**
 * 从 run 记录解析出角色 id。
 *
 * 实测 run 记录的顶层 `role` 存的就是 roleId（如 `role-bajie`），
 * 另有 `routing.roleId` 作为备份来源。
 *
 * @param {any} record
 * @returns {string}
 */
export function resolveRecordRoleId(record) {
  if (!record || typeof record !== 'object') return ''
  for (const value of [record.roleId, record.role, record.routing?.roleId]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * 从 run 记录提取可用于重放的已有产出。
 *
 * 语义边界（与 `context-replay.js` 一致）：这是**不可信数据**，
 * 只是给下一轮看的「上次干到哪了」，不是指令。
 *
 * @param {any} record run 记录
 * @returns {{ text: string, truncated: boolean }}
 */
export function extractPartialOutput(record) {
  if (!record || typeof record !== 'object') return { text: '', truncated: false }
  // 优先级：result（完整产出）> summary（摘录）> output > detail。
  // 为什么不先取 summary：summary 是截断过的摘录，重开时当然要尽量给完整产出。
  for (const key of ['result', 'summary', 'output', 'detail']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return { text: value.trim(), truncated: record.resultTruncated === true || record.summaryTruncated === true }
    }
    if (value && typeof value === 'object') {
      for (const inner of ['text', 'summary', 'content', 'message']) {
        if (typeof value[inner] === 'string' && value[inner].trim()) {
          return { text: value[inner].trim(), truncated: false }
        }
      }
    }
  }
  // 结构化结果兜底：序列化后当参考内容。
  if (record.structuredResult && typeof record.structuredResult === 'object') {
    try {
      const text = JSON.stringify(record.structuredResult)
      if (text && text.trim() && text !== '{}') return { text, truncated: false }
    } catch {
      // 循环引用等，忽略
    }
  }
  return { text: '', truncated: false }
}
