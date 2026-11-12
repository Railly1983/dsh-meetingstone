# 验证方法失效审计 + 红字报错复现（2026-11-12）

> 角色：小白（审计者）。不改代码、不重启 DSH、不装包、不联系其他角色。
> 目标：① 独立复现红字报错；② 审计两套验证脚本为何全绿却漏掉两个真机缺陷；
> ③ 给出「不重启 DSH、尽量逼近真实 remote 方法链」的验证框架建议。

---

## 0. 一句话结论

两个缺陷都源于**同一个被验证完全覆盖不到的层级**：**宿主 remote 方法 `refreshCli` 的实现体**。

- 红字报错的根因：`refreshCli`（`src/gui/host.js`）引用了 `capabilityCatalog`，但 `capabilityCatalog` 只在 `createGuiState()` 的闭包里定义，`registerGuiRemote()` 从未把它传进来 → 调用即抛 `ReferenceError: capabilityCatalog is not defined`，被 Gateway 包成 `gateway/internal capabilityCatalog is not defined`。
- 下拉没有「实时模型」：实时模型来自 `capabilityCatalog` 的动态发现（`ctx.llm.listModels()` / codex `model/list`），而唯一能重新拉取并把 discovered 模型写回下拉的入口正是 `refreshCli` —— 它被上面的报错卡死，所以点「刷新能力」永远拿不到实时模型；下拉里只剩 profile 静态/配置推导出来的「之前用过的」选项。

**两套验证脚本（render 24 项、interaction 20 项）全部用 stub 替换了 remote、喂了合成数据**，所以只验证了「给定 capabilities 能渲染」「remote 契约（参数 schema）合法」，却从未执行过真正的 `refreshCli` 实现体，也从未验证「宿主真的能产出实时 capabilities」。契约测试（schema）绿 ≠ 实现测试（body）绿。

---

## 1. 复现红字报错（不重启 DSH）

### 1.1 复现方式

不重启 DSH。用 Node 直接加载插件 `src/gui/host.js`，用最小替身把宿主 Typert 协议桩掉（仅复刻 `TypertRemoteService` / `Remote` / `RemoteError` 三个导出），让 `registerGuiRemote()` 真正实例化 `MeetingStoneGuiRemote`，再直接调用 `instance.refreshCli('dsh', true)`。

> 为什么需要桩协议：项目里装的是 ESM-only 版本的 `@deepseek-ai/dsh-typert-protocol`，Node 20 的 `require()` 无法加载（DSH 用 Node 24 可以 `require(ESM)`）。用进程级 `_resolveFilename` 钩子把协议重定向到只读诊断桩，不碰任何项目文件。

复现脚本与产物（均在 `.meetingstone/runs/verify-audit/`，不含项目源码）：
- `repro-refreshCli.mjs` —— 加载真实 `host.js` 并调用 `refreshCli`
- `hook.cjs` —— require 重定向钩子
- `node_modules/@deepseek-ai/dsh-typert-protocol/`（桩，用完即弃）

运行命令（worktree 版本，即用户真机对应的代码）：

```bash
cd d:/MeetingStone/.meetingstone/runs/verify-audit
node --require ./hook.cjs repro-refreshCli.mjs
```

### 1.2 复现结果（实测输出）

```
registerGuiRemote.result = {"registered":true,"hasInstance":true}
--- refreshCli 实际行为 ---
{
  "threw": true,
  "name": "ReferenceError",
  "message": "capabilityCatalog is not defined",
  "isReferenceError": true,
  "stackTop": "ReferenceError: capabilityCatalog is not defined | at MeetingStoneGuiRemote.refreshCli (.../src/gui/host.js:641:35) ..."
}
```

**复现成功**：与用户原话 `gateway/internal capabilityCatalog is not defined` 完全对应。

### 1.3 `gateway/internal` 前缀从哪来（已查 app.asar 确认）

在宿主 `app.asar` 的 `dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js` 中确认：

```
function terminalStreamFailure(error) {
  return remoteErrorOf(error) ?? new RemoteError("gateway/internal", error instanceof Error ? error.message : String(error), {}, { cause: error });
}
function protocolViolation$1(message) { return new RemoteError("gateway/internal", message, {}); }
```

网关 README（asar 内同包 `README.md`）也写明：

> The Connection adapter answers `gateway/internal` with empty details for dispatch failures and unclassified exceptions; a `RemoteError` thrown by an owner or by Gateway ...

即：**owner（本插件）的 remote 方法抛出未分类异常时，网关把它包成 `RemoteError("gateway/internal", <原错误信息>)`**。所以完整红字 = `gateway/internal` + `ReferenceError` 的 message（`capabilityCatalog is not defined`）。这与复现栈顶 `host.js:641` 一致。

### 1.4 对用户「是不是不可 JSON 序列化」猜测的纠正

用户/派单里曾怀疑「返回值里有不可 JSON 序列化的东西」。**实测否定了这一假设**：`refreshCli` 在到达任何 `return` 之前就抛出了 `ReferenceError`，根本没有任何返回值可供序列化。红字的本质是**未捕获的引用错误**，不是序列化问题。验证框架要抓的是「方法体抛错」，不是「返回值不可序列化」。

### 1.5 根因定位（精确到行）

| 位置 | 说明 |
| --- | --- |
| `src/gui/host.js:370` | `const capabilityCatalog = capabilities ?? createCliCapabilityCatalog(...)` —— 定义在 **`createGuiState()` 闭包内** |
| `src/gui/host.js:442` | `globalView()`（同闭包内）调用 `capabilityCatalog.snapshot()` —— **此处能用到，所以初始快照有（静态/配置推导的）capabilities** |
| `src/gui/host.js:637-659`（worktree）/ `655-667`（parent） | `refreshCli()` 定义在 `registerGuiRemote()` 闭包内，**引用 `capabilityCatalog` 但不在其词法作用域** → 抛 `ReferenceError` |
| `src/gui/host.js:504` | `createGuiState()` 返回 `{ snapshot, fullSnapshot, recordError, recordDispatch }` —— **没有把 `capabilityCatalog` 暴露出来** |
| `src/index.js:437-440` | `registerGuiRemote(ctx, { snapshot: () => gui.fullSnapshot(), configApi })` —— **`deps` 从未包含 `capabilityCatalog`** |

**根因一句话**：`capabilityCatalog` 的创建（`createGuiState`）和 `refreshCli` 的调用（`registerGuiRemote`）是两个彼此隔离的闭包，`registerGuiRemote` 既没被传入、也没从 `createGuiState` 拿到这个目录。

### 1.6 旁证：parent 仓库已有悟空在修的半截补丁

`D:/MeetingStone/src/gui/host.js:659-667` 已经加了守卫：

```js
// 能力目录未装配时**如实报错**，不要抛 ReferenceError。
// （2026-11-12：之前这里直接引用未定义的 `capabilityCatalog`，
//  宿主把 ReferenceError 包成 `gateway/internal ... is not defined` 显示成红字。）
if (!capabilityCatalog) {
  throw new RemoteError('MEETINGSTONE_GUI_CAPABILITIES_UNAVAILABLE', '能力目录未装配（插件初始化未传入 capabilities）')
}
```

这说明悟空**已确认同一根因**（注释直接点名「未定义的 capabilityCatalog」）。但该守卫只是把 `ReferenceError` 换成更清晰的 `RemoteError` —— **刷新仍然失败**（目录依旧没传进来）。真正的修法是把 `capabilityCatalog` 通过 `deps` 传入 `registerGuiRemote`（或让 `registerGuiRemote` 复用 `createGuiState` 的产物）。worktree（用户真机对应的分支）还没有这半截守卫，所以是原始 `ReferenceError` 形态。

---

## 2. 审计：两套验证脚本为什么全绿却漏掉两个缺陷

实测：本机 `node scripts/verify-d1-render.mjs` → **24 PASS / 0 FAIL**；`node scripts/verify-d1-interaction.mjs` → **20 PASS / 0 FAIL**。两个脚本在 bug 存在时全部通过。

### 2.1 `verify-d1-render.mjs`（静态，24 项）—— 漏掉两缺陷

- **它做什么**：读 `src/client/index.js` 源码做字符串/正则匹配（字典键、是否存在 `refreshCapabilities` 文案、两色、返回按钮等），再**本地** `buildSnapshot()`（第 93-211 行）从 profile YAML 自己解析出一份 capabilities 做断言（第 349-377 行）。
- **为什么漏**：
  - 它从不加载、更不执行**宿主侧** `src/gui/host.js` 的 `refreshCli`，也从不检查 `capabilityCatalog` 是否在 `refreshCli` 作用域内。红字报错对它完全不可见。
  - 它对 capabilities 的断言基于**本地重新解析的 profile**（`buildSnapshot` 里 `kindToCli` / `catalog` 是脚本自己手写的副本），而不是 `createGuiState`/`capabilityCatalog` 的真实输出。所以即使真机 `capabilityCatalog` 为空或刷新崩溃，这条「DeepSeek Harness 有模型值」依旧绿（因为它检查的是脚本自己造的数据）。
  - 它验证的是「**源码里有没有某个文案/键**」和「**我本地算的快照长什么样**」，不是「**真机运行时数据对不对**」。

### 2.2 `verify-d1-interaction.mjs`（动态，20 项）—— 漏掉两缺陷

- **它做什么**：真加载 `src/client/index.js`，渲染设置页/管理器/详情，检查按钮、下拉、文案。但：
  - 第 264 行：`configActions: { setCliEnabled: async () => ({}), refreshCli: async () => ({}) }` —— **`refreshCli` 是空 stub**，永远返回 `{}`，且断言里根本没调用它。
  - 第 189-193 行：`global.capabilities` 是**硬编码**的合成数据（dsh/codebuddy/codex 各塞一个模型）；第 208-211 行直接喂给渲染器。
- **为什么漏**：
  - 「U6 详情有 4 个 CLI 选项 / 有模型字段」等项（第 423-461 行）检查的是「**我喂进去的 capabilities 有没有被渲染出来**」，即「给定数据能渲染」。它证明了 UI 渲染逻辑没坏，**但完全没有证明「宿主真的能拿到实时模型」**——因为真实数据链路（host → gateway 序列化 → client）被 stub 整个换掉了。
  - `refreshManagerCapabilities`（`src/client/index.js:1983-2013`，第 1987 行真正调用 `refreshCli`）这条「刷新后把 discovered 模型写回下拉」的逻辑，在 interaction 脚本里**从未被触发**（stub 不调用、不抛错）。所以「刷新拿不到实时模型」对它不可见。
  - 它验证的是「**client 渲染层在合成数据下表现正确**」，不是「**remote 方法链在真实依赖下能产出数据**」。

### 2.3 具体是哪个设计决策导致的？（核心）

> 你的怀疑是对的：**两套脚本都用 stub 替换了 remote，于是只验证了「给定数据能渲染」，没验证「真实数据能拿到」。** 更精确的定性：

1. **决策 A：用 stub 替换 entire remote（含 `refreshCli`）。** 这是主因。客户端验证只需要在「渲染」层用 stub 隔离远程，但**这套脚本把「远程是否真的能产出数据」也一起 stub 掉了**，等于把最容易出错的环节（真实依赖装配、作用域、序列化）从测试里删除了。
2. **决策 B：host 半边几乎零测试，且现有 host 测试只测「契约/schema」不测「实现体」。** 证据：
   - `tests/gui.test.mjs:544-545` 用的也是**手写 stub `refreshCli`**，从不调用真实 `MeetingStoneGuiRemote.refreshCli`。
   - `tests/typert-contract.test.mjs` 测的是 `refreshCli` 的**参数 strict codec/schema**（第 55、93、208 行），即「传参合法、能注册」—— **schema 绿了，但方法体里 `capabilityCatalog is not defined` 的 `ReferenceError` 根本没被任何测试执行到**。
   - 没有任何测试实例化真实 remote 并调用其 `refreshCli` 实现体。
3. **决策 C：render 脚本用「本地重写一份 catalog」替代真实 `capabilityCatalog` 输出。** 这让「capabilities 有模型」这类断言变成自证，无法反映真机目录为空/崩溃的情况。

**结论**：缺陷 1（红字）是 host 实现体的作用域 bug，缺陷 2（下拉无实时模型）是同一 host 数据链路的派生后果——**两者都恰好落在「stub 替换 remote + 只测 schema/渲染」留下的盲区里**。全绿是虚假置信。

### 2.4 还应补什么样的验证，才能真正抓到这类问题？

按优先级：

1. **host 半边实现体集成测试（最关键，见第 3 节）**：用真实 `host.js` 构造真实 remote，调用 `refreshCli` 并断言返回 `{ ok:true, capabilities }` 且 `JSON.stringify` 不抛错。本审计的 `repro-refreshCli.mjs` 就是模板——把它固化为 `tests/refreshCli.host.test.mjs` 即可。这一条单独就能抓到本次 `ReferenceError`。
2. **「刷新→写回下拉」闭环测试**：在 client 侧不 stub `refreshCli`，而是注入一个会返回 discovered 模型的假 remote，断言 `refreshManagerCapabilities` 真的把 discovered 模型合并进 `snapshot.global.capabilities`。当前 interaction 脚本把这一步 stub 掉了。
3. **「initial snapshot 真的含 discovered」测试**：用注入了 `ctx.llm.listModels()` 的 `createGuiState`，断言 `fullSnapshot().global.capabilities` 中 dsh 的 `sources.models === 'discovered'` 且模型非空。这能抓「初始下拉就没有实时模型」。
4. **作用域/装配回归断言（防复发）**：加一条测试，实例化真实 remote 后断言 `refreshCli` 不抛 `ReferenceError` 且能访问到与 initial snapshot 同源的 `capabilityCatalog`（即两个闭包拿到了同一个目录）。悟空修完后，这条要从「抓 bug」转为「防回归」。

---

## 3. 真实环境验证框架建议（不重启 DSH）

### 3.1 设计原则

- **能跑真实代码的层，就跑真实代码**；只在「没有宿主就加载不出」的宿主专属依赖上用桩。
- **明确标注每一层是模拟还是真实**，不把桩的结果宣称成真机结果。
- 分层验证，逐层隔离故障：client 渲染层、host 实现层、host↔gateway 序列化边界、真实宿主 `ctx`。

### 3.2 框架分层（哪层真、哪层模拟）

| 层 | 验证手段 | 真 / 模拟 | 能抓到什么 | 抓不到什么 |
| --- | --- | --- | --- | --- |
| **client 渲染层** | 已存在 `verify-d1-interaction.mjs` / `gui-u2-u3.test.mjs`（建议**去掉对 `refreshCli` 的 stub**，改注入可控假 remote） | 真实 client 模块 | UI 在给定数据下渲染正确 | 真实数据从哪来 |
| **host 实现层（本次缺口）** | 新增 `tests/refreshCli.host.test.mjs`：加载真实 `host.js`，桩掉**仅** Typert 协议，构造真实 remote，调用 `refreshCli`/`updateGlobalRole` 等 | **真实 `host.js` 实现体**；仅协议桩 | 作用域 bug、null ref、返回不可序列化、逻辑错误（**本次 `ReferenceError` 在此被抓**） | 真实 gateway 序列化、真实 `ctx.llm` |
| **host↔gateway 序列化边界** | 已存在 `tests/typert-contract.test.mjs`（real strict codec）。**必须和「实现体测试」成对存在**——本次 codec 绿但实现体红，说明单独测 schema 不够 | 真实 codec | 参数/返回值在 gateway 边界能否被 zod 解析 | 方法体行为 |
| **真实宿主 `ctx` / `ctx.llm.listModels()`** | 只能在**运行中的 DSH** 内执行：若 DSH 有插件自测 harness 就跑；否则作为**人工真机核对项** | 真实（仅 in-app） | 实时模型真的能从模型接口拿到 | 无法在 CI/离线复现 |

### 3.3 可直接落地的 host 实现层测试骨架（基于本次复现改造）

`.meetingstone/runs/verify-audit/repro-refreshCli.mjs` 已经实现了「加载真实 host.js + 桩协议 + 调真实 refreshCli」的完整链路。把它固化为正式测试即可，要点：

```js
// tests/refreshCli.host.test.mjs（示意）
import { registerGuiRemote } from '../src/gui/host.js'
// 桩协议：TypertRemoteService / Remote / RemoteError 三个导出（仅复刻形状）
const reg = registerGuiRemote(ctx, { snapshot, configApi })
assert.equal(reg.registered, true)
const res = await reg.instance.refreshCli('dsh', true)   // 关键：调真实实现体
assert.equal(res.ok, true)
assert.ok(Array.isArray(res.capabilities))
JSON.parse(JSON.stringify(res))                            // 断言可无损序列化
```

该测试在 Node 20 下需要把 ESM-only 的协议重定向到桩（本次用 `hook.cjs` 的 `_resolveFilename` 钩子；DSH 自身 Node 24 环境可直接 `require` 真实协议，无需钩子）。

### 3.4 明确说不出来的部分（诚实边界）

- **真实 gateway 序列化 + 真实 `ctx.llm.listModels()` 的端到端**：只能在运行中的 DSH 内验证（或在 DSH 的插件自测 harness 里）。**离线/CI 无法 100% 复现**，必须作为一条「真机人工核对项」保留：打开设置页 → 点「刷新能力」→ 不应出现 `gateway/internal` 红字，且 dsh 的下拉里出现 `source: 'discovered'` 的模型。
- 本框架能**确定性抓到**的是：host 实现体的作用域/引用/序列化类缺陷（本次红字的根因），以及「刷新→写回下拉」闭环是否接通。这些占本次两个缺陷的绝大部分因果链，且**不需要重启 DSH**。

### 3.5 给主控/悟空的下一步

1. 把 `capabilityCatalog` 通过 `registerGuiRemote` 的 `deps`（或在 `src/index.js` 把 `gui` 的目录传给 remote）接进 `refreshCli` 作用域——这是根因修复（悟空已在 parent 加了守卫，但还需真正把目录传进来，否则刷新仍失败）。
2. 将 `repro-refreshCli.mjs` 固化为 `tests/refreshCli.host.test.mjs`，纳入门禁。
3. `verify-d1-interaction.mjs` 去掉对 `refreshCli` 的空 stub，改注入「返回 discovered 模型的假 remote」，补一条「刷新后 discovered 模型进入下拉」的断言。
4. 真机人工核对项写进发布检查清单（D1 用户验收清单），明确标注「此条只能真机验」。

---

## 附：证据索引

- `src/gui/host.js:370` —— `capabilityCatalog` 定义于 `createGuiState` 闭包
- `src/gui/host.js:442` —— `globalView` 同闭包内可用（初始快照有静态/配置能力）
- `src/gui/host.js:637-659`（worktree）/ `655-667`（parent）—— `refreshCli` 引用未定义 `capabilityCatalog`
- `src/gui/host.js:504` —— `createGuiState` 未暴露 `capabilityCatalog`
- `src/index.js:437-440` —— `registerGuiRemote` 的 `deps` 未含 `capabilityCatalog`
- `src/client/index.js:1983-2013` —— `refreshManagerCapabilities` 调 `refreshCli`（客户端刷新入口）
- `scripts/verify-d1-render.mjs:93-211, 349-377` —— 本地重写 catalog，非真实输出
- `scripts/verify-d1-interaction.mjs:189-211, 264` —— 硬编码 capabilities + 空 stub `refreshCli`
- `tests/gui.test.mjs:544-545` —— 手写 stub `refreshCli`，未测真实实现体
- `tests/typert-contract.test.mjs:55,93,208` —— 只测 `refreshCli` 参数 schema，未测方法体
- 宿主 `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js`（byte ~20134343 / 20134931 / 20148928）—— `new RemoteError("gateway/internal", message)` 包住未分类异常
- 复现产物：`d:/MeetingStone/.meetingstone/runs/verify-audit/repro-refreshCli.mjs`、`hook.cjs`、协议桩
