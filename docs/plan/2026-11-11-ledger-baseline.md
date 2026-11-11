# 效率账本基线（runs 维度）

> 日期：2026-11-11
> 快照时间：`2026-11-11T06:21:53.268Z`（UTC）
> 数据源：`D:\MeetingStone\.meetingstone\runs`（62 个 run JSON；坏/非 run JSON 0 个）
> 复现：`node scripts/token-ledger.mjs`（表格）/ `node scripts/token-ledger.mjs --json`（机器可读）
> 产物：`.meetingstone/runs/ledger-baseline-2026-11-11.txt`、`.meetingstone/runs/ledger-baseline-2026-11-11.jsonl`

## 声明（先读）

- **字节 ≠ Token。** 本报告只统计 runs 记录里可直接观测的 `resultBytes`，不做 `bytes/4` 之类的
  估算，也不输出 `approxTokens`。
- **Provider Usage 未知。** runs 记录不含 Provider Usage 字段；本机 `~/.codebuddy/projects/<project>/sessions`
  下未发现可读的 `.jsonl` 会话/工具调用统计，因此本次只做 runs 维度。Token、主控开销、工具调用
  次数均记「未知」，不以字节数冒充。
- **这是基线，不是前后对照。** 本报告没有改造前样本，不能据此得出「节省了多少」；它只固定
  口径、留下当前快照，供后续同口径复跑对照。
- 快照含 4 条生成时仍为 `running` 的记录（其中可能包括本次账本任务自身）；它们计入任务数，
  不计入耗时与结果字节。

## 一、口径

### 1. 样本

`scripts/token-ledger.mjs` 只读扫描 runs 目录下顶层 `*.json`，按 `createdAt` 降序；只接受
含 `childId` 的 run 记录。坏 JSON 与同目录其他 JSON 跳过并计数，不中断统计。

本快照未使用 `--since` / `--limit`，即扫描当时目录内全部 62 条记录。runs 目录本身受
`DEFAULT_MAX_RUNS=100`、`DEFAULT_MAX_AGE_MS=30d` 清理策略约束（`src/run-store.js:51`），
所以「全部」也只是一段保留窗口，不是历史全集。

### 2. 结果归并（`outcomeOf`）

| 归并结果 | 判定 |
| --- | --- |
| `success` | `status=completed` 且 `stopReason` 为 `completed`/空，且 `resultStatus` 非 `failed`/`blocked` |
| `failed` | `status=failed`；或 `status=completed` 但 `stopReason` 不是 `completed`/空；或 `resultStatus=failed`/`blocked` |
| `cancelled` | `status=cancelled` 或 `stopReason=cancelled` |
| `interrupted` | `status=interrupted` 或 `stopReason=plugin-disposed`/`interrupted` |
| `running` | `status=running` |
| `unknown` | 其余 |

原始 `status` 分布另列，归并只用于回答「任务实际干成没有」。因此 `status=completed` 但
`stopReason=refusal/error` 的记录计入失败，不会把「跑完但没干活」算成成功。

### 3. 指标

- **耗时**：`finishedAt - createdAt`（毫秒），只统计两者都存在且 `finishedAt >= createdAt` 的
  终态记录；包含排队/启动时间，不是纯模型推理时间。
- **resultBytes**：只统计 `outcome=success` 的记录（含 0 字节）；失败/取消/中断/运行中的结果
  不计入。它是一条结果正文的 UTF-8 字节数，不是上下文总量，也不是 Token。
- **分位**：线性插值（R-7），p50/p90/max。样本为空时输出 `null`，不补 0。
- **失败分类**：启发式，来源为 `stopReason` / `diagnostic` / `error` / `resultStatus` 文本信号。
  `stopReason=refusal` 优先记为 `refusal`；诊断里的「可能是 429」只是提示，不升级为
  `rate-limit`，避免把猜测当结论。无信号记 `unspecified`。
- **改动文件**：只统计 `changedFiles` 为数组的记录；`changedFilesUnknown=true` 单独计数，
  不当作 0 个改动。

## 二、样本

| 项 | 值 |
| --- | ---: |
| 扫描文件 | 62 |
| 有效 run 记录 | 62 |
| 坏/非 run JSON | 0 |
| createdAt 范围 | `2026-11-10T15:21:27.246Z` ~ `2026-11-11T06:17:25.771Z`（约 14 小时 56 分） |
| 终态记录 | 58 |
| 生成时 running | 4 |

## 三、结果

### 1. 总体

| 指标 | 值 |
| --- | ---: |
| 任务数 | 62 |
| 成功 | 47 |
| 失败 | 7 |
| 取消 | 2 |
| 中断 | 2 |
| 运行中 | 4 |
| 未知 | 0 |
| 终态成功率 | 47 / 58 = 81.0% |
| 平均耗时 | 404545 ms（约 6.7 min），n=58 |
| 耗时 p50 / p90 / max | 336320 / 943170 / 1929786 ms（5.6 / 15.7 / 32.2 min） |
| resultBytes p50 / p90 / max | 4802 / 9943 / 13593 B（4.7 / 9.7 / 13.3 KiB），n=47 |
| resultBytes 合计 / 均值 | 237398 B（231.8 KiB）/ 5051 B（4.9 KiB） |
| 改动文件 | 已知 36 条，合计 109 个，单任务最多 16 个；unknown 0 条 |

原始 `status` 分布：`completed 54`、`running 4`、`cancelled 2`、`interrupted 2`。
`completed` 比成功多 7 条，正是 `stopReason` 为 `refusal`/`error` 的失败记录。

### 2. 失败分类（启发式）

| 分类 | 数量 | 证据 |
| --- | ---: | --- |
| `refusal` | 5 | 5 条 `stopReason=refusal`；其中 2 条诊断文本为「可能 429 或模型拒绝」，未证实，不升级为 rate-limit |
| `error` | 2 | 2 条 `status=completed`、`stopReason=error`，诊断均为 `Product subagent failure … category: limit`；无更细字段，归入 error |
| `rate-limit` | 0 | 本快照没有可确认的 429/限流字段 |
| `timeout` | 0 | — |
| `auth-or-permission` | 0 | — |
| `unspecified` | 0 | — |
| **合计** | **7** | — |

### 3. 按角色

| 角色 | 任务 | 成功 | 失败 | 取消 | 中断 | 运行 | 平均耗时 | resultBytes p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `role-sashi` | 22 | 18 | 3 | 0 | 0 | 1 | 494073 ms（8.2 min） | 5441 B |
| `role-xiaobai` | 14 | 8 | 2 | 2 | 1 | 1 | 488985 ms（8.1 min） | 5545 B |
| `role-wukong` | 13 | 11 | 1 | 0 | 1 | 0 | 336062 ms（5.6 min） | 2363 B |
| `role-bajie` | 7 | 5 | 0 | 0 | 0 | 2 | 205721 ms（3.4 min） | 7923 B |
| `role-claude` | 3 | 3 | 0 | 0 | 0 | 0 | 350643 ms（5.8 min） | 6925 B |
| `role-tangtang` | 3 | 2 | 1 | 0 | 0 | 0 | 93971 ms（1.6 min） | 1186 B |

### 4. 按通道

| 通道 | 任务 | 成功 | 失败 | 取消 | 中断 | 运行 | 平均耗时 | resultBytes p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `acp-cli` | 36 | 26 | 5 | 2 | 1 | 2 | 492128 ms（8.2 min） | 5475 B |
| `codex` | 16 | 13 | 2 | 0 | 1 | 0 | 290670 ms（4.8 min） | 2363 B |
| `in-process` | 7 | 5 | 0 | 0 | 0 | 2 | 205721 ms（3.4 min） | 7923 B |
| `claude-code` | 3 | 3 | 0 | 0 | 0 | 0 | 350643 ms（5.8 min） | 6925 B |

## 四、局限

1. **不是 Token 账本。** runs 只有字节，没有 Provider Usage；本机也没有可读的宿主 JSONL。
   因此「省了多少 Token」当前**未验证**，脚本明确输出 `providerUsage: unknown`、`tokenEstimate: not-calculated`。
2. **样本小且有选择偏差。** 62 条全部来自本项目约 15 小时内的开发/派单，不是跨项目、跨模型、
   跨任务类型的代表性样本；runs 还有 100 条 / 30 天保留上限，存在幸存者偏差。
3. **快照会漂移。** 数据目录持续写入，重复运行会得到不同任务数；对照时必须固定 `--since/--limit`
   或保存当次 `--json` 产物。
4. **耗时是墙钟时间。** `createdAt → finishedAt` 包含排队、启动、工具等待；不能等同于模型推理
   时长，也会受系统休眠/时钟影响。
5. **resultBytes 覆盖面有限。** 只覆盖成功结果正文，不含主控输入/输出、工具回执、Context Pack、
   系统提示和重试成本；`resultBytes` 很低的成功任务不代表整体开销低。
6. **失败分类是启发式。** 依赖文本匹配，不是宿主专用字段；本快照 2 条 `category: limit` 只能
   归入 `error`，2 条「可能 429」只能留在 `refusal`。新增 provider 错误文案可能落入 `unspecified`。
7. **改动文件不是 diff 行数。** `changedFiles` 只是路径列表，可能包含生成文件；`null` 与
   `changedFilesUnknown` 不会被当成 0。
8. **未做前后对照。** 没有改造前的同口径样本，本报告不能宣称任何节省比例或效率提升。

## 五、复现

```bash
node scripts/token-ledger.mjs                 # 全量快照（表格）
node scripts/token-ledger.mjs --json          # 机器可读
node scripts/token-ledger.mjs --since 1d      # 最近 24 小时
node scripts/token-ledger.mjs --limit 20      # 最近 20 条
npm run ledger                                # 等价于第一条
```

测试：`node --test tests/token-ledger.test.mjs`（坏 JSON 跳过、空目录、分位、过滤、结果归并、
失败分类、CLI JSON/表格）。`npm run ledger` 不接入 `npm run verify`。
