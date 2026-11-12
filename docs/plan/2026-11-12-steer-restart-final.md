# steer 外部 CLI 路径：八轮真机测试的完整记录

> 日期：2026-11-12
> 起点：`meetingstone_steer_task` 的 `restart-with-output` 分支**完全不工作**
> 终点：**端到端跑通**（alpha.20）

## 一、最终验收结果

### 1.1 回执（alpha.20）

```json
{
  "ok": true,
  "mode": "restart-with-output",
  "childId": "44f26383-b25c-4146-bfd9-89b6e8f2934b",
  "previousChildId": "bf8e3974-1692-46f2-8f3b-dc783b0a7c70",
  "stopConfirmed": true,
  "replayedBytes": 0,
  "note": "该通道（acp）不支持续接会话，已改为「停掉原任务 + 带上已有产出重开」。
          这不是真插话：新任务会重新读一遍上下文，模型没有原任务的内部状态。
          **原任务被中止时尚无产出，新任务只能看到你的新指示** ——
          若指令依赖原任务上下文，新任务可能无法理解，建议把必要背景写进 instruction。"
}
```

### 1.2 落盘记录（全部要素齐全）

| 项 | 值 |
|---|---|
| 原任务 `bf8e3974` | `status: cancelled`，`stopConfirmed: true` |
| 新任务 `44f26383` | `status: running` → `completed` |
| **`upstreamChildId`** | **`bf8e3974-...`（正确关联原任务）** |
| `projectRoot` | `D:\MeetingStone` |
| `role` | `role-sashi` |
| `provider` | `acp` |

### 1.3 新任务真的执行了插话指示

新任务的产出（摘要）：

> 统计范围已从 src/dsh 扩大为整个 src 并完成重新统计：src 下共 36 个 .js 文件，
> 总行数 20157。分目录行数：client 3106、dsh 3788、cli 2131、gui 1917、
> dispatch 1849、根文件 9 个共 4374、roles 1069、session 825、project 766、config 332。
> 报告已落盘 `.meetingstone/runs/2026-11-12-src-full-stats.md`。

**插话指令被完整理解并执行。**

---

## 二、八轮测试暴露的 8 个缺陷

每一轮都是真机暴露的，**而且全部在「单元测试全绿」的状态下存在**。

| # | 缺陷 | 暴露轮次 | 根因 |
|---|---|---|---|
| 1 | 记录字段读不全 | alpha.13 / 第 1 轮 | 只读 `dispatcher.getTask()` 的内存视图（只有 status/reason），不含 provider/role/channel |
| 2 | 重开缺必需参数 | alpha.14 / 第 2 轮 | 没传 `context.agent` → `PARENT_AGENT_UNAVAILABLE`；也没传 projectKey/sessionId/isolation |
| 3 | `stopConfirmed` 取值用错键 | alpha.14 | 代码写 `cancelOutcome?.ok`，但 `dispatcher.cancel` 返回的是 `{ stopConfirmed }` |
| 4 | **原任务没停也照样重开** | alpha.14 | 无门禁 → 会两个任务同时写同一工作区（安全/正确性风险） |
| 5 | 停止判定证据顺序错 | alpha.15/16/17 / 第 3-5 轮 | `rememberFinished()` 同步写内存、`emitRunFinish()` 异步写磁盘；只查磁盘会输给写盘延迟 |
| 6 | `projectRoot` 丢失 | alpha.17 / 第 5 轮 | 两处：`buildRunBase` 只读 `context.projectRoot`（派单传的是顶层）；`run-store` 白名单没收 |
| 7 | `upstreamChildId` 丢失 | alpha.18/19 / 第 6 轮 | 两处：adapter 只认 `continuation.upstreamChildId`；dispatcher 构造 adapter 入参时没列它 |
| 8 | 重开任务被模型合理拒绝 | alpha.19 / 第 7 轮 | 新任务看不到原任务，只收到裸指令 → 判断「这要求我虚构结果」 |

---

## 三、最重要的教训

### 3.1 「工具函数有单测」≠「工具能用」

`src/dsh/steer.js` 当时有 **19 条单元测试**（`steerCapability` / `translateSteerError` /
`extractPartialOutput` 等纯函数），全部通过。

但**一条都没覆盖「`execute` 真的调 dispatcher」** —— 于是工具在真机上 100% 不可用。

修复后新增的 `tests/steer-restart.test.mjs`（18 条）全部是**工具 execute 层的集成测试**，
直接断言「dispatcher 收到了什么参数」「返回了什么形状」。

### 3.2 每个缺陷都值得单独记

因为它们的**根因类型完全不同**：

1. **数据源层**（内存 vs 磁盘）—— 要理解宿主的写入时序
2. **参数传递链**（工具 → dispatcher → adapter → run-store）—— 四层，任何一层漏了都断
3. **返回值契约**（`.ok` vs `.stopConfirmed`）—— 想当然的键名
4. **安全门禁**（没停就不能重开）—— 这类「加保护」的逻辑容易被漏掉
5. **异步时序**（同步写内存 vs 异步写磁盘）—— 最隐蔽
6. **字段白名单**（写了但被过滤）—— `run-store` 的 `normalize()` 只保留白名单字段
7. **中间层透传**（dispatcher 不转发未知字段）
8. **模型语义**（新会话缺上下文会合理拒绝）

### 3.3 「重开 ≠ 续聊」是架构边界，不是 bug

|  | 真续聊（进程内 spawn） | 重开（外部 CLI） |
|---|---|---|
| 实现机制 | `subagents.sendMessage({delivery:'steer'})` → 子 agent 收件箱 | `cancel` + 带产出 `dispatch` |
| 新任务知道原任务在做什么 | ✅ 完整上下文 | ❌ 全新会话 |
| 原任务无产出时 | 仍能理解上下文 | **只能看到裸指令** |
| 依赖上下文的指令 | 没问题 | **可能被合理拒绝** |

详见 `docs/plan/2026-11-12-restart-semantics.md`。

---

## 四、给后续维护者的检查清单

如果你要改 steer / dispatcher / adapter 之间的任何一层，**必须真机验证这几项**：

- [ ] 回执 `mode` 是 `steer` 还是 `restart-with-output`（不能混）
- [ ] `childId` 非 null（重开真的成功了）
- [ ] `stopConfirmed` 是 true（原任务真的停了）
- [ ] 原任务记录 `status === 'cancelled'`
- [ ] 新任务记录 `upstreamChildId === 原 childId`
- [ ] 新任务记录 `projectRoot` 非 null
- [ ] 原任务**没停**时，`dispatch` 未被调用（用假 adapter 断言 `dispatches.length === 0`）
- [ ] 无产出时，新任务收到的 prompt 里有「任务接替说明」
