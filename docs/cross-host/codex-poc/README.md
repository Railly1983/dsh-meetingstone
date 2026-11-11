# Codex 宿主最小闭环 POC（2026-11-11）

状态：**离线骨架完成、离线自检 PASS；真机联调未执行**。Codex 额度暂不可用，本轮不安装、不注册、不写 `~/.codex`、不启动付费 Agent。
真机步骤、预期输出与失败判定见 [ACCEPTANCE.md](ACCEPTANCE.md)；离线结果只覆盖文件格式与协议骨架，不能替代真机验收。

## 1. 文件清单

| 路径 | 用途 |
|------|------|
| [server.mjs](server.mjs) | 零依赖 stdio MCP server；两个只读工具 |
| [smoke.mjs](smoke.mjs) | 最小协议冒烟：握手、工具发现、两次调用、错误、EOF |
| [verify-offline.mjs](verify-offline.mjs) | 完整离线自检：语法、角色 TOML、注册片段、本地链接、协议、schema |
| [meetingstone_wukong.toml](meetingstone_wukong.toml) | 角色「悟空 · 只读核验」 |
| [meetingstone_tangtang.toml](meetingstone_tangtang.toml) | 角色「唐僧 · 评审与验收」 |
| [config.example.toml](config.example.toml) | 项目级 `.codex/config.toml` 注册片段（示例，未应用） |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 额度恢复后的真机联调清单 |

角色显示名遵循 `角色简称 · 目标`（分隔符见 [src/naming.js](../../../src/naming.js) 的 `LABEL_SEPARATOR`）；TOML 的 `name` 是宿主标识符，必须与文件名一致，不能含空格或 `·`。

## 2. 工具

| 工具 | 参数 schema | 返回 |
|------|-------------|------|
| `meetingstone_list_roles` | 可选 `roleIds: string[]`（`items.type: string`），`additionalProperties: false` | 固定角色快照；未知 id 进 `unknownRoleIds`，不编造角色 |
| `meetingstone_get_task` | 必填 `childId: string`（1–128 字符），`additionalProperties: false` | 只读占位：`{"status":"NOT_FOUND",...}`，`isError:false` |

两个工具都带 `readOnlyHint: true`、`destructiveHint: false`、`idempotentHint: true`。注解只是提示，不是 ACL；只读性来自 `server.mjs` 没有文件、网络、子进程访问，角色表是内存冻结常量。

`meetingstone_get_task` 不读 `.meetingstone/runs`，任何 `childId` 都返回 `NOT_FOUND`。这是查询结果而不是协议错误，所以 `isError` 保持 `false`；协议错误仍用 `-32602`。

## 3. 离线自检（本机已执行）

前置：Node ≥18（本机 `v20.16.0`）、Git。在仓库根执行：

```powershell
node --check docs/cross-host/codex-poc/server.mjs
node --check docs/cross-host/codex-poc/smoke.mjs
node --check docs/cross-host/codex-poc/verify-offline.mjs
node docs/cross-host/codex-poc/smoke.mjs
node docs/cross-host/codex-poc/verify-offline.mjs
```

预期：smoke 打印一行 `PASS: handshake, silent notification, 2 read-only tools, calls, ping, errors, EOF exit`；verify 每条 `PASS ...`，末行 `PASS: offline self-check (N passed)`，退出码 0。

2026-11-11 本轮结果：

- 三个 `node --check` 均 exit 0；smoke 与 verify 均 PASS。
- 环境：Windows、Node `v20.16.0`；**本会话未出现 EPERM**（当前 DSH profile 为 danger-full-access）。
- 历史限制：Node 内部 `spawnSync` 曾被沙箱拒绝（EPERM）。若再次出现，改用独立 stdio 管道模式，不改变沙箱配置：

```powershell
node docs/cross-host/codex-poc/smoke.mjs --requests |
  node docs/cross-host/codex-poc/server.mjs |
  node docs/cross-host/codex-poc/smoke.mjs --verify
```

`--verify` 只断言协议输出，驱动方另验 server 退出码和 stderr；也可用 Python 标准库 `subprocess` 以同样方式喂 stdin。`verify-offline.mjs --strict` 会把 SKIP 视为失败，便于 CI。

## 4. 协议与错误码

stdin/stdout 按行分隔 JSON-RPC 2.0；stdout 只写协议消息，stderr 正常为空；stdin EOF 后 exit 0。

| 方法 | 行为 |
|------|------|
| `initialize` | 回显受支持的 `protocolVersion`；不支持时回 `2025-06-18`；声明 `tools` 能力 |
| 通知（无 `id`） | 不响应 |
| `ping` | 返回 `{}` |
| `tools/list` | 返回两个工具及显式 schema |
| `tools/call` | 校验工具名、参数对象、必填/多余字段；成功返回 `content` + `isError:false` |
| 其他带 `id` 的方法 | `-32601` |

| 错误码 | 触发 |
|--------|------|
| `-32700` | 坏 JSON（id 为 null） |
| `-32600` | 非对象、缺 `jsonrpc`/`method`、批量数组、非法 id（id 为 null） |
| `-32601` | 未知方法 |
| `-32602` | 未知工具、参数非对象、缺必填、类型错误、多余参数 |

## 5. 边界与未验证

- **未声称已真机验证**：Codex 桌面/内置 CLI 的 TOML 加载、MCP 连接、子 Agent 启动、取消、并发名额与 worktree 行为均未验证。
- **不改宿主机文件**：本轮只写本目录；不写 `~/.codex`、不合并用户级配置、不安装依赖。
- 角色继承父会话 MCP；角色 TOML 不能覆盖 `mcp_servers`；`enabled_tools` 是父会话服务器级过滤，不是角色 ACL。
- 并发上限、取消/关闭语义、worktree 归属与 `$CODEX_HOME/worktrees` 位置以目标宿主版本为准，见 [ACCEPTANCE.md](ACCEPTANCE.md)。
- 当前目录是集合石已有的隔离 worktree：`git rev-parse --git-common-dir` 为 `D:/MeetingStone/.git`，这只证明本会话的落点，不构成 Codex 子 Agent 隔离证据。

## 6. 官方依据（格式/策略以目标宿主版本为准）

- [Subagents：角色格式、继承、线程控制、并发](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Configuration Reference：并发设置与旧别名](https://learn.chatgpt.com/docs/config-file/config-reference)
- [MCP：stdio 注册、过滤与桌面设置](https://learn.chatgpt.com/docs/extend/mcp)
- [Worktrees：聊天关联与默认位置](https://learn.chatgpt.com/docs/environments/git-worktrees)
