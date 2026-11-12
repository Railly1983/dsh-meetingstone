# 取消语义的时序边界（2026-11-12 实测）

> 触发：`meetingstone_cancel_task` 返回 `stopConfirmed: false`，但 3 秒后查记录是 `stopConfirmed: true`

## 现象

```
meetingstone_cancel_task({ childId: '38f93e0e-...' })
→ { ok: true, cancelled: false, stopConfirmed: false }

# 3 秒后查记录：
status: cancelled
stopReason: cancelled
stopConfirmed: true      ← 变成了 true
```

## 根因：cancel 的确认有延迟

`adapter.cancelActivation` 的流程（`src/dsh/adapter.js:1664` 起）：

```js
handle.cancelPromise = (async () => {
  handle.cancelling = true
  handle.controller.abort(new Error('meetingstone: cancelled'))
  // 1) 等宿主释放 activation（带 disposeTimeoutMs 超时）
  const disposeError = await disposeActivation(handle.activation, disposeTimeoutMs)
  // 2) 写终态
  const settledByResult = handle.resultSettled === true
  const stopConfirmed = !disposeError || settledByResult
  ...
})()
```

外部 CLI（ACP）的 `dispose` 是**异步的**：
- dispose 未在 `disposeTimeoutMs` 内完成 → `disposeError` 存在
- 且 `resultSettled` 还是 false → `stopConfirmed = false`
- **但 dispose 随后会完成，结果回调会写 `stopConfirmed: true`**

所以：**cancel 的那一刻确实无法确认**，几秒后可以。

## 这个行为是「诚实的」，但体验不好

### 好的方面

- 没有撒谎：那一刻确实没确认
- 槽位保留策略正确：不确定就不释放，等结果落定

### 不好的方面

- 用户看到 `cancelled: false` 会以为「取消失败了」
- 实际上取消是成功的，只是**确认晚了几秒**
- 没有任何提示告诉他「请稍后复查」

## 建议的改进（未实施，待决策）

### 方案 A：回执里加「稍后复查」提示

```js
if (!stopConfirmed) {
  return {
    ok: true,
    cancelled: false,
    stopConfirmed: false,
    reason: outcome?.reason,
    hint: '取消信号已发送，但宿主尚未确认停止（外部 CLI 的 dispose 是异步的）。' +
          '请稍后用 meetingstone_get_task 复查；若记录变成 cancelled 即说明已停。',
  }
}
```

成本极低，只是加一句话。

### 方案 B：轮询等一小段（不推荐）

在 cancel 里加 `await sleep(500)` 再查一次。
缺点：拖慢响应，且 500ms 不一定够。

### 方案 C：保持现状 + 文档说明

在工具描述里写明「外部 CLI 的取消确认可能有延迟」。

## 实测数据

| 时刻 | 状态 |
|---|---|
| T+0（cancel 调用） | `stopConfirmed: false` |
| T+3s（查记录） | `stopConfirmed: true` |

**延迟在 3 秒以内。**

## 结论

这不是 bug，是**异步 dispose 的固有特性**。
但「回执说 false、实际是 true」会让用户困惑，建议至少加一句 hint。

已登记为待决策项，本轮不实施（避免在质量收敛期引入新改动）。
