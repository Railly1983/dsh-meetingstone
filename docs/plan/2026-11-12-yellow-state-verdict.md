# 角色黄色状态 P0：最终裁决

> 日期：2026-11-12  
> 裁决人：唐僧（已获用户当晚授权）  
> 状态：**最终裁决，交 Lead 实现**  
> 裁决：**选 A。V1 角色状态从三色收敛为绿 / 灰两色，取消黄色及“确认无额度”的产品承诺。**

本文取代 `docs/plan/2026-11-12-yellow-state-decision.md` 中“建议 B、待用户决策”的待决状态；原文保留为评估记录，不再作为实现依据。

## 一、裁决结果

1. **不采用 B**：不得读取 `failureClass=quota` 后把角色标黄，也不得把它注入 `quota=exhausted`。
2. **不采用 C**：不接 WorkBuddy 私有额度 API，也不分别适配 Codex / Claude / CodeBuddy 的认证态和额度接口。
3. **采用 A**：删除活动状态模型中的 `ROLE_COLOR.YELLOW` 与 `QUOTA.EXHAUSTED`，角色 Switch 只保留绿 / 灰；`quota` 字段仍如实保留 `available / unknown / not_applicable`，缺证据时仍是 `unknown`。
4. 原始“黄 = 正常但确认无额度”需求在 V1 **正式撤回**，不是改名成“最近额度失败”后继续保留。未来只有取得可信、实时的额度事实源，才可重新立项评审第三色。

## 二、理由

1. **诚实优先于补齐颜色。** `src/gui/state-model.js:5-17` 已明确：失败分类不是额度事实，缺证据必须为 `unknown`。B 若仍写 `exhausted`，直接违反这条边界；若另造历史信号，则已经是在做另一个需求，而不是修复原黄色语义。
2. **B 的提示价值和原需求不等价。** 它必须等待一次失败，充值后也不能立即恢复；黄色只能证明“某次历史派单失败”，不能证明“现在无额度”。即使文案改准确，也不能把它当作原三色需求的完成。
3. **B 并非当前代码结构下的低成本接线。** `createGuiState()` 没有 `listPersistedRuns` 输入，`roleView()` / `snapshot()` 是同步投影；更重要的是设置页 Remote 没有会话 `cwd`（`docs/gui-0.2.0.md:283-285`），而 run 记录按项目根隔离。要正确实现 B，必须新增项目身份传递或跨项目聚合规则，不能再声称只是“一个读 run 的派生函数”。
4. **A 符合最简化和职责边界。** 不新增 Remote 参数、项目上下文、文件扫描、TTL、定时失效或跨项目规则；现有 run 的 `failureClass` 继续用于派单诊断，不被状态颜色重复消费。
5. **C 明显越界。** 多 CLI 私有接口和认证态适配会把插件变成 Agent 管理平台，且形成长期维护负担，今晚不做。

## 三、V1 状态语义（两色，不再有第三种颜色）

| 颜色 | 中文语义 | English semantics |
|---|---|---|
| 绿 | 未关闭且依赖就绪；**不声明额度充足，也不表示实时额度** | Enabled and dependencies are ready; **does not claim that quota is available or report real-time quota** |
| 灰 | 已关闭，或依赖阻断 / 就绪状态未知 | Off, or dependencies are blocked / readiness is unknown |

补充边界：

- Switch 仍是开 / 关两态控件；颜色只是只读状态投影。
- `quota=unknown` 不得渲染成“额度充足”；绿色只说明启用意图与依赖就绪。
- `failureClass=quota` 继续留在 run 记录、失败提示和派单诊断中，不进入角色颜色矩阵。
- 不设置 TTL，因为本裁决不采用 B。

## 四、UI 文案（定稿）

在“默认角色配置”区域放一条统一说明，不在每行重复：

- 中文：**颜色仅表示启用与依赖就绪状态，不表示实时额度。**
- English: **Colors only indicate enablement and dependency readiness, not real-time quota.**

状态短文案：

| 状态 | 中文 | English |
|---|---|---|
| 启用且就绪 | 已启用 | Enabled |
| 已关闭 | 已关闭 | Off |
| 依赖阻断 | 依赖阻断 · `{readinessReason}` | Blocked · `{readinessReason}` |
| 就绪未知 | 状态未知 | Unknown |

删除 `roleQuota` 的“额度耗尽 / Quota exhausted”文案及其渲染分支。任何位置都不得把绿色写成“正常可用且额度充足”。

## 五、文档记录要点

必须记录以下事实，避免后续重新踩入同一问题：

1. 当前 DSH 宿主没有可用额度查询 API；错误分类常量与 `isQuotaExceededError` 不是余额 / 剩余额度接口。
2. V1 主动取消黄色，不承诺实时额度；绿色不等于有额度，`quota=unknown` 保持未知。
3. `failureClass=quota` 是历史失败诊断，包含额度 / 频率限制等情形，不是当前额度计量。
4. 设置页是全局角色视图，Remote 当前无会话 `cwd`；不得为了颜色暗中跨项目读取或混用 run 记录。
5. 只有未来出现可信的实时额度事实源，才重新评审第三色；不得默认接各 CLI 私有 API。

文档落地范围：

- 更新 `docs/gui-0.2.0.md` §10.2：三色矩阵改为上述两色，删除黄色与额度原因承诺，补上统一说明。
- 在 `docs/plan/2026-11-12-yellow-state-decision.md` 顶部标记“已被 verdict 取代，B 不实施”，链接本文。
- 更新 `docs/plan/2026-11-12-tonight-report.md` 与 `docs/plan/2026-11-12-tonight-plan.md` 的待决状态，指向本文。
- `docs/configuration.md:178-179` 的“无证据一律 unknown”继续保留；`docs/efficiency.md` 的失败分类语义不变。
- 历史 release / verify 记录是当时证据，不回写篡改；后续实现与验收以本文为准。

## 六、给 Lead 的实现清单

### 1. `src/gui/state-model.js`

- 文件头、颜色语义与类型注释统一改为“三字段 + 绿/灰两色”；删除所有“黄 / exhausted”活动契约。
- 从 `QUOTA` 删除 `EXHAUSTED`，从 `ROLE_COLOR` 与 `ROLE_COLOR_LABEL` 删除黄色；`STATE_MODEL_VALUES` 随枚举更新。
- `deriveQuota()` 保持纯函数与缺证据 `unknown`；`quota:'exhausted'` 不再是合法输入，应回落 `unknown`。继续拒绝 `failure / inferred / guess / estimated` 等来源伪造 `available`。
- `deriveRoleColor()` 只根据 `userPreference` 与 `readiness` 派生：disabled 或 readiness 非 ready → gray，否则 → green；不再读取 `quota`，不再保留黄色分支。
- `deriveRoleView()` 仍返回 `quota` 供只读诊断，但颜色只传偏好与就绪；更新 JSDoc 返回类型。

### 2. `src/client/index.js`

- `normalizeRoleState()`：不再接受 `quota:'exhausted'` 与 `color:'yellow'`；非法 / 旧值分别归一为 `unknown` / `gray`。
- `Switch()`：prop 类型、轨道颜色和注释收敛为 gray / green；删除 warning 黄色轨道。
- `roleColorTone()`：删除 yellow → warning；只保留 green → success，其余 neutral。
- `roleReasonOf()`：删除 `state.quota === 'exhausted'` 分支；保留 disabled / blocked / unknown 解释。
- 角色 Switch 的 `title` 使用 `roleReasonOf(t, role) || t('roleEnabled')`，让灰色原因实际可见；不改变开关写入行为。
- 中英文词典删除 `roleQuota`，新增第四节那条 `roleColorNote` 统一说明，并在“默认角色配置”标题附近渲染一次。
- 文件头及“三色 / tri-color”注释同步改成两色；不得新增 run 拉取、时间格式化或 TTL 代码。

### 3. 明确不要改的路径

- `src/gui/host.js:156-160`：保持不传 `quota`，也**不得**传 run 派生的 `quota` / `quotaSource`。
- `src/index.js`：不得为颜色新增项目根、RemoteScope 或 `listPersistedRuns` 接线。
- `src/run-store.js`、`src/dispatch/failure.js`、`src/dsh/adapter.js`：保持失败分类与落盘行为不变。
- 不改 profile、不重启 DSH、不安装依赖，不做 C 的私有 API 探测。

### 4. 测试与验收

- `tests/state-model.test.mjs`：枚举改为两色、三个 quota 值；颜色矩阵改为偏好 × 就绪；删除“显式 exhausted → 黄”的旧断言，新增“exhausted / failureClass=quota / 429 均不能改变 quota 事实或产生黄色”的回归断言。
- 检查 `tests/gui.test.mjs`、`tests/gui-u2-u3.test.mjs`、`tests/gui-primitives.stub.test.mjs`：更新两色契约、Switch title 与中英文说明断言；当前源码检索显示黄色 / exhausted 单测集中在 `state-model.test.mjs`，但仍需跑完整套件防漏。
- 运行 `npm test` 与 `npm run verify`，全部通过后才可交付。
- 真机 / stub 验收：启用且 ready 为绿；disabled、blocked、unknown readiness 为灰；构造历史 `failureClass=quota` 后角色颜色不变，run 详情仍显示原失败分类；界面出现“不表示实时额度”说明且无黄色轨道。

## 七、重新开放条件

只有同时满足以下条件才可重新提出黄色：

1. 有明确、可信、实时的额度事实源，而非失败记录推断；
2. 能说明其角色 / 项目 / provider 作用域与失效规则；
3. 不依赖各 CLI 私有接口的分散适配，不突破 MeetingStone 职责边界；
4. 另立方案评审，不把本次 A 裁决解释成隐藏的 B 授权。
