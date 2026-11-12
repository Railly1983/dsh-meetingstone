# 2026-11-13 「插话」误导性设计修复

> 角色：悟空（核心资深专家）。约束：不重启 DSH、不改 profile、不装包、不打扰其它 Agent。
> 核心原则：**把「做不到」在点击前就说清楚，而不是事后在回执里解释。**

## 结论速览

- 用户点的「插话」是 **DeepSeek Harness 宿主聊天输入框的「插话发送 / Steer」发送模式按钮**，不是本插件的 UI。**我们改不了它的标签，也改不了它的点击行为。**
- 真正「承诺了做不到的事」的地方在 `meetingstone_steer_task` 的**工具描述**：它以「中途插话」开头，把「外部 CLI 会杀掉重来」放在中段，并写明「回执里的 mode 会明确区分」——把真相推迟到了**事后**。而 `.meetingstone.json` 里 7 个角色有 6 个走外部 CLI（acp / claude-code / codex），也就是说**默认路径恰恰是不支持插话的那条**。
- 采用 **方案 C（+ 方案 A 应用到我们自己的文案）**：工具描述改为「调用前必读」并前置后果；`list_runs` / `get_task` 返回里加 `steerMode` / `steerNote` 事前标注。**不做方案 B**（宿主按钮无插件确认钩子）。
- 验证：披露检查 31 PASS / 0 FAIL；`run-tests` 689 tests / 688 pass / 0 fail / 1 skipped；`release-check --version 0.1.0-alpha.26` **10 PASS**。基线原样保持。

---

## 1. 用户点的入口到底是什么（附证据）

### 1.1 判定：宿主的，不是插件的

宿主 `app.asar` 的位置：`C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（213 MB）。
在其中按 UTF-8 搜「插话」有 9 处命中，定位到的文件是：

- `dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`（宿主会话 UI 包）
- `dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/README.zh.md`

`lib/client.js` 里的 locale 字典（逐字摘录，完整上下文见产物 `host-asar-steer-locale.log`）：

```
"placeholder.steerQueue": "Cmd/Ctrl+Enter 插话发送全部排队消息"
"input.send.steer":       "插话发送"
"settings.enter.steer":   "插话发送"
"queue.steer":            "插话发送"
"queue.steer.unavailable":"仅运行中可插话发送"
"queue.steerFailed":      "插话发送失败，请重试。"
```

`README.zh.md`（byte offset 27525518）说明了机制：

> 「……置为普通 Session 与可继续 child 选择 Queue 或 Steer 投递，运行中的 Send 按钮按 plain Enter 解析出的同一模式投递；……其标签以该模式命名（**排队发送或插话发送**）……」

即：宿主聊天输入框的发送按钮有两种模式——`Queue`（排队发送）与 `Steer`（**插话发送**），`Steer` 走 `delivery: 'steer'` 投递。这就是用户看到并点击的「插话」。**它是宿主组件，不在本仓库里。**

### 1.2 本插件没有、也注入不了这个按钮（反证）

| 证据 | 内容 |
| --- | --- |
| `src/` 全量 grep「插话 / 插队」 | 只命中 `src/dsh/steer.js`（注释/说明）与 `src/dsh/register.js`（工具描述/注释），**没有任何 UI 按钮渲染** |
| `src/client/index.js` | 设置页 React UI（角色管理 / CLI 管理），由 `scripts/verify-d1-interaction.mjs` 实测渲染；无 chat composer |
| `src/gui/host.js` | 设置页的 Typert remote 数据提供者（`registerGuiRemote`），不是聊天输入框 |
| 工具 `output.render` | 统一为 `renderObject`，只把返回值 `JSON.stringify` 成**纯文本**，不产出按钮 |
| `cordis.patch.yml` | 只贡献一条 config row（`id: meetingstone`），无 UI 注入 |
| `src/index.js` | 只做 `registerTools` + `registerGuiRemote`（设置页），无会话 UI 挂载 |

结论：**「插话发送」按钮的标签、点击行为、确认弹窗，全部够不着。**

### 1.3 点击链路（为什么两个任务都被中止）

```
用户点宿主「插话发送」(delivery:'steer')
   → steer 消息投递进当前会话（主 Agent）
   → 主 Agent 读 meetingstone_steer_task 的工具描述（旧文案以「中途插话」开头）
   → 对两个外部 CLI 任务调用 steer
   → register.js 路径 B：dispatcher.cancel({childId})  ← register.js:1428-1431
   → 确认停止后 dispatcher.dispatch(...)，回执 mode:'restart-with-output'  ← register.js:1542
   → 两个正在写代码的任务被中止，另开两个全新会话
```

`cancel` 是**必要的**（不能两个任务同时写同一工作区，见 `register.js:1463-1473` 的 STOP_UNCONFIRMED 门禁），Lead 的判断没错。问题在于：**必要 ≠ 可以不预先说**。真相只写在事后回执 `note`（`register.js:1547-1550`，含「这不是真插话」），用户在点击前看不到。

`src/dsh/steer.js:76-101` 的 `steerCapability()` 其实早就把真相判明白了：只有 `STEER_CAPABLE_PROVIDER='spawn'` 可真插话，其余通道返回 `capable:false, reason:'...无法真插话；可用 restart-with-output 重开'`。**能力判定是对的，披露时机是错的。**

---

## 2. 能改什么 / 不能改什么

| 项 | 归属 | 能否改 | 说明 |
| --- | --- | --- | --- |
| 宿主「插话发送」按钮标签 / 点击行为 / 确认弹窗 | 宿主 `dsh-client-ui-conversation` | **不能** | 不在本仓库；无插件钩子 |
| 宿主 Steer 投递机制（`delivery:'steer'`） | 宿主 `@deepseek-ai/dsh-subagent` | **不能** | 本插件只是没接线，机制由宿主提供 |
| `meetingstone_steer_task` 工具名 | 本插件 | 不建议 | 改名是 breaking change（`TOOL_NAMES`、测试、集成均引用）；改描述即可纠偏 |
| `meetingstone_steer_task` **工具描述 / 参数文案** | 本插件 | **能** | 这是主 Agent 决定「要不要调用」之前必读的文本，是本次最关键的**点击前**披露面 |
| `list_runs` / `get_task` 返回体 | 本插件 | **能** | 加 `steerMode` / `steerNote`，把通道能力摆到任务记录里 |
| 事后回执 `note` | 本插件 | 能（本次保留不动） | 兜底披露，不该拆 |
| `cancel` + 重开的行为本身 | 本插件 | 不该改 | 必要且不孤立；本次只补披露 |

---

## 3. 方案选择与理由（不为改而改）

- **方案 A（按钮/提示改成「停止并重开（非续聊）」）**：宿主按钮改不了；但**把它应用到我们自己的文案**是可行的——本次把工具描述/参数文案从「中途插话」重写成前置的「停掉原任务 + 带产出重开（非插话）」。采纳（部分）。
- **方案 B（点之前弹确认）**：宿主「插话发送」是宿主组件，**没有插件确认钩子**，做不到。曾考虑在工具层做二次确认（要求显式确认参数），但：① 一次性 steer 链路上主 Agent 很可能自动补确认参数，不能保证把提示回传给用户；② 会改工具契约、连带推翻现有 15+ 条 steer-restart 测试。**不做**，理由如上——为改而改反而制造回归。
- **方案 C（工具描述写清楚 + `list_runs`/`get_task` 标注）**：**采纳**。这是够得着、且恰好落在「主 Agent 决策点之前」的披露面。工具描述是每次都会读的固定文本；任务记录标注让「哪个任务不支持插话」在选任务时就可见。

---

## 4. 改了什么（改前 / 改后的实际渲染结果）

验证脚本 `scripts/verify-steer-disclosure.mjs` **真的调用 `registerTools` 取注册产物、真的调用 `execute()`**，不是读源码人眼确认。完整输出见产物 `verify-steer-disclosure.log`。

### 4.1 `meetingstone_steer_task` 工具描述

**改前**（`git HEAD e3c90c4` 原文，已用脚本逐字比对一致，203 字符）：

> 给**还在跑**的任务追加一条指示（中途插话），或给已结束的任务续聊。进程内通道（DSH 原生子 Agent）是真插话/真续聊：消息投进它的收件箱，它在下一个 step 边界处理，完整上下文保留。外部 CLI（CodeBuddy / Codex / Claude）不支持续接会话，只能「杀掉重来并带上已有产出」，**回执里的 mode 会明确区分**，不要混为一谈。只能给自己派出的任务插话。任务已终态时无法插话。

问题：① 第一句就是「中途插话」承诺；② 真相被放在第 4 句；③ 明确说「回执里的 mode 会明确区分」= 把区分推迟到**事后**。

**改后**（实际注册产物，逐字）：

> ⚠️ 调用前必读：对外部 CLI 任务（CodeBuddy / Codex / Claude，即绝大多数派单任务）这个工具**不是插话**，而是「停掉当前正在跑的任务 + 带上已有产出另开一个新会话」。调用它会**立即 cancel 仍在跑的原任务**；原任务的模型内部状态会丢失，新任务要重新读一遍上下文，这不是「中途插话」。只有进程内 spawn 通道（DSH 原生子 Agent）才支持真插话：消息投进收件箱，下个 step 边界处理，上下文完整保留。因此，如果不希望打断正在写同一工作区的任务，就**不要**对外部 CLI 任务调用本工具；改用它之前先用 list_runs / get_task 看每条记录的 steerMode 事前确认能不能真插话。只能给自己派出的任务用。

### 4.2 参数文案

| 参数 | 改前 | 改后 |
| --- | --- | --- |
| `instruction` | 「追加的指示……**不是新任务，是给当前任务的补充**」 | 「对进程内任务它是『追加指示』；对外部 CLI 任务它会成为**重开后新任务的指令（原任务已被中止）**，请把必要背景写全」 |
| `role` | 「外部 CLI 走『杀掉重来』时……」 | 「外部 CLI 走『停掉原任务 + 带产出重开（**非插话**）』时……」 |

### 4.3 新增 `steerPreview()`（`src/dsh/steer.js:119`）

纯函数，按**通道**（不受任务状态影响）返回 `{ steerMode, steerNote }`：`spawn → steer`；`acp/codex/claude-code/acp-kimi → restart-with-output`；无 provider → `unknown`（「无法确认，按不支持处理」，诚实且失败关闭）。取值与回执的 `mode` 用同一套词。

### 4.4 `list_runs` / `get_task` 事前标注

`list_runs`（默认紧凑与 verbose 两条路径）与 `get_task`（三条返回分支）都附加 `steerMode` / `steerNote`。**实际返回样例**：

```json
// list_runs，一条正在写代码的 acp 任务
{ "childId": "acp-running", "provider": "acp", "status": "running",
  "steerMode": "restart-with-output",
  "steerNote": "acp 通道不支持真插话：对它用 steer 会「停掉原任务 + 带上已有产出另开新会话」，原任务的模型内部状态会丢失，新任务要重新读一遍上下文。" }

// list_runs，一条 spawn 任务
{ "childId": "spawn-running", "provider": "spawn", "status": "running",
  "steerMode": "steer" }

// get_task，磁盘 acp 记录
{ "status": "cancelled", "steerMode": "restart-with-output", "steerNote": "acp 通道不支持真插话：……" }

// get_task，running（内存视图，不含通道信息）
{ "status": "running", "steerMode": "unknown",
  "steerNote": "该记录没有标注通道类型，无法确认能否真插话；按不支持处理（不要假定能插话）。", "diskReads": 0 }
```

### 4.5 事后回执保留（不拆兜底）

`register.js:1547-1550` 的 `note` 一字未动，仍返回 `mode:'restart-with-output'` 且明说「这不是真插话」。本次是**补事前**，不是把事后披露挪走。

---

## 5. 自己动手验证时发现的约束（如实披露）

第一版实现里，我让 `get_task` 在 running 分支补读一次磁盘以拿到 provider 做标注。**实跑 `node scripts/run-tests.mjs` 立刻暴露 1 个回归（687/689）**：`tests/wiring.test.mjs:323`「get_task：running 时以内存为准，不被磁盘快照覆盖」断言 `diskReads === 0`。

查 `src/dsh/adapter.js:1503-1525` 确认：`getTask()` 的 running 内存视图只有 `childId/status/output/jobId`，**不含 provider**；而磁盘的 running 可能是派单瞬间的过时快照。所以「running 不读盘」是一条真实的既有不变量，不能为了标注破坏它。

因此调整为：`get_task` **只读当前分支已经拿到的记录，绝不额外读盘**——
- 落到磁盘分支（内存 unknown）或终态合并分支：记录含 provider → 权威标注 `restart-with-output`；
- running 分支：无通道信息 → 标 `unknown` +「按不支持处理」；**权威的通道标注由 `list_runs` 提供**（它读的是完整落盘记录）。

这也意味着方案 C 里「`get_task` 对 ACP 任务标注不支持插话」**只能部分达成**：对运行中的任务，`get_task` 给的是保守的 `unknown` 而不是明确的 `restart-with-output`。这是能力与不变量约束下的诚实结果，不粉饰。

---

## 6. 验证结果

| 命令 | 结果 |
| --- | --- |
| `node scripts/verify-steer-disclosure.mjs` | **31 PASS / 0 FAIL / 31 项**（改前/改后渲染、参数文案、list_runs、get_task、通道矩阵、事后回执） |
| `node scripts/run-tests.mjs` | **689 tests / 688 pass / 0 fail / 1 skipped**（与基线一致） |
| `node scripts/release-check.mjs --version 0.1.0-alpha.26` | **10 PASS / 0 SKIP**（7 个门禁全 PASS；工具 schema 仍为 10 个工具） |

关于 `release-check.mjs` 裸跑：本工作树所有文件 mtime 被 checkout 成同一时刻，版本启发式（取 `docs/release/*-checklist.md` 中 mtime 最新者）误选了 `0.1.0-alpha.9`，于是出现 2 个**版本元数据** FAIL（8 PASS），**7 个门禁全部 PASS**。这是环境伪影、与本次改动无关：在 `D:/MeetingStone`（主安装，mtime 正常）裸跑同样命令得到 **10 PASS**（`0.1.0-alpha.26` 为最新）。因此门禁结论以 `--version 0.1.0-alpha.26` 的 10 PASS 为准。

日志与证据：`run-tests.log`、`release-check.log`、`release-check-plain.log`、`verify-steer-disclosure.log`、`host-asar-steer-locale.log`（均在产物目录）。

---

## 7. 未解决问题 / 风险 / 后续建议

1. **宿主按钮仍叫「插话发送」**——用户层面的第一眼误导依然存在，这是宿主侧够不着的。我们把真相前置到了「主 Agent 读到工具描述 / 查任务记录」这个决策点，但**不能保证主 Agent 一定会把警告转述给用户**。彻底消除需要宿主在 Steer 模式且目标为不可续接通道时给按钮加提示（建议提给宿主，本仓库做不到）。
2. **未做真机验证**：按约束不重启 DSH，因此没有在真实会话里验证「主 Agent 读到新描述后不再误调 steer」。这是本次最大的残余风险，建议下次真机窗口补一条冒烟：对 ACP 任务点「插话发送」，确认主 Agent 先向用户确认或直接改用其它方式。
3. **建议（未做，控制改动范围）**：`meetingstone_dispatch` 回执里已有 `taskRef.provider`，可以在派单时刻就带一条 `steerMode` 警告，把披露再提前一步。本次未改，避免动派单回执的 token 预算设计。
4. **建议（宿主侧）**：`queue.steer.unavailable` 已有「仅运行中可插话发送」，宿主可再加一条「目标通道不可续接，插话将改为停止并重开」的通道感知提示。
5. **既有行为未改**：终态任务调用 steer 同样会走 restart-with-output（与旧描述「任务已终态时无法插话」措辞不完全一致）——本次没有动行为，只在描述里去掉了这句不准确的承诺。若日后要改，需单独评估。

---

## 附：证据与产物

- 宿主证据：`host-asar-steer-locale.log`（app.asar 内 `dsh-client-ui-conversation` 的 locale 与 README 原文）
- 改前/改后渲染与全部验证输出：`verify-steer-disclosure.log`
- 门禁日志：`run-tests.log` / `release-check.log` / `release-check-plain.log`
- 验证脚本：`scripts/verify-steer-disclosure.mjs`（放在 `scripts/` 而非 `tests/`，故不进入 689 条枚举）
- 改动：`src/dsh/register.js`、`src/dsh/steer.js`、`scripts/verify-steer-disclosure.mjs`、`docs/plan/2026-11-13-steer-misleading-fix.md`
