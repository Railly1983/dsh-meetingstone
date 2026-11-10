# 集合石 · MeetingStone

[English](README.md) | 中文

DeepSeek Harness 的多 CLI 智能体角色管理与派单插件。

> **状态（2026-11-10）**：阶段 1（骨架）与阶段 2（角色映射 + 派单核心）已完成，插件已在本机 `desktop` profile 加载。
> 外部 CLI 派单需额外安装官方 provider bundle；第一版**无 UI**，配置写在 profile 的 `cordis.patch.yml`，重启生效。

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
2. **只补真缺口**：官方明确不做"本机 CLI 探测"，这是我们唯一的核心自研（`src/cli/`）。
3. **不伪造**：模型/强度/用量只显示真实拿到的值；无法强制的权限**拒绝启动**，不标个标记糊弄。
4. **薄**：不自研任务队列、不建数据库、不做独立工作台、不自研 CLI 启动器。

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
| [安装/卸载](docs/installation.md) | 门禁、安装、provider、配置、回滚 |
| [安全与权限](docs/security.md) | 四档权限的实测边界 |
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
