# 今晚工作计划（2026-11-12 18:20 起）

> 授权：唐僧角色代为决策裁决
> **硬约束：今晚不重启 DSH、不安装新包**（alpha.12 已装，是今晚的基线）
> 所有代码改动只提交到 git，明天一起装

## 基线

- 已装版本：`0.1.0-alpha.12`（模型刷新 bug 已修，但**未真机验证**）
- 测试：584 / 583 pass / 1 skip
- 门禁：8 PASS / 0 SKIP

## 进行中

| childId | 角色 | 任务 | 状态 |
|---|---|---|---|
| `12d58077` | 悟空 | Token 优化评估 | running（18:02） |
| `47841797` | 小白 | workbuddy-to-dsh UI 参考 + 上下文长度可配置性 | running（18:02） |

## P0 队列（按 Codex 评审）

1. **黄色状态不可达**（quota 接入 `deriveRoleView`）
2. **CLI 与模型路由矩阵**：为每个正式启用角色真实派单一次，记录实际 provider/model/强度
3. **续聊/取消/进程清理**：外部 CLI 的 `restart-with-output` 真机验证 + Windows 子进程树清理
4. **alpha.12 UI 验收**：D1 U1–U10 共 46 步

## P1 队列

5. **Worktree 真实并行验收**：两个任务改不同文件 → 测试 → 合并 → 冲突处理 → 清理
6. **安全审计**：命令注入、路径越权、密钥泄漏、外部输出不可信处理
7. **Token 优化复核**（悟空评估后落地）
8. **产品体验复核**：CLI 开关、角色开关、全局/项目继承

## 人员分配

- **悟空**：技术评估、路由矩阵、安全审计（已派 Token 评估）
- **小白**：UI 验收、体验复核、workbuddy 参考落地
- **八戒**：兜底（悟空/小白额度不足时接手）
- **唐僧**：裁决争议、决定取舍
- **Lead（我）**：调度、代码实现、提交（不装包）

## 交付物

- `docs/plan/2026-11-12-token-optimization-review.md`（悟空）
- `docs/plan/2026-11-12-workbuddy-ui-reference.md`（小白）
- `docs/plan/2026-11-12-route-matrix.md`（路由矩阵）
- `docs/plan/verify/2026-11-12-d1-alpha12.md`（UI 验收）
- `docs/plan/2026-11-12-security-audit.md`（安全审计）
- `docs/plan/2026-11-12-worktree-acceptance.md`（并行验收）
- 明确「明天安装什么、验证什么」的清单
