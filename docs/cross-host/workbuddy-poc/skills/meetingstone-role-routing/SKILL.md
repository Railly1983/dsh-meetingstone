---
name: meetingstone-role-routing
description: Use when deciding which MeetingStone role should handle a task in WorkBuddy, or when verifying the read-only MeetingStone role table through the meetingstone_list_roles MCP tool.
description_zh: 集合石角色路由：按任务选择执行/评审/调研角色，并核对只读角色表。
description_en: Route tasks to MeetingStone roles in WorkBuddy and verify the read-only role table.
---

# 集合石角色路由

在 WorkBuddy 内把任务交给合适的集合石（MeetingStone）角色预设，并用只读 MCP 工具核对角色映射。

## 何时使用

- 用户要求「用集合石/沙僧/悟空/斥候来做」某件事。
- 需要判断任务应由执行、评审还是调研角色承接。
- 需要确认 `meetingstone_list_roles` 是否可用、返回哪些角色。

## 路由表

| 任务类型 | 角色 | WorkBuddy 预设 | MeetingStone roleId | 写权限 |
|----------|------|----------------|---------------------|--------|
| 实现、改文件、跑测试 | 沙僧 | `meetingstone-executor` | `role-sashi` | 有 |
| 审查 diff、验收、找缺陷 | 悟空 | `meetingstone-reviewer` | `role-wukong` | 无 |
| 找文件、查依赖、摸清影响面 | 斥候 | `meetingstone-researcher` | `role-scout` | 无 |

## 步骤

1. 先判断任务类型；混合任务拆成「调研 → 执行 → 评审」多步，不要一步塞给一个角色。
2. 如果 MCP 工具可见，调用 `meetingstone_list_roles`，核对 `roleId` 与 `workbuddyAgent` 是否和上表一致；不可见或调用失败时标「MCP 未验证」，不要编造返回。
3. 选择对应预设；把任务范围、验收标准、禁止修改的文件和输出格式写进任务说明。
4. 执行角色完成后，需要独立复核时交给评审角色；评审只给结论和证据，不代改文件。
5. 回读工具轨迹和结果；模型自述不算证据。

## 输出约定

- 使用与用户相同的语言。
- 明确标注「已证实 / 推测 / 未验证」。
- 需要真实派单、取消或 worktree 时，交回集合石主控或宿主原生能力，不在 WorkBuddy 内模拟。

## 边界

- 不控制 WorkBuddy 桌面会话，不声称拥有 session/prompt/cancel 能力。
- 不把固定的角色快照当作实时配置。
- 不安装依赖、不改本机配置、不写仓库外文件。
