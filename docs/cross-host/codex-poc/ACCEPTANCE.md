# Codex 真机联调验收清单（额度恢复后执行）

> 状态：**未执行**。本文是可执行步骤与判定标准，不是结果记录。
> 边界：只在**可信测试项目**内操作；**不写 `~/.codex`**、不安装/升级 Codex、不提交测试配置、不启动与验收无关的付费任务。
> 通过门槛：真实工具轨迹 + 原始返回 + 状态前后 + 设置页/线程证据；**模型自述、列表可见、截图缺一不可**。缺一项只算部分闭环。
> 先读 [README.md](README.md) 的协议与边界；离线自检通过不等于真机通过。

## 0. 先记录环境（每个结论都要能复现）

| 项 | 取值方式 | 记录示例 |
|----|----------|----------|
| 宿主版本 | 桌面版关于页或内置 CLI `--version` | `codex-cli <version>` |
| OS / 时间 | `[Environment]::OSVersion`、当前时间 | Windows / `2026-11-11T…+08:00` |
| 有效配置来源 | 项目 vs 用户；是否改过 `CODEX_HOME` | 仅测试项目 `.codex/config.toml` |
| `node` 绝对路径 | `(Get-Command node).Source` | `C:\Program Files\nodejs\node.exe` |
| 父会话 ID | 宿主会话信息 | `<parent-id>` |

## 1. 注册角色与 MCP（只改测试项目）

### 1.1 复制角色

在**仓库根**执行（`docs/...` 相对仓库根）；在可信测试项目根创建 `.codex/agents/`，复制两个角色文件，**不要**复制到 `~/.codex`：

```powershell
$project = "D:/path/to/trusted-test-project"
New-Item -ItemType Directory -Force "$project/.codex/agents" | Out-Null
Copy-Item docs/cross-host/codex-poc/meetingstone_wukong.toml   "$project/.codex/agents/"
Copy-Item docs/cross-host/codex-poc/meetingstone_tangtang.toml "$project/.codex/agents/"
```

### 1.2 合并项目配置

先备份 `<project>/.codex/config.toml`，再把 [config.example.toml](config.example.toml) 的片段合并进去；`args` 换成这台机器的绝对路径，反斜杠推荐写成 `/`：

```toml
[agents]
enabled = true
max_concurrent_threads_per_session = 1

[mcp_servers.meetingstone_poc]
command = "node"
args = ["D:/ABS/REPO/docs/cross-host/codex-poc/server.mjs"]
enabled_tools = ["meetingstone_list_roles", "meetingstone_get_task"]
required = true
```

说明：
- `node` 不在宿主 PATH 时，把 `command` 改成 `node` 的绝对路径（GUI 启动的应用常不继承终端 PATH）。
- `enabled_tools` 是父会话服务器级过滤，不是角色 ACL；角色 TOML 不能覆盖 `mcp_servers`。
- 并发名以目标版本为准：当前文档使用 `max_concurrent_threads_per_session`，`max_threads` 是旧别名；记录实际生效值。
- **禁止**为了省事写用户级 `~/.codex/config.toml` 或 `~/.codex/agents/`；本轮只允许项目级。

### 1.3 重启与发现

重启测试宿主，找到 Settings → MCP servers（或等价页面），再执行 `/mcp`（或等价命令）：

**预期**：`meetingstone_poc` 显示已启用/已连接；工具列表出现 `meetingstone_list_roles` 与 `meetingstone_get_task`。

**失败判定**：条目缺失、连接报错、工具缺失 → 记 FAIL 并保留原始错误；列表可见但调用失败 → 继续第 2 步，以调用结果为准。**列表出现不等于工具调用成功。**

## 2. 启动子 Agent A（只启动一个）

由父 Agent 通过宿主官方 subagent 机制启动；入口随版本变化，记录实际入口。发给父 Agent 的指令：

```text
只启动一个 meetingstone_wukong 子 Agent A，不要并行启动其他子 Agent。让 A：
1) 首行输出 POC_WUKONG；
2) 调用 meetingstone_list_roles，原样返回 JSON；
3) 调用 meetingstone_get_task，childId="missing-<日期>"，原样返回；
4) 报告 Get-Location、git rev-parse --show-toplevel、--git-dir、--git-common-dir 的实际输出；
完成后保留线程，不关闭。报告 A 的 ID、状态和原始工具调用记录。
```

**预期**（原始返回，不是模型转述）：

```json
{"schemaVersion":1,"source":"codex-poc-fixed","readOnly":true,"roles":[{"id":"meetingstone_wukong","name":"悟空","duty":"核心资深专家","enabled":true},{"id":"meetingstone_tangtang","name":"唐僧","duty":"评审与验收","enabled":true}],"unknownRoleIds":[]}
```

```json
{"status":"NOT_FOUND","childId":"missing-<日期>","recordPath":null,"note":"只读占位：未读取 .meetingstone/runs，也不写文件。"}
```

第二个结果必须 `isError:false`；若返回 `-32602`，说明参数不符合 schema，记 FAIL。

**失败判定**：只有自述没有工具轨迹；角色表缺项、多出未定义角色；工具报错但模型声称成功；把 `NOT_FOUND` 当成"任务存在但失败"。

### 2.1 第二个角色（建议，串行）

A 关闭后，再单独启动一个 `meetingstone_tangtang` 子 Agent C（不要与 A 并发）：确认首行 `POC_TANGSENG`，调用 `meetingstone_list_roles` 并核对同一角色表，报告工具轨迹后关闭 C。失败判定同第 2 节；若因并发上限启动失败，先记录限额错误，不要把它当成角色注入失败。

## 3. 回读与取消

### 3.1 回读

打开 A 的活动线程，读取**最终文本 + MCP 调用记录**；父会话同时收集 A 的结果。核对人设标记 `POC_WUKONG`、两次工具调用的原始 JSON、A 的 ID/状态。

**失败判定**：只能看到最终文本、看不到工具调用记录；父 Agent 与活动线程内容不一致；角色表来自模型复述而非工具返回。

### 3.2 运行中取消

对 A 续派：

```text
先输出 CANCEL_READY，再执行只读等待 Start-Sleep -Seconds 45。
```

看到 `CANCEL_READY` 且等待仍在运行时，要求父 Agent："中断 A，不关闭线程；报告工具返回和状态。"

**预期**：等待被中断；A 状态变为 cancelled/interrupted；线程仍开放；工具返回可回读。记录中断前后的状态与原始返回。

**失败判定**：等待自然结束（45 秒到点）→ 本轮取消证据无效；取消后进程仍跑完；把"完成"或"取消"当成"关闭"。

## 4. 并发名额释放

1. 确认生效上限为「开放子线程 1（不含主线程）」，记录配置来源。
2. A 仍开放时，让父 Agent 启动同角色 B。**预期**：B 启动失败，返回限额/并发错误；记录原文与全部开放线程。
3. 关闭 A（宿主"关闭线程"，不是 cancel/complete）；报告关闭结果。
4. 再次启动同角色 B，调用同一 MCP 并回读结果；完成后关闭 B。**预期**：B 成功，最终无开放子线程。

**失败判定**：A 尚开放时 B 启动成功（先确认是否真的同 session/同上限）；关闭 A 后 B 仍失败；用取消或完成代替关闭；只看 UI 状态不记录错误原文。

## 5. worktree 归属

在父会话、A、B 分别执行：

```powershell
Get-Location
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --git-common-dir
git worktree list --porcelain
```

| 观察 | 结论 |
|------|------|
| common-dir 相同 | 同一仓库，仅证明同源，不证明隔离 |
| 顶层路径相同 | 可能共享目录；POC **不宣称写隔离** |
| 顶层路径不同 + git-dir 不同 | 支持独立 worktree；仍需 worktree 列表佐证 |
| worktree 列表出现新条目 | 记录路径/分支/HEAD，区分"条目存在"与"聊天归属" |

**预期**：POC 只要求如实记录父/A/B 的 cwd 与 Git 输出，并对照 `git worktree list --porcelain`；托管目录默认 `$CODEX_HOME/worktrees`，可被 Settings → Worktrees 的 root 改写。

**失败判定**：把"同一仓库"说成"独立 worktree"；把聊天 worktree 当成子 Agent 自动隔离；只截 UI 不记录命令原文。

## 6. 判定汇总

| 项 | PASS 证据 | FAIL 判定 |
|----|-----------|-----------|
| 角色/MCP 注册 | 设置页连接 + 两个工具 + 真实调用 | 列表缺失、连接错误、工具缺失 |
| 角色注入 | 原始角色表含两个 id/name；串行启动两个角色各见标记 | 只有人设标记、角色表缺项或臆造 |
| 第二角色 | C 首行 `POC_TANGSENG` + 工具轨迹 | 与 A 并发混淆、只有自述 |
| 工具调用 | `list_roles` / `get_task` 原始 JSON | 自述成功、错误码与断言不符 |
| 回读 | 活动线程 + 父会话 + 工具轨迹一致 | 仅最终文本或仅父会话摘要 |
| 取消 | 等待中中断且状态为 cancelled/interrupted | 自然结束、取消后仍跑完 |
| 并发放槽 | 限额错误 → 关闭 A → B 成功 → 无开放线程 | 取消/完成代替关闭、B 仍失败 |
| worktree | 三组命令原文 + 列表对照 | 把同源当隔离、只截图 |

全部 PASS → 真机闭环通过；任一 FAIL → 记录证据并只给部分闭环；未取证的写「未验证」。

## 7. 清理与回滚

1. 关闭测试会话，确认无运行中的子线程/任务。
2. 删除测试项目 `.codex/agents/meetingstone_wukong.toml`、`meetingstone_tangtang.toml`。
3. 从测试项目 `.codex/config.toml` 删除 `meetingstone_poc` 条目（或恢复备份）；重启宿主确认条目消失。
4. 保留日志/截图/原始输出作为证据；不要删除同目录其他角色、MCP 或其他配置。
5. 归档/删除 worktree 属于另一生命周期，不能代替第 4 节的"关闭线程"证据。

## 8. 未验证项（必须保留）

1. 本机 Codex 版本是否加载 `.codex/agents/*.toml` 及信任策略。
2. 设置页/MCP 状态的实际展示与 `/mcp` 行为。
3. 取消后 MCP server 与工具进程的生命周期。
4. 真实并发名额释放时机与错误文案。
5. 子 Agent 的工作目录是否自动独立 worktree。
6. 跨角色工具授权隔离；`readOnlyHint` 不是 ACL。
7. 宿主重启后的配置恢复与会话恢复。

## 9. 参考

- [README.md](README.md)（协议、工具、离线结果）
- [Subagents：角色格式、继承、线程控制、并发](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Configuration Reference：并发设置与旧别名](https://learn.chatgpt.com/docs/config-file/config-reference)
- [MCP：stdio 注册、过滤与桌面设置](https://learn.chatgpt.com/docs/extend/mcp)
- [Worktrees：聊天关联与默认位置](https://learn.chatgpt.com/docs/environments/git-worktrees)
