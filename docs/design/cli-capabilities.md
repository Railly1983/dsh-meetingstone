# CLI 能力目录（B2b）· 4 CLI × 模型 × 思考强度

> 任务：B2b（task-15）+ **B3a config 源**｜执行：沙僧｜2026-11-12｜状态：**后端完成（UI 由 task-16/B3 接入）**
> 背景：用户真机实测——编辑器把插件 channel 实例当能力来源（CLI 显示成 `ch-*`、模型不刷新、思考强度不可用）。
> 本文件是**能力唯一事实源**：`src/cli/capabilities.js`；GUI 通过 `global.capabilities` 消费，不再从 channel 推断。

## 1. 结论

1. 固定 **4 CLI**：`dsh`（DeepSeek Harness）、`claude`（Claude Code）、`codex`（Codex）、`codebuddy`（CodeBuddy/ACP）。
2. 每项形状固定：`{ id, label, models:[{id,label,provider,source}], strengths:[{id,label,source}], sources:{models,strengths}, refreshedAt, errors }`。
3. 来源优先级 **动态发现 > 本机 profile 配置（config） > 静态已知表 > unknown**；每项都带 `source`，失败保留上一来源并记录可观测错误，**不伪造**。
4. 刷新可观测：`refreshCli` 强制刷新对应 CLI（返回 `capabilities` + `capabilityRefresh`）；`list()` 快照在缓存过期后后台刷新；`capabilitiesRefreshedAt`/`capabilitiesErrors` 暴露在 `global`；config 源路径/行数在 `snapshot().capabilitiesConfig` 可查。
5. 未新增 remote、未改 `src/client`、未写 profile；**B3a 无需改 `src/gui/host.js`**（详见 §10）。

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

---

## 10. B3a · config 源（本机 profile provider 行真实声明）

> 触发：用户真机仍看不到本机模型（profile 真实模型是 `kimi-k3.1-pro` / `hy4free` / `glm-5.3-flash` / `hy3`，不在静态表里 → 编辑器无当前值、强度置灰）。
> 目标：把**本机真实声明**并入能力目录，新增 source `config`，优先级 `discovered > config > static > unknown`。

### 10.1 读取途径结论（硬要求：实测，不假设）

| 途径 | 结论 | 证据 |
| --- | --- | --- |
| `ctx.configEditor` | **只能写，不能读其它行 config** | 宿主 `dsh-config-editor` README：调用方用 `ctx.configEditor.edit()` 编辑完整配置；未提供读任意 entry config 的公开 API |
| `pluginInventory/list` | **只读但无 config 值** | 宿主 `dsh-host-plugin-inventory` README：快照是 Loader 状态/preset 组合的只读投影，**无 layer attribution、无 mutation**；不含每行 config |
| **profile patch 文件** | **采用（只读解析）** | `configEditor` 的写目标就是 profile patch（README：「Edits target the active profile patch」）；插件只读解析 `$DSH_PROFILE_DIR/cordis.patch.yml`，失败回退 → 静态/unknown |

**路径解析**（只读，均有回退）：`$DSH_PROFILE_DIR/cordis.patch.yml` → `$DSH_HOME/profiles/$DSH_PROFILE/cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`；全部不可读 → `capabilitiesConfig.errors` 记录原因并保留静态/unknown，不抛错、不写盘。
**边界**：这是“读文件”不是“读 ctx”；若宿主未来提供只读配置服务，可替换 `readProviderRowsFromProfile*` 实现，目录契约不变。

### 10.2 解析规则（YAML 子集，逐行扫描）

- 识别 `- id:` 行（含 `insert:` 嵌套），读取 `name:`（specifier）、`providerName:`、`model:`、`effort:`、`disabled: true`、`args:` 列表。
- `@deepseek-ai/dsh-subagent-acp` → CLI `codebuddy`；`-codex` → `codex`；`-claude-code` → `claude`。
- 模型/强度取值：`args` 里的 `--model <v>` / `--effort <v>`（也支持 `--model=v`）；缺省回退 config 的 `model:`/`effort:`。
- 缺 `--model` 或 `disabled: true` 的行跳过（不猜）；结构异常不影响其它行。

### 10.3 合并策略

- 模型：`discovered` 列表 + 各 provider 行的 `config` 模型**按 id 去重并入**；同一 id 以 `discovered` 为准；两者皆空且无 config 时才回退静态表（动态成功但为空时保持空，不回退静态）。
- 强度：`discovered` 强度并集 + 各 config 行 `--effort` 并集；无则回退静态表；仍无 → `unknown`。
- **反查**：每个 model 保留自己的 `provider`（config 行 = `providerName`），`providerForCatalogModel(models, modelId)` 可直接反查；编辑器保存时映射为内部 `channel{kind,model,reasoning}`（provider 由目录给出，派单解析按 kind+model+reasoning 对齐）。

### 10.4 实测样例（2026-11-12，profile `desktop`，14 行 provider 声明）

`configPath=C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml`、`rows=14`、`errors=[]`：

| CLI | models（config/static/discovered） | strengths | sources |
| --- | --- | --- | --- |
| dsh | （空） | （空） | unknown / unknown（无 provider 行；动态靠 `ctx.llm`） |
| claude | sonnet / opus / fable（static） | low, medium, high, xhigh, max（static） | static / static |
| codex | gpt-6-astra@`codex`、gpt-6.1-sol@`codex-sol`（config） | —（刷新后由 codex 动态发现 low..ultra） | config / unknown→discovered |
| codebuddy | **glm-5.3-flash@`acp`、hy3@`acp-hy4`、hy4free@`acp-hy4free`、kimi-k3.1-pro@`acp-kimi`（config）** | **high（config）** | config / config |

> 该样例直接解释并修复用户问题 3/4：编辑器打开即有当前模型与强度，且模型→provider 可反查。

### 10.5 集成与边界

- `src/cli/capabilities.js` 内部默认启用 config 读取（同步首读 + 刷新时重读）；**host.js 无需改动**：目录条目形状不变（只多 source 值），`global.capabilities`/`refreshedAt`/`errors` 已由 B2b 透传；`snapshot().capabilitiesConfig` 为附加诊断字段（host 不消费也不影响）。
- 未新增 remote；未改 `src/client`/`src/gui`/profile。
- 测试：`tests/cli-capabilities.test.mjs` 14 条（含解析/合并/优先级/刷新重读/临时文件读取/路径候选）；本机真实 profile 读取样例见 §10.4。

### 10.6 未验证

- 运行宿主插件进程内 `$DSH_PROFILE_DIR` 是否一定存在（文件回退到 `~/.dsh/profiles/<profile>` 已覆盖；若两者都拿不到则 config 源不可用 → 静态/unknown）。
- 动态发现与 config 并集的顺序在真机（`ctx.llm` 可用时 dsh 模型出现）未实测。
- 模型值（kimi-k3.1-pro / hy4free / glm-5.3-flash）能否被 CodeBuddy ACP 接受，本次未跑任务验证（能力目录只负责“可选什么”）。
