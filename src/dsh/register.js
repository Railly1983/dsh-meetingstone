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
 * TODO(P2-defineTool): 生产应由插件入口（src/index.js，并行工作面）注入
 *   `@deepseek-ai/dsh-tools` 的真实 `defineTool` 作为 `deps.defineTool`，以获得
 *   args 推断/校验与 canonical 值校验。本模块**不静态 import 宿主包**：本地测试环境
 *   只装了 `@deepseek-ai/schemastery`，静态 import 会让 `node --test` 直接失败，
 *   且 registerTools 要用假 ctx 单测。未注入时退化为「把 spec 原样交给
 *   ctx.tools.register」——工具定义形状仍是官方 ToolDefinition 形状，但**参数校验不生效**，
 *   属未验证的降级路径，必须在真机联调前补上注入。
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

/**
 * 插件模块级 inject：等待工具注册表就绪。
 * 出处 `docs/user/develop/basic/tool.md`；TODO(P2-inject) 见文件头。
 */
export const inject = Object.freeze(['tools'])

/** 工具名集中定义，便于测试与后续引用。 */
export const TOOL_NAMES = Object.freeze({
  LIST_ROLES: 'meetingstone_list_roles',
  DISPATCH: 'meetingstone_dispatch',
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
    // TODO(P2-roles-source)：registry 未暴露来源，标 unknown，不编造。
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
  const subagents = ctx?.subagents
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
  const { registry, dispatcher, probe } = deps ?? {}
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('TOOLS_UNAVAILABLE: ctx.tools.register 不可用')
  }
  if (!registry || typeof registry.list !== 'function') {
    throw new Error('REGISTRY_UNAVAILABLE: deps.registry.list 不可用')
  }
  if (!dispatcher || typeof dispatcher.dispatch !== 'function') {
    throw new Error('DISPATCHER_UNAVAILABLE: deps.dispatcher.dispatch 不可用')
  }

  // 未注入时是明确标注的降级路径（见文件头 TODO(P2-defineTool)），不是伪造的宿主 API。
  const defineTool =
    typeof deps.defineTool === 'function' ? deps.defineTool : (/** @type {object} */ spec) => spec

  /** @type {Array<object>} */
  const tools = [
    {
      name: TOOL_NAMES.LIST_ROLES,
      description:
        '列出集合石已配置的角色（roleId/名称/别名/通道/权限档位/启用状态/可用性/来源）与注册表的错误；不派单、不探测本机 CLI。',
      parameters: {},
      output: { schema: { type: 'object' }, render: renderObject },
      async execute() {
        const roles = registry.list().map((/** @type {object} */ role) => toRoleView(role, ctx))
        const errors = Array.isArray(registry.errors) ? [...registry.errors] : []
        return { roles, errors }
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
      },
      output: { schema: { type: 'object' }, render: renderObject },
      async execute(args, exec) {
        // TODO(P2-approval)：审批必须挂在这里，dispatcher.dispatch() 之前，见文件头第 5 条。
        // 第一版按要求不接审批：不调用 ctx.approval，也不假装已授权。

        // 把宿主执行上下文交给上层（适配器需要 exec.agent 作为 startActivation 的 parent）。
        // deps.onExecute 是可选钩子：不注入时不产生任何副作用，保持可测。
        if (typeof deps?.onExecute === 'function') deps.onExecute(exec)

        const input = {
          role: args?.role,
          task: args?.task,
          ...(typeof args?.cwd === 'string' ? { cwd: args.cwd } : {}),
          ...(typeof args?.readOnly === 'boolean' ? { readOnly: args.readOnly } : {}),
          ...(exec && typeof exec === 'object' ? { context: { agent: exec.agent } } : {}),
        }
        // 直接用 dispatcher 的返回（成功 { ok:true, taskRef, role, readOnly, ... } /
        // 失败 { ok:false, code, message, ... }），不二次包装。
        return dispatcher.dispatch(input)
      },
    },
    {
      name: TOOL_NAMES.CLI_STATUS,
      description:
        '查询本机 codex / codebuddy / claude 是否安装、路径、版本与探测来源；只做状态展示，不返回余额、不推断认证状态。',
      parameters: {
        cli: { type: 'string', description: 'codex | codebuddy | claude；省略则查全部' },
      },
      output: { schema: { type: 'object' }, render: renderObject },
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
    ctx.tools.register(defineTool(tool))
  }
  return /** @type {Array<{ name: string }>} */ (tools)
}

export default registerTools
