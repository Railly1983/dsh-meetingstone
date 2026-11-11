# 全局配置字段盘点与最小 schema（V1）

> 范围：设置 → 集合石 的**全局**配置面。纯文档，不改代码/配置，不提交。
> 结论：五类中 4 类复用现有字段，仅新增 `defaultChannelId` 与会话覆盖层；现有配置**零迁移**。

## 1. 现状（证据）

- `src/config.js:78-109`：插件 Config 仅 6 个顶层字段：`roles` / `channels` / `defaultRoleId` / `dispatchNotes` / `projectConfigFile` / `limits`。
- `src/config.js:19-24,35-44`：`kind` 是 4 值闭集（`in-process` / `acp-cli` / `codex` / `claude-code`），即「四 CLI 连接」；模型/强度挂在**通道实例**上（DD7），角色只引用并声明一致（`src/dsh/adapter.js:843-865`）。
- `src/config.js:6-7`：全局配置持久化在 profile 的 `cordis.patch.yml`，patch 是**整值替换**，不是深合并。
- `src/project/config-file.js:98-216`、`src/roles/registry.js:375-486`：项目级 6 字段、未知字段忽略、只认 `version:1`；合并顺序 global → project roles（同 id 字段级）→ `roleOverrides`，`channel` 按字段合并（registry L282-285）。
- `src/dispatch/dispatcher.js:423-427`：`limits` 实际消费点仅 3 个；`src/gui/host.js:135-147`：现有快照只有 `roles`/`channels`/`lastError`。

## 2. 五类最小字段表

| 类 | 字段 | 类型 | 默认值 | 必填 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| 连接 | `channels[].channelId` | string | — | ✅ | global |
| 连接 | `channels[].kind` | 4 值枚举 | `in-process` | 否 | global |
| 连接 | `channels[].provider` | string | 按 kind 推断 | 否 | global |
| 连接 | `channels[].model` | string | — | 否 | global（默认模型唯一落点） |
| 连接 | `channels[].reasoning` | string | — | 否 | global |
| 连接 | `channels[].description` | string | `''` | 否 | global |
| 角色 | `roles[]` | object[] | `[]` | 否 | global |
| 角色 | `roles[].roleId` / `name` | string | — | ✅ | global |
| 角色 | `roles[].channel.channelId` | string | — | 否 | global |
| 默认 | `defaultRoleId` | string | `undefined` | 否 | global / project |
| 默认 | `defaultChannelId` **（新增）** | string | `undefined` = 沿用默认角色通道 | 否 | global / project / session |
| 额度 | `limits.serializeWrites` | boolean | `true` | 否 | global |
| 额度 | `limits.maxParallelWritesTotal` | number | `4` | 否 | global |
| 额度 | `limits.defaultIsolation` | `none` \| `worktree` | `worktree` | 否 | global |
| 额度 | `projectConfigFile` | string | `.meetingstone.json` | 否 | global |
| 规则 | `dispatchNotes` | string（多行） | `''` | 否 | global / project（整串覆盖） |
| 规则 | `projectRules` | string[] | `[]` | 否 | project |
| 规则 | `roleOverrides` | `Record<roleId, Partial<Role>>` | `{}` | 否 | project |
| 会话 | `session.roleId` / `session.channelId` | string \| null | `null` = 继承 | 否 | session |
| 会话 | `session.isolation` | `none` \| `worktree` \| null | `null` = 继承 | 否 | session |
| 会话 | `session.dispatchNotes` | string \| null | `null` = 继承 | 否 | session |

> 「默认模型」不新增标量：模型必须由通道实例承载（DD7）。UI 选默认模型 = 选 `defaultChannelId`，模型/强度写回该实例。
> 会话层不落盘（内存，重启失效），不写 `.meetingstone.json`；恢复继承 = 删键或置 `null`。角色其余子字段沿用 `src/config.js:63-75`。CLI 探测仅覆盖 3 个外部 CLI（`src/cli/probe.js:19-49`），`in-process` 不算已装 CLI。

## 3. 与现有字段映射（复用优先）

| 五类 | 现有字段 | 处理 |
| --- | --- | --- |
| 四 CLI 连接 | `channels[]` | 原样复用；`kind` 已是 4 值闭集 |
| 全局角色库 | `roles[]` | 原样复用 `RoleSchema` |
| 默认模型 | `defaultRoleId` + `channels[].model` | 复用；仅新增 1 个指针 |
| 额度与并发 | `limits.*` | 原样复用（仅 global，项目级写 `limits` 被忽略） |
| 全局调度规则 | `dispatchNotes` | 原样复用，不新增 `rules[]` |
| 会话覆盖 | 无 | 新增内存层，不进配置文件 |

## 4. 继承模型

`global（唯一真实存储） → project（字段级差异） → session（字段级差异）`，优先级自右向左；每层只存与下层不同的键，缺省/`null` 即继承。

- 角色：global 全量 → project 同 id 覆盖 → `roleOverrides` → `session.roleId` 选择。
- 通道：`defaultChannelId` 逐层覆盖；最终 `channelId` 决定 provider/model，角色声明与实例不一致仍被拒（`MODEL_UNSUPPORTED` / `CHANNEL_MISMATCH`）。
- 额度：**只有 global**；project/session 不提供 `limits`（`docs/configuration.md:99`）。
- 规则：`dispatchNotes` 整串覆盖，不拼接，避免半句拼接产生歧义。

## 5. 兼容策略（零迁移）

1. 新字段全可选，默认值等价当前行为；不设 `defaultChannelId` 时派单路径与今天完全一致。
2. 未知键静默丢弃（`src/schema.js:117-125`）：旧版读到新字段不报错，也不阻断派单。
3. 项目文件保持 `version: 1`（`src/project/config-file.js:114-124`）；不新增 global `version`（当前无读取方）。
4. UI 写入必须回写**全量**全局对象（patch 整值替换），且基于原始 patch 做差异合并——不能回写规范化对象，否则未知/未来字段会被静默抹掉。
5. 会话层无磁盘格式：升级/重启自然回到继承值。

## 6. UI 最小数据形状

```ts
type Scope = 'global' | 'project' | 'session'
interface ChannelConn { channelId: string; kind: 'in-process'|'acp-cli'|'codex'|'claude-code'
  provider?: string; model?: string; reasoning?: string; description?: string }
interface RoleView { roleId: string; name: string; aliases: string[]; description?: string
  prompt?: string; enabled: boolean; timeoutMs: number
  channel: { channelId?: string; kind?: string; model?: string } }
interface GlobalConfigView {
  scope: 'global'; channels: ChannelConn[]; roles: RoleView[]
  defaults: { roleId: string | null; channelId: string | null }   // null = 未设/继承
  limits: { serializeWrites: boolean; maxParallelWritesTotal: number
            defaultIsolation: 'none' | 'worktree' }
  dispatchNotes: string; writable: boolean                       // false = 只读降级
  errors: Array<{ code: string; message: string }>
}
interface Effective<T> { value: T; from: Scope; overriddenBy: Scope[] }  // 可恢复继承的展示依据
```

## 7. 明确不做（含已知缺口）

- **不做** `defaultModel` / `defaultReasoning` 顶层标量：与通道实例重复，必然出现「配置成功、执行没采用」。
- **不做** project/session 级 `limits`：并发额度是插件全局纪律，不是项目偏好。
- **不做** `permissionPreset` / 只读通道（2026-11-11 用户决策，宿主无权限字段）。
- **不做** 全局 `rules[]` 数组（与 `dispatchNotes` 双写冲突）、不做会话落盘/跨会话共享/配置历史审计。
- **不做** UI 修改 `projectConfigFile` 路径（会让已存在的项目文件失联）。
- **已知缺口**：`defaultRoleId` / `dispatchNotes` / `projectRules` 目前**只解析不消费**（`src/index.js`、`dispatcher.js` 无引用）；`src/` 无 `ctx.settings` / `configEditor` 写入通道；快照仅全局、无 `limits`。
