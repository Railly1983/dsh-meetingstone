# 02b · engines.dsh 实机核验（P0-02 U1）

核验人：wukong（悟空）；日期：2026-11-10，Asia/Shanghai。阶段 0 技术实验，仅新增本审计文件；不写产品代码，不修改 `02-plugin-spec.md`。

**结论：待证命题不成立。** 本机 DSH `0.2.2-rc.1` 能安装并组合 `>=0.2.0 <0.3.0` 和 `>=0.2.2-rc.1 <0.3.0` 两种 bundle。实际实现保留完整版本号，调用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。它既不是使用默认选项，也不是剥掉 `-rc.1`。本项目最终建议声明 **`>=0.2.2-rc.1 <0.3.0-0`**：以本次实际验证版本为最低基线，并排除下一条 `0.3.0` 预发布线；详见第 3 节。

## 1. 实验环境与安全边界

| 项目 | 独立核验结果 |
| --- | --- |
| 系统 / Shell | Windows，PowerShell；工作区 `D:\MeetingStone` |
| CLI | `C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，243 字节 |
| DSH 版本 | `0.2.2-rc.1`，CLI 退出码 0 |
| 直接运行 JS / pnpm 的 Node | `C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，`v24.21.0` |
| pnpm | DSH 内置 pnpm `11.28.5`，用上述 Node 执行 `dependencies\pnpm\bin\pnpm.mjs --version`，退出码 0 |
| `.cmd` 内部执行器 | 官方 `.cmd` 使用 `ELECTRON_RUN_AS_NODE=1` 启动安装自带 Electron；实测其中 Node 也是 `v24.21.0`。CLI 自己转发 pnpm 时使用此 Electron 和安装内 pnpm，并非系统 Node；直接调用 pnpm 的版本检查则使用上面的内置 `node.exe` |
| 临时根目录 | `C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3` |
| `DSH_HOME` | 临时根目录下的 `dsh-home`；**确认生效**：CLI 初始化消息给出此目录，且在此生成 `profiles\mt-probe*\package.json` 等文件 |
| profile 隔离 | `mt-probe` 用于隔离/路径检查，A—E 各用独立的 `mt-probe-a` 至 `mt-probe-e`，避免前一实验污染后一实验 |
| 兼容性豁免 | 六个临时 profile 均无 `compatibility.json`；未调用 `allow-version`，未接受任何豁免 |
| 禁止范围 | 未向真实 `desktop` 安装，未读取或写入其目录；未读取或复制凭据文件；未进行全局 npm 安装 |
| 网络与依赖 | 探针无依赖、无构建脚本，安装设置 offline / ignore-scripts；仅另行下载公开 DSH 官方文档/源码作为复核依据，不联网安装依赖 |

以下为实验环境变量及工作目录。变量只作用于实验子进程；用户 npm 配置替换为空文件，避免读取用户 `.npmrc`。CLI 仍按其官方 `.cmd` 原样启动。

```powershell
$probeRoot = 'C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3'
$env:DSH_HOME = Join-Path $probeRoot 'dsh-home'
$env:PATH = 'C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;' + $env:PATH
$env:npm_config_offline = 'true'
$env:npm_config_ignore_scripts = 'true'
$env:npm_config_userconfig = Join-Path $probeRoot 'empty-user.npmrc'
$env:npm_config_globalconfig = Join-Path $probeRoot 'empty-global.npmrc'
$env:npm_config_store_dir = Join-Path $probeRoot 'pnpm-store'
[IO.File]::WriteAllText($env:npm_config_userconfig, '')
[IO.File]::WriteAllText($env:npm_config_globalconfig, '')
Set-Location -LiteralPath $probeRoot
```

两个主探针位于 `probe-a`、`probe-b`，**包名、版本、入口、patch 均相同，只有 `engines.dsh` 不同**。目录名用于选择输入，包名统一为 `mt-engine-probe`，因此没有名称变量干扰。两个 JSON 解析后，将 B 的该字段改回 A，深度序列化比较结果为 `AB_ONLY_ENGINES_DIFF=true`。

```json
{
  "name": "mt-engine-probe",
  "version": "0.0.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "engines": { "dsh": ">=0.2.0 <0.3.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

B 将范围改为 `>=0.2.2-rc.1 <0.3.0`；补充对照 C / D / E 分别为 `0.2.2-rc.1`、`0.2.2`、`>=0.2.2-rc.1 <0.3.0-0`，其余探针内容相同。文件为 UTF-8，无 BOM。生成器序列化的 `\u003e` / `\u003c` 是等价 JSON 转义。

`index.js` 原文：

```js
export const name = 'mt-engine-probe';
export function apply() {}
```

`cordis.patch.yml` 原文：

```yaml
- insert:
    - id: mt-engine-probe
      name: mt-engine-probe
```

A、B 两份入口文件的 SHA-256 均为 `FE9D957E818896E004AD4123DC22853D71BFAA73B3D61B009617EC21F9970C11`；两份 patch 均为 `23E73690771879BBCB3293A47D65C36055AAEDE871B1206BABF419E02D072EFA`。

## 2. 命令、原始输出与退出码

以下保留原始输出片段，不改写输出；省略部分用围栏外文字说明。A / B / C 为 PowerShell 合并 stdout / stderr 的采集；D 的拒绝输出另用内置 Node 的 `spawnSync` 原样捕获，避免 PowerShell 将 native stderr 包装成异常记录。每个退出码紧随相应命令记录。

### 2.1 版本与隔离检查

```powershell
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --version
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --help
& 'C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --version
& 'C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' --version
```

输出依次为 `0.2.2-rc.1`、帮助文本、`v24.21.0`、`11.28.5`；**四个退出码均为 0**。帮助关键原文：

```text
  --profile <name>               the profile under $DSH_HOME/profiles to boot
```

但这两条 CLI 信息命令未创建 profile，不能单凭它们证明隔离。实际隔离检查命令：

```powershell
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile mt-probe list --offline
```

关键输出原文：

```text
dsh: initialized profile mt-probe at C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3\dsh-home\profiles\mt-probe
[ERROR] Unknown option: 'offline'
For help, run: pnpm help list
```

**退出码 1**。这是本次检查命令的参数错误：`pnpm list` 不接受 `--offline`；不是隔离失败。已落盘的临时 profile 内有 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml` 和本次操作日志，足以确认 home 路径。后续安装用环境变量 offline，不向 `list` 传此选项。检查真实 home 下 `C:\Users\30673\.dsh\profiles\mt-probe` 是否存在，结果为 `False`；无需采用真实 home 的备用 profile 方案。

### 2.2 A / B 两组真实安装

A / B 首次安装的 PowerShell 原始调用主体如下（输出另存 JSON 的采集语句省略）：

```powershell
foreach ($case in @('a','b')) {
    $profile = 'mt-probe-' + $case
    $out = & 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile $profile add ('./probe-'+$case) 2>&1
    $rc = $LASTEXITCODE
}
```

A 的参数展开命令为：

```powershell
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile mt-probe-a add ./probe-a
```

完整采集输出：

```text
dsh: initialized profile mt-probe-a at C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3\dsh-home\profiles\mt-probe-a
Already up to date

dependencies:
+ mt-engine-probe 0.0.0 <- ..\..\..\probe-a

Done in 316ms using pnpm v11.28.5
```

**A 安装退出码 0**。

B 的参数展开命令为：

```powershell
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile mt-probe-b add ./probe-b
```

完整采集输出：

```text
dsh: initialized profile mt-probe-b at C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3\dsh-home\profiles\mt-probe-b
Already up to date

dependencies:
+ mt-engine-probe 0.0.0 <- ..\..\..\probe-b

Done in 304ms using pnpm v11.28.5
```

**B 安装退出码 0**。两份 profile manifest 的 `dsh.profile.bundles` 均为 `["@deepseek-ai/dsh-base", "mt-engine-probe"]`；依赖分别链接到各自探针。独立检查 A 的 `node_modules\mt-engine-probe` 是指向 `probe-a` 的 **Junction**，并非把源码实体复制进 profile。

### 2.3 确认 A / B 的 layer 已组合

```powershell
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --profile mt-probe-a --dump-config
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --profile mt-probe-b --dump-config
```

**两个退出码均为 0**。两份输出结尾均为以下原文（前面的 base 层省略）：

```yaml
# == mt-engine-probe
- id: mt-engine-probe
  name: mt-engine-probe
```

这证明 bundle 层已进入有效组合；不把配置预览表述为 `apply()` 已经执行。

### 2.4 精确版本对照 C / D：排除“去掉 rc”和“完全不检查”

C（只接受完整 rc 版本）的 CLI 命令：

```powershell
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile mt-probe-c add ./probe-c
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --profile mt-probe-c --dump-config
```

安装关键输出原文：

```text
+ mt-engine-probe 0.0.0 <- ..\..\..\probe-c

Done in 324ms using pnpm v11.28.5
```

**安装 0；dump 0**；dump 同样出现第 2.3 节的三行探针层。

D（只接受正式版 `0.2.2`）第一次安装退出码 1；为排除 PowerShell 的 stderr 包装，随后以 `cmd.exe /d /s /c` 再执行同一 CLI，原始 command string 为：

```bat
""C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile mt-probe-d add ./probe-d"
```

重试 **stdout 为空，退出码 1**。stderr 完整原文（含 CLI 建议的豁免命令；**该建议未执行**）：

```text

dsh: installation rejected: Plugin mt-engine-probe@0.0.0 is incompatible with dsh 0.2.2-rc.1: requirements {"engines.dsh":"0.2.2"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for mt-engine-probe@0.0.0 on dsh 0.2.2-rc.1 with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: not active.
dsh: nothing was installed.
dsh: to accept the risk, run: dsh plugin --profile mt-probe-d allow-version mt-engine-probe@0.0.0 --dsh-version 0.2.2-rc.1 --accept-risk
dsh: plugin command failed; diagnostics: C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3\dsh-home\profiles\mt-probe-d\.plugin-manager\logs\operation-EGpTav\pnpm.log
```

第一次拒绝后另跑：

```powershell
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --profile mt-probe-d --dump-config
```

**退出码 0**，仅有 base 层，没有 `# == mt-engine-probe`；manifest 也仅保留 base。故不能仅以 dump 退出码 0 作为安装成功证据，必须同时检查目标层。

### 2.5 本机官方实现与 SemVer 独立复算

使用安装自带 Electron 的 ASAR 文件系统，只读检查 **DSH 官方** `@deepseek-ai/dsh-app-boot/lib/index.js`，没有读取第三方 CLIWorker 的任何实现。

被读文件：`C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`。SHA-256：`346f832224737cd9ab1b5e37d111ae232fdd78b5ab892fa3179c112baf6f0a22`。

实际执行的检查脚本 `source-evidence.cjs` 原文如下；外层由内置 Node 的 `spawnSync` 等待 Electron 结束，设置 `ELECTRON_RUN_AS_NODE=1` 及临时 `DSH_HOME`，调用参数为 `--expose-internals <临时根目录>\source-evidence.cjs`，**子进程退出码 0**：

```js
const fs=require('node:fs');
const crypto=require('node:crypto');
const file='C:/Users/30673/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
const src=fs.readFileSync(file,'utf8');
const lines=src.split('\n');
console.log('Electron Node='+process.version);
console.log('FILE='+file);
console.log('SHA256='+crypto.createHash('sha256').update(src).digest('hex'));
console.log(lines.slice(1075,1103).map((l,i)=>(i+1076)+': '+l).join('\n'));
```

关键输出逐行摘录：

```text
Electron Node=v24.21.0
1077: 	return value;
1094: function satisfies(runtimeVersion, range) {
1095: 	return range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true });
1096: }
1102: 		return satisfies(runtimeVersion, range) ? {} : { "engines.dsh": range };
```

这里的 `return value` 是 `runtimeVersionOf` 校验后的原值返回；1089—1092 行从 app-boot 自身 package version 取值。也独立下载比对了原审计声明的固定 commit：[`plugin-compatibility.ts` 第 24—28、44—60 行](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/src/plugin-compatibility.ts#L24)，与本机实现一致。上述行号以本机安装文件为准。

使用内置 Node 与现成的 semver `7.8.5` 复算（无安装依赖），命令原文：

```powershell
& 'C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' (Join-Path $probeRoot 'semver-matrix.cjs')
```

矩阵脚本的核心原文（版本输出、A/B 比较的附加语句省略）：

```js
const semver=require('C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/dist/node_modules/semver');
for(const range of ['>=0.2.0 <0.3.0','>=0.2.2-rc.1 <0.3.0','>=0.2.2-rc.1 <0.3.0-0']) {
 for(const version of ['0.2.0','0.2.2-rc.1','0.2.2','0.2.3-rc.1','0.3.0-rc.1','0.3.0']) console.log(JSON.stringify({version,range,defaults:semver.satisfies(version,range),includePrerelease:semver.satisfies(version,range,{includePrerelease:true})}));
}
```

**退出码 0**。关键输出原文：

```jsonl
{"version":"0.2.2-rc.1","range":">=0.2.0 <0.3.0","defaults":false,"includePrerelease":true}
{"version":"0.3.0-rc.1","range":">=0.2.0 <0.3.0","defaults":false,"includePrerelease":true}
{"version":"0.2.2-rc.1","range":">=0.2.2-rc.1 <0.3.0","defaults":true,"includePrerelease":true}
{"version":"0.3.0-rc.1","range":">=0.2.2-rc.1 <0.3.0","defaults":false,"includePrerelease":true}
{"version":"0.2.2-rc.1","range":">=0.2.2-rc.1 <0.3.0-0","defaults":true,"includePrerelease":true}
{"version":"0.3.0-rc.1","range":">=0.2.2-rc.1 <0.3.0-0","defaults":false,"includePrerelease":false}
{"version":"0.3.0","range":">=0.2.2-rc.1 <0.3.0-0","defaults":false,"includePrerelease":false}
```

### 2.6 E：最终建议范围也做真实安装

为保证最终推荐不止是纸面推理，新增 E 范围 `>=0.2.2-rc.1 <0.3.0-0`，使用与 D 相同的 native 捕获方式，实际 command string 分别为：

```bat
""C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile mt-probe-e add ./probe-e"
""C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile mt-probe-e --dump-config"
```

安装 stdout 原文：

```text
Already up to date

dependencies:
+ mt-engine-probe 0.0.0 <- ..\..\..\probe-e

Done in 305ms using pnpm v11.28.5
```

安装 stderr 原文：

```text
dsh: initialized profile mt-probe-e at C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3\dsh-home\profiles\mt-probe-e
```

**安装 0；dump 0**；dump stderr 为空，结尾为第 2.3 节相同三行探针层。

### 2.7 顺带实证复核：overlay 是否必须用绝对插件路径

在临时根目录创建 `relative.patch.yml`：

```yaml
- insert:
    - id: mt-relative-probe
      name: ./probe-a/index.js
```

实际 command string：

```bat
""C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile mt-probe --patch ./relative.patch.yml --dump-config"
```

**退出码 0**，stderr 为空；stdout 结尾原文：

```yaml
# == C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3\relative.patch.yml
- id: mt-relative-probe
  name: >-
    file:///C:/Users/30673/AppData/Local/Temp/mt-engine-probe-d15e85d7421d4071831a101d611d07f3/probe-a/index.js
```

配置组合已将相对插件路径转换为 patch 所在目录下的 file URL。没有启动插件；此证据只证明本机组合/路径转换行为，不能外推为 TypeScript 执行能力或运行时功能测试。

## 3. 结论与最终 engines.dsh

| 探针 | `engines.dsh` | 安装退出码 | dump 退出码 / 目标层 |
| --- | --- | --- | --- |
| A | `>=0.2.0 <0.3.0` | 0 | 0 / 有 |
| B | `>=0.2.2-rc.1 <0.3.0` | 0 | 0 / 有 |
| C | `0.2.2-rc.1` | 0 | 0 / 有 |
| D | `0.2.2` | 1（两次） | 0 / 无 |
| E | `>=0.2.2-rc.1 <0.3.0-0` | 0 | 0 / 有 |

1. **默认 npm semver 的计算结果没有错，套用到 DSH 的结论错了。** A 已实证安装且进入组合，因此“官方示例因 rc 而不匹配本机”被否定；B 可用，但不是避开安装失败的必要写法。
2. **DSH 显式纳入 prerelease，并保留版本精确值。** C 成功、D 失败，以及本机官方代码共同排除“剥掉 rc”或“忽略 engines”解释。
3. **本项目最终建议：`"engines": { "dsh": ">=0.2.2-rc.1 <0.3.0-0" }`。** 下界是目前唯一实际验证的宿主基线，不宣称已测过 `0.2.0` / `0.2.1`；上界阻止 `0.3.0-rc.*` 提前进入。E 已完成本机真实安装与 layer 检查。此建议是兼容范围选择，不是 npm 默认 prerelease 规则迫使如此。
4. 官方示例 `>=0.2.0 <0.3.0` 在当前主机**可以用**；原建议 B 也**可以用**。若保留两者任一个，需接受 DSH 的实际匹配方式会纳入 `0.3.0` 的预发布版。本次没有在未来宿主上做安装，未来版本边界结论来自已核验的比较函数与独立矩阵。

U1 已关闭，没有当前主机安装方面的阻塞。U2 的“本地目录 add + manifest/layer”部分也得到实证；不能由此宣布完整产品启动已验收。

## 4. 对 02-plugin-spec.md 第 1、2、5 节的勘误清单

严重度：P0 为可能直接错误决策的核心技术项；P1 为重要边界/来源问题；P2 为表述或前置条件需修正。这里只列问题，**未修改原文**。

| 严重度 | 位置 | 问题与证据 | 建议勘误 |
| --- | --- | --- | --- |
| **P0（本次已解除）** | §1.6；并影响 §7(a) | 默认 `semver.satisfies` 实测被用于强推荐 manifest，而 DSH 实际带 `includePrerelease: true`。原文虽然登记 U1，却已在推荐值及“不要照抄”注释中把尚未核验的风险变成决策依据。A/B/C/D 与本机代码直接反证 | 写明两种原范围均可安装；移除“必须改下界才能安装”的理由，以本报告替代 U1；最终范围采用第 3 节 |
| **P1** | §1.6 范围说明 | 在 DSH 选项下，两个 `<0.3.0` 的范围都接受 `0.3.0-rc.1`。原文“排除 0.3.0+”若指正式版数学边界并非字面错误，但不足以表达只支持 0.2 分支的实际意图；也未说明后续 patch 的 prerelease 会被纳入 | 明确预发布策略；若排除整个 0.3 线，用 `<0.3.0-0` |
| **P1（来源边界）** | §0 的 clean-room 声明、§1.2 的 L6 patch 抄录 | `docs/CLEAN_ROOM.md` §2 明文禁止复制 CLIWorker 的“补丁”；§3 未列出“包结构/patch 可复制”的例外。原文称该取证范围获 §2/3 允许，却实际摘录其 patch。这个授权描述与仓库契约不符；本次未读取该第三方安装目录 | 移除这段第三方 patch 摘录，改用官方示例或独立探针；由项目负责人处理既有审计的来源边界。此项是按本地契约判断，不作法律结论 |
| **P1** | §5.2 路径 1 的验收含义；§1.6 启动拒绝说明 | CLI 帮助/版本只能证明入口可调用，不能证明安装、启动、卸载的完整语义。尤其 dump 0 不保证目标 layer 存在（D 已实证），dump 出现行也不证明 `apply` 已执行。官方 app-boot 另说明不兼容 bundle 可被跳过而保留 selection，并非总使整个 profile 启动失败 | 分开标注“文档规则”“安装实测”“配置组合”“实际启动”；验收同时检查退出码、目标层、拒绝/skip 诊断及运行行为；启动 skip 政策仍属文档依据 |
| **P2** | §5.2 补充第 4 种 | “插件路径必须绝对路径”沿用 S7 教程表述，未处理同 commit 官方 app-boot 文档的相对路径转换规则。本次 §2.7 已实证 `./probe-a/index.js` 可在 `insert` 行被转换为正确 file URL | 限定为教程的保守写法，不能描述为本机通用硬限制；区分 `insert` 行、已有行 name 断言和 config 内普通字符串 |
| **P2** | §5.2 路径 2 前提 | 一面写 Standard/Creator 均提供 Plugin Manager，一面又将 Creator 模式列为必需。原 S9 的 Creator 是该操作示例及额外只读检查入口，不能直接推导所有安装都必须 Creator | 将 Creator 改成该示例选用条件；按实际工具暴露和权限判断入口是否可用。此项是官方文档复核，未做 UI 操作 |
| **P2** | §5.2 路径 3 | “第三方包必须真实落在 profile node_modules”易被理解为必须实体拷贝；A 实测是 Junction 指向 profile 外的独立源码目录 | 改为“必须能从 profile/runtime resolution 解析”；明确支持链接目标及其依赖解析前置条件。手工 link 全流程仍未验收 |
| **P2** | §1.5 标题、§1.4 的泛化 | “整行替换”过宽，原引用精确对象是整个 `config` 值；不要扩展到所有行字段。另外 base 第一是 `plugin` 初始化及相应模板的约定，官方 app-boot 明列 `sdk-minimal` 为独立 bundle 例外 | 标题改为“config 整值替换”；将 base 第一的范围限定为适用 profile，不把它当所有 profile 的硬性 schema 条件 |
| **P2（验证前置）** | §2.4 | 生命周期、disposer 逆序开始/异步并发、`fiber.dispose()` 等表述与固定 commit 官方文档相符，未发现应改的直接事实错误。但均是文档核对，本次并未执行 HMR、服务消失或长任务清理；文档正确不等于 Windows 子进程清理已经过验收 | 明示证据等级；后续另验收进程树终止、等待退出、取消竞争及清理失败/超时，不由本报告代替 |

独立复核所用官方来源均固定在 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，避免只因版本字符串相同就宣称源码完全一致：

- [publish.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md)：manifest、安装和 config 替换；本机安装行为另由探针核验。
- [app-boot README / Profiles](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/README.md#profiles)：预发布匹配、跳过 bundle、dump 边界、相对路径转换、sdk-minimal 例外；后四项并非全部做了运行实测。
- [framework/index.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/framework/index.md)、[service.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/framework/service.md)、[events.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/framework/events.md)：复核第 2 节。
- [dynamic-cordis.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/practice/dynamic-cordis.md)、[basic/index.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/index.md)：复核模式入口及 overlay 教程与运行时规则的差异。

**对原文的信任度：6/10。** 来源清单及待验证登记有价值，第 2 节文档摘要基本可靠；但最关键版本门槛误用了比较选项，并存在来源授权描述和文档/实测证据等级问题。需要按项修订，不能直接充当阶段 1 的完整验收记录。

## 5. 未验证项、风险与清理

- 未启动完整 app、执行探针 `apply()`、连接模型、读凭据或运行 UI；没有端到端产品功能结论。`--dump-config` 只确认配置组合。
- 未在其他 DSH 版本/平台安装；`0.2.3-rc.1`、`0.3.0-rc.1` 等是 SemVer 复算输入，并非已经存在或已经安装的宿主。未来宿主改动比较选项时需重测。
- 未测 npm/tarball/git 安装、prepare/allowBuilds、手工 link 全流程、peer 回退、兼容性豁免、插件卸载和 HMR。不得把本地无依赖链接实验扩展成这些路线全部通过。
- `.cmd` 与直接 Node 检查均避开系统 Node；阶段 1 若绕过 `.cmd` 手动调用 pnpm，仍需明确使用内置 Node。仅证明 pnpm 版本并不能证明任意依赖安装都能成功。
- P1 来源契约问题需在原审计中另行处理；本次不修改该文档，也不据此读取更多第三方实现。U1 自身没有阻塞。

**清理已完成（2026-11-10 13:53:38 +0800）。** 删除范围仅为本次创建的临时根目录及自己的位置记录文件。先独立核对根目录的解析后绝对路径、确认四个 Junction 的目标也都在该根目录内，再以非递归 `Directory.Delete` 逐个移除四个依赖 Junction，最后删除临时树。删除内容包括六个隔离 profile（`mt-probe`、`mt-probe-a` 至 `mt-probe-e`）、五个探针目录、临时 npm 配置、安装操作日志、公开官方资料的临时副本及采证脚本。没有在真实 home 中建立备用 profile，因此也没有删除真实 home 下的 profile。

初次带 `-Force` 的批量删除被自动审批拒绝，返回 `blocked by policy`，未给具体理由；这些被拒命令未执行。完成上述独立路径核对及 Junction 清理后，以下更窄、无 `-Force` 的命令成功执行，均退出 0：

```powershell
Remove-Item -LiteralPath 'C:\Users\30673\AppData\Local\Temp\mt-engine-probe-d15e85d7421d4071831a101d611d07f3' -Recurse
Remove-Item -LiteralPath 'D:\mt-engine-probe-location.txt'
```

随后 `Test-Path` 检查输出原文：

```text
TEMP_ROOT_EXISTS=False
MARKER_EXISTS=False
```

交付前将文中 A/B 安装完整输出、D/E native 输出和关键源码行逐一与临时原始记录做字符串匹配，结果全部为 `true`，之后才清理原始记录。`02-plugin-spec.md` 清理前后 SHA-256 同为 `38EE86B6195F4B82C96805573A8EA88FECAC9C59ED00D63247BC0FED5B223FB1`；最终仓库状态仅新增 `docs/audit/02b-engine-probe.md`。清理及 U1 均无遗留阻塞。
