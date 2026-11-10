# 03 · DSH 原生能力复用矩阵（P0-03）

| 项 | 内容 |
| --- | --- |
| 采集时间 | 2026-11-10 14:01 +0800（asar 提取 / GitHub 取用 / 命令实测集中在此刻） |
| 采集人 | xiaobai（小白） |
| 任务 | P0-03 原生能力复用矩阵；阶段 0，只产出审计证据，不写产品代码 |
| 网络状态 | **可用**。`api.github.com` / `raw.githubusercontent.com` 均 HTTP 200 |
| 依据来源 | ① 本机 `app.asar` 内 `dsh/desktop-runtime.json` 的 `sharedPackages[]` 全量清单（329 项）；② DSH 官方 GitHub `docs/subsystems/*.md`、`packages/**/README.md`、`.agents/notes/**` 笔记；③ 本机 profile 配置只读（承接 A1/A2） |
| ref / 版本 | 官方文档统一 `ref=master` @ `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（commit 2026-11-04，`Merge release/dsh-0.2.2 (0.2.2-rc.1) into master`）；本机 `release.version = 0.2.2-rc.1`、`hostProtocolVersion = 4`、`nodeVersion = 24.21.0`、`pnpmVersion = 11.28.5`。文档/运行时版本一致 |
| Clean-room 纪律 | 本次**未读取** `dsh-cliworker-now` 的任何实现源码，也未读其包内容；所有结论来自宿主共享包清单、DSH 官方文档与本机 profile 配置。符合 `docs/CLEAN_ROOM.md` 第 2/3 节 |

> 结论标签：**【复用】**=包随宿主附带且有公开依据，可直接复用；**【配置】**=包/文档都在，但默认不启用或需显式配置；**【自研】**=能力缺失，需自己写；**【复用+自研】**=核心 seam 可复用、缺口需自研。凡未在本次取用中确认的一律写「未验证」。

---

## 0. 取证方法与全量清单

### 0.1 取 `sharedPackages` 的方式（可复现）

`desktop-runtime.json` 位于 `C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 内 `dsh/desktop-runtime.json`，物理大小 **4,942,461 B**，在 asar 文件表中 `offset = "0"`、`size = 4942461`（紧跟 header 之后）。解析步骤：

1. 读 asar 前 8 字节，`readUInt32LE(4)` 得 pickle size = `5748132`；
2. 从文件 offset `8` 读 `5748132` 字节为 headerBuf，在其中找 `{"files":` 起始位置（实测 = 8），`JSON.parse` 得文件表；
3. 数据区起点 = `8 + 5748132 = 5748140`；按 `files.dsh.files['desktop-runtime.json'].offset = "0"` 读 `4942461` 字节，解析为合法 JSON（实测成功）；
4. 取 `sharedPackages`，实测 **329** 项，每项键为 `name` / `version` / `path`（样本：`{"name":"@deepseek-ai/cordis","version":"4.1.0","path":"node_modules/@deepseek-ai/cordis"}`）。

> 与 A1:2.2 用相同 asar 头解析法、相同 offset 结论，交叉一致。全量清单已在本机临时目录导出核对，本文只摘录相关包，包名/版本逐项取自该 JSON，未手工编造。

### 0.2 版本分布（真实性佐证）

| 版本 | 项数 | 说明 |
| --- | --- | --- |
| `0.2.2-rc.1` | 321 | 全部 DSH 官方包，与宿主 release 版本一致 |
| `1.1.0` | 3 | `cordis-plugin-group` / `cordis-plugin-include` / `cordis-plugin-loader` |
| `1.2.0` | 1 | `cordis-plugin-timer` |
| `4.1.0` | 1 | `@deepseek-ai/cordis` |
| `1.9.0` | 1 | `@deepseek-ai/cosmokit` |
| `0.1.2` | 1 | `@deepseek-ai/node-addon-system` |
| `3.19.0` | 1 | `@deepseek-ai/schemastery` |

> 除下文特别标注，所有 `@deepseek-ai/dsh-*` 包版本均为 **`0.2.2-rc.1`**。

### 0.3 来源编号

| 编号 | 路径 / 命令 | 采集日期 |
| --- | --- | --- |
| L0 | `app.asar` → `dsh/desktop-runtime.json` → `sharedPackages[]`（本机，只读） | 2026-11-10 |
| L1 | `C:\Users\30673\.dsh\profiles\desktop\package.json` / `cordis.yml` / `cordis.patch.yml`（本机，只读） | 2026-11-10 |
| L2 | 本机命令实测（`node` 解析 asar、版本分布统计） | 2026-11-10 |
| G0 | GitHub `git/trees/master?recursive=1`（用于定位 README / subsystem 路径） | 2026-11-10 |
| G1 | `docs/subsystems/*.md`（官方 subsystem 参考页） | ref=master @ `fcc0ad4` / 2026-11-04 / 采集 2026-11-10 |
| G2 | `packages/**/README.md`（包级契约） | 同上 |
| G3 | `.agents/notes/archived/**` 实现决策笔记 | 同上 |
| A1 | 仓库内 `docs/audit/01-environment.md`（P0-01 实测） | 2026-11-10 |
| A2 | 仓库内 `docs/audit/02-plugin-spec.md`（P0-02 核验） | 2026-11-10 |

### 0.4 重要口径：随宿主附带 ≠ 已在当前 profile 启用

- 「随宿主附带」指包出现在 L0 `sharedPackages`（物理在宿主 asar / 共享 `node_modules`，由宿主解析），第三方包才落在 profile `node_modules`（A1:3.2）。
- 是否真正挂载生效，取决于 profile 的 `dsh.profile.bundles` 顺序 + patch 行（A2:1.4）。本机 L1 的 7 个 bundle 为：`dsh-base`、`dsh-web-app`、`dsh-experimental-terminal-bundle`、`dsh-experimental-tool-worktree`、`dsh-remote-plugin`、`dsh-experimental-session-titles-bundle`、`dsh-cliworker-now`。
- 本文「随宿主附带 = 是」只说明**可被解析复用**，不承诺当前已启用；启用与否另在结论列备注。

---

## 1. 主矩阵（11 个能力域一览）

| # | 能力域 | 代表包（版本 `0.2.2-rc.1`） | 随宿主附带 | 公开 API / README 依据 | 处理结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | Agent Teams | `dsh-experimental-agent-team` / `-profile` / `-tool-agent-team` / `-client-ui-agent-team` | 是（4 个） | 有：`docs/subsystems/agent-team.md` · `packages/team/agent-team/README.md` | **【配置】** 默认关闭，需显式启用 |
| 2 | Subagent / Provider | `dsh-subagent` / `dsh-tool-subagent` / `dsh-acp` / `dsh-sdk-*` | 部分 | 有：`docs/subsystems/subagent.md` · `packages/subagent/README.md` · G3 provider 笔记 | **【复用+自研】** 内核复用；4 个外部 CLI provider **不在**共享清单 |
| 3 | Workspace / 项目 | `dsh-workspace` / `dsh-working-directory` / `dsh-client-ui-workspace` | 是（9 个） | 有：`docs/subsystems/workspace.md` · `packages/session/working-directory/README.md` | **【复用】** |
| 4 | Jobs / Todo / 任务 UI | `dsh-jobs` / `dsh-tool-jobs` / `dsh-tool-todo` / `dsh-client-ui-jobs` | 是（12 个） | 有：`docs/subsystems/jobs.md` · `todo.md` · `packages/jobs/jobs/README.md` | **【复用】** 无 `dsh-todo` 包，能力由 `dsh-tool-todo` 承载 |
| 5 | Persona / Preset / Skills | `dsh-persona` / `dsh-agent-preset` / `dsh-skill` / `dsh-agent-instructions` | 是（16 个） | 有：`packages/preset/persona/README.md` · `docs/subsystems/skills.md` · `system-prompt.md` | **【复用】** 无 `dsh-preset` 包，由 `agent-preset*` 承载 |
| 6 | Session / 轨迹 | `dsh-session` / `dsh-session-format-*` / `dsh-client-ui-trajectory` | 是（38 个） | 有：`docs/subsystems/session.md` · `session-projection.md` · `compaction.md` | **【复用】** 无 `dsh-trajectory` 包，仅 `client-ui-trajectory` |
| 7 | Token Meter / Usage | `dsh-token-meter` / `dsh-session-stats` / `dsh-session-telemetry` | 是（6 个） | 有：`docs/subsystems/token-meter.md` | **【复用】** |
| 8 | 权限 / 审批 / 沙箱 | `dsh-user-approval` / `dsh-permission-presets` / `dsh-sandbox*` | 是（12 个） | 有：`docs/subsystems/approval.md` · `sandbox.md` · `permission-presets.md` | **【复用】** 无 `dsh-permission` 单独包 |
| 9 | 插件管理 / 设置 | `dsh-plugin-manager` / `dsh-settings` / `dsh-config-editor` / `dsh-client-ui-settings-*` | 是（74 个） | 有：`packages/boot/plugin-manager/README.md` · `docs/subsystems/settings.md` · `slots.md` | **【复用】** 设置页当前受 `ui-settings enabled:false` 阻塞（A2:4.2） |
| 10 | 工具注册 / MCP | `dsh-tools` / `dsh-tool-*` / `dsh-mcp-client` / `dsh-mcp-resources` | 是（30 个） | 有：`docs/subsystems/tools.md` · `mcp.md` · `packages/core/tools/README.md` | **【复用】** MCP server 需 opt-in；无 `dsh-mcp-server` / `dsh-mcp-manager` |
| 11 | 本机 CLI 探测 / 健康检查 | 仅 `dsh-subprocess` / `dsh-native-command` 可作原语 | 部分（原语在，服务缺） | 部分：`docs/subsystems/subprocess.md` · `packages/util/native-command/README.md`；G3 笔记明确「不做探测」 | **【自研】** 官方明确不做运行时版本/可用性探测 |

**统计**：可直接复用 **8** 项（3/4/5/6/7/8/9/10）；需配置启用 **1** 项（1）；存在缺口 **2** 项（2 部分缺、11 完全缺）。

---

## 2. 逐域定性详表

> 下列各表包名均取自 L0，除标注外版本统一 `0.2.2-rc.1`。「依据」列给官方路径（G1/G2/G3），结论列用第 0 节标签。

### 2.1 域 1 · Agent Teams

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-experimental-agent-team` | 0.2.2-rc.1 | `packages/team/agent-team/README.md`：给已有 subagent 树加**持久化共享任务板**（CAS 任务所有权、`blockedBy` DAG、`writeScopes` 建议路径前缀）；`docs/subsystems/agent-team.md` 记录 `TeamTaskSnapshot` / `revision` | 【配置】 |
| `dsh-experimental-agent-team-profile` | 0.2.2-rc.1 | 包存在；`docs/subsystems/agent-team.md` 覆盖类型。**该包的独立 README 未在本次取用中找到，API 未验证** | 【配置】 |
| `dsh-experimental-tool-agent-team` | 0.2.2-rc.1 | `packages/team/tool-agent-team/README.md`：暴露 Team 任务工具；README 明确「最小配置 = 同时挂 `dsh-agent-team` + `dsh-tool-agent-team`」 | 【配置】 |
| `dsh-experimental-client-ui-agent-team` | 0.2.2-rc.1 | `packages/client/ui-agent-team/README.md` 存在（G0 路径）；本次未取内容，**UI API 未验证** | 【配置】 |

**关键启用条件（G2 `packages/team/agent-team/README.md`）**：新 Session（含普通 fork）默认 **Team mode off**；需在 root Session 的模型/推理菜单选 "Use Agent Teams"，或配 `defaultEnabled: true`；选择持久化为 `team/mode`。官方明确「**standard bundle keeps this option off**」。本机 L1 的 `bundles` 中**没有**任何 agent-team bundle → 当前 profile 未启用 Team。

> 注：仓库内包目录为 `packages/team/agent-team`（README 标题写 `@deepseek-ai/dsh-agent-team`），而 L0 清单里是带 `experimental-` 前缀的命名。两者是否为同一构建产物**未验证**，本文以 L0 实测包名为准。

### 2.2 域 2 · Subagent / Provider（含四个 provider 核验）

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-subagent` | 0.2.2-rc.1 | `docs/subsystems/subagent.md`：`ctx.subagents` 统一激活 API，`startActivation` / `prepareContinuable` / `start`，`SubagentCapabilities` 校验选项，可选 `cwd`（相对父当前目录解析） | 【复用】 |
| `dsh-subagent-fork-in-process` | 0.2.2-rc.1 | 进程内本地子代理 provider（fork 共享父能力） | 【复用】 |
| `dsh-subagent-spawn-in-process` | 0.2.2-rc.1 | 进程内本地子代理 provider | 【复用】 |
| `dsh-tool-subagent` | 0.2.2-rc.1 | `packages/subagent/tool-subagent/README.md`：给 agent 一个具名委派工具，`toolName` 区分实例，支持 `cwd`、前台/后台（Job）、子 preset、深度上限；「工具存在期与 provider 一致」 | 【复用】 |
| `dsh-tool-subagent-control` | 0.2.2-rc.1 | `packages/subagent/tool-subagent-control/README.md` 存在；控制/收件箱等待 | 【复用】 |
| `dsh-acp` / `dsh-acp-app` | 0.2.2-rc.1 | `packages/acp/acp/README.md`：ACP（Agent Client Protocol）自动化服务端，JSON-RPC stdio，供外部进程驱动 DSH agent | 【复用】 |
| `dsh-sdk-app` / `dsh-sdk-minimal` / `dsh-sdk-protocol` / `dsh-sdk-jsonrpc-server` | 0.2.2-rc.1 | `packages/sdk/README.md`：换行分隔 JSON-RPC 协议 + TS client/server，让另一进程驱动完整 Harness runtime | 【复用】 |

**四个 provider 是否在（任务点名核验）——精确结果**：

| provider | 仓库内包路径（G0） | 是否在 L0 `sharedPackages` | 说明 |
| --- | --- | --- | --- |
| `codex` | `packages/subagent/subagent-codex/package.json` | **不在** | 默认注册名 `codex`，用 pinned `@openai/codex@0.153.4` 自带 wrapper 起 `app-server --stdio`；**不解析/回退主机 PATH 的 `codex`** |
| `claude-code` | `packages/subagent/subagent-claude-code/package.json` | **不在** | 默认名 `claude-code`，用 `@anthropic-ai/claude-agent-sdk@0.3.263` 自带 CLI；**不解析/回退主机 `claude`** |
| `acp` | `packages/subagent/subagent-acp/package.json` | **不在** | `packages/subagent/subagent-acp/README.md`：把任务委派给子进程里的 ACP agent，需配 command |
| `dsh-sdk` | `packages/subagent/subagent-dsh-sdk/README.md` | **不在** | `packages/subagent/subagent-dsh-sdk/README.md`：每次委派起一个全新 Harness 子进程，配 `dshBin` / `profile` / `patches` |

> L0 里只有协议/服务端层（`dsh-acp*` / `dsh-sdk-*`）与进程内 provider（`*-in-process`），**四个外部 CLI/进程 provider 包一个都不在**本机共享清单。这不是遗漏：G3 `.agents/notes/archived/architecture/2026-08-10-product-subagent-providers-in-shared-host.md:16` 明确「production `dsh-base` **neither depends on nor mounts them**；A Profile that opts in installs the selected provider Bundle」。即它们是**独立可安装 Bundle**，需 Profile 显式安装。

**G3 关键原文（`.agents/notes/archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md`）**：
- `:16` 「two sibling one-shot provider packages whose default registry names are `codex` and `claude-code`」；
- `:18` 所有权链：`configured tool → dsh-tool-subagent → ctx.subagents → product provider → product process`，`ctx.jobs`/`dsh-tool-jobs` 管 Job，`dsh-subprocess` 管凭据擦除与进程树终止；
- `:38` 「The provider **neither resolves nor falls back to a host `codex`**」；`:52` 「The provider **does not resolve or fall back to a host `claude`**」；
- `:96` 「**production performs no separate runtime version probe**」；
- `2026-08-10...md:20` 「Profile loading creates no product state, **probes no version or authentication**」「**Neither provider consults or falls back to a host product command**」。

**结论**：内核 seam + 进程内 provider + 派单工具 **【复用】**；四个外部 CLI provider **缺失**，且官方刻意不与本机 PATH 里的 codex/claude 对接 → 若要「按角色派给不同本机 CLI」，需自研或显式安装 provider Bundle（见第 4 节）。

### 2.3 域 3 · Workspace / 项目

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-workspace` | 0.2.2-rc.1 | `docs/subsystems/workspace.md`：`ctx.workspaceRegistry` = 一个目录的持久记录；**`WorkspaceId` 是生成的 uuid，不是路径**；`path` 用 `fs.realpath` 规范化后作为唯一性判据；对模型不可见（无 tool / 无 prompt / 无 session event） | 【复用】 |
| `dsh-workspace-changes` | 0.2.2-rc.1 | `packages/deliverables/workspace-changes/README.md` 存在 | 【复用】 |
| `dsh-working-directory` | 0.2.2-rc.1 | `packages/session/working-directory/README.md`：改一个 Session 的 cwd，选择可重放、进用户上下文；目录消失时回退原项目；已有进程保留自己的目录 | 【复用】 |
| `dsh-tool-working-directory` | 0.2.2-rc.1 | `packages/session/tool-working-directory/README.md` 存在（G0） | 【复用】 |
| `dsh-tool-workspace-dependencies` | 0.2.2-rc.1 | `packages/skill/tool-workspace-dependencies/README.md` 存在（G0） | 【复用】 |
| `dsh-util-workspace-path` | 0.2.2-rc.1 | 包存在，公开文档未找到，API 未验证 | 【复用】 |
| `dsh-api-workspace-controller` / `dsh-api-workspace-files` | 0.2.2-rc.1 | `packages/api/workspace-controller/README.md` / `workspace-files/README.md` 存在（G0） | 【复用】 |
| `dsh-client-ui-workspace` | 0.2.2-rc.1 | `packages/client/ui-workspace/README.md` 存在（G0） | 【复用】 |

**「项目目录怎么表达」**（G1 `docs/subsystems/workspace.md` + `subagent.md`）：workspace 是「稳定 id → 规范绝对路径 + 显示标题 + 有序 session 归属」的记录；子代理的 `cwd` 相对父 Session 的当前有效目录解析，省略则继承；`dsh-working-directory` 可在会话内改 cwd 但不改已存在进程。→ 直接复用，无需自研目录模型。

### 2.4 域 4 · Jobs / Todo / 任务 UI

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-jobs` | 0.2.2-rc.1 | `packages/jobs/jobs/README.md`：`ctx.jobs` 后台作业注册表，`<kind>-<short-uuid>` id、owner 授权、output ring、`job/registered` / `job/settled` 事件；`docs/subsystems/jobs.md` 定义 `JobStatus = running\|stopping\|completed\|killed\|failed` | 【复用】 |
| `dsh-jobs-local` / `dsh-tool-jobs` / `dsh-client-ui-jobs` | 0.2.2-rc.1 | `packages/jobs/jobs-local/README.md` / `tool-jobs/README.md` / `client/ui-jobs/README.md` 存在（G0） | 【复用】 |
| `dsh-tool-todo` | 0.2.2-rc.1 | `packages/todo/tool-todo/README.md`：`todo_write` 整表替换、`pending`/`in_progress`/`completed` 三态、per-session 归属、`allowParallelInProgress` 必填；`docs/subsystems/todo.md` 定义 `TodoItem` 与 `todo/write` 持久事件 | 【复用】 |
| `dsh-schedule` / `dsh-tool-schedule` / `dsh-client-ui-schedule` | 0.2.2-rc.1 | `docs/subsystems/schedule.md` 存在（G0 路径）；本次未取内容，API 未验证 | 【复用】 |
| `dsh-workflow` / `dsh-workflow-ptc` / `dsh-tool-workflow` / `dsh-client-ui-workflow-run` | 0.2.2-rc.1 | 包存在；公开文档未找到，API 未验证 | 【复用】 |

**命名核验**：L0 中 **`dsh-todo*` 不存在**（只有 `dsh-tool-todo`），但 `docs/subsystems/todo.md` 明确「the durable todo vocabulary **owned by `@deepseek-ai/dsh-tool-todo`**」→ 能力存在，只是包命名不同，`dsh-todo` 不应被当作缺失项。`dsh-agent-team*` 非 experimental 命名亦不存在（见域 1）。

### 2.5 域 5 · Persona / Preset / Skills

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-persona` | 0.2.2-rc.1 | `packages/preset/persona/README.md`：preset 内挂载的可组合行，注册 persona `prefix`/`suffix` 段遮蔽部署默认；`complete` 可让 prefix 成为完整系统提示；**必须挂在 agent scope 内**，全局挂载会与 prompt registry 冲突并 fail loud | 【复用】 |
| `dsh-agent-preset` | 0.2.2-rc.1 | `packages/preset/agent-preset/README.md`：用普通 Cordis YAML 定义一个 Agent 的子插件，声明多个 preset 让 session 选择；编辑只影响后续创建的 Agent | 【复用】 |
| `dsh-agent-preset-registry` | 0.2.2-rc.1 | `packages/preset/agent-preset-registry/README.md`：`default: standard` 等 roster 配置 | 【复用】 |
| `dsh-skill` / `dsh-skill-filesystem` / `dsh-skill-office` / `dsh-skill-badge` / `dsh-tool-skill` | 0.2.2-rc.1 | `docs/subsystems/skills.md`：`ctx.skills` host+per-scope 分层注册表，`SkillProvider.list()` 发现技能，`dsh-tool-skill` 拥有模型可见 `skill` 工具 | 【复用】 |
| `dsh-agent-instructions` | 0.2.2-rc.1 | `packages/context/agent-instructions/README.md`：加载用户全局 + 项目级 `AGENTS.md`/`CLAUDE.md` 指令链，`dsh-base` 默认启用、每链 65,536 B 预算 | 【复用】 |
| `dsh-system-prompt` | 0.2.2-rc.1 | `docs/subsystems/system-prompt.md`：prompt 贡献者注册/排序/作用域/渲染；`AssembleContext` 可 merge-extend | 【复用】 |
| `dsh-client-ui-agent-preset` / `dsh-client-ui-skill` / `dsh-client-ui-permission-presets` | 0.2.2-rc.1 | 对应 `packages/client/ui-*/README.md` 存在（G0） | 【复用】 |

**命名核验**：L0 中**无 `dsh-preset*` 独立包**，能力由 `dsh-agent-preset` / `dsh-agent-preset-registry` / `dsh-permission-presets` 承载。`dsh-experimental-badge-skill-bundle` 在清单内。

> **对 MeetingStone 的边界**：`dsh-persona` + `dsh-agent-preset` 已能表达「一个角色一套 system prompt / 一套工具」，但它们是**静态 YAML 行 + 一个 preset 一个身份**，没有「角色名/别名 → 目标 CLI + 参数 + cwd」的动态映射与别名归一化。见第 5 节。

### 2.6 域 6 · Session / 轨迹

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-session` | 0.2.2-rc.1 | `docs/subsystems/session.md`：Session 是 append-only `SessionEvent` 日志（唯一真相源），LLM history 由日志派生、replay 即重派生；`SessionEventMap` 可声明合并扩展 | 【复用】 |
| `dsh-session-format` / `-catalog` / `-v0-to-v1` … `-v3-to-v4` | 0.2.2-rc.1 | 格式迁移链；`docs/subsystems/session.md`、各 `packages/session/session-format*/README.md`（G0） | 【复用】 |
| `dsh-session-persistence` / `-jsonl` | 0.2.2-rc.1 | `docs/subsystems/persistence.md` 存在（G0）；JSONL 持久化 | 【复用】 |
| `dsh-session-projection` / `-cache` | 0.2.2-rc.1 | `docs/subsystems/session-projection.md` 存在（G0） | 【复用】 |
| `dsh-session-query` / `-sqlite` / `dsh-tool-session-query` | 0.2.2-rc.1 | `docs/subsystems/session-query.md` · `packages/session-query/README.md`（G0） | 【复用】 |
| `dsh-session-title*` / `dsh-experimental-session-titles-bundle` | 0.2.2-rc.1 | `docs/subsystems/session-title.md`（G0） | 【复用】 |
| `dsh-session-stats` / `-telemetry` / `-telemetry-otel` / `dsh-experimental-client-ui-stats` | 0.2.2-rc.1 | `docs/subsystems/session-telemetry.md`（G0） | 【复用】 |
| `dsh-compaction*` / `dsh-session-checkpoint-policy` / `dsh-session-turn-outline` / `dsh-session-reference` | 0.2.2-rc.1 | `docs/subsystems/compaction.md` · `session-reference.md`（G0） | 【复用】 |
| `dsh-client-ui-session` / `dsh-client-ui-trajectory` / `dsh-client-ui-settings-session-log` | 0.2.2-rc.1 | `packages/client/ui-session/README.md` · `ui-trajectory/README.md` · `ui-settings-session-log/README.md`（G0） | 【复用】 |
| `dsh-api-session-controller` | 0.2.2-rc.1 | `packages/api/session-controller/README.md`（G0） | 【复用】 |

**命名核验**：L0 中 **`dsh-trajectory*` 不存在**，只有 `dsh-client-ui-trajectory`（UI 侧）；轨迹数据本身由 `dsh-session*` 日志体系承载。本次未找到独立的 trajectory 服务包，**其 UI API 未验证**；对 MeetingStone 而言「任务轨迹/可见性」更可能落在 `dsh-session` 事件 + `dsh-jobs` 上（见 P0-06）。

### 2.7 域 7 · Token Meter / Usage

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-token-meter` | 0.2.2-rc.1 | `docs/subsystems/token-meter.md`：`TokenMeasurement` 不可变快照（`logRevision` / `baseline` / `surfaceDeltaTokens` / `totalTokens` / `surfaceTokens` / `nodes`），按路由定价；`baseline.kind === 'usage'` 用最近成功 provider 调用锚点，`estimated` 为启发式 | 【复用】 |
| `dsh-session-stats` | 0.2.2-rc.1 | `packages/session/session-stats/README.md` 存在（G0） | 【复用】 |
| `dsh-session-telemetry` / `-otel` / `dsh-host-product-telemetry-otel` | 0.2.2-rc.1 | `docs/subsystems/session-telemetry.md` · `otel.md`（G0） | 【复用】 |
| `dsh-experimental-client-ui-stats` | 0.2.2-rc.1 | 包存在；公开文档未找到，API 未验证 | 【复用】 |

### 2.8 域 8 · 权限 / 审批 / 沙箱

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-user-approval` | 0.2.2-rc.1 | A2 已核 `docs/subsystems/approval.md`：`ctx.approval.request()`，结果闭集 `allowed-once\|rejected\|cancelled\|unavailable`，**fail-closed**；per-session `ask`/`never` | 【复用】 |
| `dsh-permission-presets` | 0.2.2-rc.1 | A2 已核 `docs/subsystems/permission-presets.md`：把 `sandbox/mode` + `approval/policy` 打成命名预设 | 【复用】 |
| `dsh-sandbox` / `-local` / `-policy` / `-windows-acl` | 0.2.2-rc.1 | `docs/subsystems/sandbox.md`：`SandboxMode = read-only\|workspace-write\|danger-full-access`，`enforcement = full\|partial`；`packages/sandbox/README.md`（G0） | 【复用】 |
| `dsh-bash-sandbox` / `dsh-pwsh-sandbox` / `dsh-fs-sandbox` | 0.2.2-rc.1 | `packages/shell/bash-sandbox/README.md` 等（G0） | 【复用】 |
| `dsh-authorization` / `dsh-client-ui-approval` / `dsh-client-ui-permission-presets` | 0.2.2-rc.1 | `packages/client/ui-approval/README.md`（G0） | 【复用】 |

**命名核验**：L0 中**无 `dsh-permission` 单独包**，语义由 `dsh-permission-presets` 承载。本机 Windows 有 `dsh-sandbox-windows-acl`（A1 环境为 win32），与 P0-08 直接相关。

### 2.9 域 9 · 插件管理 / 设置

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-plugin-manager` | 0.2.2-rc.1 | `packages/boot/plugin-manager/README.md`：不改配置即可启用/禁用条目、选 bundle、安装/移除外部 bundle；`plugin_manager` 工具在 Standard/Creator preset 启用；每个动作需 `danger-full-access` 或逐次审批；toggle 只改 profile `cordis.patch.yml` 的 `disabled`，bundle 开关改 `dsh.profile.bundles` 有序列表 | 【复用】 |
| `dsh-settings` / `dsh-config-editor` / `dsh-api-settings-controller` | 0.2.2-rc.1 | A2 已核 `docs/subsystems/settings.md`：`ctx.settings` 把 volatile Config 投影成表单，config-editor 经 Cordis patches 持久化 | 【复用】 |
| `dsh-client-ui-settings*` （14 个） | 0.2.2-rc.1 | `packages/client/ui-settings*/README.md`（G0）；`ui-settings-plugins` 拥有卡片示例（A2:4.3） | 【复用】 |
| `dsh-client-ui-plugin-manager` / `dsh-client-ui-plugin-market` / `dsh-client-ui-plugin-recommendations` | 0.2.2-rc.1 | `packages/client/ui-plugin-manager/README.md` 等（G0） | 【复用】 |
| `dsh-plugin-detail` / `dsh-plugin-market` / `dsh-plugin-market-index` / `dsh-plugin-recommendations` | 0.2.2-rc.1 | 包存在；`dsh-plugin-detail` 公开文档未找到，API 未验证 | 【复用】 |
| `dsh-host-plugin-inventory` | 0.2.2-rc.1 | `packages/host/plugin-inventory/README.md`：`pluginInventory/list` 只读快照，报每个非 group Loader 行的 id / specifier / 有效启用 / root Fiber phase（`pending`/`loading`/`active`/`failed`/`unloading`/`null`）；**只读、无历史、不能改** | 【复用】 |
| `dsh-plugin-package-inventory-deepseek` | 0.2.2-rc.1 | `packages/llm/plugin-package-inventory-deepseek/README.md`：给官方 DeepSeek 请求附 `dsh_plugin_packages` 活动包清单 | 【复用】 |
| 其余 `dsh-client-ui-*`（约 60 个，layout/sidebar/chat/conversation/theme/slots/renderer 等） | 0.2.2-rc.1 | `docs/subsystems/slots.md`（A2 已核）· `web-client.md` · `packages/client/*/README.md`（G0） | 【复用】 |

**阻塞备注**：A2:4.2 / A1:3.4 实测本机 `cordis.patch.yml` 把 `ui-settings` 设为 `enabled: false` → 原生 Settings 面板当前不启用。这是**配置阻塞**，不是能力缺失；归 P0-07 处理。

### 2.10 域 10 · 工具注册 / MCP

| 包名 | 版本 | 依据 / 一句话用法 | 结论 |
| --- | --- | --- | --- |
| `dsh-tools` | 0.2.2-rc.1 | A2 已核 `docs/subsystems/tools.md` · `packages/core/tools/README.md`：`ToolDefinition` + `ToolOutputDefinition`，`ctx.tools.register(defineTool(...))`；`schemas()` 按显式 allowlist 构建模型可见 schema | 【复用】 |
| `dsh-tool-*`（28 个：bash / fs / fs-search / web / terminal / jobs / todo / subagent / skill / goal / session-query / working-directory / workspace-dependencies / workflow / schedule / present / ask-user 等） | 0.2.2-rc.1 | `docs/subsystems/tools.md` · 各 `packages/**/README.md`（G0） | 【复用】 |
| `dsh-tool-executor-native` / `-ptc` / `dsh-tool-call-timeout-policy` / `dsh-tool-cordis` | 0.2.2-rc.1 | `docs/subsystems/tools.md` · `ptc-runtime.md`（G0） | 【复用】 |
| `dsh-mcp-client` | 0.2.2-rc.1 | `docs/subsystems/mcp.md` · `packages/mcp/mcp-client/README.md`：每个 server 一个连接插件（stdio / Streamable HTTP），把发现的工具适配成 harness 工具；`probeServer(ctx, config, options)` 是**一次性连接 + identify + listTools + close** 的 MCP server 探测 | 【复用】 |
| `dsh-mcp-resources` | 0.2.2-rc.1 | `docs/subsystems/mcp.md`：共享资源服务，shipped profiles 挂一次，无配置字段 | 【复用】 |

**命名核验**：L0 中**无 `dsh-mcp-server` / `dsh-mcp-manager`**（仓库 G0 有 `packages/mcp/mcp-manager/README.md`，但**不在**本机共享清单）。G1 `mcp.md:24` 明确「MCP servers are **opt-in**，每个 server 配一个 `@deepseek-ai/dsh-mcp-client` 行」，`mcp-manager` 只在 Web/Desktop profile 挂一次、提供 status/restart/probe。→ 工具注册能力完整【复用】，MCP 侧需按 server 显式配置。

### 2.11 域 11 · 有没有官方包在做「本机 CLI 探测 / 健康检查」

**结论：没有现成服务，且官方在设计上刻意不探测主机 CLI。** 逐项核验如下（这是本任务最可能「砍需求」的一问）：

| 候选包 | 版本 | 实际职责（依据） | 是否 = 本机 CLI 探测 |
| --- | --- | --- | --- |
| `dsh-subprocess` / `dsh-subprocess-local` | 0.2.2-rc.1 | G1 `docs/subsystems/subprocess.md:9-11`：`resolveExecutable(command, env?, signal?)` 校验绝对路径，或**通过 provider 的 scrubbed `PATH` + 显式 override 解析裸命令名**；拥有 `DSH_*` 命名空间、凭据擦除、进程树终止、`CollectedOutput` | **部分**：只做「可执行文件查找」，不做枚举/版本/健康判定 |
| `dsh-native-command` | 0.2.2-rc.1 | G2 `packages/util/native-command/README.md`：`runNativeCommand(cmd, args, signal, 'hidden'\|'visible')` 基于 `execFile` 无 shell 执行，失败时把 `code` / `stdout` / `stderr` 挂到 error，可区分**缺工具 `ENOENT`** / `ABORT_ERR` / 真实失败；`openNativePath` 等 | **部分**：可作健康检查的执行原语，但本身不探测 |
| `dsh-mcp-client` 的 `probeServer` | 0.2.2-rc.1 | G2 `packages/mcp/mcp-client/README.md:138,149`：`src/probe.ts` 是「连接 → identify → listTools → close」的**一次性 MCP server 探测**，`timeoutMs` 限定模板解析+连接+列举 | **否**：对象是 MCP server，不是本机 CLI |
| `dsh-host-plugin-inventory` | 0.2.2-rc.1 | G2 `packages/host/plugin-inventory/README.md`：`pluginInventory/list` 报**插件** fiber 健康/启用状态，只读快照 | **否**：对象是插件，不是外部 CLI |
| `dsh-launch-environment` | 0.2.2-rc.1 | G2 `packages/util/launch-environment/README.md`：冻结「继承 process env / `<cwd>/.env` / `$DSH_HOME/.env`」三层，`get(name)` 按信任顺序取值并返回来源；`launchedThroughSsh()` | **否**：环境变量快照 |
| `dsh-shell-env` | 0.2.2-rc.1 | G2 `packages/shell/shell-env/README.md`：给每次 shell 调用注入 `DSH_HOME` / `DSH_SHELL` / `DSH_SESSION_ID` / `DSH_PROFILE` / `DSH_PROFILE_DIR`，插件可注册自定义 fact | **否**：环境变量注入 |
| `dsh-plugin-package-inventory-deepseek` | 0.2.2-rc.1 | G2 `packages/llm/plugin-package-inventory-deepseek/README.md`：给官方 LLM 请求附活动包清单 | **否** |
| `dsh-experimental-inspector` / `dsh-experimental-session-inspector` | 0.2.2-rc.1 | G2 `packages/experimental/inspector/README.md`：Chrome DevTools 检查 Host/Client Cordis 运行时（Console/Sources/Network/Elements），需 Chrome | **否**：运行时调试器 |
| `dsh-win32-process` / `dsh-tmux-context` / `dsh-ptc-runtime*` | 0.2.2-rc.1 | 平台进程 / tmux / PTC 运行时；`packages/subprocess/win32-process/README.md`（G0） | **否**：进程/上下文基础设施 |

**全局检索（G0 tree）**：匹配 `*cli*/*command*/*executable*` + `*detect*/*probe*/*health*/*resolve*` 的源码文件只有 `packages/mcp/mcp-client/src/probe.ts`、`packages/client/ui-input-trigger/src/core/detect.ts`、`packages/client/ui-plugin-manager/src/client/versions.tsx`、`packages/host/directory-picker-auto/src/probe.ts` —— **没有任何「枚举本机已安装 CLI + 跑 `--version` 判定可用性」的服务**。

**反向事实（官方明确不做）**：

> G3 `.agents/notes/archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md:96` —— "**production performs no separate runtime version probe**."
>
> G3 `.agents/notes/archived/architecture/2026-08-10-product-subagent-providers-in-shared-host.md:20` —— "Profile loading creates no product state, **probes no version or authentication** ... **Neither provider consults or falls back to a host product command**."
>
> 同笔记 `:38/:52` —— codex/claude-code provider 使用 pinned npm 包自带的私有 CLI payload，**不解析、不回退**到主机 `PATH` 里的 `codex` / `claude`。

**因此**：这一项**不会**被官方能力砍掉；官方走的是「Bundle 固定版本自带 CLI」路线，与 MeetingStone「探测用户本机已装的多种 CLI 并按角色派单」是相反的产品假设。但 `dsh-subprocess.resolveExecutable()` 与 `dsh-native-command.runNativeCommand()` 可直接复用来做「PATH 查找 + 无 shell 试跑 + 区分 ENOENT」，自研范围被缩小为「枚举 + 健康/版本判定 + 结果缓存 + UI 展示」，不必自己写路径解析与子进程执行。

---

## 3. 关键事实汇总（会改变开发范围的三条）

| # | 事实 | 出处 | 影响 |
| --- | --- | --- | --- |
| F1 | 四个外部 CLI/进程 provider 包（`dsh-subagent-acp` / `-codex` / `-claude-code` / `-dsh-sdk`）**都不在**本机 329 个共享包里；生产 `dsh-base` 不含它们，需 Profile 显式安装独立 Bundle | L0 · G3 `2026-08-10-product-subagent-providers-in-shared-host.md:16` | 本机桌面版当前没有到外部 CLI 的官方派单通道；P0-04/P0-11 需按「缺」处理 |
| F2 | 官方 provider **不解析/回退主机 PATH 的 codex/claude**，用 pinned npm 包自带 CLI；且**明确不做运行时版本/认证探测** | G3 `2026-08-04-...md:38,52,96` · `2026-08-10-...md:20` | 「本机 CLI 探测」无官方现成服务，需自研（但可复用两个原语） |
| F3 | `dsh-persona` + `dsh-agent-preset` 已能定义角色身份与工具集；`ctx.subagents` + `dsh-tool-subagent` + `ctx.jobs` + `dsh-subprocess` 已覆盖单任务委派、前台/后台、进程树退出、取消、完成通知 | G2 `packages/preset/persona/README.md` · G1 `subagent.md` / `jobs.md` / `subprocess.md` · G3 `2026-08-04-...md:18,27-34` | 角色定义与进程/作业生命周期不用自研；缺的只是「角色→CLI 映射 + 编排」 |

---

## 4. 未验证项

| # | 未验证项 | 原因 | 建议后续 |
| --- | --- | --- | --- |
| U1 | `dsh-experimental-agent-team-profile` / `dsh-experimental-client-ui-agent-team` 的独立 README 与 API | 本次取了 `docs/subsystems/agent-team.md` 与 `packages/team/*/README.md`，未取这两个包自身 README | 需要时按 G0 路径补取 |
| U2 | 仓库 `packages/team/agent-team`（README 标题 `@deepseek-ai/dsh-agent-team`）与 L0 的 `dsh-experimental-agent-team` 是否同一产物 | 命名前缀不同，未做构建产物比对 | 阶段 1 用 `--dump-config` / 包解析验证 |
| U3 | `dsh-util-workspace-path`、`dsh-workflow*`、`dsh-schedule*`、`dsh-plugin-detail`、`dsh-experimental-client-ui-stats`、`dsh-client-ui-trajectory` 的公开文档 | 包在 L0，但未在本次取用中找到对应 README/API 页 | 按 G0 路径补取；本文只写「包存在，公开文档未找到，API 未验证」 |
| U4 | `dsh-mcp-manager`（G0 有 README）为何不在 L0 | 只在仓库树里出现，本机共享清单无此项 | 与 `dsh-base`/`dsh-web-app` 的 composition 一起核对（P0-07） |
| U5 | 四个 provider 的**可安装 Bundle 名称**与安装方式 | G3 说明「独立 Bundle，Profile 显式安装」，但未取 Bundle patch 与包名 | P0-04 / P0-11 补取 `packages/subagent/*/cordis.patch.yml` 或 bundle 目录 |
| U6 | `dsh-subprocess.resolveExecutable()` 的完整签名、PATH override 规则与 Windows 行为 | 只读了 G1 `subprocess.md` 的开头定义，未取 `packages/subprocess/subprocess/README.md` | P0-08 沙箱/子进程边界任务里核实 |
| U7 | 本机 `ui-settings enabled:false` 是用户手动关还是模板默认 | A1:3.4 / A2:4.2 已标注待确认 | P0-07 |
| U8 | `sharedPackages` 是否等于「当前 profile 实际可解析的全部包」 | 只核了清单本身与 A1:3.2 的观察，未做运行时 `require.resolve` 实测 | 阶段 1 在临时 profile 实测 |

---

## 5. 最小自研范围初判

> 只列「真的可能要自己写」的东西，并说明原生为什么不够。结论：**核心 3 项 + 1 项几乎可全复用**。

| # | 自研项 | 原生已有什么 | 原生为什么不够 | 实际要写的最小范围 |
| --- | --- | --- | --- | --- |
| 1 | **角色注册表 + 别名解析** | `dsh-persona`（preset 内 `prefix`/`suffix`/`complete` 段，G2）、`dsh-agent-preset` + `-registry`（YAML 定义 agent 子插件，G2）、`dsh-skill` / `dsh-agent-instructions`（技能与 `AGENTS.md` 链）、`dsh-system-prompt`（prompt 贡献注册） | 这些都是**静态组合行 / 一个 preset 一个身份**，没有「角色名或别名 → 目标 CLI + 参数 + cwd + 模型」的可变映射表，也没有别名归一化/冲突消解。原生无法回答「把这条任务按 `reviewer` 派给谁」 | 一张角色注册表（角色 id / 别名集合 / 目标 CLI / 启动参数 / 工作目录策略）+ 别名解析函数；**角色 prompt 文本与预设选择复用 `dsh-persona`/`dsh-agent-preset`，不自己拼系统提示** |
| 2 | **本机 CLI 探测 / 健康检查** | `dsh-subprocess.resolveExecutable()`（PATH 裸名解析，G1 `subprocess.md`）、`dsh-native-command.runNativeCommand()`（无 shell 执行、区分 `ENOENT`，G2）、`dsh-launch-environment`（环境分层）、`dsh-shell-env`（`DSH_*` 注入）、`dsh-host-plugin-inventory`（插件 fiber 健康）、`dsh-mcp-client.probeServer()`（MCP server 探测） | **官方明确「production performs no separate runtime version probe」「probes no version or authentication」，且 provider 不解析/回退主机 PATH 的 codex/claude**（G3，见 F2）。`pluginInventory` 只报插件状态、`probeServer` 只探 MCP server，都不是本机 CLI。没有任何服务负责「枚举多个 CLI + 试跑 + 判定可用/版本 + 缓存」 | 复用两个原语，自己写：CLI 候选枚举、`--version`/health 试跑与超时、结果规范化（可用/版本/路径）、缓存与失效、状态展示。底层 PATH 解析与子进程执行不重写 |
| 3 | **派单编排（按角色路由到不同 CLI）** | `ctx.subagents` + `dsh-tool-subagent`（具名委派工具，`toolName`/`cwd`/前后台）、`ctx.jobs` + `dsh-tool-jobs`（Job id/状态/输出/取消/完成通知）、`dsh-subprocess`（凭据擦除 + 进程树终止 + whole-tree exit）、`dsh-tool-todo` / `dsh-jobs` 的任务 UI | G3 的 ownership 表已把「单任务委派 → 前台/后台 → 进程退出」全部管好；但**四个外部 CLI provider 不在本机共享清单（F1）**，且官方 provider 刻意绑定 pinned 自带 CLI、不做动态主机 CLI 路由（F2）。原生没有「一个角色名 → 选哪台本机 CLI → 用哪套参数启动」的路由层，也没有跨多个异构 CLI 的统一编队 | 一层薄编排：角色 →（CLI 探测结果 + 启动参数）→ 复用 `dsh-subprocess` / `ctx.jobs` 启动与回收；**不自己写进程树管理、Job 状态机、取消/完成通知**。若后续选择安装官方 provider Bundle，则这层可退化为「Bundle 选择 + preset 工具绑定」 |
| 4 | **最小设置表单** | `dsh-settings` + `dsh-config-editor`（G1 `settings.md`）、Schemastery `Config` + `.volatile()` 自动生成 Plugins 页表单、`ctx.settings.configure({auto:true})`、`dsh-client-ui-settings-plugins` + `ctx.slots`（A2:4.3） | 几乎**不缺**：写自己的 `Config` schema（把角色表、CLI 候选、默认策略标为 volatile）即可得到可编辑表单，编辑经 config-editor 持久化到 profile `cordis.patch.yml` + HMR 生效 | 只需写 Config schema + 少量 slot 贡献（或自定义页）。**注意**：本机 `ui-settings` 被 `enabled:false`（U7/A2:4.2）是配置阻塞，不是自研项；若走 `./client` 自定义页面，还有 A2:4.3 的 lazy-CJS factory 构建门槛，建议先走自动表单路线 |

**不列入自研的项**（均由原生覆盖）：项目/工作目录模型（`dsh-workspace`）、Session 事件与轨迹（`dsh-session*`）、后台作业与任务 UI（`dsh-jobs*` / `dsh-tool-todo`）、权限/审批/沙箱（`dsh-user-approval` / `dsh-permission-presets` / `dsh-sandbox*`）、Token/Usage 统计（`dsh-token-meter`）、工具注册（`dsh-tools` / `defineTool`）、插件管理与设置页机制（`dsh-plugin-manager` / `dsh-settings`）、子进程生命周期与清理（`ctx.effect()` + `dsh-subprocess`，见 A2:2.4）。

---

*本文为阶段 0 审计证据，只记录「怎么得到的」；包名/版本逐项取自 `app.asar` 内 `sharedPackages`，文档依据均标仓库路径 + ref/日期；未验证项一律登记于第 4 节，未推断成结论。*
