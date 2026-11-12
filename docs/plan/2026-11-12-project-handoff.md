# MeetingStone 项目交接文档

> 生成时间：2026-11-12 17:45
> 当前版本：`dsh-meetingstone@0.1.0-alpha.11`（已安装、已验证）
> 代码状态：`main` 干净，测试 578 / 577 pass / 1 skip，门禁 8 PASS
>
> 注意：本文件是**项目交接**。`docs/handoff.md` 是另一份东西 ——
> 那是「结构化结果的六段式契约」产品文档，两者不要混。

---

## 一、项目是什么

**集合石 / MeetingStone** 是 DSH（DeepSeek Harness）的第三方插件，解决一个问题：
**把任务按角色派给不同的 CLI 模型去执行，并按角色配置各自的模型与提示词。**

和 DSH 原生能力的区别：

| 能力 | DSH 原生 subagent | MeetingStone |
| --- | --- | --- |
| 指定模型 | 需 `modelSelection` 白名单 | ✅ 角色配置里直接写 |
| 角色提示词（persona） | 需 Agent Preset | ✅ 角色配置里直接写 |
| 外部 CLI（Codex/CodeBuddy/Claude） | 需逐个装 provider | ✅ 4 个 CLI 统一编排 |
| 执行记录 | 无 | ✅ `.meetingstone/runs/` |
| worktree 隔离 | 无 | ✅ 每个任务独立工作树 |
| 中途插话/续聊 | 仅进程内 | ✅ 新增，见下 |

---

## 二、当前能力清单（9 个工具）

| 工具 | 作用 |
| --- | --- |
| `meetingstone_list_roles` | 列出角色及其可用性 |
| `meetingstone_dispatch` | 按角色派单（核心） |
| `meetingstone_get_task` | 查单个任务状态 |
| `meetingstone_wait` | 等一组任务到终态 |
| `meetingstone_list_runs` | 列出最近执行记录 |
| `meetingstone_cancel_task` | 取消任务 |
| `meetingstone_get_run_artifact` | 读任务完整产出 |
| `meetingstone_cli_status` | 查本机 CLI 安装状态 |
| **`meetingstone_steer_task`** | **中途插话 / 续聊（本轮新增）** |

### `meetingstone_steer_task` 详解

**已真机验证通过**（2026-11-12 17:40，childId `b336d56d`）：

```
派单（统计 5 个文件）
  → Step 1 完成、Step 2 未启动的窗口内插话
  → 子 agent 在下一个 step 边界消费消息
  → 改执行路径：只统计 2 个文件就停
  → 实测 steer.js 未被统计
```

子 agent 自己的原话（来自 run 记录）：

> 插话在下一个 step 边界被消费，并以新指示覆盖原计划，而非排队到任务终态才处理，
> 说明进程内收件箱投递为真插话。

**两条路径，回执 `mode` 字段会明确区分**：

| mode | 适用通道 | 语义 |
| --- | --- | --- |
| `steer` | 进程内（`spawn`） | **真插话**，消息进收件箱，下个 step 边界处理，上下文完整保留 |
| `restart-with-output` | 外部 CLI | **不是真插话**：停掉原任务 + 带上已有产出重开 |

**为什么外部 CLI 不行**（实测数据）：

| Provider | `prepareContinuable` | 能续聊 |
| --- | --- | --- |
| `spawn`（进程内） | ✅ | ✅ |
| `dsh-subagent-acp` | ❌ `capabilities.agentOptions: false` | ❌ |
| `dsh-subagent-codex` | ❌ 连 `sessionId` 都不引用 | ❌ |
| `dsh-subagent-claude-code` | ❌ 同上 | ❌ |

它们每次都是全新进程、全新会话，宿主 `coldResume` 会抛 `NOT_RESUMABLE`。

---

## 三、关键架构决策（含踩过的坑）

### 3.1 计费：必须显式下发 `agentOptions`

**曾发生真实资损事故**：宿主的 `resolveChildAgentOptions(parent, requested, depth)` 实现是
`{...父会话路由, ...requested}`。不传 `requested` → 子会话静默继承父会话模型 →
角色配置的模型完全不生效，还按父会话的按量计费 provider 扣钱。

- 实测损失：30 分钟 ≈ ¥15（114 次调用 / 63.1M input）
- 修复：`src/dsh/adapter.js` 的 `buildChildAgentOptions()`，in-process 通道显式下发
  `{agentOptions: {provider, model, reasoningEffort}}`
- 外部 CLI **不传**（它们的 `capabilities.agentOptions = false`，传了会撞校验）

### 3.2 `agent/request` 不能改模型路由

网上有些实现说挂 `agent/request` waterfall 覆写 provider/model。**这条路是死的** ——
`dsh-agent-loop` 的 `prepareRequest()` 有硬断言：

```js
if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model)
  throw new Error(`... use agent.model.select() before step preparation`)
```

正确做法：`agent.model.select()`（等价于写一条 durable 的 `model/selection` 事件）。

### 3.3 记录字段：优先读磁盘，不要只用内存视图

`dispatcher.getTask()` 返回的是适配器的 **live 视图**，只有 `status` / `reason`，
**不含 `provider` / `role` / `channel`**。完整字段在 `.meetingstone/runs/*.json` 里。

steer 第一次真机测试就栽在这：明明是 `spawn` 任务，却被判成「无法确认是否支持插话」
（返回 `ROLE_UNKNOWN`）。

修复：优先 `loadPersistedRun()`，内存视图只用来补 `liveStatus`；provider 解析做多源回退
（`provider` → `channel.kind` → `channel.provider` → `kind` → `providerName`）。

### 3.4 安装必须整目录替换

`install-safe.mjs` 原用 `cpSync({force:true})` 做叠加，**只覆盖同名文件、不删除新包里没有的文件**。
后果：插件删掉的模块仍留在已装目录里，排查时误判「删除没生效」
（实测：alpha.6 安装后 B3 删除的 4 个文件仍在磁盘）。

已改为整目录 rm + cp，失败还原备份。

### 3.5 已放弃：Agent Teams 改造

曾做过 `spawn_teammate_as`（alpha.8/9），让 Team teammate 能跑角色模型。
**用户评估后决定放弃，已删除（-1160 行）。**

放弃理由：
- Agent Teams 唯一的独有能力是「队员可续聊/可中途叫醒」
- 但代价是模型、persona、外部 CLI 全部失控
- 那件事已用 `meetingstone_steer_task` 在我们自己的派单路径上做得更好

**Team 面板的硬限制**（无法绕过）：
- 成员名只能是 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`（中文进不去）
- 成员不能改名、不能删除（宿主无 `removeMember`，名字 once-used 永不回收）
- 遗留成员 `sashi` / `route-probe` / `d1-verifier` / `auditor` 会永久留在面板

---

## 四、当前状态

### 4.1 已验证可用

| 项 | 证据 |
| --- | --- |
| 9 个工具全部注册 | 真机工具列表确认（60 个工具中含 9 个 meetingstone） |
| 派单走角色模型 | 43 次调用 100% workbuddy，deepseek-account 零调用 |
| 中途插话（进程内） | childId `b336d56d` 实测改变执行路径 |
| 测试 | 578 tests / 577 pass / 1 skip |
| 发布门禁 | 8 PASS / 0 SKIP |
| 安装 | alpha.11，install-safe PASS |

### 4.2 环境

- 已装版本：`C:\Users\30673\.dsh\profiles\desktop\node_modules\dsh-meetingstone` = `0.1.0-alpha.11`
- 回滚目标：`C:\Users\30673\.dsh\packages\dsh-meetingstone-0.1.0-alpha.10.tgz`
- profile 配置：`C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml`（17 行）
- 角色：唐僧/悟空/八戒/沙僧/小白，全部 `timeoutMs: 3600000`
- 通道：`ch-inprocess`（workbuddy/v4.1-flash）、`ch-acp-kimi`、`ch-acp-hy4free`、
  `ch-acp-flash`、`ch-acp-hy4`、`ch-codex-astra`、`ch-codex-sol`

### 4.3 未验证 / 已知缺口

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 外部 CLI 的 `restart-with-output` | ⚠️ 代码已写，**未真机验证** | 需要一个外部 CLI 任务的实测 |
| ACP 模型接受度 | ⚠️ 未验证 | `kimi-k3.1-pro` / `hy4free` / `hy3` / `glm-5.3-flash` 在高强度下是否被接受，需真实派单 |
| **黄色状态不可达** | 🔴 设计缺口 | `src/gui/host.js:156` 调 `deriveRoleView` 没传 `quota`，`deriveQuota` 恒 `unknown` → 真实角色只有绿/灰 |
| codex 思考强度为空 | ⚠️ | profile 该 provider 行无 `--effort` |
| 压缩阈值 0.5 | ✅ 已在 1M 窗口下生效 | 触发线 50 万，保留约 14 万（`compaction-basic` 行） |
| D1 验收 | 🔴 **未通过** | alpha.6 时 9 通过 / 3 失败 / 3 部分；两个阻塞缺陷已修（alpha.7），但未按 alpha.7+ 复验 |

---

## 五、待办事项

### P0：需要用户手工验证

1. **外部 CLI 的 `restart-with-output` 真机验证**
   - 派一个 CodeBuddy / Codex 任务（选耗时一点的）
   - 趁它跑着调 `meetingstone_steer_task`
   - 确认回执 `mode: "restart-with-output"`，且备注说明「不是真插话」
   - 预期：新 childId 与原 childId 通过 `upstreamChildId` 关联

2. **D1 验收复验**（在 alpha.11 上重跑）
   - 按 `docs/plan/verify/2026-11-13-d1-windows.md` §4 的 U1–U10 目视清单（46 步）
   - 重点确认两个已修缺陷：
     - CLI 选 DeepSeek Harness 时模型下拉**有值**（应显示 `deepseek-v4.1-flash`）
     - 点「刷新能力」**不报错**
     - 全页面**无**「右侧栏」/「本对话角色」误导文案

### P1：代码层面

3. **黄色状态不可达**（设计缺口，非回归）
   - `src/gui/host.js:156` 的 `deriveRoleView` 调用没传 `quota`
   - 需决定：是接上额度查询，还是从三色语义里去掉黄色

4. **ACP 模型接受度验证**
   - 需真实派单到 `ch-acp-kimi` / `ch-acp-hy4free` / `ch-acp-flash` / `ch-acp-hy4`
   - 会消耗外部 CLI 额度，量小

### P2：发布

5. **task-13 D3 发布**
   - 状态：pending，`ready: true`
   - 需要用户明确授权才动
   - 内容：release:check + install:safe + 回滚演练

### P3：清理（可选）

6. 工作树/临时文件已清过一轮（34 个工作树 + hotfix + 2 个 canary profile + 20 个历史 tgz，约 103 MB）
7. `.meetingstone/runs/` 有 100+ 条记录（1.3 MB），保留（这是执行记录，不是垃圾）

---

## 六、关键文件索引

| 路径 | 作用 |
| --- | --- |
| `src/index.js` | 插件入口，`apply()` 装配一切 |
| `src/dsh/register.js` | 9 个工具的定义与注册 |
| `src/dsh/adapter.js` | 派单适配器；**计费修复在 `buildChildAgentOptions()`** |
| `src/dsh/steer.js` | **本轮新增**：插话/续聊的通道能力判定与错误翻译 |
| `src/dispatch/dispatcher.js` | 派单编排 |
| `src/context-replay.js` | 上下文重放（非真续聊，已明确标注） |
| `src/cli/capabilities.js` | CLI 能力目录（4 CLI × 模型 × 强度） |
| `src/client/index.js` | 浏览器半：设置页、角色管理 |
| `src/gui/host.js` | Host 半：Typert remote |
| `scripts/install-safe.mjs` | 安全安装（canary + 整目录替换 + 自动回滚） |
| `scripts/release-check.mjs` | 发布门禁（8 项） |

### 关键文档

| 路径 | 内容 |
| --- | --- |
| `docs/release/0.1.0-alpha.11-checklist.md` | 当前版本发布清单 |
| `docs/plan/2026-11-12-team-role-feasibility.md` | Agent Teams 可行性研究（结论：不做） |
| `docs/plan/2026-11-12-steer-resume-evaluation.md` | 插话/续聊评估（结论：做） |
| `docs/plan/verify/2026-11-13-d1-windows.md` | D1 验收报告（不通过） |
| `docs/plan/verify/2026-11-12-alpha6-audit.md` | 代码审计 |

---

## 七、纪律（血泪教训）

1. **永远不要唤醒创建于 2026-11-12 15:44 之前的 teammate**
   它们固化在 `deepseek-account` 路由上，唤醒即按量计费。实测烧掉 31 次调用 / 30.8 万 input / 1603 万 cacheRead。

2. **不要给下面这几个成员发消息**（同一条：会唤醒并扣费）：
   `sashi` / `xiaobai` / `bajie` / `route-probe` / `d1-verifier` / `auditor`

3. **发版只走 `install:safe`**，禁止手工 remove/add 插件，禁止手工改 profile

4. **不要在任务运行中重启 DSH**

5. **测试必须先红后绿**：每条新测试都要验证「修复前会失败」，否则是假测试

6. **不要只看内存视图就下结论**：完整字段在磁盘的 run 记录里

7. **改文件用 edit/read 工具，不要用 PowerShell 写中文**
   PowerShell 控制台的 GBK 渲染会干扰，实测把 `capabilities.js` 的中文写坏过一次

---

## 八、下一步建议

**最小闭环**：用户在 alpha.11 上跑一遍 D1 复验 + 外部 CLI 的 steer 验证，通过后发正式版。

**技术债优先级**：
1. 黄色状态不可达（影响三色语义的完整性）
2. ACP 模型接受度（影响用户能否放心用 Kimi/GLM 通道）

**不建议再做**：Agent Teams 相关任何改造（已论证价值不足）。
