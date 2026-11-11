// @ts-check
/**
 * 插件配置 schema（零依赖，见 src/schema.js 的原因说明）。
 *
 * 约定（来自阶段 0 审计）：
 * - 配置持久化在 profile 的 `cordis.patch.yml`，行 id = `meetingstone`
 * - patch 是**整值替换**，不是深合并：用户覆盖时要把整个 config 写全
 * - 第一版**不做 UI**；没有 `.volatile()` 热编辑
 *
 * 设计取舍：这里只声明「形状 + 默认值」，**语义校验（别名冲突、模型一致性）
 * 放在 src/roles/registry.js 与 src/dsh/adapter.js**，那些规则需要被单测覆盖。
 *
 * 本项目**不提供只读通道**：宿主 subagent spec 没有权限字段，做不到绝对只读，
 * 所以配置里没有 permissionPreset，也不要再实现（2026-11-11 用户决策）。
 */
import { S, ValidationError, compile } from './schema.js'
import { CLI_NAMES, sanitizeCliPreferences } from './cli/preferences.js'

/** 通道类型。见 docs/开发计划.md §3.4。 */
export const CHANNEL_KINDS = /** @type {const} */ ([
  'in-process',
  'acp-cli',
  'codex',
  'claude-code',
])

export { ValidationError }

/**
 * 一个「通道实例」：一行 provider 配置。
 *
 * 为什么需要它（DD7，2026-11-10 定）：
 * 官方子任务启动 spec 没有 model / reasoning 字段，这两样只能在 **provider 行**上配。
 * 角色只能**引用**一个实例并声明期望，由派单层校验一致性——不一致就拒绝，避免"配置成功、执行没采用"。
 */
export const ChannelInstanceSchema = compile(
  S.object({
    channelId: S.string().required().description('通道实例 ID，如 ch-codex-dev'),
    description: S.string().default('').description('人类可读说明'),
    kind: S.union([...CHANNEL_KINDS]).default('in-process').description('执行通道类型'),
    provider: S.string().description('对应的 provider 名（acp / codex / claude-code / spawn ...）'),
    model: S.string().description('该 provider 行实际配置的模型（用于与角色声明比对）'),
    reasoning: S.string().description('该 provider 行实际配置的思考强度'),
  }),
)

/** 角色上的执行通道引用。 */
export const ChannelSchema = compile(
  S.object({
    kind: S.union([...CHANNEL_KINDS])
      .default('in-process')
      .description(
        '执行通道：in-process=DSH 原生子 Agent；acp-cli=配 command 驱动任意 ACP CLI；codex/claude-code=官方 provider',
      ),
    channelId: S.string().description('引用 channels 表里的通道实例 ID（推荐；模型由实例承载）'),
    provider: S.string().description('通道需要的 provider 名，如 acp / codex / claude-code / spawn'),
    cli: S.string().description('本机平台标识（仅用于展示与探测，不代表实际执行路径）'),
    model: S.string().description('声明的模型 ID；必须与所引用的通道实例一致，否则派单被拒'),
    reasoning: S.string().description('声明的思考强度；同样要与通道实例一致'),
  }),
)

/**
 * 自动角色路由规则（P1-B）。默认规则表在 `src/dispatch/routing.js`；
 * 这里只声明「形状 + 默认值」，语义（关键词匹配、可用性过滤）同样在 routing.js。
 */
export const RoutingRuleSchema = compile(
  S.object({
    taskType: S.string().required().description('任务类型标识，如 review / edit / research / architecture'),
    label: S.string().default('').description('人类可读类型名，写进路由 reason'),
    keywords: S.array(S.string()).default([]).description('判定任务类型的关键词'),
    roleKeywords: S.array(S.string()).default([]).description('匹配角色 roleId/name/aliases/description 的关键词'),
    roleIds: S.array(S.string()).default([]).description('直接指定角色 ID（优先于 roleKeywords）'),
  }),
)

/** 角色定义。语义校验见 registry.js。 */
export const RoleSchema = compile(
  S.object({
    roleId: S.string().required().description('稳定 ID，如 role-sashi；改名不变'),
    name: S.string().required().description('显示名称'),
    aliases: S.array(S.string()).default([]).description('简称/别名，全局唯一'),
    description: S.string().default('').description('职责说明（人类可读）'),
    prompt: S.string().description('角色人设/工作守则；派单时作为前缀注入子 Agent 的提示词'),
    channel: ChannelSchema,
    enabled: S.boolean().default(true).description('停用后不得派单'),
    fallbackRoleId: S.string().description('备用角色（第一版只提示，不自动接替）'),
    timeoutMs: S.number().default(30 * 60 * 1000).description('单次派单超时'),
  }),
)

/**
 * 外部 CLI 的显式用户偏好（P0-S2）。
 *
 * - 键缺失 = `unset`（不是关闭）
 * - `true` = 用户显式开启（仍需 preflight 通过才生效）
 * - `false` = 用户显式关闭（持久化，重启/升级保持）
 *
 * 值只接受布尔；未知键忽略（向前兼容）。语义详见 `src/cli/preferences.js`
 * 与 docs/configuration.md §1.3。
 */
const cliPreferencesSpec = S.object(
  Object.fromEntries(
    CLI_NAMES.map((cli) => [
      cli,
      S.boolean().description(`${cli}：true=显式开启，false=显式关闭，缺省=unset`),
    ]),
  ),
)

/** 编译后的 `cliPreferences`（测试可直接用；嵌套到 Config 时用 spec 带描述）。 */
export const CliPreferencesSchema = compile(cliPreferencesSpec)

/** 插件配置根。 */
export const Config = compile(
  S.object({
    roles: S.array(RoleSchema).default([]).description('全局角色表'),
    channels: S.array(ChannelInstanceSchema)
      .default([])
      .description('通道实例表：一行 = 一个已配置的 provider（模型/强度写在这里）'),
    defaultRoleId: S.string().description('仅 autoRoute 实验路由的兜底角色；未指定 role 且未开 autoRoute 时会明确报错'),
    routingRules: S.array(RoutingRuleSchema)
      .default([])
      .description('自动路由规则表（空 = 用内置规则；仅 autoRoute:true 且未显式指定 role 时生效）'),
    cliPreferences: cliPreferencesSpec.description(
      '外部 CLI 显式偏好：true=开启、false=关闭、缺省=unset（首次 preflight 通过才视为启用）',
    ),
    dispatchNotes: S.string().default('').description('辅助调度提示，不改变通道与并发规则'),
    projectConfigFile: S.string()
      .default('.meetingstone.json')
      .description('项目级配置文件（相对项目根）'),
    limits: S.object({
      serializeWrites: S.boolean()
        .default(true)
        .description(
          'defaultIsolation=none 时同项目任务串行；这是同一工作区的正确性保护，不是并发额度',
        ),
      maxParallelWritesTotal: S.number()
        .default(4)
        .description(
          '本插件派发的并行写任务总上限（默认 4；不含宿主自身的子 Agent，宿主容量由宿主管理）',
        ),
      defaultIsolation: S.union(['none', 'worktree'])
        .default('worktree')
        .description('默认隔离方式：worktree=每任务独立工作树；none=主工作区串行'),
    }).default({
      serializeWrites: true,
      maxParallelWritesTotal: 4,
      defaultIsolation: 'worktree',
    }),
  }),
)

/** @param {unknown} value */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 把用户给的原始配置规范化成安全值。
 * - 缺字段回退默认值
 * - 非法值抛 `ValidationError`（上层决定降级策略）
 *
 * 例外：`cliPreferences` 先做**容错清洗**。一个手写错的 CLI 偏好（比如把
 * `false` 写成 `"false"`）不应该让整个角色表一起回落到默认值；非法项按
 * unset 丢弃，其余配置照常校验。
 *
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? { .../** @type {Record<string, unknown>} */ (raw) } : {}
  if (Object.hasOwn(input, 'cliPreferences')) {
    const sanitized = sanitizeCliPreferences(input.cliPreferences)
    if (sanitized === undefined) delete input.cliPreferences
    else input.cliPreferences = sanitized
  }
  return Config(input)
}

export default Config
