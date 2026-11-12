# 四个问题的答案

> 日期：2026-11-13
> 问题来源：用户直接提问

---

## 1. Claude 不需要取列表 —— 你是对的

> 「claude 按我的了解，根本不需要去取列表，因为模型固定不就是那三个吗？」

**同意，而且理由比「固定」更充分**：

- Claude Code 的 `--model` 接受 **别名**（`fable` / `opus` / `sonnet`），
  别名指向「当前最新」的同档模型，会自动跟进版本
- 没有一个命令能列出别名背后的具体型号，也不需要 —— 用户要的是「用最强的」，
  不是「用 claude-opus-4-20250514」
- 强行去枚举反而会**引入维护负担**：每出一个新型号就要改表

**结论**：claude 保持「静态清单 + 标注来源」，这不是缺陷，是正确的设计。

---

## 2. 四个来源的模型列表：3 个实时 + 1 个静态

| 来源 | 能获取吗 | 方式 | 实测结果 | 耗时 |
|---|---|---|---|---|
| **DeepSeek Harness** | ✅ 实时 | `ctx.llm.listModels()` | 1 个（`deepseek-v4.1-flash`） | <100ms |
| **CodeBuddy** | ✅ 实时 | ACP `session/new` → `availableModels` | **20 个** | ~5.4s |
| **Codex** | ✅ 实时 | app-server `model/list` | 2 个（`gpt-6-astra`、`gpt-6.1-sol`） | ~1s |
| **Claude Code** | ❌ 无接口 | `--model <alias>` | 3 个别名 | 静态 |

**3 个真获取（34 个模型），1 个静态（3 个别名）。**

---

## 3. 刷新按钮**不控制**触发 —— 这里确实有问题

> 「你在设置里不是有个刷新的按钮，这个刷新按钮就是更新列表的触发开关吧？
>  不点这个就不会触发刷新吧？」

**不是。** 实际行为：

### 代码（`src/cli/capabilities.js:1011-1015`）

```js
function snapshot() {
  if (autoRefresh && (lastRefreshAt === null || now() - lastRefreshAt >= ttlMs) && !inFlight) {
    // 后台刷新：list 只读、不阻塞
    void refresh(undefined, { force: false }).catch(() => {})
  }
  ...
}
```

### 实际触发时机

| 动作 | 会触发刷新吗 |
|---|---|
| 打开设置页（读 `snapshot()`） | **会** —— 只要距上次 ≥ 5 分钟 |
| 点「刷新能力」 | 会（强制刷新当前 CLI，`force: true`） |
| 什么都不做 | 不会 |

`ttlMs` 默认 **5 分钟**（`DEFAULT_CAPABILITY_TTL_MS`）。

### 这意味着什么

**每次打开设置页且距上次超过 5 分钟，后台会静默启动一个 `codebuddy --acp` 子进程，占用约 5.4 秒。**

- 不是「点按钮才刷新」，而是「打开页面就可能刷新」
- 对 CodeBuddy 这种 5 秒级的探测，成本不小
- 与你「频繁获取没有意义」的判断一致

### 建议改成纯手动（三个方案）

| 方案 | 行为 | 代价 |
|---|---|---|
| **A（现状）** | 5 分钟 TTL 自动刷新 | 每次开页可能起子进程 |
| **B（推荐）** | 首次进入获取一次，之后**只手动** | 需改 `autoRefresh` 默认值 + 首次标记 |
| **C** | 完全手动，第一次也要点 | 首屏会是空列表，体验差 |

**我倾向 B**：第一次打开自动取一次（用户不用等），之后只在点按钮时更新。
实现很小：`autoRefresh: false` + 一个「首次已刷」的内存标记。

---

## 4. 上下文长度：我们**没有**这个功能，分两层看

### 4.1 CodeBuddy 的 context_window：拿不到

社区实测（farm-out）说 ACP 的 `configOptions` 里有 `context_window`：

> `context_window` exists only for some models. `glm-5.3-flash`, `deepseek-v4.1-flash`
> and `hy4-preview-f` offered 300000 and 1000000, default 300000.

**但我本机实测没有**：

```
configOptions 全部：
  id=mode          → default, acceptEdits, plan, auto, dontAsk, bypassPermissions, fullAccess
  id=model         → 20 个
  id=thought_level → high, enabled
  id=sandbox       → true, false
  id=multitask     → (空)

有 context_window: ❌ 没有
```

原因可能是：当前模型（`hy4free`）恰好是「没有 context_window 的那类」。
社区笔记也说了「only for some models」。

**所以：能不能拿到取决于模型，不能保证。**

### 4.2 DSH 自己的上下文窗口：在 DSH 配置里，不在我们插件

`profile/cordis.patch.yml`：

```yaml
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  config:
    summarizationProvider: workbuddy
    summarizationModel: deepseek-v4.1-flash
    thresholdRatio: 0.5      # ← 这个是你之前改的
```

**上下文窗口本身由各 provider 的模型定义决定**，`thresholdRatio` 只是压缩阈值
（窗口的 N% 时触发压缩）。这两者都不是我们插件的配置项。

### 4.3 结论

| 层面 | 能否在集合石里设置 |
|---|---|
| DSH 压缩阈值（`thresholdRatio`） | ❌ 不是我们的配置，在 DSH 的 `cordis.patch.yml` |
| 模型的上下文窗口大小 | ❌ 由 provider/模型决定，不可配 |
| CodeBuddy 的 `context_window` 选项 | ⚠️ **部分模型有**，可通过 ACP 改，但当前模型没有 |

**如果你想在界面上看到「这个模型的上下文窗口是多少」，我可以做**：
解析 ACP 返回的 `context_window`（有就显示，没有就显示「未知」）。
但「设置」它需要确认 CodeBuddy 支持哪些值，且只对部分模型有效。

---

## 待你决策

1. **刷新策略**：保持 5 分钟自动，还是改成「首次 + 手动」（我推荐后者）？
2. **上下文窗口**：要不要在界面上**显示**模型支持的窗口大小（只读）？
3. **Claude**：确认保持静态清单，不做探测？
