# 00 · 阶段 0 审计汇总与最小开发范围（P0-10 · Gate 签署件）

> 编制：八戒 ｜ 日期：2026-11-10 ｜ 依据：`docs/audit/01`–`09` 共 9 份实测证据
> **用途：项目负责人逐项签署后，才允许进入阶段 1 编码。**

---

## 1. 一句话结论

DSH 原生已经覆盖了「团队/项目/任务/会话/权限/统计/工具」的**全部底座**，本项目真正要自己写的只有 **3 件事**：角色注册表（含别名）、本机 CLI 探测、派单编排；另加 1 件被明确排到 0.2.0 的 UI。外部 CLI 的**执行通道不需要自研**——装官方 provider bundle 即可。

---

## 2. A 类 · DSH 原生已满足（直接复用，**不写代码**）

| 能力 | 采用的官方包 / API | 关键约束 |
| --- | --- | --- |
| 项目与目录 | `dsh-workspace`（`ctx.workspaceRegistry`）、`dsh-working-directory` | `WorkspaceId` 是 uuid，**不能当路径**；取项目根用 `exec.agent.session.header.cwd` |
| 会话与轨迹 | `dsh-session*`、`dsh-client-ui-trajectory` | 不建平行历史系统 |
| 后台任务 / 取消 / 完成通知 | `dsh-jobs`、`dsh-tool-jobs`、`ctx.jobs.start({kind,label,owner,run})` | 发布 id 后用 task-owned 取消信号 |
| Todo | `dsh-tool-todo` | 名字不叫 `dsh-todo`，别找错 |
| 角色身份与提示词 | `dsh-persona`、`dsh-agent-preset`、`dsh-skill`、`dsh-agent-instructions` | 只做静态身份；**没有**"名称/别名→通道"的可变映射 |
| Token / Usage | `dsh-token-meter` | 外部 CLI 用量不进它，需单独标来源 |
| 权限 / 审批 / 沙箱 | `dsh-permission-presets`、`dsh-user-approval`、`dsh-sandbox*` | ⚠️ **不会自动约束外部子进程，必须显式 `sandbox.confine()`**（P0-08） |
| 工具注册 / MCP | `dsh-tools`（`defineTool` + `ctx.tools.register`）、`dsh-mcp-client` | 注册即 effect，dispose 自动注销 |
| 插件管理 / 配置 | `dsh-plugin-manager`、`dsh-settings`、`dsh-config-editor` | 配置落 profile `cordis.patch.yml`；写用 `ctx.get('configEditor').edit(...)` |
| 子进程原语 | `dsh-subprocess`（`resolveExecutable`、凭据擦除、进程树终止）、`dsh-native-command`（区分 `ENOENT`） | 不重写 PATH 解析与进程回收 |
| 派单 seam | `ctx.subagents`、`dsh-tool-subagent`、`dsh-tool-subagent-control` | 前台/后台、cwd、深度上限都有 |

## 3. B 类 · 官方插件/配置可满足（**装/配，不写代码**）

| 能力 | 做法 | 状态 |
| --- | --- | --- |
| 外部 CLI 执行通道 | 安装 npm 上的公开 bundle：`@deepseek-ai/dsh-subagent-acp`（配 `command` 驱动任意 ACP CLI）、`@deepseek-ai/dsh-subagent-codex`、`@deepseek-ai/dsh-subagent-claude-code`；`next` 标签 = `0.2.2-rc.1` | 未安装；**P2 前置任务先做隔离 profile 安装实测** |
| Agent Teams | 官方 experimental 包宿主已附带，profile 未挂 | 已决：**第一版不启用**（05） |

> ⚠️ 重要：官方 provider **不解析本机 PATH 的 codex/claude**，用它自带的 pinned CLI。产品文案不能说"用你装的 codex"。

## 4. C 类 · 真缺，必须自研（**只有这 3 项 + 1 项后置**）

| # | 自研项 | 为什么原生不够（证据） | 最小实现 | 风险 |
| --- | --- | --- | --- | --- |
| C1 | **角色注册表 + 别名解析** | `dsh-persona`/`dsh-agent-preset` 是"一个 preset 一个静态身份"，没有"名称或别名 → 通道+参数+cwd+模型"的可变映射，也没有别名归一化与冲突消解（03 §5） | 一张角色表 + 别名索引 + 冲突拒绝；提示词复用 persona | 低 |
| C2 | **本机 CLI 探测** | 官方明确「production performs no separate runtime version probe」「probes no version or authentication」，且 provider 不回退本机 PATH（03 F2）。现有最接近的只有 `resolveExecutable` 与 `runNativeCommand` 两个原语 | 多源解析（PATH → Appx 包 → npm 全局 → 常见目录 → 手工）+ `--version` 试跑 + 缓存与失效 + 状态展示 | 中：商店应用路径随升级漂移（R1） |
| C3 | **派单编排薄层** | 原生没有"角色名 → 选哪条通道 → 用什么参数"的路由层；也没有跨异构 CLI 的统一编队（03 §5） | 角色 →（探测结果 + 通道）→ 调 `ctx.subagents`；写任务串行、只读可并行；权限档位映射到**显式 confine + CLI 原生 flag** | 中高：权限边界只能标"部分保证"（08） |
| C4 | 设置页 UI | 官方**没有任何客户端消费** `autoGenerate`，每个插件的配置页由它自己的 companion 包注册（07 §3.6 + 官方 `ui-settings-plugins` README） | **第一版不做**；配置走 `cordis.patch.yml` + `.meetingstone.json`，用 `meetingstone_list_roles` 回显 | 已排 0.2.0 |

---

## 5. 最终最小架构（修正后）

```
DeepSeek Harness Host（全部复用，零改动）
  ├─ Workspace / Session / Jobs / Todo / Token Meter / Approval / Sandbox
  ├─ ctx.subagents ──► 官方 provider bundle（acp-cli / codex / claude-code / in-process）
  └─ dsh-meetingstone（本项目，薄层）
       ├─ Config（Schemastery，落 profile cordis.patch.yml）
       ├─ 项目配置读取（.meetingstone.json，项目根来自 session.header.cwd）
       ├─ C1 角色注册表 + 别名解析
       ├─ C2 本机 CLI 探测（多源 + 版本 + 缓存）
       ├─ C3 派单编排 → ctx.subagents
       └─ 工具：meetingstone_list_roles / _dispatch / _cli_status（/_get_task、_cancel_task 若原生未覆盖）
```

---

## 6. 阶段 0 被推翻的结论（诚实记录，共 9 条）

| # | 原说法 | 实测真相 | 谁推翻 |
| --- | --- | --- | --- |
| 1 | 桌面版版本 44.7.0 | 那只是 Electron 外壳；DSH 包版本 `0.2.2-rc.1` | 沙僧 |
| 2 | Agent Teams 未安装 | 宿主已随附 `@deepseek-ai/dsh-experimental-agent-team@0.2.2-rc.1`，只是 profile 未启用 | 沙僧 |
| 3 | 没有 dsh CLI | 存在 `resources\runtime\cli\bin\dsh.cmd`，只是不在 PATH | 沙僧 |
| 4 | pnpm 直接可用 | 系统 node v20.16.0 跑内置 pnpm 会崩（`node:sqlite`），必须用内置 node 24.21.0 | 沙僧 |
| 5 | 官方示例 `engines.dsh` 在 rc 上不匹配 | 实测能装：DSH 比较带 `includePrerelease: true`；被拒的是写成 `0.2.2` | 悟空 |
| 6 | Codex 未安装 | 装在商店应用包内，`codex-cli 0.167.0-alpha.3.2`，只是不在 PATH | 用户指出 → 我复核 |
| 7 | `ui-settings: enabled: false` 是设置面板被禁用 | 是插件 Config 里的「开发者工具」偏好，设置面板由 `ui-settings-general` 提供 | 沙僧 |
| 8 | Config 能自动生成设置表单 | 无任何随包客户端消费 `autoGenerate`；必须自带 client half | 沙僧 → 我独立复核 |
| 9 | 外部 CLI provider 未安装/不可用 | 确实没装，但在 npm 上**是公开可安装 bundle**，`acp` 版就是"配 command 驱动任意 CLI" | 我 |

> 这 9 条里 3 条是**我**判错的（6/7/9 的前置判断）、2 条是小白的、其余是初始文档的。团队复核机制起作用了。

---

## 7. Gate 签署清单（请逐项确认）

| # | 待签项 | 建议结论 |
| --- | --- | --- |
| G1 | A 类 11 项复用清单 | ✅ 全部直接复用，不重造 |
| G2 | B 类：第一版要求用户安装 provider bundle（至少 `dsh-subagent-acp`） | ✅ 同意，作为安装文档的一部分 |
| G3 | C 类 3 项自研范围（角色表/CLI 探测/派单编排） | ✅ 只做这 3 项 |
| G4 | C4 设置页 UI 排到 0.2.0 | ✅ 已决（DD5） |
| G5 | 权限承诺边界：只读=条件化；项目写入=标 partial/无保证；CodeBuddy=无保证；受限命令=未验证 | ✅ 按 08 §8 措辞，不夸大 |
| G6 | 产品文案不得写"外部任务出现在原生 UI" | ✅ 按 06 结论 |
| G7 | 命名 `dsh-meetingstone` + 与 WOW 插件无关的声明 | ✅ 已决（DD6） |
| G8 | 进入阶段 1 的首批任务 | P1-01 仓库骨架 → P1-02 构建链（锁内置 node）→ P1-03 空插件加载 |

---

## 8. 阶段 1 开工前置（已就绪）

| 前置 | 状态 |
| --- | --- |
| 仓库骨架 + 9 份审计证据 | ✅ 已 commit |
| 构建运行时（内置 node 24.21.0 + pnpm 11.28.5） | ✅ 已确认路径 |
| 打包规范（`dsh.bundle.patch` + `engines.dsh`） | ✅ 已实装验证 |
| 幂等安装路径（`dsh.cmd plugin add`） | ✅ 已实装验证 |
| provider bundle 可用性 | ⏳ P2 前必须实测安装（R14） |

---

## 9. 残留风险（阶段 1 期间需盯）

| 风险 | 处置 |
| --- | --- |
| DSH 走 nightly 通道，API 漂移 | 锁 peer 版本；`engines.dsh` 已定；阶段 4 再核验 |
| Windows 沙箱 `enforcement=partial` + 硬链接越界 | 文案不承诺"绝不修改项目外路径"；代码里显式 confine + 失败关闭 |
| 商店应用 CLI 路径随升级漂移 | 运行时解析，不写死；缓存带失效 |
| Codex/Claude provider 用自带 CLI（非本机） | 角色卡明示执行通道；安装文档写清 |
| 多 Worker 并行合回冲突 | 文件域切分 + 主 Agent 统一整合 |
