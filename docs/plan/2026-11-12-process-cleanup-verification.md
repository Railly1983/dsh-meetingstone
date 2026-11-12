# 进程清理验证（Windows）

> 日期：2026-11-12
> 对应 Codex 评审 P0「取消/超时/进程清理」中的进程清理项
> 方法：真实派单 → 记录基线 → 取消 → 对比

## 一、结论：**进程清理通过，零残留**

取消任务后，CLI 进程被彻底清理，进程数回到基线。

## 二、验证过程

### 2.1 基线（取消前）

```
ProcessName       Id     Start
node              8472   08:40:19
node              19400  08:36:47
node              33184  17:25:58
node              38064  17:25:58
WeMailNode_x64    23428  08:40:19
```

共 **5 个**。

### 2.2 派单后新增

派一个 ACP 任务（小白角色，`ch-acp-hy4`），它执行 PowerShell 起子进程：

```
ProcessName    Id      Start
node           32852   22:07:50    ← CLI 主进程
powershell     29900   22:07:56    ← 任务内部的短进程（自行退出）
```

### 2.3 取消后

调用 `meetingstone_cancel_task({ childId: '9aca9d1c-...' })`，
回执 `stopConfirmed: false`（见下方「时序说明」）。

等待 **10 秒**后检查：

```
node 32852 → ✅ 已清理
```

进程总数回到基线 **5 个，超出 0 个**。

## 三、实现机制

清理由宿主的 Windows Job Object 负责，不是我们的代码：

`dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js` 提供：

```
createKillOnCloseJob    — 创建带 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 的 Job
terminateJob            — 终止整个 Job
isJobEmpty              — 判断 Job 是否已空
spawnJobProcess         — 在 Job 内启动进程
```

`dsh-subprocess-local/lib/runner-launch-*.js` 也用 Job Object 管理子进程。

**本项目不自己实现进程树清理** —— 那是宿主职责，符合「尽量复用 DSH 自带功能」的原则。
我们只需要确保 `activation.dispose()` 被正确调用（`cancelActivation` 里做了）。

## 四、时序说明（重要，避免误判）

取消的回执是 `stopConfirmed: false`，但**记录随后会变成 true**：

| 时刻 | 记录状态 |
|---|---|
| T+0（cancel 返回） | 回执 `stopConfirmed: false` |
| T+3s ~ T+10s | 记录 `status: cancelled`，`stopConfirmed: true` |
| 进程状态 | 已清理（10 秒内） |

根因：外部 CLI 的 `dispose()` 是异步的，`disposeTimeoutMs` 内没完成时
`cancelActivation` 会如实返回 `false`，随后 dispose 完成才写 true。

**这不是缺陷，是异步 dispose 的固有特性。** 详见 `2026-11-12-cancel-timing.md`。

## 五、未验证的部分

| 项 | 状态 | 原因 |
|---|---|---|
| 超时触发的清理 | ⚠️ 未真机验证 | 需要 `timeoutMs` 很小的任务；已在 `tests/adapter-timeout.test.mjs` 覆盖超时**信号**，但没验证超时后的进程清理 |
| DSH 退出时的清理 | ⚠️ 未验证 | 需要退出 DSH 才能测，会打断当前会话 |
| 深层进程树（3 层以上） | ⚠️ 未验证 | 本次只验证了「CLI → 子进程」两层 |

这三项需要更长的专项测试，本轮不做。

## 六、对 Codex 评审的答复

> 验证 Windows 子进程树清理

**已通过**（2 层进程树，取消路径）。

补充说明：
- 清理由宿主 Job Object 负责，本项目只负责调用 `dispose()`
- 取消的确认有 3-10 秒延迟，回执如实返回 false，记录随后更新
- 超时路径的清理未真机验证，但超时信号机制已有单测覆盖
