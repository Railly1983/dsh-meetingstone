// @ts-check
/**
 * DSH 接线层 · 工具注册（阶段 2）。
 *
 * deps 一律由调用方注入：`{ registry, dispatcher, probe }`。本模块不创建它们、
 * 不 import 它们的实现，保持可用假 ctx 单测。
 *
 * ── 本文件用到的宿主 API，逐条给出出处 ────────────────────────────────────────
 * 官方来源固定为 `deepseek-ai/deepseek-harness` `ref=master` @ `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
 * （commit 2026-11-04，0.2.2-rc.1），与本机宿主同版。
 *
 * 1. `ctx.tools.register(defineTool({...}))` + 模块导出 `inject = ['tools']`
 *    出处：`docs/user/develop/basic/tool.md`（本项目 `docs/audit/02-plugin-spec.md` §3.1
 *    摘录的完整示例）：`import { defineTool } from '@deepseek-ai/dsh-tools'`、
 *    `export const inject = ['tools']`、`ctx.tools.register(defineTool({ name, description,
 *    parameters, output: { schema, render }, execute }))`。
 *    工具字段形状（含 `output.schema` 可为 object 根）出自
 *    `docs/cookbook/adding-a-tool.md` §「Rules of the execute() contract」。
 *
 * 2. 「注册即 effect」：`ctx.tools.register(tool)` 在插件卸载时由框架自动注销
 *    出处：`docs/user/develop/framework/index.md` §「Automatic cleanup」列出的
 *    自动清理清单（02-plugin-spec.md §2.4 复核）；故这里**不**手工 unregister。
 *
 * 3. `ctx.subagents.getProvider(name)` —— 用于 list_roles 的 availability 判定。
 *    出处：`docs/subsystems/subagent.md` cordis-surface；本项目
 *    `docs/audit/10-provider-install.md` §7.2 逐字引用。查不到则返回 'unknown'，不猜。
 *
 * 4. `probe.probe(cli)` / `probe.probeAll()` —— 注入的探测器契约，出处为本项目
 *    `src/cli/probe.js`（并行工作面，本文件只读引用其公开返回类型 ProbeResult：
 *    `{ cli, installed, path, version, source, notes, checkedAt }`）。
 *    ProbeResult **不含** auth / balance 字段，故本工具原样透传，不补任何推断。
 *
 * 5. `ctx.approval.request(req)` —— **第一版不接审批**，仅登记 TODO。
 *    出处：`docs/subsystems/approval.md`（02-plugin-spec.md §3.2）：结果闭集
 *    `'allowed-once'|'rejected'|'cancelled'|'unavailable'`，**只有 allowed-once 放行**
 *    （fail-closed）；请求需 `agent` / `toolName` / `callId` / `reason` / `signal`，
 *    且要求 session 处于已开启的 turn 内。
 *
 * ── 明确未解决 / 待运行验证 ────────────────────────────────────────────────
 * P2-defineTool（已接线）：入口 src/index.js 同步探测宿主的
 *   `@deepseek-ai/dsh-tools` 并把真实 `defineTool` 作为 `deps.defineTool` 注入，
 *   获得 args 校验与 canonical 值校验。本模块**不静态 import 宿主包**：本地测试环境
 *   只装了 `@deepseek-ai/schemastery`，静态 import 会让 `node --test` 直接失败。
 *   拿不到宿主包时**不再原样注册**（那会把未编译的参数字典当 JSON Schema，
 *   触发 DeepSeek `Invalid schema ... writeOnly is not of type "boolean"`），
 *   改用下面的 compileToolSpec 做等价编译；该降级路径不含运行时 args 校验。
 *   另：官方 defineTool 要求 object 根显式声明 `additionalProperties`，
 *   故所有 `output.schema` 都带 `additionalProperties: true`。
 * TODO(P2-approval): 审批应挂在 `meetingstone_dispatch.execute` 里、`dispatcher.dispatch()`
 *   **之前**：`const outcome = await ctx.approval.request({ agent, toolName:
 *   'meetingstone_dispatch', callId, reason, signal })`；只有 `outcome === 'allowed-once'`
 *   才继续，其余（含 'unavailable'）一律返回失败。第一版按要求不调用、也不假装已授权。
 * TODO(P2-inject): `export const inject = ['tools']` 是**插件模块级**导出；本文件不是
 *   bundle 入口（入口是 src/index.js），需由入口 re-export 或在 apply 里等待 tools 服务，
 *   Loader 才会据此排序。该接线属并行工作面，此处只导出常量供其使用。
 * TODO(P2-roles-source): `registry.list()`（src/roles/registry.js）不携带角色来源，
 *   故 list_roles 的 `source` 标 'unknown'；若 registry 日后补来源标注再透传，不编造。
 */

import { providerNameFor } from './adapter.js'
import { normalizeProjectKey } from '../dispatch/dispatcher.js'
import { resolveContinuation } from '../context-replay.js'
import { truncateUtf8 } from '../run-store.js'
import { validateTaskSpec } from '../taskspec.js'

// 兼容旧引用：归一化实现只在 dispatcher 里维护一份，避免两处逻辑漂移。
export { normalizeProjectKey }

/**
 * 插件模块级 inject：等待工具注册表就绪。
 * 出处 `docs/user/develop/basic/tool.md`；TODO(P2-inject) 见文件头。
 */
export const inject = Object.freeze(['tools'])

/** 工具名集中定义，便于测试与后续引用。 */
export const TOOL_NAMES = Object.freeze({
  LIST_ROLES: 'meetingstone_list_roles',
  DISPATCH: 'meetingstone_dispatch',
  GET_TASK: 'meetingstone_get_task',
  LIST_RUNS: 'meetingstone_list_runs',
  CANCEL_TASK: 'meetingstone_cancel_task',
  GET_RUN_ARTIFACT: 'meetingstone_get_run_artifact',
  CLI_STATUS: 'meetingstone_cli_status',
})

/** meetingstone_cli_status 接受的 CLI 白名单（与 src/cli/probe.js 的 CLI_SPECS 对齐）。 */
export const CLI_STATUS_CLIS = Object.freeze(['codex', 'codebuddy', 'claude'])

/**
 * canonical 值 → 模型可见内容。纯函数，无 I/O（cookbook/adding-a-tool.md 的 render 约束）。
 * @param {unknown} _args
 * @param {unknown} value
 */
function renderObject(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value ?? null) }]
}

/**
 * 与宿主 `@deepseek-ai/dsh-tools` 的 `parameterSchemaSpecToJsonSchema` 等价的最小编译。
 * 出处：本机 0.2.2-rc.1 `app.asar` 内 `lib/index.js` / `lib/types/schema.js`：
 * 字段字典 → `{ type:'object', properties, required? }`；字段只保留
 * type/description/title/default/examples/enum/const，`required:true` 提升到根级。
 *
 * 为什么必须编译：未编译的字典把字段名暴露在 JSON Schema 根上；
 * `writeOnly` 等是 JSON Schema 保留注解（值必须是 boolean），DeepSeek API 校验直接报
 * `Invalid schema for function ... is not of type "boolean"` 并拒掉整轮请求。
 * @param {object} spec
 */
function compileParameterSpec(spec) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec ?? {})) {
    const source = field && typeof field === 'object' ? field : {}
    const node = {}
    for (const k of ['type', 'description', 'title', 'default', 'examples', 'enum', 'const']) {
      if (Object.hasOwn(source, k)) node[k] = source[k]
    }
    // 避免 `__proto__` 之类的键触发原型赋值语义（与宿主实现一致）。
    Object.defineProperty(properties, key, {
      value: node,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    if (source.required === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** 与 `valueSchemaSpecToJsonSchema` 等价：object 根必须显式声明 additionalProperties。 */
function compileValueSchema(spec) {
  const node = { ...(spec ?? {}) }
  if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
    node.additionalProperties = true
  }
  return node
}

/** 降级路径：把作者 DSL 编译成 ctx.tools.register 期望的 registry-ready 定义。 */
function compileToolSpec(spec) {
  return {
    ...spec,
    parameters: compileParameterSpec(spec.parameters),
    output: { ...spec.output, schema: compileValueSchema(spec.output?.schema) },
  }
}

/**
 * 注册前 fail-fast（2026-11-10 事故兜底）。
 *
 * 宿主 `register()` 只校验 output.schema、不校验 parameters，投影时又原样深拷贝；
 * 一个坏定义混进全局工具集，会让 profile 下所有会话每轮都被 API 拒。
 * 宁可让本插件加载失败（错误局限在插件自己），也不把坏 schema 交出去。
 * 两条注册路径（官方 defineTool / 本地编译）都过这一关。
 * @param {object} definition
 */
function assertHostReadySchema(definition) {
  const name = definition?.name ?? '(unknown)'
  const p = definition?.parameters
  if (!p || typeof p !== 'object' || p.type !== 'object' || !p.properties) {
    throw new Error(`TOOL_SCHEMA_INVALID: ${name} 的 parameters 不是 object 根 JSON Schema`)
  }
  for (const key of ['readOnly', 'writeOnly', 'deprecated', '$schema', '$ref']) {
    if (Object.hasOwn(p, key)) {
      throw new Error(
        `TOOL_SCHEMA_INVALID: ${name} 的 parameters 根上出现保留关键字 ${key}（字段字典未编译）`,
      )
    }
  }
  const s = definition?.output?.schema
  if (s?.type === 'object' && typeof s.additionalProperties !== 'boolean') {
    throw new Error(`TOOL_SCHEMA_INVALID: ${name} 的 object 输出 schema 缺 additionalProperties`)
  }
}

/**
 * 角色 → 对外视图。
 *
 * 默认**紧凑**（Token 审计 2026-11-11）：只回 roleId/name/aliases/enabled/availability。
 * `verbose:true` 才追加 description/channel/model/hasPrompt/source —— 角色多时
 * 默认返回全量字段会把工具结果撑得很大，而模型通常只需要角色标识与可用性。
 *
 * @param {object} role
 * @param {object} ctx
 * @param {{ verbose?: boolean }} [options]
 */
function toRoleView(role, ctx, options = {}) {
  const view = {
    roleId: role.roleId,
    name: role.name,
    aliases: Array.isArray(role.aliases) ? [...role.aliases] : [],
    enabled: role.enabled !== false,
    availability: availabilityOf(role, ctx),
  }
  if (options.verbose !== true) return view
  return {
    ...view,
    // 配置透明性：不返回 prompt 全文（可能很长），只给"有没有人设"和摘要
    description: typeof role.description === 'string' ? role.description : '',
    hasPrompt: typeof role.prompt === 'string' && role.prompt.trim() !== '',
    channel: { ...role.channel },
    ...(typeof role.channel?.channelId === 'string' ? { channelId: role.channel.channelId } : {}),
    ...(typeof role.channel?.model === 'string' ? { model: role.channel.model } : {}),
    source: typeof role.source === 'string' ? role.source : 'unknown',
  }
}

/**
 * 角色可用性。用的是**已确认**的 `ctx.subagents.getProvider(name)`（出处见文件头第 3 条）。
 * 拿不到查询能力就返回 'unknown'——不猜、不假装可用。
 * @param {object} role
 * @param {object} ctx
 * @returns {'disabled' | 'ambiguous' | 'available' | 'provider-unavailable' | 'unknown'}
 */
function availabilityOf(role, ctx) {
  if (role.enabled === false || role.disabled === true) return 'disabled'
  if (role.ambiguous === true) return 'ambiguous'
  let subagents = null
  try {
    subagents = ctx?.subagents ?? null
  } catch {
    subagents = null // 未 inject 时访问会抛，按"未知"处理
  }
  if (!subagents || typeof subagents.getProvider !== 'function') return 'unknown'
  const provider = providerNameFor(role)
  if (!provider) return 'unknown'
  try {
    return subagents.getProvider(provider) ? 'available' : 'provider-unavailable'
  } catch {
    return 'unknown'
  }
}

/**
 * ProbeResult → 工具返回视图。**只透传探测器自己给的字段**：
 * 不返回余额、不编造认证状态（ProbeResult 本身没有 auth/balance 字段）。
 * @param {object} r
 */
function toCliView(r) {
  return {
    cli: r?.cli ?? null,
    installed: r?.installed === true,
    path: r?.path ?? null,
    version: r?.version ?? null,
    source: r?.source ?? null,
    checkedAt: typeof r?.checkedAt === 'number' ? r.checkedAt : null,
    notes: Array.isArray(r?.notes) ? [...r.notes] : [],
  }
}

/** get_task 默认摘要的结果窗口（UTF-8 字节）：头 1KiB + 尾 512B。 */
export const TASK_RESULT_HEAD_BYTES = 1024
export const TASK_RESULT_TAIL_BYTES = 512

/**
 * 任务记录 → 模型可见视图（Token 审计 2026-11-11 / P0-C）。
 *
 * - 有结构化 `summary` 时，默认**只回 summary/status/openIssues 等字段**，不再回原始正文
 *   （正文用 full:true 或 meetingstone_get_run_artifact 按需取）；
 * - 没有 summary 时退回首 1KiB + 末 512B 摘要，并附 `resultBytes`；
 * - `full:true` 才返回完整正文；
 * - 记录里 `output`/`result` 可能同时存在（内存终态用 output、磁盘用 result），
 *   这里统一压成**一个** `result` 字段，绝不重复返回两份正文。
 *
 * @param {any} record
 * @param {boolean} full
 */
function taskResultView(record, full) {
  const source = record && typeof record === 'object' ? record : {}
  // 内存终态优先（`output` 来自本进程），但它为空时退回磁盘快照 `result`，
  // 避免"内存空串"把已经落盘的结果吞掉。
  const liveText = typeof source.output === 'string' ? source.output : ''
  const storedText = typeof source.result === 'string' ? source.result : ''
  const text = liveText || storedText
  const bytes = Buffer.byteLength(text, 'utf8')
  const summary = typeof source.summary === 'string' ? source.summary.trim() : ''
  const out = { ...source }
  delete out.output
  if (full) {
    out.result = text
    out.resultBytes = bytes
    out.resultTruncated = source.resultTruncated === true
    delete out.resultOmitted
  } else if (summary) {
    // 结构化摘要已经在记录里（落盘时按 8KiB 截断）；不再附带原始正文
    delete out.result
    out.resultOmitted = true
    out.resultBytes = bytes
    out.resultTruncated = true
  } else {
    const preview = truncateUtf8(text, TASK_RESULT_HEAD_BYTES + TASK_RESULT_TAIL_BYTES, {
      headBytes: TASK_RESULT_HEAD_BYTES,
      tailBytes: TASK_RESULT_TAIL_BYTES,
    })
    out.result = preview.text
    out.resultBytes = bytes
    out.resultTruncated = preview.truncated
  }
  if (source.resultTruncated === true) out.recordResultTruncated = true
  return out
}

/**
 * 注册七个工具。
 *
 * @param {object} ctx 宿主 Context（需 `ctx.tools.register`）
 * @param {object} deps
 * @param {object} deps.registry  角色注册表：`list(): Role[]`、`errors: RegistryError[]`
 * @param {object} deps.dispatcher  派单器：`dispatch(req) -> Promise<DispatchResult>`
 * @param {object} deps.probe  CLI 探测器：`probe(cli)` / `probeAll()`
 * @param {(spec: object) => object} [deps.defineTool]
 *   可选；生产应注入 `@deepseek-ai/dsh-tools` 的真实 defineTool（TODO(P2-defineTool)）。
 * @returns {Array<{ name: string }>} 已注册的工具定义（便于调用方/测试核对）
 */
export function registerTools(ctx, deps) {
  const { registry, dispatcher, probe, loadPersistedRun, listPersistedRuns } = deps ?? {}

  /**
   * 取一次任务的结果（内存优先、磁盘兜底），供上下文重放使用。
   * 返回 `null` 表示"确实没有这条记录"；带 `code` 的对象由重放层翻译成对应错误。
   * @param {any} exec
   * @param {string} childId
   */
  const resolveRun =
    typeof deps.resolveRun === 'function'
      ? deps.resolveRun
      : async (exec, childId) => {
          const live = typeof dispatcher.getTask === 'function' ? await dispatcher.getTask(childId) : null
          if (live && live.status !== 'unknown') return live
          return loadPersistedRun ? await loadPersistedRun(exec, childId) : live
        }

  /**
   * 记录文件路径（可选依赖）：由入口用 run-store 的 pathFor 计算，
   * 让 get_task 默认就能告诉调用方磁盘记录在哪。
   * @param {any} exec
   * @param {string} childId
   * @returns {string | null}
   */
  const recordPathFor = typeof deps.recordPathFor === 'function' ? deps.recordPathFor : null
  function recordPathOf(exec, childId) {
    if (!recordPathFor) return null
    try {
      const path = recordPathFor(exec, childId)
      return typeof path === 'string' && path ? path : null
    } catch {
      return null
    }
  }

  /**
   * 给记录补 recordPath（不覆盖已有值）。
   * @param {any} record
   * @param {any} exec
   * @param {string} childId
   */
  function withRecordPath(record, exec, childId) {
    if (!record || typeof record !== 'object') return record
    if (typeof record.recordPath === 'string' && record.recordPath) return record
    const path = recordPathOf(exec, childId)
    return path ? { ...record, recordPath: path } : record
  }

  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('TOOLS_UNAVAILABLE: ctx.tools.register 不可用')
  }
  if (!registry || typeof registry.list !== 'function') {
    throw new Error('REGISTRY_UNAVAILABLE: deps.registry.list 不可用')
  }
  if (!dispatcher || typeof dispatcher.dispatch !== 'function') {
    throw new Error('DISPATCHER_UNAVAILABLE: deps.dispatcher.dispatch 不可用')
  }

  // 宿主 defineTool 可用 → 官方编译 + args 校验；否则本地等价编译 schema。
  // 两条路径都只把合法 JSON Schema 交给 ctx.tools.register（见文件头 P2-defineTool）。
  const defineTool =
    typeof deps.defineTool === 'function' ? deps.defineTool : compileToolSpec

  // 按「当前会话的项目根」构造注册表（全局角色 + 项目 .meetingstone.json 覆盖）。
  // 未注入时退回静态 registry（只有全局角色），并在返回里如实说明，不假装项目配置生效。
  const resolveRegistry =
    typeof deps.resolveRegistry === 'function' ? deps.resolveRegistry : null

  /**
   * @param {any} exec
   * @returns {Promise<{ registry: any, projectErrors: any[] }>}
   */
  async function registryFor(exec) {
    if (!resolveRegistry) return { registry, projectErrors: [] }
    try {
      const res = await resolveRegistry(exec)
      if (res && res.registry) return res
      return { registry, projectErrors: [] }
    } catch (err) {
      return {
        registry,
        projectErrors: [
          {
            code: 'PROJECT_CONFIG_LOAD_FAILED',
            message: `项目配置加载失败，已退回全局角色表：${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
      }
    }
  }

  /** @type {Array<object>} */
  const tools = [
    {
      name: TOOL_NAMES.LIST_ROLES,
      description:
        '列出集合石已配置的角色。默认紧凑：roleId/名称/别名/启用状态/可用性（provider 未装时标为不可用）。' +
        'verbose:true 才返回职责说明、通道/模型、是否配置人设与来源；不返回 prompt 全文，不派单、不探测本机 CLI。',
      parameters: {
        verbose: {
          type: 'boolean',
          description: 'true=返回 description/channel/model/hasPrompt/source 等详细字段（默认 false）',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args, exec) {
        const effective = await registryFor(exec)
        const verbose = args?.verbose === true
        const roles = effective.registry
          .list()
          .map((/** @type {object} */ role) => toRoleView(role, ctx, { verbose }))
        const errors = [
          ...(Array.isArray(effective.registry.errors) ? effective.registry.errors : []),
          ...(effective.projectErrors ?? []),
        ]
        return { roles, errors, projectScoped: Boolean(resolveRegistry) }
      },
    },
    {
      name: TOOL_NAMES.DISPATCH,
      description:
        '按角色把一次任务派发给宿主 provider。默认每个任务在独立 git 工作树里执行（默认并行上限 2/项目、4/全局）；' +
        'isolation=none 时退回主工作区串行。工作树只隔离文件布局，不是权限沙箱。' +
        '可以只传 role+task（旧用法），也可以带 title/objective/scope/acceptance/contextPack 等结构化简报；' +
        '使用任一结构化字段时 title 必填，声明 scope 时必须给 acceptance。简单查询不需要 scope/evidence。',
      parameters: {
        role: { type: 'string', required: true, description: '角色名、别名或 roleId' },
        task: { type: 'string', required: true, description: '任务内容' },
        title: {
          type: 'string',
          description: '短任务名；使用任一结构化字段时必填，用于 Jobs / list_runs 展示',
        },
        objective: {
          type: 'string',
          description: '要达成的结果；省略时任务正文即目标',
        },
        scope: {
          type: 'object',
          description: '范围与边界：{ include: string[], exclude: string[] }；声明了 scope 就必须给 acceptance',
        },
        acceptance: {
          type: 'array',
          description: '验收标准（字符串数组）；声明 scope 时必填，简单查询可省略',
        },
        evidence: {
          type: 'array',
          description: '需要提交的证据 / 文件 / 测试（字符串数组）',
        },
        contextRefs: {
          type: 'array',
          description: '上下文包或文件引用（字符串数组）',
        },
        roleHint: {
          type: 'string',
          description: '建议角色 / 能力提示（仅随简报传递，不改变本次 role 路由）',
        },
        outputBudget: {
          type: 'object',
          description: '摘要与产物预算：{ summaryTokens?: number, notes?: string }',
        },
        contextPack: {
          type: 'object',
          description:
            '最小上下文：{ knownFacts: string[], files: string[], priorResults: [{ summary, artifactRef }], doNotRepeat: string[] }',
        },
        cwd: { type: 'string', description: '目标目录；隔离模式下由工作树路径覆盖，调用方须先校验在项目内' },
        isolation: {
          type: 'string',
          enum: ['none', 'worktree'],
          description:
            '本次隔离方式：worktree=独立工作树（默认）；none=主工作区串行。请求隔离但建树失败会拒绝派单，不会退回主工作区',
        },
        continuesFrom: {
          type: 'string',
          description:
            '上一次派单的 childId：把它的终态作为不可信上下文重放进本次任务（不是真续聊，子 Agent 没有上次的内部状态）',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args, exec) {
        // TODO(P2-approval)：审批必须挂在这里，dispatcher.dispatch() 之前，见文件头第 5 条。
        // 第一版按要求不接审批：不调用 ctx.approval，也不假装已授权。

        // 0) 隔离方式只接受闭集；非法值直接拒绝，不交给下游猜
        if (
          args?.isolation !== undefined &&
          args.isolation !== 'none' &&
          args.isolation !== 'worktree'
        ) {
          return {
            ok: false,
            code: 'INVALID_ISOLATION',
            message: `isolation 必须是 none | worktree，收到 ${JSON.stringify(args.isolation)}`,
          }
        }

        // 1) 按当前会话的项目根取「全局 + 项目覆盖」的注册表
        const effective = await registryFor(exec)

        // 1.2) P0-B：TaskSpec / ContextPack 校验。只拒绝缺了就无法执行/验收的关键字段；
        //      纯 role+task 调用（structured=false）完全不受影响。
        const taskSpecResult = validateTaskSpec(args ?? {})
        if (taskSpecResult.ok !== true) {
          return {
            ok: false,
            code: taskSpecResult.code,
            message: taskSpecResult.message,
            fields: taskSpecResult.fields,
          }
        }

        // 1.5) 上下文重放：找不到/没就绪就如实失败，绝不静默退化成普通派单
        let continuation = null
        if (typeof args?.continuesFrom === 'string' && args.continuesFrom.trim()) {
          try {
            continuation = await resolveContinuation(args.continuesFrom.trim(), {
              loadRun: (childId) => resolveRun(exec, childId),
            })
          } catch (err) {
            const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'CONTINUATION_UNAVAILABLE'
            return {
              ok: false,
              code,
              message: err instanceof Error ? err.message : String(err),
            }
          }
        }

        // 2) 宿主执行上下文（exec.agent）随请求透传给适配器，作为 startActivation 的 parent；
        //    同时给出项目根，供适配器做 cwd 边界校验。
        const agent = exec && typeof exec === 'object' ? exec.agent : undefined
        const projectRoot = exec?.agent?.session?.header?.cwd

        const input = {
          role: args?.role,
          task: args?.task,
          ...(taskSpecResult.spec ? { taskSpec: taskSpecResult.spec } : {}),
          ...(taskSpecResult.contextPack ? { contextPack: taskSpecResult.contextPack } : {}),
          ...(typeof args?.cwd === 'string' ? { cwd: args.cwd } : {}),
          ...(args?.isolation ? { isolation: args.isolation } : {}),
          ...(continuation ? { continuation } : {}),
          // 并发计数按项目隔离：不传的话 dispatcher 会把所有项目算成 default（真机审计发现）。
          // 必须归一化：Windows 大小写不敏感、尾斜杠等价，否则 'D:/P' 与 'd:/p/' 会被当成两个项目而绕过串行。
          ...(normalizeProjectKey(projectRoot) ? { projectKey: normalizeProjectKey(projectRoot) } : {}),
          // 原始项目根：建工作树需要真实路径（projectKey 是归一化后的计数键，不能拿来建树）
          ...(typeof projectRoot === 'string' && projectRoot ? { projectRoot } : {}),
          registry: effective.registry,
          ...(agent || projectRoot
            ? { context: { ...(agent ? { agent } : {}), ...(projectRoot ? { projectRoot } : {}) } }
            : {}),
        }
        // 直接用 dispatcher 的返回（成功 { ok:true, taskRef, role, startedAt } /
        // 失败 { ok:false, code, message, ... }），不二次包装；
        // 成功回执只保留轻量字段（Token 审计 2026-11-11）：role 全量/prompt/工作树细节
        // 一律不返回，需要时用 meetingstone_list_runs 查。
        const result = await dispatcher.dispatch(input)
        let payload = result
        if (result?.ok === true) {
          const ref = result.taskRef && typeof result.taskRef === 'object' ? result.taskRef : {}
          /** @type {Record<string, unknown>} */
          const taskRef = {}
          for (const key of ['childId', 'name', 'provider', 'jobId']) {
            if (ref[key] !== undefined && ref[key] !== null) taskRef[key] = ref[key]
          }
          payload = {
            ok: true,
            taskRef,
            roleId: result.role?.roleId ?? null,
            roleName: result.role?.name ?? null,
            isolation: result.isolation ?? null,
          }
        }
        if (Array.isArray(effective.projectErrors) && effective.projectErrors.length > 0) {
          return { ...payload, projectErrors: effective.projectErrors }
        }
        return payload
      },
    },
    {
      name: TOOL_NAMES.LIST_RUNS,
      description:
        '列出当前项目最近的派单记录（新的在前）：title、childId、角色、通道、模型、状态、结构化结果摘要（resultStatus/summaryPreview）、' +
        '耗时、工作树路径/分支、改动文件（changedFiles）、原生 Job id（jobId）、同项目任务之间的 overlapWarnings 与 200 字预览。' +
        '数据来自 `.meetingstone/runs/`，DSH 重启后仍可查；上一个进程遗留的 running 会显示为 interrupted。' +
        '带工作树的记录不会被 100 条/30 天自动清理，用于保护未合并成果的元数据。',
      parameters: {
        limit: { type: 'number', description: '最多返回多少条（默认 20，上限 200）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args, exec) {
        if (typeof listPersistedRuns !== 'function') {
          return { runs: [], reason: '当前插件未启用派单记录' }
        }
        const limit = typeof args?.limit === 'number' ? args.limit : undefined
        return listPersistedRuns(exec, { limit })
      },
    },
    {
      name: TOOL_NAMES.GET_TASK,
      description:
        '按 childId 查询一次派发：status（running/completed/failed/cancelled/interrupted/unknown）、stopReason、resultBytes、jobId、recordPath、' +
        '工作树/改动文件/overlapWarnings。若结果带结构化 summary，默认只回 summary/resultStatus/openIssues/handoff 等字段（resultOmitted:true）；' +
        '否则回结果首 1KiB + 末 512B。需要原始全文时传 full:true，或用 meetingstone_get_run_artifact 按范围读取。' +
        '先查本进程内存（最近 20 条），终态再读项目内 `.meetingstone/runs/<childId>.json` 补隔离元数据；' +
        '上一个进程留下的 running 会投影为 interrupted。',
      parameters: {
        childId: { type: 'string', required: true, description: 'meetingstone_dispatch 返回的 taskRef.childId' },
        full: {
          type: 'boolean',
          description: 'true=返回完整结果文本（默认 false，只回首 1KiB + 末 512B 摘要）',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args, exec) {
        const childId = args?.childId
        if (typeof childId !== 'string' || !childId.trim()) {
          return { status: 'unknown', reason: '缺少 childId' }
        }
        const id = childId.trim()
        const full = args?.full === true
        if (typeof dispatcher.getTask !== 'function') {
          return { status: 'unknown', reason: '当前派单器不支持结果查询' }
        }
        const live = await dispatcher.getTask(id)
        // 只在内存确实不知道（unknown）时才查磁盘：running 必须以内存实时状态为准，
        // 否则会把磁盘里"派单瞬间写的 running"当成当前状态（字段形状也不一致）。
        if (live?.status === 'unknown') {
          const persisted = await loadPersistedRun?.(exec, id)
          if (persisted) {
            return taskResultView(withRecordPath(persisted, exec, id), full)
          }
        }
        // 终态：内存结果没有 worktree/changedFiles/overlapWarnings，用磁盘记录补齐。
        // 内存仍优先 status/output/诊断，磁盘只提供隔离元数据。
        if (
          live &&
          ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(live.status)) &&
          typeof loadPersistedRun === 'function'
        ) {
          const persisted = await loadPersistedRun(exec, id)
          if (persisted && persisted.status !== 'unknown') {
            const merged = {
              ...persisted,
              ...live,
              operationId: persisted.operationId ?? live.operationId ?? null,
              isolation: persisted.isolation ?? live.isolation ?? null,
              worktree: persisted.worktree ?? live.worktree ?? null,
              jobId: persisted.jobId ?? live.jobId ?? null,
              changedFiles: Array.isArray(persisted.changedFiles) ? persisted.changedFiles : null,
              changedFilesUnknown: persisted.changedFilesUnknown === true,
              changedFilesTruncated: persisted.changedFilesTruncated === true,
              changedFilesTotal:
                typeof persisted.changedFilesTotal === 'number'
                  ? persisted.changedFilesTotal
                  : Array.isArray(persisted.changedFiles)
                    ? persisted.changedFiles.length
                    : null,
              overlapWarnings: Array.isArray(persisted.overlapWarnings)
                ? persisted.overlapWarnings
                : [],
              stopConfirmed:
                typeof persisted.stopConfirmed === 'boolean'
                  ? persisted.stopConfirmed
                  : typeof live.stopConfirmed === 'boolean'
                    ? live.stopConfirmed
                    : null,
            }
            return taskResultView(withRecordPath(merged, exec, id), full)
          }
        }
        return taskResultView(withRecordPath(live, exec, id), full)
      },
    },
    {
      name: TOOL_NAMES.GET_RUN_ARTIFACT,
      description:
        '按需读取一次派发的完整结果（项目内 `.meetingstone/runs/<childId>.json`）。默认返回完整文本；' +
        '可用 headBytes/tailBytes 取首尾，或用 lineFrom/lineTo（1 起、含端点）取行范围。' +
        '找不到记录 → NOT_FOUND；记录损坏/非法 JSON → CORRUPT；参数冲突 → INVALID_RANGE。' +
        '这是 get_task 默认摘要之外的"取全文"通道，不会触发宿主任务查询。',
      parameters: {
        childId: {
          type: 'string',
          required: true,
          description: 'meetingstone_dispatch 返回的 taskRef.childId',
        },
        headBytes: {
          type: 'number',
          description: '保留开头字节数；与 tailBytes 一起决定读取窗口（默认全文）',
        },
        tailBytes: {
          type: 'number',
          description: '保留结尾字节数',
        },
        lineFrom: {
          type: 'number',
          description: '起始行（1 起，含）；不能与 headBytes/tailBytes 同时使用',
        },
        lineTo: {
          type: 'number',
          description: '结束行（含）；省略则读到末尾',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args, exec) {
        const childId = args?.childId
        if (typeof childId !== 'string' || !childId.trim()) {
          return { ok: false, code: 'NOT_FOUND', message: '缺少 childId' }
        }
        const id = childId.trim()
        const lineMode = args?.lineFrom !== undefined || args?.lineTo !== undefined
        const byteMode = args?.headBytes !== undefined || args?.tailBytes !== undefined
        if (lineMode && byteMode) {
          return {
            ok: false,
            code: 'INVALID_RANGE',
            message: 'lineFrom/lineTo 与 headBytes/tailBytes 不能同时使用',
          }
        }
        if (typeof loadPersistedRun !== 'function') {
          return { ok: false, code: 'UNAVAILABLE', message: '当前插件未启用派单记录' }
        }
        const record = await loadPersistedRun(exec, id)
        if (!record) {
          return { ok: false, code: 'NOT_FOUND', message: `没有该任务的落盘记录：${id}`, childId: id }
        }
        if (record.code === 'RUN_NOT_FOUND') {
          return { ok: false, code: 'NOT_FOUND', message: `没有该任务的落盘记录：${id}`, childId: id }
        }
        if (record.code === 'RUN_CORRUPT') {
          return {
            ok: false,
            code: 'CORRUPT',
            message: `记录文件不是合法 JSON：${id}`,
            childId: id,
          }
        }
        if (record.code === 'RUN_ID_INVALID') {
          return { ok: false, code: 'INVALID_CHILD_ID', message: `childId 不合法：${id}` }
        }
        if (record.code === 'RUN_TOO_LARGE') {
          return {
            ok: false,
            code: 'TOO_LARGE',
            message: `记录文件超过读取上限，拒绝读取：${id}`,
            childId: id,
          }
        }
        if (typeof record.code === 'string' && record.code.startsWith('RUN_')) {
          return {
            ok: false,
            code: 'READ_FAILED',
            message: `读取派单记录失败：${record.reason ?? record.code}`,
            childId: id,
          }
        }

        const text = typeof record.result === 'string' ? record.result : ''
        const totalBytes = Buffer.byteLength(text, 'utf8')
        /** @param {unknown} value */
        const asCount = (value) =>
          typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
        /** @param {unknown} value */
        const asLine = (value) =>
          typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null

        /** @type {{ mode: string, lineFrom?: number, lineTo?: number, lineTotal?: number, headBytes?: number, tailBytes?: number }} */
        let range = { mode: 'full' }
        let content = text
        let truncated = false

        if (lineMode) {
          const lines = text === '' ? [] : text.split('\n')
          const lineTotal = lines.length
          const from = args?.lineFrom === undefined ? 1 : asLine(args.lineFrom)
          const to = args?.lineTo === undefined ? lineTotal : asLine(args.lineTo)
          if (from === null || to === null || to < from) {
            return {
              ok: false,
              code: 'INVALID_RANGE',
              message: 'lineFrom / lineTo 必须是正整数，且 lineTo >= lineFrom',
            }
          }
          content = from > lineTotal ? '' : lines.slice(from - 1, Math.min(to, lineTotal)).join('\n')
          truncated = from > 1 || to < lineTotal
          range = { mode: 'lines', lineFrom: from, lineTo: to, lineTotal }
        } else if (byteMode) {
          const head = args?.headBytes === undefined ? 0 : asCount(args.headBytes)
          const tail = args?.tailBytes === undefined ? 0 : asCount(args.tailBytes)
          if (head === null || tail === null || head + tail === 0) {
            return {
              ok: false,
              code: 'INVALID_RANGE',
              message: 'headBytes / tailBytes 必须是非负整数，且至少有一个大于 0',
            }
          }
          const cut = truncateUtf8(text, head + tail, { headBytes: head, tailBytes: tail })
          content = cut.text
          truncated = cut.truncated
          range = { mode: 'bytes', headBytes: head, tailBytes: tail }
        }

        const withPath = withRecordPath(record, exec, id)
        return {
          ok: true,
          childId: id,
          status: typeof record.status === 'string' ? record.status : 'unknown',
          ...(typeof record.resultStatus === 'string' ? { resultStatus: record.resultStatus } : {}),
          resultBytes: totalBytes,
          bytes: Buffer.byteLength(content, 'utf8'),
          truncated,
          range,
          content,
          ...(record.resultTruncated === true ? { recordResultTruncated: true } : {}),
          ...(typeof withPath.recordPath === 'string' && withPath.recordPath
            ? { recordPath: withPath.recordPath }
            : {}),
        }
      },
    },
    {
      name: TOOL_NAMES.CANCEL_TASK,
      description:
        '按 childId 取消一次派发（中止 + 释放宿主 activation）。若该任务有原生 Job，优先走 Job 的 cancel（Jobs 面板与本工具停止路径一致），' +
        '否则走适配器原路径。只有确认停止（stopConfirmed:true）才释放并发槽位；' +
        'dispose 超时/失败时槽位保留，等任务结果落定后自动释放。重复调用无害。',
      parameters: {
        childId: { type: 'string', required: true, description: 'meetingstone_dispatch 返回的 taskRef.childId' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args) {
        const childId = args?.childId
        if (typeof childId !== 'string' || !childId.trim()) {
          return { ok: false, code: 'INVALID_CHILD_ID', message: '缺少 childId' }
        }
        const id = childId.trim()
        const outcome = await dispatcher.cancel(id)
        const stopConfirmed = outcome?.stopConfirmed === true
        return {
          ok: true,
          childId: id,
          // cancelled 只表示「已确认停止」；未确认时槽位仍被保留，必须如实说明
          cancelled: stopConfirmed,
          stopConfirmed,
          ...(!stopConfirmed && outcome?.reason ? { reason: outcome.reason } : {}),
        }
      },
    },
    {
      name: TOOL_NAMES.CLI_STATUS,
      description:
        '查询本机 codex / codebuddy / claude 是否安装、路径、版本与探测来源；只做状态展示，不返回余额、不推断认证状态。',
      parameters: {
        cli: { type: 'string', description: 'codex | codebuddy | claude；省略则查全部' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args) {
        const cli = args?.cli
        if (cli !== undefined && cli !== null && !CLI_STATUS_CLIS.includes(cli)) {
          return { error: 'UNKNOWN_CLI', message: `未知 CLI：${String(cli)}` }
        }
        // 失败关闭：探测器没注入或形状不对，就如实报错，不编造状态。
        if (!probe || typeof probe.probe !== 'function' || typeof probe.probeAll !== 'function') {
          return { error: 'PROBE_UNAVAILABLE', message: 'CLI 探测器未注入，不编造 CLI 状态' }
        }
        const results = cli ? [await probe.probe(cli)] : await probe.probeAll()
        return { clis: (Array.isArray(results) ? results : []).map(toCliView) }
      },
    },
  ]

  for (const tool of tools) {
    // 注册即 effect：卸载时框架自动注销（文件头第 2 条），无需手工 unregister。
    const definition = defineTool(tool)
    // 交出前最后一道闸：坏 schema 宁可让本插件加载失败，也不能污染全局工具集。
    assertHostReadySchema(definition)
    ctx.tools.register(definition)
  }
  return /** @type {Array<{ name: string }>} */ (tools)
}

export default registerTools
