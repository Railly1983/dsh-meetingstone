# WorkBuddy 子集原型：角色 + Skill + MCP（2026-11-11）

状态：**样例 / POC，未安装**。本目录只提供可复制的文件、协议骨架和安装文档；没有写入 `~/.workbuddy`，没有修改项目 `.workbuddy`，没有启动 WorkBuddy 桌面会话，也没有调用真实模型。完整桌面接入的结论是 NO-GO，角色 Markdown + Skill + MCP 子集是 GO，依据见[可行性验收报告](../../audit/cross-host/workbuddy-20261111/report.md)。

这个原型要证明的只有一件事：WorkBuddy 能发现三个角色 Markdown，并能通过 stdio MCP 调用一个只读工具。它**不**提供程序化桌面控制、任务派单、取消、worktree 管理或模型选角保证。

## 1. 文件清单

| 路径 | 用途 |
|------|------|
| [agents/meetingstone-executor.md](agents/meetingstone-executor.md) | 执行角色「沙僧」，对应 `role-sashi`；可改文件并跑验证 |
| [agents/meetingstone-reviewer.md](agents/meetingstone-reviewer.md) | 评审角色「悟空」，对应 `role-wukong`；只读审查 |
| [agents/meetingstone-researcher.md](agents/meetingstone-researcher.md) | 调研角色「斥候」，对应 `role-scout`；只读调查 |
| [skills/meetingstone-role-routing/SKILL.md](skills/meetingstone-role-routing/SKILL.md) | 可选 Skill：按任务路由到执行/评审/调研角色 |
| [mcp.json](mcp.json) | 用户级/项目级 MCP 注册片段，启动 `server.mjs` |
| [server.mjs](server.mjs) | 零依赖 stdio MCP server；固定角色表，只读 |
| [smoke.mjs](smoke.mjs) | 离线自检：协议三条路径、错误码、角色/Skill frontmatter、配置与本地链接 |
| README.md | 本文件 |

三个角色都使用 WorkBuddy 用户级 Agent 的 frontmatter：`name`、`description`、`mainAgent: true`，外加一个真实限制工具面的 `tools` 白名单。正文是中文 prompt，会被追加到宿主的 Standard system prompt 后面。`model` 故意不写，让它继承父会话模型，因为真实模型 ID 和选角未验证。

另附一个可选 Skill：它不改变三个角色或 MCP 的行为，只给主 Agent 一张「任务 → 角色」路由表和调用约定。不安装 Skill 也能单独使用角色和 MCP。

## 2. 前置条件

- WorkBuddy 桌面版。本机被检查的是 5.9.3；其他版本是否接受同样的文件格式未验证。
- Node.js ≥ 18（本机 `v20.16.0`），且 `node` 能从 WorkBuddy 进程的 PATH 找到。GUI 启动的应用可能不继承终端 PATH；找不到时在 `mcp.json` 里把 `command` 改成 `node` 的绝对路径。
- 默认配置根是 `~/.workbuddy`（Windows 为 `C:\Users\<用户名>\.workbuddy`）。如果设置过 `CODEBUDDY_CONFIG_DIR` 或其他自定义配置根，以实际根为准。
- 只操作本目录和复制目标；不要改仓库源码或用户的其他配置。

## 3. 安装（尚未执行）

### 3.1 复制角色

在 `docs/cross-host/workbuddy-poc` 目录执行：

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$HOME\.workbuddy\agents" | Out-Null
Copy-Item .\agents\*.md "$HOME\.workbuddy\agents\"
```

```bash
# macOS / Linux
mkdir -p ~/.workbuddy/agents
cp agents/*.md ~/.workbuddy/agents/
```

文件名必须与 frontmatter 的 `name` 一致（`meetingstone-executor.md` ↔ `meetingstone-executor`）。复制后重启 WorkBuddy 或新建会话；按包内 agent authoring 指南，`mainAgent: true` 的文件应出现在 Agent 预设选择器中。**是否真的出现、显示成什么名字，未实测。**

### 3.2 复制 Skill（可选）

不装 Skill 不影响角色和 MCP。需要路由表时，在 `docs/cross-host/workbuddy-poc` 目录执行：

```powershell
# Windows PowerShell；默认技能目录为 ~/.workbuddy/skills
New-Item -ItemType Directory -Force "$HOME\.workbuddy\skills\meetingstone-role-routing" | Out-Null
Copy-Item .\skills\meetingstone-role-routing\SKILL.md "$HOME\.workbuddy\skills\meetingstone-role-routing\"
```

```bash
# macOS / Linux
mkdir -p ~/.workbuddy/skills/meetingstone-role-routing
cp skills/meetingstone-role-routing/SKILL.md ~/.workbuddy/skills/meetingstone-role-routing/
```

技能目录由包内 `PathUtils.getHomeSkillsDir()` 解析为 `<配置根>/skills`；自定义配置根会改变位置。Skill 的实际发现与加载未实测。

### 3.3 注册 MCP

先把 [mcp.json](mcp.json) 里的路径改成这台机器上的真实绝对路径。JSON 中反斜杠必须转义，推荐全部用 `/`：

```json
{
  "mcpServers": {
    "meetingstone-poc": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/path/to/MeetingStone/docs/cross-host/workbuddy-poc/server.mjs"
      ]
    }
  }
}
```

然后二选一，首次测试不要同时写两处，避免重复注册和优先级干扰：

- 用户级：`~/.workbuddy/mcp.json`（所有项目可见）
- 项目级：`<仓库根>/.workbuddy/mcp.json`（只在该项目可见）

重启 WorkBuddy，新建会话，在 MCP 设置/工具列表里找 `meetingstone-poc` 和工具 `meetingstone_list_roles`。实际菜单名称和位置随版本变化，本目录未截图验证。

## 4. 验证

### 4.1 离线自检（已执行，见下）

```powershell
node --check docs/cross-host/workbuddy-poc/server.mjs
node --check docs/cross-host/workbuddy-poc/smoke.mjs
node docs/cross-host/workbuddy-poc/smoke.mjs
```

期望输出 10 条 `PASS ...` 明细加最后一行 `PASS: WorkBuddy POC self-check`，退出码 0。自检会真正 spawn `server.mjs`，逐行发 JSON-RPC，并检查：

- `initialize` 协商 `2025-06-18`、`tools` 能力、`serverInfo`；
- 通知不产生响应；
- `tools/list` 只有一个工具，输入 schema 封闭，`readOnlyHint: true`；
- `tools/call` 返回固定的三条角色记录；
- `-32700` 解析错误、`-32600` 非法请求、`-32601` 未知方法、`-32602` 非法参数；
- 三个角色文件的 frontmatter、工具白名单、中文正文；
- 可选 Skill 的 frontmatter、中文正文和路由表；
- `mcp.json` 指向 `server.mjs`；
- README 本地链接都能解析；
- `server.mjs` 只依赖 `node:` 内置模块。

### 4.2 WorkBuddy 内验证（未执行）

1. 记录 WorkBuddy 版本、OS、时间、配置根，以及是否修改过 `CODEBUDDY_CONFIG_DIR`。
2. 新建会话，打开 Agent 预设选择器，确认出现 `meetingstone-executor`、`meetingstone-reviewer`、`meetingstone-researcher`；记录实际显示名和是否可选。
3. 打开 MCP 设置或工具列表，确认 `meetingstone-poc` 状态为已连接，且能看到 `meetingstone_list_roles`。
4. 选 `meetingstone-reviewer`，发送：`调用 meetingstone_list_roles，原样返回 JSON，并报告你的角色名和工具可见性；不要修改文件。`
5. 回读工具调用轨迹和原始 JSON。预期 `roles` 精确包含 `role-sashi/沙僧`、`role-wukong/悟空`、`role-scout/斥候`，每项带 `workbuddyAgent` 映射。
6. 逐项标 PASS / FAIL / 未验证。**只看模型自述不算通过**，必须有工具调用记录或界面状态；列表出现也不等于工具调用成功。

建议证据模板：版本｜时间｜操作｜原始返回｜界面截图｜结论｜未验证项。

## 5. 与集合石主控的关系

```text
用户 → WorkBuddy 主 Agent → 选择预设（执行 / 评审 / 调研）
                         → 调用 meetingstone_list_roles（只读、固定数据）
                         → 结果留在当前会话，由主 Agent 编排

集合石 / DSH → 外部 CLI 派单、预算、worktree、取消（另一条链路）
```

- WorkBuddy 内的角色由主 Agent 按预设或技能选择；MCP 只提供只读查询，不承担派单。
- 集合石继续负责外部 CLI 的确定性调度、任务状态和取消；WorkBuddy 桌面没有公开的 session/prompt/cancel 入口，不能用本原型模拟这些能力。
- 角色表是**固定快照**，不读取 `.meetingstone.json`。当前快照里的 `role-scout` 来自[示例项目角色](../../../examples/project.meetingstone.json)；全局配置里如果没有这个角色，需要同时改 [server.mjs](server.mjs) 和 [smoke.mjs](smoke.mjs) 的期望值。
- 如果以后需要真实派单，走集合石现有 UI/DSH 或 CodeBuddy 官方 ACP，不要把本 MCP server 扩成桌面控制接口。

## 6. 协议与错误码

传输：stdin/stdout 上按行分隔的 JSON-RPC 2.0（UTF-8，一行一个对象）。stdout 只写协议消息；stderr 只用于内部诊断，正常运行时为空。stdin EOF 后进程正常退出（exit 0）。

| 方法 | 行为 |
|------|------|
| `initialize` | 回显受支持的 `protocolVersion`（不在列表中则回 `2025-06-18`），声明 `tools` 能力 |
| `notifications/initialized`、其他通知 | 不响应（JSON-RPC 通知语义） |
| `ping` | 返回 `{}` |
| `tools/list` | 返回唯一工具 `meetingstone_list_roles` |
| `tools/call` | 只接受该工具名；`arguments` 省略或 `{}`；返回固定角色表 |
| 其他带 id 的方法 | `-32601` |

| 错误码 | 含义 |
|--------|------|
| `-32700` | JSON 解析失败（id 为 null） |
| `-32600` | 非法请求：非对象、缺 `jsonrpc`/`method`、非法 id、批量数组（id 为 null） |
| `-32601` | 未知方法 |
| `-32602` | 非法参数：`params` 不是对象、未知工具、参数不是对象、传了多余参数 |
| `-32603` | 内部错误（正常路径不会出现） |

工具执行失败在 MCP 里应返回 `result.isError: true` 的 content，而不是 JSON-RPC 错误；本工具没有失败路径，所以只覆盖协议错误。

## 7. 安全边界

- `server.mjs` 没有文件、网络、环境变量或子进程访问；角色表是内存里的冻结常量。只读性来自这一点，不来自 `readOnlyHint`。
- MCP 工具注解（`readOnlyHint` 等）只是提示，不是 ACL；实际权限由 WorkBuddy 和宿主策略决定。
- 角色 frontmatter 的 `tools` 是宿主侧的白名单请求；它是否被桌面版严格执行未验证，不能当作安全边界。
- 评审/调研角色没有 `Write`、`Edit`、`Bash`；执行角色有写工具，靠任务范围和 prompt 约束，不是沙箱。
- 不要把凭据写进 `mcp.json`；本 server 不需要任何密钥。保持 stdio，不要暴露到网络。

## 8. 未验证项（必须保留）

1. WorkBuddy 5.9.3 是否真的从 `~/.workbuddy/agents` 加载这三个文件并显示在预设选择器里。
2. `mainAgent: true` 在桌面版的行为是否与包内 CLI 指南一致。
3. `~/.workbuddy/mcp.json` 与项目 `.workbuddy/mcp.json` 的实际合并/优先级，以及是否需要重启。
4. MCP server 是否真的被桌面拉起、工具是否出现在每个角色的工具列表中。
5. 可选 Skill 是否从 `~/.workbuddy/skills/meetingstone-role-routing` 被发现和加载。
6. 真实模型选角：`model` 省略后继承哪个模型、不同角色的工具可用性差异。
7. 桌面版是否严格执行 frontmatter 的 `tools` 白名单。
8. 真实 WorkBuddy 内的角色/MCP 设置页面名称、状态展示和错误提示。
9. 打包成专家团（`plugin.json`、`settings.json`、`agents/*.md` 不同 frontmatter）的安装与上架路径；本原型没有包含。
10. 跨平台差异；本轮只检查了 Windows 上的 WorkBuddy 5.9.3 文件和 Node v20.16.0。

## 9. 卸载

删除复制到 `~/.workbuddy/agents/` 的三个 `meetingstone-*.md`，删除 `~/.workbuddy/skills/meetingstone-role-routing/`（如果安装过），从 `~/.workbuddy/mcp.json` 或项目 `.workbuddy/mcp.json` 删除 `meetingstone-poc` 条目，重启 WorkBuddy。不要删除同目录下其他角色、Skill 或 MCP 配置。

## 10. 依据

已检查的本机 WorkBuddy 包内材料（ASAR unpacked，仅读取）：

- `resources/plugins/workbuddy-builtin/skills/expert-manager/references/agent-md-spec.md`：专家团 Agent MD 的 frontmatter 规范（注意：与用户级 Agent 不同）。
- `resources/plugins/workbuddy-builtin/builtin-plugins/workbuddy-docx/agents/doc-writer.md`：真实 agent Markdown 样例。
- `node_modules/@genie/agent-harness/cli/dist-server/shared.cjs`：用户级 Agent 发现与解析逻辑；其中的 agent authoring 指南写明 `name`、`description`、`mainAgent: true` 和 `tools` 的用法。
- 包内 `weixinpay/.mcp.json`、`miora-mcp/.mcp.json`：`mcpServers` + `type: stdio` + `command`/`args` 的配置形状。

官方文档（外部链接，版本以目标宿主为准）：

- [WorkBuddy MCP 配置指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)
- [WorkBuddy 插件](https://www.codebuddy.cn/docs/workbuddy/Plugins)
- [专家团分发格式](https://open.workbuddy.cn/docs/expert-team)

离线自检不能替代真实宿主验收；本目录的结论只覆盖文件格式、协议骨架和离线自检。
