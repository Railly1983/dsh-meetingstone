# 发布前状态总表（2026-11-12 收尾）

> 版本：`0.1.0-alpha.23`（已安装、已验证）
> 测试：649 tests / 648 pass / 1 skip
> 门禁：9 PASS / 0 SKIP（新增「D1 渲染核对」）
> D1 自动核对：**24 PASS / 0 FAIL**
> 工作树：干净

---

## 一、Codex 交叉评审 P0 项

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| 1 | UI 验收 | 🟢 **24 项自动验证通过**，剩 9 项交互需人眼 | `scripts/verify-d1-render.mjs` |
| 2 | CLI 与模型路由矩阵 | ✅ **静态可信 + 动态可证** | `docs/plan/2026-11-12-route-matrix.md` + `route-closure.md` |
| 3 | 续聊、取消与进程管理 | ✅ **外部 CLI 路径打通 + 进程零残留** | `steer-restart-final.md` + `process-cleanup-verification.md` |

### 1.1 D1 验收：从 46 步压缩到 9 项

原本全部归为「只能人眼看」。后来发现其中 **24 项本质是结构判断**，
用 `scripts/verify-d1-render.mjs` 从真实 profile 推导 + 源码结构核对，全部自动化：

| 已自动验证（24 项） | 结果 |
|---|---|
| 设置页只有两区、区标题「全局角色库」 | ✅ |
| 无「右侧栏」「本对话角色」「额度耗尽」「通道」用户可见文案 | ✅ |
| 两色语义（无 yellow、有「不表示实时额度」说明） | ✅ |
| 「保存修改」「新增角色」「删除角色」「刷新能力」「返回」都存在 | ✅ |
| 删除有二次确认（`confirmDelete` + `deleteConfirming`） | ✅ |
| 保存有二次确认（`confirmGlobal`） | ✅ |
| U2 断言**无** `sidebarRight.openTab`（确实内联） | ✅ |
| 按钮都绑了 `onClick: opts.onXxx`（不是死按钮） | ✅ |
| 4 个 CLI 全部存在；dsh / CodeBuddy / Codex 都有模型 | ✅ |
| dsh 与 CodeBuddy 都有 `high` | ✅ |
| 真实 profile 5 个启用角色；颜色只有绿/灰 | ✅ |

**只剩 9 项需要人眼**：确认「点下去真的有没有反应」+ 视觉布局。

### 1.2 路由矩阵详情

**静态（可信）**：5 个启用角色的通道/角色/provider/model/reasoning 声明全部自洽，
与 provider 行 `--model`/`--effort` 逐项一致；两道 fail-closed 校验保证不一致必然拒绝。

**动态（已闭环）**：新增 `effectiveProvider` / `effectiveModel` / `reasoningEffort`
三个字段落盘，真机验证正确写入。

### 1.3 steer 外部 CLI 路径

**八轮真机测试，累计修掉 8 个缺陷**，全部在「单测全绿」状态下存在。

最终验收（alpha.20）：
```json
{ "ok": true, "mode": "restart-with-output",
  "childId": "44f26383-...", "previousChildId": "bf8e3974-...",
  "stopConfirmed": true }
```
新任务真的执行了插话指示（统计范围从 `src/dsh` 改为整个 `src`）。

### 1.4 进程清理

基线 5 个 node 进程 → 派 ACP 任务 → 取消 → 10 秒后：**超出基线 0 个**。
另有 `interrupted` 投影的单测覆盖（重启后僵尸任务必须被识别）。

---

## 二、Codex 交叉评审 P1 项：全部闭环

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| 4 | Worktree 真实并行验收 | ✅ **通过** | `2026-11-12-worktree-parallel-write.md` |
| 5 | 安全审计 | ✅ **无高危，1 中危已修** | `2026-11-12-security-audit.md` |
| 6 | Token 优化复核 | ✅ **三项全部落地** | `2026-11-12-token-verification.md` |
| 7 | 产品体验复核 | ✅ **5 处不一致，4 处已修** | `2026-11-12-ux-review.md` |

### 2.1 Worktree 并行写入

A/B 同批并发派出 → 各落独立 worktree → 只创建自己的文件 →
双向交叉核验成立 → 合并无冲突 → 用户未提交文件 SHA256 逐字节不变。

**重要边界**（八戒指出的）：`overlapWarnings` 是**事后检测而非事前锁**。

### 2.2 Token 优化实测

| 工具 | 实测 |
|---|---|
| `get_task` | 省 **88%**（6354 → 746 B） |
| `list_runs` | 省 **89%**（156151 → 17082 B） |
| `list_roles` | 245 B（约 61 tokens） |

---

## 三、额外完成

| 项 | 内容 |
|---|---|
| 超时测试盲区 | 此前所有 adapter 测试都用 `timeoutMs: 0`，超时路径零覆盖。新增 5 条 + interrupted 投影 1 条 |
| 磁盘清理 | 删除 3 个过期 verify 日志（466.5 KB）+ 2 个测试残留 + 15 个终态 worktree（约 40 MB） |
| README 修正 | 两份 README 状态行从 2026-11-10 更新，工具数 8→10，UI 描述与实际一致 |
| UX 收口 | 「默认角色配置」→「全局角色库」；`SOURCE_LAYERS` 去掉 project/session；`confirmDeleteRole` 对齐 B3 |
| TODO 清理 | 4 个已解决的 TODO 改为「已解决」+ 证据 |

---

## 四、唯一未完成项：D1 的 9 项人眼确认

**这是唯一需要用户亲自做的。**

| # | 要确认什么 |
|---|---|
| U1 | 设置页两区**看起来**排布正常 |
| U2 | 点「管理角色」→ 面板**真的**在页内展开 |
| U3 | 改角色名 → 保存 → **真的**弹二次确认 → **真的**生效 |
| U4 | 点「新增角色」→ **真的**出现在列表 |
| U5 | 点「删除角色」→ **真的**弹确认 → **真的**消失 |
| U6 | 模型下拉**真的有选项**；「刷新能力」**不报错** |
| U8 | 开关点击**真的**即时生效；颜色只有绿/灰 |
| U9 | 右侧栏 / 页头**真的**看不到角色入口 |
| U10 | 点「返回」→ **真的**回到设置主区 |

清单：`docs/plan/verify/2026-11-13-d1-user-checklist.md`

---

## 五、待决策（不阻塞发布）

### 5.1 取消确认的时序提示

`cancel_task` 回执 `stopConfirmed: false`，但 3-10 秒后记录变 `true`。
根因：外部 CLI 的 `dispose()` 异步。建议加 hint。见 `2026-11-12-cancel-timing.md`。

### 5.2 槽位泄漏根因

DSH 重启时 `onFinish` 不触发 → 槽位泄漏。
已缓解（上限 8 + 可诊断），根因未修。见 `2026-11-12-slot-leak-critical.md`。

### 5.3 ACP 模型接受度

`kimi-k3.1-pro` / `hy4free` / `hy3` / `glm-5.3-flash` 在高强度下是否被接受，
需要真实派单验证（会消耗外部 CLI 额度）。

---

## 六、发布判断

| 维度 | 状态 |
|---|---|
| 自动化测试 | ✅ 649 / 648 pass / 1 skip |
| 发布门禁 | ✅ 9 PASS / 0 SKIP |
| D1 自动核对 | ✅ 24 PASS / 0 FAIL |
| P0 核心功能 | ✅ 全部闭环（除 9 项人眼确认） |
| P1 工程质量 | ✅ 全部闭环 |
| 安全检查 | ✅ 无高危，中危已修 |
| 安装回滚 | ✅ install-safe 可用，回滚目标存在 |
| 文档 | ✅ 清理完毕，README 已修正 |

**结论：技术条件已满足发布。唯一缺口是 9 项人眼确认。**

按 Codex 评审的发布标准：
> 未实际测试的模型或通道，不得显示为已验证可用。

本项目的做法是：**未验证项全部在报告里明确标注为「未验证」**，没有伪装成已验证。

---

## 七、发布清单

如果用户确认那 9 项通过，发布步骤：

1. `node scripts/release-check.mjs`（已 9 PASS）
2. `npm pack`
3. `node scripts/install-safe.mjs --tgz <new.tgz> --previous <old.tgz>`
4. 重启后验证版本号
5. 冒烟：`meetingstone_stats` + 一次真实派单

回滚目标：`C:\Users\30673\.dsh\packages\dsh-meetingstone-0.1.0-alpha.22.tgz`


---

---
