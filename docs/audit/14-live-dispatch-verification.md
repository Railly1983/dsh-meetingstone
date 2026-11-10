# 14 · 真机派单链路验证（2026-11-10）

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
| 只读通道（`permissionPreset: read-only` 的实例） | 通道实例只能写在 profile 的全局 Config，需改配置 + 重启 |
| 外部 provider（codex / acp）通道 | 需先装对应 bundle（隔离已验证配置组合，未在 desktop 装） |
| 任务结果回读（子 Agent 到底输出了什么） | 当前只有 `list_roles` / `dispatch` / `cli_status`，缺 `get_task` |
| 取消任务 | 同上，缺 `cancel_task` 工具 |

## 5. 结论

**P2 的核心目标（按角色把任务派给宿主 provider 并拿到原生引用）已在真机达成。**
剩余的是"读回结果 / 取消 / 只读实例 / 外部 provider"这类补全，属于 P2 收尾 + P3 范畴。


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

### 6.3 只读拒绝（READONLY_UNENFORCEABLE）

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
