# CLI 能力目录（B2b）· 4 CLI × 模型 × 思考强度

> 任务：B2b（task-15）｜执行：沙僧｜2026-11-12｜状态：**后端完成（UI 由 task-16 接入）**
> 背景：用户真机实测——编辑器把插件 channel 实例当能力来源（CLI 显示成 `ch-*`、模型不刷新、思考强度不可用）。
> 本文件是**能力唯一事实源**：`src/cli/capabilities.js`；GUI 通过 `global.capabilities` 消费，不再从 channel 推断。

## 1. 结论

1. 固定 **4 CLI**：`dsh`（DeepSeek Harness）、`claude`（Claude Code）、`codex`（Codex）、`codebuddy`（CodeBuddy/ACP）。
2. 每项形状固定：`{ id, label, models:[{id,label,provider,source}], strengths:[{id,label,source}], sources:{models,strengths}, refreshedAt, errors }`。
3. 来源优先级 **动态发现 > 静态已知表 > unknown**；每项都带 `source`，失败保留静态表并记录可观测错误，**不伪造**。
4. 刷新可观测：`refreshCli` 强制刷新对应 CLI（返回 `capabilities` + `capabilityRefresh`）；`list()` 快照在缓存过期后后台刷新；`capabilitiesRefreshedAt`/`capabilitiesErrors` 暴露在 `global`。
5. 未新增 remote、未改 `src/client`、未写 profile。

## 2. 探测可行性核验（2026-11-12 实测）

| CLI | 结论 | 证据 |
| --- | --- | --- |
| **codex** | **动态可用** ✅ | `codex app-server` JSON-RPC：`initialize` → `initialized` 通知 → `model/list` 返回 `data[]`（含 `model/displayName/supportedReasoningEfforts/defaultReasoningEffort`）。实测 codex-cli `0.167.0-alpha.4.1`；本机返回 gpt-6.1-sol / gpt-6-astra / gpt-6.1-terra / gpt-6-sol / gpt-6-luna / gpt-5.6-sol… 与强度 low/medium/high/xhigh/max/ultra。**必须先发 initialized 通知**，否则无响应 |
| **claude** | **静态可用**（CLI 自述） | `claude --help`（v2.1.322）：`--model <model>` 支持别名 `fable` / `opus` / `sonnet`（或完整模型名）；`--effort <level>` 档位 `low, medium, high, xhigh, max`。无“列模型”API → 记 `source:"static"` |
| **codebuddy** | **无法动态枚举** → 静态表 + 强度 unknown | `codebuddy --help` 崩溃（`TypeError: Cannot read properties of undefined (reading 'get')`）；`~/.codebuddy/settings.json` 仅 `trustedDirectories`（无模型表）。模型用 Lead 定版映射：`deepseek-v4.1-flash→acp`、`hy3→acp-hy4`；强度无证据 → `unknown` |
| **dsh** | **接口存在，插件侧依赖宿主注入** | 宿主 `@deepseek-ai/dsh-llm` README：`listModels` 描述 catalog 模型（含 `reasoning.efforts`）。插件侧尝试 `ctx.llm.listModels()`（或 `ctx.get('llm')`）；拿不到 → 抛错并保留 `unknown`（独立脚本无宿主 ctx 时实测即 unknown，不伪造） |

## 3. 能力数据（静态已知表）

| CLI | models（静态） | strengths（静态） | 备注 |
| --- | --- | --- | --- |
| dsh | —（动态：host llm） | — | 无静态表；动态失败 → unknown |
| claude | sonnet / opus / fable（provider `claude-code`） | low / medium / high / xhigh / max | 来自 `--help` |
| codex | gpt-6-astra（`codex`）/ gpt-6.1-sol（`codex-sol`） | —（动态提供） | 动态失败 → 模型静态、强度 unknown |
| codebuddy | deepseek-v4.1-flash（`acp`）/ hy3（`acp-hy4`） | —（无证据） | 强度 unknown |

**provider 映射**（模型级优先，未知模型回退 CLI 级）：
- `dsh` → `spawn`；`claude` → `claude-code`
- `codex`：`gpt-6-astra`→`codex`、`gpt-6.1-sol`→`codex-sol`，其他发现模型→`codex`
- `codebuddy`：`deepseek-v4.1-flash`→`acp`、`hy3`→`acp-hy4`，其他→`acp`

## 4. `global.capabilities` 示例（静态初始快照）

```json
{
  "capabilities": [
    { "id": "dsh", "label": "DeepSeek Harness", "provider": "spawn",
      "models": [], "strengths": [],
      "sources": { "models": "unknown", "strengths": "unknown" },
      "refreshedAt": null, "errors": [] },
    { "id": "claude", "label": "Claude Code", "provider": "claude-code",
      "models": [ { "id": "sonnet", "label": "Sonnet", "provider": "claude-code", "source": "static" } ],
      "strengths": [ { "id": "low", "label": "Low", "source": "static" } ],
      "sources": { "models": "static", "strengths": "static" },
      "refreshedAt": null, "errors": [] },
    { "id": "codex", "label": "Codex", "provider": "codex",
      "models": [ { "id": "gpt-6-astra", "label": "GPT-6-Astra", "provider": "codex", "source": "static" } ],
      "strengths": [],
      "sources": { "models": "static", "strengths": "unknown" },
      "refreshedAt": null, "errors": [] },
    { "id": "codebuddy", "label": "CodeBuddy", "provider": "acp",
      "models": [ { "id": "deepseek-v4.1-flash", "label": "DeepSeek V4.1 Flash", "provider": "acp", "source": "static" } ],
      "strengths": [],
      "sources": { "models": "static", "strengths": "unknown" },
      "refreshedAt": null, "errors": [] }
  ],
  "capabilitiesRefreshedAt": null,
  "capabilitiesErrors": []
}
```

刷新后（实测 codex 动态）：`codex.sources.models="discovered"`、模型含 `gpt-6.1-sol(provider=codex-sol)`、`gpt-6-astra(provider=codex)` 等，`strengths` 为 low/medium/high/xhigh/max/ultra（来源 `discovered`），`capabilitiesRefreshedAt` 为时间戳；dsh 无宿主 ctx 时保留 unknown 且 `capabilitiesErrors` 记录原因。

## 5. 刷新与可观测

| 机制 | 行为 |
| --- | --- |
| 静态初始 | 目录始终可返回 4 CLI（静态表/unknown），`list()` 不阻塞 |
| 自动刷新 | 快照超过 TTL（默认 5 分钟）时**后台**刷新（不阻塞 list），完成后下次快照可见 |
| `refreshCli(cli, force)` | 先 preflight；成功后强制刷新该 CLI 能力，返回 `{ok, cli, capabilities, capabilityRefresh}` |
| 可观测 | `global.capabilitiesRefreshedAt`、`global.capabilitiesErrors`、每项 `refreshedAt/errors/sources` |
| 失败语义 | 动态失败 → 保留静态表 + 记录错误；动态成功但为空 → 以动态为准（`source:"discovered"`，不回退静态） |

## 6. 集成点

- `src/cli/capabilities.js`（新）：目录、静态表、provider 映射、codex JSON-RPC 探测、宿主模型提取、缓存/刷新。
- `src/gui/host.js`：`createGuiState({ capabilities? })` 默认创建目录（探测 = codex app-server / DSH host llm）；`globalView` 输出 `capabilities/capabilitiesRefreshedAt/capabilitiesErrors`；`refreshCli` 刷新并回传。
- **未新增 remote**（沿用 `list` + `refreshCli`）；`src/client` 未改。

## 7. 测试

- 新增 `tests/cli-capabilities.test.mjs`（7 条）：4 CLI 形状/标签、来源标注不伪造、provider 映射、动态覆盖静态、失败保留静态+错误、动态空列表语义、codex/宿主解析容错、宿主快照 4 CLI。
- 全量：`npm test` **584 tests / 583 pass / 0 fail / 1 skip**（B2b 前 577）。
- 动态 e2e（源码级，真实 codex app-server）：codex `sources.models="discovered"`，模型含 gpt-6.1-sol→provider `codex-sol`、gpt-6-astra→provider `codex`；strengths=low/medium/high/xhigh/max/ultra。

## 8. 交给 task-16（B2c / UI）的契约要点

1. 读 `global.capabilities`（不是 `global.channels`，也不是 `roles[].channelId`）渲染 4 CLI 选项。
2. 模型取 `capability.models[]`（`id/label/provider/source`）；强度取 `capability.strengths[]`；若为空且 `sources.*=="unknown"` → 显示「不支持/未知」，不得伪造。
3. `refreshCli` 返回里已带最新 `capabilities`；也可用 `global.capabilitiesRefreshedAt` 判断新鲜度。
4. 当前 alpha.4 客户端仍按旧形状（`{cli,models:[{model,efforts}],efforts,reasoningSupported}`）收窄，**UI 未接新形状时会显示空**——属预期，task-16 修。
5. 角色保存仍写内部 `channel{kind,model,reasoning}`（B2 契约不变）；能力目录只负责“可选什么”。

## 9. 边界与未验证

- 未改 `src/client`、未重启、未改 profile；未新增 remote。
- DSH host `ctx.llm.listModels()` 的**实机可用性未验证**（只在独立脚本验证了无 ctx 时 unknown 兜底）；插件内 `ctx.llm`/`ctx.get('llm')` 的注入形态需在 task-16/真机确认。
- Claude 只验证了 `--help` 静态声明；未验证具体模型的可用性/额度。
- CodeBuddy 模型/强度只能静态表；无动态来源。
