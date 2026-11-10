// @ts-check
import { relative, resolve } from 'node:path'
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
 * TODO(P2-parent): `startActivation` 的 `parent: Agent` 是**必填**，但 dispatcher 的
 *   `start({ role, task, cwd, readOnly, timeoutMs })` 接口没有 Agent。本版通过
 *   `createDshAdapter(ctx, { getParent })` 注入；未注入时抛错失败关闭，不编造 Agent。
 *   `docs/cookbook/adding-a-tool.md` 提到 `exec.agent`，但「它能直接当 `parent`」**未验证**，
 *   需由工具调用方（src/index.js，并行工作面）在真实会话里确认后注入。
 * TODO(P2-readonly): 官方 `SubagentActivationSpec` / `SubagentStartRequest` **没有**
 *   permission / readOnly / sandbox 字段；provider 的 `permissionMode`（codex/claude-code）
 *   与 `permission`（acp）是**挂载时的行配置**（10-provider-install.md §8.1），不是每次
 *   start 的参数。只读只能由 provider 行（通道实例）保证：实例声明 read-only 时
 *   返回 `readOnlyEnforced:true`，否则拒绝启动
 *   让上层显示「无保证」——这是 `docs/audit/08-sandbox.md` §「启动必须校验 backend 和实际
 *   限制，失败关闭 / 标无保证」的硬要求，绝不静默假装只读生效。
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
 * @property {boolean} readOnlyEnforced 是否由通道实例保证了只读（仅当实例声明 read-only 时为 true）
 * @property {number} startedAt 本适配器记录的启动时间（Date.now()）
 */

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
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
 *            start: (input: object) => Promise<{ taskRef: MeetingstoneTaskRef,
 *                                               readOnlyEnforced: boolean }>,
 *            cancel: (taskRef: object) => Promise<void> }}
 */
export function createDshAdapter(ctx, options = {}) {
  const getParent = options.getParent ?? null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** @type {Map<string, any>} */
  const channelsById = new Map()
  for (const instance of options.channels ?? []) {
    if (instance && typeof instance.channelId === 'string' && instance.channelId) {
      channelsById.set(instance.channelId, instance)
    }
  }

  /** @type {Map<string, { activation: any, controller: AbortController, timer: any }>} */
  const handles = new Map()

  /**
   * 查询 provider 是否注册。**只信宿主返回值，不猜**。
   * 拿不到查询能力或查不到 provider，一律 ok:false。
   */
  function canStart(role) {
    const provider = providerNameFor(role)
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
  async function start(input) {
    const { role, task, cwd, readOnly, timeoutMs } = input ?? {}
    // readOnly 在这里被显式「不消费」：官方 SubagentActivationSpec 没有 permission/readOnly
    // 字段（TODO(P2-readonly)），绝不塞进 spec 假装生效；只在结果/taskRef 上标 false。
    void readOnly
    const provider = providerNameFor(role)
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

    // 2.5 启动前置校验（P2 Gate 复核 P0）：三项约束不满足就**不启动**，而不是带病启动。
    //
    // (a) 只读：官方 SubagentActivationSpec 没有 readonly/permission 字段（TODO(P2-readonly)），
    //     无法强制时按 docs/audit/08-sandbox.md §8 的要求拒绝启动，而不是启动后标个 false。
    //
    // 只读由**通道实例**承载（与模型同理，DD7 方案 B 的延伸）：
    // 宿主的启动 spec 没有 permission 字段，能不能只读取决于 provider 行怎么配。
    // 角色是只读时必须引用一个声明 permissionPreset: 'read-only' 的实例，否则拒绝。
    let readOnlyEnforced = false
    if (readOnly === true) {
      const channelId = role?.channel?.channelId
      const instance = channelId ? channelsById.get(String(channelId)) : null
      if (!instance) {
        throw new Error(
          'READONLY_UNENFORCEABLE: 角色是只读档位，但没有引用任何通道实例，无法确认该通道真的只读。' +
            '请在配置的 channels 里声明一个 permissionPreset: read-only 的实例，让角色用 channelId 引用它',
        )
      }
      if (instance.permissionPreset !== 'read-only') {
        throw new Error(
          `READONLY_UNENFORCEABLE: 通道实例 ${channelId} 声明的权限是 ` +
            `${instance.permissionPreset ?? '(未声明)'}，不是 read-only，无法保证只读；已拒绝启动`,
        )
      }
      readOnlyEnforced = true
    }

    // (b) 模型/强度：官方 spec 不收 model/reasoning，模型只能由 **provider 行**承载（DD7 方案 B）。
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

    // (c) 项目边界：cwd 必须在当前会话的项目根之内；拿不到项目根就失败关闭
    if (typeof cwd === 'string' && cwd) {
      const projectRoot = input?.context?.projectRoot ?? readProjectRoot(parent)
      if (!projectRoot) {
        throw new Error(
          'PROJECT_ROOT_UNKNOWN: 无法从当前会话确定项目根，拒绝在未校验的 cwd 下启动',
        )
      }
      if (!isInside(cwd, projectRoot)) {
        throw new Error(
          `PATH_OUTSIDE_PROJECT: cwd ${cwd} 不在项目根 ${projectRoot} 之内，已拒绝启动`,
        )
      }
    }

    // 3. 组装官方 SubagentActivationSpec（字段出处见文件头第 2 条）。
    //    delivery:'caller' —— 「caller delivery only returns the result」（subagent.md）；
    //    TODO(P2-runtime): 该取值尚未在真实会话里验证，若宿主要求 parent delivery 需改这里。
    const controller = new AbortController()
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
        prompt: [{ type: 'text', text: String(task ?? '') }],
        ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
        // 不传 maxDepth：实现里 `resolveChildDepth(parent, undefined)` 自带默认上限；
        // 传了反而要求 provider 具备 depthLimit 能力。
      },
    }

    // 4. 调宿主创建任务。抛错（含权限被拒 / 参数不接受）直接向上抛，不吞。
    const activation = await subagents.startActivation(spec)
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
      // 只读是由通道实例保证的（实例声明 read-only 才允许走到这里）
      readOnlyEnforced,
      startedAt: now(),
    }

    // 5. 取消信号：我们自己的 AbortController（spec.signal）+ activation.dispose()。
    //    timeoutMs 只用来给这个 controller 装一个定时器，是我们自己的策略，不是宿主 API。
    let timer = null
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new Error('meetingstone: timeout')), timeoutMs)
    }
    handles.set(childId, { activation, controller, timer, onFinish: input?.onFinish })

    // 任务自己结束后释放内部句柄（result 是 subagent.md 确认的 Promise）。
    if (activation.result && typeof activation.result.then === 'function') {
      void activation.result.then(
        () => cleanup(childId),
        () => cleanup(childId),
      )
    }

    // readOnlyEnforced 同时在返回值与 taskRef 上标记，保证上层（dispatcher → tool）看得见。
    return { taskRef, readOnlyEnforced }
  }

  /** @param {string} childId */
  function cleanup(childId) {
    const handle = handles.get(childId)
    if (!handle) return
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

  /** 取消：先 abort，再让宿主 dispose 这个 activation。重复调用无害。 */
  async function cancel(taskRef) {
    const childId = taskRef?.childId
    if (!childId) return
    const handle = handles.get(String(childId))
    if (!handle) return
    cleanup(String(childId))
    handle.controller.abort(new Error('meetingstone: cancelled'))
    if (typeof handle.activation?.dispose === 'function') {
      await handle.activation.dispose()
    }
  }

  // 插件卸载：单一 disposer 内串行 await 全部收尾（02-plugin-spec.md §2.4 的硬要求，
  // 不拆成多个并列 ctx.effect，避免异步 disposer 并发导致子进程清理顺序不确定）。
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => {
      return async () => {
        const pending = [...handles.values()]
        handles.clear()
        for (const handle of pending) {
          if (handle.timer) clearTimeout(handle.timer)
          handle.controller.abort(new Error('meetingstone: plugin disposed'))
          try {
            if (typeof handle.activation?.dispose === 'function') {
              await handle.activation.dispose()
            }
          } catch (err) {
            // 清理失败不阻断其余任务的收尾；只记日志，不静默吞掉成「成功」。
            if (typeof ctx?.logger?.warn === 'function') {
              ctx.logger.warn(`[meetingstone] activation dispose failed: ${errorMessage(err)}`)
            }
          } finally {
            if (typeof handle.onFinish === 'function') {
              try {
                handle.onFinish()
              } catch {
                /* 同上：释放回调失败不影响清理 */
              }
            }
          }
        }
      }
    }, 'meetingstone: activation-cleanup')
  }

  return { canStart, start, cancel }
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
  return !rel.startsWith('..') && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel)
}

export default createDshAdapter
