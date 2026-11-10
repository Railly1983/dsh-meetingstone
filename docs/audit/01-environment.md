# 01 · 环境与版本清单（P0-01）

| 项 | 值 |
| --- | --- |
| 采集时间 | 2026-11-10 13:20–13:25（UTC+08:00） |
| 采集人 | 沙僧（CodeBuddy CLI 会话，模型 `deepseek-v4.1-flash`） |
| 宿主版本 | DeepSeek Harness `0.2.2-rc.1`（`hostProtocolVersion: 4`，更新通道 `nightly`） |
| 采集方式 | 只读命令探测（PowerShell / node 读取 asar 头），未安装、未修改任何被测对象 |
| 证据规矩 | 遵循 `docs/audit/README.md`：命令 + 关键输出片段 + 日期；拿不到写「未验证」 |

> 本文件**不含任何凭据内容**。凡涉及 token / API key / 登录态，只记录「文件存在与否」和文件名。

---

## 1. 操作系统

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| 产品名 | Microsoft Windows 11 家庭中文版 | `osName: Microsoft Windows 11 家庭中文版 中文版`（`Get-ComputerInfo`） |
| 注册表 ProductName | `Windows 10 Home China`（Win11 沿用的旧字段，非实际版本） | `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion` → `ProductName` |
| 版本号 / 功能更新 | `25H2`（`DisplayVersion`） | 同上注册表 → `DisplayVersion` |
| 内部版本 | `26200.9711`（`CurrentBuild` 26200 + `UBR` 9711） | 同上 |
| `WindowsVersion` | `2009`（DSH/应用兼容性用的版本标识） | `Get-ComputerInfo -Property WindowsVersion` |
| 架构 | x64（`AMD64`，64 位操作系统） | `[Environment]::Is64BitOperatingSystem = True`，`PROCESSOR_ARCHITECTURE = AMD64` |
| OSVersion 字符串 | `Microsoft Windows NT 10.0.26200.0` | `[System.Environment]::OSVersion.VersionString` |

证据命令（2026-11-10）：

```powershell
Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsBuildNumber,OsArchitecture
# WindowsProductName : Windows 10 Home China
# WindowsVersion     : 2009
# OsBuildNumber      : 26200
# OsArchitecture     : 64 位

Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" |
  Select-Object ProductName,DisplayVersion,CurrentBuild,UBR,EditionID
# ProductName    : Windows 10 Home China
# DisplayVersion : 25H2
# CurrentBuild   : 26200
# UBR            : 9711
# EditionID      : CoreCountrySpecific
```

> 注：`EditionID = CoreCountrySpecific` 表示“家庭中文版”这一特定 SKU，与企业版/专业版的组策略能力不同（对 P0-08 沙箱实测有影响）。

---

## 2. DSH 宿主

### 2.1 安装与版本

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| 安装路径 | `C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\` | `Get-ChildItem` 成功列出 `DeepSeek Harness.exe`(246,343,656 B)、`resources\`、`locales\` 等 |
| 发行形态 | Windows 桌面版（Electron 打包：`chrome_*.pak`、`icudtl.dat`、`v8_context_snapshot.bin`、`snapshot_blob.bin`） | 同上目录清单 |
| `resources\version` | `44.7.0` | `Get-Content resources\version` → `44.7.0`（文件 6 字节） |
| 主程序文件版本 | `FileVersion 0.2.2-rc.1`，`ProductVersion 0.2.2.0` | `(Get-Item "...\DeepSeek Harness.exe").VersionInfo` |
| 公司名 | `Hangzhou DeepSeek Artificial Intelligence Co., Ltd.` | 同上 |
| 进程状态 | 正在运行（11 个 `DeepSeek Harness` 进程，主进程 2026-11-9 15:43 启动，13:22 有新子进程） | `Get-Process -Name "DeepSeek Harness"` |

> **版本口径差异**：`resources\version` 里的 `44.7.0` 与 `DeepSeek Harness.exe` 的 `FileVersion 0.2.2-rc.1` 不是同一个版本号。`44.7.0` 更像外壳/运行时构建号，`0.2.2-rc.1` 是 DSH 应用版本，且与内部发布清单的 `release.version` 完全一致（见 2.2）。产品侧展示应使用 `0.2.2-rc.1`。

### 2.2 发布清单（含 hostProtocolVersion / nodeVersion / pnpmVersion）

**已定位到**，位于 `app.asar` 内部第一个条目：`dsh/desktop-runtime.json`（未压缩，4,942,461 字节）。

| 项 | 值 |
| --- | --- |
| 物理文件 | `C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` |
| asar 内路径 | `dsh/desktop-runtime.json`（offset 0，紧跟 asar header 之后） |
| 读取方式 | node 解析 asar 头（`readUInt32LE(12)` 取 header size），再按 `files.dsh.files['desktop-runtime.json']` 的 offset/size 读取 |

清单中 `release` 段实测：

```json
{
  "schemaVersion": 1,
  "release": {
    "schemaVersion": 1,
    "version": "0.2.2-rc.1",
    "hostProtocolVersion": 4,
    "nodeVersion": "24.21.0",
    "pnpmVersion": "11.28.5"
  },
  "platform": "win32",
  "arch": "x64",
  "sharedPackages": [ ... 329 条 ... ]
}
```

| 协议/运行时项 | 值 |
| --- | --- |
| `hostProtocolVersion` | **4** |
| `nodeVersion` | **24.21.0** |
| `pnpmVersion` | **11.28.5** |
| `release.version` | **0.2.2-rc.1** |
| `platform` / `arch` | `win32` / `x64` |
| `sharedPackages` 条目数 | 329（宿主共享的 `@deepseek-ai/*` 包及其版本，插件 peer 依赖由此解析） |

另有 `resources\runtime\versions.json`（更小的运行时版本表）：

```json
{ "schemaVersion": 1, "node": "24.21.0", "pnpm": "11.28.5" }
```

### 2.3 更新通道

`resources\app-update.yml` 全文（306 B）：

```yaml
provider: generic
url: https://download.deepseek.com/dsh-desk/feeds/win-x64/
channel: nightly
updaterCacheDirName: '@deepseek-aidsh-desktop-updater'
publisherName:
  - CN=Hangzhou\20DeepSeek\20Artificial\20Intelligence\20Co.\2c\20Ltd.,...
```

| 项 | 值 |
| --- | --- |
| channel | `nightly` |
| feed url | `https://download.deepseek.com/dsh-desk/feeds/win-x64/` |
| 更新 provider | `generic` |
| updater 缓存目录名 | `@deepseek-aidsh-desktop-updater` |
| 签名主体 | Hangzhou DeepSeek Artificial Intelligence Co., Ltd.（CN） |

> nightly + `0.2.2-rc.1` = 预发布版本，**宿主 API 漂移风险成立**（对应计划 R6）。

### 2.4 宿主自带 CLI 入口（顺带发现）

`resources\runtime\cli\bin\dsh.cmd` 存在，内容是把参数转发给 `DeepSeek Harness.exe --expose-internals app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`：

```bat
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

但 `where.exe dsh` 退出码 1（**不在 PATH**）。详见第 5 节。

---

## 3. 活动 profile（`C:\Users\30673\.dsh\profiles\desktop\`）

### 3.1 目录概览

| 名称 | 类型 | 最后修改 | 说明 |
| --- | --- | --- | --- |
| `node_modules\` | 目录 | 2026-11-09 14:24 | 插件实际安装位置 |
| `.plugin-manager\logs\` | 目录 | 2026-11-09 16:07 | 插件安装/卸载操作日志（10 个 operation-* 目录） |
| `cordis.yml` | 文件 223 B | 2026-11-09 15:43 | 根条目列表，实测为 `[]` |
| `cordis.patch.yml` | 文件 801 B | 2026-11-09 12:41 | 用户补丁层（见 3.4） |
| `package.json` | 文件 515 B | 2026-11-09 16:07 | 依赖 + bundle 列表 |
| `pnpm-lock.yaml` | 文件 3,956 B | 2026-11-09 16:07 | 锁定 2 个直接依赖 |
| `pnpm-workspace.yaml` | 文件 115 B | 2026-10-24 | `nodeLinker: hoisted`、`autoInstallPeers: false` |
| `cordis.patch.yml.bak-*` | 3 个备份 | 2026-10/11 | 历史补丁备份（未改动） |
| `package.json.bak-20261108-072259` | 备份 282 B | 2026-11-08 | 历史 package.json 备份（未改动） |

### 3.2 `package.json` 全文实测

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-cliworker-now": "^0.8.7",
    "dsh-remote-plugin": "0.8.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-terminal-bundle",
        "@deepseek-ai/dsh-experimental-tool-worktree",
        "dsh-remote-plugin",
        "@deepseek-ai/dsh-experimental-session-titles-bundle",
        "dsh-cliworker-now"
      ]
    }
  }
}
```

| # | bundle | 来源 | 宿主侧版本（取自 `sharedPackages`） |
| --- | --- | --- | --- |
| 1 | `@deepseek-ai/dsh-base` | 官方 `@deepseek-ai/` | `0.2.2-rc.1` |
| 2 | `@deepseek-ai/dsh-web-app` | 官方 | `0.2.2-rc.1` |
| 3 | `@deepseek-ai/dsh-experimental-terminal-bundle` | 官方（experimental） | `0.2.2-rc.1` |
| 4 | `@deepseek-ai/dsh-experimental-tool-worktree` | 官方（experimental） | `0.2.2-rc.1` |
| 5 | `dsh-remote-plugin` | **第三方**（未加 scope） | 不在 sharedPackages，装于 profile `node_modules`（`0.8.0`） |
| 6 | `@deepseek-ai/dsh-experimental-session-titles-bundle` | 官方（experimental） | `0.2.2-rc.1` |
| 7 | `dsh-cliworker-now` | **第三方**（未加 scope） | 不在 sharedPackages，装于 profile `node_modules`（`0.8.7`） |

> 观察：官方 bundle 没有装进 profile 的 `node_modules`，而是从宿主 `sharedPackages`（asar 内）解析；只有第三方插件才落在 profile 目录里。这对 P0-02（bundle 打包形态）和 P0-07（配置落点）是重要事实。

### 3.3 `cordis.yml`

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

结论：**插件启用/禁用不写在 `cordis.yml`**，而是由「bundle 顺序叠加 + `cordis.patch.yml` 覆盖」组合而成。

### 3.4 `cordis.patch.yml` 中与启停相关的条目

| `id` | `name` | 关键 config | 启停含义 |
| --- | --- | --- | --- |
| `ui-settings-account` | `@deepseek-ai/dsh-client-ui-settings-account` | `step: done`、`completion: skipped`、`usage: compact` | 账号设置页已走完引导步骤 |
| `ui-chat` | `@deepseek-ai/dsh-client-ui-chat` | `transcriptView: standard`、`performanceUsage: compact` | 聊天 UI 默认视图/性能档 |
| `ui-settings` | `@deepseek-ai/dsh-client-ui-settings` | **`enabled: false`** | ⚠️ **`ui-settings` 被显式禁用** |
| `agent-default-model` | `@deepseek-ai/dsh-agent-default-model` | `provider: deepseek-account`、`model: deepseek-flash` | 默认模型通道（注意：不是 v4.1-flash） |

> ⚠️ 对后续任务的影响：`ui-settings` 被 `enabled: false` 关掉，意味着**当前 profile 上原生 Settings 面板不启用**。P0-07（Settings 扩展路径）与 P1-04（Settings 页最小可见）必须先确认这个禁用是用户手动关的还是可恢复的，否则「设置页入口」这条路走不通。此处仅记录事实，未做结论。

### 3.5 已安装包（直接相关）

`node_modules` 顶层：`.bin`、`.pnpm`、`@deepseek-ai`、`@linxin666`、`@nanmicoder`、`@standard-schema`、`@xterm`、`dsh-cliworker-now`、`dsh-remote-plugin`、`yaml`、`zod`。

| 包名 | 版本 | 官方范围（`@deepseek-ai/`） | 角色 | 证据 |
| --- | --- | --- | --- | --- |
| `dsh-cliworker-now` | **0.8.7** | ❌ 第三方（无 scope） | 本项目 clean-room 隔离对象；开发期派单工具 | `package.json` → `version: 0.8.7`；`pnpm-lock.yaml` 锁定 `0.8.7` |
| `dsh-remote-plugin` | **0.8.0** | ❌ 第三方（无 scope，仓库 `Blank-not-black/dsh-Remote`，MIT） | 侧边栏远程控制插件 | `package.json` 实测 `0.8.0` |
| `@deepseek-ai/cosmokit` | 1.8.6 | ✅ 官方 | cliworker 的间接依赖 | `package.json` → `1.8.6`（注意：宿主 sharedPackages 里是 `1.9.0`，存在双版本） |
| `@deepseek-ai/schemastery` | 3.18.5 | ✅ 官方 | 配置 schema 库 | `package.json` → `3.18.5` |
| `@xterm/xterm` | 6.0.0 | ❌ 第三方 | cliworker 终端 UI 依赖 | `.modules.yaml` hoistedLocations |
| `@xterm/addon-fit` | 0.11.0 | ❌ 第三方 | 同上 | 同上 |
| `@standard-schema/spec` | 1.1.0 | ❌ 第三方 | schemastery 依赖 | 同上 |
| `yaml` | 2.9.1 | ❌ 第三方 | YAML 解析 | 同上 |
| `zod` | 4.4.3 | ❌ 第三方 | 校验库 | 同上 |

- `@linxin666`、`@nanmicoder` 两个 scope 目录**当前为空**（`Get-ChildItem -Force` 无输出），属于已卸载插件的残留空目录。
- `dsh-cliworker-now` 的 `dsh` 元数据（对 P0-02 有参考价值）：`bundle.patch = ./cordis.patch.yml`，`client.platform = web`，`client.inject` 列出 12 个官方 UI/API 包（`dsh-client-ui-subagent`、`dsh-api-session-controller` 等）。
- `dsh-cliworker-now` 声明的 engines：`node: >=22.19.0`；peer：`@deepseek-ai/cordis: 4.0.4 || 4.0.5 || ~4.1.0`（宿主为 `4.1.0`，满足）。

### 3.6 插件安装/卸载历史（`.plugin-manager\logs` 只读摘录）

| 时间 | operation | 日志关键行 | 结论 |
| --- | --- | --- | --- |
| 2026-11-08（目录 mtime） | `operation-VTewRx` | `+ dsh-cliworker-now 0.8.7` | 安装 cliworker |
| 2026-11-09 14:24 | `operation-fLw5iZ` | `+ @nanmicoder/dsh-agent-teams 0.1.29` | **曾安装第三方 agent-teams 插件** |
| 2026-11-09 16:07 | `operation-cr6lnI` | `- @nanmicoder/dsh-agent-teams 0.1.29` / `Already up to date` | **已于同日卸载**，当前不在依赖清单 |

> 这条对 P0-05 有直接影响：本机曾用第三方 `@nanmicoder/dsh-agent-teams@0.1.29`做 Agent Teams 尝试，但已卸载；现在 profile 里没有任何 agent-team 插件。

---

## 4. 运行时

### 4.1 DSH 主运行时（`C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\`）

`runtime.json` 全文（598 B）：

```json
{
  "desktopVersion": "0.2.2-rc.1",
  "platform": "win32",
  "arch": "x64",
  "payloadDigest": "0881fbf6…55907374f",
  "python": "3.12.14",
  "node": "24.21.0",
  "pnpm": "11.28.5",
  "pythonPackages": {
    "numpy": "2.3.5", "pandas": "3.0.1", "python-dateutil": "2.9.0.post0",
    "six": "1.17.0", "tzdata": "2025.2", "python-docx": "1.2.0",
    "python-pptx": "1.0.2", "openpyxl": "3.1.5", "Pillow": "12.3.0",
    "lxml": "6.1.3", "XlsxWriter": "3.2.9", "typing_extensions": "4.16.0",
    "et_xmlfile": "2.0.0"
  }
}
```

| 项 | 值 |
| --- | --- |
| desktopVersion | `0.2.2-rc.1`（与宿主一致） |
| node | `24.21.0` |
| pnpm | `11.28.5` |
| python | `3.12.14`（附 13 个预装包：numpy / pandas / python-docx / openpyxl 等） |
| 目录结构 | `dependencies\{node,pnpm,python}`；`node\bin\node.exe` 93,580,104 B |

### 4.2 node / npm / pnpm 实测（含关键坑）

| 工具 | 路径 | 版本 | 在 PATH | 证据 |
| --- | --- | --- | --- | --- |
| node（系统） | `C:\Program Files\nodejs\node.exe` | **v20.16.0** | ✅ | `Get-Command node` → 该路径；`node --version` → `v20.16.0` |
| npm | `C:\Program Files\nodejs\npm.cmd` | **10.8.1** | ✅ | `npm --version` |
| node（DSH 内置） | `C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` | **v24.21.0** | ❌ | `& <该路径> --version` → `v24.21.0` |
| pnpm（DSH 内置） | `…\dependencies\pnpm\bin\pnpm.mjs` | **11.28.5** | ❌（`where.exe pnpm` 退出码 1） | 见下方两条命令对比 |
| corepack | `C:\Program Files\nodejs\corepack.cmd` | 未采集 | ✅ | `where.exe corepack` 命中 |

**⚠️ 重要：DSH 的 pnpm 不能直接用系统 node 跑。** 用系统 node v20.16.0 执行时失败：

```powershell
node "C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" --version
# warn: This version of pnpm requires at least Node.js v22.13
# warn: The current version of Node.js is v20.16.0
# Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
# Exit Code: 1
```

换成 DSH 内置 node 才成功：

```powershell
& "C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" --version
# 11.28.5
```

**结论（会直接影响 P1-02 构建链）**：项目构建必须锁定「DSH 内置 node 24.21.0 + 内置 pnpm 11.28.5」这一组，或自行安装 ≥22.13 的 node；直接用系统 node 20 + 内置 pnpm 会硬失败。另注：`resources\runtime\bin\node(.cmd)` 只是转发到 `$DSH_DESKTOP_NODE_EXECUTABLE` 的 shim（脚本内容已核对），依赖 DSH 注入的环境变量，不能独立运行。

---

## 5. 本机 CLI

### 5.1 Codex

| 项 | 值 |
| --- | --- |
| 怎么找到的 | `Get-AppxPackage -Name "OpenAI.Codex*"` → 取 `InstallLocation`，再拼 `app\resources\codex.exe` |
| 可执行文件 | `C:\Program Files\WindowsApps\OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`（同目录另有 GUI 入口 `app\Codex.exe`） |
| 版本 | **`codex-cli 0.167.0-alpha.3.2`** |
| 是否在 PATH | **否**（`where.exe codex` 退出码 1；`$env:PATH` 中无任何含 `codex` 的条目） |
| 包形态 | Windows 商店应用（ChatGPT 桌面版内置 CLI） |

实测两个相关 Appx 包：

| 包名 | 版本 | InstallLocation |
| --- | --- | --- |
| `OpenAI.Codex` | `26.1103.7773.0` | `C:\Program Files\WindowsApps\OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0` |
| `OpenAI.CodexPrimaryRuntime` | `26.1105.1297.0` | `C:\Program Files\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1105-1297-0_26.1105.1297.0_x64__3k8sg7r9htsxt`（该包内**未找到** `codex.exe`） |

> 说明：`OpenAI.CodexPrimaryRuntime` 是第二个包，且版本号（`26.1105.1297.0`）高于主包（`26.1103.7773.0`）——这两个包是独立升级的，进一步印证「商店应用路径必须运行时解析」。

### 5.2 CodeBuddy

| 项 | 值 |
| --- | --- |
| 怎么找到的 | `Get-Command codebuddy` / `where.exe codebuddy` |
| 可执行文件 | `C:\Users\30673\AppData\Roaming\npm\codebuddy.cmd`（另有 `codebuddy`、`codebuddy.ps1`） |
| 版本 | **`2.181.0`** |
| 是否在 PATH | **是**（`where.exe codebuddy` 命中 `…\npm\codebuddy` 与 `…\npm\codebuddy.cmd`） |
| 来源 | npm 全局：`npm ls -g --depth=0` → `@tencent-ai/codebuddy-code@2.181.0` |

同目录还有 `codebuddy-code`、`codebuddy-lowmem`、`codebuddy-code.cmd/.ps1`、`codebuddy-lowmem.cmd/.ps1` —— 共 4 个入口脚本，选择哪个由调用方决定（目前未验证低内存版差异）。

### 5.3 Claude Code

| 项 | 值 |
| --- | --- |
| 怎么找到的 | 四路确认：`Get-Command claude`、`where.exe claude`、`npm ls -g --depth=0`、`~/.claude` 目录；另查 `~/.local\bin` 与 `%APPDATA%\npm\node_modules` 下的 `claude*` |
| 可执行文件 | **未找到** |
| 版本 | **未安装**（无法采集版本） |
| 是否在 PATH | 否（`where.exe claude` 退出码 1） |
| 确认过程 | ① `Get-Command claude -ErrorAction SilentlyContinue` → 空；② `where.exe claude` → 退出码 1；③ `npm ls -g --depth=0` 只有 `@tencent-ai/codebuddy-code@2.181.0` 与 `mi-note-cli@0.3.1`，无 `@anthropic-ai/claude-code`；④ `%APPDATA%\npm` 下无 `claude*` 文件；⑤ `~\.local\bin` 只有 `env`/`uv*` |
| 历史痕迹 | `~/.claude\.last-update-result.json`：`{"timestamp":"2026-09-12T09:15:15.243Z","path":"npm-global","outcome":"failed","status":"install_failed","version_from":"2.1.266","version_to":"2.1.269","error_code":"update_apply_exe_locked"}` |

> 结论：Claude Code **当前不可用**；`~/.claude` 里的配置与历史会话是旧版本残留，不能当作“已安装”。

### 5.4 DSH 原生 CLI 入口

| 项 | 值 |
| --- | --- |
| 独立可执行文件 | 无（`where.exe dsh` 退出码 1） |
| 但是 | `resources\runtime\cli\bin\dsh.cmd` 存在（243 B），转发到 `dsh-desktop-host\lib\cli.js` |
| 是否在 PATH | **否** |
| 实测是否可用 | **未验证**（未执行该 `.cmd`，避免产生副作用；仅读了脚本内容） |

> 与计划「无独立可执行文件」的说法需要修正为：**存在一个未加入 PATH 的宿主内 CLI 转发脚本**，能力边界待 P0-04 决定是否验证。

### 5.5 CLI 探测结论（可直接用于 P0-04 的探测链设计）

| CLI | PATH | Appx | npm 全局 | 常见目录 | 最终结论 |
| --- | --- | --- | --- | --- | --- |
| codex | ❌ | ✅ `OpenAI.Codex` | ❌ | — | 已安装，需走 Appx 解析 |
| codebuddy | ✅ | — | ✅ | — | 已安装，PATH 直取 |
| claude | ❌ | ❌ | ❌ | ❌（`~/.local/bin` 无） | 未安装 |
| dsh | ❌ | — | — | 宿主 resources 内有转发脚本 | 入口存在但不可直达 |

---

## 6. 用户配置目录（只记存在性，未读取任何凭据内容）

| 目录 | 存在 | 顶层子目录 | 顶层文件（仅文件名） |
| --- | --- | --- | --- |
| `C:\Users\30673\.codex` | ✅ | `.sandbox`、`.sandbox-bin`、`.sandbox-secrets`、`.tmp`、`archived_sessions`、`cache`、`computer-use`、`log`、`node_repl`、`pets`、`plugins`、`project-metadata-locks`、`sessions`、`skills`、`sqlite`、`thread-writer-locks`、`tmp`、`vendor_imports`、`visualizations`（19 个） | `.codex-global-state.json`、`.sandbox_migration`、`auth.json`、`auth.json.lock`、`auth.lock`、`cap_sid`、`config.toml`、`goals_1.sqlite`、`installation_id`、`logs_2.sqlite(+shm/wal)`、`memories_1.sqlite`、`models_cache.json`、`models_cache.codex_work_desktop.json`、`queue_1.sqlite(+shm/wal)`、`session_index.jsonl(+lock)`、`state_5.sqlite`、`thread_history_1.sqlite(+shm/wal)`、`.codex-provisioning-*.guard`、`.sqlite-maintenance.lock` |
| `C:\Users\30673\.claude` | ✅ | `backups`、`cache`、`file-history`、`plugins`、`projects`、`session-env`、`sessions`、`shell-snapshots`、`skills`、`tasks`、`telemetry`（11 个） | `.claude.json.test-leftover`、`.last-cleanup`、`.last-update-result.json`、`history.jsonl`、`settings.claude.json`、`settings.deepseek.json`、`settings.json`、`settings.json.bak-20261031` |
| `C:\Users\30673\.codebuddy` | ✅ | `app`、`channels`、`debug`、`diagnostics`、`file-history`、`local_storage`、`logs`、`plugins`、`projects`、`sessions`、`shell-snapshots`、`skills`、`tasks`、`traces`（14 个） | `settings.json`、`user-state.json`、`web-ui-port.json` |
| `C:\Users\30673\.dsh` | ✅ | `attachments`、`cache`、`cliworker-now`、`dsh-runtimes`、`llm-deepseek`、`profiles`、`sessions`、`storages`（8 个） | `.anonymous-user-id`、`.credentials.yaml` |

**凭据文件（仅记录存在，内容未读取、未记录）**：

| 文件 | 状态 |
| --- | --- |
| `~/.codex/auth.json` | 存在（2026-11-08 修改） |
| `~/.dsh/.credentials.yaml` | 存在（2026-10-12 修改） |
| `~/.claude/settings.json` 及 `settings.deepseek.json` / `settings.claude.json` | 存在（内容未读） |
| `~/.codebuddy/settings.json` / `user-state.json` | 存在（内容未读） |

> 以上全部按纪律处理：只写「存在 + 文件名 + 修改时间」，**未打开、未摘抄任何一行内容**。

---

## 7. 开发工具

| 工具 | 版本 | 路径 | 在 PATH |
| --- | --- | --- | --- |
| git | **2.54.0.windows.1** | `C:\Program Files\Git\cmd\git.exe` | ✅ |
| node | v20.16.0（系统） / v24.21.0（DSH 内置） | 见 4.2 | 系统版 ✅ / 内置版 ❌ |
| npm | 10.8.1 | `C:\Program Files\nodejs\npm.cmd` | ✅ |
| pnpm | 11.28.5（DSH 内置） | `…\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs` | ❌ |
| corepack | 未采集 | `C:\Program Files\nodejs\corepack.cmd` | ✅ |

工作区与仓库状态（顺带核对）：

| 项 | 值 |
| --- | --- |
| 工作目录 | `D:\MeetingStone` |
| 是否 git 仓库 | 是（`git rev-parse --is-inside-work-tree` → `true`） |
| 提交 | `4cefcac docs: 审计目录约定`；`ea7561d chore: 建立仓库骨架与阶段 0 基线` |
| 顶层内容 | `.git\`、`docs\`、`.gitignore`、`LICENSE`、`README.md` |

---

## 8. 未验证 / 未采集项

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `resources\runtime\cli\bin\dsh.cmd` 实际能力（help/子命令） | **未验证** | 只读了脚本内容，未执行（避免副作用） |
| codex 登录态是否有效 | **未验证** | 属凭据范畴，只读探测不进入 |
| `@nanmicoder/dsh-agent-teams@0.1.29` 的能力 | **未验证** | 已卸载，包文件不在本机 |
| Windows 商店应用 `OpenAI.CodexPrimaryRuntime` 的作用 | **未验证** | 包内无 `codex.exe`，用途未确认 |
| Electron 内核版本 | **未采集** | 任务未要求；如需可从 `app.asar` 内 `package.json` 或 `chrome_*.pak` 推断 |
| `~/.dsh/cliworker-now/settings-catalogs/` 内容 | **未采集** | 属 P0-04 模型矩阵，本任务不涉及 |

---

## 9. 与开发计划的差异

对照 `docs/开发计划.md` 第 2 节（2026-11-10 基线），逐条列出实测差异：

| # | 计划中的说法（第 2 节） | 本次实测 | 性质 |
| --- | --- | --- | --- |
| D-1 | 桌面外壳版本 `44.7.0`（`resources\version`） | `resources\version` 确是 `44.7.0`；但 `DeepSeek Harness.exe` 的 `FileVersion = 0.2.2-rc.1`，内部发布清单 `release.version = 0.2.2-rc.1` | **口径需修正**：`44.7.0` 不是产品版本；对外应报 `0.2.2-rc.1`，`44.7.0` 只是外壳构建号 |
| D-2 | 宿主协议 `hostProtocolVersion: 4`、`nodeVersion: 24.21.0`、`pnpmVersion: 11.28.5` | 完全一致（`app.asar` → `dsh/desktop-runtime.json`） | 一致（并已补上清单物理路径） |
| D-3 | 更新通道 `nightly`，feed `download.deepseek.com/dsh-desk/feeds/win-x64/` | 一致；另补充 `provider: generic`、签名主体、updater 缓存目录名 | 一致（有补充） |
| D-4 | 已启用 bundles 共 7 个（列表一致） | 一致；另查清「官方 bundle 不在 profile `node_modules`，从宿主 `sharedPackages` 解析；第三方才落盘」 | 一致（有补充） |
| D-5 | 第三方插件 `dsh-cliworker-now@0.8.7`、`dsh-remote-plugin@0.8.0` | 一致（版本已核实） | 一致 |
| D-6 | 「`@deepseek-ai/dsh-experimental-agent-team` 未出现在当前 profile」 | profile 里确实没有；但**宿主 `sharedPackages` 里已随附 `@deepseek-ai/dsh-experimental-agent-team@0.2.2-rc.1`**（329 条共享包之一） | **需修正**：不是“不存在”，而是“宿主已具备、profile 未启用”。这会直接影响 P0-05 的可行性判断 |
| D-7 | 未提及任何 agent-teams 历史 | 本机 2026-11-09 14:24 曾安装第三方 `@nanmicoder/dsh-agent-teams@0.1.29`，同日 16:07 卸载 | **计划缺项**：P0-05 需说明「官方与第三方两条路都试过/可试」 |
| D-8 | Codex 安装在 `OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0` | 一致；但另存在第二个包 `OpenAI.CodexPrimaryRuntime 26.1105.1297.0`（版本更高、包内无 `codex.exe`） | 一致（有新增事实，强化 R1） |
| D-9 | Codex 版本 `codex-cli 0.167.0-alpha.3.2`、不在 PATH | 一致（`where codex` 退出码 1） | 一致 |
| D-10 | CodeBuddy `codebuddy.cmd`，版本 `2.181.0`，在 PATH | 一致；另发现同目录有 `codebuddy-code`、`codebuddy-lowmem` 两套入口 | 一致（有补充） |
| D-11 | Claude Code 未找到可执行文件，`~/.claude` 有历史数据 | 一致；四路探测均为空，`npm` 全局无 `@anthropic-ai/claude-code`，`.last-update-result.json` 内容与计划描述一致 | 一致 |
| D-12 | 「DeepSeek Harness CLI：无独立可执行文件」 | 严格说**有**：`resources\runtime\cli\bin\dsh.cmd`（转发到 `dsh-desktop-host/lib/cli.js`），只是不在 PATH、未验证可用性 | **需修正**表述为「有转发入口但不在 PATH、能力未验证」 |
| D-13 | 开发工具：node、npm、git 在 PATH；pnpm 用 DSH 内置 | 一致；但**内置 pnpm 用系统 node v20.16.0 会直接崩溃**（`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`，需 node ≥22.13），必须配 DSH 内置 node 24.21.0 | **关键补充**：计划没提这个硬约束，P1-02 构建链必须显式锁定运行时 |
| D-14 | 工作区 `D:\MeetingStone`「当前为空」 | 已非空：已有 `.git`、`LICENSE`、`.gitignore`、`README.md`、`docs/`，2 个提交 | **已过期**（仓库骨架已建） |
| D-15 | 未提及 profile 的 UI 开关状态 | `cordis.patch.yml` 中 `@deepseek-ai/dsh-client-ui-settings` 为 `enabled: false` | **计划缺项**：影响 P0-07 / P1-04 的 Settings 页路线 |
| D-16 | 未提及 `@deepseek-ai/cosmokit` 版本冲突 | 宿主 sharedPackages 为 `1.9.0`，profile 安装的是 `1.8.6`（cliworker 依赖） | 新增风险点：双版本共存，插件 peer 解析需注意 |

### 影响后续任务的 3 条要点

1. **P1-02 构建链**：必须用 `dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0）跑内置 pnpm，或装 node ≥22.13；否则装包/构建直接失败（D-13）。
2. **P0-05 Agent Teams**：宿主已随附官方 `dsh-experimental-agent-team@0.2.2-rc.1`，只是 profile 未启用；第三方 `@nanmicoder/dsh-agent-teams` 已试过又卸载。可行性的起点比计划里写的“未安装”要高（D-6/D-7）。
3. **P0-07 / P1-04 Settings 页**：当前 profile 把 `dsh-client-ui-settings` 显式禁用（D-15），设置页路线需要先确认能否恢复，否则得换扩展点。
