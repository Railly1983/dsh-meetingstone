# 中途插话与续聊：可行性评估

> 日期：2026-11-12
> 背景：评估「中途插话」与「续聊」两个能力，决定是否做进本插件。
> 结论：**两者都能做，但机制完全不同；插话价值最高且实现成本最低。**

## 一、先纠正一个关键误解

我最初以为「插话」只能靠「杀掉重来 + 重放输出」。**查完宿主源码后发现这个判断是错的** ——
宿主 `@deepseek-ai/dsh-subagent` 已经内建了完整的插话与冷恢复机制。

### 1.1 `sendMessage` 支持 steer 投递

`dsh-subagent/lib/types/manager.js`：

```js
async sendMessage(sender, targetId, content, options) {
  // ...
  return this.deliverToChild(sender, targetId, content, {
    signal: options.signal,
    delivery: 'steer',        // ← 这就是「插话」语义
  })
}
```

`deliverToChild` → `deliverFollowup` 的实现：

```js
async deliverFollowup(parent, childId, content, options) {
  while (true) {
    const live = await this.locks.run(childId, async () => {
      const activation = this.resident.get(childId)
      if (activation === undefined)
        return this.coldResume(parent, childId, content, options)   // ← 不在线就冷恢复
      // ...
      const messageId = this.submitAdmitted(activation, content, options, parent)
      this.announce(activation)
      return messageId
    })
    if (live !== undefined) return live
  }
}
```

**关键能力**：
- 子 agent **还在跑** → 消息投递进它的 inbox，它在下个 step 边界处理（真·中途插话）
- 子 agent **已结束/休眠** → 走 `coldResume`，从持久化会话恢复后继续（真·续聊）

### 1.2 消息关闭保护

```js
if (local.structured?.acceptsInput() === false) {
  throw new SubagentError(
    'subagent is submitting or has submitted its structured result; the message was not accepted',
    'INPUT_CLOSED'
  )
}
```

子 agent 一旦提交结构化结果就不再接受输入 —— 这个边界要如实透传给用户。

## 二、各通道能力矩阵（实测）

| Provider | `prepareContinuable` | 能插话 | 能续聊 | 说明 |
|---|---|---|---|---|
| `spawn`（进程内） | ✅ | ✅ | ✅ | 完整支持 |
| `dsh-subagent-acp`（CodeBuddy） | ❌ | ⚠️ | ❌ | 无 `prepareContinuable`，只能「杀掉重来」 |
| `dsh-subagent-codex` | ❌ | ⚠️ | ❌ | 连 `sessionId` 都没引用，每次全新进程 |
| `dsh-subagent-claude-code` | ❌ | ⚠️ | ❌ | 同上 |

**结论**：真插话/真续聊只对**进程内 spawn** 可用。
外部 CLI 走 `coldResume` 会抛 `NOT_RESUMABLE`。

## 三、价值判断

### 3.1 中途插话 —— 价值最高

**真实痛点**（当前无法解决）：

```
派给沙僧一个大任务 → 跑 8 分钟 → 发现方向错了
→ 只能等它跑完，或 cancel 从零开始（前面 8 分钟全白烧）
→ 也无法告诉它「别改 A 文件，只改 B」
```

**有插话之后**：

```
发现跑偏 → steer 一句「停，不要动 A，只改 B」
→ 进程内 agent 在下个 step 边界收到，带着已有上下文继续
```

**为什么价值高**：
1. 直接减少返工 → 省 token（用户的核心目标）
2. 让「长任务 + 人工把关」成为可能
3. 这是当前完全缺失的能力，不是优化而是新增

### 3.2 续聊 —— 价值中等，但只在进程内有效

**场景**：任务完成后追问「你刚才说的那个文件具体改哪行？」
- 进程内：能真续聊，模型保有完整上下文
- 外部 CLI：不能，只能靠 `context-replay.js` 的重放（现有能力，已标注「不是真续聊」）

**价值判断**：对进程内角色（八戒/调度）有用，但进程内角色通常跑短任务，追问需求不如插话强烈。

## 四、实现方案

### 4.1 新增工具 `meetingstone_steer_task`

```
meetingstone_steer_task({
  childId: 'run-abc123',        // 必填，目标任务
  instruction: '停，不要动 A 文件',  // 必填
  role: '沙僧'                   // 可选，外部 CLI 重开时用；缺省沿用原角色
})
```

**分两条路径**：

**路径 A：进程内（spawn）—— 真 steer**
1. `ctx.subagents.sendMessage(parentAgent, childId, content, { delivery: 'steer' })`
2. 子 agent 在下个 step 边界收到，带完整上下文继续
3. 回执：`mode: 'steer'`, `delivered: true`

**路径 B：外部 CLI —— 杀掉重来 + 重放**
1. `cancel` 当前任务
2. 从 run 记录取 partial output
3. 用 `context-replay.js` 拼「原任务 + 已产出 + 新指示」
4. 重新派给同一角色，`upstreamChildId` 关联原 run
5. 回执：`mode: 'restart-with-output'`, 说明「不是真插话」+ 新 childId

**必须诚实区分**：回执里明确标 `mode`，不能让用户以为外部 CLI 也是真插话。

### 4.2 失败边界（必须透传）

| 情况 | 行为 |
|---|---|
| 任务已 completed/cancelled | 明确告知「任务已结束，无法插话；可续聊或新建」 |
| 子 agent 已提交结构化结果 | 命中 `INPUT_CLOSED`，如实转述「已提交结果，不再接受输入」 |
| 外部 CLI 且已离线 | 抛 `NOT_RESUMABLE`，转成「该通道不支持续聊，建议重新派单」 |
| 并发写冲突 | 宿主有 `holdOwnership` 锁，等锁或超时 |

### 4.3 权限

只允许**创建该任务的父 agent** 插话（宿主 `authorizeLineage` 会校验）。
本插件不需要额外鉴权，但要在工具描述里说清「只能操作自己派出的任务」。

## 五、工作量

| 项 | 估计 |
|---|---|
| `src/dsh/steer.js`（路径分流 + 错误翻译） | 中 |
| 注册 `meetingstone_steer_task` 工具 | 小 |
| 路径 B 的重开逻辑（复用现有 dispatcher） | 中 |
| 测试（两条路径 + 4 类失败边界） | 中 |

**风险**：
- 路径 A 依赖宿主 `sendMessage` 的 `delivery: 'steer'` 语义稳定
- 路径 B 的回执措辞必须足够清楚，否则用户会误以为是真的插话
- 进程内 agent 的 step 边界不可控（可能一轮已经跑完才收到）

## 六、结论

**做。** 理由：
1. 插话能力是刚需，且宿主已内建，我们只是**没接线**
2. 实现成本低于当初预判（原以为要自己实现「杀掉重来」，实际进程内直接调 API）
3. 直接服务用户的核心目标（省 token / 减少返工）

**不做**：给外部 CLI 自研 resume 客户端（要改 provider 插件，违反「非必要不重新开发」）。
