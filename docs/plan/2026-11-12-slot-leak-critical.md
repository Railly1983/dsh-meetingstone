# 严重缺陷：槽位泄漏导致派单永久阻塞

> 发现时间：2026-11-12 18:20
> 严重级别：**P0 阻塞**
> 触发条件：DSH 重启时有任务在跑

## 现象

重启 DSH 后，所有派单都返回：

```json
{
  "ok": false,
  "code": "WRITE_LIMIT_TOTAL",
  "message": "本插件派发的并行写任务已达上限 4（不含宿主的子 Agent 容量）"
}
```

但实际**没有任何任务在跑**：
- 两个 interrupted 任务的 worktree 已清理（改动 0 条）
- 没有残留的 CLI 进程
- `git worktree list` 干净

## 根因

`src/dispatch/dispatcher.js` 的槽位管理是**纯内存 Map**：

```js
const active = new Map()
// ...
active.set(token, entry)          // 派单时占槽（:752）
// ...
const onFinish = () => {          // 释放槽位
  active.delete(token)            // (:590)
}
```

`onFinish` 由适配器的「任务终态回调」触发 —— **完成 / 失败 / 取消**三种情况。

**但 DSH 重启时，任务是被强行中断的**：适配器根本没机会调用 `onFinish`，
于是槽位永远留在 `active` 里。重启后新进程的 `active` 虽然是空的……

等等，重启应该清空内存。那为什么还是 4？

## 需要进一步确认

两种可能：
1. **重启没有真正发生**（进程还在用旧的 Map）
2. **磁盘上有残留状态被重新加载**（如果有持久化）

需要查：
- `active` 到底是纯内存，还是有持久化恢复路径
- `meetingstone_list_runs` 显示 interrupted 是投影出来的（读磁盘），不是内存
- 当前这次 DSH 进程（PID 在 18:16 启动）的 `active` 里为什么有 4 条

## 影响

**今晚所有派单工作全部阻塞**，包括：
- 悟空的 Token 优化评估
- 小白的 workbuddy UI 研究
- 路由矩阵验证
- 任何 P0/P1 整改任务

## 临时绕过方案（待验证）

1. 调大 `limits.maxParallelWritesTotal`（改 profile → 需重启才生效，但今晚禁止重启）
2. 找到并清理 `active` 的残留（如果能从外部触发）
3. 等 `onFinish` 自然触发（僵尸任务不会触发）

## 必须修复

这是架构缺陷，不只是这次的问题：

**重启/崩溃时 `onFinish` 不会触发，槽位必然泄漏。**

修复方向：
1. 槽位不应纯内存，应有「基于实际存活任务的重新计算」能力
2. 或提供 `meetingstone_stats` / 内部清理接口，能根据磁盘 run 记录重建 active
3. 或加租约（lease）：槽位带 TTL，超时自动释放
4. 启动时扫一遍磁盘，把 interrupted 的从 active 里剔除

## 记录

- 这不是 Codex 评审提到的项，是通过今晚实际阻塞发现的
- 说明「重启打断任务」不只是「任务要重跑」，还会**永久锁死插件**
