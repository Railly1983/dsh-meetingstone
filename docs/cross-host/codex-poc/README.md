# Codex 宿主最小闭环 POC（2026-11-11）
范围：仅仓库骨架；本次不安装、不注册、不写用户或项目的生效配置，不启动付费 Agent。
目录：`docs/cross-host/codex-poc/{README.md,meetingstone_wukong.toml,config.example.toml,server.mjs,smoke.mjs}`，全部文件合计 ≤100 行。
本地前提：已有 Node ≥18、Git；离线自检：在仓库根执行 `node docs/cross-host/codex-poc/smoke.mjs`。

后续宿主验证（需另行安排；以下不是本次已执行记录）：
1. 记录桌面/内置 CLI 版本、OS、有效配置来源；使用可信测试项目，确认本版本支持下述官方格式，旧版不支持则标阻塞，不安装升级。
2. 将角色样例放入测试项目 `.codex/agents/meetingstone_wukong.toml`，把注册片段合并到其 `.codex/config.toml`；替换绝对路径，确认宿主能找到现有 Node，不写 `~/.codex`。
3. 重启测试宿主；在 Settings → MCP servers 截图记录 `meetingstone_poc`、启用/连接状态，再用 `/mcp` 检查连接；列表出现不等于工具调用成功。
4. 新建 Worktree 聊天，不选带安装/配置副作用的环境 setup；记录父会话 ID、工作目录及 `git worktree list --porcelain` 基线。
5. 发给父 Agent：“只启动一个 meetingstone_wukong 子 Agent A，调用 meetingstone_list_roles，返回 POC_WUKONG、原始角色表、Get-Location 和 git rev-parse --show-toplevel、--git-dir、--git-common-dir 的实际输出；完成后保留线程，不关闭。报告 A 的 ID 与状态。”
6. 打开 A 活动线程回读最终文本和 MCP 调用记录；父会话也收集结果。要求角色表精确含 `meetingstone_wukong/悟空`，不能仅凭自述判定注入或工具成功。
7. 对 A 续派：“先输出 CANCEL_READY，再执行只读等待 Start-Sleep -Seconds 45。”在工具运行中要求父 Agent：“中断 A，不关闭线程；报告工具返回和状态。”确认等待已停止；若到时自然结束，该轮取消证据无效。
8. 上限已设 1，A 尚开放时尝试启动同角色 B，记录成功或限额错误及全部开放线程；若成功，立即关闭 B，避免影响后续对照。不要把取消或完成当作关闭。
9. 要求父 Agent：“关闭 A，报告关闭结果；再次启动同角色 B，调用同一 MCP，回读结果后关闭 B。”只有关闭前后限额对照、B 成功和最终无开放子线程共同支持放槽；异常/自动关闭须记录，不能强判通过。
10. 对比父/A/B 的 Git 输出：同 common-dir 表示同仓库，不同顶层路径且不同 git-dir 才支持独立 worktree；再次读取 worktree 列表，区分现存条目、聊天归属与新增条目。
11. 关闭测试聊天，确认无运行任务；归档/删 worktree 属于另一生命周期，不用它代替子线程关闭。仅撤回本次测试配置条目/角色文件，保留证据，不改其他配置。

证据模板：版本｜父/子 ID｜时间｜操作及原始返回｜状态前后｜MCP 原始结果｜cwd/git-dir/common-dir｜设置截图；每项标 PASS/FAIL/未验证。
通过门槛：人设标记+真实工具轨迹、结果回读、运行中取消、关闭后放槽、worktree 归属证据、设置列表可见，缺一项只算部分闭环。
边界：角色继承父会话 MCP，角色 TOML 不能覆盖 `mcp_servers`；`enabled_tools` 是父会话服务器级过滤，不是角色 ACL。人设与 readOnlyHint 都不是权限隔离；本 server 的只读性来自固定内存数据且没有写操作。
并发：当前官方未承诺固定默认数字，由 Codex 选择；`max_threads` 是旧别名。此处显式设“开放子线程上限 1（不含主线程）”，与集合石自身名额不是同一计数器。
Worktree：官方保证独立聊天可使用 worktree，未保证每个子 Agent 自动独立；POC 按可能共享目录设计，不能宣称写隔离。托管目录默认 `$CODEX_HOME/worktrees`，可被 Settings → Worktrees 的 root 改写。
未验证：本机桌面 TOML 加载/信任策略/设置页展示、取消后进程与 MCP 生命周期、真实名额释放时机、子线程工作目录、跨角色授权隔离、重启恢复；离线自检不能代替这些验收。
骨架边界：stdio 按行 JSON-RPC，无 HTTP、认证、持久化或生产限流；Agent 取消由宿主管，固定快速只读工具不模拟取消。
本轮实测：Node v20.16.0；TOML 可解析；Node 内部 spawnSync 被当前沙箱拒绝（EPERM），改用 Python 标准库 subprocess 独立驱动 stdio，未改变沙箱配置；当前目录是集合石已有 worktree，Git common-dir 为 `D:/MeetingStone/.git`，不构成 Codex 子 Agent 隔离证据。
独立 stdio 模式：`node smoke.mjs --requests` 产生请求，交给 `node server.mjs`；将其 stdout 交给 `node smoke.mjs --verify`（该模式仅断言协议输出，驱动方另验 server 退出码和 stderr）。
离线验收 PASS：握手/通知无响应/仅一个只读工具/固定角色表/心跳/未知方法/非法参数/未知工具/null 参数/非法请求/坏 JSON；server EOF 后 exit=0、stderr 为空。

官方依据（已打开核对；格式/策略以目标宿主版本为准）：
- [Subagents：角色格式、继承、线程控制、并发](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Configuration Reference：并发设置与旧别名](https://learn.chatgpt.com/docs/config-file/config-reference)
- [MCP：stdio 注册、过滤与桌面设置](https://learn.chatgpt.com/docs/extend/mcp)
- [Worktrees：聊天关联与默认位置](https://learn.chatgpt.com/docs/environments/git-worktrees)
