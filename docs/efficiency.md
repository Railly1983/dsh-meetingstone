# 协作效率规范

> 这是一份**协作约定**（纯文档 / 提示词），不是代码、不是配置、不是门禁。
> 系统不会因为派单写得简略就拒绝执行；规范只为少返工、少烧上下文、少来回。
> 实现细节见 [架构](architecture.md)，错误码见 [配置参考](configuration.md)。

## 为什么有这份文档

派单，就是把一段话交给另一个智能体去干活。话写得太含糊，对方要么反复追问、要么做偏；
回复写得太啰嗦，上下文很快被长文占满；收口时一遍遍查状态、失败时盲目重试，都是纯浪费。
下面 4 条，就是把这些浪费挡在前面的约定。

## 1. 派单简报：说清四件事

一次派单把下面四件写清楚：

| 项 | 写什么 | 例子 |
| --- | --- | --- |
| 目标 | 要达成什么结果 | 给超时分支补一个单测 |
| 范围 | 只改哪些、不要碰什么 | 只改 `tests/dispatcher.test.mjs`；不动 `src/`、不改配置 |
| 验收标准 | 怎样算做完 | `node scripts/run-tests.mjs` 全绿 |
| 证据格式 | 交什么、交到哪 | 结论 + patch + 测试输出路径；全文写 `.meetingstone/runs` |

**不硬拒绝**：这四件是规范，不是校验。派单缺了某一项，系统照样执行，不会拦你、不会报错。
只是缺得越多，对方越可能跑偏或来回追问——省下的字，最后都会以返工还回来。

> 现在可以把这四件写成**结构化字段**（`title` / `objective` / `scope` / `acceptance` / `evidence` /
> `contextRefs` / `contextPack`），由插件渲染进子 Agent 提示词。仍不是表单：只有缺 `title`
> （用了任一结构化字段时）、声明了 `scope` 却没有 `acceptance`、或关键字段类型错误时才会
> 返回 `TASKSPEC_INVALID`。字段与校验规则见
> [配置参考 §7.1–7.2](configuration.md#71-taskspec结构化任务简报p0-b)。

## 2. 输出：只给"能用的东西"

子智能体回复时，只给三样：

- **结论**：做完了 / 没做完 / 卡在哪；
- **产物**：patch、JSON、命令输出这类结构化结果；
- **证据路径**：完整日志、长文写到 `.meetingstone/runs`，回复里只给路径。

禁止把长文、整份文件、大段原文复述回会话。上下文是共享的稀缺资源，复述一遍等于花两遍钱
买同一段字。要查全文，按路径去 `.meetingstone/runs` 取，别在会话里再贴一遍。

> 派单提示词里已经固定写入**输出契约**：子 Agent 最后返回 `status` / `summary` / `evidence` /
> `artifacts` / `changedFiles` / `tests` / `openIssues` / `nextAction`。插件解析后默认只把
> `summary` / `handoff` 交给主控；完整正文用 `meetingstone_get_run_artifact` 按范围读取。
> 模板与字段见 [handoff.md](handoff.md)。

## 3. 收口：一次查，批量报

不要周期轮询——每隔一会儿 `get_task` 一下、几十次调用只为等一个状态，纯烧调用不产生信息。
任务该收口时，一次性 `list_runs` / `get_task` 把这一批的终态取齐，然后**批量汇报**一次。
"等"交给宿主和任务本身，主导者不靠反复查询来推进。

优先用 `meetingstone_wait` **一次等齐**：`childIds` 传本批全部任务，`timeoutMs` 给一个上限
（默认 300000、最大 600000），一次调用等到全部完成或超时。超时的任务回 `status:'running'` +
`timedOut:true`，未知 `childId` 回 `UNKNOWN_CHILD` 并立即返回；已完成的立即返回，未完成的只等
宿主结算通知，不忙等。**不要在高频循环里反复 wait 或拿它当轮询**，字段见
[配置参考](configuration.md) §7，错误码见 §5。

## 4. 失败：先分类，再决定

失败不是"再试一次"就完了。插件会把失败归入下表的**白名单**，落盘 `failureClass` 并给出一句
`hint`；主控据此决定等、换角色还是先查日志。建议由主导者拍板，**不自动执行**：

| `failureClass` | 典型表现 | 建议（`hint` 摘要） |
| --- | --- | --- |
| `quota` | Codex `category: limit`、ACP 429、`refusal` 且**空输出** | 等待额度重置，或改派其他 provider 的角色；不要原样重派 |
| `auth` | 401、无效 API key、登录失效 | 先检查该 provider 的登录 / API key，再重新派单 |
| `permission` | 403、`EACCES` / `EPERM`、权限被拒 | 确认工作目录与命令权限（沙箱 / 审批）后重派 |
| `timeout` | 超过 `timeoutMs`、`ETIMEDOUT`、deadline exceeded | 缩小范围或拆子任务后重派 |
| `refusal` | 安全拒答，且**有输出**（非额度） | 改写任务措辞或换模型 / 角色；必要时人工确认 |
| `crash` | 进程异常、非零退出、被信号杀死 | 查 provider 日志与退出码后换角色重派，保留现场 |
| `network` | `ECONNRESET`、DNS、502/503/504 | 检查到 provider 的连通性后再重试，别当成额度问题 |
| `unknown` | 已失败但无法归入以上类别 | 先读 `diagnostic` 与 provider 日志，再决定是否重派 |

判定顺序固定（先 `quota`，再 `auth` → `permission` → `timeout` → `network` → `refusal` →
`crash`，兜底 `unknown`）。**成功任务不会带分类**：`status=completed` 且
`stopReason=completed` 的记录 `failureClass`/`hint` 为 `null`；`cancelled` / `interrupted`
是主动取消或卸载，也不算失败。真实故障的区分要点：

- Codex 额度耗尽：`stopReason: error` + 诊断含 `category: limit` → `quota`；
- CodeBuddy hy4 的 429：ACP 只回 `stopReason: refusal` + 空输出 → 按需求归 `quota`；
- 安全拒答与额度不同：`refusal` **有输出**且不含限流特征才是 `refusal`。

落盘位置：run 记录（`.meetingstone/runs/<childId>.json`）的 `failureClass` / `hint`；
`meetingstone_get_task` 与 `meetingstone_list_runs` 默认展示这两个字段。旧记录没有字段，
读取时按 `stopReason` / `diagnostic` / `error` 现算，不需要迁移。

> **明确不做**：自动重试、冷却计时器、自动切模型 / 切角色。额度要等重置、认证要换 key、
> 权限可能要改沙箱或审批——这些都需要人或主控拍板；插件自动重试只会把同一个错误再烧一遍
> 额度，并让真实原因淹没在重试日志里。宿主容量满时同样没有等待 / 队列机制，插件原样透传
> `ACTIVATION_LIMIT_REACHED`（见 [配置参考](configuration.md) §5），是否等、是否换人由主控决定。

## 反例：什么算浪费

- 派单只写"改一下 X""看看这个"——没目标、没边界、没验收，对方只能猜，来回追问三轮。
- 子智能体把改动的整个文件原样贴回来，或把日志全文复述一遍——占满上下文，主导者还得自己找重点。
- 主导者每半分钟 `get_task` 一次，为一个任务发几十次状态查询。
- 一个任务一个任务单独汇报，明明可以收口时一次批量说清。
- 失败不分类：429 和"宿主满了"都当成"再试一次"，反复撞同一堵墙；或容量已满还不断派新单。
- 把整段需求 / 背景复制进每一次派单，而不是给路径让对方自己去取。

## 一个合格派单（模板）

```
目标：给 `src/dispatch/dispatcher.js` 的 dispose 超时分支补一个单测，断言槽位未被释放。
范围：只改 `tests/dispatcher.test.mjs`；不改 `src/`、不改配置、不 commit。
验收标准：`node scripts/run-tests.mjs` 全绿；新用例在 dispose 超时时断言槽位保留。
证据格式：回复只给「结论 + patch + 测试输出摘要」；完整测试日志写 `.meetingstone/runs`，
          回复里附该路径。
```

对照四件套：目标 ✅ / 范围 ✅ / 验收标准 ✅ / 证据格式 ✅。
注意它没写"必须四件齐全否则拒绝"——因为本来就不拒绝，这只是把话说明白。

## 5. 效率账本：把「省了多少」变成可复现统计

`scripts/token-ledger.mjs` 只读扫描 `.meetingstone/runs/*.json`，统计任务数、成功/失败/取消、
失败分类、`resultBytes` 分位（p50/p90/max）、平均耗时，以及按角色/通道聚合。零依赖，不参与
`npm run verify`。

```bash
npm run ledger                              # 人类可读表格
node scripts/token-ledger.mjs --json        # 机器可读
node scripts/token-ledger.mjs --since 7d    # 相对时间（也支持 24h/30m、YYYY-MM-DD、ISO、毫秒时间戳）
node scripts/token-ledger.mjs --limit 20    # 最近 20 条
node scripts/token-ledger.mjs --dir <path>  # 指定 runs 目录（默认自动定位；worktree 回退主仓库）
```

**口径（先读）**：

- **字节 ≠ Token**。脚本不输出 `approxTokens`，也不把字节数当 Token 汇报。
- runs 记录**没有 Provider Usage 字段**，Provider Usage 一律标「未知」；找不到可读的宿主
  会话/工具调用 JSONL 时就只做 runs 维度（本次基线未找到）。
- 失败分类是从 `stopReason` / `diagnostic` / `error` / `resultStatus` 推导的**启发式**分类；
  无信号时记 `unspecified`，不猜原因。
- `resultBytes` 只统计成功记录（`status=completed` 且 `stopReason` 为 `completed`/空且
  `resultStatus` 非 `failed`/`blocked`），含 0 字节；失败/取消/运行中不计入。
- `completed` 但 `stopReason=refusal/error` 的记录计入失败，避免「跑完但没干活」被算成功。

首份基线（样本、数字、局限）见
[`docs/plan/2026-11-11-ledger-baseline.md`](plan/2026-11-11-ledger-baseline.md)。

## 6. Token 数字的可信边界

Subagents 面板显示的 `tok` 是 `uncachedInput + output + cacheRead + cacheWrite` 四桶之和，
按**整条持久日志累计**；fork 会话包含父会话历史（`154M tok / 4 秒` 即此：token 继承父前缀，
耗时只算子会话自身）。**不可用于成本、额度或子 Agent 归属核算**。

- 为什么：cache 命中与未命中按 1:1 相加、跨调用重复累计、四桶未乘单价；fork 会把父会话的
  同一批 token 在父子面板各显示一次。
- 可用于：展示“累计处理量 / 吞吐”，但必须标注“累计、含 cache 重读”。
- 替代口径：账本字节（§5 的 `resultBytes`，字节不是 token）、`ownEvents` 截断后的 usage、
  四桶分价、Provider 账单。

完整推导、三例对账与未验证项见 [`docs/audit/token-stats.md`](audit/token-stats.md)。

## 不在本规范范围（明确不做）

以下几项评审过但**砍掉**（指不写进本「协作约定 / 提示词」文档），不要补进来，也不算"没写完"：

- AI 语义自动路由（按自然语言理解“猜”该找谁）
- 冷却时间 / 自动换模型（失败处置是人工建议，系统不自动切）

> 注：**规则式角色路由（P1-B）** 已作为**代码级派单功能**落地：只在未显式指定 `role`
> 且传 `autoRoute:true` 时生效，按显式关键词表 + `enabled`/`availability` 过滤，回执带
> `routing.reason`，不调用 AI、不改 provider/model/权限。规则表与优先级见
> [配置参考 §1.2](configuration.md#12-自动角色路由p1-b规则式)。
>
> 注：**进行中完全相同任务去重**已作为**代码级派单功能**落地（P0-D），不是本协作约定的内容：
> 它按指纹判定、只对进行中任务生效、命中返回既有 `taskRef`，版本或信息不足时照常新建。
> 指纹组成与误判边界见 [配置参考](configuration.md) §7.5。

这些要么与宿主能力重复，要么会把"约定"变成"自研调度"，违背"薄"的原则
（见 [架构](architecture.md) §3、§5）。
