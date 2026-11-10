# P0-08 沙箱与子进程权限边界实测

核验人为 wukong，实验日期为 2026-11-10，时区为 Asia/Shanghai。本文件记录阶段 0 的实机结果与产品承诺边界。

## 1. 可以据此作出的结论

| 问题 | 实测结论 | 证据 |
| --- | --- | --- |
| DSH 的权限档位会自动约束外部 CLI 吗 | 约束取决于启动入口。已解析 read-only 策略的临时 Context，通过普通 `ctx.subprocess.spawn()` 仍成功写到工作区外。显式调用 `sandbox.confine()` 后，同类写入及其后代写入被拒绝 | D1—D7 |
| 已进入宿主沙箱的后代会受限吗 | 本机 DSH Windows ACL runner 下，Node 后代通过继承 stdio 成功启动，写目录外文件返回 EPERM。Codex 本体也能在该 runner 下启动，其初始化写临时 CODEX_HOME 的尝试被拒绝 | D6—D7 |
| Codex 只读能否落实 | 原生 `codex sandbox -P :read-only` 下，命令写工作区内外均被拒绝。`:workspace` 下普通文件内写成功、外写被拒绝。模型入口 `codex exec -s read-only` 因隔离身份缺认证、随后超时，标为未验证 | C1—C6 |
| 整个 Codex 进程都只读吗 | 原生只读 sandbox 命令的启动器仍在工作区外的临时 CODEX_HOME 创建初始化文件。产品承诺应明确覆盖受控的执行命令，并为 CLI 自身缓存另设边界 | C5 |
| CodeBuddy 只读能否落实 | 切换 DSH 内置 Node 后帮助命令可用。实际只读写入、模型工具权限和容器沙箱均未验证，当前产品文案应标无保证 | B1 |
| workspace-write 能否保证目录外绝无写入 | 本机 DSH Windows backend 返回 `enforcement="partial"`。目录外普通文件被拒绝，但目录外硬链接指向项目文件时追加成功 | D5、D9—D10 |
| 杀父进程是否足够 | 普通 detached 子进程及孙进程残留。通过 DSH 当前 Windows 托管入口创建的普通和 detached 后代，在强杀测试宿主后均消失。托管句柄 terminate 对照也清除了后代 | T1—T5 |
| 是否会继承敏感 env | 普通 Node spawn 继承了合成 TOKEN、AUTHORIZATION、COOKIE。DSH 默认 scrub 过滤 TOKEN 和 DSH_HOME，保留 AUTHORIZATION、COOKIE。显式 env 又能重新传入 TOKEN。真实认证变量在本次 Worker 样本中均不存在 | E1—E4 |

以上 DSH 动态实验使用安装内官方服务类和真实 Windows runner，放在独立临时 Cordis Context 中运行。策略服务的默认值为 read-only，另按测试显式解析 workspace-write。真实桌面 profile 和交互 session 切换链路保持未验证。这个范围足以检验集成 API 是否自动约束子进程，以及显式封装后的实际效果。

## 2. 环境、方法与取证纪律

{{VERSIONS}}

所有探针、写入目标、CLI home、日志、PID 文件和官方源码临时副本都位于以下目录。实验用工作区为其中的 `workspace`，外部目标为同级 `outside`。

```text
C:\Users\30673\AppData\Local\Temp\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5
```

`DSH_HOME` 指向 `dsh-home`，`CODEX_HOME` 指向 `codex-home` 或专用的 `codex-entry-home`，`TEMP`、`TMP` 指向 `runtime-temp`。CodeBuddy 的复核另外把 `HOME`、`USERPROFILE` 指向 `env-home`。Codex Windows sandbox 选用 `windows.sandbox="unelevated"`，并设置 `features.prefer_mxc=false`，便于固定测试实现并避免管理员初始化。有效 profile 为内置 `:read-only`、`:workspace`。该选择由核验人作出，本报告的 Codex 结果限于这一实现。

取证程序对环境只输出名称与 `Object.hasOwn(process.env, name)` 的布尔值。真实凭据文件内容、`.sandbox-secrets`、`cap_sid` 等内容没有进入取证记录。身份隔离后的 Codex exec 获得 401，未复用用户登录凭据。实验没有安装包，没有调整真实 profile，没有启用 danger-full-access 或权限绕过选项。

命令通过 Node `spawnSync(executable, args)` 或官方 `ctx.subprocess.spawn({argv})` 传入。下文保留实际 executable/argv，避免 PowerShell 引号转换改变参数。时间均来自执行前的时间戳。`Z` 表示 UTC，对应北京时间加 8 小时。写入探针捕获系统错误后约定返回 13，成功返回 0。父级采证程序完成记录时可返回 0，表格中的被测命令退出码取子进程的真实结果。

基本写入探针原文如下。所有目标事先位于本次临时根目录下，使用独立文件名。

```js
const fs = require('node:fs');
const target = process.argv[2];
console.log(JSON.stringify({event: 'attempt', pid: process.pid, target}));
try {
  fs.writeFileSync(target, 'mt-sandbox-probe\n', {flag: 'wx'});
  console.log(JSON.stringify({event: 'write', ok: true, target}));
} catch (error) {
  console.error(JSON.stringify({event: 'write', ok: false, code: error.code, message: error.message, target}));
  process.exitCode = 13;
}
```

## 3. Codex 自身的权限边界

### 3.1 C1—C4 直接执行沙箱命令

使用原生 sandbox 子命令可以固定待执行程序，观察真正的文件系统拒绝，不依赖模型是否愿意调用工具。只读模式同时测工作区内外，workspace 模式同时做成功和拒绝对照。

{{CODEX_TESTS}}

清理前的文件状态另外确认，`workspace\codex-ww-in.txt` 存在，长度 17。两份只读目标和 workspace 模式的普通目录外目标均不存在。首次另有一个 cmd echo 探测因命令参数问题返回 1，没有用于权限结论。

### 3.2 C5 启动器自身的写入面

使用全新空目录 `codex-entry-home` 作为 CODEX_HOME，在 read-only sandbox 中执行 Node 版本命令。

{{CODEX_METADATA}}

该目录位于工作区外，初始化后出现 `.sandbox` 日志、`cap_sid` 和 `tmp\arg0-windows` 下的别名脚本与锁。仅枚举名称。由此能够宣传的范围是沙箱内命令的文件限制。若需要约束整个 CLI 及其初始化、缓存、插件代码，应同时把 CLI 本体放进外层沙箱，并规划私有临时写入区。

### 3.3 C6 codex exec 模型入口

{{CODEX_EXEC}}

这次执行采用隔离 CODEX_HOME。20 秒后父级 `spawnSync` 超时，以 SIGTERM 结束该调用。进程没有自然退出码，记录为 `null`，不能把采证脚本的 0 当成它的退出码。日志中没有写入探针被执行的事件，因此模型入口的 read-only 行为维持未验证。C1—C4 的本地 sandbox 结果可以独立复现。

Codex 本机 exec 帮助把 `-s` 描述为执行模型生成 shell 命令时的策略。官方 Windows 文档说明 native sandbox 的文件与网络限制覆盖命令及其子进程，并列出 unelevated 的能力限制。本次结果来自上述实测，其他 Windows 实现和网络能力保持未验证。[官方 Windows sandbox 文档](https://learn.chatgpt.com/docs/windows/windows-sandbox)

## 4. DSH 自身的约束入口和外部进程

### 4.1 安装内官方实现复核

2026-11-10T06:15:01.110Z 使用安装自带 Electron 只读检查官方包，采证进程退出 0。包版本均为 `0.2.2-rc.1`。入口命令如下。

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' --expose-internals 'C:\Users\30673\AppData\Local\Temp\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\inspect-dsh.cjs'
```

脚本只枚举 `app.asar\dsh\node_modules\@deepseek-ai` 下名称含 sandbox、subprocess、permission 的官方包，读取其 package.json 与 lib 文件。关键边界如下。

| 官方包与本机 lib 行号 | 行为 |
| --- | --- |
| `dsh-sandbox-policy/lib/index.js` 158—173 | `resolve()` 返回显式批准模式、session 模式或部署默认值，以及 workspaceRoot。返回策略对象本身不会改变当前进程的 Windows token |
| `dsh-pwsh-sandbox/lib/index.js` 145—169、247—248 | 执行器按每次调用解析策略，read-only / workspace-write 调用 `ctx.sandbox.confine()` 生成实际 runner argv |
| `dsh-sandbox-local/lib/index.js` 307—335、359—384 | `confine()` 返回 enforcing argv 和 enforcement。Windows 走 `dsh-sandbox-windows-acl` runner，并报告 partial |
| `dsh-sandbox-windows-acl/lib/runner.js` 143—164 | 按 writableDirs 创建 AclSandbox，使用其 spawn 启动实际程序。约束作用于被包装的进程及继承其 token 的后代 |
| `dsh-fs-sandbox/lib/index.js` 125—187 | 对 `ctx.fs` 的文件修改入口逐次检查。读取通过。该服务与 shell 的 OS runner 各有自己的约束入口 |
| `dsh-subprocess-local/lib/index.js` 1547—1575 | 普通 spawn 处理进程托管、环境与 stdio，没有读取 sandboxPolicy 或调用 confine。Windows Job 的进程生命周期托管与文件权限封装需要分别确认 |
| `dsh-subprocess/lib/index.js` 32、50—55 | 默认环境去掉名称匹配 `/KEY\|PASSWORD\|SECRET\|TOKEN/i` 以及所有 `DSH_*` 的变量，随后显式 env 可以覆盖回填 |

{{SOURCE_HASHES}}

动态实验直接加载这些已安装的类。核心实际调用包括下面这些语句，未通过真实 profile 安装探针。

```js
const ctx = new Context();
const policyService = new SandboxPolicyService(ctx, {
  mode: 'read-only', workspaceRoot: workspace, additionalWritableRoots: []
});
const sandbox = new LocalSandboxProvider(ctx, {
  runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000
});
const runtime = new LocalSubprocessRuntime(ctx);
const policy = policyService.resolve(mode === undefined ? {} : {mode});
const confined = mode === undefined ? undefined : await sandbox.confine(argv, policy);
const handle = runtime.spawn({
  argv: confined?.argv ?? argv,
  cwd: workspace,
  graceMs: 500,
  stdio: {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'},
  env: explicitEnv
});
const result = await handle.done;
await handle.waitForExit();
```

这里 `mode === undefined` 对应普通 spawn 对照，策略服务仍实际解析出 read-only。显式 mode 分支把真实策略交给官方 confine。采证宿主设置临时 DSH_HOME、CODEX_HOME、TEMP、TMP 后执行 `dsh-probe.cjs`。每个动态组的宿主均正常退出 0。

### 4.2 D1—D7 写入、后代与实际 Codex 进程

{{DSH_TESTS}}

D6 的首次后代探针使用默认管道 stdio，创建子进程返回 `EPERM`，采证返回 99，该次没有启动孙进程。随后只把后代 stdio 改为 inherit，实际启动的父 PID 32860、子 PID 61228 均记录在 D6 中，子写入返回 EPERM。后代传播结论采用这次成功启动后的结果。

D7 在 DSH read-only runner 下启动了真实 codex.exe。版本命令返回 0，其 stderr 同时记录临时 CODEX_HOME 初始化写入的拒绝。Codex 模型工具链、CodeBuddy 完整工具链在这一外层 wrapper 下仍未验证。

### 4.3 D8—D10 读取范围及 NTFS 硬链接例外

读取样本是本次创建的无敏感信息 fixture，只记录能否读取。硬链接实验先在工作区创建 27 字节的 fixture，再创建工作区外的 alias，二者指向同一 NTFS 文件对象。创建命令如下。

```powershell
New-Item -ItemType HardLink -Path (Join-Path $root 'outside\hardlink-alias.txt') -Value (Join-Path $root 'workspace\hardlink-source.txt')
```

追加探针调用 `fs.appendFileSync(target, 'probe-append\n')`，成功后记录文件长度，失败时记录原始错误并返回 13。

{{DSH_EDGES}}

本机 workspace-write 经目录外 alias 追加成功，两条路径显示相同的 39 字节长度。read-only 对相同 alias 的追加被拒。目录外 fixture 在 read-only 中可读。因此产品需要将文件写限制、路径边界和机密读取隔离分别说明。

## 5. T1—T5 进程树终止

长跑样本为 Node 父、子、孙三层进程，每层把 PID、PPID 和时间写入自己的临时目录，然后存活 180 秒。控制器等到孙进程 readiness 文件出现，先用 CIM 记录真实父子关系，再执行终止动作，两秒后用 `Get-Process` 查询原 PID 集合。

```js
const next = {parent: 'child', child: 'grandchild'}[role];
if (next) {
  const child = cp.spawn(process.execPath, [__filename, next, directory], {
    stdio: 'ignore', windowsHide: true,
    detached: process.env.MT_TREE_DETACHED === '1'
  });
  if (process.env.MT_TREE_DETACHED === '1') child.unref();
}
fs.writeFileSync(path.join(directory, role + '.json'),
  JSON.stringify({role, pid: process.pid, ppid: process.ppid, time: new Date().toISOString()}));
const interval = setInterval(() => {}, 1000);
setTimeout(() => {clearInterval(interval); process.exit(0);}, 180000);
```

普通样本用 `Start-Process` 启动 Node。DSH 样本用独立 Electron 宿主实例化真实 `LocalSubprocessRuntime`，通过其 spawn 启动相同 Node 程序。后者的进程关系还包括 DSH 的官方 runner。没有终止真实桌面宿主。

观察命令原文如下，knownIds 在 readiness 后从本次 PID 文件及 CIM 父 PID 得到。PowerShell cmdlet 没有独立 OS 退出码，终止动作成功后继续执行的两份 controller 脚本整体退出码均为 0。

```powershell
$before = @($knownIds | ForEach-Object {
    Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_)
} | Select-Object ProcessId,ParentProcessId,Name,CreationDate)
Stop-Process -Id $parent.Id -Force
Start-Sleep -Milliseconds 2000
$after = @(Get-Process -Id $knownIds -ErrorAction SilentlyContinue |
    Select-Object Id,ProcessName,StartTime)
```

T3 使用临时请求文件触发真实托管句柄的以下调用，然后进行相同的独立 PID 查询。

```js
handle.terminate();
const result = await handle.done;
await handle.waitForExit();
```

{{TREE_RESULTS}}

T4 的残留进程随后由控制器 finally 按已记录的 PID 单独终止。两批测试最后均输出 `FINAL_KNOWN_PROCESS_COUNT=0`，交付前再次检查合并 PID 集合，结果仍为 0。

普通 detached 样本表明只杀一个父进程可能留下后代。本机 DSH Job 托管对普通、detached 样本均有效。实际 Codex/CodeBuddy 长会话的取消、PTY 路径、其他平台、runner 不可用后的 fallback、显式 breakaway 和系统重启没有在这里验证，文案应限定已经验收的启动路径。

## 6. E1—E4 环境变量与凭据泄漏面

测试包含原生 Node spawn、DSH 默认 spawn、DSH 显式 env 回填，以及 DSH read-only wrapper。仅使用本次创建的 `MT_PROBE_*` 合成标记测试过滤规则。存在性程序的核心原文如下。

```js
const names = [...new Set([
  ...fixedNames,
  ...Object.keys(process.env).filter(name =>
    /KEY|PASSWORD|SECRET|TOKEN|AUTH|COOKIE|^DSH_/i.test(name))
])].sort();
for (const name of names)
  console.log(JSON.stringify({name, present: Object.hasOwn(process.env, name)}));
```

此处的 Worker 环境样本及临时 DSH Context，与真实桌面 DSH 主进程的环境是不同采样范围。真实主进程环境与其凭据存储保持未验证。

{{ENV_RESULTS}}

本次 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEBUDDY_API_KEY`、`DEEPSEEK_API_KEY`、`GH_TOKEN`、`GITHUB_TOKEN`、`NPM_TOKEN`、三个 AWS 凭据名称均不存在。对这些真实名称，记录只能证明本次样本缺席。TOKEN 过滤行为另由确实存在的合成 TOKEN 实证。

应按工作进程用途建立最小环境白名单，过滤清单至少包含以下类别。清单是后续设计要求，尚待产品实现验收。

- 认证变量与其大小写变体，包括 `*KEY*`、`*TOKEN*`、`*SECRET*`、`*PASSWORD*`、`*CREDENTIAL*`、`*AUTH*`、`*COOKIE*` 以及云厂商、Git、npm 的访问凭据。AUTHORIZATION 和 COOKIE 是本次默认 scrub 实测保留的类别。
- 宿主控制与权限绕过变量，包括 `DSH_*`、`CODEBUDDY_IS_SANDBOX`，以及各 CLI 的授权、配置或 sandbox 覆盖变量。`DSH_*` 当前已有默认过滤，显式 env 回填仍需调用方审核。
- 命令注入和自动加载入口，包括 `NODE_OPTIONS`、`NODE_PATH`、`BASH_ENV`、`ENV`、Python 启动路径/钩子变量、任意指向用户插件与配置目录的覆盖变量。以上类别的实际加载利用保持未验证。
- 代理和代理认证入口，包括 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、SSH/GPG agent socket，以及认证文件定位变量。这些可能指向凭据或带认证信息，默认整包继承应由逐项授权取代。
- 将 `HOME`、`USERPROFILE`、`CODEX_HOME` 和其他 CLI home 映射到受控目录。保留真实 home 可能让工具自行发现文件中的凭据，本次只读目录外 fixture 的成功读取说明还需要独立的读取边界验收。

必要的 CLI 认证可以由受控调用方按用途显式注入最小权限凭据，需同时定义子进程生命周期、日志脱敏与失效规则。文件只读和 env scrub 都需要与凭据可见性一起验收。

## 7. B1 CodeBuddy 当前状态

{{CODEBUDDY}}

首次系统 Node 下的帮助命令曾报 `TypeError: Cannot read properties of undefined (reading 'get')`。把 PATH 置为内置 Node v24.21.0 并隔离 home 后，帮助命令成功。本次确认的是入口可运行和它公开的选项。

帮助中的 permission-mode 为 plan、default、dontAsk、acceptEdits、auto、bypassPermissions 等，另有工具名单和 container/E2B sandbox 入口。实际只读写入、模式映射与容器依赖未验证。项目当前应把 CodeBuddy 的只读/项目写边界标为无保证，并在接入真实外层 runner、完成完整 CLI 验收后再调整承诺。

## 8. 可诚实使用的产品文案与权限设计

| 拟提供档位 | 当前能支持的表述 | 必须标明的边界 |
| --- | --- | --- |
| 只读 | “使用已验证的只读执行沙箱，阻止命令的普通文件写入”可作为后续条件化能力描述。Codex 原生 sandbox 与 DSH ACL wrapper 的本机探针通过 | 完整 CLI 初始化、插件代码、已登录模型执行、CodeBuddy、敏感文件读取和网络边界尚有未验证项。启动必须校验 backend 和实际限制，失败关闭 |
| 项目写入 | “限制普通写入到所选工作区，并提供私有临时区”可以作为设计目标 | Windows 当前为 partial。NTFS 硬链接目录外 alias 写入已成功，“绝不修改任何项目外路径”应标无保证 |
| 受限命令 | 启动前的 executable/argv 与受控工具名单可以作为独立设计范围 | 外部 CLI 内部工具、后代执行命令及其解释器行为未经过本次白名单验收，逐条命令限制应标未验证/无保证 |
| 人工批准 | 对启动、提升权限、额外目录和凭据注入分别设置待实现的批准点 | 本次没有验证真实 session 的审批往返。工作进程内部每次工具调用是否再次批准需单独集成，不能由父级一次同意推导 |
| 停止任务 | 本机 DSH Windows 托管入口已经清理普通和 detached 样本，可以作为这一启动路径的验收证据 | 普通 detached spawn 的父进程终止出现残留。每次接入都要保留句柄并等待真实范围退出，fallback 和其他平台需重新验收 |

权限设计应记录每个 worker 的请求模式、实际执行 backend、enforcement、workspace、临时写入区、env 注入列表和进程托管方式。把文件/网络限制、命令策略、人工批准、凭据可见性和取消清理分别验收。普通 spawn 对照、硬链接反例和显式 env 回填表明，仅给角色保存一个权限标签不足以支撑对应承诺。

## 9. 未验证项与清理

未验证的核心项包括真实桌面 session 模式切换和审批链、Codex 已登录 exec、CodeBuddy 模型写入、CLI 插件与 MCP、完整 worker 取消、PTY/fallback/breakaway、其他 OS、MXC/elevated sandbox、网络与全部读取拒绝。未进行 danger-full-access 写盘对照。

{{CLEANUP}}
