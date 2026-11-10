# 配置参考

> 第一版没有 UI：配置写在 profile 的 `cordis.patch.yml`（全局）与项目根的 `.meetingstone.json`（项目级）。
> 改完**重启 DSH** 生效（全局配置在插件加载时读取；项目配置按调用读取，改完下一次工具调用即生效）。

## 1. 全局配置（profile 的 `cordis.patch.yml`）

```yaml
- id: meetingstone
  name: dsh-meetingstone
  config:
    channels: [...]      # 通道实例表（见 §2）
    roles: [...]         # 角色表（见 §3）
    defaultRoleId: role-sashi
    dispatchNotes: "常规实现优先沙僧；关键改动交悟空复核。"
    projectConfigFile: .meetingstone.json
    limits:
      serializeWrites: true              # isolation:none 时同项目串行
      maxParallelWritesPerProject: 2     # 同项目并行写任务上限
      maxParallelWritesTotal: 4          # 全局并行写任务上限（所有 provider 共用）
      defaultIsolation: worktree         # worktree | none
```

> ⚠️ patch 是**整值替换**：覆盖这一行时要把整个 `config` 写全，不是深合并。

### 1.1 并行与工作树隔离

`meetingstone_dispatch` 默认 `isolation:'worktree'`：每个任务在
`<projectRoot>/.meetingstone/worktrees/<operationId>` 的独立 git 工作树里执行，
分支为 `meetingstone/<operationId>`。详见 [工作树隔离](worktree-isolation.md)。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `limits.defaultIsolation` | `worktree` | `worktree`=每任务独立工作树；`none`=主工作区 |
| `limits.maxParallelWritesPerProject` | `2` | 同项目并行写任务上限；超限返回 `WRITE_LIMIT_PROJECT`（可重试） |
| `limits.maxParallelWritesTotal` | `4` | 所有项目合计上限；超限返回 `WRITE_LIMIT_TOTAL`（可重试） |
| `limits.serializeWrites` | `true` | 仅在 `isolation:none` 时生效：同项目串行 |

纪律：

- 两级额度在**首次异步操作前**一起预占（含建树）；所有 provider 共用同一计数器。
- `isolation:none` 与隔离任务**不得混跑**，同项目任一方向有活动任务就返回 `WRITE_CONFLICT`。
- 请求隔离但建树失败 / 服务缺失 → **拒绝派单**，绝不退回主工作区。
- 完成 / 失败 / 取消 / 卸载都**不删除**工作树与分支。
- **隔离是文件布局隔离，不是权限沙箱**（同账号、同文件系统、共享 git 元数据）。

## 2. `channels`（通道实例表）

一行 = 一个已配置好的 provider。**模型/强度写在这里**，因为宿主的子任务启动 spec 不接收这两个字段。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `channelId` | string | ✅ | 实例 ID，角色通过 `channel.channelId` 引用 |
| `kind` | `in-process` \| `acp-cli` \| `codex` \| `claude-code` | | 通道类型 |
| `provider` | string | | provider 名（`spawn` / `acp` / `codex` / `claude-code`），省略时按 kind 推断 |
| `model` | string | | 该 provider 行实际使用的模型 |
| `reasoning` | string | | 该 provider 行实际的思考强度 |
| `description` | string | | 人类可读说明 |

**为什么要这层**（DD7 方案 B）：角色不能凭空指定模型。角色的声明必须与所引用实例一致，否则派单被拒（`MODEL_UNSUPPORTED`）——我们宁可报错，也不做"配置成功、执行没采用"。

> **本项目不提供只读通道**：宿主 subagent 启动 spec 没有权限字段，做不到绝对只读。因此这里没有 `permissionPreset`，角色上也没有；不要再实现（2026-11-11 用户决策）。

## 3. `roles`（角色表）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `roleId` | string | — | 稳定 ID，`^role-[a-z0-9][a-z0-9-]*$`，改名不变 |
| `name` | string | — | 显示名，同时参与解析 |
| `aliases` | string[] | `[]` | 别名；跨角色唯一（大小写/空白不敏感） |
| `description` | string | `''` | 职责说明 |
| `channel.kind` | 枚举 | `in-process` | 通道类型 |
| `channel.channelId` | string | | 引用通道实例 |
| `channel.model` / `channel.reasoning` | string | | 声明期望值，必须与实例一致 |
| `enabled` | boolean | `true` | 停用后不得派单 |
| `fallbackRoleId` | string | | 预留（第一版只提示，不自动接替） |
| `timeoutMs` | number | `1800000` | 单次派单超时 |

## 4. 项目级配置 `.meetingstone.json`

放在**项目根**（取 `exec.agent.session.header.cwd`）。

```json
{
  "version": 1,
  "defaultRoleId": "role-sashi",
  "roles": [{ "roleId": "role-scout", "name": "斥候", "channel": { "kind": "in-process" } }],
  "roleOverrides": { "role-sashi": { "description": "本项目里负责主力开发" } },
  "dispatchNotes": "只改 src/；动 docs/ 前先问。",
  "projectRules": ["未经确认不得修改数据库迁移文件"]
}
```

**合并规则**

1. 项目 > 全局（`roleOverrides` 按 roleId 打补丁；`roles` 里同 roleId 也是覆盖）。
2. `channel` 覆盖是**字段级合并**；但模型/强度仍要与实例一致。
3. 文件坏了（JSON 非法、版本不认识、字段类型错）→ **降级为空配置 + 把错误暴露在工具返回里**，绝不打断派单链路。

> 项目级配置**不提供 `limits`**：同项目串行开关 `serializeWrites` 只在插件全局配置（§1）里生效，项目文件里写 `limits` 会按未知字段忽略，不报错、不阻断派单。
> `permissionPreset` 已随只读通道移除；旧配置里写了也会被忽略，不报错、不阻断派单。

## 5. 解析与校验

| 场景 | 行为 |
| --- | --- |
| 名字/别名冲突 | 冲突 token 不参与解析；角色仍可用 `roleId`；`list_roles` 的 `errors` 里给 `ALIAS_CONFLICT` |
| 派单到歧义名字 | `ROLE_AMBIGUOUS`，提示里列出可选 roleId |
| 派单到停用角色 | `ROLE_DISABLED` |
| provider 未注册 | `PROVIDER_UNAVAILABLE`，附带原因 |
| 模型与实例不一致 | `MODEL_UNSUPPORTED`，给出双方取值 |
| `cwd` 越出项目根 | `PATH_OUTSIDE_PROJECT` |
| 拿不到项目根却指定 `cwd` | `PROJECT_ROOT_UNKNOWN` |
| 同项目已有任务（`isolation:none` + `serializeWrites`） | `WRITE_CONFLICT` |
| 同项目已有未隔离任务，或隔离任务遇到未隔离任务 | `WRITE_CONFLICT`（不得混跑） |
| 同项目并行写任务达上限 | `WRITE_LIMIT_PROJECT`（可重试） |
| 全局并行写任务达上限 | `WRITE_LIMIT_TOTAL`（可重试） |
| 请求隔离但工作树服务缺失 | `WORKTREE_UNAVAILABLE` |
| 项目根不是 git 工作区 | `WORKTREE_NOT_GIT_REPOSITORY` |
| `base` 无法解析为 commit | `WORKTREE_BASE_INVALID` |
| 工作树路径已存在/已被 git 登记 | `WORKTREE_PATH_EXISTS` |
| `meetingstone/<operationId>` 分支已存在 | `WORKTREE_BRANCH_EXISTS` |
| 其他 git 失败 | `WORKTREE_GIT_FAILED` |
| git 命令超时（建树 30s / 计算改动 10s） | `WORKTREE_TIMEOUT` |
| 工作树实际路径逃出项目根 | `WORKTREE_PATH_OUTSIDE` |
| `isolation` 不是 `none`/`worktree` | `INVALID_ISOLATION` |
| 取消/卸载时宿主 `dispose()` 超时 | `ADAPTER_DISPOSE_TIMEOUT`：按超时兜底，记录后仍然释放并发槽位并写终态 |
| 取消/卸载时宿主 `dispose()` 抛错 | `ADAPTER_DISPOSE_FAILED`：记录错误后仍然释放并发槽位并写终态 |

## 6. 生命周期、runtimeId 与 interrupted

- 每次插件启动生成一个 `runtimeId`，写进每一条落盘记录（`.meetingstone/runs/<childId>.json`）。
- **取消顺序**：先 `abort` → `await activation.dispose()`（默认最多等 5 秒）→ 释放并发槽位。
  dispose 成功、超时或抛错都会释放，区别只在于终态记录里的 `error` / `diagnostic`。
  这样旧进程没退干净之前，同项目不可能再派新的写任务。
- **落盘顺序**：同一 `childId` 的写入按 FIFO 串行，`running` 一定先于终态落地，终态不会被覆盖。
- **重启后的假 running**：读取时若 `status === 'running'` 且 `runtimeId` 不是当前进程的，投影为
  `status: 'interrupted'` + `interrupted: true`；只改返回值，不回写磁盘。
- **插件卸载**：对内存中仍存活的任务写 `interrupted` 终态（`stopReason: 'plugin-disposed'`），
  不会在磁盘留下假 `running`。
- **工作树记录**：终态记录包含 `worktree: { path, branch, baseSha, repositoryRoot, operationId }`、
  `changedFiles`、`changedFilesUnknown`、`stopConfirmed`。带 `worktree` 的记录**不参与**
  100 条/30 天自动清理（保护未合并成果的元数据）；工作树/分支本身一律不自动删除。
- **重叠预警**：`get_task` / `list_runs` 返回 `overlapWarnings: [{ childId, files }]`；
  `changedFilesUnknown: true` 的记录不参与比较，但会在结果里标注未知。

## 7. 示例

- 全局五角色：[examples/meetingstone.desktop.yml](../examples/meetingstone.desktop.yml)
- 项目覆盖：[examples/project.meetingstone.json](../examples/project.meetingstone.json)
- 仓库自检角色：[examples/selftest.roles.json](../examples/selftest.roles.json)（`role-selftest*`，in-process / codex / acp 通道）
- 本仓库项目配置：根目录 `.meetingstone.json`（五角色 + 通道引用）
