# 今晚工作进展（2026-11-12，实时更新）

> 授权：唐僧角色代为决策
> 起点：`0.1.0-alpha.11`（18:20 时）
> 当前：`0.1.0-alpha.13` 已装 + 4 个本地提交待装

## 一、并发上限调整（用户要求）

| 项 | 改前 | 改后 |
|---|---|---|
| 全局并行上限 | 4 | **8** |
| 单会话上限 | （无） | **4** |

新增错误码 `WRITE_LIMIT_SESSION` 与全局满区分。
拿不到 sessionId 时只受全局约束，不被误伤。

## 二、关键发现：槽位泄漏（今晚最大收获）

**现象**：18:20 起所有派单返回「已达上限 4」，但实际没有任何任务在跑。

**根因**：`active` 是纯内存 Map，槽位只在 `onFinish`（完成/失败/取消）时释放。
**DSH 重启时任务被强杀，`onFinish` 永不触发 → 每次重启必然泄漏槽位。**

**已缓解**：上限放宽到 8 + 重启后已解锁。
**未修根因**：`docs/plan/2026-11-12-slot-leak-critical.md`。
**可诊断**：新增 `meetingstone_stats` 工具，能看真实占用数。

## 三、已修复项

### 3.1 模型列表刷新不正常（P0，用户报的 bug）

两个成因：
1. `channelsToCatalog` 见 `model` 为空就跳过 → 外部 CLI 从目录消失
2. 角色绑定的模型没进目录

**修复**：没有 model 也登记通道；新增 `mergeRoleBoundModels()` 从角色侧反补。

**验收结果**（小白，契约层）：**通过**
- 4 个 CLI 全部出现（DeepSeek Harness / Claude Code / Codex / CodeBuddy）
- dsh = `deepseek-v4.1-flash`
- CodeBuddy = `kimi-k3.1-pro` / `hy4free` / `glm-5.3-flash` / `hy3`
- Codex = `gpt-6-astra` / `gpt-6.1-sol`
- dsh 与 CodeBuddy 思考强度有 `high`

**遗留**：`sources:['role']` 标记没传到 UI（统一显示成 `config`）。不阻塞。

### 3.2 重放块边界可被伪造逃逸（安全，中危）

旧输出含 `[END PREVIOUS TASK OUTPUT]` 会提前闭合不可信边界，
让旧输出冒充主控指令。已加 `neutralizeBoundaryMarks()` 无害化。

### 3.3 list_runs 返回体冗余（Token 优化）

实测单条 1.7KB，其中约 1KB 是纯排障字段。新增 `verbose` 参数，
默认紧凑，**省约 65% 返回体**（20 条从 34KB → 12KB）。

## 四、安全审计结论（沙僧，已完成）

**无高危**。中危 4 项：
1. ✅ 重放块边界可伪造逃逸（**已修**）
2. run 记录 result 含敏感内容无过滤（已文档化接受）
3. install-safe 整目录替换有窗口期
4. watcher 回滚是叠加不是整目录替换
5. 回滚 tgz 选择按字母序

低危若干：`.cmd/.bat` 走 cmd.exe 拼接、符号链接 realpath 回退、错误栈泄漏路径。

完整报告：`docs/plan/2026-11-12-security-audit.md`

## 五、进行中

| childId | 角色 | 任务 | 状态 |
|---|---|---|---|
| `beaff738` | 悟空 | 路由矩阵 | running（20+ 分钟） |
| `14da4947` | 八戒 | Worktree 真机验收 | running（20+ 分钟） |

## 六、已完成

| 角色 | 任务 | 结果 |
|---|---|---|
| 小白 | alpha.13 UI 验收 | 契约层 PASS，视觉层需用户目视 |
| 沙僧 | 安全审计 | 无高危，2 中危（1 已修） |
| Lead | Token 复核 + list_runs 优化 | 已实现并提交 |
| Lead | 槽位泄漏诊断 + stats 工具 | 已实现并提交 |

## 七、待办

### 待用户手工确认

1. **D1 视觉层**：U1–U10 目视 46 步（重点 U6-22/23、U7、U9）
2. **黄色状态**：目前不可达，需决定「接通 quota」还是「承认只有绿/灰」

### 待悟空/八戒完成

3. 路由矩阵（悟空）
4. Worktree 真机验收（八戒）

### 明天要做的

5. 安装今天的 4 个提交（alpha.14）
6. 验证 `meetingstone_stats` 真机可用
7. 验证 `list_runs` 紧凑模式实际省多少
8. 外部 CLI 的 `restart-with-output` 真机验证（还没做）

## 八、今晚的提交线

```
c238ea3 feat(stats): 新增 meetingstone_stats
8459115 perf(tokens): list_runs 默认紧凑
6650844 fix(security): 重放块边界可被伪造逃逸
82c088d feat(limits): 并发上限两档（8/4）
a9da9a5 fix(capabilities): 模型列表刷新
```

**注意：以上除 alpha.13 外都还没装**（今晚只提交不装包的原则已破例一次，
因为槽位泄漏必须重启解锁）。
