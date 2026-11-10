// @ts-check
import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { composePromptWithContinuation } from '../context-replay.js'
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
 * 7. `ctx.jobs.start(spec: JobSpec): JobId`（**本版未调用**，仅登记）：
 *    `docs/subsystems/jobs.md` §「`ctx.jobs` — `JobRegistry`」cordis-surface
 *    「abstract start(spec: JobSpec): JobId」；`JobSpec` 需 `kind` / `label` /
 *    `run(job: JobHandle): JobHooks`，且 `owner?: SessionId`。见下方 TODO。
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
 * TODO(P2-jobs): 若将来改走后台 Job 路线，用上面的 `ctx.jobs.start(spec)`，把返回的
 *   `JobId` 放进 taskRef；取消信号用该 Job 的 task-owned signal + `job_kill` / owner
 *   disposal（`docs/cookbook/adding-a-tool.md` §「Long-running work」），**不是** `exec.signal`。
 *   该路径的 `JobHooks` 形状与 `run()` 同步 starter 尚未验证，本版不调用。
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
})

/** 等待宿主 `activation.dispose()` 的默认上限（毫秒）。 */
export const DEFAULT_DISPOSE_TIMEOUT_MS = 5000

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
 * 把角色身份、可选的"上次结果重放块"和任务拼成子 Agent 的提示词。
 *
 * 为什么要拼：子 Agent 默认不知道"自己是谁"。CLIWorker 时代靠 persona 的 prompt 注入，
 * 我们替代它时必须保留这个语义，否则「沙僧」和「小白」派出去只是同一个裸模型。
 *
 * 重放块必须放在人设之后、任务之前，并且用显式边界标记——旧输出是不可信数据。
 *
 * @param {any} role
 * @param {string} task
 * @param {{ text: string } | null} [continuation]
 * @returns {string}
 */
function composePrompt(role, task, continuation = null) {
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
    continuation: continuation && typeof continuation.text === 'string' ? continuation : null,
    task: String(task ?? ''),
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
 * 创建 DSH 适配器。
 *
 * @param {object} ctx 宿主 Context（需 `ctx.subagents`；可选 `ctx.effect` / `ctx.logger`）
 * @param {object} [options]
 * @param {() => (object | undefined | null)} [options.getParent]
 *   返回 `SubagentActivationSpec.parent` 所需的 Agent；仅在拿不到 `context.agent` 时兜底。
 * @param {Array<{ channelId: string, kind?: string, provider?: string, model?: string, reasoning?: string }>} [options.channels]
 *   通道实例表（来自插件 Config 的 `channels`）。模型/强度只能由它承载（DD7 方案 B）。
 * @param {() => number} [options.now]
 * @returns {{ canStart: (role: object) => { ok: boolean, reason?: string },
 *            start: (input: object) => Promise<{ taskRef: MeetingstoneTaskRef }>,
 *            cancel: (taskRef: object) => Promise<{ stopConfirmed: boolean, code?: string, message?: string, reason?: string }>,
 *            getTask: (ref: string | object) => Promise<object> }}
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
   * @type {Map<string, { status: string, stopReason?: string, output: string, diagnostic?: string, at: number }>}
   */
  const finished = new Map()
  /** @param {string} childId @param {any} value */
  function rememberFinished(childId, value) {
    finished.set(childId, value)
    while (finished.size > 20) {
      const oldest = finished.keys().next().value
      if (oldest === undefined) break
      finished.delete(oldest)
    }
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
      throw new Error('ADAPTER_DISPOSED: 插件正在卸载，拒绝启动新任务')
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
      label: `meetingstone:${role?.roleId ?? 'unknown'}`,
      delivery: 'caller',
      signal: controller.signal,
      request: {
        parent,
        prompt: [{ type: 'text', text: composePrompt(role, task, input?.continuation) }],
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
      throw new Error('ADAPTER_DISPOSED: 插件已卸载，拒绝启动')
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
      throw err
    }
    pendingStarts.delete(startKey)
    if (placeholder.cancelled || disposed) {
      // 卸载已经发生：这个 activation 不允许登记，立即释放宿主资源后向上抛。
      await disposeActivation(activation, disposeTimeoutMs)
      throw new Error('ADAPTER_DISPOSED: 插件已卸载，拒绝登记启动结果')
    }
    if (!activation || !activation.childId) {
      throw new Error('ADAPTER_FAILED: startActivation 未返回有效 activation（缺 childId）')
    }

    const childId = String(activation.childId)
    /** @type {MeetingstoneTaskRef} */
    const taskRef = {
      kind: 'subagent-activation',
      provider,
      childId,
      name: typeof activation.name === 'string' ? activation.name : childId,
      startedAt: now(),
      // operationId → childId 的即时映射；落盘记录里也有同样一对字段
      ...(operationId ? { operationId } : {}),
    }

    // 5. 取消信号：我们自己的 AbortController（spec.signal）+ activation.dispose()。
    //    timeoutMs 只用来给这个 controller 装一个定时器，是我们自己的策略，不是宿主 API。
    let timer = null
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new Error('meetingstone: timeout')), timeoutMs)
    }
    /** 落盘用的基础信息（不含终态），cancel 也需要它 */
    const runBase = {
      childId,
      projectRoot: typeof input?.context?.projectRoot === 'string' ? input.context.projectRoot : null,
      role: role?.roleId ?? null,
      channel: role?.channel?.kind ?? null,
      provider,
      model: role?.channel?.model ?? null,
      status: 'running',
      createdAt: taskRef.startedAt,
      startedAt: taskRef.startedAt,
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
    }
    handles.set(childId, { activation, controller, timer, onFinish: input?.onFinish, runBase })

    // 先记 running（结果落盘），再挂终态钩子
    emitRunStart(runBase)

    // 任务自己结束后记录结果并释放内部句柄（result 是 subagent.md 确认的 Promise）。
    if (activation.result && typeof activation.result.then === 'function') {
      void activation.result.then(
        (result) => {
          const handleForResult = handles.get(childId)
          if (!handleForResult) return
          // 取消/卸载已经开始收尾时，由那条路径写终态，避免"先 cancelled、又被 completed 覆盖"；
          // 但 result 落定本身就是"进程已停止"的可验证证据，此时才允许释放保留的槽位。
          if (handleForResult.cancelling) {
            cleanup(childId)
            return
          }
          if (!claimSettlement(handleForResult)) return
          const settled = {
            status: 'completed',
            stopReason: result?.stopReason ?? 'completed',
            // 子 Agent 已正常结束；宿主返回了终态，视为进程已确认停止
            stopConfirmed: true,
            output: resultText(result),
            ...(result?.diagnostic ? { diagnostic: String(result.diagnostic) } : {}),
            at: now(),
          }
          rememberFinished(childId, settled)
          void emitRunFinish({
            ...runBase,
            ...settled,
            // 落盘字段叫 result：这里显式映射，否则磁盘记录会是空串（真机踩过）
            result: settled.output,
            finishedAt: settled.at,
          })
          cleanup(childId)
        },
        (err) => {
          const handleForResult = handles.get(childId)
          if (!handleForResult) return
          if (handleForResult.cancelling) {
            cleanup(childId)
            return
          }
          if (!claimSettlement(handleForResult)) return
          const settled = {
            status: 'failed',
            stopReason: 'error',
            // 执行已经以错误结束；进程不再存活
            stopConfirmed: true,
            output: '',
            diagnostic: errorMessage(err),
            at: now(),
          }
          rememberFinished(childId, settled)
          void emitRunFinish({
            ...runBase,
            ...settled,
            result: settled.output,
            error: { code: 'ADAPTER_ERROR', message: errorMessage(err) },
            finishedAt: settled.at,
          })
          cleanup(childId)
        },
      )
    }

    return { taskRef }
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
    if (handle) return { childId: String(childId), status: 'running', output: '' }

    return {
      childId: String(childId),
      status: 'unknown',
      reason: '本进程没有该任务的记录（可能已重启，或不是本插件派发的）',
    }
  }

  /**
   * 取消：先 abort，再让宿主 dispose 这个 activation。
   *
   * 顺序是**先 dispose、后 cleanup**：只有拿到 `stopConfirmed:true`（dispose 成功，
   * 或 activation.result 已落定）才释放并发槽位；dispose 超时/抛错时**保留槽位与隔离互斥**，
   * 否则旧进程还没退干净就能再派写任务，串行纪律被绕过（P1）。
   * 保留的槽位会在 result 落定时释放（结果落定是可验证的停止证据）。
   * 重复调用无害：并发的第二次调用复用同一个 cancelPromise。
   *
   * @returns {Promise<{ stopConfirmed: boolean, code?: string, message?: string, reason?: string }>}
   */
  async function cancel(taskRef) {
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
          const settled = {
            status: 'cancelled',
            stopReason: 'cancelled',
            // dispose 成功 = 确认已停；超时/失败时如实标 false（进程可能还活着）
            stopConfirmed: !disposeError,
            output: '',
            at: now(),
            ...(disposeError
              ? { diagnostic: `activation.dispose 失败（${disposeError.code}）：${disposeError.message}` }
              : {}),
          }
          rememberFinished(id, settled)
          // 只在底层结算之后写终态：避免"记录已取消、进程其实又成功完成"
          await emitRunFinish({
            ...handle.runBase,
            ...settled,
            result: settled.output,
            ...(disposeError ? { error: disposeError } : {}),
            finishedAt: settled.at,
          })
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

  // 插件卸载：单一 disposer 内串行 await 全部收尾（02-plugin-spec.md §2.4 的硬要求，
  // 不拆成多个并列 ctx.effect，避免异步 disposer 并发导致子进程清理顺序不确定）。
  // 必须给每个存活任务写终态（interrupted），否则重启后磁盘里会留下假 running。
  //
  // P1 修复：卸载也必须按「可验证停止」释放槽位——
  // - 启动中（startActivation 未返回）的占位：取消占位并释放其槽位（还没有真实 activation）；
  // - 已启动的 activation：dispose 成功才释放；超时/抛错时保留句柄与槽位，并记 stopConfirmed:false，
  //   等 result 落定后再释放。绝不无条件 handoff 给 dispatcher。
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => {
      return async () => {
        disposed = true
        // 1) 取消尚未返回的启动：它们没有 childId，只能按占位收尾。
        for (const [key, placeholder] of [...pendingStarts]) {
          pendingStarts.delete(key)
          placeholder.cancelled = true
          try {
            placeholder.controller.abort(new Error('meetingstone: plugin disposed'))
          } catch {
            /* abort 不应失败 */
          }
          if (typeof placeholder.onFinish === 'function') {
            try {
              placeholder.onFinish()
            } catch {
              /* 释放回调失败不影响清理 */
            }
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

        // 3) 逐个收尾已登记的 activation。注意**不要**先 handles.clear()：
        //    未确认停止的句柄必须保留，等 result 落定后再释放。
        for (const [id, handle] of snapshot) {
          // 取消流程已经在收尾：复用同一个 promise，避免对同一个 activation 调两次 dispose。
          // 是否释放由 cancel 自己按 dispose 结果决定（未确认时它不会 cleanup）。
          if (handle.cancelPromise) {
            try {
              await handle.cancelPromise
            } catch {
              /* cancel 自己会记录错误 */
            }
            continue
          }
          // 冻结之后 result 可能已经落定并 cleanup；已清理的句柄不再 dispose
          if (handle.cleaned || !handles.has(id)) continue
          let disposeError = null
          try {
            disposeError = await disposeActivation(handle.activation, disposeTimeoutMs)
            if (disposeError) {
              // 清理失败不阻断其余任务的收尾；只记日志，不静默吞掉成「成功」。
              if (typeof ctx?.logger?.warn === 'function') {
                ctx.logger.warn(
                  `[meetingstone] activation dispose ${disposeError.code}: ${disposeError.message}`,
                )
              }
            }
            if (claimSettlement(handle)) {
              const settled = {
                status: 'interrupted',
                stopReason: 'plugin-disposed',
                // dispose 成功 = 确认已停；超时/失败时如实标 false
                stopConfirmed: !disposeError,
                output: '',
                diagnostic: disposeError
                  ? `插件卸载：任务被中断（activation.dispose 失败 ${disposeError.code}：${disposeError.message}）`
                  : '插件卸载：任务被中断',
                at: now(),
              }
              rememberFinished(handle.runBase.childId, settled)
              await emitRunFinish({
                ...handle.runBase,
                ...settled,
                result: settled.output,
                ...(disposeError ? { error: disposeError } : {}),
                finishedAt: settled.at,
              })
            }
          } finally {
            // 只有确认停止才释放槽位；未确认时保留句柄（result 落定后由回调 cleanup）
            if (!disposeError) cleanup(id)
          }
        }
      }
    }, 'meetingstone: activation-cleanup')
  }

  return { canStart, start, cancel, getTask }
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
