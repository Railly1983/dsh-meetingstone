# 集合石 · MeetingStone

[English](README.md) | 中文

DeepSeek Harness 的多 CLI 智能体角色管理与派单插件。

> **状态（2026-11-12）**：`0.1.0-alpha.20`。核心派单、角色配置、跨 CLI 路由、worktree 隔离、
> 执行记录均已实现并在真机验证；**十个工具**可用。
> 外部 CLI 派单需额外安装官方 provider bundle；配置写在 profile 的 `cordis.patch.yml`。
>
> **V1 UI（已实现）**：设置页 → 集合石。两个区：外部 CLI 连接 + 全局角色库。
> 「管理角色」页内联展开，支持增改删、每行启用开关、CLI→模型→思考强度联动、能力刷新。
> **没有**右侧栏「本对话角色」面板，**没有**对话页头角色入口 —— 这两个已在 B3 移除。
> 角色配置也只有全局一层（项目级/会话级覆盖已下线）。

> **Token 口径**：Subagents 面板的 `tok` 是四桶（uncachedInput+output+cacheRead+cacheWrite）累计、按整条持久日志计算；fork 会话含父历史（`154M / 4 秒` 即此，耗时只算子会话自身）。**不可用于成本/额度/子 Agent 归属**；替代口径见 [Token 统计口径核查](docs/audit/token-stats.md)。

## 解决什么问题

DSH 本身有完整的任务、子智能体、权限和统计。但"把活分给不同 CLI 的不同模型"仍要人记：谁用什么模型、什么强度、什么权限、在哪个目录跑。

集合石把这件事变成一张角色表：

| 角色 | 通道 | 模型 / 强度 | 职责 |
| --- | --- | --- | --- |
| 唐僧 | Codex | `gpt-6-astra` / high | 架构、关键决策、终审（最贵，慎用） |
| 悟空 | Codex | `gpt-6.1-sol` / high | 疑难、复核、长任务 |
| 八戒 | DSH 原生子 Agent | — | 调度、监工、整合 |
| 沙僧 | CodeBuddy(ACP) | `deepseek-v4.1-flash` / high | 主力开发 |
| 小白 | CodeBuddy(ACP) | `hy4free` / high | 主力开发、文档、杂活 |

之后就可以说："让沙僧重构这个模块"、"叫悟空复核这段并发逻辑"。

## 设计原则

1. **复用优先**：团队、项目、任务、子智能体、权限、用量统计全部用 DSH 原生，不重建。
2. **只补真缺口**：自研范围只有两处——本机 CLI 探测（`src/cli/`，官方明确不做）与并行写任务的 Git 工作树管理（`src/worktree.js`；宿主 `ctx.worktrees.create()` 会切走调用方 cwd，不能直接用于后台派单，详见 `docs/worktree-isolation.md`）。
3. **不伪造**：模型/强度/用量只显示真实拿到的值；做不到的能力就不提供——**本项目不提供只读通道**（宿主 subagent spec 没有权限字段），不标假标记。
4. **薄**：不自研任务队列、不建数据库、不做独立工作台、不自研 CLI 启动器。

## 子代理使用建议（实测结论）

> **多子代理模式会大幅度增加 token 消耗，建议仅在重要长任务情境下启用。**

这是实打实测出来的，不是感觉。对照实验（四方案 × 48 格，全部统一模型）见
[多平台调度对照](docs/plan/2026-11-13-multi-platform-benchmark.md)：

| 现象 | 原因 |
|---|---|
| 并行子代理的 token 总量显著高于串行 | 每个子代理都要**重新读一遍上下文**，父会话的 KV cache 命中率下降 |
| 任务越碎，放大越明显 | 拆成 N 个子任务 ≈ N 次上下文重建 |
| 耗时收益远小于成本增长 | 并行省下的墙钟时间，往往抵不上多花的 token |

**实践建议**：

- **默认串行**。一次派一个任务，完成后再派下一个。
- 只有同时满足下面三条时才考虑并行：
  1. 任务确实很长（单项就要跑几十分钟）
  2. 子任务之间**没有共享上下文**（不需要互相看到对方的产出）
  3. 你愿意为缩短墙钟时间多付 token
- 需要并行时，用 `limits.maxParallelWritesTotal` 显式放开，
  并配合 `worktree` 隔离（每任务独立工作树），避免写冲突。

子代理相关工具（`meetingstone_dispatch` 的 autoRoute、`steer` 等）能力保留，
但**不要因为"能并行"就默认并行**。

## 快速开始

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

npm run verify                                              # 1) 门禁，必须通过
& $dsh plugin --profile desktop add "D:\MeetingStone"        # 2) 安装
# 3) 参考 examples/meetingstone.desktop.yml 配角色，重启 DSH
```

安装、provider、配置与回滚详见 [安装文档](docs/installation.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [开发计划](docs/开发计划.md) | 环境基线、架构、阶段路线、风险登记、决策记录 |
| [任务清单](docs/任务清单.md) | WBS 与验收状态 |
| [架构](docs/architecture.md) | 分层与数据流、设计不变量 |
| [配置参考](docs/configuration.md) | 全部字段、合并规则、错误码 |
| [协作效率规范](docs/efficiency.md) | 派单简报、输出、收口、失败标注的协作约定（纯提示词，非配置） |
| [统一任务/结果协议](docs/task-protocol.md) | 派单四件（名称/目标/范围/验收）、回执四件（状态/结论/证据/报告路径）、六条规则与工具字段映射 |
| [GUI 只读配置页（0.2.0）](docs/gui-0.2.0.md) | 面板注册、会话角色覆盖、三个原生面板职责与命名规则 |
| [Token 统计口径核查](docs/audit/token-stats.md) | Subagents 面板 token 的公式、fork 继承、可信边界与替代口径 |
| [P0-A 真实 A/B 实测](docs/plan/2026-11-11-p0a-ab.md) | dispatch / get_task / list_roles 的真实回执字节对照与 Token 可得性 |
| [安装/卸载](docs/installation.md) | 门禁、安装、provider、配置、回滚 |
| [安全与权限](docs/security.md) | 权限边界与"不提供只读通道"的原因 |
| [工作树隔离（自动 + 手动）](docs/worktree-isolation.md) | 默认每任务独立工作树、失败关闭、人工合并/清理；文件布局隔离≠权限沙箱 |
| [并行多任务方案（已实现）](docs/plan/2026-11-11-parallel-plan.md) | 悟空裁决、两级额度、失败关闭、不自动清理 |
| [发布检查清单](docs/release-checklist.md) | 通用门禁、隔离环境验证、回滚与发布前安全审查 |
| [发布清单（0.1.0-alpha）](docs/release/0.1.0-alpha-checklist.md) | 版本同步、门禁、npm/GitHub 发布步骤、回滚与已知限制 |
| [兼容性](docs/compatibility.md) | 宿主/provider/本机 CLI 的实测组合 |
| [事故复盘](docs/audit/13-incident-tool-schema.md) | 2026-11-10 工具 schema 事故与门禁 |
| [阶段 0 审计](docs/audit/00-summary.md) | A/B/C 分类与最小自研范围 |

## 开发

```powershell
npm run verify     # 测试 + 工具 schema 契约 + manifest + 发布包内容
```

提交守则见 [CONTRIBUTING](CONTRIBUTING.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。

**命名声明**：本项目的 "集合石 / MeetingStone" 与魔兽世界的同名插件**没有任何关系**（那个是游戏内组队找队伍工具）。本项目与 DeepSeek、OpenAI、Anthropic、腾讯等厂商无隶属或背书关系；文中出现的模型与 CLI 名称归各自权利人所有。
