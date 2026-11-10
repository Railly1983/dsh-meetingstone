# 04 · 各 CLI / 原生通道 能力矩阵（P0-04）

> 采集人：八戒（主 Agent）｜采集日期：2026-11-10｜环境：Windows 11 25H2 / DSH `0.2.2-rc.1`
> 原则：**亲手跑过的写实测，没跑过的写未验证**。转述他人结论的会标注来源。

## 0. 一句话结论

| 通道 | 能不能被我们驱动 | 关键限制 |
| --- | --- | --- |
| Codex CLI | ✅ 能（`codex exec` 无头 + JSONL 事件 + 真实 usage） | 不在 PATH，要从 Appx 包解析；stdin 有坑 |
| CodeBuddy CLI | ⚠️ **不能直接 spawn**（无头入口崩），但经 DSH 的 ACP Provider 正常 | 结论：**不要自研启动器**，走宿主 Provider |
| Claude Code CLI | ❌ 未安装 | 需要时再装，不阻塞 |
| DSH 原生子 Agent | ✅ 宿主原生（本会话工具层已有 `subagent` / `subagent_fork`） | 能力边界待单独验证 |

---

## 1. Codex CLI（实测）

| 项 | 实测值 / 证据 |
| --- | --- |
| 可执行文件 | `C:\Program Files\WindowsApps\OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0\app\resources\codex.exe` |
| 版本 | `codex-cli 0.167.0-alpha.3.2`（`--version`） |
| 是否在 PATH | ❌ 否（`where codex` 退出码 1）；必须走 `Get-AppxPackage` 解析 |
| 非交互入口 | ✅ `codex exec`（别名 `e`） |
| 事件流 | ✅ `--json` → stdout 输出 **JSONL**，实测事件：`thread.started`（带 `thread_id`）→ `turn.started` → `item.completed`（`agent_message`）→ `turn.completed` |
| 用量 | ✅ **真实可用**：`turn.completed.usage` 含 `input_tokens` / `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens` / `reasoning_output_tokens` |
| 一次最小实测 | 提示词「Reply with exactly: PONG」，`-s read-only --ephemeral --skip-git-repo-check --json`：退出码 `0`，耗时 **8685 ms**，usage 为 `input 17461 / cached 13952 / output 6` |
| 权限档位（CLI 原生） | ✅ `-s, --sandbox`：`read-only` / `workspace-write` / `danger-full-access` —— 这是「真只读」的硬落点 |
| 工作目录 | ✅ `-C, --cd <DIR>`；另有 `--add-dir` 追加可写目录 |
| 模型 | ✅ `-m, --model <MODEL>` |
| 会话 | ✅ `exec resume`（`--last` 续最近一次）/ `exec fork`；`--ephemeral` 不落盘 |
| 结构化输出 | ✅ `--output-schema <FILE>`、`-o/--output-last-message <FILE>` |
| 其他可用子命令 | `app-server`（experimental，app-server/JSON-RPC）、`review`、`doctor`、`sandbox`、`apply`、`mcp`、`plugin`、`features` |
| 宿主实际传输 | `codex-app-v1`（读自 CLIWorker worker.json 的 `transport` 字段）：宿主是走 **app-server** 而不是 `exec` |
| ⚠️ 坑 1 | **stdin 未关闭时**，`codex exec "<prompt>"` 会打印 `Reading additional input from stdin...` 并把 stdin 追加为 `<stdin>` 块。自动化必须显式关闭 stdin 或用 `-` 从 stdin 喂提示词 |
| ⚠️ 坑 2 | 同一台机器存在第二个包 `OpenAI.CodexPrimaryRuntime 26.1105.1297.0`（版本更高但**包内无 `codex.exe`**），探测时容易误命中 |
| ⚠️ 坑 3 | 包目录名带版本号，应用升级后整体变化（已实测 `26.1103.4239.0` → `26.1103.7773.0`），路径不可写死 |

**结论**：Codex 是我们唯一可以「自己驱动且能拿到真实用量」的外部 CLI；`-s read-only` 让「只读档位」不是口号。

---

## 2. CodeBuddy CLI（实测 + 重要负面结论）

| 项 | 实测值 / 证据 |
| --- | --- |
| 可执行文件 | `C:\Users\30673\AppData\Roaming\npm\codebuddy.cmd`（另有 `cbc`、`codebuddy-code`、`codebuddy-lowmem`） |
| 版本 | `2.181.0`（`--version` 正常返回） |
| 是否在 PATH | ✅ 是 |
| `--help` | ❌ **崩溃**：`Failed to start the backend application.` + `TypeError: Cannot read properties of undefined (reading 'get')`（`codebuddy-headless.js:6638`），退出码 1 |
| `-p "<prompt>"`（关闭 stdin、无 TTY） | ❌ 同样崩溃，退出码 1，stdout 空 |
| `--acp`（关闭 stdin） | ❌ 同样崩溃，退出码 1 |
| 包内线索 | 依赖里有 `@agentclientprotocol/sdk@1.9.0`（ACP 支持确实存在）；`bin/` 下有 `windows-job.cjs`（Job Object 管理）、`no-orphans.cjs`、`daemon-supervisor.cjs` |
| 宿主实际传输 | `codebuddy-acp-v1`：**通过 ACP 正常工作**——本轮已有 2 个 CodeBuddy Worker 跑完并交付（沙僧 P0-01、小白 P0-02），且会话续聊可用 |
| 真正只读 | ❓ 未验证（doc 也警告：若不支持真只读，不得标成安全只读） |
| 用量 | ❓ 未验证（ACP 是否回传 usage/context 未测） |

**结论（设计级）**：**我们不应该自己去 spawn CodeBuddy 进程**。直连入口在本机非 TTY 环境下必然失败，而宿主已有的 ACP 通路是通的。这条实测直接支持交接文档的最高原则——复用宿主 Provider，不做自研启动器。

> 待补：CodeBuddy 在「真 TTY」下是否可用未验证；但对我们没有意义——产品走 Provider 通路。

---

## 3. Claude Code CLI

| 项 | 结论 |
| --- | --- |
| 可执行文件 | ❌ 未找到（PATH / Appx / npm 全局 / 常见目录 四路皆空） |
| 历史 | `~/.claude/.last-update-result.json` 记录曾用 npm-global 安装 `2.1.266`，升级 `2.1.269` 时 `update_apply_exe_locked` 失败，之后被移除 |
| 配置残留 | `~/.claude` 仍在，含 `settings.json`（指向 DeepSeek 的 anthropic 兼容端点）、`projects`、`sessions` |
| 决策 | 负责人已定：**暂不安装**；需要独立审查时再补 |

---

## 4. DSH 原生子 Agent（第四通道）

| 项 | 结论 |
| --- | --- |
| 存在性 | ✅ 宿主原生能力，已在本会话工具层暴露：`subagent`（独立上下文）、`subagent_fork`（继承上下文）、`send_message` / `interrupt_agent` / `list_agents` |
| 生命周期 | 可并行启动、可中途 steer、可中断、可续聊 |
| 执行记录 | 走原生 Session（无需我们自建） |
| 能力边界 | ❓ 未单独验证：它能做什么、不能做什么（尤其写文件边界、长任务、并发上限） |
| 产品含义 | 这是「八戒」这类角色的天然通道；产品里 `channel.kind = "dsh-subagent"` |

---

## 5. 横向对比（用于产品设计）

| 维度 | Codex | CodeBuddy | Claude | DSH 原生 |
| --- | --- | --- | --- | --- |
| 我们能直接驱动 | ✅ `exec --json` | ❌ 走 Provider | ❌ 未装 | ✅ 工具层 |
| 真实 usage | ✅ | ❓ | — | ✅（宿主统计） |
| CLI 原生只读 | ✅ `-s read-only` | ❓ | — | ✅（宿主权限） |
| 会话续聊 | ✅ `resume --last` | ✅（经 Provider） | — | ✅ |
| 取消 | ✅（进程信号）❓未测子进程树 | ❓ | — | ✅ `interrupt_agent` |
| 事件流 | ✅ JSONL | ❓ ACP JSON-RPC | — | ✅ 宿主事件 |
| 工作目录约束 | ✅ `-C` | ❓ | — | ✅ 宿主 cwd |

---

## 6. 对产品的 4 条直接结论

1. **派单执行一律经宿主 Provider**，不自研 CLI 启动器 —— CodeBuddy 的崩溃是硬证据，不是偏好。
2. **本机 CLI 探测只做「状态展示 + 可用性判断」**，不承担执行：探测链 = PATH → Appx 解析 → npm 全局 → 常见目录 → 手工指定。
3. **「只读」档位在 Codex 上可以用 `-s read-only` 真落实**；CodeBuddy 未验证前，UI 必须标「无只读保证」，不许宣传。
4. **用量只报真值**：Codex 的 `turn.completed.usage` 可直接用；其余显示 `unknown`。

## 7. 未验证清单

| 项 | 状态 |
| --- | --- |
| Codex 取消后子进程树是否尽退 | 未验证（P0-08 一起做） |
| Codex 在 `-s read-only` 下是否真的拒绝写盘 | 未验证（只验证了参数存在，未做拒绝实验） |
| Codex `app-server` 的 JSON-RPC 接口细节 | 未验证（宿主已在用 `codex-app-v1`，但我们是否需要直连未定） |
| CodeBuddy ACP 的 usage / 只读能力 | 未验证 |
| DSH 原生子 Agent 的并发与边界 | 未验证 |
| Claude 装回后的能力 | 未验证（当前未安装） |
