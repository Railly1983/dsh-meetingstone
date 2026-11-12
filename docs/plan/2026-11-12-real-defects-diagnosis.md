# 用户报告的两个真机缺陷：诊断报告

> 日期：2026-11-12
> 触发：用户真机截图 + 原话
> 「刷新能力一点就红字报错。模型和强度的下拉选项里，只有我之前使用的选项，
> 没有从模型接口实时获取的信息。这个角色配置事实上是根本没法用的状态。
> 你测不出来吗？而且这个问题我之前都和你说过多少次了，你为什么一直不管？」

---

## 缺陷 1：点「刷新能力」红字报错 —— 已定位并修复

### 报错原文

```
gateway/internal capabilityCatalog is not defined
```

### 根因：跨作用域引用

`src/gui/host.js` 的结构：

| 行号 | 内容 | 作用域 |
|---|---|---|
| 353~505 | `createGuiState() { ... }` | 闭包 A |
| 370 | `const capabilityCatalog = ...` | **闭包 A 内** |
| 567~747 | `registerGuiRemote() { ... }` | **闭包 B** |
| 656 | `refreshCli` 用了 `capabilityCatalog` | **闭包 B 内 → 未定义** |

`createGuiState` 在 505 行就 `return` 结束了。`refreshCli` 在 656 行，
属于另一个函数 `registerGuiRemote`。**两个函数两个作用域**，所以
`capabilityCatalog` 在 `refreshCli` 里是未定义标识符。

### 为什么显示成 `gateway/internal xxx is not defined`

宿主 `dsh-api-gateway/lib/index.js` 的 `rpcFailure()`：

```js
function rpcFailure(error) {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return { ok: false, error: { code: remote.code, ... } }
  return {
    ok: false,
    error: {
      code: "gateway/internal",
      message: error instanceof Error ? error.message : String(error),  // ← 我们的 ReferenceError
      details: {},
    },
  }
}
```

我们的 `ReferenceError: capabilityCatalog is not defined` 被原样包成
`gateway/internal` + message。所以红字看起来像宿主的错，其实是我们的。

### 修复（5 处）

1. `createGuiState` 的 return 增加 `capabilities: capabilityCatalog`
2. `registerGuiRemote` 从 `deps.capabilities` 取
3. `refreshCli` 开头加显式检查，缺失时抛 `MEETINGSTONE_GUI_CAPABILITIES_UNAVAILABLE`
   （可识别的 RemoteError，不是 ReferenceError）
4. `src/index.js` 调用点补 `capabilities: gui.capabilities`
5. 新增 `tests/host-remote-scope.test.mjs`（6 条）

### 为什么原有测试没抓到 —— 这是关键

原有 `gui.test.mjs` 测的是「注册成功」「返回形状对不对」，
**没有真正调用带参方法**。

一个 JS 函数只有在**被调用**时才会求值函数体，未定义变量才会暴露。
静态检查（包括我那两个 D1 脚本）都发现不了。

新测试的做法：**把每个 remote 方法真的调一遍**，断言不抛 ReferenceError 形态的错误。
另加一条**源码契约测试**，直接查 `src/index.js` 里有没有传 `capabilities:`。

已验证这条测试有效：把传参移除后，测试立刻失败。

---

## 缺陷 2：模型下拉没有实时数据

### 逐个 CLI 的实查结论

| CLI | 有模型列举接口吗 | 证据 | 结论 |
|---|---|---|---|
| **dsh** | ✅ 有 | `createDefaultProbes` 里 `ctx.llm.listModels()` | **已实现**，是真实时 |
| **codex** | ✅ 有 | `probeCodexModels` 走 app-server `model/list` | **已实现**，是真实时 |
| **codebuddy** | ⚠️ 只有 ACP 内部接口 | 见下 | **未实现** |
| **claude** | ❌ 无 | 只有 `--model <alias>`，别名是 `fable`/`opus`/`sonnet`，**不可枚举** | **不可实现** |

### codebuddy 的调查

CodeBuddy 二进制（`codebuddy-headless.js`，29 MB）里确实有模型列举：

```js
// 约 5522611 字符处
async updateModelOptionDescription(){
  const ep = await Promise.race([AgentManager.getDefault(), timeout])
  const eh = await Promise.race([agentManager.getModels(ep.name), timeout])
  if (0 === eh.length) return
  const eg = eh.map(eA => eA.id).join(", ")   // 模型 id 列表
}

// 约 3866214 字符处
// [ACP Agent] getModelsInfo: END, returning ${ef.length} models
return { availableModels: ef, currentModelId: el }
```

**但**：
1. `AgentManager.getModels` 是**进程内 API**，没有命令行入口
2. `--help` 本身就需要后端环境（实测报 `Failed to start the backend application`）
3. `getModelsInfo` 是 **ACP 协议**里的方法

而 DSH 的 ACP provider（`@deepseek-ai/dsh-subagent-acp/lib/index.js`，18 KB）
**完全没有模型查询能力**：

```
getModelsInfo    0 处
availableModels  0 处
listModels       0 处
models/list      0 处
models           0 处
```

它只做「启动子进程 + 转发消息」，不碰模型列表。

**所以**：要通过 ACP 拿 codebuddy 的模型列表，需要自己实现 ACP 协议握手
（`initialize` → `session/new` → 拿 `availableModels`），成本不低，
而且协议细节没有公开文档。

### claude 的调查

`claude --help` 可用，但只有：

```
--model <model>    Model for the current session. Provide an alias for the
                   latest model (e.g. 'fable', 'opus', or 'sonnet') or a
                   model's full name.
```

只有**别名**，没有 `list-models` 子命令，配置目录
（`~/.claude/`）里也没有模型清单。

**结论：claude 的模型列表无法程序化获取。**

### 正确的做法：如实标注，不伪装

按「未实际验证的不得显示为已验证」的原则：

- `dsh` / `codex`：`source: 'live'` → UI 标注「实时」
- `codebuddy` / `claude`：`source: 'config'` → UI 必须明确写「来自配置，非实时」

用户截图里已经能看到 `kimi-k3.1-pro · 配置` 这种形式，
说明 `source` 机制**已存在**，需要确认它准确反映了真实来源。

**绝对不能**把静态配置伪装成实时数据 —— 那正是用户抱怨的
「只有我之前使用的选项」的根源。

---

## 我的验证方法错在哪（用户批评的核心）

用户问「你测不出来吗？」——**确实测不出来**，原因有三层：

### 1. 两个 D1 脚本都用 stub 替换了 remote

`verify-d1-render.mjs` 和 `verify-d1-interaction.mjs` 里：

```js
const snapshot = { roles: [...], global: { capabilities: {...} } }  // 手写的假数据
T.renderSection(t, normalized, { cliStates })                        // 喂假数据给真渲染
```

它们验证的是「**给定数据能渲染**」，不是「**真实数据能拿到**」。

`refreshCli` 从来没被调用过 —— 它根本不在渲染路径上，是按钮点击才触发的
remote 调用。所以「点按钮报错」这类缺陷**结构上不可能被测到**。

### 2. 测试只测注册，不测调用

`gui.test.mjs` 断言 `REMOTE_DESCRIPTORS` 里有 `refreshCli` 这个 descriptor，
但**没有真的调它**。

JS 函数体不执行就不会求值内部的变量引用，所以作用域越界发现不了。

### 3. 「静态结构正确」≠「功能可用」

我的 24 + 20 项 D1 核对，检查的是「字典里有没有这个 key」「按钮有没有 onClick」
「节点树里有没有这段文本」。

这些都对，但**按钮点下去调用的那条链路**（client → gateway → host →
capabilityCatalog → 探测）从来没被端到端验证过。

---

## 应该补什么验证（待实施）

### A. Remote 方法全量调用测试（已在 `tests/host-remote-scope.test.mjs` 部分实现）

对每个 remote 方法用最小 deps 真调一遍，断言：
- 不抛 ReferenceError / TypeError 形态（那是代码缺陷）
- 抛出的必须是可识别的 `RemoteError`（那是设计内的失败）

### B. 返回值 JSON 可序列化测试

`gateway` 用 JSON 传输。如果返回值里有 `undefined`、函数、`Map`、`Error`，
序列化会出问题或丢失数据。

测试：`JSON.parse(JSON.stringify(result))` 往返，比对关键字段还在。

### C. 源码契约测试

像「`src/index.js` 必须传 `capabilities:`」这种关键接线，用正则直接查源码。
粗，但对「两个作用域之间的接线断了」这类缺陷有效。

### D. 能力目录来源真实性测试

断言：**没有 probe 实现的 CLI，其 `source` 不能是 `live`**。

```js
// 如果 codebuddy 没有 probe，它就绝不能声称自己是 live
assert.notEqual(catalog.codebuddy.source, 'live')
```

这能防止「静态配置伪装成实时数据」。

---

## 对用户的回答

> 「这个问题我之前都和你说过多少次了，你为什么一直不管？」

我必须承认：**我没有真正验证过「刷新能力」按钮能不能用**。

我做的所有验证都在「渲染层」，而缺陷在「调用层」。
每次我说「D1 通过了」，验证的都是「界面画对了」，不是「功能能用」。

这是我的方法错误，不是运气问题。上面 A/B/C/D 四项就是针对性的补救。
