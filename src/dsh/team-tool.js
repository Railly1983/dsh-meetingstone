// @ts-check
/**
 * `spawn_teammate_as` 工具：按角色创建 Agent Teams teammate。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────────
 * `src/dsh/register.js` 已注册 8 个工具，契约被 `verify-host-schema` 与多份测试锁死。
 * 本工具是**可选能力**（依赖宿主开启 Agent Teams），放进 register.js 会让
 * 未启用 Team 的 profile 也去注册一个用不了的工具。故独立成模块，由入口按需接线。
 *
 * ── 为什么不叫 `spawn_teammate` ─────────────────────────────────────────────
 * 宿主 `dsh-tools` 在同一 Agent scope 内同名注册会抛
 * `tool "<name>" is already registered in this scope`。
 * 官方 `spawn_teammate` 由 `@deepseek-ai/dsh-experimental-tool-agent-team` 注册，
 * 我们**无法覆盖**，只能新增。好处是官方工具原样保留，没有行为差异风险。
 *
 * ── 工具做什么 ─────────────────────────────────────────────────────────────
 * 1. `role` 解析成本插件角色配置 → 通道 `llmProvider` / `llmModel` / `reasoning`
 * 2. 调官方 `ctx.agentTeams.spawnTeammate()` 建成员（复用宿主 roster / journal / UI）
 * 3. 立刻对该 teammate 调 `agent.model.select(...)` 切到目标路由
 *    （宿主唯一认可的方式；详见 `team-roles.js` 头部关于 `agent/request` 的说明）
 * 4. 回执里如实报告：实际用了什么路由、走的哪条写入路径、以及任何降级原因
 *
 * ── 失败语义 ───────────────────────────────────────────────────────────────
 * - 角色/通道解析失败 → **不建成员**，直接返回错误（避免建出一个跑错模型的成员）
 * - 成员建成但路由写入失败 → **保留成员**，回执明确标 `modelApplied: false` + 原因。
 *   不自动删成员：宿主没有 `removeMember`，成员名一经占用永久不可复用，
 *   删不掉反而更糟；如实报告让调用方自己决定怎么用。
 */

import { resolveSelection, selectAgentModel, memberNameForRole, isMemberName } from './team-roles.js'

/** 工具的模型面声明。`output.schema` 必须 object 根 + additionalProperties。 */
const TEAMMATE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    name: { type: 'string' },
    role: { type: 'string' },
    childId: { type: 'string' },
    model: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
        applied: { type: 'boolean' },
        via: { type: 'string' },
      },
      additionalProperties: true,
    },
    note: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
}

/**
 * 把 `output.schema` 渲染成模型可见的文本。与 register.js 的 render 约定一致。
 * @param {any} _args
 * @param {any} value
 */
function renderTeammateOutput(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * 注册 `spawn_teammate_as`。
 *
 * @param {object} ctx 宿主 Context（需 `ctx.tools.register`）
 * @param {object} deps
 * @param {object} deps.registry 角色注册表 `list(): Role[]`
 * @param {(spec: object) => object} [deps.defineTool] 宿主真实 defineTool（不注入则降级）
 * @param {(name: string) => any} [deps.findChannel] 通道实例查找（可选）
 * @returns {{ name: string } | null} 注册成功返回工具名；宿主无 Team 能力时返回 null（不报错）
 */
export function registerTeamRoleTool(ctx, deps) {
  const { registry, defineTool, findChannel } = deps ?? {}
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') return null
  // 只有宿主装了 Agent Teams 才有 agentTeams 服务；没有就静默跳过（不是错误）。
  if (!ctx.agentTeams || typeof ctx.agentTeams.spawnTeammate !== 'function') return null
  if (!registry || typeof registry.list !== 'function') return null

  const spec = {
    name: 'spawn_teammate_as',
    description:
      '按角色创建一个 Team teammate，并把它切到该角色配置的模型。' +
      '与内置 spawn_teammate 的区别：多一个 role 参数，会把 teammate 钉在角色绑定的 provider/model 上，' +
      '而不是继承当前会话的模型。role 可以写中文角色名（如「沙僧」）或拼音（如 shaseng）；' +
      'name 必须是 lower-kebab-case。只有 Lead 能创建 teammate。' +
      '若角色绑定的是外部 CLI 通道（如 codebuddy/codex），会拒绝并说明原因 —— ' +
      'teammate 跑在宿主进程内，不能挂外部 CLI 子进程。',
    parameters: {
      role: {
        type: 'string',
        required: true,
        description: '角色名（中文如「沙僧」，或拼音如 shaseng）。决定 teammate 跑哪个模型。',
      },
      description: {
        type: 'string',
        required: true,
        description: '短描述（3-5 个词），用于面板显示。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'teammate 的完整初始任务。它看不到当前对话，必须自包含。',
      },
      name: {
        type: 'string',
        description: '成员名（lower-kebab-case，≤64 字符）。省略则由 role 推导。',
      },
      context: {
        type: 'string',
        enum: ['fresh', 'fork'],
        description: 'fresh 不带 Lead 历史；fork 继承已完成的 Lead 轮次。默认 fresh。',
      },
    },
    output: { schema: TEAMMATE_OUTPUT_SCHEMA, render: renderTeammateOutput },
    /**
     * @param {any} args
     * @param {any} exec
     */
    async execute(args, exec) {
      const roleInput = typeof args?.role === 'string' ? args.role.trim() : ''
      if (!roleInput) {
        return { ok: false, error: 'ROLE_REQUIRED: 必须给 role' }
      }

      // 1) 解析角色
      const roles = registry.list()
      const wanted = roleInput.toLowerCase()
      const role =
        roles.find(
          (candidate) =>
            String(candidate.roleId ?? '').toLowerCase() === wanted ||
            String(candidate.name ?? '') === roleInput ||
            (Array.isArray(candidate.aliases) &&
              candidate.aliases.some((alias) => String(alias).toLowerCase() === wanted)),
        ) ?? null
      if (!role) {
        const known = roles.map((r) => `${r.name}(${r.roleId})`).join('、')
        return { ok: false, error: `ROLE_NOT_FOUND: 找不到角色「${roleInput}」。可用角色：${known || '（无）'}` }
      }

      // 2) 解析该角色的执行通道与模型路由
      const instance = typeof findChannel === 'function' ? findChannel(role) : undefined
      const { selection, reason } = resolveSelection(role, instance)
      if (!selection) {
        return {
          ok: false,
          role: role.name,
          error: `NO_ROUTE: ${reason}`,
        }
      }

      // 3) 成员名
      const explicitName = typeof args?.name === 'string' ? args.name.trim() : ''
      const name = explicitName || memberNameForRole(role.name) || memberNameForRole(role.roleId)
      if (!isMemberName(name)) {
        return {
          ok: false,
          role: role.name,
          error: `INVALID_NAME: 「${name}」不是合法的 lower-kebab-case 成员名（≤64 字符，非 lead）。请用 name 参数显式指定。`,
        }
      }

      // 4) 建成员（复用官方 roster / journal / UI）
      const parent = exec?.agent
      if (!parent) return { ok: false, error: 'NO_AGENT: 拿不到调用方 Agent' }
      let member
      try {
        const spawned = await ctx.agentTeams.spawnTeammate(parent, {
          name,
          description: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          context: args.context ?? 'fresh',
          provider: 'spawn',
          signal: exec?.signal,
        })
        member = spawned?.member ?? spawned
      } catch (error) {
        return { ok: false, role: role.name, error: `SPAWN_FAILED: ${error?.message ?? String(error)}` }
      }
      const childId = member?.id ?? member?.childId ?? ''
      if (!childId) {
        return { ok: false, role: role.name, name, error: 'SPAWN_FAILED: 宿主没有返回 teammate id' }
      }

      // 5) 立刻切路由（必须在首轮请求之前）
      //    spawnTeammate 内部会 checkpointInitialPrompt，teammate 可能已经开始跑；
      //    因此这里尽快取 agent 并 select。拿不到 agent 就如实报告降级。
      const base = { ok: true, name: member?.name ?? name, role: role.name, childId }
      const agent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(childId) : undefined
      if (!agent) {
        return {
          ...base,
          model: { ...selection, applied: false },
          note: '成员已创建，但拿不到它的 Agent（可能还在 provisioning）。路由未切换，将继承当前会话模型。',
        }
      }
      const applied = selectAgentModel(agent, selection)
      if (!applied.ok) {
        return {
          ...base,
          model: { ...selection, applied: false },
          note: `成员已创建，但路由切换失败：${applied.reason}。该成员会继承当前会话模型。`,
        }
      }
      return {
        ...base,
        model: { ...selection, applied: true, via: applied.via },
        note: `已创建并钉在 ${selection.provider}/${selection.model}`,
      }
    },
  }

  const definition = typeof defineTool === 'function' ? defineTool(spec) : spec
  ctx.tools.register(definition)
  return { name: spec.name }
}
