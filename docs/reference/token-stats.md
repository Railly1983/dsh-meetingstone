# Subagents 面板 Token 统计口径核查（P0-4/5）

> 核查人：八戒（技术主管）｜日期：2026-11-11｜环境：DSH Desktop **0.2.2-rc.1**（安装版 app.asar）
> 方式：只读取证。反编译 asar 内 `@deepseek-ai/dsh-client-ui-subagent@0.2.2-rc.1`、`dsh-token-meter`、`dsh-session`、`dsh-session-projection`、`dsh-api-session-controller`、`dsh-llm-deepseek`，并用本机 `~/.dsh/sessions` 真实日志复算。
> **未改宿主源码/配置，未做 DOM 注入，未 commit。**

## 0. 结论（先看这里）

1. 面板显示的是 **`summary.projectionValues.tokenUsage`** 的四个分桶之和：
   `uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`，单位是 **token 个数**，显示为 `K`/`M`。
2. 该值是 **会话持久日志的累计值**：每一条带 `usage` 的 `assistant/message` / `assistant/attempt` 都累加一次；同一 `(turn,step)` 的流式样本会替换而非追加。它**不是**唯一 token 数，也**不是**费用。
3. **`154M tok / 4 秒` 已精确复现**：会话 `f8b00633-…`（label `meetingstone:role-selftest-fork`）是 **fork 种子会话**（`isSeeded:true`）。日志前 3375 条（seq 0…3375）是父会话 `session-417e6b6a` 的**逐字拷贝**，其中 420 条 usage 合计 **152,938,727 token**；fork 自己只有 1 次调用 **614,250 token**；总计 **153,552,977**，经 `formatTokens` 四舍五入即 **154M**。而“4 秒”只是子会话**自己**那一轮的活动时长（`subagentTiming` 在子会话 descriptor 处清零）。**154M 的 99.6% 是继承来的父会话历史，不是这 4 秒的消耗。**
4. **`4.5M / 4 分 55 秒` 也是同一公式**：会话 `274cbe89-…`，53 次调用，累计 **4,546,388 token**；跨度 295.56s。数值真实（累计处理量），但 98% 是 cache_read，且 53 次调用每次都要重发上下文，所以远大于“唯一 token”。
5. **可信度结论**：该字段可用于“累计处理量/吞吐”展示；**不能直接用于成本、额度、子 Agent 归属核算**。原因：① cache 命中 token 与 miss token 按 1:1 计入总数、不体现折扣，且跨调用重复累计；② 四桶没有乘单价；③ fork 会把父会话历史重复计入子会话（父/子面板各显示一次）。可信替代：`ownEvents` 截断后的 usage、`contextPressure.pressureTokens`（当前上下文）、四桶 × 分价（或以 provider 账单为准）。

## 1. 字段表与数据链

### 1.1 面板字段

| 位置 | 字段/表达式 | 类型 | 含义 |
|---|---|---|---|
| `dsh-client-ui-subagent/lib/client.js:211` | `summary?.projectionValues?.tokenUsage` | object | 会话 summary 里的投影值 |
| `client.js:66-68` | `tokenTotal(usage)` = `uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` | number | 面板显示的四桶之和 |
| `client.js:59-64` | `formatTokens(value,t)`：`<1e3` 原样；`<1e6` 转 `K`；否则转 `M`；≥100 时取整 | string | 显示单位；153.55M→`154M`，4.546M→`4.5M`，11293→`11.3K` |
| `client.js:213` + locale `tokens.total` | `"{value} tok"` | string | 最终“154M tok” |
| `client.js:70-77` | `activityDuration(summary, activity, now)` 读 `projectionValues.subagentTiming` | ms | 时长**不是** token 时间，来自另一投影 |
| `client.js:360` | `summaries = useSessions(state => state.byId)` | map | 列表行数据来自会话 summary 快照 |
| `dsh-api-session-controller/lib/client.js:3601-3613` | `buildListSnapshot()`：每行附 `projectionValues = projectionStore.values()` | object | 服务端把全部 client 可见投影塞进 list row |

`tokenUsage` 注册为 **summary 投影**（`wire` 未写 `summary:false`，默认 true；对照 `contextPressure` 在 `dsh-token-meter/lib/index.js:495` 显式 `summary:false`），所以无需打开会话就能在 Subagents 列表里看到它。

### 1.2 四桶的来源

| 字段 | 写入源 | 说明 |
|---|---|---|
| `inputTokens → uncachedInputTokens` | provider usage | **未命中缓存**的 prompt token（不是 prompt 总量） |
| `cacheReadTokens` | provider usage | 命中缓存的 prompt token（默认 0） |
| `cacheWriteTokens` | provider usage | 写缓存 token（默认 0；DeepSeek 本机样本恒 0） |
| `outputTokens` | provider usage | 生成 token（含 reasoning 时由 provider 口径决定，本机未单列） |
| `totalTokens` | 适配器重算 | `input+output+cacheRead+cacheWrite`（`dsh-llm-deepseek/lib/index.js:2019`） |

证据：`dsh-llm-deepseek/lib/index.js:1834-1847` 把 `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens` 映射到上述本地字段；`:2019` 重算 `totalTokens`。本机每条样本均满足 `input+output+cacheRead(+write) === totalTokens`（如 `864+144+13312=14320`），可证**四桶互斥**，同一次调用内 cache 没有重复计。

### 1.3 写入/聚合路径（端到端）

```
provider SSE usage
  → assistant/message.data.usage（或 stream 最后一个 usage chunk）   [dsh-llm-deepseek/lib/index.js:1834-1847,2019]
  → 持久会话日志 session.v4.jsonl.zstd（append-only，每条消息一个事件）
  → dsh-token-meter tokenUsage 投影：完整日志 fold 四桶            [dsh-token-meter/lib/types/usage-projection.js:86-119]
  → dsh-session-projection：client 可见投影 = summary              [dsh-session-projection/README.md:104-106]
  → dsh-api-session-controller buildListSnapshot 把 projectionValues 附到 list row [api-session-controller/lib/client.js:3601-3613]
  → dsh-client-ui-subagent 读 byId[id].projectionValues.tokenUsage [client.js:360,211]
  → tokenTotal() 求和 → formatTokens() → "154M tok"               [client.js:59-68,213]
```

## 2. 聚合公式与语义

### 2.1 公式（逐事件）

对日志按 seq 顺序折叠，状态 `{totals, last}`：

```
on llm/retry-started:
    if last.turn == e.turn and last.step == e.step: last = null

on assistant/message | assistant/attempt with usage:
    b = { uncachedInputTokens: usage.inputTokens,
          outputTokens:        usage.outputTokens,
          cacheReadTokens:     usage.cacheReadTokens ?? 0,
          cacheWriteTokens:    usage.cacheWriteTokens ?? 0 }
    prev = (last && last.turn==e.turn && last.step==e.step) ? last.buckets : 0
    totals = totals - prev + b        # 同一 (turn,step) 替换，不重复
    last = {turn,step,buckets:b}
```

面板值：`sum(totals)`。`llm/retry-started` 会结束替换作用域，因此**重试的同一 step 会再计一次**（设计意图：每次重试都是真实计费调用）。

### 2.2 关键语义（逐条回答任务问题）

| 问题 | 答案 | 证据 |
|---|---|---|
| 累加 input+output+reasoning+cache？ | 累加 **input(未命中)+output+cacheRead+cacheWrite**；不单列 reasoning（provider 若把 reasoning 含在 output 内则已包含） | `usage-projection.js:8-19,86-119` |
| cache 命中是否重复计？ | **同一次调用内不重复**（input 是 miss 部分，四桶互斥）；**跨调用会重复**：每次请求都把整个上下文重新算一遍 cacheRead，逐步累加 | `dsh-llm-deepseek/index.js:2019`；本机样本恒等式 |
| 是否跨轮累计？ | **是**，累计整个持久日志，不是“当前上下文” | `dsh-token-meter/README.md:49`：“complete durable log's …” |
| 是否把字节当 token？ | **否**，全部来自 provider usage；无字节换算路径 | `dsh-llm-deepseek/index.js:1834-1847` |
| fork 继承历史是否计入？ | **计入**。投影 `init` 不接收/不使用 `inheritedEventCount`，`apply` 也不在 `subagent/descriptor` 或继承切点清零 | `usage-projection.js:86-119`（`init: () => ...`）；对照 `dsh-session/README.md:82-84`、`dsh-session-projection/README.md:54` |
| 时长是否同口径？ | **否**。`subagentTiming` 在 `subagent/descriptor` 处 `settledMs=0` 重置，只算子会话自己的轮次 | `dsh-subagent/lib/types/projection.js:38-88`（注释明确 “Every descriptor therefore resets the accumulated state”） |

## 3. 复现（本机真实数据）

### 3.1 步骤

1. 会话目录：`C:\Users\30673\.dsh\sessions\--D-MeetingStone--\<sessionId>\session.v4.jsonl.zstd`。
2. 该 zstd 文件是**多帧追加**（`f8b00633` 为 6 帧，其他会话可达数百帧）。Node `zlib.zstdDecompressSync` 只解第一帧；需按 zstd magic `28 B5 2F FD` 切帧后逐帧解压，得到完整 JSONL。
3. 逐行解析；首行 `type:"session"` 给出 `isSeeded` / `parentSession` / `createdAt`；`subagent/descriptor` 给出 label 与子会话计时起点。
4. 按 §2.1 折叠 `assistant/message` / `assistant/attempt` 的 `data.usage`（或 `data.stream` 最后一个 usage chunk）。
5. 用 `formatTokens` 同款规则格式化。

> 复算脚本见附录 A（只读，不依赖宿主进程）。

### 3.2 三例对账（计算结果与面板显示逐字一致）

| 显示 | 会话 ID | label | isSeeded | usage 样本 | uncached | output | cacheRead | cacheWrite | 合计 | subagentTiming（日志跨度） | formatTokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **154M tok / 4 秒** | `f8b00633-4f82-4f2c-a292-0335770dd0fd` | `meetingstone:role-selftest-fork` | **true** | 421 | 825,116 | 325,173 | 152,402,688 | 0 | **153,552,977** | 4.234s（4.585s） | `154M` |
| **4.5M tok / 4 分 55 秒** | `274cbe89-3255-4a2b-81a3-e18c26f06dca` | `meetingstone:role-bajie` | false | 53 | 91,466 | 38,154 | 4,416,768 | 0 | **4,546,388** | 295.547s（295.556s） | `4.5M` |
| **11.3K tok / 31 秒** | `d52874f6-50e6-41fc-82db-218dd8950ff3` | `meetingstone:role-selftest` | false | 1 | 11,266 | 27 | 0 | 0 | **11,293** | 31.381s（31.391s） | `11.3K` |

- `formatTokens(153552977)`：`153.552977 ≥ 100` → `Math.round` = **154** → `"154M"`。
- `formatTokens(4546388)`：`4.546388 < 100` → `Math.round(45.46388)/10` = **4.5** → `"4.5M"`。
- `formatTokens(11293)`：`11.293` → `Math.round(112.93)/10` = **11.3** → `"11.3K"`。
- 时长：`activityDuration` = `settledMs + (through - since)`，由 `subagentTiming` 投影给出。三例分别为 4.234s / 295.547s / 31.381s（“日志最后事件 − createdAt”为 4.585s / 295.556s / 31.391s，差的是 turn/start 前的时间），格式化即 4 秒 / 4 分 55 秒 / 31 秒。

### 3.3 `154M` 的逐段拆解

会话 `f8b00633`：

| 段 | 事件范围 | usage 样本 | 合计 token | cacheRead |
|---|---|---|---|---|
| fork 继承的父会话前缀 | 复制自 `session-417e6b6a`，seq 0…3375（其后 seq 3376 为子会话 `session/end-seed`），time < `createdAt` | **420** | **152,938,727** | 151,788,928 |
| fork 自己的唯一一轮 | seq 3390，`turn=17, step=1`，time = createdAt+4.583s | **1** | **614,250** | 613,760 |
| **合计** | | **421** | **153,552,977** | 152,402,688 |

直接证据：
- 子会话首条 `assistant/message` = `{seq:27, time:1794287019184, message.id:"c5be4101-3339-441f-b8bd-6456605f81a8", usage:{inputTokens:864, outputTokens:144, cacheReadTokens:13312, totalTokens:14320}}`，与**父会话首条完全相同**（seq/time/id/usage 全同）——不是巧合，是 `ctx.sessions.fork()` 拷贝前缀（`dsh-session/README.md:82`：“copies an exact inclusive event prefix”）。
- 逐条比对：子会话 421 条 usage 中，420 条在父日志**同 seq 处的 `message.id` 完全相同（420/420）**；第 421 条（seq 3390）是 fork 自己的。继承切点是 `session/end-seed`（seq 3376）。
- 子会话 descriptor：`{seq:3377, time:1794305167342, label:"meetingstone:role-selftest-fork"}`；`createdAt=1794305166996`，fork 自己的 `turn/start` 在 `createdAt+351ms`。
- 子会话最后一条：`{seq:3390, time:1794305171579, turn:17, step:1, usage:{inputTokens:487, outputTokens:3, cacheReadTokens:613760, totalTokens:614250}}`。
- 父会话 `session-417e6b6a` 当前累计 **574,607,339**（1294 样本，92 轮）；fork 的 152.9M 是它的**前缀子集**。同一批 token 在父面板与 fork 面板各显示一次。
- 上下文窗口 `request/context.contextWindow = 1,048,576`；fork 前缀的 cacheRead 逐次增长（p50=394,880，p95=595,328，max=613,760），420 次继承调用 + 1 次自身调用累加即 152.4M。**不是字节，也不是一次请求的量**。

### 3.4 `4.5M / 4m55s` 为什么“看起来也不合理”但其实成立

- 53 次 API 调用，每次 prompt 从 ~10K 增长到 134K（p50 cacheRead=99,456，max=134,016），53 次累加 = 4.42M cacheRead + 0.13M 其他 = 4.55M。
- 最终上下文只有 **137,008 token**；累计 4.5M 是它的约 33 倍。这正是“每步重发上下文”的累计处理量，不是“唯一 token”。
- 该会话 `isSeeded:false`，全部 53 条样本都在 `createdAt` 之后，所以 4.5M **全部是它自己的调用**，没有继承。

## 4. `154M` 的成因定性

| 因素 | 是否成立 | 说明 |
|---|---|---|
| cache_read 累计 × 轮次 | **是（主因）** | 421 次调用，cacheRead 合计 152.4M；占 99.25% |
| 历史重放/fork 种子计入 | **是（次因，但决定性）** | 152.9M 是父会话前缀；fork 自己只有 0.61M |
| 同一调用重复计 cache | **否** | 四桶互斥；`totalTokens` 恒等式验证 |
| 同一 (turn,step) 双写 | **否** | 本会话 `replaced=0`，汇总值 = 朴素和 |
| 把字节当 token | **否** | 全部 provider usage 字段 |
| 单位错误（K/M/B） | **否** | 153.55M 四舍五入为 154M，严格匹配 |

**一句话**：`154M` = 父会话 152.9M 历史累计 + fork 自己 0.6M；`4 秒` = fork 自己那一轮的活动时长。token 与时长来自两个**口径不同**的投影，被 UI 并排展示，于是产生“154M/4秒”的荒谬组合。

## 5. 可信度结论与替代口径

### 5.1 能否用于成本 / 额度

| 用途 | 能否 | 原因 |
|---|---|---|
| 展示“累计处理量”（吞吐） | ✅ 可以，但需标注“累计、含 cache 重读” | 公式确定、可复算 |
| 成本估算 | ❌ 不可以直接 | 四桶未乘单价；cache 命中 token 与 miss token 按 1:1 求和，不体现 cache 折扣；fork 重复计入父历史；无价格表参与 |
| 额度/预算扣减 | ❌ 不可以 | 同一 token 会在父/子/重试中多次出现；与 provider 账单口径未对齐 |
| 子 Agent 归属/排名 | ❌ 不可以 | fork 继承前缀会把它算成“子 Agent 的消耗”，实际是父会话早已发生的调用 |
| 当前上下文占用 | ❌ 不是这个字段 | 应读 `contextPressure.pressureTokens` / `projectedTokens`（最近一次请求的 prompt），不是累计 |

### 5.2 可信替代

1. **子会话自身消耗**：只取子会话 `ownEvents()`（继承切点 `session/end-seed` 之后）内的 usage。本例 fork 自身 = **614,250**，而不是 154M。
2. **当前上下文**：`summary.projectionValues.contextPressure.pressureTokens`（最近一次 provider 报告的 prompt 大小）或 `projectedTokens`（下一次请求预计占用）。该投影 `summary:false`，列表行没有，需打开会话读取。
3. **精确成本**：四桶分别乘单价（miss / cacheRead / cacheWrite / output），或用 `dsh-token-meter` 的 route-pricing / provider 账单。面板目前不显示 cost，也未做价格换算。
4. **逐轮精确用量**：`deriveTurnTokenUsage(turnEvents)`（`dsh-token-meter/lib/types/turn-usage.js:115-228`）可给出单轮精确聚合；比“整会话累计”更适合按轮摊销。

## 6. 未验证项 / 风险

1. **未直接读取运行中 GUI 的接口响应/DOM**（按约束不做 DOM 注入）。“面板显示值”是用同一 `formatTokens`/`tokenTotal` 公式反推，并与三例会话语义逐字匹配；未截取 panel 实际 payload。
2. **未验证 provider 账单**是否与 `cacheReadTokens` 的计价折扣完全一致；只验证了 DSH 内部四桶与 `totalTokens` 的恒等式。
3. **未验证 projection checkpoint** 在会话运行中是否可能短暂返回旧值；本次三例与日志复算完全一致，未观察到 stale。
4. **未找到 DSH 将 token 换算成金额的代码路径**（面板本来就不显示 cost）；若未来加成本列，需要引入四桶单价与 fork 截断，不能直接复用该字段。
5. **未穷举所有 seeded 会话**；抽查 `f8b00633`、`session-cc5a771a` 两个 `isSeeded:true` 会话，均包含大量 `createdAt` 之前的复制事件，规则一致。
6. **repro 脚本依赖 Node 的 zstd**（本机 v24.21 可用）；若换环境，需支持“多帧 zstd”的解压器。

## 7. 证据索引

| 文件（asar 内路径） | 行 | 证明 |
|---|---|---|
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js` | 59-68 | `formatTokens` / `tokenTotal` 四桶求和 |
| 同上 | 211-218 | 面板取 `projectionValues.tokenUsage` 并渲染 |
| 同上 | 360 | `summaries = useSessions(state => state.byId)` |
| 同上 | 865 | locale `tokens.total = "{value} tok"` |
| `dsh/node_modules/@deepseek-ai/dsh-client-ui-subagent/package.json` | 4 | 安装版本 `0.2.2-rc.1` |
| `dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js` | 8-19, 86-119 | `tokenUsage` 投影：四桶、同 step 替换、整日志累计 |
| `dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js` | 394-427, 806 | 同一投影的运行时定义与注册 |
| `dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/types/turn-usage.js` | 115-228 | 逐轮精确聚合（替代口径） |
| `dsh/node_modules/@deepseek-ai/dsh-token-meter/README.md` | 49 | “complete durable log's …” |
| `dsh/node_modules/@deepseek-ai/dsh-session-projection/README.md` | 54, 104-106 | `init(header, inheritedEventCount)`；summary 由 client 可见投影组成；`summary:false` 才排除 |
| `dsh/node_modules/@deepseek-ai/dsh-session/README.md` | 82-84 | fork 复制 inclusive 前缀；`inheritedEventCount` 只数复制段；`ownEvents()` |
| `dsh/node_modules/@deepseek-ai/dsh-subagent/lib/types/projection.js` | 38-88 | `subagentTiming` 在每个 descriptor 处清零（时长只算子会话自己） |
| `dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js` | 1834-1847, 2019 | provider usage 字段映射；`totalTokens = input+output+cacheRead+cacheWrite` |
| `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js` | 3601-3613 | list row 附 `projectionValues` |

## 附录 A：复算脚本（Node，只读）

```js
// node --experimental-default-type=commonjs token-stats-repro.cjs
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const DIR = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-MeetingStone--';
const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd]);

function decompressAll(buf) {
  const idx=[]; let p=0;
  while ((p=buf.indexOf(MAGIC,p))!==-1){ idx.push(p); p+=4; }
  const out=[];
  for (let i=0;i<idx.length;i++){
    const frame=buf.subarray(idx[i], i+1<idx.length?idx[i+1]:buf.length);
    out.push(zlib.zstdDecompressSync(frame));       // 逐帧解压（多帧追加）
  }
  return Buffer.concat(out);
}
const sum = u => u.inputTokens + u.outputTokens + (u.cacheReadTokens??0) + (u.cacheWriteTokens??0);
const usageOf = e => e.data?.usage ?? (Array.isArray(e.data?.stream)
  ? [...e.data.stream].reverse().find(s => s?.chunk?.type==='usage')?.chunk.usage : undefined);

function fmt(v){
  const scaled = n => n >= 100 ? String(Math.round(n)) : String(Math.round(n*10)/10);
  if (v < 1e3) return String(v);
  if (v < 1e6) return scaled(v/1e3) + 'K';
  return scaled(v/1e6) + 'M';
}

function analyze(id){
  const lines = decompressAll(fs.readFileSync(path.join(DIR, id, 'session.v4.jsonl.zstd'))).toString('utf8').split('\n').filter(Boolean);
  let created=null, totals=0, last=null, n=0;
  for (const l of lines){
    let e; try { e=JSON.parse(l); } catch { continue; }
    if (e.type==='session') created=e.createdAt;
    if (e.type==='llm/retry-started'){ if(last && last.turn===e.data.turn && last.step===e.data.step) last=null; continue; }
    if (e.type!=='assistant/message' && e.type!=='assistant/attempt') continue;
    const u=usageOf(e); if(!u) continue;
    const b={ inputTokens:u.inputTokens, outputTokens:u.outputTokens, cacheReadTokens:u.cacheReadTokens??0, cacheWriteTokens:u.cacheWriteTokens??0 };
    const prev = last && last.turn===e.data.turn && last.step===e.data.step ? last.b : null;
    const v = x => x.inputTokens+x.outputTokens+x.cacheReadTokens+x.cacheWriteTokens;
    totals += v(b) - (prev?v(prev):0); last={turn:e.data.turn,step:e.data.step,b}; n++;
  }
  console.log(id, {samples:n, totals, text: fmt(totals)});
}
analyze('f8b00633-4f82-4f2c-a292-0335770dd0fd'); // 153552977 -> 154M
analyze('274cbe89-3255-4a2b-81a3-e18c26f06dca'); // 4546388 -> 4.5M
analyze('d52874f6-50e6-41fc-82db-218dd8950ff3'); // 11293 -> 11.3K
```

> 注：`formatTokens` 对 `≥100M` 用整数四舍五入（153.55→154），对 `1M–100M` 保留 1 位（4.546→4.5），对 `1K–1M` 保留 1 位（11.293→11.3）；上表 `text` 列已按该规则。
