// @ts-check
import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { composePromptWithContinuation } from '../context-replay.js'
import { classifyFailure } from '../dispatch/failure.js'
import { renderTaskBrief, summarizeContextPack, summarizeTaskSpec } from '../taskspec.js'
import { parseStructuredResult, renderOutputContract, resultRecordFields } from '../result-contract.js'
import { buildTaskLabel } from '../naming.js'
/**
 * DSH 接线层 · 适配器（阶段 2）。
 *
 * 把 `src/dispatch/dispatcher.js` 定义的 DispatchAdapter 接口接到宿主 `ctx.subagents`。
 * 边界（勿破坏）：
 * - 不 import `src/dispatch/**`（避免循环依赖），只消费传入的 role 对象；
 * - 不自建任务队列 / 会话 / 进程树，全部交给宿主 provider（03-native-capabilities.md F3）；
 * - 拿不到 provider、参数不被接受、权限被拒，一律失败关闭，绝不降级成「看起来成功」。
 *
 * ── 本文件用到的宿主 API，逐条给出出处 ────────────────────────────────────────
 * 官方来源固定为 `deepseek-ai/deepseek-harness` `ref=master` @ `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
 * （commit 2026-11-04，`Merge release/dsh-0.2.2 (0.2.2-rc.1) into master`），与本机宿主同版。
 *
 * 1. `ctx.subagents.getProvider(name): SubagentProvider | undefined`
 *    出处：`docs/subsystems/subagent.md` §「`ctx.subagents` — `SubagentRuntime`」cordis-surface
 *    （`getProvider(name: string): SubagentProvider | undefined`）；
 *    本项目 `docs/audit/10-provider-install.md` §7.2 亦逐字引用该签名作为「运行时自查」入口。
 *    同文档另有 `registerProvider` 与 `subagent/provider-added|removed` 事件；**没有**「列举全部
 *    provider」的公开方法（10-provider-install.md §7.2 明确），所以 canStart 只能按名查询。
 *
 * 2. `ctx.subagents.startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>`
 *    出处：`docs/subsystems/subagent.md` cordis-surface 两个重载之一（不带 `childId` 的那个，
 *    外部 provider 自行分配 id）。`SubagentActivationSpec` 字段出处同文档 §「Capabilities and
 *    activation requests」：`provider`、`label`、`delivery:'parent'|'caller'`、`signal`、`name?`、
 *    `childId?`，并继承 `SubagentStartRequest` 的 `prompt: ContentBlock[]`、`parent: Agent`、
 *    `cwd?`。`SubagentActivation` 带 `childId`（SessionId）、`name`、`result: Promise`、
 *    `dispose(): Promise<void>`，同文档 §「Local children and activations」。
 *
 * 3. `SubagentActivation.dispose(): Promise<void>` —— 同上，「Stop and release only this
 *    activation; rejects on teardown failure」。本适配器的 cancel 用它 + 我们自己的
 *    AbortController；依据 `docs/audit/02-plugin-spec.md` §2.4（清理集中在单一 disposer，
 *    串行 await；注册经 ctx 会被 Fiber 自动撤销）。
 *
 * 4. `ctx.effect(() => disposer)` —— 官方 `docs/user/develop/framework/index.md`
 *    §「Automatic cleanup」（02-plugin-spec.md §2.4 复核）。插件卸载时串行收尾所有存活 activation。
 *
 * 5. provider 名称 `spawn` / `fork` / `acp` / `codex` / `claude-code`：
 *    `packages/subagent/tool-subagent/README.md` §「Minimal configuration」配置表
 *    「Provider name on `ctx.subagents` (e.g. `spawn`, `fork`, `acp`)」；
 *    `codex` 见 `docs/audit/10-provider-install.md` §4.3 的 `provider: codex` 行，
 *    `claude-code` 见 `.agents/notes/archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md:16`
 *    （默认注册名 `codex` / `claude-code`）。
 *
 * 6. `ContentBlock` 形如 `{ type:'text', text }`：`docs/user/develop/basic/tool.md`
 *    （02-plugin-spec.md §3.1 摘录的 `output.render` 返回 `[{ type:'text', text:value }]`）。
 *
 * 7. `ctx.jobs.start(spec: JobSpec): JobId` —— **本版已接入**（2026-11-11）。
 *    出处：`docs/subsystems/jobs.md` §「`ctx.jobs` — `JobRegistry`」cordis-surface
 *    「abstract start(spec: JobSpec): JobId」；`JobSpec` 需 `kind` / `label` /
 *    `run(job: JobHandle): JobHooks`。本机 `@deepseek-ai/dsh-jobs-local` 实现核对：
 *    - `owner` 是 **SessionId**（`resolveOwner(session)` 用 `agents.get(session)` 找活 Agent），
 *      不是 Agent 对象本身；这里传 `parent.id`（宿主保证 `agent.id === agent.session.id`）。
 *    - `run(handle)` 必须**同步**返回 `{ cancel, done }`；`handle` 提供
 *      `append(text)` / `updateProgress(line)`。
 *    - 加载 `@deepseek-ai/dsh-tool-jobs` 才会挂 controller；没有它时 `start()` 抛
 *      「no job controller serves this agent」，本适配器只告警、不建 Job，派单照常。
 *    取消：`ctx.jobs.kill(jobId, caller)` 会调用 `hooks.cancel`；这里让 hooks.cancel
 *    复用适配器内部的 `cancelActivation`，避免 cancel 工具 → Job kill → 适配器 cancel
 *    的递归。
 *
 * ── 明确未解决 / 待运行验证（不许假装已解决） ───────────────────────────────
 * **本项目不提供只读通道**（2026-11-11 用户决策）：官方 `SubagentActivationSpec` /
 *   `SubagentStartRequest` 没有 permission / readOnly / sandbox 字段，provider 的
 *   `permissionMode`（codex/claude-code）与 `permission`（acp）是**挂载时的行配置**
 *   （10-provider-install.md §8.1），不是每次 start 的参数。既然做不到绝对只读，
 *   就整个不提供——不要再实现 `readOnly` 参数或 `readOnlyEnforced` 标记。
 * TODO(P2-parent): `startActivation` 的 `parent: Agent` 是**必填**，但 dispatcher 的
 *   `start({ role, task, cwd, timeoutMs })` 接口没有 Agent。本版通过
 *   `createDshAdapter(ctx, { getParent })` 注入；未注入时抛错失败关闭，不编造 Agent。
 *   `docs/cookbook/adding-a-tool.md` 提到 `exec.agent`，但「它能直接当 `parent`」**未验证**，
 *   需由工具调用方（src/index.js，并行工作面）在真实会话里确认后注入。
 * TODO(P2-runtime): `getProvider` / `startActivation` 的签名来自官方文档，但本项目
 *   `docs/audit/10-provider-install.md` §7.3 / §12 明确「真实启动后返回非空」**未验证**
 *   （阶段 0 只做了安装与 --dump-config）。需在阶段 2 的真机联调里补一次运行实测。
 */

/**
 * `channel.kind` → `ctx.subagents` 上的 provider 名。
 * 官方 provider 不解析本机 PATH 的 codex/claude（03-native-capabilities.md F2），
 * 这里只是「注册名」，不是可执行文件路径。
 */
export const PROVIDER_BY_KIND = Object.freeze({
  'in-process': 'spawn',
  'acp-cli': 'acp',
  codex: 'codex',
  'claude-code': 'claude-code',
})

/**
 * 生命周期错误码（取消/卸载时宿主 dispose 的兜底）。
 * 新增错误码必须进常量并写进 `docs/configuration.md`，不要在调用点散落字符串。
 */
export const ADAPTER_ERRORS = Object.freeze({
  DISPOSE_TIMEOUT: 'ADAPTER_DISPOSE_TIMEOUT',
  DISPOSE_FAILED: 'ADAPTER_DISPOSE_FAILED',
  // 卸载期间拒绝启动/登记：dispatcher 必须原样透传，不能归入 ADAPTER_FAILED
  DISPOSED: 'ADAPTER_DISPOSED',
})

/** 等待宿主 `activation.dispose()` 的默认上限（毫秒）。 */
export const DEFAULT_DISPOSE_TIMEOUT_MS = 5000

/** `waitForSettled` 的默认等待上限（毫秒，`meetingstone_wait` 默认值）。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 300000

/** `waitForSettled` 允许的最大等待上限（毫秒）；更大的请求按此值截断。 */
export const MAX_WAIT_TIMEOUT_MS = 600000

/**
 * 宿主子 Agent 容量耗尽的错误码。
 *
 * 出处（2026-11-11 核对的宿主实现）：`@deepseek-ai/dsh-subagent` 的
 * `ActivationPool.reserve(capacity)` 在池满时抛
 * `new SubagentError('subagent limit reached (active child limit: 8); wait ...', 'ACTIVATION_LIMIT_REACHED')`。
 * `maxActiveSubagents` 默认 **8**，是进程内共享池（宿主自己的子 Agent 与本插件派单都计入），
 * 且**没有等待/排队机制**。这里只负责识别并原样透传，不在插件侧重复实现容量控制。
 */
export const HOST_ACTIVATION_LIMIT_CODE = 'ACTIVATION_LIMIT_REACHED'

/** 没有 code 时的消息兜底识别（宿主消息以 `subagent limit reached` 开头）。 */
const HOST_ACTIVATION_LIMIT_MESSAGE = /subagent limit reached/i

/** provider 缺失时的统一提示片段（含各通道的安装前置条件，便于排障）。 */
const PROVIDER_HINTS = Object.freeze({
  spawn: '需 dsh-base 的 dsh-subagent-spawn-in-process 行',
  fork: '需 dsh-base 的 dsh-subagent-fork-in-process 行',
  acp: '需装 @deepseek-ai/dsh-subagent-acp 并在 cordis.patch.yml 手写 subagent-acp 行（10-provider-install.md §5）',
  codex: '需装 @deepseek-ai/dsh-subagent-codex（是 bundle，装完自动成层，10-provider-install.md §4）',
  'claude-code': '需装 @deepseek-ai/dsh-subagent-claude-code',
})

/**
 * 解析一个角色应该用的 provider 名。
 * 优先用 `role.channel.provider`（role shape 见 src/roles/registry.js 的 RoleChannel，
 * config.js 的 ChannelSchema 也把它定义为「通道需要的 provider 名」）；否则按 kind 映射。
 *
 * @param {object} role
 * @returns {string | null} 未知 kind 返回 null（调用方必须失败关闭）
 */
export function providerNameFor(role) {
  const channel = role && typeof role === 'object' ? role.channel : null
  if (!channel || typeof channel !== 'object') return null
  if (typeof channel.provider === 'string' && channel.provider.trim()) {
    return channel.provider.trim()
  }
  return /** @type {Record<string, string>} */ (PROVIDER_BY_KIND)[channel.kind] ?? null
}

/**
 * 宿主原生可查的任务引用。
 *
 * 全部字段可 JSON 序列化（工具返回值必须是 lossless JSON，见
 * `docs/cookbook/adding-a-tool.md` §「Rules of the execute() contract」），因此
 * **不**把 `SubagentActivation` / `AbortController` 放进 taskRef；它们存在适配器闭包
 * 的 `handles` 表里，按 `childId` 索引，供 cancel / 卸载清理使用。
 *
 * @typedef {object} MeetingstoneTaskRef
 * @property {'subagent-activation'} kind 引用类型；将来接 Job 时改为 'job'
 * @property {string} provider  `ctx.subagents` 上的注册名
 * @property {string} childId   `SubagentActivation.childId`（宿主 SessionId，可用
 *   `SubagentRuntime.listDescendants()` / `ctx.sessionQuery` 查询，出处 subagent.md）
 * @property {string} name      `SubagentActivation.name`（模型可见名）
 * @property {number} startedAt 本适配器记录的启动时间（Date.now()）
 * @property {string} [operationId] 隔离工作树的 operationId（仅隔离任务有）
 * @property {string} [jobId] 宿主原生 Job id（`ctx.jobs` 可用且创建成功时）
 */

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 带 code 的生命周期错误（dispose 超时/失败）。
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 */
function lifecycleError(code, message, cause) {
  const err = new Error(`${code}: ${message}`)
  // @ts-expect-error 自定义字段，run-store 会原样落盘 code/message
  err.code = code
  if (cause !== undefined) {
    // @ts-expect-error 同上
    err.cause = cause
  }
  return err
}

/**
 * 是否是宿主容量耗尽错误。宿主把码放在 `err.code`，消息里没有码前缀；
 * 极少数包装层会丢掉 code，所以再按消息特征兜底识别一次。
 * @param {unknown} err
 */
function isActivationLimitError(err) {
  if (!err || typeof err !== 'object') return false
  if (/** @type {any} */ (err).code === HOST_ACTIVATION_LIMIT_CODE) return true
  return HOST_ACTIVATION_LIMIT_MESSAGE.test(errorMessage(err))
}

/**
 * 把宿主容量错误包装成可透传的带码错误：
 * dispatcher 按消息前缀/`err.code` 原样透出 `ACTIVATION_LIMIT_REACHED`，不归入 ADAPTER_FAILED。
 * 消息里明确告诉调用方：容量是宿主共享池（默认 8），本项目不排队，只能等现有任务结束。
 * @param {unknown} err
 */
function activationLimitError(err) {
  return lifecycleError(
    HOST_ACTIVATION_LIMIT_CODE,
    '宿主子 Agent 并发已满（默认 8，宿主共享池），请等现有任务结束；本项目不排队。' +
      `原始错误：${errorMessage(err)}`,
    err,
  )
}

/**
 * 等宿主 dispose 完成，但不无限等：超时按 `ADAPTER_DISPOSE_TIMEOUT` 兜底。
 * 返回 `null` 表示成功（或没有 dispose 可调）；否则返回 `{ code, message }`，由调用方记录。
 *
 * 为什么不能直接 `await dispose()`：宿主 provider 卡死时，cancel 会永久挂住，
 * 并发槽位永远不释放，整个项目被锁死。
 *
 * @param {any} activation
 * @param {number} timeoutMs
 * @returns {Promise<{ code: string, message: string } | null>}
 */
async function disposeActivation(activation, timeoutMs) {
  if (!activation || typeof activation.dispose !== 'function') return null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  try {
    await Promise.race([
      Promise.resolve().then(() => activation.dispose()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              lifecycleError(
                ADAPTER_ERRORS.DISPOSE_TIMEOUT,
                `activation.dispose 超过 ${timeoutMs}ms 未完成`,
              ),
            ),
          timeoutMs,
        )
      }),
    ])
    return null
  } catch (err) {
    const code =
      /** @type {any} */ (err)?.code === ADAPTER_ERRORS.DISPOSE_TIMEOUT
        ? ADAPTER_ERRORS.DISPOSE_TIMEOUT
        : ADAPTER_ERRORS.DISPOSE_FAILED
    return { code, message: errorMessage(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 安全调用释放回调。释放回调失败不应影响任务收尾；重复调用由 dispatcher 侧幂等。
 * @param {{ onFinish?: Function } | null | undefined} holder
 */
function callOnFinish(holder) {
  if (!holder || typeof holder.onFinish !== 'function') return
  try {
    holder.onFinish()
  } catch {
    /* 释放回调失败不应影响任务收尾 */
  }
}

/**
 * 落盘用的基础信息（不含终态）。正常启动与「卸载后迟到 activation」共用同一形状，
 * 保证两条路径写出的记录字段一致。
 *
 * @param {object} args
 * @param {any} args.input
 * @param {any} args.role
 * @param {string} args.provider
 * @param {string} args.childId
 * @param {number} args.startedAt
 */
function buildRunBase({ input, role, provider, childId, startedAt }) {
  // P0-B：TaskSpec / ContextPack 摘要（截断后落盘，供 list_runs / get_task 展示标题）
  const taskSpec = summarizeTaskSpec(input?.taskSpec)
  const contextPack = summarizeContextPack(input?.contextPack)
  return {
    childId,
    projectRoot: typeof input?.context?.projectRoot === 'string' ? input.context.projectRoot : null,
    role: role?.roleId ?? null,
    channel: role?.channel?.kind ?? null,
    provider,
    model: role?.channel?.model ?? null,
    status: 'running',
    createdAt: startedAt,
    startedAt,
    // 原生 Job id：创建 Job 后由 start() 回填（Job 创建失败/服务缺失时为 null）
    jobId: typeof input?.jobId === 'string' && input.jobId ? input.jobId : null,
    // 上下文重放实际注入的字节数：只有带了 continuation 才写（"有就用，无则不写"）
    ...(input?.continuation && Number.isInteger(input.continuation.bytes)
      ? { continuationBytes: input.continuation.bytes }
      : {}),
    // 并行隔离元数据：记录与 childId 的映射，便于审计"这个 childId 用了哪棵树"
    operationId:
      typeof input?.operationId === 'string' && input.operationId
        ? input.operationId
        : typeof input?.worktree?.operationId === 'string'
          ? input.worktree.operationId
          : null,
    worktree:
      input?.worktree && typeof input.worktree === 'object' ? input.worktree : null,
    isolation: input?.isolation === 'none' || input?.isolation === 'worktree' ? input.isolation : null,
    // P1-B：角色路由结果（谁选的、为什么）随记录落盘，供 get_task/list_runs 解释与审计。
    // 手动指定角色时 auto:false 且不带 reason（由工具层构造，这里只透传）。
    ...(input?.routing && typeof input.routing === 'object'
      ? { routing: { ...input.routing } }
      : {}),
    ...(taskSpec ? { taskSpec } : {}),
    ...(contextPack ? { contextPack } : {}),
    ...(taskSpec?.title ? { title: taskSpec.title } : {}),
  }
}

/**
 * 把角色身份、可选的 TaskSpec 简报、可选的"上次结果重放块"、任务和输出契约拼成提示词。
 *
 * 为什么要拼：子 Agent 默认不知道"自己是谁"。CLIWorker 时代靠 persona 的 prompt 注入，
 * 我们替代它时必须保留这个语义，否则「沙僧」和「小白」派出去只是同一个裸模型。
 *
 * 顺序（P0-B/P0-C）：人设 → TaskSpec+ContextPack → 重放块 → 任务正文 → 输出契约。
 * 简报与重放块都在人设之后、任务之前；旧输出是不可信数据，必须用显式边界隔开。
 *
 * @param {any} role
 * @param {string} task
 * @param {{ text: string } | null} [continuation]
 * @param {any} [taskSpec] 已校验的结构化简报（可空）
 * @param {any} [contextPack] 已校验的最小上下文（可空）
 * @returns {string}
 */
function composePrompt(role, task, continuation = null, taskSpec = null, contextPack = null) {
  const name = typeof role?.name === 'string' ? role.name : ''
  const persona =
    typeof role?.prompt === 'string' && role.prompt.trim()
      ? role.prompt.trim()
      : typeof role?.description === 'string' && role.description.trim()
        ? role.description.trim()
        : ''
  return composePromptWithContinuation({
    personaHead: name ? `你是「${name}」。` : '',
    persona,
    taskBrief: renderTaskBrief(taskSpec, contextPack),
    continuation: continuation && typeof continuation.text === 'string' ? continuation : null,
    task: String(task ?? ''),
    outputContract: renderOutputContract(),
  })
}

/**
 * 把宿主 `SubagentResult.output`（ContentBlock[]）压成人类可读文本。
 * @param {any} result
 * @returns {string}
 */
function resultText(result) {
  const output = result?.output
  if (!Array.isArray(output)) return ''
  return output
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * 安全读取宿主服务。
 * Cordis 里访问**未 inject** 的属性会直接抛（`cannot get property "x" without inject`，
 * optional chaining 也挡不住），所以必须 try/catch：拿不到返回 null，
 * 由调用方按「未知/不可用」处理，而不是让整个工具调用崩掉。
 * @param {any} ctx
 * @param {string} name
 */
function safeService(ctx, name) {
  try {
    return ctx ? ctx[name] : null
  } catch {
    return null
  }
}

/**
 * 读取**可选**宿主服务（未写进 `inject` 的依赖）。
 *
 * Cordis 的官方可选依赖方式是 `ctx.get(name)`（见 docs/audit/02-plugin-spec.md
 * §「可选依赖不写 inject，改用 ctx.get」）；没有 `ctx.get` 的假 ctx
 * 退回属性访问，并同样容错。拿不到返回 null —— 调用方不得因此失败。
 *
 * @param {any} ctx
 * @param {string} name
 */
function optionalService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name) ?? null
    return ctx ? ctx[name] ?? null : null
  } catch {
    return null
  }
}

/**
 * Job 终态 detail 的展示上限（字符数，不是字节）。
 * detail 是 Background Tasks 面板第二行，不是完整结果；完整输出仍写在
 * `.meetingstone/runs/<childId>.json` 里。
 */
const JOB_DETAIL_MAX = 80

/**
 * Job 的 owner 是宿主 SessionId，不是 Agent 对象。
 * 宿主保证 `agent.id === agent.session.id`；两个来源都试，拿不到就返回 null
 * （宁可不建 Job，也不传一个会让 `agents.get()` 查不到的假 id）。
 *
 * @param {any} parent
 * @returns {string | null}
 */
function jobOwnerId(parent) {
  const id = parent?.id ?? parent?.session?.id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

/**
 * Job 的 detail / progress 是给面板看的一行摘要，不是完整结果。
 * 默认截到 {@link JOB_DETAIL_MAX} 字；完整内容仍在 run 记录与 Job output ring 里。
 * @param {unknown} value
 * @param {number} [max]
 */
function truncateDetail(value, max = JOB_DETAIL_MAX) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 适配器终态 → Job done 状态。
 *
 * **宿主原生 Job 的状态闭集是 completed / failed / killed**（本机 `isTerminal` 与面板
 * statusLabel 只认这三个），`cancelled` 会让宿主得到 `unhandled job status: "cancelled"`、
 * terminal=false。插件自己的 run 记录仍写 `cancelled` / `interrupted`，两者不能混用：
 * - 完成：completed（stopReason 非 completed 时如实写进 detail，例如 refusal）
 * - 失败：failed（detail 用诊断/错误码）
 * - 取消/插件卸载：killed（detail 仍如实写 cancelled / stop unconfirmed / plugin-disposed）
 *
 * @param {any} settled
 * @returns {{ status: 'completed' | 'failed' | 'killed', detail?: string }}
 */
function jobOutcomeFor(settled) {
  const status = String(settled?.status ?? '')
  if (status === 'failed') {
    const detail =
      truncateDetail(settled?.diagnostic) ||
      truncateDetail(settled?.error?.code) ||
      'failed'
    return { status: 'failed', detail }
  }
  if (status === 'cancelled' || status === 'interrupted') {
    const base = truncateDetail(settled?.stopReason) || 'cancelled'
    // dispose 未确认时进程可能仍在跑：不要用干净的 killed 掩盖这一点。
    const detail =
      settled?.stopConfirmed === false ? `${base} (stop unconfirmed)` : base
    return { status: 'killed', detail }
  }
  const stopReason =
    typeof settled?.stopReason === 'string' && settled.stopReason
      ? settled.stopReason
      : 'completed'
  if (stopReason !== 'completed') {
    return { status: 'completed', detail: truncateDetail(stopReason) }
  }
  const output = truncateDetail(settled?.output)
  return { status: 'completed', ...(output ? { detail: output } : {}) }
}

/**
 * 创建 DSH 适配器。
 *
 * @param {object} ctx 宿主 Context（需 `ctx.subagents`；可选 `ctx.effect` / `ctx.logger`）
 * @param {object} [options]
 * @param {() => (object | undefined | null)} [options.getParent]
 *   返回 `SubagentActivationSpec.parent` 所需的 Agent；仅在拿不到 `context.agent` 时兜底。
 * @param {Array<{ channelId: string, kind?: string, provider?: string, model?: string, reasoning?: string }>} [options.channels]
 *   通道实例表（来自插件 Config 的 `channels`）。模型/强度只能由它承载（DD7 方案 B）。
 * @param {object} [options.jobs]
 *   可选的原生 Jobs 服务覆盖（`{ start, kill }`）；未提供时运行时读取 `ctx.jobs`。
 *   两条路径都拿不到时只是不建 Job，派单不受影响。
 * @param {() => number} [options.now]
 * @returns {{ canStart: (role: object) => { ok: boolean, reason?: string },
 *            start: (input: object) => Promise<{ taskRef: MeetingstoneTaskRef }>,
 *            cancel: (taskRef: object) => Promise<{ stopConfirmed: boolean, code?: string, message?: string, reason?: string }>,
 *            getTask: (ref: string | object) => Promise<object>,
 *            waitForSettled: (childIds: string[], timeoutMs?: number) => Promise<object>,
 *            waitStats: () => { pendingWaiters: number, registrations: number } }}
 */
export function createDshAdapter(ctx, options = {}) {
  const getParent = options.getParent ?? null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const disposeTimeoutMs =
    Number.isFinite(options.disposeTimeoutMs) && options.disposeTimeoutMs > 0
      ? options.disposeTimeoutMs
      : DEFAULT_DISPOSE_TIMEOUT_MS
  /** 落盘钩子：start 成功后记 running，终态时记 completed/failed/cancelled/interrupted（失败不影响真实结果） */
  const onRunStart = typeof options.onRunStart === 'function' ? options.onRunStart : null
  const onRunFinish = typeof options.onRunFinish === 'function' ? options.onRunFinish : null

  /** @param {any} record */
  function emitRunStart(record) {
    if (!onRunStart) return
    try {
      // 允许返回 promise（落盘串行化）；启动路径不等盘，绝不阻断派单
      void Promise.resolve(onRunStart(record)).catch(() => {})
    } catch {
      /* 落盘是尽力而为，绝不阻断派单 */
    }
  }

  /**
   * 发送终态记录。调用方可以 await（取消/卸载要保证终态落盘后才结束）。
   * @param {any} record
   * @returns {Promise<void>}
   */
  async function emitRunFinish(record) {
    if (!onRunFinish) return
    try {
      await onRunFinish(record)
    } catch {
      /* 同上：落盘失败不改变真实终态 */
    }
  }

  /** @type {Map<string, any>} */
  const channelsById = new Map()
  for (const instance of options.channels ?? []) {
    if (instance && typeof instance.channelId === 'string' && instance.channelId) {
      channelsById.set(instance.channelId, instance)
    }
  }

  /** @type {Map<string, { activation: any, controller: AbortController, timer: any, onFinish?: Function, cancelling?: boolean, settled?: boolean, cleaned?: boolean, cancelPromise?: Promise<any>, runBase?: any }>} */
  const handles = new Map()
  /**
   * 启动中的占位句柄：`startActivation` 还没返回时没有 childId，无法进 handles。
   * 卸载必须能看见并取消它们，否则「启动中」的 activation 会在卸载后偷偷登记成存活任务。
   * key = `op:<operationId>` 或 `start:<序号>`。
   * @type {Map<string, { controller: AbortController, cancelled: boolean, onFinish?: Function }>}
   */
  const pendingStarts = new Map()
  /** 插件是否已进入卸载收尾。进入后拒绝一切新启动。 */
  let disposed = false
  let startSeq = 0

  /**
   * 已完成任务的结果快照（childId → 结果），只留最近 20 条。
   * 用途：`meetingstone_get_task` 读回"子 Agent 到底输出了什么"。
   *
   * 必须带**完整 runBase**（taskSpec/contextPack/title 等）：`continuesFrom` 命中内存
   * 时直接返回这里，缺了 runBase 就会让内存重放比磁盘重放少掉验收/范围/禁止重复
   * （P0-B 审计 F1）。快照与落盘记录保持同一形状，重放才有一致语义。
   * @type {Map<string, any>}
   */
  const finished = new Map()

  /**
   * 终态等待信号表（childId → 一次性 deferred）。
   *
   * `meetingstone_wait` 的全部语义都在这里：**不轮询**，只在任务结算时 resolve。
   * 同一 childId 只建一个 deferred —— 多个 wait 调用复用它（按 refs 计数），
   * 不重复注册监听；某个 wait 超时只释放自己的引用，最后一个引用离开才删除；
   * 卸载时统一清空。
   * @type {Map<string, { promise: Promise<void>, resolve: () => void, settled: boolean, refs: number }>}
   */
  const settleWaiters = new Map()
  /** 新建 deferred 的累计次数（仅用于测试/诊断证明「不重复监听」）。 */
  let waiterRegistrations = 0

  /** @param {string} childId */
  function waiterFor(childId) {
    let waiter = settleWaiters.get(childId)
    if (waiter) return waiter
    /** @type {() => void} */
    let resolve = () => {}
    const promise = new Promise((/** @type {() => void} */ r) => {
      resolve = r
    })
    waiter = { promise, resolve, settled: false, refs: 0 }
    settleWaiters.set(childId, waiter)
    waiterRegistrations += 1
    return waiter
  }

  /** 登记一个等待者引用（复用同一 deferred，不重复注册）。 @param {string} childId */
  function acquireWaiter(childId) {
    const waiter = waiterFor(childId)
    waiter.refs += 1
    return waiter
  }

  /** 释放一个等待者引用；最后一个引用离开时删除监听。 @param {string} childId */
  function releaseWaiter(childId) {
    const waiter = settleWaiters.get(childId)
    if (!waiter) return
    waiter.refs -= 1
    if (waiter.refs <= 0) settleWaiters.delete(childId)
  }

  /** 通知并移除一个等待者；重复调用无副作用。 @param {string} childId */
  function notifySettled(childId) {
    const waiter = settleWaiters.get(childId)
    if (!waiter) return
    settleWaiters.delete(childId)
    waiter.settled = true
    try {
      waiter.resolve()
    } catch {
      /* resolve 不应失败 */
    }
  }

  /** @param {string} childId @param {any} value */
  function rememberFinished(childId, value) {
    finished.set(childId, value)
    while (finished.size > 20) {
      const oldest = finished.keys().next().value
      if (oldest === undefined) break
      finished.delete(oldest)
    }
    // 终态（完成/失败/取消/卸载）统一从这一处唤醒等待者：
    // 所有终态路径都会调用 rememberFinished，不需要在每个分支重复挂监听。
    notifySettled(childId)
  }

  // ─── 宿主原生 Jobs（可选） ──────────────────────────────────────────────────
  // 边界：没有 `ctx.jobs`（或 `start` 抛错）时只记 warning，**派单照常**；
  // 绝不伪造 jobId，也绝不因为建 Job 失败回滚已启动的 activation。
  /** @type {Map<string, { resolve: (outcome: any) => void }>} */
  const jobDeferreds = new Map()
  /** @type {Map<string, { updateProgress?: (line: string) => void }>} */
  const jobHandles = new Map()

  function warn(line) {
    if (typeof ctx?.logger?.warn === 'function') {
      try {
        ctx.logger.warn(line)
      } catch {
        /* 日志失败不影响任务 */
      }
    }
  }

  /**
   * jobs 服务缺失的 warning 每个适配器实例只发一次：派单是高频路径，
   * 每次派单都刷同一行会淹没日志。缺 Job 不影响任务本身，但必须让调用方知道
   * 「面板里没有这个任务」不是 bug 静默。
   */
  let jobsUnavailableWarned = false
  /** 取原生 jobs 服务；只认有 `start` 的实现，拿不到返回 null。 */
  function jobsService() {
    const injected = options.jobs
    if (injected && typeof injected.start === 'function') return injected
    const jobs = optionalService(ctx, 'jobs')
    return jobs && typeof jobs.start === 'function' ? jobs : null
  }

  /**
   * 更新 Job 的一行进度（失败不影响任务）。
   * @param {string} childId
   * @param {string} line
   */
  function updateJobProgress(childId, line) {
    const handle = jobHandles.get(childId)
    if (!handle || typeof handle.updateProgress !== 'function') return
    try {
      handle.updateProgress(line)
    } catch {
      /* 进度只是展示，不能影响任务 */
    }
  }

  /**
   * 用适配器的真实终态结算 Job：先更新进度，再 resolve `done`，之后清理句柄。
   * 重复调用无副作用（deferred 只取一次）。
   *
   * @param {string} childId
   * @param {any} settled 适配器终态记录
   */
  function settleJob(childId, settled) {
    const deferred = jobDeferreds.get(childId)
    if (!deferred) return
    const outcome = jobOutcomeFor(settled)
    updateJobProgress(
      childId,
      outcome.status === 'completed'
        ? '已完成'
        : outcome.status === 'failed'
          ? '失败'
          : '已取消',
    )
    jobDeferreds.delete(childId)
    jobHandles.delete(childId)
    try {
      deferred.resolve(outcome)
    } catch {
      /* resolve 不应失败 */
    }
  }

  /**
   * 派单启动成功后创建原生 Job。失败只告警，返回 null。
   *
   * `run(handle)` 必须同步返回 hooks；`done` 由 `settleJob()` 在 activation 终态时
   * resolve，`cancel` 复用适配器内部的 `cancelActivation()`（不能回调 `cancel()`，
   * 否则 Job kill → hooks.cancel → Job kill 会递归）。
   *
   * @param {object} args
   * @param {string} args.childId
   * @param {any} args.role
   * @param {unknown} args.task
   * @param {any} [args.taskSpec] 结构化简报（有 title 时优先作为短目标）
   * @param {any} args.parent
   * @param {() => Promise<any>} args.cancel
   * @returns {string | null}
   */
  function createDispatchJob({ childId, role, task, taskSpec, parent, cancel }) {
    const jobs = jobsService()
    if (!jobs) {
      if (!jobsUnavailableWarned) {
        jobsUnavailableWarned = true
        warn('[meetingstone] jobs unavailable, task continues without native Job')
      }
      return null
    }
    const owner = jobOwnerId(parent)
    if (!owner) {
      warn('[meetingstone] jobs: 无法从 parent 取得 SessionId，跳过创建原生 Job（派单继续）')
      return null
    }
    /** @type {(outcome: any) => void} */
    let resolveDone = () => {}
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })
    jobDeferreds.set(childId, { resolve: resolveDone })
    try {
      const started = jobs.start({
        kind: 'meetingstone-dispatch',
        label: buildTaskLabel(role, task, taskSpec),
        owner,
        run(/** @type {any} */ jobHandle) {
          if (jobHandle && typeof jobHandle === 'object') {
            jobHandles.set(childId, jobHandle)
            try {
              // 进度行只描述状态；工作树绝对路径不进面板（避免重复信息撑满一行）
              jobHandle.updateProgress?.('已启动')
            } catch {
              /* 进度只是展示 */
            }
          }
          return {
            done,
            cancel: () => cancel(),
          }
        },
      })
      // 本机 dsh-jobs-local 的 `start()` 返回 JobId 字符串；
      // 任务说明里的契约写成 `{ id, append, updateProgress }`。两种形状都接受，
      // 保证换实现/不同版宿主时不会因为形状差异静默丢掉 jobId。
      const jobId = typeof started === 'string' ? started : started?.id
      if (typeof jobId !== 'string' || !jobId) {
        throw new Error('jobs.start 没有返回有效 job id')
      }
      return jobId
    } catch (err) {
      jobDeferreds.delete(childId)
      jobHandles.delete(childId)
      warn(
        `[meetingstone] jobs: 创建原生 Job 失败，派单继续（无 Job）：${errorMessage(err)}`,
      )
      return null
    }
  }

  /**
   * 迟到结算的说明文案。
   * @param {{ code?: string } | null} disposeError
   * @param {string} [rejectedMessage]
   */
  function lateSettlementNote(disposeError, rejectedMessage) {
    const cause =
      disposeError?.code === ADAPTER_ERRORS.DISPOSE_TIMEOUT ? 'dispose timeout' : 'dispose failure'
    return rejectedMessage
      ? `late settlement: result rejected after ${cause}: ${rejectedMessage}`
      : `late settlement: result settled after ${cause}`
  }

  /**
   * 回填「迟到落定」的停止证据。
   *
   * 真机场景：取消/卸载时 dispose 超时，记录只能保守写 `stopConfirmed:false`；
   * 之后宿主进程真的退出、`activation.result` 落定时，如果不回填，磁盘会永远停在
   * "未确认停止"的错误状态。这里只在**已有终态且 stopConfirmed:false** 时回填：
   * - `status` 保持 cancelled / interrupted，不把取消改写成 completed
   * - `stopConfirmed` 改为 true（result 落定 = 进程已结束的可验证证据）
   * - 追加 `diagnostic`，异常结算也如实记录原因
   *
   * @param {string} childId
   * @param {any} handle 仍在 handles 里的句柄（提供 runBase，保证记录字段完整）
   * @param {{ rejectedMessage?: string }} [outcome]
   */
  function backfillLateSettlement(childId, handle, outcome = {}) {
    const prior = finished.get(childId)
    if (!prior || prior.stopConfirmed !== false) return
    if (prior.status !== 'cancelled' && prior.status !== 'interrupted') return
    const disposeError =
      prior.error && typeof prior.error === 'object'
        ? /** @type {{ code?: string }} */ (prior.error)
        : null
    const note = lateSettlementNote(disposeError, outcome.rejectedMessage)
    const updated = {
      ...prior,
      stopConfirmed: true,
      diagnostic: prior.diagnostic ? `${prior.diagnostic}; ${note}` : note,
    }
    rememberFinished(childId, updated)
    void emitRunFinish({
      ...handle.runBase,
      ...updated,
      result: typeof updated.output === 'string' ? updated.output : '',
      ...(updated.error ? { error: updated.error } : {}),
      finishedAt: updated.at,
    })
  }

  /**
   * 查询 provider 是否注册。**只信宿主返回值，不猜**。
   * 拿不到查询能力或查不到 provider，一律 ok:false。
   */
  function canStart(role) {
    // 与 start 用同一套路由解析：实例不一致/不存在时提前给出可诊断原因，而不是等到启动才抛
    let provider
    try {
      provider = resolveRoute(role).provider
    } catch (err) {
      return { ok: false, reason: errorMessage(err) }
    }
    const subagents = safeService(ctx, 'subagents')
    if (!provider || !subagents || typeof subagents.getProvider !== 'function') {
      return { ok: false, reason: '无法确认 provider 是否注册' }
    }
    let found
    try {
      found = subagents.getProvider(provider)
    } catch (err) {
      return { ok: false, reason: `无法确认 provider 是否注册：查询失败 ${errorMessage(err)}` }
    }
    if (!found) {
      const hint = PROVIDER_HINTS[provider] ?? '请确认 provider 已安装并挂载'
      return { ok: false, reason: `provider ${provider} 未注册（${hint}）` }
    }
    return { ok: true }
  }

  /** 启动一次委派。任何失败都抛，不吞、不降级。 */
  /**
   * 解析一次派单的实际执行路由。
   *
   * 规则（fail-closed）：
   * - 没有 channelId：沿用角色声明的 provider/kind（老配置兼容）
   * - 有 channelId：**以实例的 provider 为准**；角色声明的 provider/kind 与实例不一致就拒绝
   *   （`CHANNEL_MISMATCH`），实例不存在就拒绝（`CHANNEL_NOT_FOUND`）
   *
   * @param {any} role
   * @returns {{ provider: string | null, instance: any | null }}
   */
  function resolveRoute(role) {
    const channelId = role?.channel?.channelId
    if (!channelId) return { provider: providerNameFor(role), instance: null }
    const instance = channelsById.get(String(channelId))
    if (!instance) {
      throw new Error(`CHANNEL_NOT_FOUND: 角色引用的通道实例 ${channelId} 不存在，拒绝启动`)
    }
    const instanceProvider =
      typeof instance.provider === 'string' && instance.provider.trim()
        ? instance.provider.trim()
        : /** @type {Record<string, string>} */ (PROVIDER_BY_KIND)[instance.kind] ?? null
    if (!instanceProvider) {
      throw new Error(`CHANNEL_MISMATCH: 通道实例 ${channelId} 既没声明 provider 也没有已知 kind，拒绝启动`)
    }
    const declaredProvider = role?.channel?.provider
    if (typeof declaredProvider === 'string' && declaredProvider.trim() && declaredProvider.trim() !== instanceProvider) {
      throw new Error(
        `CHANNEL_MISMATCH: 角色声明的 provider 是 ${declaredProvider}，但通道实例 ${channelId} 实际是 ${instanceProvider}；` +
          '两者必须一致，否则会出现「配置写的是一个通道、实际跑的是另一个」。已拒绝启动',
      )
    }
    const declaredKind = role?.channel?.kind
    if (typeof declaredKind === 'string' && declaredKind && instance.kind && declaredKind !== instance.kind) {
      throw new Error(
        `CHANNEL_MISMATCH: 角色声明的通道类型是 ${declaredKind}，但实例 ${channelId} 是 ${instance.kind}，已拒绝启动`,
      )
    }
    return { provider: instanceProvider, instance }
  }

  async function start(input) {
    if (disposed) {
      throw lifecycleError(ADAPTER_ERRORS.DISPOSED, '插件正在卸载，拒绝启动新任务')
    }
    const { role, task, cwd, timeoutMs } = input ?? {}
    // 执行路由**必须**以引用的通道实例为准，不能只信角色自己的声明。
    // 否则：角色写 channelId=A 实例 + provider=B，配置与实际执行的通道会不一致。
    const route = resolveRoute(role)
    const provider = route.provider
    const subagents = safeService(ctx, 'subagents')

    // 1. 失败关闭：重新查询，不依赖 canStart 是否被上层调用过。
    if (
      !provider ||
      !subagents ||
      typeof subagents.getProvider !== 'function' ||
      typeof subagents.startActivation !== 'function'
    ) {
      throw new Error('PROVIDER_UNAVAILABLE: 无法确认 provider 是否注册')
    }
    if (!subagents.getProvider(provider)) {
      throw new Error(`PROVIDER_UNAVAILABLE: provider ${provider} 未注册`)
    }

    // 2. parent 必须来自**当次执行上下文**（exec.agent），不做全局 holder 回退：
    //    全局回退会在并发/多会话下把上个会话的 agent 当成 parent（P2 Gate 复核指出）。
    const parent = input?.context?.agent ?? (typeof getParent === 'function' ? getParent() : null)
    if (!parent) {
      throw new Error(
        'PARENT_AGENT_UNAVAILABLE: startActivation 需要 parent Agent，但本次执行上下文没有 exec.agent',
      )
    }

    // 2.5 启动前置校验（P2 Gate 复核 P0）：约束不满足就**不启动**，而不是带病启动。
    //
    // (a) 模型/强度：官方 spec 不收 model/reasoning，模型只能由 **provider 行**承载（DD7 方案 B）。
    //     角色的声明必须与所引用通道实例的配置一致；不一致就拒绝，避免"配置成功、执行没采用"。
    const declaredModel = role?.channel?.model
    const declaredReasoning = role?.channel?.reasoning
    if (declaredModel || declaredReasoning) {
      const channelId = role?.channel?.channelId
      if (!channelId) {
        throw new Error(
          'MODEL_UNSUPPORTED: 角色声明了 model/reasoning，但没有指定 channelId。' +
            '宿主的启动 spec 不接收模型，请先在插件配置的 channels 表里配置一个通道实例，' +
            '再让角色通过 channel.channelId 引用它',
        )
      }
      const instance = channelsById.get(String(channelId))
      if (!instance) {
        throw new Error(
          `MODEL_UNSUPPORTED: 角色引用的通道实例 ${channelId} 不存在，无法确认模型是否已配置`,
        )
      }
      if (declaredModel && instance.model !== declaredModel) {
        throw new Error(
          `MODEL_UNSUPPORTED: 角色声明 model=${declaredModel}，但通道实例 ${channelId} 配置的是 ` +
            `${instance.model ?? '(未配置)'}；两者必须一致（模型只能由 provider 行承载）`,
        )
      }
      if (declaredReasoning && instance.reasoning !== declaredReasoning) {
        throw new Error(
          `MODEL_UNSUPPORTED: 角色声明 reasoning=${declaredReasoning}，但通道实例 ${channelId} 配置的是 ` +
            `${instance.reasoning ?? '(未配置)'}；两者必须一致`,
        )
      }
    }

    // (b) 项目边界：cwd 必须在当前会话的项目根之内；拿不到项目根就失败关闭
    if (typeof cwd === 'string' && cwd) {
      const projectRoot = input?.context?.projectRoot ?? readProjectRoot(parent)
      if (!projectRoot) {
        throw new Error(
          'PROJECT_ROOT_UNKNOWN: 无法从当前会话确定项目根，拒绝在未校验的 cwd 下启动',
        )
      }
      // 项目根可能是 junction/symlink、大小写也可能不同：优先用 realpath 判断。
      // realpath 失败（路径不存在等）时退回字符串判断，保持原有失败关闭语义。
      const insideReal = await isInsideReal(cwd, projectRoot)
      if (insideReal === null ? !isInside(cwd, projectRoot) : !insideReal) {
        throw new Error(
          `PATH_OUTSIDE_PROJECT: cwd ${cwd} 不在项目根 ${projectRoot} 之内，已拒绝启动`,
        )
      }
    }

    // 3. 组装官方 SubagentActivationSpec（字段出处见文件头第 2 条）。
    //    delivery:'caller' —— 「caller delivery only returns the result」（subagent.md）；
    //    TODO(P2-runtime): 该取值尚未在真实会话里验证，若宿主要求 parent delivery 需改这里。
    const controller = new AbortController()
    const operationId =
      typeof input?.operationId === 'string' && input.operationId
        ? input.operationId
        : typeof input?.worktree?.operationId === 'string'
          ? input.worktree.operationId
          : null
    // 3. 组装 spec。**运行时形状与官方文档不一致**（2026-11-10 真机核对）：
    //    实现里 `SubagentRuntime.startActivation(spec)` 读的是 `spec.request.*`
    //    （`manager.startLocal/startExternal` 里 `const request = spec.request`），
    //    而文档给的是扁平字段。按文档传扁平对象会得到
    //      `Cannot read properties of undefined (reading 'maxDepth')`
    //    因为 `spec.request` 是 undefined。这里按**实现**的嵌套形状组装。
    const spec = {
      provider,
      // 官方字段：`SubagentActivationSpec.label` 会写进 `subagent/descriptor` 与
      // `subagent/catalog`，Subagents 面板行标题读的就是这个值（证据见
      // docs/gui-0.2.0.md §6）。命名统一为 `角色简称 · 简短目标（≤14 字）`。
      label: buildTaskLabel(role, task, input?.taskSpec),
      delivery: 'caller',
      signal: controller.signal,
      request: {
        parent,
        prompt: [
          {
            type: 'text',
            text: composePrompt(role, task, input?.continuation, input?.taskSpec, input?.contextPack),
          },
        ],
        ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
        // 不传 maxDepth：实现里 `resolveChildDepth(parent, undefined)` 自带默认上限；
        // 传了反而要求 provider 具备 depthLimit 能力。
      },
    }

    // 4. 调宿主创建任务。抛错（含权限被拒 / 参数不接受）直接向上抛，不吞。
    //
    // 在 await **之前**登记占位句柄：这段时间没有 childId，卸载按 handles 扫不到。
    // 卸载会标记这个占位（cancelled）并 abort；启动返回后我们检查标记，
    // 若已卸载就立即 dispose、拒绝登记，绝不让它变成卸载后的存活 activation。
    // 进入这里前的 cwd 校验含 await，卸载可能在期间发生：再查一次，避免占位漏给卸载。
    if (disposed) {
      throw lifecycleError(ADAPTER_ERRORS.DISPOSED, '插件已卸载，拒绝启动')
    }
    const startKey = operationId ? `op:${operationId}` : `start:${(startSeq += 1)}`
    /** @type {{ controller: AbortController, cancelled: boolean, onFinish?: Function }} */
    const placeholder = { controller, cancelled: false, onFinish: input?.onFinish }
    pendingStarts.set(startKey, placeholder)
    let activation
    try {
      activation = await subagents.startActivation(spec)
    } catch (err) {
      pendingStarts.delete(startKey)
      // 卸载时不再立刻释放占位槽位（见卸载 disposer）：启动失败由这里补释放，
      // 因为没有真实 activation 需要保留。
      if (placeholder.cancelled) callOnFinish(placeholder)
      // 宿主容量耗尽：原样透传错误码，并补充"宿主共享池、默认 8、本项目不排队"的说明。
      // dispatcher 按 ACTIVATION_LIMIT_REACHED 透出，不会包成 ADAPTER_FAILED。
      if (isActivationLimitError(err)) throw activationLimitError(err)
      throw err
    }
    pendingStarts.delete(startKey)
    if (placeholder.cancelled || disposed) {
      // 卸载已经发生：这个 activation 不允许登记为存活任务，先 dispose 再拒绝。
      const disposeError = await disposeActivation(activation, disposeTimeoutMs)
      if (!disposeError) {
        // 已确认停止，占位槽位现在才释放（卸载时延迟到这一刻）。
        callOnFinish(placeholder)
        throw lifecycleError(ADAPTER_ERRORS.DISPOSED, '插件已卸载，拒绝登记启动结果')
      }
      const lateChildId =
        activation && activation.childId !== undefined && activation.childId !== null
          ? String(activation.childId)
          : ''
      if (!lateChildId) {
        // 没有 childId 就无法追踪 result、也无法在日后确认停止；如实释放并带上 dispose 错误。
        callOnFinish(placeholder)
        throw lifecycleError(
          ADAPTER_ERRORS.DISPOSED,
          `插件已卸载，迟到 activation 的 dispose 未确认（${disposeError.code}：${disposeError.message}），` +
            '且缺少 childId，无法追踪',
          disposeError,
        )
      }
      // dispose 超时/失败：进程可能仍存活。必须保留句柄与并发槽位，写 interrupted 终态，
      // 等 activation.result 落定后再释放（与 cancel 的 stopConfirmed 门控一致）。
      // 绝不吞掉 dispose 错误——记录、返回值、日志三处都要能看见。
      if (typeof ctx?.logger?.warn === 'function') {
        ctx.logger.warn(
          `[meetingstone] unload: late activation ${lateChildId} dispose ${disposeError.code}: ${disposeError.message}`,
        )
      }
      const startedAt = now()
      const lateRunBase = buildRunBase({ input, role, provider, childId: lateChildId, startedAt })
      /** @type {any} */
      const lateHandle = {
        activation,
        controller,
        timer: null,
        onFinish: placeholder.onFinish,
        runBase: lateRunBase,
        cancelling: true,
      }
      handles.set(lateChildId, lateHandle)
      claimSettlement(lateHandle)
      const settled = {
        status: 'interrupted',
        stopReason: 'plugin-disposed',
        stopConfirmed: false,
        output: '',
        diagnostic:
          `插件卸载：迟到 activation 的 dispose 失败（${disposeError.code}：${disposeError.message}），` +
          '进程可能仍存活，槽位保留至结果落定',
        // 保留 dispose 错误（普通对象，便于迟到结算回填时继续落盘）
        error: { code: disposeError.code, message: disposeError.message },
        at: startedAt,
      }
      rememberFinished(lateChildId, { ...lateRunBase, ...settled })
      // 先挂结果监听再写盘：写盘期间 result 落定也能清掉句柄/槽位。
      watchActivationResult(lateChildId)
      await emitRunFinish({
        ...lateRunBase,
        ...settled,
        result: settled.output,
        error: disposeError,
        finishedAt: settled.at,
      })
      const err = lifecycleError(
        ADAPTER_ERRORS.DISPOSED,
        `插件已卸载，迟到 activation 的 dispose 未确认（${disposeError.code}：${disposeError.message}）`,
        disposeError,
      )
      // 明确告知 dispatcher：停止未确认，槽位必须保留到 activation.result 落定。
      // @ts-expect-error 自定义字段，dispatcher 用它决定是否 release
      err.slotPreserved = true
      // @ts-expect-error 同上
      err.stopConfirmed = false
      throw err
    }
    if (!activation || !activation.childId) {
      throw new Error('ADAPTER_FAILED: startActivation 未返回有效 activation（缺 childId）')
    }

    const childId = String(activation.childId)
    const startedAt = now()

    // 5. 取消信号：我们自己的 AbortController（spec.signal）+ activation.dispose()。
    //    timeoutMs 只用来给这个 controller 装一个定时器，是我们自己的策略，不是宿主 API。
    let timer = null
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new Error('meetingstone: timeout')), timeoutMs)
    }
    /** 落盘用的基础信息（不含终态），cancel 也需要它 */
    const runBase = buildRunBase({ input, role, provider, childId, startedAt })
    // 先登记句柄，再建 Job：hooks.cancel 要能按 childId 找到同一个 activation。
    handles.set(childId, {
      activation,
      controller,
      timer,
      onFinish: input?.onFinish,
      runBase,
      jobId: null,
      ownerId: jobOwnerId(parent),
    })

    // 5.1 原生 Jobs：失败只告警，绝不回滚已启动的 activation。
    const jobId = createDispatchJob({
      childId,
      role,
      task,
      taskSpec: input?.taskSpec,
      parent,
      cancel: () => cancelActivation({ childId }),
    })
    if (jobId) {
      const handle = handles.get(childId)
      if (handle) handle.jobId = jobId
      runBase.jobId = jobId
    }

    /** @type {MeetingstoneTaskRef} */
    const taskRef = {
      kind: 'subagent-activation',
      provider,
      childId,
      name: typeof activation.name === 'string' ? activation.name : childId,
      startedAt,
      // operationId → childId 的即时映射；落盘记录里也有同样一对字段
      ...(operationId ? { operationId } : {}),
      ...(jobId ? { jobId } : {}),
    }

    // 先记 running（结果落盘），再挂终态钩子
    emitRunStart(runBase)
    watchActivationResult(childId)

    return { taskRef }
  }

  /**
   * 订阅宿主 activation.result 的落定。
   * - 正常路径：完成/失败各写一次终态（claimSettlement 保证只写一次）
   * - 取消/卸载路径（cancelling）：终态由那条路径负责，这里只记录「进程已停止」的证据
   *   （`resultSettled`）并释放保留的槽位——结果落定是可验证的停止证据。
   *
   * @param {string} childId
   */
  function watchActivationResult(childId) {
    const handle = handles.get(childId)
    const result = handle?.activation?.result
    if (!result || typeof result.then !== 'function') return
    void result.then(
      (value) => {
        const current = handles.get(childId)
        if (!current) return
        // 无论谁写终态，result 落定都意味着进程已停止；卸载/取消用它确认 stopConfirmed
        current.resultSettled = true
        // 取消/卸载已经开始收尾时，由那条路径写终态，避免"先 cancelled、又被 completed 覆盖"；
        // 但 result 落定本身就是"进程已停止"的可验证证据：
        // - 若终端记录已经保守写成 stopConfirmed:false，回填 true（不伪造，但纠正迟到证据）
        // - 此时才允许释放保留的槽位
        if (current.cancelling) {
          backfillLateSettlement(childId, current)
          cleanup(childId)
          return
        }
        if (!claimSettlement(current)) return
        const settledOutput = resultText(value)
        const settledDiagnostic =
          value?.diagnostic !== undefined
            ? String(value.diagnostic)
            : // 真机教训：CodeBuddy 触发 429 时 ACP 只回 stopReason=refusal + 空输出，
              // 不附任何原因；不补提示就会看起来像"莫名拒绝"（沙僧那次就是这样）。
              value?.stopReason === 'refusal' && !settledOutput
              ? 'ACP refusal without output：可能是额度/频率限制（429）或模型拒绝；请检查 provider 日志或切换模型'
              : undefined
        const settledStopReason = value?.stopReason ?? 'completed'
        // P1-A：失败快分类。completed 不是失败 → null；refusal/error 等如实分类。
        // 只写分类与建议，不在这里重试/换模型（处置由主控决定）。
        const failure = classifyFailure({
          status: 'completed',
          stopReason: settledStopReason,
          diagnostic: settledDiagnostic,
          output: settledOutput,
          provider: current.runBase?.provider ?? null,
        })
        const settled = {
          status: 'completed',
          stopReason: settledStopReason,
          // 子 Agent 已正常结束；宿主返回了终态，视为进程已确认停止
          stopConfirmed: true,
          output: settledOutput,
          ...(settledDiagnostic !== undefined ? { diagnostic: settledDiagnostic } : {}),
          ...(failure.failureClass
            ? { failureClass: failure.failureClass, hint: failure.hint }
            : {}),
          ...(current.jobId ? { jobId: current.jobId } : {}),
          // P0-C：容错提取结构化结果（纯文本则 summary=原文），完整 output 仍然落盘
          ...resultRecordFields(parseStructuredResult(settledOutput)),
          at: now(),
        }
        // 内存快照必须携带完整 runBase（taskSpec/contextPack/title），
        // 否则同进程 continuesFrom 重放会丢验收/范围/禁止重复（F1）。
        rememberFinished(childId, { ...current.runBase, ...settled })
        void emitRunFinish({
          ...current.runBase,
          ...settled,
          // 落盘字段叫 result：这里显式映射，否则磁盘记录会是空串（真机踩过）
          result: settled.output,
          finishedAt: settled.at,
        })
        settleJob(childId, settled)
        cleanup(childId)
      },
      (err) => {
        const current = handles.get(childId)
        if (!current) return
        current.resultSettled = true
        if (current.cancelling) {
          // 迟到结果是异常/失败时也回填停止证据，并如实记录失败原因
          backfillLateSettlement(childId, current, { rejectedMessage: errorMessage(err) })
          cleanup(childId)
          return
        }
        if (!claimSettlement(current)) return
        const failure = classifyFailure({
          status: 'failed',
          stopReason: 'error',
          diagnostic: errorMessage(err),
          error: { code: 'ADAPTER_ERROR', message: errorMessage(err) },
          output: '',
          provider: current.runBase?.provider ?? null,
        })
        const settled = {
          status: 'failed',
          stopReason: 'error',
          // 执行已经以错误结束；进程不再存活
          stopConfirmed: true,
          output: '',
          diagnostic: errorMessage(err),
          ...(failure.failureClass
            ? { failureClass: failure.failureClass, hint: failure.hint }
            : {}),
          ...(current.jobId ? { jobId: current.jobId } : {}),
          at: now(),
        }
        rememberFinished(childId, { ...current.runBase, ...settled })
        void emitRunFinish({
          ...current.runBase,
          ...settled,
          result: settled.output,
          error: { code: 'ADAPTER_ERROR', message: errorMessage(err) },
          finishedAt: settled.at,
        })
        settleJob(childId, settled)
        cleanup(childId)
      },
    )
  }

  /**
   * 认领终态：一个任务只允许写一次终态，防止 cancel/unload 与 result 回调互相覆盖。
   * @param {any} handle
   * @returns {boolean}
   */
  function claimSettlement(handle) {
    if (!handle || handle.settled) return false
    handle.settled = true
    return true
  }

  /** @param {string} childId */
  function cleanup(childId) {
    const handle = handles.get(childId)
    if (!handle || handle.cleaned) return
    handle.cleaned = true
    handles.delete(childId)
    if (handle.timer) clearTimeout(handle.timer)
    // 通知 dispatcher 释放并发槽位（幂等；适配器只负责"叫一声"，不关心上层怎么记账）
    if (typeof handle.onFinish === 'function') {
      try {
        handle.onFinish()
      } catch {
        /* 释放回调失败不应影响任务收尾 */
      }
    }
  }

  /**
   * 查询一次派发的结果。**不阻塞**：仍在跑就返回 running。
   * 结果只在当前进程内存里保存（最近 20 条），DSH 重启后读不到——如实返回 unknown。
   * @param {string | object} ref childId 或 taskRef
   */
  async function getTask(ref) {
    const childId = typeof ref === 'string' ? ref : ref?.childId
    if (!childId) return { status: 'unknown', reason: '缺少 childId' }

    const done = finished.get(String(childId))
    if (done) return { childId: String(childId), ...done }

    const handle = handles.get(String(childId))
    if (handle) {
      return {
        childId: String(childId),
        status: 'running',
        output: '',
        ...(handle.jobId ? { jobId: handle.jobId } : {}),
      }
    }

    return {
      childId: String(childId),
      status: 'unknown',
      reason: '本进程没有该任务的记录（可能已重启，或不是本插件派发的）',
    }
  }

  /**
   * 内存终态 → `meetingstone_wait` 的单任务结果。
   * 文本只取内存快照的 `output`（磁盘记录用 `result`，本进程未读过盘就不编造）。
   * @param {string} childId
   * @returns {{ childId: string, status: string, stopReason: string | null,
   *             resultBytes: number, summary?: string, timedOut: boolean } | null}
   */
  function terminalResult(childId) {
    const record = finished.get(childId)
    if (!record) return null
    const text =
      typeof record.output === 'string'
        ? record.output
        : typeof record.result === 'string'
          ? record.result
          : ''
    // 只回结构化 summary；纯文本的 summary 就是全文，重复返回会把 wait 输出撑大。
    const summary =
      record.structuredResult === true && typeof record.summary === 'string'
        ? record.summary.trim()
        : ''
    return {
      childId,
      status: typeof record.status === 'string' && record.status ? record.status : 'unknown',
      stopReason: typeof record.stopReason === 'string' ? record.stopReason : null,
      resultBytes: Buffer.byteLength(text, 'utf8'),
      ...(summary ? { summary } : {}),
      timedOut: false,
    }
  }

  /**
   * 仍在跑 → `running` + `timedOut:true`（只有超时路径会产出这个形状）。
   * @param {string} childId
   */
  function runningResult(childId) {
    return {
      childId,
      status: 'running',
      stopReason: null,
      resultBytes: 0,
      timedOut: true,
    }
  }

  /**
   * 等待一组任务**全部到达终态**或超时。不轮询、不忙等：
   * 已结算的任务直接读内存终态；未结算的只等 `rememberFinished` 的通知。
   *
   * - 未知 childId（内存既无终态也无存活句柄）→ `UNKNOWN_CHILD`，**不等待**；
   * - 超时后仍未完成 → `status:'running', timedOut:true`，调用方可稍后再 wait 或查 get_task；
   * - 同一 childId 的多次 wait 复用同一个 deferred，不重复注册监听。
   *
   * @param {string[]} childIds
   * @param {number} [timeoutMs]
   */
  async function waitForSettled(childIds, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
    /** @type {string[]} */
    const ids = []
    for (const raw of Array.isArray(childIds) ? childIds : []) {
      const id = typeof raw === 'string' ? raw.trim() : ''
      if (id && !ids.includes(id)) ids.push(id)
    }
    if (ids.length === 0) {
      return { ok: false, code: 'INVALID_CHILD_IDS', message: 'childIds 必须是非空字符串数组' }
    }

    const unknown = ids.filter((id) => !finished.has(id) && !handles.has(id))
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'UNKNOWN_CHILD',
        message: `未知 childId（本进程没有该任务的记录）：${unknown.join(', ')}`,
        unknownChildIds: unknown,
      }
    }

    const requested =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : DEFAULT_WAIT_TIMEOUT_MS
    const effective = Math.min(requested, MAX_WAIT_TIMEOUT_MS)

    /** @returns {Array<object>} */
    const collect = () =>
      ids.map((id) => terminalResult(id) ?? runningResult(id))

    const pending = ids.filter((id) => !finished.has(id))
    if (pending.length > 0) {
      const waiters = pending.map((id) => acquireWaiter(id).promise)
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null
      try {
        await Promise.race([
          Promise.all(waiters),
          new Promise((resolve) => {
            timer = setTimeout(resolve, effective)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
        // 超时路径：只释放本次 wait 的引用；还有别的 wait 在等同一条任务时保留监听。
        for (const id of pending) releaseWaiter(id)
      }
    }

    const timedOut = ids.some((id) => !finished.has(id))
    return { ok: true, timedOut, timeoutMs: effective, results: collect() }
  }

  /**
   * 取消的适配器内部实现：先 abort，再让宿主 dispose 这个 activation。
   *
   * 顺序是**先 dispose、后 cleanup**：只有拿到 `stopConfirmed:true`（dispose 成功，
   * 或 activation.result 已落定）才释放并发槽位；dispose 超时/抛错时**保留槽位与隔离互斥**，
   * 否则旧进程还没退干净就能再派写任务，串行纪律被绕过（P1）。
   * 保留的槽位会在 result 落定时释放（结果落定是可验证的停止证据）。
   * 重复调用无害：并发的第二次调用复用同一个 cancelPromise。
   *
   * 这是 `hooks.cancel` 的落点，**不能**反过来调用 `cancel()`：`cancel()` 会先
   * `jobs.kill()` → hooks.cancel → 这里，形成递归。
   *
   * @returns {Promise<{ stopConfirmed: boolean, code?: string, message?: string, reason?: string }>}
   */
  async function cancelActivation(taskRef) {
    const childId = typeof taskRef === 'string' ? taskRef : taskRef?.childId
    if (!childId) return { stopConfirmed: false, reason: '缺少 childId' }
    const id = String(childId)
    const handle = handles.get(id)
    if (!handle) {
      // 句柄已被正常收尾：内存终态能确认停止才如实返回 true；否则不猜
      const done = finished.get(id)
      if (done && done.stopConfirmed === true) return { stopConfirmed: true }
      return { stopConfirmed: false, reason: '没有该任务的存活句柄，无法确认停止状态' }
    }
    if (handle.cancelPromise) return handle.cancelPromise

    handle.cancelPromise = (async () => {
      handle.cancelling = true
      if (handle.timer) {
        clearTimeout(handle.timer)
        handle.timer = null
      }
      handle.controller.abort(new Error('meetingstone: cancelled'))
      // 1) 先等宿主真正释放 activation（带超时兜底）
      const disposeError = await disposeActivation(handle.activation, disposeTimeoutMs)
      if (disposeError && typeof ctx?.logger?.warn === 'function') {
        ctx.logger.warn(
          `[meetingstone] cancel: activation dispose ${disposeError.code}: ${disposeError.message}`,
        )
      }
      try {
        // 2) 再写终态（claim 失败说明结果回调已先结算，不重复覆盖）
        if (claimSettlement(handle)) {
          // dispose 超时/失败时，如果 result 在等待期间已经落定，那本身就是可验证的停止证据：
          // 直接写 stopConfirmed:true，并注明迟到结算，避免先写 false 再立刻回填。
          const settledByResult = handle.resultSettled === true
          const stopConfirmed = !disposeError || settledByResult
          const lateNote =
            disposeError && settledByResult ? lateSettlementNote(disposeError) : null
          const settled = {
            status: 'cancelled',
            stopReason: 'cancelled',
            stopConfirmed,
            output: '',
            ...(handle.jobId ? { jobId: handle.jobId } : {}),
            at: now(),
            ...(disposeError
              ? {
                  diagnostic:
                    `activation.dispose 失败（${disposeError.code}）：${disposeError.message}` +
                    (lateNote ? `；${lateNote}` : ''),
                  // 保留 dispose 错误（普通对象，便于迟到结算回填时继续落盘）
                  error: { code: disposeError.code, message: disposeError.message },
                }
              : {}),
          }
          rememberFinished(id, { ...handle.runBase, ...settled })
          // 只在底层结算之后写终态：避免"记录已取消、进程其实又成功完成"
          await emitRunFinish({
            ...handle.runBase,
            ...settled,
            result: settled.output,
            ...(disposeError ? { error: disposeError } : {}),
            finishedAt: settled.at,
          })
          settleJob(id, settled)
        }
      } finally {
        // 3) 只有确认停止才释放并发槽位；未确认时保留句柄（result 落定后再释放）
        if (!disposeError) cleanup(id)
      }
      return {
        stopConfirmed: !disposeError,
        ...(disposeError ? disposeError : {}),
      }
    })()
    return handle.cancelPromise
  }

  /**
   * 取消入口。
   *
   * 有原生 Job 时**优先走 Job 的 cancel**（`ctx.jobs.kill` → `hooks.cancel` →
   * `cancelActivation`），保证面板与工具的停止路径一致；Job 不存在、服务缺失、
   * kill 抛错（例如 owner 已失效）时回退到原来的适配器路径。
   *
   * @returns {Promise<{ stopConfirmed: boolean, code?: string, message?: string, reason?: string }>}
   */
  async function cancel(taskRef) {
    const childId = typeof taskRef === 'string' ? taskRef : taskRef?.childId
    if (!childId) return { stopConfirmed: false, reason: '缺少 childId' }
    const id = String(childId)
    const handle = handles.get(id)
    if (handle && !handle.cancelPromise && handle.jobId) {
      const jobs = jobsService()
      if (jobs && typeof jobs.kill === 'function') {
        try {
          jobs.kill(String(handle.jobId), handle.ownerId ?? undefined, 'meetingstone_cancel_task')
        } catch (err) {
          warn(
            `[meetingstone] jobs: kill ${handle.jobId} 失败，回退到适配器取消：${errorMessage(err)}`,
          )
        }
      }
    }
    return cancelActivation(taskRef)
  }

  // 插件卸载：单一 disposer 内收尾全部存活任务（02-plugin-spec.md §2.4 的硬要求，
  // 不拆成多个并列 ctx.effect，避免异步 disposer 并发导致子进程清理顺序不确定）。
  // 必须给每个存活任务写终态（interrupted），否则重启后磁盘里会留下假 running。
  //
  // P1 修复：卸载也必须按「可验证停止」释放槽位——
  // - 启动中（startActivation 未返回）的占位：只标记取消 + abort，**不立即释放槽位**。
  //   activation 可能随时返回；在返回并 dispose 成功之前，停止状态未确认，
  //   释放槽位会让「迟到且无法停止」的进程绕过并发纪律（F1）。
  // - 已启动的 activation：dispose 成功才释放；超时/抛错时保留句柄与槽位，并记 stopConfirmed:false，
  //   等 result 落定后再释放。绝不无条件 handoff 给 dispatcher。
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => {
      return async () => {
        disposed = true
        // 1) 取消尚未返回的启动：它们没有 childId，只能按占位冻结。
        //    **不调用 onFinish**：槽位保留到 activation 返回并确认 dispose 之后
        //    （见 start() 的迟到分支；启动直接抛错时由 start 的 catch 补释放）。
        for (const [key, placeholder] of [...pendingStarts]) {
          pendingStarts.delete(key)
          placeholder.cancelled = true
          try {
            placeholder.controller.abort(new Error('meetingstone: plugin disposed'))
          } catch {
            /* abort 不应失败 */
          }
        }

        // 2) 先同步冻结所有已登记句柄：标记 cancelling 并 abort，避免卸载期间
        //    result 回调把任务写成 completed（此时应写 interrupted）。
        const snapshot = [...handles.entries()]
        for (const [, handle] of snapshot) {
          if (handle.cancelPromise) continue
          handle.cancelling = true
          if (handle.timer) {
            clearTimeout(handle.timer)
            handle.timer = null
          }
          try {
            handle.controller.abort(new Error('meetingstone: plugin disposed'))
          } catch {
            /* abort 不应失败 */
          }
        }

        // 3) 每个句柄独立收尾：自己的 dispose、自己的终态、自己的 try/finally。
        //    前一个 dispose 阻塞不能拖住后一个的终态写入（F2）。
        //    **不要**先 handles.clear()：未确认停止的句柄必须保留，等 result 落定后再释放。
        //    result 在等待期间落定并 cleanup 的句柄也**不能跳过**——那正是 F2 漏写终态的场景；
        //    此时 resultSettled 就是可验证的停止证据，终态仍要写，stopConfirmed 记 true。
        await Promise.all(
          snapshot.map(async ([id, handle]) => {
            let confirmed = false
            try {
              // 取消流程已经在收尾：复用同一个 promise，避免对同一个 activation 调两次 dispose。
              // 是否释放由 cancel 自己按 dispose 结果决定（未确认时它不会 cleanup）。
              if (handle.cancelPromise) {
                try {
                  await handle.cancelPromise
                } catch {
                  /* cancel 自己会记录错误 */
                }
                return
              }
              const disposeError = await disposeActivation(handle.activation, disposeTimeoutMs)
              if (disposeError) {
                // 清理失败不阻断其余任务的收尾；只记日志，不静默吞掉成「成功」。
                if (typeof ctx?.logger?.warn === 'function') {
                  ctx.logger.warn(
                    `[meetingstone] activation dispose ${disposeError.code}: ${disposeError.message}`,
                  )
                }
              }
              confirmed = !disposeError || handle.resultSettled === true
              if (claimSettlement(handle)) {
                const lateNote =
                  disposeError && handle.resultSettled === true
                    ? lateSettlementNote(disposeError)
                    : null
                const settled = {
                  status: 'interrupted',
                  stopReason: 'plugin-disposed',
                  // dispose 成功 / result 落定 = 确认已停；否则如实标 false
                  stopConfirmed: confirmed,
                  output: '',
                  diagnostic: disposeError
                    ? `插件卸载：任务被中断（activation.dispose 失败 ${disposeError.code}：${disposeError.message}）` +
                      (lateNote ? `；${lateNote}` : '')
                    : '插件卸载：任务被中断',
                  ...(disposeError
                    ? { error: { code: disposeError.code, message: disposeError.message } }
                    : {}),
                  ...(handle.jobId ? { jobId: handle.jobId } : {}),
                  at: now(),
                }
                rememberFinished(id, { ...handle.runBase, ...settled })
                await emitRunFinish({
                  ...handle.runBase,
                  ...settled,
                  result: settled.output,
                  ...(disposeError ? { error: disposeError } : {}),
                  finishedAt: settled.at,
                })
                settleJob(id, settled)
              }
            } finally {
              // 只有确认停止才释放槽位；未确认时保留句柄（result 落定后由回调 cleanup）
              if (confirmed) cleanup(id)
            }
          }),
        )
        // 4) 等待者收尾：已写入终态的由 rememberFinished 唤醒；这里清掉剩余监听，
        //    避免卸载后留下悬挂的 wait promise（没有任务会再来结算它们）。
        for (const id of [...settleWaiters.keys()]) notifySettled(id)
        settleWaiters.clear()
      }
    }, 'meetingstone: activation-cleanup')
  }

  /** 等待原语的自检快照（仅测试/诊断用，不进入工具返回）。 */
  function waitStats() {
    return { pendingWaiters: settleWaiters.size, registrations: waiterRegistrations }
  }

  return { canStart, start, cancel, getTask, waitForSettled, waitStats }
}

/**
 * 从宿主 Agent 读项目根：`exec.agent.session.header.cwd`
 * （docs/audit/07-config-extension.md §4.2 确认该字段是"原始项目目录"）。
 * 拿不到返回 null，由调用方失败关闭。
 * @param {any} agent
 * @returns {string | null}
 */
function readProjectRoot(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : null
}

/**
 * 判断 child 是否在 root 之内（大小写按平台）。
 * 用 path.relative 而不是字符串前缀，避免 `C:\proj-evil` 冒充 `C:\proj`。
 * @param {string} child
 * @param {string} root
 */
function isInside(child, root) {
  const rel = relative(resolve(root), resolve(child))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * realpath 版边界判断，处理 junction / symlink / Windows 大小写。
 * 返回 null 表示无法 realpath（调用方退回字符串判断，而不是放行）。
 * @param {string} child
 * @param {string} root
 * @returns {Promise<boolean | null>}
 */
async function isInsideReal(child, root) {
  try {
    const [realChild, realRoot] = await Promise.all([fs.realpath(child), fs.realpath(root)])
    return isInside(realChild, realRoot)
  } catch {
    return null
  }
}

export default createDshAdapter
