# 10 · 官方 provider bundle 安装实测（R14）

| 项 | 值 |
| --- | --- |
| 采集时间 | 2026-11-10 14:52–14:59（UTC+08:00） |
| 采集人 | 沙僧（CodeBuddy CLI 会话，模型 `deepseek-v4.1-flash`） |
| 宿主 | DeepSeek Harness `0.2.2-rc.1`（`hostProtocolVersion: 4`） |
| CLI | `C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| 隔离根 | `C:\Users\30673\AppData\Local\Temp\mt-provider-install-20261110145203`（**已删除**） |
| `DSH_HOME` | `<隔离根>\dsh-home` |
| 结论 | acp **可装但不是 bundle**（须手工挂行）；codex **可装且自动成层**；两者**都能干净卸载**；尚未验证运行时注册 |

---

## 0. 结论卡

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 能否装进隔离 profile | **能，两者都是退出码 0**。acp `+6` 包（5.6 MB），codex `+10` 包（约 3 分钟、store 382 MB） |
| 2 | 版本标签 | 用 **`next`（= `0.2.2-rc.1`，与宿主同版）**。`latest` 是 `0.0.1-rc.1`（2026-08-10 的旧版），不能用；生产建议写**精确版本** `@0.2.2-rc.1` |
| 3 | 装完 `--dump-config` 出现什么 | **codex**：新增 `# == @deepseek-ai/dsh-subagent-codex` 层，含 `subagent-codex` 与 `tool-subagent-codex` 两行；**acp**：**0 处出现**（它不是 bundle，`plugin add` 只装依赖不成层） |
| 4 | acp 怎么才能生效 | 必须在 profile `cordis.patch.yml` 手写 `- id: subagent-acp / name: '@deepseek-ai/dsh-subagent-acp' / config.command: ...`（实测可组合，见 §5） |
| 5 | 能否查询 provider 是否注册 | **CLI 层没有查询命令**。只能运行时用 `ctx.subagents.getProvider('acp' \| 'codex')` 或监听 `subagent/provider-added` 事件确认（见 §7） |
| 6 | 卸载是否干净 | **干净**：`plugin remove` 退出码 0；`package.json` 依赖与 `dsh.profile.bundles` 同时回退；`--dump-config` 目标关键字 0 命中；`node_modules` 只剩空 scoped 目录与空 `.pnpm` |
| 7 | 对真实 desktop 的影响 | **无**。真实 profile 全程只在删除后复查一次：`package.json` 515 B、mtime `2026-11-09 16:07:20`、SHA-256 未变、7 个 bundle 原样（见 §9） |

---

## 1. 安全边界与隔离验证

### 1.1 环境变量（只作用于本次子进程）

```powershell
$root = Join-Path $env:TEMP ('mt-provider-install-' + (Get-Date -Format 'yyyyMMddHHmmss'))
$env:DSH_HOME = Join-Path $root 'dsh-home'
$env:npm_config_userconfig = Join-Path $root 'empty-user.npmrc'
$env:npm_config_globalconfig = Join-Path $root 'empty-global.npmrc'
$env:npm_config_store_dir = Join-Path $root 'pnpm-store'
```

两个 npmrc 写空字符串，避免读取用户 `.npmrc`。**未**设置 `npm_config_offline`（本次需要联网装公开包）。

### 1.2 `DSH_HOME` 生效证据

`--version` 本身不建 profile，因此另用一次 `plugin list` 触发初始化：

```powershell
& $dsh --version
# 0.2.2-rc.1   rc=0

& $dsh plugin --profile mt-provider-acp list
# dsh: initialized profile mt-provider-acp at C:\Users\30673\AppData\Local\Temp\
#   mt-provider-install-20261110145203\dsh-home\profiles\mt-provider-acp
# rc=0
```

隔离核对：

| 检查 | 结果 |
| --- | --- |
| 隔离 home 下生成 `profiles\mt-provider-acp` | **True** |
| 真实 `C:\Users\30673\.dsh\profiles\mt-provider-acp` | **False** |
| 真实 `C:\Users\30673\.dsh\profiles` 下 `mt-*` 目录（清理后复查） | **0 个** |

初始化产物仅 `package.json`（183 B）、`cordis.patch.yml`（217 B）、`pnpm-workspace.yaml`（61 B）、`.plugin-manager`。

### 1.3 一次必须记录的副作用：pnpm store 没被 `npm_config_store_dir` 接管

第一次（acp）安装时 pnpm 打印：

```text
Content-addressable store is at: C:\Users\30673\AppData\Local\pnpm\store\v11
```

即 `npm_config_store_dir` 对 pnpm 无效。之后我改用 pnpm 自己的参数 `--store-dir <隔离根>\store-codex`，codex 安装的 store 才落到隔离目录（输出确认 `...\mt-provider-install-...\store-codex\v11`）。

**后果**：全局 pnpm store（`...\AppData\Local\pnpm\store\v11`）可能新增了 acp 相关的缓存对象（安装输出为 `reused 5 / downloaded 1`）。这是**只增的包缓存**，不在任何 profile 里、不改任何 manifest 或锁文件；但确实发生在隔离目录之外，如实记录。

---

## 2. 包元数据（npm registry 实查）

```bash
curl -s "https://registry.npmjs.org/@deepseek-ai%2Fdsh-subagent-acp"
curl -s "https://registry.npmjs.org/@deepseek-ai%2Fdsh-subagent-codex"
```

| 包 | `dist-tags.next` | `dist-tags.latest` | `latest` 发布时间 | `dsh.bundle` |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-subagent-acp` | `0.2.2-rc.1` | **`0.0.1-rc.1`** | 2026-08-10T19:42:58Z | **无**（`dsh` 字段整个为 `undefined`） |
| `@deepseek-ai/dsh-subagent-codex` | `0.2.2-rc.1` | **`0.0.1-rc.1`** | 2026-08-10T19:36:35Z | `{"bundle":{"patch":"./cordis.patch.yml"}}` |

`0.2.2-rc.1` 的依赖/peer（节选）：

| 包 | dependencies | peer（cordis 之外） |
| --- | --- | --- |
| acp | `@agentclientprotocol/sdk 1.4.0`、`dsh-brand 0.2.2-rc.1`、`schemastery ~3.19.0` | `dsh-llm` / `dsh-agent` / `dsh-session` / `dsh-timeout` / `dsh-subagent` / `dsh-subprocess`，全部 `0.2.2-rc.1` |
| codex | `@openai/codex 0.153.4`、`dsh-sdk-protocol 0.2.2-rc.1`、`dsh-tool-subagent 0.2.2-rc.1` | 同上六项 |

> 注意 codex 固定 `@openai/codex@0.153.4`（不是本机商店版 `0.167.0-alpha.3.2`），与 P0-03 的 F2「provider 自带 pinned CLI，不解析本机 PATH」一致。

**版本选择结论**：`latest` 指向 2026-08 的 `0.0.1-rc.1`，明显是旧线；必须显式用 `next` 或精确版本。生产配置建议 `@0.2.2-rc.1` 锁定，避免 `next` 随宿主升级漂移。

---

## 3. 实测 A：acp（不是 bundle）

### 3.1 安装

```powershell
& $dsh plugin --profile mt-provider-acp add '@deepseek-ai/dsh-subagent-acp@next'
```

关键输出（耗时 7,368 ms）：

```text
Packages: +6
dependencies:
+ @deepseek-ai/dsh-subagent-acp 0.2.2-rc.1
Done in 5.2s using pnpm v11.28.5
```

`rc=0`，同时 stderr 给出关键警告：

```text
dsh: warning: @deepseek-ai/dsh-subagent-acp declares no dsh.bundle - installed as a plain dependency, not a profile layer
```

（终端编码把破折号显示成 `â€?`，语义不变。）

### 3.2 profile 结果

`package.json`：

```json
{
  "name": "dsh-profile-mt-provider-acp",
  "private": true,
  "dependencies": { "@deepseek-ai/dsh-subagent-acp": "0.2.2-rc.1" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
```

`bundles` **没有**追加任何东西。

### 3.3 dump-config

```powershell
& $dsh --profile mt-provider-acp --dump-config   # rc=0，366 行
```

| 关键字 | 命中 |
| --- | --- |
| `acp`（不区分大小写，简易匹配） | **0** |
| `subagent` | 12 行，全部来自 `dsh-base` 的进程内 provider（`subagent`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`tool-subagent*`） |

**结论**：只装 acp 不会产生任何 provider 行，`ctx.subagents` 里不会出现 `acp`。

---

## 4. 实测 B：codex（是 bundle）

### 4.1 安装

```powershell
& $dsh plugin --profile mt-provider-codex add '@deepseek-ai/dsh-subagent-codex@next' --store-dir <隔离根>\store-codex
```

关键输出（耗时 **178,820 ms ≈ 2 分 59 秒**）：

```text
Packages: +10
dependencies:
+ @deepseek-ai/dsh-subagent-codex 0.2.2-rc.1
Done in 2m 57s using pnpm v11.28.5
```

`rc=0`。下载量来自 `@openai/codex` 的 Windows 原生二进制（安装后 `node_modules\@openai\` 下有 `codex`、`codex-win32-x64`）。

### 4.2 profile 结果

```json
"dependencies": { "@deepseek-ai/dsh-subagent-codex": "0.2.2-rc.1" },
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-subagent-codex"
] } }
```

包**自动**进入 `bundles`——与 acp 形成对照。

### 4.3 dump-config

```powershell
& $dsh --profile mt-provider-codex --dump-config   # rc=0，375 行（比 acp 多 9 行）
```

输出尾部原文：

```yaml
# == @deepseek-ai/dsh-subagent-codex
- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    maxDepth: provider-managed
```

（前三行来自 `# == ...` 层标记 + 两行 insert；config 三行来自包内 patch。）

包内 `cordis.patch.yml` 原文（2 个 insert，无 config 覆盖其他行）：

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: codex
        toolName: subagent_codex
        maxDepth: provider-managed
```

**结果**：codex 通道是「一条 `plugin add` 就完成」的形态；装上即注册 provider `codex` 并新增全局工具 `subagent_codex`（工具注册是行配置的直接结果，见包 README「The layer registers the provider and adds `subagent_codex` to every Agent as a global tool」）。

---

## 5. 实测 C：acp 手工挂行（官方 README 的路径）

acp 包内**没有** `cordis.patch.yml`，README 明确要求显式 mount。按官方示例写入临时 profile：

```yaml
- insert:
    - id: subagent-acp
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: acp
        command: node
        args: ['--version']
        permission: reject
```

```powershell
& $dsh plugin --profile mt-provider-acp-row add '@deepseek-ai/dsh-subagent-acp@next'   # rc=0
& $dsh --profile mt-provider-acp-row --dump-config                                     # rc=0
```

dump 尾部出现（原文）：

```yaml
# == C:\Users\30673\AppData\Local\Temp\mt-provider-install-20261110145203\dsh-home\profiles\mt-provider-acp-row\cordis.patch.yml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
```

即：**acp 的生效条件是「依赖装好 + 手写一行」两件事**，`plugin add` 只完成前半。

### 5.1 模块可解析（但不等于已注册）

```powershell
& $dsh --profile mt-provider-acp-row --dump-config-schema
# rc=0, 2,231 ms, 636,295 bytes
```

输出中该行状态为 `"status": "schema"`，并解析出 `"name": "@deepseek-ai/dsh-subagent-acp"`、`"configRef": "#/$defs/config67"`。这说明**运行时能 import 该包并读出它的 Config schema**，但**不证明 `apply()` 已执行、provider 已注册**。

---

## 6. 卸载实测

### 6.1 codex（bundle 形态）

```powershell
& $dsh plugin --profile mt-provider-codex remove '@deepseek-ai/dsh-subagent-codex' --store-dir <隔离根>\store-codex
# rc=0，pnpm 362 ms
```

| 检查 | 结果 |
| --- | --- |
| `package.json` 依赖 | 已消失 |
| `dsh.profile.bundles` | 回到 `["@deepseek-ai/dsh-base"]` |
| `--dump-config` | rc=0，366 行，`codex` 命中 **0** |
| `node_modules\@deepseek-ai` / `@openai` | 空目录 |
| `node_modules\.pnpm` | 0 项 |

### 6.2 acp（依赖形态）

```powershell
& $dsh plugin --profile mt-provider-acp remove '@deepseek-ai/dsh-subagent-acp'
# rc=0，pnpm 327 ms
```

`package.json` 回到只有 `dsh.profile.bundles: ["@deepseek-ai/dsh-base"]`；`--dump-config` 中 `acp` 命中 0。

**结论**：卸载命令就是 `dsh plugin --profile <name> remove <包名>`；对 bundle 会把层一起摘掉，对普通依赖只删依赖，dump 都不会残留。

---

## 7. 问题二：能不能查询「provider 已注册」

### 7.1 CLI 层：不能

`cli.js` 的命令面只有四种模式（`dsh/lib/bin.js` 原文）：

```js
case "profile":        // 启动 profile
case "plugin":         // 转发 pnpm（add / remove / ...）
case "dump-config":    // 打印组合后的树
case "dump-config-schema": // 打印 JSON Schema
```

没有任何 `agent` / `provider` / `subagent` 子命令；`--dump-config` 只打印**配置行**，不启动、不注册。

### 7.2 运行时：可以，两个入口

`docs/subsystems/subagent.md`（`fcc0ad4`，`ctx.subagents — SubagentRuntime`）给出：

```ts
/** Look up a provider by name. */
getProvider(name: string): SubagentProvider | undefined

/** Register a provider under its name. */
registerProvider(provider: SubagentProvider): () => void
```

事件（同文档）：

```ts
'subagent/provider-added'(provider: SubagentProvider): void
'subagent/provider-removed'(name: string): void
```

**建议的确认方式**（阶段 2 里派单前自查）：

```js
const provider = ctx.subagents?.getProvider('acp')   // 或 'codex'
if (!provider) throw new Error('PROVIDER_UNAVAILABLE')
```

目录里没有看到「列举全部 provider」的公开方法，只有按名查询 + 两个事件；所以「当前装了哪些 provider」需要自己维护已知名单再逐个 `getProvider`。

### 7.3 本次证据等级

| 层级 | 是否验证 | 依据 |
| --- | --- | --- |
| 包可下载、可安装、可进 manifest | ✅ | 两次 `plugin add` rc=0 + `package.json` |
| bundle 层可组合 | ✅ | codex `--dump-config` 出现新层与两行 |
| 模块可被运行时解析、schema 可读 | ✅ | `--dump-config-schema` 的 `"status": "schema"` |
| `apply()` 执行、`ctx.subagents.getProvider('codex')` 返回对象 | ❌ **未验证** | 需真正启动 profile；本次为安全边界内不做 |

---

## 8. acp 的 `command` 到底怎么写

### 8.1 字段（包 README 的配置表 + 源码 schema 双重印证）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `providerName` | string | `acp` | 在 `ctx.subagents` 上的注册名 |
| `command` | **string（必填）** | — | 子进程可执行文件，**不是数组** |
| `args` | string[] | `[]` | 参数单独放这里 |
| `permission` | `allow` \| `reject` | `reject` | 无人值守时自动答权限请求的方式 |
| `env` | `Record<string,string>` | `{}` | 显式环境变量，叠加在「已清洗凭据的父环境」之上 |
| `disposeEofGraceMs` | number | `6000` | stdin EOF 后的宽限 |
| `disposeGraceMs` | number | `3000` | 终止/观察宽限 |

源码证据（包内 `lib/index.js:443-448`）：

```js
providerName: z.string().default("acp"),
command: z.string().required(),
args: z.array(...),           // 上方 schema 区默认 []
permission: z.union(["allow", "reject"]).default("reject"),
```

### 8.2 cwd 怎么配：**没有 cwd 字段**

README 原文：「Startup uses the manager-resolved child directory (the request override, else the parent's current effective directory)」。

也就是：**子进程工作目录由父会话的当前有效目录决定**，配置里不能写死；要限定目录得在派单请求侧解决（属 P2-03/P2-08 的编排范围）。

### 8.3 官方示例（原样摘录）

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
    command: dsh
    args: ['--profile', 'acp', '--patch', '/absolute/path/to/acp.patch.yml']
    permission: reject
    env:
      DSH_HOME: /absolute/path/to/isolated-child-home
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

要点：

1. `command: dsh` 是**一个可执行名**，参数全在 `args`；
2. 驱动 DSH 子实例时，`args` 里显式给 `--profile` 与 `--patch`，并强制 `DSH_HOME` 指向隔离 home（官方警告：否则子实例会发现启动者的 profile 与凭据）；
3. 凭据通过 `env` 显式传（父环境默认被清洗）。

### 8.4 映射到 CodeBuddy（未验证）

按 P0-04 的结论，CodeBuddy 的无头入口在本机非 TTY 下会崩（`-p` / `--acp` 都 exit 1），所以「`command: codebuddy` + `args: [--acp]`」**本次没有验证，也不能写进产品默认值**。acp 通道本身只要求「一个说 ACP 的可执行文件」，具体命令属于角色配置，需在 P2 用真实 CLI 复测后填。

---

## 9. 风险与副作用

| 风险 | 实测结果 | 结论 |
| --- | --- | --- |
| 污染真实 desktop profile | 全程 `DSH_HOME` 指向临时目录；真实 `package.json` 515 B、mtime `2026-11-09 16:07:20`、SHA-256 `E3566CC8…FECE7C64`、7 个 bundle 与阶段 0 记录一致；真实 `profiles` 下无 `mt-*` | **无影响** |
| 拉入大量依赖 | codex `+10` 包、安装 2 分 57 秒、store 382.3 MB（含 Windows 原生 codex 二进制）；acp `+6` 包、profile 5.6 MB | codex 体积显著，安装需网络与磁盘预算 |
| 共享包版本漂移（cosmokit 双版本） | provider 带入 `cosmokit 1.9.0`、`schemastery 3.19.0`，**与宿主 `sharedPackages` 完全一致**（宿主同为 1.9.0 / 3.19.0） | 隔离 profile 内**无冲突**；但真实 desktop profile 目前是有 `cosmokit 1.8.6` + `schemastery 3.18.5`（cliworker 带入）的，若把 provider 装进 desktop，pnpm 需要升级/去重这两个包 —— **必须先在隔离环境验证，不能直接装 desktop** |
| 全局 pnpm store 被写入 | 第一次安装未带 `--store-dir`，pnpm 使用 `C:\Users\30673\AppData\Local\pnpm\store\v11`（`npm_config_store_dir` 无效） | 只增缓存；后续用 `--store-dir` 已隔离。生产脚本应显式传 `--store-dir` |
| 网络依赖 | 全程需要访问 `registry.npmjs.org`（全部成功，无重试） | 离线环境无法安装 |
| `desktop` profile 保护 | CLI 源码中 `rejectElectronProfile` 对普通 CLI 生效；但 Desktop 自带 CLI 以 `manageDesktopProfile: true` 运行，**理论上可管理 desktop** | 任何安装脚本都必须显式设置 `DSH_HOME`，不能依赖 CLI 拒绝 |

---

## 10. 清理记录

删除对象只有本次创建的临时根目录，包含：

- `dsh-home\`（3 个 profile：`mt-provider-acp`、`mt-provider-codex`、`mt-provider-acp-row`）
- `store-codex\`（382 MB pnpm store）
- 4 份 dump 文本、1 份 schema JSON、2 个空 npmrc

删除命令与结果（14:58:53 前后）：

```powershell
Remove-Item -LiteralPath 'C:\Users\30673\AppData\Local\Temp\mt-provider-install-20261110145203' -Recurse
# 退出 0，耗时 204 ms，删除前共 1262 个文件/目录项
```

复查（原文）：

```text
ROOT_EXISTS=False
REAL_MT_PROFILES=0
LEFTOVER=0
```

**未删除**、也不应删除的：真实 `C:\Users\30673\.dsh`（desktop profile 及其余目录）、全局 pnpm store（只增缓存，无安全方式精确回滚，已如实登记）。

---

## 11. 阶段 2 结论

| 项 | 结论 |
| --- | --- |
| 能不能用 | **能装、能组合**；`codex` 是开箱可用的 bundle，`acp` 需要额外一行。运行时注册尚未实测（缺一次真实启动） |
| 用哪个版本 | `next` = `0.2.2-rc.1`；**生产写精确版本** `@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1` / `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.1`。不要用 `latest`（`0.0.1-rc.1`） |
| codex 安装命令 | `dsh plugin --profile <p> add @deepseek-ai/dsh-subagent-codex@0.2.2-rc.1 --store-dir <隔离store>` |
| acp 安装命令 | ① `dsh plugin --profile <p> add @deepseek-ai/dsh-subagent-acp@0.2.2-rc.1`；② 在 `<profiles>\<p>\cordis.patch.yml` 插入 `subagent-acp` 行（见 §8.3） |
| acp command 形态 | `command` 是**单个可执行字符串**，参数放 `args` 数组；**无 cwd 字段**（子进程用父会话当前目录）；`env` 是显式映射，覆盖在凭据清洗后的父环境上 |
| 给最终用户的卸载命令 | `dsh plugin --profile <p> remove @deepseek-ai/dsh-subagent-codex` / `... remove @deepseek-ai/dsh-subagent-acp` |
| 产品侧判定 | codex/acp 通道走「让用户在自己的 profile 里装 provider」是**可行**的；插件不必自带 provider。**但** acp 需要插件帮用户写/校验那一行配置，否则装了也不生效——这是 P2 编排必须处理的差异 |

---

## 12. 未验证项

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `apply()` 后 `ctx.subagents.getProvider('codex'/'acp')` 返回非空 | **未验证** | 需启动完整 profile；本次只做安装/组合/卸载，未启动 app |
| `subagent_codex` 工具在真实会话里可调用 | **未验证** | 同上，且需要模型凭据 |
| acp + CodeBuddy 的真实握手 | **未验证** | CodeBuddy 无头入口在 P0-04 已崩；本次未重复尝试 |
| `@latest`（0.0.1-rc.1）安装会怎样 | **未验证** | 仅据 registry 元数据判断已过时，未实际安装旧版 |
| 装进真实 desktop profile 的依赖去重行为 | **未验证** | 按安全边界禁止；仅在隔离 profile 观察到 1.9.0/3.19.0 |
| `--dump-config-schema` 是否会触发模块顶层副作用 | **未验证** | 只观察到 rc=0 与 schema 输出，未审计该包的顶层代码 |
