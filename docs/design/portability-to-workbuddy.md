# 能否把集合石移植到 WorkBuddy：技术评估

> 日期：2026-11-14
> 方法：解包 WorkBuddy `app.asar`（173.6 MB / 9893 文件）+ 读真实插件清单与源码
> 结论：**不能原样移植。但「角色派单」这个产品概念可以重做，工作量中等。**

---

## 一、先看清两边是什么

### 1.1 集合石（DSH 插件）

| 维度 | 事实 |
|---|---|
| 运行环境 | Node.js 主进程，**完整 Node 能力**（`require` / `fs` / `child_process` / `git`） |
| 扩展方式 | Cordis 插件：`ctx.tools.register()` 注册工具 |
| 依赖的核心 API | `ctx.subagents` / `ctx.tools` / `ctx.llm` / `ctx.jobs` / `ctx.worktrees` / `ctx.remote` / `ctx.typert` / `ctx.slots` |
| 代码量 | `src/` 约 250 KB / 40 个模块 |
| UI | 客户端 React 组件 + 宿主 slots + Typert remote |

**核心能力**：
1. 注册 10 个工具（dispatch / wait / get_task / cancel / list_runs / ...）
2. 派单到外部 CLI（CodeBuddy / Codex / Claude）—— 起子进程、走 ACP 协议
3. **worktree 隔离** —— `git worktree add`，每任务独立工作树
4. 执行记录落盘（`.meetingstone/runs/*.json`）
5. 设置页 UI

### 1.2 WorkBuddy（v5.9.3）

| 维度 | 事实 |
|---|---|
| 架构 | Electron（`app.asar` 173.6 MB） |
| 插件系统 | `<plugin>/.codebuddy-plugin/plugin.json` |
| **插件能力字段** | `skills` / `mcpServers` / `hooks` / `commands` / `agents` / `modules` |
| 插件数量 | 内置 34 个（`marketplace.json` 列出） |
| 文件规模 | `resources/plugins` 745 个文件、`resources/extensions` 611 个 |
| **mod 执行环境** | **隔离沙箱**（`CBC_MODS_ISOLATE` 默认开） |

---

## 二、关键差异：执行环境被沙箱化

### 2.1 WorkBuddy 的 mod 能力面（来自真实源码）

`subscription-gate/hooks/register.ts` 的注释写得很明确：

> 生产加载走隔离通道（`CBC_MODS_ISOLATE` 默认开，`isolated-import.ts` 的加固 realm）：
> **脚本拿不到宿主 `require`/`process`/`global`**，`import 'node:…'` 会在加载期
> 被 require 拦截器 fail-closed 拒绝。

**可用能力只有注入的 `$`**：
```typescript
$.process.run    // 跑子进程
$.env.get        // 读环境变量
$.clock.now      // 时钟（毫秒 epoch）
$.plugin.root    // 插件根目录
console.error    // 日志（realm endowment）
```

**不能用**：`fs` / `path` / `child_process` / `require` / `process`。

### 2.2 这对集合石意味着什么

| 集合石的能力 | 依赖 | WorkBuddy 能否 | 判定 |
|---|---|---|---|
| 注册工具 | `ctx.tools.register` | 插件清单**没有 `tools` 字段**；只能靠 MCP 或 skill | ❌ 需重做 |
| 派单起子进程 | `child_process.spawn` | `$.process.run` 可用 | ⚠️ 受限可做 |
| **worktree 隔离** | `fs` + `git` 命令 | 无 `fs`，只能跑 `git`；**无法建目录/写文件** | ❌ 做不了 |
| 执行记录落盘 | `fs.writeFile` | 无 `fs` | ❌ 做不了 |
| 设置页 UI | `ctx.slots` + Typert remote | WorkBuddy 用 extension（federation 模块） | ❌ 完全不同体系 |
| 模型/能力探测 | `ctx.llm` | 无对应 | ❌ 需改用 MCP |
| 角色配置持久化 | profile `cordis.patch.yml` | 无对应 | ⚠️ 需改用插件配置 |

**结论：集合石 5 项核心能力里，4 项在 WorkBuddy 的沙箱里做不了。**

---

## 三、那什么能做？

WorkBuddy 的插件模型是 **「Skill（Markdown 提示词）+ MCP（工具服务）+ Hooks（生命周期）」**，
不是「插件注册代码工具」。

### 3.1 能做的部分

| 集合石的组成 | WorkBuddy 对应做法 | 可行性 |
|---|---|---|
| 角色定义（谁用什么模型/强度） | **Skill 的 frontmatter** + `agents` 字段 | ✅ 可行 |
| 「把活派给某个角色」 | Skill 本身（`name` + `description` 触发） | ✅ 可行 |
| 执行记录 | MCP 服务（外部进程，有 fs 权限） | ✅ 可行但要单独写服务 |
| worktree 隔离 | **MCP 服务里做**（MCP 是独立进程，有完整 Node） | ✅ 可行但要单独写服务 |
| 设置页 | WorkBuddy extension（federation 模块） | ⚠️ 成本高 |

### 3.2 关键洞察：**MCP 是突破口**

WorkBuddy 的插件清单支持：
```json
{
  "mcpServers": {
    "meetingstone": { "type": "http", "url": "..." }
  }
}
```

**MCP server 是独立进程，不受 mod 沙箱限制**，可以：
- 有完整 `fs` / `child_process`
- 跑 `git worktree`
- 维护执行记录
- 提供工具（MCP tools 就是 LLM 能调用的工具）

**所以移植路径是：把集合石的核心逻辑改成 MCP server，插件清单只挂 MCP。**

---

## 四、工作量估算

| 方案 | 内容 | 工作量 | 风险 |
|---|---|---|---|
| **A. 原样移植** | — | **不可行** | 沙箱阻断 4/5 核心能力 |
| **B. 完全重写为 MCP** | 把 dispatcher / worktree / run-store 抽成独立 MCP server；角色配置改走 Skill | **2–3 周** | 中（MCP 生态成熟） |
| **C. 只做 Skill 版「角色提示词分发」** | 不做真派单，只做「按角色注入不同提示词」 | **2–3 天** | 低 |
| **D. 保持 DSH 独占，WorkBuddy 用现有 CodeBuddy 能力** | 不移植 | **0** | 无 |

---

## 五、我的建议

### 不建议移植的理由

1. **架构不兼容**：DSH 是「代码插件」，WorkBuddy 是「Skill + MCP」。集合石的核心价值
   （worktree 隔离、执行记录、跨 CLI 派单）在 WorkBuddy 里都要重写成独立服务。
2. **WorkBuddy 自己已经有类似能力**：它的 `skill-recommend-experts`、
   `interactionmode-expert`、`builtin-teams-todo` 已经覆盖了「专家/角色」概念。
3. **投入产出比低**：2-3 周重写，得到一个功能比 DSH 版弱的插件。

### 如果一定要做，建议方案 C

**只做 Skill 版「角色提示词分发」**（2–3 天）：

```
meetingstone-skills/
  .codebuddy-plugin/plugin.json
  skills/
    tangtang/SKILL.md    ← 唐僧：架构决策
    wukong/SKILL.md      ← 悟空：技术评估
    bajie/SKILL.md       ← 八戒：执行
```

**它不做**：worktree、执行记录、跨 CLI 派单、模型路由。
**它做**：让用户能「切换角色」，每个角色有不同的提示词与工作方式。

这本质上是**把「角色设定」这一层复用过去**，放弃底层派单机制。

---

## 六、给决策者的三个问题

1. **你在 WorkBuddy 里真正想要的是什么？**
   - 「换个角色说话」→ 方案 C 够用（2-3 天）
   - 「跨 CLI 派单 + worktree 隔离」→ 方案 B（2-3 周，且比 DSH 版弱）

2. **WorkBuddy 的 MCP 生态是否已有人做过类似的事？**
   建议先搜 `workbuddy mcp dispatch` / `codebuddy mcp subagent`，
   有现成的话直接接，不用重写。

3. **是否接受「两个平台两套实现」的维护成本？**
   如果不能共享代码，长期要维护两份。

---

## 附录：证据索引

| 证据 | 位置 |
|---|---|
| WorkBuddy 版本与架构 | `app.asar/package.json`（`@genie/workbuddy-desktop` 5.9.3） |
| 插件清单字段 | `resources/plugins/workbuddy-builtin/builtin-plugins/*/.codebuddy-plugin/plugin.json` |
| 市场索引格式 | `resources/plugins/workbuddy-builtin/.codebuddy-plugin/marketplace.json`（34 个插件） |
| **mod 沙箱限制** | `subscription-gate/hooks/register.ts` 注释（`CBC_MODS_ISOLATE`） |
| Hook 机制 | `subscription-gate/hooks/hooks.json`（`PreToolUse` / `UserPromptExpansion`） |
| Skill 结构 | `ardot/skills/*/SKILL.md`（frontmatter + Markdown） |
| 集合石的 DSH 依赖 | `src/` 里 `ctx.*` 与 `@deepseek-ai/*` 的 import 统计 |
