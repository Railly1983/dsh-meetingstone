# 审计证据目录（阶段 0）

> **2026-11-11 移除声明**：本目录中出现的 `readOnly` / `readOnlyEnforced` / `permissionPreset` /
> `READONLY_UNENFORCEABLE` / `READONLY_LIMIT` / "只读档位"均为**历史记录**。只读通道已因
> "宿主 subagent spec 无权限字段、做不到绝对只读"而彻底移除，**不要再实现**。

本目录存放阶段 0 的**实测证据**，不是设计文档。规矩：

1. 每个结论后面必须跟"怎么得到的"：命令、输出片段、版本号、日期。
2. 拿不到的就写 `未验证` / `未安装`，不允许推断成"应该有"。
3. 文件名固定，便于交叉引用：

| 文件 | 对应任务 | 内容 |
| --- | --- | --- |
| `00-summary.md` | P0-10 | A/B/C 分类与最小开发范围（最终 Gate 依据） |
| `01-environment.md` | P0-01 | DSH 版本、协议、profile、bundle、已装插件清单 |
| `02-plugin-spec.md` | P0-02 | 插件/Bundle 开发规范、入口、Config、UI Slot、生命周期 |
| `03-native-capabilities.md` | P0-03 | 11 项原生能力复用矩阵 |
| `04-cli-matrix.md` | P0-04 | 各 CLI / 原生通道能力矩阵 |
| `05-agent-teams.md` | P0-05 | Agent Teams 可用性与成员兼容性 |
| `06-ui-visibility.md` | P0-06 | 外部任务在原生 Jobs/Subagents UI 的可见性 |
| `07-config-extension.md` | P0-07 | Settings/Workspace 配置扩展路径 |
| `08-sandbox.md` | P0-08 | 沙箱与子进程权限边界 |
| `09-release.md` | P0-09 | 发布规范与名称占用 |
| `11-team-dispatch.md` | P0-11 | 团队 Worker 编队与派发协议验证 |

- [16 · Codex 沙箱初始化失败与修复](./16-codex-sandbox-fix.md)
