# 黄色状态不可达：技术评估与决策

> ## ⚠️ 本文已被取代，**方案 B 不实施**
>
> 2026-11-12 唐僧裁决（用户当晚授权）**选 A**：V1 角色状态从三色收敛为绿/灰两色，
> 撤回「黄色 = 确认无额度」的产品承诺。
>
> 最终裁决见 **[2026-11-12-yellow-state-verdict.md](./2026-11-12-yellow-state-verdict.md)**。
> 本文保留为**评估过程记录**，不再作为实现依据。
>
> 裁决纠正了本文的一个错误判断：本文称方案 B「成本低（一个读 run 记录的派生函数）」，
> 但实际 `createGuiState()` 没有 `listPersistedRuns` 输入、设置页 Remote 无会话 `cwd`、
> run 记录按项目根隔离 —— 要正确实现必须新增项目身份传递或跨项目聚合规则。

> 日期：2026-11-12
> 触发：Codex 交叉评审 P0 —— 「修复角色黄色状态不可达问题」
> ~~结论：宿主没有额度查询能力，黄色只能靠「事后错误」推断。建议不伪造额度，改为明确区分「未知」。~~

## 一、问题现状

`src/client/index.js` / `src/gui/state-model.js` 定义了三色：

| 颜色 | 条件 | 当前是否可达 |
|---|---|---|
| 灰 | `disabled` 或 not ready | ✅ 可达 |
| 黄 | ready + `quota === exhausted` | ❌ **不可达** |
| 绿 | ready + `quota` 为 available/unknown/not_applicable | ✅ 可达 |

原因：`src/gui/host.js:156` 调 `deriveRoleView` 时没传 `quota`，
`deriveQuota()` 恒返回 `unknown` → 永远走绿色分支。

## 二、额度数据从哪来：查证结果

### 2.1 宿主没有额度查询 API

翻了 `app.asar` 全部 `dsh-llm` 实现：

- **没有** `ctx.quota` 服务
- **没有** `getBalance()` / `getRemaining()` 之类的查询方法
- 只有**错误分类常量**：

```js
const QUOTA_EXCEEDED_CODE = 'QUOTA'              // 通用额度耗尽
const ACCOUNT_QUOTA_EXCEEDED_CODE = 'ACCOUNT_QUOTA'  // 账号额度，可通过账单页充值
```

以及识别函数：

```js
function isQuotaExceededError(detail) {
  return /insufficient[\s_-]+(?:quota|balance|credits?)/i.test(detail)
    || /(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)/i.test(detail)
    ...
}
```

**这意味着：额度只有出错了才知道。** 没有任何「现在还剩多少」的接口。

### 2.2 那 workbuddy 怎么显示额度的？

用户提到 workbuddy-to-dsh 的 UI 做得好，它显示模型倍率、积分胶囊。但那是**那个插件自己调用 WorkBuddy 的私有接口**拿到的，不是 DSH 宿主提供的能力。

MeetingStone 面向 4 个 CLI（DSH / Codex / CodeBuddy / Claude），每个的额度查询方式都不同，且多数没有公开接口。

## 三、三个可选方案

### 方案 A：不做黄色，只保留灰/绿（最小改动）

- 删除 `QUOTA.EXHAUSTED` 分支或让它永不命中
- UI 上不再承诺「黄色 = 无额度」
- **优点**：诚实，不假装有能力
- **缺点**：违背用户最初的三色需求

### 方案 B：用「最近的失败记录」推断（可行，但有延迟）

**数据源**：`.meetingstone/runs/` 里有 `failureClass`

```json
{ "failureClass": "quota", "hint": "..." }
```

`failureClass=quota` 是在派单失败时由适配器识别的（`src/failure-classes.js`）。

**实现**：
1. 读该角色**最近一次**派单记录
2. 如果 `failureClass === 'quota'` 且发生在**最近 N 分钟/小时**内 → 标黄
3. 否则 → 绿

**优点**：真的能变黄（在真实额度耗尽后）
**缺点**：
- **滞后**：要等一次失败才知道
- **会过期**：额度充值后，要等下一次成功派单才能变绿
- 语义是「上次因为额度失败了」，不是「现在没额度」—— 文案必须如实

### 方案 C：接入各 CLI 的真实额度查询（做不了）

每个 CLI 都要单独实现额度查询：
- WorkBuddy：有私有 API（workbuddy-to-dsh 在用）
- Codex / Claude / CodeBuddy：需要各自的认证态与接口

**成本极高，且不属于本插件的职责边界**（Codex 评审也强调「不要变成 Agent 管理平台」）。

## 四、我的建议

**采用方案 B，但文案必须精确。**

理由：
1. 它真的能让黄色出现（满足用户需求）
2. 数据源已经存在（`failureClass`），不需要新依赖
3. 成本低（一个读 run 记录的派生函数）

**但必须改三色语义的文案**：

| 现在 | 改成 |
|---|---|
| 黄 = 正常但确认无额度 | 黄 = **最近一次派单因额度失败** |
| （未说明时间范围） | 明确标注「基于最近 N 小时内的记录」 |

**关键原则（评审也强调）**：
> 额度未知不得伪装成有额度或无额度。

所以：
- 从没派过单 → `unknown` → 绿，但 hover 提示「额度未知」
- 最近失败是额度 → 黄，提示「上次因额度失败于 X 分钟前」
- 最近成功 → 绿

## 五、实现方案（如果用户同意 B）

```
src/gui/quota-signal.js  （新增）
  export function deriveQuotaFromRuns(roleId, runs, options)
    // 1. 找该角色最近一条有 failureClass 的记录
    // 2. failureClass === 'quota' 且在 TTL（默认 6h）内 → 'exhausted'
    // 3. 否则 → 'unknown'
```

然后在 `src/gui/host.js:156` 的 `roleView` 里：

```js
const state = deriveRoleView(role, {
  subagents,
  availability: roleAvailability(role, ctx),
  sources,
  quota: deriveQuotaFromRuns(role.roleId, recentRuns),
  quotaSource: 'runs',   // 标记来源，避免被误当实时额度
})
```

**需要 host.js 能拿到 recentRuns** —— `createGuiState` 里已经有 `listPersistedRuns` 的调用路径。

## 六、待用户决策

1. **是否接受「黄色 = 最近因额度失败」这个语义**（而不是「现在没额度」）
2. **TTL 设多久**（6 小时？24 小时？）
3. 还是选择方案 A（干脆不做黄色，承认只有绿/灰）

**我不建议在没确认语义的情况下直接实现** —— 那会造出一个「看起来能变黄，但用户理解错」的假功能。
