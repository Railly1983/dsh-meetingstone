# 评估 · DSH 官方智能体管理插件（Agent Teams）在本项目的可用性

> 2026-11-12｜评估人：八戒（Lead）｜方式：只读核查 profile 配置、官方 bundle 清单、本会话工具面，并**实机 spawn 一个只读审计成员**验证
> 未改任何插件代码、未改 profile、未 commit

---

## 0. 结论先行

1. **能用，而且已经在本机 `desktop` profile 里启用了**——不是"要不要装"的问题，而是"要不要用、怎么用"的问题。
2. **它和 MeetingStone 不是竞争关系，是上下游**：官方 Agent Teams 提供「协作面」（持久成员、团队任务板、消息/打断、UI）；MeetingStone 提供「执行面」（角色表、跨 CLI 通道、worktree 隔离、结构化结果）。
3. **关键实测发现：官方团队成员可以直接调用 `meetingstone_dispatch`。** 也就是说，"官方团队当调度台 + MeetingStone 当跨 CLI 执行引擎"这条组合链路**不需要写任何新代码**就能成立。
4. **建议：采纳为可选协作层，不设为硬依赖，不把 MeetingStone 改造成团队插件。** 理由与边界见下。

---

## 1. 证据链

### 1.1 已经启用（配置层）

`C:\Users\30673\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 顺序：

```
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
dsh-meetingstone              ← 本项目
@deepseek-ai/dsh-experimental-agent-team-profile   ← 官方智能体管理
dsh-remote-plugin
@deepseek-ai/dsh-subagent-codex
@deepseek-ai/dsh-subagent-claude-code
```

`plugin_manager(list_bundles)` 中该 bundle 的官方描述：
> "Agent Teams collaboration, tools, and Web UI in one experimental bundle"（`official:true`，包含 `agent-team` / `tool-agent-team` / `ui-agent-team` 三行，并 override `tool-subagent-control` / `tool-subagent` / `tool-subagent-fork`）

### 1.2 本会话已具备工具面（运行层）

本会话实际可用：`spawn_teammate`、`list_agents`、`send_message`、`wait_agent`、`interrupt_agent`、`team_task_create` / `get` / `list` / `update`。这组工具就是 agent-team bundle 暴露的能力，说明它已挂载生效。

### 1.3 实测 spawn 成员（行为层）

2026-11-12 实测创建一个只读审计成员 `arch-auditor`（provider=`spawn`，model=`deepseek-flash`），成功运行并回报：

| 问题 | 成员实测回答 |
| --- | --- |
| 是否有 Agent Teams 工具 | 有：`send_message`/`wait_agent`/`team_task_*`/`list_agents`；**`spawn_teammate` 仅 Lead 可调** |
| 是否有子代理工具 | 有 `subagent`/`subagent_codex`/`subagent_claude_code`/`subagent_fork`，但**本会话深度余 0，实际调用会被拒** |
| 是否有 MeetingStone 派单工具 | **有**：`meetingstone_dispatch`/`list_roles`/`list_runs`/`get_task` 等 |
| 成员模型能否指定 | `subagent` 可传 provider/model（可选 Codex/CodeBuddy 通道）；**`spawn_teammate` 无模型参数，成员只继承父会话模型** |

### 1.4 官方能力域（文档层，引自 `docs/audit/03-native-capabilities.md` §2.1）

`dsh-experimental-agent-team` 给已有 subagent 树加**持久化共享任务板**：CAS 任务所有权、`blockedBy` DAG、`writeScopes` 建议路径前缀；`TeamTaskSnapshot` / `revision` 提供快照与并发控制；`dsh-experimental-client-ui-agent-team` 提供团队 UI。
默认关闭、需显式启用（本机 desktop profile 已开启）；**experimental，官方未承诺 API 稳定**（`docs/audit/05-agent-teams.md` 的"第一版不用"结论仍然成立，但那是发布策略，不是能力不存在）。

---

## 2. 与 MeetingStone 的能力边界（谁该干什么）

| 能力 | 官方 Agent Teams | MeetingStone | 裁决 |
| --- | --- | --- | --- |
| 角色 → 跨 CLI 通道（Codex/CodeBuddy/Claude） | ✗ | ✓ | MeetingStone 不可替代 |
| 角色/通道/模型绑定与探测 | ✗ | ✓ | MeetingStone 不可替代 |
| 团队持久成员 + 邮箱 + 打断 | ✓ | ✗ | 用官方，不重造 |
| 任务板（CAS 所有权 / blockedBy DAG / writeScopes） | ✓ | ✗（只有 runs 记录） | 用官方，不重造 |
| 团队 UI（成员/任务可见性） | ✓ | V1 只读 GUI（角色/设置） | 用官方补协作可见性 |
| 结构化结果契约（JSON + 证据 + handoff） | ✗ | ✓ | MeetingStone |
| 每任务独立 worktree 隔离 | ✗（需另装 worktree bundle） | ✓ | MeetingStone |
| 会话/成员级 token 统计 | 宿主 `dsh-token-meter` | ✗ | 都用原生 |
| 稳定性承诺 | experimental | 自研可控 | **依赖风险在官方侧** |

**一句话**：官方解决"人和 agent 怎么协作"，MeetingStone 解决"活怎么分给不同 CLI 的模型"。两者没有重叠到需要二选一。

---

## 3. 组合验证（本次唯一实机结论）

`arch-auditor` 是官方团队成员，它能直接看到并调用 `meetingstone_dispatch` / `meetingstone_list_roles`。
→ 组合模式成立：**成员（官方团队）→ 派单（MeetingStone）→ 外部 CLI 执行（Codex/CodeBuddy/Claude）→ 结果回传成员**。
这条链路目前**无需新增代码、无需改协议**。

已知限制（实测）：
- 成员自身模型不可指定（继承父会话），跨 CLI 只能通过 MeetingStone 派单实现；
- 成员当前 subagent 深度为 0（不能再套原生子代理），但 MeetingStone 派单不受此限；
- 官方 bundle 是 experimental，升级可能改 API。

---

## 4. 建议

### 4.1 采纳方式
1. **立即可用，零改造**：需要"多成员协作 + 任务板 + 人类可见进度"时，用官方 Agent Teams；成员通过 MeetingStone 派单执行真实开发。
2. **不硬依赖**：MeetingStone 必须继续在**没有** agent-team bundle 的 profile 下正常工作（现状即如此，保持不变）。
3. **不在 MeetingStone 里重造**：成员管理、任务板、邮箱、团队 UI 一律不写进插件。
4. **单一事实来源约定**：任务板管"协作意图与所有权"，runs 管"执行事实与证据"；两边不做双向同步。

### 4.2 不建议现在开发的东西
- 不要为"角色直接显示为团队成员"写自定义 member/provider adapter——**用"成员 → dispatch"组合已覆盖当前需求**，属于"能实现但没有实测缺口"的范围，按任务书原则不立项。
- 不要把 `dsh-token-meter` 的会话级统计抄进插件。

### 4.3 待验证（有需要再开）
- agent-team bundle 关闭/升级后，MeetingStone 与它的共存边界（版本漂移影响面）；
- 团队成员并发上限、与外部 CLI 额度的叠加限制；
- 成员 depth=0 是否可配置（影响"成员再分活"的形态）。

---

## 5. 与既有审计文档的关系

- `docs/audit/05-agent-teams.md`（2026-11-10）结论是"第一版不纳入"，理由：experimental + 成员模型不匹配 + 价值不在第一版。**其中"成员模型不匹配"这次得到实机确认**（spawn 成员只继承父会话模型），但"不纳入"的前提已变：该 bundle 现已挂在本机 profile 上，且与 MeetingStone 可组合使用。本文不修改历史审计，只追加当前事实与建议。
- `docs/audit/03-native-capabilities.md` §2.1 的包名/能力描述仍是有效依据。
