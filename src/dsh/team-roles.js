// @ts-check
/**
 * Agent Teams 角色化：让 teammate 跑在角色配置的模型上。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────────────
 * 宿主 `@deepseek-ai/dsh-experimental-agent-team` 的 `spawn_teammate` 工具参数只有
 * `name / description / prompt / context`（`tool-agent-team/lib/index.js:250-274`），
 * 组装 activation 时只传 `{ prompt, parent }`（`roster.js:237-247`），**不传 agentOptions**。
 * 于是 `resolveChildAgentOptions(parent, undefined, depth)` 回落到
 * `parentAgentOptionsForDelegation(parent)` = 父会话最近一次请求的路由，
 * 并写入 descriptor **永久固化**。
 *
 * 后果（2026-11-12 实测）：teammate 全部跑在父会话的模型上，角色配置的
 * Kimi / GLM / hy3 通道完全不生效，且按父会话的按量计费 provider 扣钱。
 *
 * 底层其实完全支持：`dsh-subagent-spawn-in-process/lib/index.js:21-26`
 * `capabilities = { agentOptions: true, agentPreset: true, ... }`
 * 注释原文：`agentOptions` (merged over the parent route)。
 *
 * ── 本模块的解法（不改宿主）──────────────────────────────────────────────
 * 1. **新增**一个 `spawn_teammate_as` 工具（不接管官方 `spawn_teammate`）。
 *    `dsh-tools` 在同一 Agent scope 内同名注册会抛
 *    `tool "${name}" is already registered in this scope`，所以只能新增、不能覆盖。
 * 2. 建完成员后**立刻**调 `agent.model.select(...)` 切到目标路由。
 *    这是宿主唯一认可的方式（等价于写一条 durable 的 `model/selection` 事件），
 *    让首轮请求就用新路由，不浪费一轮继承模型的调用。
 *
 * ── 为什么不是「挂 agent/request 覆写」（这条弯路必须记下来）──────────────
 * 网上部分实现说要在 `agent/request` waterfall 里覆写 provider/model。**在本机
 * 0.2.2-rc.1 上这条路是死的** —— `dsh-agent-loop` 的 `prepareRequest()` 有硬断言：
 *
 * ```js
 * if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model)
 *   throw new Error(`agent "${this.id}": agent/request proposed "..." after step preparation
 *     fixed "..."; use agent.model.select() before step preparation`)
 * ```
 *
 * 宿主自己把答案写在错误信息里了：**用 `agent.model.select()`，在 step preparation 之前**。
 *
 * ── 路由会一直有效吗（会不会只生效一轮）────────────────────────────────
 * 会一直有效。宿主的投影折叠逻辑（`dsh-agent/lib/types/model-selection.js`）：
 *
 * ```js
 * apply: (state, event) => {
 *   if (event.type === 'model/selection') return { ...state, pending: event.data }
 *   if (event.type !== 'request/header') return state
 *   const lastUsed = selectionOfHeader(event.data.header)
 *   const pending = sameModelSelection(state.pending, lastUsed) ? null : state.pending
 *   return { lastUsed, pending }
 * }
 * ```
 *
 * `model/selection` 写入 `pending` → 首个 `request/header` 用它并把它记进 `lastUsed`
 * → `pending` 清空。之后每次请求都从 `lastUsed` 继承，**路由持续有效**。
 * 所以只需要写一次，不需要请求期钩子。
 *
 * ── 名字为什么只能是拼音 ─────────────────────────────────────────────────
 * `roster.js:10` 硬编码 `MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u`，无配置项，
 * 且 `name` 同时用作 model-facing target。中文进不来。
 * 本模块的做法：**`role` 参数收中文，内部映射成拼音 member name**。
 * 面板仍显示拼音（宿主限制），但调用侧语义是通的。
 *
 * ── 宿主 API 出处 ────────────────────────────────────────────────────────
 * - `ctx.agentTeams.spawnTeammate(agent, req)`：`dsh-experimental-agent-team/lib/types/roster.js`
 * - `ctx.agents.get(sessionId)` / `agentRegistry`：`dsh-agent/lib/index.js`（service 名 `agents`）
 * - `session.append('model/selection', {provider, model, reasoningEffort})`：
 *   `dsh-agent/lib/types/model-selection.js` 的 `AgentModel.select()`
 * - 事件类型白名单：`dsh-session/lib/types/known-event-types.js` 含 `model/selection`
 */

/** 角色中文名 → member name（拼音）。宿主正则只允许 [a-z0-9-]。 */
export const ROLE_MEMBER_NAMES = Object.freeze({
  唐僧: 'tangseng',
  悟空: 'wukong',
  八戒: 'bajie',
  沙僧: 'shaseng',
  小白: 'xiaobai',
})

/** member name 反查中文角色名。 */
export const MEMBER_ROLE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(ROLE_MEMBER_NAMES).map(([zh, en]) => [en, zh])),
)

/**
 * 把角色名归一成合法的 member name。
 *
 * 接受三种输入：中文角色名（`沙僧`）、拼音（`shaseng`）、其它合法 kebab 名。
 * 中文按 `ROLE_MEMBER_NAMES` 映射；已是合法 kebab 的原样返回；其余降级为
 * 去掉非法字符后的形态。**不抛异常**：名字不合法时交给宿主校验去拒绝，
 * 本函数只负责「尽力给出一个可用的名字」，避免在参数归一阶段就失败。
 *
 * @param {unknown} role 角色名 / member name
 * @returns {string} 合法的 lower-kebab-case 名字（可能为空串）
 */
export function memberNameForRole(role) {
  const raw = typeof role === 'string' ? role.trim() : ''
  if (!raw) return ''
  if (ROLE_MEMBER_NAMES[raw]) return ROLE_MEMBER_NAMES[raw]
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(raw)) return raw
  // 兜底：拆出可用的 ascii 片段；中文已在上一步映射过，走到这里说明是未登记的名字。
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return ascii
}

/** 校验 member name 是否符合宿主的 `MEMBER_NAME`。 */
export function isMemberName(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 64 && value !== 'lead'
}

/**
 * 从角色 + 通道实例解析出 teammate 要用的模型路由。
 *
 * 与派单路径共用 `buildChildAgentOptions` 的语义：只有 `in-process` 通道才下发
 * provider/model（外部 CLI 的模型由 provider 行的 `--model` 承载，且它们的
 * provider 声明 `capabilities.agentOptions = false`，传了会撞能力校验）。
 *
 * 与派单路径的区别：teammate 一定是进程内的子 Agent，跑的是宿主 LLM，
 * 所以这里只认 `llmProvider` / `llmModel`，不看外部 CLI 的 `--model`。
 *
 * @param {any} role 角色（含 channel 或已解析的 instance）
 * @param {any} [instance] 命中的通道实例
 * @returns {{ selection?: { provider: string, model: string, reasoningEffort?: string }, reason?: string }}
 *   `selection` 为空时 `reason` 说明为什么拿不到路由（用于工具回执，不静默）
 */
export function resolveSelection(role, instance) {
  const channel = instance && typeof instance === 'object' ? instance : role?.channel
  if (!channel || typeof channel !== 'object') {
    return { reason: '角色没有绑定通道，无法确定模型' }
  }
  const kind = typeof channel.kind === 'string' ? channel.kind : ''
  if (kind !== 'in-process') {
    return {
      reason: `通道 ${channel.channelId ?? kind} 是 ${kind || '未知类型'}，teammate 只能跑进程内通道（跑的是宿主 LLM，不能挂外部 CLI）`,
    }
  }
  const provider = typeof channel.llmProvider === 'string' ? channel.llmProvider.trim() : ''
  const model = typeof channel.llmModel === 'string' ? channel.llmModel.trim() : ''
  if (!provider || !model) {
    return {
      reason: `通道 ${channel.channelId ?? '(未命名)'} 没有同时声明 llmProvider 与 llmModel，无法钉死路由`,
    }
  }
  /** @type {{ provider: string, model: string, reasoningEffort?: string }} */
  const selection = { provider, model }
  const reasoning = typeof channel.reasoning === 'string' ? channel.reasoning.trim() : ''
  if (reasoning) selection.reasoningEffort = reasoning
  return { selection }
}

/**
 * 给已存在的 teammate session 写入一条 `model/selection` 事件。
 *
 * 为什么写事件而不是改 agent.options：`agent.options` 是创建时快照，改它不会影响
 * 已经记录的请求路由；而 `model/selection` 是宿主自己的 durable 选择通道，
 * 投影折叠后会进入 `pending`，下一个 `request/header` 就用它。
 *
 * 写入时机很关键：必须在 teammate **首轮请求之前**。社区实现
 * （Chruix/dsh-team-model）的说明是「模型会在队友的首轮请求之前写入子会话，
 * 因此第一次回复就使用新路由，不会先用继承的模型跑一轮」。
 *
 * @param {any} session 子会话（需有 `append`）
 * @param {{ provider: string, model: string, reasoningEffort?: string }} selection
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function writeModelSelection(session, selection) {
  if (!session || typeof session.append !== 'function') {
    return { ok: false, reason: '拿不到子会话的 append，无法写入 model/selection' }
  }
  if (!selection || !selection.provider || !selection.model) {
    return { ok: false, reason: 'selection 缺少 provider 或 model' }
  }
  /** @type {{ provider: string, model: string, reasoningEffort?: string }} */
  const data = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort) data.reasoningEffort = selection.reasoningEffort
  try {
    session.append('model/selection', data)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `写入 model/selection 失败：${error?.message ?? String(error)}` }
  }
}

/**
 * 用宿主**唯一认可**的方式切换一个 agent 的模型：`agent.model.select(selection)`。
 *
 * ## 为什么不能挂 `agent/request` 覆写路由（重要，别走回头路）
 *
 * `dsh-agent-loop/lib/index.js` 的 `prepareRequest()` 是这么校验的：
 *
 * ```js
 * const proposedConfig = await this.dispatch.waterfall('agent/request', { turn, step, signal },
 *   () => Promise.resolve(seedConfig))
 * if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model)
 *   throw new Error(`agent "${this.id}": agent/request proposed "..." after step preparation
 *     fixed "..."; use agent.model.select() before step preparation`)
 * ```
 *
 * **`agent/request` 里改 provider/model 会直接抛错**，宿主明说要用
 * `agent.model.select()`。所以「挂 request waterfall 覆写路由」这条路是死的
 * （社区文档里写的 `agent/request` 覆写，在本机 0.2.2-rc.1 上会撞这条断言）。
 *
 * ## `agent.model.select()` 到底是什么
 *
 * `dsh-agent-loop` 构造 agent 时：`this.model = new AgentModel(projections.modelSelection, session, options)`。
 * `AgentModel.select(selection)` 的实现是 `session.append('model/selection', ...)`
 * —— 就是写一条 durable 事件，和 `/model` 命令走同一条链路。
 *
 * 因此写入后：
 * - 下一次 `prepareRequest` 从投影读 `pending`，构造 `seedConfig` 时就用新路由；
 * - `model/selection` 被 `request/header` 消费后 `pending` 清空，
 *   但 `lastUsed` 会更新成新路由，后续请求从 `lastUsed` 继承 —— **路由因此持续有效**。
 *
 * 所以正确的做法是**只写一次事件**，不需要任何请求期钩子。
 *
 * @param {any} agent 子 agent（需有 `model.select`）
 * @param {{ provider: string, model: string, reasoningEffort?: string }} selection
 * @returns {{ ok: true, via: string } | { ok: false, reason: string }}
 */
export function selectAgentModel(agent, selection) {
  if (!selection || !selection.provider || !selection.model) {
    return { ok: false, reason: 'selection 缺少 provider 或 model' }
  }
  const model = agent && typeof agent === 'object' ? agent.model : undefined
  if (model && typeof model.select === 'function') {
    /** @type {{ provider: string, model: string, reasoningEffort?: string }} */
    const payload = { provider: selection.provider, model: selection.model }
    if (selection.reasoningEffort) payload.reasoningEffort = selection.reasoningEffort
    try {
      model.select(payload)
      return { ok: true, via: 'agent.model.select' }
    } catch (error) {
      return { ok: false, reason: `agent.model.select 失败：${error?.message ?? String(error)}` }
    }
  }
  // 后备：直接写 session 事件（等价链路，agent 尚未装配 model 时用）。
  const session = agent && typeof agent === 'object' ? agent.session : undefined
  const written = writeModelSelection(session, selection)
  if (written.ok) return { ok: true, via: 'session.append' }
  return { ok: false, reason: `拿不到 agent.model.select，且 ${written.reason}` }
}
