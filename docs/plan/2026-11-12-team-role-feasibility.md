# Agent Teams 角色可定制性：可行性研究（终版）

> 日期：2026-11-12
> 触发：用户明确要求「智能体团队角色不能调整，这个我不能接受」，要求研究官方文档与社区经验解决。
>
> **结论：可解。社区已有 3 个成熟插件验证过同一条路，全部只用框架公开接口，不改宿主。**

## 一、问题拆成三件，成因完全不同

| 现象 | 能否解决 | 难度 |
|---|---|---|
| ① 成员名只能是 `sashi` 这类拼音，不能用「唐僧」 | **可以绕过** | 小 |
| ② 成员无法指定模型/角色，一律继承父会话 | **可以解决** | 中 |
| ③ 成员不能改名、不能删除 | **不能** | — |

## 二、逐项根因（源码证据）

### ② 成员无法指定模型 —— 这是核心问题，可解

**现状**：`@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js:237`

```js
const started = await this.ctx.subagents.startActivation({
  delivery: 'parent', childId,
  provider: request.provider,
  label: description,
  request: {
    prompt: request.prompt,
    parent: root,          // ← 没有 agentOptions
  },
  signal,
})
```

`spawn_teammate` 工具参数只有 `name / description / prompt / context`（`tool-agent-team/lib/index.js:250-274`），
传不进模型。于是 `resolveChildAgentOptions(parent, undefined, depth)` 落到
`parentAgentOptionsForDelegation(parent)` = 父会话最近一次请求的路由，
**并写入 descriptor 永久固化**。

**但底层完全支持。** `dsh-subagent-spawn-in-process/lib/index.js:21-26`：

```js
capabilities = {
  agentOptions: true,      // ← 支持 agentOptions（注释：merged over the parent route）
  agentPreset: true,
  outputSchema: true,
  depthLimit: true,
}
```

### ③ 不能改名/删除 —— 官方设计，无解

翻遍 `dsh-experimental-agent-team` 的方法名，**没有** `removeMember` / `dismiss` / `rename` /
`deleteMember` / `archive`。只有 `stopTeammates`（停运行时，不删记录）。

roster 是 append-only journal，`memberName()` 注释原文：
*Validate a **never-reused** model-facing teammate name*。名字一经占用永久不可复用。

**这是刻意设计，不是 bug。** 社区插件 README 也确认：「没有移除队友的公开接口——满员后只能复用已有队友」。

### ① 名字不能用中文 —— 可绕过

`roster.js:10`：

```js
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
```

硬编码正则，无配置项。**但可以加一层映射**：`role` 参数用中文，内部转成拼音 member name。

## 三、社区验证过的方案（关键发现）

三个独立插件都在做同一件事，印证了这条路可行：

### 1. [Chruix/dsh-team-model](https://awesome-dsh-plugin.com/zh/p/Chruix/dsh-team-model)

> 内置团队插件在创建队友时不接受模型参数……**这个插件补上这一层，并且只使用框架的公开接口**：
> 新增一个工具、向子会话写入一条既有的 `model/selection` 事件、在 `agent/request` 中保持路由。

新增工具 `spawn_teammate_with_model`，参数在官方基础上加三个可选：

```jsonc
{ "provider": "openai", "model": "gpt-5", "reasoning_effort": "high" }
```

**关键技术点**：「模型会在队友的首轮请求之前写入子会话，因此第一次回复就使用新路由，
不会先用继承的模型跑一轮。」

### 2. [SeverusZh/dsh-plugin-subagent-director](https://blog.yeyupiaoling.cn/article/1787944949892?lang=zh-tw)

> 角色模板：定义角色，包括 **displayName、职责描述、persona**，以及可选的模型绑定。
> 角色按**显示名**引用：`role` 参数未命中 id 时，会按 `displayName` 精确匹配。
> 四级回退链：单次调用参数 > 角色绑定 > 插件默认 > 继承主代理。

**这正好解决中文名问题**：`role: "沙僧"` 可直接用，内部映射。

### 3. [dsh-subagent-model](https://blog.yeyupiaoling.cn/article/1790358339609?lang=zh-cn)

> 在官方模型菜单左侧多出一个「子代理模型」菜单，为所有委派出去的子代理统一配置 provider / model / 推理强度。
> **子代理档位**：为所有委派的子代理统一套用一个人格 + 工具面组合，与「设置 → Agent 预设」完全同源。

## 四、已验证的关键 API（本机实测存在）

### 4.1 `model/selection` durable 事件

`dsh-agent/lib/types/model-selection.js`：

```js
export class AgentModel {
  current() { ... }              // 读当前选择（pending ?? lastUsed）
  select(selection) {            // 写入 durable 事件
    if (sameModelSelection(this.recordedSelection(), selection)) return
    this.session.append('model/selection', toSelection(...))
  }
  recordedSelection() {
    const state = this.readState()
    return state.pending ?? state.lastUsed
  }
}
```

### 4.2 `installModelSelection(agentCtx)`

挂 `agent/pre-step` hook，拿到每步的 `modelSelection`，并生成切换提示：

```js
function installModelSelection(agentCtx) {
  return agentCtx.on('agent/pre-step', async ({ agent, messages, signal, step, modelSelection }, next) => {
    const decision = await next()
    ...
    const previous = agent.session.requestHeader()?.config
    if (previous === undefined || modelSelection.provider === previous.provider && ...) return decision
    return { ...decision, messages: [...decision.messages, modelSwitchNotice(previous, modelSelection)] }
  }, { prepend: true })
}
```

### 4.3 官方模型白名单（如走 `subagent` 工具路线）

`dsh-tool-subagent/lib/model-selection-settings.js`：

```js
static Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile()
})
```

配合 `tool-subagent` 的 `modelSelection: true`，参数自动生成 `provider`/`model`/`reasoning_effort`，
并由 `assertAllowedModelSelection` 按白名单校验。

## 五、推荐方案

**采用社区验证过的「新增工具 + 写 model/selection 事件」路线，不接管官方工具。**

为什么优于我原先想的「禁用官方工具、自己重写」：
1. 官方 `spawn_teammate` 保留，无行为差异风险
2. 只**新增**一个工具，不碰官方注册（`dsh-tools` 里同 scope 同名会冲突：
   `tool "${name}" is already registered in this scope`）
3. 社区已证明这条路在真实宿主上跑通

### 实施步骤

1. **新增工具 `spawn_teammate_as`**（注册到 Lead 的 `agent.ctx`）
   - 参数：官方 4 项 + `role`（中文角色名/拼音/roleId，任一）
   - 内部：`ctx.agentTeams.spawnTeammate()` 建成员 → 立刻给子会话写 `model/selection`
   - 首轮请求即生效，不浪费一轮

2. **角色 → 路由映射**：复用本插件已有的角色配置
   `{kind, provider, model, reasoning}` → `{provider, model, reasoningEffort}`

3. **持久化覆写**（社区踩过的坑，必须处理）
   - 内置 `selectionFor(agent).current` 是**一次性**的，被一次请求消费后清空
   - 表现为「切换只生效一轮」
   - 解法：在**队友** agent 上挂 `agent/request` waterfall，
     按会话投影 `modelSelection.pending ?? lastUsed` 覆写路由

4. **中文名映射**：`role: "沙僧"` → member name `shaseng`
   - 面板显示仍是 `shaseng`（宿主正则限制，无法绕过）
   - 但 `role` 参数可用中文，语义通顺

5. **可选增强：agentPreset 承载完整角色**
   - `spawn` provider 的 `capabilities.agentPreset = true`
   - preset 的 `plugins` 里可放 persona + 工具子集
   - 这能实现「角色 = 模型 + 人格 + 工具面」的完整语义
   - 但 `spawn_teammate` 同样不传 `agentPreset`，需在自建工具里一并传

## 六、风险与限制（必须诚实告知）

| 项 | 说明 |
|---|---|
| **面板仍显示拼音** | 宿主正则 `/^[a-z0-9]+(-[a-z0-9]+)*$/` 硬编码，无法显示中文 |
| **成员不能删** | 官方无此接口，满员（默认 8，社区说 16）后只能复用 |
| **不能改名** | 同上，一次占用永久占用 |
| **RPC 有已知坑** | 社区记录：`ctx.connection.rpc.handle` 在 0.2.1-rc.5 把注册落在 connection 自己的 ctx 上，第三方调用必抛 `cannot get property "webServer" without inject`。需用 `ctx.get('webServer')` 自行实现 RPC 信封 |
| **模型注册表约束** | 推理强度由各模型声明，目录里 `reasoning.efforts` 为空的提供方不显示强度入口 |
| **角色隔离** | Team 按会话隔离，Lead 只能管理自己会话的队友 |

## 七、待用户决策

1. **做不做**：是否按推荐方案实施（新增 `spawn_teammate_as` 工具 + 角色路由映射）
2. **范围**：只做「模型/强度」（小，约 300 行）还是含「persona + 工具面」（中，需接 agentPreset）
3. **中文名**：接受「面板显示拼音、参数可用中文」吗？（宿主限制，无法做到面板显示中文）

## 八、引用的社区资料

- [Chruix/dsh-team-model](https://awesome-dsh-plugin.com/zh/p/Chruix/dsh-team-model) —— 最完整的参考实现，含 RPC 坑
- [SeverusZh/dsh-plugin-subagent-director](https://blog.yeyupiaoling.cn/article/1787944949892?lang=zh-tw) —— 角色模板 + displayName 匹配
- [dsh-subagent-model](https://blog.yeyupiaoling.cn/article/1790358339609?lang=zh-cn) —— 子代理档位 + 官方预设同源
- [拆解 DeepSeek Harness 的 Cordis 架构](https://blog.csdn.net/gedonshen/article/details/163827889) —— 工具遮蔽算法
- [Cordis 插件系统与挂载方式](https://deepseek.csdn.net/6a7eb32d662f9a54cb9ca169.html) —— 宿主层 vs 会话层
