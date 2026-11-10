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
      serializeWrites: true
```

> ⚠️ patch 是**整值替换**：覆盖这一行时要把整个 `config` 写全，不是深合并。

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
  "projectRules": ["未经确认不得修改数据库迁移文件"],
  "limits": { "serializeWrites": true }
}
```

**合并规则**

1. 项目 > 全局（`roleOverrides` 按 roleId 打补丁；`roles` 里同 roleId 也是覆盖）。
2. `channel` 覆盖是**字段级合并**；但模型/强度仍要与实例一致。
3. 文件坏了（JSON 非法、版本不认识、字段类型错）→ **降级为空配置 + 把错误暴露在工具返回里**，绝不打断派单链路。

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
| 同项目已有任务 | `WRITE_CONFLICT`（`serializeWrites` 默认开） |
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

## 7. 示例

- 全局五角色：[examples/meetingstone.desktop.yml](../examples/meetingstone.desktop.yml)
- 项目覆盖：[examples/project.meetingstone.json](../examples/project.meetingstone.json)
- 仓库自检角色：根目录 `.meetingstone.json`（`role-selftest`，in-process 通道）
