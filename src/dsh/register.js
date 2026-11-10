// @ts-check
/**
 * DSH 接线层 · 工具注册（阶段 2，第一版只注册三个工具，别多加）。
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
 *   触发 DeepSeek `Invalid schema ... readOnly is not of type "boolean"`），
 *   改用下面的 compileToolSpec 做等价编译；该降级路径不含运行时 args 校验。
 *   另：官方 defineTool 要求 object 根显式声明 `additionalProperties`，
 *   故三个 `output.schema` 都带 `additionalProperties: true`。
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
import { resolveContinuation } from '../context-replay.js'

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
  CANCEL_TASK: 'meetingstone_cancel_task',
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
 * 为什么必须编译：未编译的字典把 `readOnly` 等字段名暴露在 JSON Schema 根上；
 * `readOnly` 是 JSON Schema 保留注解（值必须是 boolean），DeepSeek API 校验直接报
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
 * 角色 → 对外视图。只挑契约要求的字段，外加两个「如实标注」的派生字段。
 * @param {object} role
 * @param {object} ctx
 */
function toRoleView(role, ctx) {
  return {
    roleId: role.roleId,
    name: role.name,
    aliases: Array.isArray(role.aliases) ? [...role.aliases] : [],
    channel: { ...role.channel },
    permissionPreset: role.permissionPreset,
    enabled: role.enabled !== false,
    availability: availabilityOf(role, ctx),
    // 配置透明性：不返回 prompt 全文（可能很长），只给"有没有人设"和摘要
    description: typeof role.description === 'string' ? role.description : '',
    hasPrompt: typeof role.prompt === 'string' && role.prompt.trim() !== '',
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

/**
 * 注册三个工具。
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
  const { registry, dispatcher, probe, loadPersistedRun } = deps ?? {}

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
        '列出集合石已配置的角色（roleId/名称/别名/通道/权限档位/启用状态/可用性/来源/职责说明/是否配置人设）与注册表的错误；不派单、不探测本机 CLI。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(_args, exec) {
        const effective = await registryFor(exec)
        const roles = effective.registry
          .list()
          .map((/** @type {object} */ role) => toRoleView(role, ctx))
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
        '按角色把一次任务派发给宿主 provider。只读无法强制时会在 taskRef.readOnlyEnforced 明确标记 false；不会假装只读生效。',
      parameters: {
        role: { type: 'string', required: true, description: '角色名、别名或 roleId' },
        task: { type: 'string', required: true, description: '任务内容' },
        cwd: { type: 'string', description: '目标目录；调用方须先校验在项目内' },
        readOnly: { type: 'boolean', description: '只收紧、不放宽；无法强制时会明确标记' },
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

        // 1) 按当前会话的项目根取「全局 + 项目覆盖」的注册表
        const effective = await registryFor(exec)

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
          ...(typeof args?.cwd === 'string' ? { cwd: args.cwd } : {}),
          ...(typeof args?.readOnly === 'boolean' ? { readOnly: args.readOnly } : {}),
          ...(continuation ? { continuation } : {}),
          // 并发计数按项目隔离：不传的话 dispatcher 会把所有项目算成 default（真机审计发现）
          ...(typeof projectRoot === 'string' && projectRoot ? { projectKey: projectRoot } : {}),
          registry: effective.registry,
          ...(agent || projectRoot
            ? { context: { ...(agent ? { agent } : {}), ...(projectRoot ? { projectRoot } : {}) } }
            : {}),
        }
        // 直接用 dispatcher 的返回（成功 { ok:true, taskRef, role, readOnly, ... } /
        // 失败 { ok:false, code, message, ... }），不二次包装；
        // 唯一附加字段是项目配置的解析错误，避免"配置有错但悄悄忽略"。
        const result = await dispatcher.dispatch(input)
        if (Array.isArray(effective.projectErrors) && effective.projectErrors.length > 0) {
          return { ...result, projectErrors: effective.projectErrors }
        }
        return result
      },
    },
    {
      name: TOOL_NAMES.GET_TASK,
      description:
        '按 childId 查询一次派发的结果：status（running/completed/failed/cancelled/unknown）、输出文本、停止原因。' +
        '先查本进程内存（最近 20 条），查不到再读项目内 `.meetingstone/runs/<childId>.json`，因此 DSH 重启后仍可查到终态。',
      parameters: {
        childId: { type: 'string', required: true, description: 'meetingstone_dispatch 返回的 taskRef.childId' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args, exec) {
        const childId = args?.childId
        if (typeof childId !== 'string' || !childId.trim()) {
          return { status: 'unknown', reason: '缺少 childId' }
        }
        const id = childId.trim()
        if (typeof dispatcher.getTask !== 'function') {
          return { status: 'unknown', reason: '当前派单器不支持结果查询' }
        }
        const live = await dispatcher.getTask(id)
        // 内存里是 running/unknown 时才去磁盘找终态（内存已完成就直接返回，避免多读一次文件）
        if (live?.status === 'running' || live?.status === 'unknown') {
          const persisted = await loadPersistedRun?.(exec, id)
          if (persisted) return persisted
        }
        return live
      },
    },
    {
      name: TOOL_NAMES.CANCEL_TASK,
      description:
        '按 childId 取消一次派发（中止 + 释放宿主 activation），并释放并发槽位。重复调用无害。',
      parameters: {
        childId: { type: 'string', required: true, description: 'meetingstone_dispatch 返回的 taskRef.childId' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderObject },
      async execute(args) {
        const childId = args?.childId
        if (typeof childId !== 'string' || !childId.trim()) {
          return { ok: false, code: 'INVALID_CHILD_ID', message: '缺少 childId' }
        }
        await dispatcher.cancel(childId.trim())
        return { ok: true, childId: childId.trim(), cancelled: true }
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
