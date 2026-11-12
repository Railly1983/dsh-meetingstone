# 上下文窗口：可行方案评估

> 日期：2026-11-13
> 用户要求：「如果没有接口获取，想想有什么其他办法。比如网上搜索官方公开信息
> 确定常见的每个模型的最大上下文支持，把上下文强行设置成最大值，无需用户填写」

---

## 一、实测结论：ACP 拿不到 context_window

我对 **20 个模型逐个**发了 `session/set_config_option`，然后检查服务端
有没有回吐 `configOptions`：

```
hy4free                      context_window=无
hy4std                       context_window=无
hy3                          context_window=无
...（20 个全部）
mimo-v2.6-pro                context_window=无

=== 汇总 ===
0 / 20 个模型报告了 context_window
```

**结论：当前 CodeBuddy 版本（2.181.0）不再通过 ACP 暴露 `context_window`。**

社区笔记（farm-out，CLI 2.137.1）说它有，但我们这个版本没有 —— 可能是版本演进去掉了。

---

## 二、找到了更好的源：`product.json`

CodeBuddy 安装包里有 `product.json`（351.8 KB），内含 **22 个模型**的完整元数据：

```json
{
  "id": "hy4-preview",
  "name": "Hy4 preview",
  "maxOutputTokens": 64000,
  "maxInputTokens": 1000000,
  "maxAllowedSize": 1000000,
  "supportsImages": true,
  "supportsReasoning": true,
  "credits": "x0.29 credits",
  "contextWindow": {
    "supportedLengths": [200000, 1000000],
    "defaultLength": 200000
  }
}
```

**字段含义**：

| 字段 | 含义 |
|---|---|
| `maxInputTokens` | **最大上下文**（这就是「上下文窗口」） |
| `maxOutputTokens` | 最大输出 |
| `maxAllowedSize` | 允许的最大总长 |
| `contextWindow.supportedLengths` | 可选的窗口档位（部分模型有） |
| `contextWindow.defaultLength` | 默认档位（部分模型有） |

**这比网上搜资料准确得多** —— 它是这份安装包自带的官方元数据。

---

## 三、但有个大问题：两份清单只有 6/20 交集

`product.json` 的 22 个模型 vs ACP 返回的 20 个模型：

| 情况 | 数量 |
|---|---|
| 两边都有 | **6**（`hy3`、`deepseek-v4.1-flash`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、`kimi-k2.8-preview`） |
| 只在 ACP（你账号可用） | **14**（`hy4free`、`hy4std`、`hy3-x`、`glm-5.3-flashx`、`space-bunny`、`minimax-*`、`kimi-k3.1-*`、`kimi-k3-2`、`deepseek-v4-pro`、`step-5-preview`、`mimo-v2.6-pro`） |
| 只在 product.json（未对你开放） | 16（`gpt-6-astra`、`gemini-3.5-flash`、`gpt-5.*`、`default-model` 等） |

**含义**：`product.json` 是**产品级目录**（所有可能的模型），
ACP 返回的是**账号级可用列表**。两者不能互相替代。

---

## 四、所以能做什么、不能做什么

### ✅ 可以做（有据可依）

**对 6 个命中的模型**：显示真实上下文（`maxInputTokens`），标注来源 `product.json`。

```
hy3                    192,000
deepseek-v4.1-flash  1,000,000
glm-5.3              1,000,000
glm-5.3-flash        1,000,000  （可调档位 300K / 1M）
glm-5.2              1,000,000
kimi-k2.8-preview    1,000,000  （可调档位 300K / 1M）
```

### ⚠️ 不能做（你说的「强行设置成最大值」，我认为不能这么干）

**对剩下 14 个不命中的模型**，如果「强行设成最大值」，等于**编造数据**。

举反例：`hy4free` 和 `hy4std` 都带 `hy4` 前缀，但：

- 可能等于 `hy4-preview` 的 1,000,000
- 也可能是另一套配置（免费版常被限流/限长）

**猜错的后果**：用户按 1,000,000 规划上下文，实际只有 200,000，
会在 20% 处被静默截断 —— 这比「显示未知」危险得多。

### 我的建议：三档显示

| 情况 | 显示 | 依据 |
|---|---|---|
| `product.json` 有精确记录 | `上下文 1,000,000` | 官方元数据 |
| `product.json` 没有 | `上下文 未知` | 不编造 |
| 用户手动设置过 | 显示用户值 | 用户强制覆盖 |

**关键**：如果你要「统一按最大值」，我可以做成**用户可选的默认值**，但要明确标注
「这是假设值，不是探测值」—— 而不是把它伪装成官方数据。

---

## 五、关于 `contextWindow.supportedLengths`

对 4 个模型（`deepseek-v4.1-flash`、`glm-5.3-flash`、`kimi-k2.8-preview`、`hy4-preview`），
`product.json` 还给了**可调档位**：

```json
"contextWindow": { "supportedLengths": [300000, 1000000], "defaultLength": 300000 }
```

这意味着这些模型**真的可以在 ACP 里切上下文长度** —— 但要用 `session/set_config_option`
的 `configId: 'context_window'`。我实测这个 configId 不存在（当前版本移除了）。

所以我**没法替你切**，只能显示「这个模型支持 300K / 1M 两档」。

---

## 六、Claude Code 的情况

`@anthropic-ai/claude-code` 是**原生二进制**（无 JS 可读），包里只有
`cli-wrapper.cjs` / `install.cjs`，没有任何模型元数据。

它只有三个别名（`fable`/`opus`/`sonnet`），上下文窗口由 Anthropic 服务端决定，
本地拿不到，也没有 ACP 模式。

**结论：claude 保持静态，不显示上下文。**

---

## 七、给你的三个选项

| 方案 | 做法 | 风险 |
|---|---|---|
| **A（推荐）** | 6 个有据 → 显示真实值；14 个无据 → 显示「未知」 | 无 |
| **B** | 同上，但给「未知」的模型加一个**用户可填**的输入框 | 用户要自己查 |
| **C** | 全部按 `maxInputTokens` 填满（14 个按同类模型的最大值猜） | **可能误导**，不推荐 |

我倾向 **A**，需要时再加 B。等你定。
