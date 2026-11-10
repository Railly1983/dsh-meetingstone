// @ts-check
/**
 * 插件配置 schema（Schemastery）。
 *
 * 约定（来自阶段 0 审计）：
 * - 配置持久化在 profile 的 `cordis.patch.yml`，行 id = `meetingstone`
 * - patch 是**整值替换**，不是深合并：用户覆盖时要把整个 config 写全
 * - 第一版**不做 UI**，字段不加 `.volatile()`；需要热编辑时再加
 * - `engines.dsh` 已在 package.json 声明，schema 只负责字段形状
 *
 * 设计取舍：这里只声明「形状 + 默认值」，**语义校验（别名冲突、权限放宽）放在
 * src/roles/registry.js**，因为那些规则需要在纯函数里被单测覆盖。
 */
import Schema from '@deepseek-ai/schemastery'

// 语义常量以 roles/registry.js 为唯一来源，避免两处枚举漂移。
import { CHANNEL_KINDS, PERMISSION_PRESETS } from './roles/registry.js'

export { CHANNEL_KINDS, PERMISSION_PRESETS }

/**
 * 一个角色的执行通道。
 * 注意：官方 provider 不解析本机 PATH 的 codex/claude（P0-03 F2），
 * 所以 `cli` 只是「用户以为的通道」，真实执行由 `provider` 决定。
 */
export const ChannelSchema = Schema.object({
  kind: Schema.union([...CHANNEL_KINDS]).default('in-process').description(
    '执行通道：in-process=DSH 原生子 Agent；acp-cli=配 command 驱动任意 ACP CLI；codex/claude-code=官方 provider',
  ),
  channelId: Schema.string().description('引用 channels 表里的通道实例 ID（推荐；模型由该实例承载）'),
  provider: Schema.string().description('通道需要的 provider 名，如 acp / codex / claude-code'),
  cli: Schema.string().description('本机平台标识（仅用于展示与探测，不代表实际执行路径）'),
  model: Schema.string().description('声明的模型 ID；必须与所引用的通道实例一致，否则派单被拒'),
  reasoning: Schema.string().description('声明的思考强度；同样要与通道实例一致'),
})

/**
 * 一个「通道实例」：一行 provider 配置。
 *
 * 为什么需要它（DD7，2026-11-10 定）：
 * 官方 `SubagentActivationSpec` 没有 model / reasoning 字段，模型只能在**provider 行**上配置
 * （例如 acp 的 `command` 带 `--model`）。角色不能凭空指定模型，只能**引用**一个实例并声明期望，
 * 由派单层校验「角色声明 == 通道实例配置」——不一致就拒绝，避免"配置成功、执行没采用"。
 */
export const ChannelInstanceSchema = Schema.object({
  channelId: Schema.string().required().description('通道实例 ID，如 ch-codex-dev'),
  description: Schema.string().default('').description('人类可读说明'),
  kind: Schema.union([...CHANNEL_KINDS]).default('in-process').description('执行通道类型'),
  provider: Schema.string().description('对应的 provider 名（acp / codex / claude-code / spawn ...）'),
  model: Schema.string().description('该 provider 行实际配置的模型（用于与角色声明比对）'),
  reasoning: Schema.string().description('该 provider 行实际配置的思考强度'),
  permissionPreset: Schema.union([...PERMISSION_PRESETS])
    .default('read-only')
    .description('该 provider 行实际强制的权限档位；只读角色必须引用 read-only 的实例'),
})

/** 角色定义。语义校验见 registry.js。 */
export const RoleSchema = Schema.object({
  roleId: Schema.string().required().description('稳定 ID，如 role-sashi；改名不变'),
  name: Schema.string().required().description('显示名称'),
  aliases: Schema.array(Schema.string()).default([]).description('简称/别名，全局唯一'),
  description: Schema.string().default('').description('职责说明，作为提示词前缀'),
  channel: ChannelSchema,
  permissionPreset: Schema.union([...PERMISSION_PRESETS])
    .default('read-only')
    .description('权限档位；项目覆盖只能收紧不能放宽'),
  enabled: Schema.boolean().default(true).description('停用后不得派单'),
  fallbackRoleId: Schema.string().description('备用角色（第一版只提示，不自动接替）'),
  timeoutMs: Schema.number().default(30 * 60 * 1000).description('单次派单超时'),
})

/** 插件配置根。 */
export const Config = Schema.object({
  roles: Schema.array(RoleSchema).default([]).description('全局角色表'),
  channels: Schema.array(ChannelInstanceSchema).default([]).description(
    '通道实例表：一行 = 一个已配置的 provider（模型/强度写在这里，因为宿主的启动 spec 不收它们）',
  ),
  defaultRoleId: Schema.string().description('未指定角色时的默认角色'),
  dispatchNotes: Schema.string().default('').description('辅助调度提示，不覆盖权限规则'),
  projectConfigFile: Schema.string()
    .default('.meetingstone.json')
    .description('项目级配置文件（相对项目根）'),
  limits: Schema.object({
    maxParallelReadonly: Schema.number().default(3).description('只读任务并发上限'),
    serializeWrites: Schema.boolean().default(true).description('同项目写任务串行'),
  }).default({}),
})

/**
 * 把用户给的原始配置规范化成安全值。
 * - 缺字段回退默认值
 * - 非法值抛 `Schema.ValidationError`（上层决定降级策略）
 *
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  return Config(raw ?? {})
}

export default Config
