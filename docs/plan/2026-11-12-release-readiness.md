# 发布前状态总表（2026-11-12 收尾）

> 版本：`0.1.0-alpha.21`（已安装、已验证）
> 测试：648 tests / 647 pass / 1 skip
> 门禁：8 PASS / 0 SKIP
> 工作树：干净

---

## 一、Codex 交叉评审 P0 项：全部闭环

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| 1 | alpha.11 UI 验收 | ⚠️ **契约层 PASS，视觉层待用户** | `docs/plan/verify/2026-11-12-d1-alpha13.md` |
| 2 | CLI 与模型路由矩阵 | ✅ **静态可信 + 动态可证** | `docs/plan/2026-11-12-route-matrix.md` + `route-closure.md` |
| 3 | 续聊、取消与进程管理 | ✅ **外部 CLI 路径打通 + 进程零残留** | `docs/plan/2026-11-12-steer-restart-final.md` + `process-cleanup-verification.md` |

### 1.1 路由矩阵详情

**静态（可信）**：5 个启用角色的通道/角色/provider/model/reasoning 声明全部自洽，
与 provider 行 `--model`/`--effort` 逐项一致；两道 fail-closed 校验保证不一致必然拒绝。

**动态（已闭环）**：
- 新增 `effectiveProvider` / `effectiveModel` / `reasoningEffort` 三个字段落盘
- 真机验证：`effectiveModel: glm-5.3-flash`、`reasoningEffort: high` 正确写入

### 1.2 steer 外部 CLI 路径

**八轮真机测试，累计修掉 8 个缺陷**，全部在「单测全绿」状态下存在。

最终验收（alpha.20）：
```json
{ "ok": true, "mode": "restart-with-output",
  "childId": "44f26383-...", "previousChildId": "bf8e3974-...",
  "stopConfirmed": true }
```
新任务真的执行了插话指示（统计范围从 `src/dsh` 改为整个 `src`）。

### 1.3 进程清理

基线 5 个 node 进程 → 派 ACP 任务 → 取消 → 10 秒后：**超出基线 0 个**。

---

## 二、Codex 交叉评审 P1 项：全部闭环

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| 4 | Worktree 真实并行验收 | ✅ **通过** | `docs/plan/2026-11-12-worktree-parallel-write.md` |
| 5 | 安全审计 | ✅ **无高危，1 中危已修** | `docs/plan/2026-11-12-security-audit.md` |
| 6 | Token 优化复核 | ✅ **三项全部落地** | `docs/plan/2026-11-12-token-verification.md` |
| 7 | 产品体验复核 | ✅ **5 处不一致，4 处已修** | `docs/plan/2026-11-12-ux-review.md` |

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

## 三、本轮额外完成

| 项 | 内容 |
|---|---|
| 超时测试盲区 | 此前所有 adapter 测试都用 `timeoutMs: 0`，超时路径零覆盖。新增 5 条 |
| 磁盘清理 | 删除 3 个过期 verify 日志（466.5 KB）+ 2 个测试残留 |
| Worktree 清理 | 12 个终态树，回收 36 MB |
| README 修正 | 两份 README 状态行从 2026-11-10 更新到 11-12，工具数 8→10，UI 描述与实际一致 |
| UX 收口 | 「默认角色配置」→「全局角色库」；`SOURCE_LAYERS` 去掉 project/session；`confirmDeleteRole` 文案对齐 B3 |

---

## 四、唯一未完成项：D1 视觉验收

**这是唯一需要用户亲自做的。**

原因：契约层/数据层已全部验证通过，但**视觉层只能人看**。

### 需要看的 46 步（U1–U10）

清单在 `docs/plan/verify/2026-11-13-d1-user-checklist.md`。

重点关注：
- **U6-22/23**：选 CLI 后模型下拉有值、选模型后思考强度有值
- **U7**：点「刷新能力」不报错
- **U9**：无「右侧栏」/「本对话角色」误导文案
- **两色**：角色状态只有绿/灰，没有黄色（唐僧裁决后）
- **无角色入口**：右侧栏无「本对话角色」面板，对话页头无角色按钮

---

## 五、待决策（不阻塞发布）

### 5.1 取消确认的时序提示

`cancel_task` 回执 `stopConfirmed: false`，但 3-10 秒后记录变 `true`。
根因：外部 CLI 的 `dispose()` 异步。

建议加一句 hint 告诉用户「稍后复查」。三个方案见 `docs/plan/2026-11-12-cancel-timing.md`。

### 5.2 槽位泄漏根因

DSH 重启时 `onFinish` 不触发 → 槽位泄漏。
已缓解（上限 8 + 可诊断），根因未修。
方案见 `docs/plan/2026-11-12-slot-leak-critical.md`。

### 5.3 ACP 模型接受度

`kimi-k3.1-pro` / `hy4free` / `hy3` / `glm-5.3-flash` 在高强度下是否被接受，
需要真实派单验证（会消耗外部 CLI 额度）。

---

## 六、发布判断

| 维度 | 状态 |
|---|---|
| 自动化测试 | ✅ 648 / 647 pass / 1 skip |
| 发布门禁 | ✅ 8 PASS / 0 SKIP |
| P0 核心功能 | ✅ 全部闭环（除视觉验收） |
| P1 工程质量 | ✅ 全部闭环 |
| 安全检查 | ✅ 无高危，中危已修 |
| 安装回滚 | ✅ install-safe 可用，回滚目标存在 |
| 文档 | ✅ 清理完毕，README 已修正 |

**结论：技术条件已满足发布，唯一缺口是 D1 视觉验收需用户执行。**

按 Codex 评审的发布标准：
> 未实际测试的模型或通道，不得显示为已验证可用。

本项目的做法是：**未验证项全部在报告里明确标注为「未验证」**，没有伪装成已验证。

---

## 七、发布清单

如果用户确认 D1 通过，发布步骤：

1. `node scripts/release-check.mjs`（已 PASS）
2. `npm pack`
3. `node scripts/install-safe.mjs --tgz <new.tgz> --previous <old.tgz>`
4. 重启后验证版本号
5. 冒烟：设置页 + 派单 + 三面板

回滚目标：`C:\Users\30673\.dsh\packages\dsh-meetingstone-0.1.0-alpha.20.tgz`
