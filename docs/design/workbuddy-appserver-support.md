# WorkBuddy 能否支持 Codex 的 app-server 机制

> 日期：2026-11-14
> 结论：**不能直接支持。但要分清「在 WorkBuddy 里」和「WorkBuddy 调用外部进程」两种情形。**

---

## 一、先明确 app-server 是什么

Codex 的 `app-server` 是一个**长驻进程**，通过 **JSON-RPC over stdio** 通信：

```
宿主                           codex app-server
  │  spawn(['app-server'])          │
  │────────────────────────────────>│  进程启动
  │                                 │
  │  {"id":1,"method":"initialize"} │
  │────────────────────────────────>│
  │  {"id":1,"result":{...}}        │
  │<────────────────────────────────│
  │  {"method":"initialized"}       │
  │────────────────────────────────>│
  │  {"id":2,"method":"model/list"} │
  │────────────────────────────────>│
  │  {"id":2,"result":{"data":[...]}}│
  │<────────────────────────────────│
  │                                 │
  │    ... 后续可反复请求 ...       │
  │                                 │
  │  stdin.close()                  │
  │────────────────────────────────>│  进程退出
```

**关键特征（四条缺一不可）**：

1. **双向流式**：请求发出去，响应流回来，可多轮
2. **进程长驻**：一次 spawn，多次请求
3. **stdin 可增量写**：不是「一次性喂完」
4. **需要读 stdout 的实时输出**：JSON-RPC 逐行

集合石的 `probeCodexModels()` 正是这么实现的：

```js
child = spawnImpl(executable, ['app-server'], { stdio: ['pipe','pipe','pipe'] })
child.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize', ... }) + '\n')
// 监听 child.stdout 的 'data' 事件，逐行解析
// 收到 initialize 响应后，再写 model/list
```

---

## 二、WorkBuddy 的 `$.process.run` 是什么

来自真实源码 `subscription-gate/hooks/compiled/register.js:55-58`：

```js
const argv = ["node", `${root}/dist/gate.mjs`, "expert", String(spawnedAtMs / 1e3)]
result = await $.process.run(argv, {
  stdin: JSON.stringify(payload),   // ← 一次性字符串
  timeoutMs: budgetMs,
})
if (!result || result.exitCode !== 2) return undefined
const denyText = extractDenyText(result.stderr)  // ← 读 stderr
```

**契约**：

| 输入 | 说明 |
|---|---|
| `argv` | 完整命令行数组 |
| `stdin` | **一个字符串**（一次性） |
| `timeoutMs` | 超时后 SIGKILL |

| 输出 | 说明 |
|---|---|
| `exitCode` | 进程退出码 |
| `stderr` | 完整 stderr 文本 |
| `stdout` | 应该有（虽然这段代码没用到） |

**这是「一次性执行」模型（exec 语义），不是「长驻连接」（spawn 语义）。**

---

## 三、逐条对比

| app-server 需要 | `$.process.run` 提供 | 结论 |
|---|---|---|
| 双向流式通信 | ❌ 只有一次性 stdin 字符串 | **不支持** |
| 进程长驻（多次请求） | ❌ 每次调用都是新进程 | **不支持** |
| stdin 增量写 | ❌ 一次性写入后关闭 | **不支持** |
| 实时读 stdout | ❌ 只有进程结束后的结果 | **不支持** |

**四条全部不满足。**

### 3.1 为什么不能「变通」

有人可能会想：能不能把 `initialize` + `initialized` + `model/list` 拼成一个完整的 stdin 一次性喂进去？

**理论上可以**——JSON-RPC 是换行分隔的，一次写三行不会崩。

```js
const stdin = [
  JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize', params:{...} }),
  JSON.stringify({ jsonrpc:'2.0', method:'initialized', params:{} }),
  JSON.stringify({ jsonrpc:'2.0', id:2, method:'model/list', params:{} }),
].join('\n')
```

**但有个致命问题**：`initialized` 必须在收到 `initialize` 响应**之后**发。
一次性全写进去，服务端可能因为时序错乱而不响应 `model/list`。

**实测验证**：我们自己的 `probe-codex-models.mjs` 就是先等 `initialize` 响应、
再发 `initialized` 和 `model/list`。如果改成一次性写入，大概率失败。

**结论：可以「凑」，但不可靠。**

---

## 四、但有个重要区分

### 4.1 ❌ 不能的：在 WorkBuddy 的 **mod** 里跑 app-server

mod 跑在隔离 realm，只有 `$.process.run`（一次性），做不了长驻连接。

### 4.2 ✅ 能做的：在 WorkBuddy 的 **hook 命令**里跑 app-server

`hooks.json` 支持 `type: "command"`：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Skill",
      "hooks": [{
        "type": "command",
        "command": "node \"${CODEBUDDY_PLUGIN_ROOT}/dist/gate.mjs\" skill ...",
        "timeout": 30
      }]
    }]
  }
}
```

**这个 `command` 是一个 shell 命令，跑在普通 Node 进程里。**

证据：`gate.mjs` 的第一行就是：
```js
#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
```

**它用了 `fs` / `net` / `crypto`，还自己实现了 WBIPC 的 UDS/命名管道长连接协议。**

所以：**hook 命令形式的脚本有完整 Node 能力，包括 `spawn` 长驻进程。**

### 4.3 ✅ 也能做的：在 **MCP server** 里跑 app-server

MCP server 是独立进程，不受任何沙箱限制。插件清单挂：

```json
{ "mcpServers": { "meetingstone": { "type": "http", "url": "..." } } }
```

MCP server 内部可以 `spawn('codex', ['app-server'])`，完全没问题。

---

## 五、所以真正的答案

| 场景 | app-server 能用吗 | 为什么 |
|---|---|---|
| **集合石移植成 WorkBuddy mod** | ❌ **不能用** | mod 只有一次性 `$.process.run` |
| **写成 WorkBuddy 的 hook 脚本** | ✅ **能用** | hook 是普通 Node 进程，有完整能力 |
| **写成 WorkBuddy 的 MCP server** | ✅ **能用** | 独立进程，无限制 |
| **集合石保持 DSH 插件** | ✅ 已经在用 | DSH 有 `child_process.spawn` |

**换句话说：不是 WorkBuddy 不支持 app-server，而是 WorkBuddy 的「mod 沙箱」不支持。
绕开 mod、用 hook 脚本或 MCP server，就能支持。**

---

## 六、但这解决不了移植的根本问题

即使走 MCP server 路，集合石仍有 3 个能力在 WorkBuddy 里没有对应：

| 能力 | WorkBuddy 是否有 | 影响 |
|---|---|---|
| `ctx.tools.register`（注册工具到 LLM） | ❌ 插件清单无 `tools` 字段 | 需改成 MCP tools |
| `ctx.worktrees` / `git worktree` | ⚠️ MCP 里能做（有 fs） | 可行 |
| `ctx.slots`（注入设置页 UI） | ❌ 完全不同的 extension 体系 | 需重写 |
| `ctx.llm.listModels` | ❌ 无对应 | 需改用 MCP 或 ACP |
| run 记录落盘 | ⚠️ MCP 里能做 | 可行 |

**所以：app-server 不是障碍，但「工具注册 + UI 注入」是。**

---

## 七、给你的结论

**问：WorkBuddy 能支持 codex app-server 机制吗？**

**答：分三种情况**

1. **在 WorkBuddy 的 mod（沙箱模块）里** → ❌ 不能，只有一次性 `$.process.run`
2. **在 WorkBuddy 的 hook 命令里** → ✅ 能，普通 Node 进程，有 `spawn` / `net`
3. **在 WorkBuddy 的 MCP server 里** → ✅ 能，独立进程

**但即使技术上能做，移植的瓶颈不在这里**——而是「工具如何暴露给 LLM」和「设置页 UI」，
这两项 WorkBuddy 与 DSH 是完全不同的体系。

---

## 附录：证据

| 结论 | 出处 |
|---|---|
| `$.process.run` 一次性执行 | `subscription-gate/hooks/compiled/register.js:55-58` |
| 参数是 `{ stdin, timeoutMs }` | 同上 |
| 返回值有 `exitCode` / `stderr` | 同上 `:63-66` |
| hook 命令有完整 Node | `subscription-gate/dist/gate.mjs:1-10`（`import fs/net/crypto/os/path`） |
| mod 沙箱限制 | `subscription-gate/hooks/register.ts` 注释（`CBC_MODS_ISOLATE`） |
| 插件支持 `mcpServers` | `builtin-calendar/.codebuddy-plugin/plugin.json` |
| 集合石怎么用 app-server | `src/cli/capabilities.js` 的 `probeCodexModels()` |
