# 14 · 真机派单链路验证（2026-11-10）

> **2026-11-11 移除声明**：本文出现的 `readOnly` / `readOnlyEnforced` / `permissionPreset` /
> `READONLY_UNENFORCEABLE` 均为历史记录。只读通道已彻底移除（宿主 subagent spec 无权限字段，
> 做不到绝对只读），**不要再实现**。

> 目的：证明「角色解析 → 通道选择 → 宿主 `ctx.subagents` → 原生任务引用」在**真实 DSH 会话**里跑通。
> 环境：DSH `0.2.2-rc.1`，`desktop` profile，插件以本地链接安装（`D:\MeetingStone`）。
> 全部操作都通过插件自己的工具完成，未改 profile 配置。

## 1. 前置

| 项 | 状态 |
| --- | --- |
| 插件加载 | ✅ 三个工具可用 |
| 项目级配置 | `.meetingstone.json`（`role-selftest` spawn / `role-selftest-fork` fork，均 `project-write`） |
| provider | `spawn` / `fork` 随宿主，`availability: "available"` |

## 2. 验证步骤与结果

### 2.1 角色表（含来源与可用性）

```json
{"roles":[
  {"roleId":"role-selftest","name":"自检员","aliases":["SELFTEST"],"channel":{"kind":"in-process","provider":"spawn"},"permissionPreset":"project-write","enabled":true,"availability":"available","source":"project"},
  {"roleId":"role-selftest-fork","name":"自检员B","aliases":["SELFTESTB"],"channel":{"kind":"in-process","provider":"fork"},"permissionPreset":"project-write","enabled":true,"availability":"available","source":"project"}
],"errors":[],"projectScoped":true}
```

结论：项目级配置读取、来源标注（`source: "project"`）、provider 可用性查询均正常。

### 2.2 派单（spawn 通道）

请求：`meetingstone_dispatch({ role: "SELFTEST", task: "只回复三个字母 PONG…" })`

```json
{"ok":true,
 "taskRef":{"kind":"subagent-activation","provider":"spawn",
            "childId":"d52874f6-50e6-41fc-82db-218dd8950ff3",
            "readOnlyEnforced":false,"startedAt":1794305125745},
 "role":{"roleId":"role-selftest",...},"readOnly":false}
```

### 2.3 原生可见性

派单后立即查宿主原生 `list_agents`：

```
d52874f6-50e6-41fc-82db-218dd8950ff3 [running] — meetingstone:role-selftest
```

约 25 秒后再查：同一 id 变为 `[inactive]`。

**结论**：进程内通道的子 Agent **确实进入原生 subagent 目录**，label 来自适配器（`meetingstone:<roleId>`）。
> P0-1 起 label 改为统一命名 `角色简称 · 简短目标（≤14 字）`，不再出现 `meetingstone:` 前缀；
> 本行保留当时真机输出作为历史证据。
⚠️ 这修正了 `audit/06-ui-visibility.md` 的早期结论——那条结论针对的是**外部 CLI** Worker，不适用于 in-process 通道。

### 2.4 并发纪律（写任务串行）

在第一个任务仍 `running` 时再次派单：

```json
{"ok":false,"code":"WRITE_CONFLICT","message":"同一项目已有写任务在执行；写任务默认串行（可在项目配置里调整）"}
```

**结论**：`先占槽再启动` 在真机生效（旧实现是"两个都成功"）。

### 2.5 槽位释放（onFinish）

第一个任务 `inactive` 后再派（fork 通道）：

```json
{"ok":true,"taskRef":{"provider":"fork","childId":"f8b00633-4f82-4f2c-a292-0335770dd0fd",...}}
```

**结论**：适配器在任务终态回调 `onFinish`，dispatcher 幂等释放槽位——否则这里仍会 `WRITE_CONFLICT`。

## 3. 过程中发现并修掉的三个真机问题

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| `cannot get property "subagents" without inject` | Cordis 里访问未 inject 的服务会抛 | `inject` 加 `subagents` + `safeService()` 兜底 |
| `MODEL_UNSUPPORTED`（配置的模型永远不生效） | registry 的 channel 字段白名单漏了 `channelId` | 白名单补 `channelId`，加端到端回归 |
| `Cannot read properties of undefined (reading 'maxDepth')` | **运行时 `startActivation` 读 `spec.request.*`，与官方文档的扁平签名不一致** | 适配器改为嵌套 `request` 结构；测试桩按宿主行为校验形状 |

第三条的定位方式值得记：从 `app.asar` 提取 `dsh-subagent/lib/index.js` 直接读实现（`scripts/asar-extract.mjs`），不再靠猜。

## 4. 仍未验证

| 项 | 原因 |
| --- | --- |
| 只读通道（`permissionPreset: read-only` 的实例） | **已移除，不要再实现**（2026-11-11）：宿主 spec 无权限字段，做不到绝对只读 |
| 外部 provider（codex / acp）通道 | 需先装对应 bundle（隔离已验证配置组合，未在 desktop 装） |
| 任务结果回读（子 Agent 到底输出了什么） | 当前只有 `list_roles` / `dispatch` / `cli_status`，缺 `get_task` |
| 取消任务 | 同上，缺 `cancel_task` 工具 |

## 5. 结论

**P2 的核心目标（按角色把任务派给宿主 provider 并拿到原生引用）已在真机达成。**
剩余的是"读回结果 / 取消 / 外部 provider"这类补全，属于 P2 收尾 + P3 范畴。
（原文中的"只读实例"已于 2026-11-11 随只读通道整体移除，不要再实现。）


## 6. 补验（2026-11-10 第二次重启后）

工具补齐到 5 个后，又跑了一轮：

### 6.1 结果回读（get_task）

```json
// dispatch
{"ok":true,"taskRef":{"provider":"spawn","childId":"8a214462-64ac-4f74-a14d-b0aaa2e11d5d",...}}
// get_task（约 1 秒后）
{"childId":"8a214462-64ac-4f74-a14d-b0aaa2e11d5d","status":"completed","stopReason":"completed","output":"PONG"}
```

**结论**：子 Agent 的真实输出可以被读回，不是"派出去就不知道结果"。

### 6.2 取消（cancel_task）

```
dispatch(数到 300) → childId b275997f-...
cancel_task(b275997f-...) → {"ok":true,"cancelled":true}
get_task(b275997f-...) → {"status":"cancelled","output":""}
list_agents → b275997f-... [inactive]
```

取消后立刻再派一个写任务 → 成功，**说明槽位随取消一起释放**。

### 6.3 只读拒绝（READONLY_UNENFORCEABLE）— 历史记录，功能已移除

> **2026-11-11 注**：本节的只读拒绝路径已随只读通道整体删除，`READONLY_UNENFORCEABLE` 错误码不存在了。
> 保留原文仅作历史证据，**不要再实现**。

项目配置里加了一个只读角色，但没有引用任何通道实例：

```json
{"ok":false,"code":"ADAPTER_FAILED","message":"派发失败：READONLY_UNENFORCEABLE: 角色是只读档位，但没有引用任何通道实例，无法确认该通道真的只读。请在配置的 channels 里声明一个 permissionPreset: read-only 的实例，让角色用 channelId 引用它"}
```

拒绝符合预期（未启动任何子任务）。**改进已提交**：适配器前置校验的错误码现在会透传（`READONLY_UNENFORCEABLE` 不再被包成 `ADAPTER_FAILED`），下次重启生效。


## 7. 外部 CLI 通道验证成功（2026-11-10 20:57）

配置路径：`desktop` profile 安装 `@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1`，
并在 `cordis.patch.yml` 里给 provider 行显式指定 `model: gpt-5.6-sol`
（原因见 §7.1）。

```json
// dispatch(role=SELFTESTCODEX)
{"ok":true,"taskRef":{"provider":"codex","childId":"1adb5b02-3fef-4bab-a415-1b9ec27e2bc7",...}}
// get_task
{"status":"completed","stopReason":"completed","output":"PONG"}
```

**结论：角色 → 外部 CLI（Codex）→ 真实输出，端到端打通。**

### 7.1 关键坑：pinned Codex 的模型限制

provider bundle 自带 `@openai/codex@0.153.4`，它继承 `~/.codex/config.toml` 的模型设置。
本机 config 写的是 `gpt-6.1-sol`，在 **ChatGPT 账号**下被服务端拒绝：

```
400 invalid_request_error: The 'gpt-6.1-sol' model is not supported
when using Codex with a ChatGPT account. (code: model_not_found)
```

用 provider 自带的 CLI 直接实测（`node <profile>/node_modules/@openai/codex/bin/codex.js exec -m <model> ...`）：

| 模型 | 结果 |
| --- | --- |
| **gpt-5.6-sol** | ✅ 返回 PONG |
| gpt-6.1-sol / gpt-6-sol / gpt-5-codex / gpt-6-luna | ❌ 400 model_not_found |

因此 provider 行必须显式配置模型：

```yaml
- id: subagent-codex
  config:
    providerName: codex
    model: gpt-5.6-sol
    permissionMode: never
```

这也再次验证 DD7 的判断：**模型只能由 provider 行承载**，插件层写 model 无意义。

## 8. CodeBuddy（acp）通道验证成功（2026-11-10 21:46）

前置两件事：

1. 装 `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.1`——它**不声明 `dsh.bundle`**，只装依赖、不产生配置层。
2. 在 profile 的 `cordis.patch.yml` 里**用 `insert:` 包裹**新增一行。

```yaml
- insert:
    - id: subagent-acp
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: acp
        command: '<宿主 node.exe>'
        args: ['<codebuddy bin 脚本>', '--acp']
        permission: allow
```

结果：

```json
{"ok":true,"taskRef":{"provider":"acp","childId":"03fbdc25-f789-4098-8e0e-6e73f5c56a18"}}
{"status":"completed","stopReason":"completed","output":"PONG"}
```

### 8.1 两个关键坑（都踩过）

| 坑 | 事实 |
| --- | --- |
| **stdin 必须保持打开** | `codebuddy --acp` 启动后立刻关 stdin 会崩在 headless 初始化（`Failed to start the backend application`）。早期探测因此误判"不可用"。单独验证过 ACP 握手（`initialize` → 返回 `agentCapabilities`） |
| **insert 包裹** | 用户补丁里裸的 `- id: xxx` 表示**覆盖已存在行**；目标行不存在时被**静默忽略**（现象：插件清单里根本没有该行，也没有 failed 记录）。新增行必须写在 `- insert:` 列表下 |

### 8.2 角色人设注入（替代 CLIWorker 的 persona）

派单提示词形如：`你是「沙僧」。<prompt>\n\n任务：<task>`。
`prompt` 缺失时回退到 `description`，两者都没有则只发任务正文。已加回归测试。

**真机验证**（2026-11-10 21:50）：派单给 CodeBuddy 角色，任务为「只回复你的角色名」：

```json
{"status":"completed","output":"自检员CodeBuddy"}
```

子 Agent 能报出角色名，证明角色身份确实随提示词传到了外部 CLI。

### 8.3 三条通道汇总

| 通道 | 状态 | 备注 |
| --- | --- | --- |
| `in-process`（spawn/fork） | ✅ | 原生可见、并发串行、槽位释放均已验证 |
| `codex` | ✅ | 模型必须固定在 provider 行（账号仅接受 `gpt-5.6-sol`） |
| `acp-cli`（CodeBuddy） | ✅ | stdin 常开 + node 启动 bin |


## 9. 新版 Codex 接入（2026-11-10 23:00）

结论：**provider 的 pinned 版本可以换掉**，方法是物理镜像嵌套依赖（见 docs/installation.md）。

关键事实：

| 事实 | 证据 |
| --- | --- |
| provider 在自己包内解析 codex | `createRequire(import.meta.url).resolve("@openai/codex/package.json")` |
| profile 的 `pnpm.overrides` 无效 | 写入后重装仍解析到 0.153.4 |
| 新版协议兼容 | 用 0.167 复现 initialize → thread/start → turn/start → turn/complete，返回 PONG |
| 模型目录由版本决定 | 0.167 下 gpt-6.1-sol / gpt-5.6-sol / gpt-6-astra / gpt-6-luna 全部可用；0.153.4 只认 gpt-5.6-sol |
| 端到端 | dispatch(role=SELFTESTCODEX) → `{"output":"PONG\nGPT-6"}` |

**教训**：把"官方 pinned"当成不可改的约束，是没查实现就下的结论。
