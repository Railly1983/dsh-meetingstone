# MeetingStone · 集合石

A lightweight cross-CLI agent role and dispatch plugin for DeepSeek Harness.

DeepSeek Harness 多 CLI 智能体角色管理与派单插件。

---

> **状态：阶段 0（复用审计与技术验证）进行中，尚不可安装使用。**
> Status: Phase 0 (reuse audit & technical validation) in progress. Not installable yet.

## 它要解决什么

DSH 已经有一套完整的任务、子智能体、权限和统计体系，但"怎么把活分给不同 CLI 的不同模型"仍然要人工记：谁用什么模型、什么强度、什么权限、在哪个目录跑。

集合石把这件事变成一张**角色表**：

| 角色 | 执行通道 | 模型 / 强度 | 干什么 |
| --- | --- | --- | --- |
| 唐僧 | Codex | `gpt-6-astra` / high | 架构、关键决策、终审 |
| 悟空 | Codex | `gpt-6.1-sol` / high | 疑难、复核、长任务 |
| 八戒 | DSH 原生 | `deepseek-v4.1-flash` / high | 调度、监工、整合 |
| 沙僧 | CodeBuddy | `deepseek-v4.1-flash` / high | 主力开发 |
| 小白 | CodeBuddy | `hy4free` / high | 主力开发、文档、杂活 |

然后你就可以说："让沙僧重构这个模块"，"叫悟空复核一下这段并发逻辑"。

## 设计原则

1. **复用优先**：团队、项目、任务、子智能体、权限、用量统计，全部用 DSH 原生的，不重建。
2. **只补真缺口**：本项目只补 DSH Provider 确实不提供的那一层——本机 CLI 的可执行文件探测（PATH 查不到的商店应用 CLI 也在内）。
3. **不伪造**：模型、强度、用量只显示真实拿到的值，拿不到就显示未知。
4. **薄**：不自研任务队列、不自建数据库、不做独立工作台。

## 文档

| 文档 | 内容 |
| --- | --- |
| [开发计划](docs/开发计划.md) | 环境基线、架构、五阶段路线、任务编排、风险登记 |
| [任务清单](docs/任务清单.md) | 11+6+8+4+7 项任务的 WBS 与验收 |
| [Clean-room 声明](docs/CLEAN_ROOM.md) | 独立开发边界与来源审查流程 |
| [交接文档归档](docs/reference/交接文档_V1.1.md) | 项目立项依据（原始 .docx 的完整提取） |

## 许可

MIT，见 [LICENSE](LICENSE)。

**命名声明**：本项目的 "MeetingStone / 集合石" 与魔兽世界的同名插件 **没有任何关系**——那个是游戏里的组队找队伍工具，本项目是 DeepSeek Harness 的插件。本项目也与 DeepSeek、OpenAI、Anthropic、腾讯等厂商无隶属或背书关系；文中出现的模型与 CLI 名称归各自权利人所有。
