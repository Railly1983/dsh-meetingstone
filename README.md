# MeetingStone · 集合石

A lightweight cross-CLI agent role and dispatch plugin for DeepSeek Harness.

DeepSeek Harness 多 CLI 智能体角色管理与派单插件。

---

> **状态（2026-11-10）**：阶段 1（骨架）与阶段 2（角色映射 + 派单核心）已完成；插件已在本机 `desktop` profile 加载，八个工具在真实会话中可用。
> 外部 CLI 派单需额外安装官方 provider bundle（见 [安装文档](docs/installation.md)）。
> V1 有只读 GUI（设置页 / 对话顶部入口 / 右侧栏）；底层配置仍以 profile 的 `cordis.patch.yml` 与项目 `.meetingstone.json` 为准。

## 它要解决什么

DSH 有完整的任务、子智能体、权限和统计体系，但"怎么把活分给不同 CLI 的不同模型"仍然要人工记：谁用什么模型、什么强度、什么权限、在哪个目录跑。

集合石把这件事变成一张**角色表**：

| 角色 | 执行通道 | 模型 / 强度 | 干什么 |
| --- | --- | --- | --- |
| 唐僧 | Codex | `gpt-6-astra` / high | 架构、关键决策、终审 |
| 悟空 | Codex | `gpt-6.1-sol` / high | 疑难、复核、长任务 |
| 八戒 | DSH 原生 | — | 调度、监工、整合 |
| 沙僧 | CodeBuddy(ACP) | `deepseek-v4.1-flash` / high | 主力开发 |
| 小白 | CodeBuddy(ACP) | `hy4free` / high | 主力开发、文档、杂活 |

然后你就可以说："让沙僧重构这个模块"，"叫悟空复核一下这段并发逻辑"。

## 设计原则

1. **复用优先**：团队、项目、任务、子智能体、权限、用量统计全部用 DSH 原生的，不重建。
2. **只补真缺口**：官方明确不做"本机 CLI 探测"，这是我们唯一的核心自研（`src/cli/`）。
3. **不伪造**：模型/强度/用量只显示真实拿到的值；做不到的能力就不提供——**本项目不提供只读通道**（宿主 subagent spec 没有权限字段），不标假标记。
4. **薄**：不自研任务队列、不自建数据库、不做独立工作台、不自研 CLI 启动器。

## 快速开始

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1) 门禁（必须通过）
npm run verify

# 2) 安装
& $dsh plugin --profile desktop add "D:\MeetingStone"

# 3) 配置角色（参考 examples/meetingstone.desktop.yml），重启 DSH
```

完整步骤、provider 安装与回滚见 [安装文档](docs/installation.md)。

## 开发

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --test "tests/**/*.test.mjs"     # 214 项
& $node scripts/verify-host-schema.mjs    # 工具 schema 契约门禁
& $node scripts/verify-manifest.mjs       # manifest 自检
```

提交守则见 [CONTRIBUTING](CONTRIBUTING.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [开发计划](docs/开发计划.md) | 环境基线、架构、阶段路线、风险登记、决策记录 |
| [任务清单](docs/任务清单.md) | WBS 与验收状态 |
| [安装/卸载](docs/installation.md) | 门禁、安装、provider、配置、回滚 |
| [安全与权限](docs/security.md) | 权限边界与"不提供只读通道"的原因（实测边界） |
| [工作树隔离（自动 + 手动）](docs/worktree-isolation.md) | 默认每任务独立工作树、失败关闭、人工合并/清理；文件布局隔离≠权限沙箱 |
| [并行多任务方案（已实现）](docs/plan/2026-11-11-parallel-plan.md) | 悟空裁决、两级额度、失败关闭、不自动清理 |
| [兼容性矩阵](docs/compatibility.md) | 宿主/provider/本机 CLI 的实测组合 |
| [事故复盘](docs/audit/13-incident-tool-schema.md) | 2026-11-10 工具 schema 事故与门禁 |
| [阶段 0 审计](docs/audit/00-summary.md) | A/B/C 分类、最小自研范围、9 条被推翻的结论 |
| [Clean-room 声明](docs/CLEAN_ROOM.md) | 独立开发边界与来源审查 |
| [示例配置](examples/meetingstone.desktop.yml) | 五角色 + 通道实例可直接参考 |

## 许可

MIT，见 [LICENSE](LICENSE)。

**命名声明**：本项目的 "MeetingStone / 集合石" 与魔兽世界的同名插件 **没有任何关系**——那个是游戏里的组队找队伍工具，本项目是 DeepSeek Harness 的插件。本项目也与 DeepSeek、OpenAI、Anthropic、腾讯等厂商无隶属或背书关系；文中出现的模型与 CLI 名称归各自权利人所有。
