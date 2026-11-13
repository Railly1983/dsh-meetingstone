# 2026-11-13 WorkBuddy 桥消耗核查 + 四方案对照测试设计

> 状态：**诊断已完成；a/b/c/d 四平台链路已全部实测打通，4 格冒烟通过；全量 16/48 格执行待用户确认**。本文数字来自本机只读账本/日志与实测标定。
> 本轮已按用户授权改动配置并逐文件备份（详见第六节），未改动任何插件正式代码。
> 诊断/标定脚本位于 `.token-test/`。**第五节**是全量 48 格 token/积分预算；**第六节**是本轮四平台打通与 4 格冒烟的实测证据。

---

## 一、昨天（11-12）消耗是否正常

### 结论：**金额属实、速率异常但不是计费 bug，且本地账本少记了约 1117 分**

| 口径 | 数值 | 来源 |
|---|---|---|
| 账号余额总下降（11-12 14:25:57 → 11-13 09:35:14） | **-1988 分** | `~/.workbuddy-bridge/quota-history.jsonl`（39 条快照，权威） |
| 其中 11-12 当天（14:25:57 → 23:43:45） | **-1641 分** | 同上，27 条快照 |
| 11-13 至今（00:46:45 → 09:35:14） | **-244 分** | 同上，12 条快照 |
| 11-12 跨零点到今晨的额外下降 | -103 分 | 23:43:45 → 00:46:45 |
| 本地 `usage.jsonl` 记的 credit（11-12） | 649.57 分 / 1501 次调用 / 618.6M prompt | `~/.workbuddy-bridge/usage.jsonl` |
| 本地账本全程 credit 合计 | 871.16 分 | `/api/usage` 与账本一致 |

你说的"差不多 2000 分"精确对应 **1988 分**，不是错觉。

### 为什么"看起来太快"

**直接原因是长会话反复重放超大上下文，不是单价高。** 11-12 DSH 会话日志按会话拆分：

| 会话 | 调用 | 输入 | 未命中 | 命中 | 峰值上下文 | 时间 |
|---|---|---|---|---|---|---|
| `session-417e6b6a` | **1618** | **609.8M** | 3.3M | 606.5M | **800K** | 14:48→23:58 |
| `session-9d97574f` | 186 | 61.1M | 918K | 60.2M | 422K | 17:33→23:58 |
| 沙僧/B3 清理子会话 | 204 | 29.0M | 185K | 28.9M | 201K | 15:58→16:20 |
| D1 真机验收子会话 | 134 | 15.4M | 192K | 15.2M | 199K | 15:50→16:04 |
| 其余 14 个会话 | 335 | ~22M | — | — | ≤147K | — |
| **合计** | **2477** | **738.1M** | 5.3M | 732.7M | — | 命中率 **99.28%** |

- 缓存命中率 99.28%，**单价已经压到很低**（约 1.58 分 / 1M prompt）。
- 但 `session-417e6b6a` 一个会话跑了 9 小时、1618 次调用、每次平均 ~377K prompt，峰值 800K，累计 609.8M 输入。这是消耗主体（占 83%）。
- 单次请求最大一笔 credit 出现在 11-13 09:18:46：`prompt=545,287`、`miss=540,423`、`credit=33.1` —— **缓存失效（冷启动/上下文变化）时单次就能烧掉 33 分**，比正常命中态（约 1.1 分/次）贵 30 倍。

### 那 1117 分去哪了（重要，不是幽灵扣费）

| 差额来源 | 分值 |
|---|---|
| 账本起点之前（11-12 14:25:57 → 16:52:52，余额 49481→49110） | **371** |
| 账本覆盖期内未回报/异步结算（18:25→20:07 段差 296.88；22:48→23:43 段差 161.65；11-13 08:20 段差 109.61 等） | ~**746** |
| 合计 | **~1117** |

证据：`final-reconcile.mjs` 逐段比对余额下降与账本 credit，账本前 9 个快照期间 `calls=0 / credit=0` 但余额持续降；账本启动后仍有多个时段余额降幅显著大于 credit 之和。`usage.jsonl` 首行时间是 **16:57:39**，而桥从 14:25 已在服务 —— 前 2.5 小时**根本没被本地账本记录**。此外还有 4 行付费模型请求 `credit=0`（疑似上游未回报积分）。

**判断**：
- ✅ 余额扣 1988 分是真实的、与账户套餐变动逐分吻合（标准版 24000→22078 少 1922，裂变包 1141→1115 少 26，另有小包消耗）。
- ⚠️ **异常点一**：本地账本不完整，不能用它估算成本；请以 `quota-history.jsonl` 或账户侧为准。
- ⚠️ **异常点二**：消耗速率确实偏快，根因是长会话 + 800K 上下文 + 1618 次调用，而非桥多扣。
- ❌ 不是"桥把请求算重了"：缓存命中率 99.28%，单价正常。

### 止血建议（按性价比排序）

1. **主控会话定时新开**：把 800K 上下文砍到 100K 以内，9 小时会话拆成 3~4 段。这是最有效的一招。
2. **避免缓存冷启动**：`session-417e6b6a` 上下文峰值 800K 超过桥上 `deepseek-v4.1-flash` 默认 300K 档；长会话请固定用同一模型、不要频繁切模型或压缩后立刻继续。
3. 已开启 `compaction-basic`（`thresholdRatio: 0.5`、`summarizationModel: deepseek-v4.1-flash`），但压缩本身也调 LLM，仍算积分。
4. 优先把主控默认模型设为 **`hy4free` / `hy3`（免费档）**——当前配置已经是 `workbuddy/hy4free`，11-13 已见效（详见第二节）。
5. 修账本：让桥在启动时把首条 `quota snapshot` 写入 `usage.jsonl` 基线，并对 `credit=0` 的付费请求补记 `original_credit`。**需改插件代码，本次未动。**

---

## 二、为什么今天 DeepSeek 余额还在扣

### 结论：**DSH 侧今天一次 DeepSeek 都没调；扣费来自 DSH 之外的独立客户端配置**

`dsh-1113.mjs` 扫描 11-13 全部 DSH 会话日志：

```
2026-11-13 LLM 调用 437 次，最后 10:00:17
  workbuddy/deepseek-v4.1-flash   392
  workbuddy/hy4free                45
  deepseek-account                   0   ← 零
```

`agent-default-model` 已是 `workbuddy/hy4free`，`compaction-basic` 的 summarization 也指向 workbuddy，辅助 title/搜索路由今天没有出现 `deepseek-account`。**DSH 已完全切到桥。**

### 真正的扣费路径（三条，全部在 DSH 之外）

| # | 路径 | 证据 | 说明 |
|---|---|---|---|
| **1** | **用户级环境变量 `ANTHROPIC_*`** | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`ANTHROPIC_AUTH_TOKEN=sk-2373…`、`ANTHROPIC_MODEL=deepseek-v4-pro[1m]` | 任何读 `ANTHROPIC_*` 的 CLI（Claude Code、opencode、自定义脚本）都会**绕过桥和 DSH**，直接扣官方账户。这是最可疑的一条，因为它是用户级全局设置，对所有新进程生效。 |
| **2** | **`~/.claude/settings.json`** | 同一 `api.deepseek.com/anthropic`、另一把 `sk-ee83…` key、默认 `deepseek-v4-flash-vision-exp[1M]` | Claude Code 的配置级 key，优先级高于/独立于上面那条。 |
| **3** | **`~/.codex/config.toml`** | `model = "gpt-6.1-sol"`，**未接桥**（无 `model_provider`/`experimental_bearer_token`，`workbuddy.config.toml` 不存在） | Codex 走自己的 OpenAI 账户，不扣 DeepSeek；但它是 d 方案要改的地方。 |

补充旁证：`~/.claude/projects` 最近日志是 11-12 23:05，`~/.codex/sessions` 最近是 11-11 01:31，**今天 0 个 JSONL 被修改**。所以如果你今天没有主动开 Claude Code / Codex 窗口，也可能是：
- 后台常驻进程（IDE 插件、MCP server、CLI 守护）持有旧 key 在轮询；
- 或账户侧余额是**昨日请求的延迟结算**（DeepSeek 官方账户的扣费展示有滞后）。

### 止血动作（需你确认后执行，本次未改任何配置）

1. **确认扣费时间戳**：先看 DeepSeek 官方账户的**逐笔明细时间**。若集中在 11-12，属延迟结算；若持续到 11-13 09:xx，则是路径 1/2 的活跃客户端。
2. **临时禁用官方 key**（可逆）：把用户级 `ANTHROPIC_AUTH_TOKEN` 改名备份（如 `ANTHROPIC_AUTH_TOKEN.bak`），并在 `~/.claude/settings.json` 里把 `env.ANTHROPIC_BASE_URL` 指向 `http://127.0.0.1:8790`、token 换成 `~/.workbuddy-bridge/bridge-token`。**注意改完需重启对应 CLI 进程才生效。**
3. **让 Codex/Claude Code 走桥**：用 workbuddy-to-dsh 控制台自带的一键接入 API（**安装包里没有 `tools/connect.mjs`，别照 README 的 `npm run connect` 抄**，见 6.1）。控制台需先运行：`workbuddy_bridge console` 或本页 `http://127.0.0.1:8792`。
   ```
   # 必须带 x-workbuddy-panel: 1，否则 403
   curl -X POST http://127.0.0.1:8792/api/connect/apply ^
     -H "content-type: application/json" -H "x-workbuddy-panel: 1" ^
     -d "{\"client\":\"claude\",\"model\":\"hy4free\"}"
   curl -X POST http://127.0.0.1:8792/api/connect/apply ^
     -H "content-type: application/json" -H "x-workbuddy-panel: 1" ^
     -d "{\"client\":\"codex\",\"model\":\"hy4free\"}"
   curl -X POST http://127.0.0.1:8792/api/connect/verify ^
     -H "content-type: application/json" -H "x-workbuddy-panel: 1" ^
     -d "{\"client\":\"codex\"}"
   ```
   API 自带逐文件备份与 `POST /api/connect/undo` 回滚。**Codex 桌面版注意**：主 `~/.codex/config.toml` 接桥后会被自动注入的超长 MCP 工具名卡住（桥 400），需用隔离的最小 `CODEX_HOME`（见 6.2）或先移除 `[mcp_servers.*]` 段。
4. **保留桥令牌**：本地令牌在 `%USERPROFILE%\.workbuddy-bridge\bridge-token`；桥与控制台需一起重启才能收敛到同一值（README 明确警告只重启一边会继续 401）。

---

## 三、a/b/c/d 四方案对照测试设计

### 3.1 前置条件核实（已实测）

| 项 | 结果 |
|---|---|
| 主控默认对话模型 | `agent-default-model` = `workbuddy/hy4free` ✅ 已符合"各主控平台默认 hy4free" |
| 四模型在桥上的 ID | `hy4free`、`hy3`、`deepseek-v4.1-flash`、`glm-5.3-flash` 全部 200 OK |
| **`hy3free`** | ❌ **404，不在 59 个模型目录里**。限时免费的正确 ID 是 **`hy3`**（`hy3-b`/`hy3-c`/`hy3-x` 同族）。下文一律用 `hy3`，除非你确认要测 `hy3-x`（×0.05）。 |
| 思考强度 | 四个模型均接受 `high` 与 `max`；`hy4free`/`hy3` 官方只列 `high`（`max` 被静默接受但不保证生效），`deepseek-v4.1-flash`/`glm-5.3-flash` 官方列 `high`/`max`。**统一用 `high`** 保证可比性，另跑一轮 `max` 做敏感性验证。 |
| 上下文上限（桥实测） | `hy4free` 300K（maxInput 960K）、`hy3` 192K、`deepseek-v4.1-flash` 300K（maxInput 1M）、`glm-5.3-flash` 300K（输出上限 131K） |
| "上下门长度拉到最高" | 理解为**上下文窗口与输出上限都取最大**。共口径取 `max_tokens` = 各模型官方上限的最小值 **64K**（hy4free/hy3 的输出上限），另标注 `space-bunny`(1000K) 不在四模型内。**不混用不同 max_tokens**，否则质量分不可比。 |
| 方案 a 通道 | **本轮已补齐**：`ch-acp-hy4free`/`ch-acp-hy4`/`ch-acp-flash`/`ch-acp-ds`，四模型齐备，均 `reasoning: high`；`subagent-acp*` CLI 参数带 `--effort high` |
| 方案 b 通道 | `ch-inprocess` = `spawn` + `llmProvider: workbuddy` + `llmModel: deepseek-v4.1-flash`；**冒烟实测**：直接用官方 `subagent` 工具并显式传 `provider:workbuddy, model:<目标模型>, reasoning_effort:high`，新建子会话 descriptor 即为 `agentProvider:workbuddy / agentModel:<目标模型>`，3 次调用全部走 `workbuddy/hy4free`。**因此 b 方案无需改任何配置即可逐次切四模型**（每次新建会话，规避 spawn 创建时固定 provider 的既有坑）。`ch-inprocess` 的默认值只在未显式指定时兜底。 |
| 方案 c | WorkBuddy 桌面端/控制台直接调用四模型（走同一账号，不经 DSH） |
| 方案 d | 控制台 API `/api/connect/apply` 把桥接成 Responses provider；**本轮已在真实 `codex exec` 上实跑通过四模型**（见 6.2），不再是待验证项 |

### 3.2 四个方案的可执行定义

| 方案 | 主控 | 子代理机制 | 模型接入 | 本次需要的前置动作 |
|---|---|---|---|---|
| **a** | DSH（`hy4free`） | 集合石 `meetingstone_dispatch`，`kind: acp-cli` | 启动 CodeBuddy CLI `--acp --model <m> --effort high` | ✅ 已完成：四角色 `role-wukong`(hy4free) / `role-xiaobai`(hy3) / `role-sashi`(glm-5.3-flash) / `role-bench-ds`(deepseek-v4.1-flash)，全部冒烟通过（见 6.3） |
| **b** | DSH（`hy4free`） | 官方 `subagent` 工具 / `spawn`，**in-process** | `workbuddy-to-dsh` 注册的 `workbuddy` LLM adapter | ✅ 已验证：显式传 `provider` / `model` / `reasoning_effort` 即可逐次切四模型，**无需改配置**（每次新建会话） |
| **c** | WorkBuddy 桌面端（`hy4free`） | 直接对话，无子代理 | WorkBuddy 原生模型选择器 | 在 WorkBuddy 里建 4 个独立会话，每个固定一个模型；**无子代理开销，作为基线** |
| **d** | Codex CLI（`hy4free`） | Codex 原生（in-process） | 控制台 API `/api/connect/apply` 写入 Responses provider | ✅ 已完成：`codex exec` 四模型实测全部 exit=0；**固定前提** = 隔离最小 `CODEX_HOME`（主配置的桌面 MCP 工具名会被桥 400 拒绝，见 6.2） |

> 关于 "in-progress"：按上下文应为 **in-process**（进程内子代理）。b/d 都按 in-process 口径设计；若你确指别的含义请纠正。

### 3.3 固定任务（同一份，逐字不变）

选一个**不依赖仓库状态、可机器判分、能触发多步工具调用**的任务，避免"简单问答"测不出差异：

> **任务 T1（只读 + 结构化输出）**
> 读取 `D:\MeetingStone\src\result-contract.js`，回答：
> 1) 该模块导出的全部函数名（按文件出现顺序）；
> 2) `parseStructuredResult` 容忍哪几种 JSON 形状；
> 3) 当解析失败时回退行为是什么，引用具体行号；
> 4) 输出严格 JSON：`{"functions":[...],"shapes":[...],"fallback":"...","evidence":[{"file":"...","line":N,"quote":"..."}]}`。
> 禁止修改任何文件；允许且只允许使用 read/grep 类工具。

配套两个变体用于控制难度：
- **T0 热身**：`node -v`，只回一个版本号（测纯链路开销，不测质量）。
- **T2 长上下文**：把 `src/gui/host.js`（约 3K 行）全文塞进 prompt 后问 3 个定位问题（测长上下文下的速度与缓存行为）。

### 3.4 维度与测量口径

| 维度 | 指标 | 数据来源 | 口径 |
|---|---|---|---|
| **速度** | 墙钟总时长、TTFB、每步耗时 | `meetingstone` run 的 `createdAt/durationMs`；桥 `/api/requests` 的 `ms/ttfbMs/overheadMs`；Codex/WorkBuddy 侧用脚本打点 | 从派单发出到收到终态；不含排队 |
| **Token** | prompt / cache-miss / cache-hit / completion / **credit** | 桥 `usage.jsonl` 的 `promptTokens/cacheMissTokens/cachedTokens/completionTokens/credit` + `quota-history.jsonl` 余额差 | **credit 以余额差为准**（本地账本会少记，见第一节）；token 以桥逐条为准 |
| **质量** | 4 项自动判分（各 0/1）+ 证据可核验性 | 用固定判分脚本比对 T1 的 JSON 与 `result-contract.js` 真实导出 | 函数名集合(1) / 形状集合(1) / 回退行为(1) / evidence 行号可复核(1)；满分 4 |
| **稳定性** | 失败率、重试次数、超时、`ADAPTER_DISPOSE_TIMEOUT` | run 记录 + 桥 `failures[]` | 每格至少 **3 次重复**，报中位数与失败次数 |
| **链路开销** | 主控自身 token（不含子代理） | DSH 会话日志 / Codex 会话日志 / WorkBuddy 账本 | 区分"主控调度开销"与"子代理执行开销" |

### 3.5 实验矩阵与执行顺序

- **规模**：4 方案 × 4 模型 × 3 重复 = **48 次**（每格 T1；T0/T2 各跑 1 次做校准，共 +96 次，视预算裁剪）。
- **顺序**：按 `方案 → 模型 → 重复` 固定顺序，**每格前重启/新建会话**以清空上下文，避免缓存污染跨格。
- **隔离**：a 方案用 `isolation: worktree`；b/c/d 用独立会话目录；所有 T1 只读，**不写仓库**。
- **余额打点**：每格开始前/结束后各取一次 `quota-history` 快照，用余额差作为该格真实 credit。
- **并行度**：串行执行（避免并发让缓存/额度互相干扰），预估 T1 单次 1~5 分钟，48 格约 **2~4 小时**。

### 3.6 验收与产物

- 每格一条记录：`{方案, 模型, 重复, 任务, 墙钟, TTFB, prompt/miss/hit/out, credit(余额差), 质量分, 失败原因}`。
- 汇总表：按方案、按模型两个维度分组，给中位数与 P90；明确标注 `hy3` 而非 `hy3free`。
- **d 方案若 Codex 端到端不通**：如实标 `blocked`，记录具体错误（协议/认证/模型目录），不补造数据。
- 最终报告写入 `docs/plan/2026-11-13-multi-platform-benchmark.md`；原始账本归档到 `.token-test/bench-<date>/`。

### 3.9 冒烟实测结果（本轮已跑）

| 方案 | 冒烟 | 结果 |
|---|---|---|
| a | `meetingstone_dispatch(role-wukong, hy4free, T0: node -v)` | ✅ completed，`v20.16.0`，无文件改动；另新增 `BenchDS` 通道跑 deepseek 模型也通过 |
| b | `subagent(provider=workbuddy, model=hy4free, reasoning_effort=high)` | ✅ 完成，descriptor 精确为 `workbuddy/hy4free`，调用全部走桥，无 `deepseek-account` |
| c | WorkBuddy 桥直调四模型 | ✅ 四模型均 200 OK（`hy3free` 404，已确认改用 `hy3`） |
| d | Codex 接桥 | ✅ **已实跑打通**，见第六节；`connect.mjs` 不存在，实际走控制台 API |

**结论**：a/b/c/d 四平台链路已全部打通并完成 4 格同任务冒烟（见第六节）。原"d 是唯一待打通项"已解除。

### 3.8 风险与已发现的坑

1. **账本少记**：必须以 `quota-history.jsonl` 余额差为主，不能只信 `/api/usage`。
2. **缓存冷启动**：单次 miss 50 万 token 会产生 33 分尖峰；每格新开会话会放大这一点，需在报告里单列"冷启动 credit"。冒烟实测 b 方案新建 `hy4free` 子会话仅 3 次调用、上下文极小，冷启动影响可控。
3. **官方 key 仍在扣费**：测试期间若有后台 Claude/Codex 进程走 `api.deepseek.com`，会污染"DeepSeek 账户"侧读数；建议测试窗口内先按第二节做止血。
4. **Codex 主配置会被 MCP 工具名卡住**：d 方案必须用隔离的最小 `CODEX_HOME`（见 6.2），否则桥返回 400；这已不是阻断项，但是固定前提。
5. `hy4free`/`hy3` 是限时免费，配额 `percent`/`reset_at` 可见（探针返回 `hy4` 67%、`hy3` 17%），跑到一半可能触发限流，需记录 `quota` 字段。
6. 方案 b 的 `spawn` 子代理**创建时固定 agentProvider**，切换模型只对新建会话生效（这是 11-12 的既有教训），每格必须新建会话并重派。

---

## 五、全量 48 格预算（应要求，基于实测标定）

> 用户问"得先告诉我全量 48 格跑下来要多少 token、多少积分"。**已实际跑标定，不是拍脑袋**：
> `.token-test/bench-calibration-v2.jsonl`（单次 T1）、`bench-calibration-v3.jsonl`（32K 输出）、`bench-per-cell.jsonl`（3 轮 agent）、`budget-final.mjs`（外推）。
> **速览**：典型 19.2M tokens / **4.80 分** / 约 2~3 小时；保守上限 21.4M / 11.52 分。详见 5.3。
> `.token-test/bench-calibration-v2.jsonl`（单次 T1）、`bench-calibration-v3.jsonl`（32K 输出）、`bench-per-cell.jsonl`（3 轮 agent）、`budget-final.mjs`（外推）。

### 5.1 标定实测（同一份 T1：12,165 字符 prompt + 350 行源码，`effort=high`）

| 模型 | 单次耗时 | prompt | 输出 | 思考 token | credit | 正文有效 |
|---|---|---|---|---|---|---|
| `deepseek-v4.1-flash` | **2.7s** | 4,407 | 280 | 0 | **0.04** | ✅ 严格 JSON |
| `glm-5.3-flash` | 34.6s | 3,638 | 2,162 | 1,843 | **0.14** | ✅ 严格 JSON |
| `hy3`（免费） | **181s** | 3,641 | **14,604** | 13,981 | **0** | ✅（要 32K 额度才吐正文） |
| `hy4free`（免费） | 104s（2K 额度时）/ 32K 请求失败 | 4,375 | 8,192→32K 全烧思考 | — | **0** | ❌ T1 长任务无法收敛 |

**关键发现（直接影响测试设计）**：`hy4free` / `hy3` 在 `effort=high` + 长任务下会把输出额度**全部消耗在 reasoning token**，正文为空。短任务（问一个关键字）只要 2.7s / 94 token 就正常；T1 长任务下 `hy3` 需要 181 秒、14.6K 思考 token 才吐出 JSON，`hy4free` 到 32K 额度仍未收敛（请求失败）。
→ **这不是桥的 bug，是这两个免费模型的思考行为**。若强行全量跑，hy 系会拖长整体耗时且质量分可能全 0。建议二选一：① 四模型统一改用更短、可收敛的固定任务；② 保留 T1 但把 hy 系标为"收敛失败"如实记录，并给它单独的 `max_tokens` 上界（如 16K）。

### 5.2 单格 agent 实测（3 轮工具往返，含上下文重放）

| 模型 | prompt(miss/hit) | 输出 | credit | 耗时 |
|---|---|---|---|---|
| `deepseek-v4.1-flash` | 9,439 (4,703/4,736) | 665 | **0.23** | 6.3s |
| `glm-5.3-flash` | 8,081 (4,305/3,776) | 1,492 | **0.17** | 23.2s |

（免费模型无 3 轮实测，按单次实测 ×2.1 外推）

### 5.3 48 格总预算（4 方案 × 4 模型 × 3 重复）

| 场景 | 子代理 tokens | 主控 tokens | **合计 tokens** | **积分** | 模型耗时 |
|---|---|---|---|---|---|
| ① 纯单次调用（下限，c 方案） | 0.79M | 17.9M | **18.7M** | **2.16 分** | 1.1h |
| ② **3 轮 agent（典型，a/b/d）** | 1.29M | 17.9M | **19.2M** | **4.80 分** | 2.0h |
| ③ 8 轮 + 波动（保守上限） | 3.47M | 17.9M | **21.4M** | **11.52 分** | 5.7h |

- **主控侧**：48 格 × 3 次 = 144 次调用，按今天 `hy4free` 实测均值 **124.5K prompt/次**（中位 137.5K、P90 163K）= **17.9M tokens，0 分**（免费模型）。
- **若主控误用 `deepseek-v4.1-flash`**：今天实测 0.435 分/次、480K prompt，则额外 **+63 分 / +69M tokens**。
- **T0/T2 校准**：T0 可忽略（48×~30 tok）；T2 若真跑，48 格 × 100K = 4.8M tokens，付费模型约 +3~4 分。
- 实际墙钟还要加派单、工具执行、排队等待约 **30~50%**，即典型场景约 **2.5~3 小时**。

### 5.4 结论：48 格很便宜，真正的成本风险在别处

对照昨天：11-12 单日 **-1641 分** = 1501 次调用 / 618.6M prompt（命中率 99.28%）。
48 格预计 144 次子代理 + 144 次主控 = **288 次，仅为昨天的 19%**，且两个模型免费 → **约 5 分，最坏 12 分**。

**但有一个远大于测试本身的风险**：若测试期间继续沿用长会话、主控上下文涨到 500K 且不新开，288 次 × 500K = 144M prompt ≈ **+125 分**。
→ 所以执行纪律比预算更重要：**每格新建会话、主控默认 `hy4free`、控制上下文在 150K 内**。按此纪律，全量 48 格总花费预期 **< 15 分**（约占当前 47,464 余额的 0.03%）。

### 5.5 建议的折中执行方案

1. **先跑 4 格冒烟**（a/b/c/d × `deepseek-v4.1-flash`，最快且能出正文）：约 0.1 分 / 5 分钟，确认四平台链路都通。
2. **再跑 16 格**（4 方案 × 4 模型 × 1 次）：约 1.6 分、约 1 小时，先出完整对照表。
3. **最后补 2 次重复到 48 格**：再加约 3.2 分。
4. hy 系若坚持 `high` 强度，接受"耗时 3 分钟/格 + 可能无正文"的质量损失，或统一改用短任务。

---

## 六、四平台打通与 4 格链路冒烟实测（本轮新增证据）

### 6.1 先纠正一个上一轮的错误结论

上一轮据 `package.json scripts` 写了 `npm run connect apply codex` / `connect profile codex`。**实测安装包 v1.23.2 里没有 `tools/` 目录，也没有 `connect.mjs`**（该 script 指向一个未随 npm 包发布的文件）。
→ 真实入口是控制台 HTTP API：`POST /api/connect/{apply,verify,mode,undo}`，需带 `x-workbuddy-panel: 1`；底层实现 `lib/client-connect.mjs` 随包发布。所有 d 方案操作改走这个 API。

### 6.2 方案 d：Codex 接桥，已从"README 未实跑"变为实测打通

| 步骤 | 结果 |
|---|---|
| `/v1/models?all=1` | 200，59 模型；`hy4free` / `hy3` / `deepseek-v4.1-flash` / `glm-5.3-flash` 全部在目录 |
| `/v1/responses` 四模型最小请求 | **全部 200 OK**（1.2~1.8s） |
| `POST /api/connect/apply {client:codex, model:hy4free, models:[四模型]}` | **ok:true**，写入 `model=hy4free`、`model_provider=workbuddy`、`wire_api=responses`、`model_catalog_json`，四模型写入 `~/.codex/workbuddy-model-catalog.json`；API 自带备份与端到端 auth 验证 `ok:true` |
| 真实 `codex exec`（主 `~/.codex/config.toml`） | ❌ **失败**：`workbuddy-bridge: tool name "mcp__codex_apps__codex_document_control___execute_document_c…" is invalid (max 64 chars)` |
| 定位原因 | 桥 `workbuddy-bridge.mjs:323` 强制 `TOOL_NAME_RE=/^[A-Za-z0-9_-]{1,64}$/`；Codex 桌面版自动注入超长 MCP 工具名，与桥冲突，**不是模型不通** |
| 隔离 `CODEX_HOME`（去掉 MCP 段）后 `codex exec` | ✅ **OK**，16.4s，`model: hy4free / provider: workbuddy / reasoning effort: high` |
| 四模型逐个 `-m` 真实跑 | ✅ **全部 exit=0**：hy4free 20.9s / hy3 15.0s / deepseek-v4.1-flash 3.6s / glm-5.3-flash 9.7s |

**结论**：d 方案可行，但必须用一个**不含桌面 MCP 注入的最小 `CODEX_HOME`**（本报告用 `.token-test/codex-min-home/config.toml`，已落盘可复用）。主 `~/.codex/config.toml` 已接桥但日常 Codex 桌面端会被 MCP 工具名卡住——这是执行 d 时的固定前提，不能忽略。

### 6.3 方案 a：补齐第四个 ACP 模型通道

`cordis.patch.yml` 原本只有 `hy4free` / `hy3` / `glm-5.3-flash` 三个 ACP 通道，缺 `deepseek-v4.1-flash`。按用户授权新增（均已备份）：

- `subagent-acp-ds` → `providerName: acp-ds`，CodeBuddy CLI `--model deepseek-v4.1-flash --effort high`
- `ch-acp-ds` 通道
- `role-bench-ds`（BenchDS）临时角色

验证：`meetingstone_list_roles` **实时返回 `role-bench-ds / available`**（无需重启 DSH）；派单 `86c14888…` 完成，返回 `v20.16.0`，`changedFiles: []`。
至此 **a 方案四模型通道齐备**：`role-wukong`→hy4free、`role-xiaobai`→hy3、`role-sashi`→glm-5.3-flash、`role-bench-ds`→deepseek-v4.1-flash。

### 6.4 4 格链路冒烟：同一任务 × 同一模型，四平台全部答对

任务：`对 [12, 7, 23, 8, 30] 求和，只输出严格 JSON {"sum": N}`（期望 80）。模型统一 `hy4free`，`effort=high`，主控默认模型 `hy4free`。

| 方案 | 通道 | 结果 | 耗时 | token/credit 证据 |
|---|---|---|---|---|
| a | 集合石 ACP `role-wukong` | ✅ `{"sum": 80}` | **80.5s**（`durationMs=80541`） | 结果 11B，`changedFiles:[]`；ACP 通道 token 不在桥账本内，需单独量 |
| b | 官方 `subagent`（`provider=workbuddy, model=hy4free, effort=high`） | ✅ `{"sum": 80}` | 数秒级 | in-process 调用进桥账本，与主控同池 |
| c | 桥直调 `/v1/chat/completions` | ✅ `{"sum":80}` | **2.0s** | prompt=101 / out=120（reason=113）/ credit=0 |
| d | 真实 `codex exec`（隔离 home） | ✅ 答对 | **14.7s** | `tokens used 250`，credit=0 |

**重要测量口径问题**：冒烟窗口内桥账本 13 条 `hy4free` 调用（合计 748K prompt / 7K out）**混有主控自身调用与 b/d 的子调用，无法逐格干净归因**。a 走 CodeBuddy CLI（不经桥账本）。
→ 16/48 格正式测试必须改用**每格独立会话 + 余额前后打点 + 平台侧 token 计量**三口径交叉，不能只用桥账本按时间切片。

### 6.5 本轮落盘的配置改动与回滚

| 文件 | 改动 | 备份 / 回滚 |
|---|---|---|
| `~/.dsh/profiles/desktop/cordis.patch.yml` | +`subagent-acp-ds` / `ch-acp-ds` / `role-bench-ds` | `cordis.patch.yml.bak-bench-20261113-1235`（8570B，改前原样） |
| `~/.codex/config.toml` | 接桥：`model=hy4free`、`model_provider=workbuddy`、 Responses 段 | `config.toml.bak-bench-20261113`；API 自带 `.backup/client-configs/codex/20261113-124101-config.toml`；`POST /api/connect/undo` |
| `~/.codex/workbuddy-model-catalog.json` | 新增四模型目录 | 由 API 生成，undo 可撤销 |
| `~/.claude/settings.json` | **未改**，仅备份 | `settings.json.bak-bench-20261113` |
| `.token-test/codex-min-home/config.toml` | 新增隔离测试配置 | 测试用，可删 |

`ANTHROPIC_*` 环境变量与 `~/.claude/settings.json` 的 DeepSeek 官方 key **按用户选择"先给命令不改"，本轮未动**。

---

## 七、当前状态与待确认事项

### 已解决（本轮完成）

1. ✅ `hy3free` → **`hy3`**（桥上 404，用户已确认选 `hy3`）。
2. ✅ **配置授权已给并已执行**：`ch-acp-ds` 通道、`BenchDS` 角色、Codex 接桥全部完成，逐文件备份（见 6.5）。
3. ✅ **方案 d 已实跑打通**：真实 `codex exec` 四模型全部 exit=0（见 6.2）。
4. ✅ **4 格链路冒烟已跑**：a/b/c/d × `hy4free` 全部答对（见 6.4）。
5. ✅ **48 格预算已给**：典型 19.2M tokens / **4.80 分** / 约 2~3 小时；保守上限 21.4M / 11.52 分（见第五节）。
6. ✅ DeepSeek 官方 key 止血按用户选择"先给命令不改"，命令见第二节，本轮未动。

### 仍需用户决定（决定后才能推进 16/48 格）

1. **T1 任务形态**：`hy4free`/`hy3` 在 `effort=high` + 长任务下把输出额度全烧在思考 token、正文为空（实测 5.1）。是 ① 保留长 T1、把 hy 系标"收敛失败"如实记录；还是 ② 统一改成短可收敛任务（如 6.4 的求和任务）？**推荐 ②**，否则质量维度对两个模型不公平。
2. **规模**：4 格冒烟已完成 → 下一步跑 **16 格**（4 方案 × 4 模型 × 1 次，约 1 小时 / ~1.6 分），还是直接补到 **48 格**（~5 分 / 2~3 小时）？
3. **"上下门长度拉到最高"** 的口径：`hy3` 只有 192K，其余三个 300K。是统一 `max_tokens=64K` 对齐，还是各按模型上限（不对等）？
4. **方案 c 的操作入口**：桥直调已由脚本驱动（等价于 WorkBuddy 模型层）。若严格要求"在 WorkBuddy 桌面端里操作"，需要确认由谁操作；脚本口径已可出数据。
5. **测量口径**：冒烟证明桥账本混有主控调用、a 走 CLI 不进账本（6.4）。16/48 格是否需要按"每格独立会话 + 余额打点 + 平台侧 token"三口径交叉？推荐是。

### 尚未完成

- 16 格 / 48 格对照实测与最终报告 `docs/plan/2026-11-13-multi-platform-benchmark.md`。
