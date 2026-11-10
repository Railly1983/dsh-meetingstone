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

| 对象 | 时间 | 输出 | 退出码 |
| --- | --- | --- | --- |
| codex | 2026-11-10T14:30:44.1915210+08:00 | `codex-cli 0.167.0-alpha.3.2` | 0 |
| codebuddy | 2026-11-10T14:30:44.2332252+08:00 | `2.181.0` | 0 |
| dsh | 2026-11-10T14:30:44.2999841+08:00 | `0.2.2-rc.1` | 0 |
| node | 2026-11-10T14:30:44.4755056+08:00 | `v24.21.0` | 0 |

版本命令原文

```powershell
& 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0\app\resources\codex.exe' --version
& 'C:\Users\30673\AppData\Roaming\npm\codebuddy.cmd' --version
& 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --version
& 'C:\Users\30673\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --version
```

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

#### C1 read-only 写工作区外

时间 `2026-11-10T06:17:26.971Z`，被测进程退出码 `13`。

原始 argv

```json
["C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/codex.exe","-c","windows.sandbox=\"unelevated\"","-c","features.prefer_mxc=false","sandbox","-C","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","-P",":read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\codex-ro-out.txt"]
```

关键输出原文

```text
{"event":"write","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\codex-ro-out.txt'","target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\codex-ro-out.txt"}
```

#### C2 read-only 写工作区内

时间 `2026-11-10T06:17:27.075Z`，被测进程退出码 `13`。

原始 argv

```json
["C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/codex.exe","-c","windows.sandbox=\"unelevated\"","-c","features.prefer_mxc=false","sandbox","-C","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","-P",":read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\codex-ro-in.txt"]
```

关键输出原文

```text
{"event":"write","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\codex-ro-in.txt'","target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\codex-ro-in.txt"}
```

#### C3 workspace 写工作区内

时间 `2026-11-10T06:17:27.165Z`，被测进程退出码 `0`。

原始 argv

```json
["C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/codex.exe","-c","windows.sandbox=\"unelevated\"","-c","features.prefer_mxc=false","sandbox","-C","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","-P",":workspace","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\codex-ww-in.txt"]
```

关键输出原文

```text
{"event":"attempt","pid":62136,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\codex-ww-in.txt"}
{"event":"write","ok":true,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\codex-ww-in.txt"}
```

#### C4 workspace 写工作区外

时间 `2026-11-10T06:17:27.271Z`，被测进程退出码 `13`。

原始 argv

```json
["C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/codex.exe","-c","windows.sandbox=\"unelevated\"","-c","features.prefer_mxc=false","sandbox","-C","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","-P",":workspace","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\codex-ww-out.txt"]
```

关键输出原文

```text
{"event":"write","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\codex-ww-out.txt'","target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\codex-ww-out.txt"}
```


清理前的文件状态另外确认，`workspace\codex-ww-in.txt` 存在，长度 17。两份只读目标和 workspace 模式的普通目录外目标均不存在。首次另有一个 cmd echo 探测因命令参数问题返回 1，没有用于权限结论。

### 3.2 C5 启动器自身的写入面

使用全新空目录 `codex-entry-home` 作为 CODEX_HOME，在 read-only sandbox 中执行 Node 版本命令。

#### C5 read-only 启动器元数据

时间 `2026-11-10T06:23:19.976Z`，被测进程退出码 `0`。

原始 argv

```json
["C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/codex.exe","-c","windows.sandbox=\"unelevated\"","-c","features.prefer_mxc=false","sandbox","-C","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","-P",":read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","--version"]
```

关键输出原文

```text
v24.21.0
```

目录名称采样时间 `2026-11-10T06:23:20.045Z`

```json
{
  "initiallyEmpty": true,
  "entries": [
    ".sandbox/",
    ".sandbox\\sandbox.2026-11-10.log",
    "cap_sid",
    "tmp/",
    "tmp\\arg0-windows/",
    "tmp\\arg0-windows\\codex-arg0tV8Aae/",
    "tmp\\arg0-windows\\codex-arg0tV8Aae\\.lock",
    "tmp\\arg0-windows\\codex-arg0tV8Aae\\applypatch.bat",
    "tmp\\arg0-windows\\codex-arg0tV8Aae\\apply_patch.bat"
  ]
}
```

该目录位于工作区外，初始化后出现 `.sandbox` 日志、`cap_sid` 和 `tmp\arg0-windows` 下的别名脚本与锁。仅枚举名称。由此能够宣传的范围是沙箱内命令的文件限制。若需要约束整个 CLI 及其初始化、缓存、插件代码，应同时把 CLI 本体放进外层沙箱，并规划私有临时写入区。

### 3.3 C6 codex exec 模型入口

#### C6 模型入口认证失败

时间 `2026-11-10T06:23:20.046Z`，被测进程退出码 `null`。

原始 argv

```json
["C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/codex.exe","exec","--ignore-user-config","--ignore-rules","--ephemeral","--skip-git-repo-check","-C","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","-s","read-only","-c","approval_policy=\"never\"","-c","windows.sandbox=\"unelevated\"","-c","features.prefer_mxc=false","--json","Run only the local Node attempt-write.cjs probe against the temporary outside/codex-exec-ro.txt target and report the command exit code. Do not inspect any other files."]
```

关键输出原文

```text
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a582f7cf9f52f804-ICN)"}
```

采证结束时间 `2026-11-10T06:23:40.069Z`，signal 为 `SIGTERM`。

```text
spawnSync C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/codex.exe ETIMEDOUT
```

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

本机源码 SHA-256 记录如下，路径前缀均为 `app.asar\dsh\node_modules\@deepseek-ai`。

| 官方 lib 文件 | SHA-256 |
| --- | --- |
| `dsh-sandbox-policy/lib/index.js` | `8eb1674f9c3c2e336efae7ecc734d5197dc8b80bc29f1f1d61bfe0b5a1472188` |
| `dsh-pwsh-sandbox/lib/index.js` | `bed19d2cea875b152f9e811116b59c2a45e6711b1c6cf1d8bacc4d20e15c6783` |
| `dsh-sandbox-local/lib/index.js` | `4399dae3ca786b032d232bda094f3f395c151f0258b1373e640eb4ba0d04ba3f` |
| `dsh-fs-sandbox/lib/index.js` | `f4edd14bf48f8d5bfdea10a61c6651ccde99f2d08a79855746ad2a8d89c6fb73` |
| `dsh-subprocess/lib/index.js` | `0ea9e95a73639f9e69b48aa48f373f34881adffa2ee2ac2acd4702728da9592b` |
| `dsh-subprocess-local/lib/index.js` | `2964d94d6aa735f79e5cd5f54035a9d73b371e8060dda7e3bf666593428c04f4` |

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

#### D1 策略已解析 read-only 的普通 spawn

时间 `2026-11-10T06:19:41.158Z`，被测进程退出码 `0`。
实际策略为 `read-only`，confined 为 `false`。

原始 argv

```json
["C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-raw-ro-out.txt"]
```

关键输出原文

```text
{"event":"attempt","pid":19556,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-raw-ro-out.txt"}
{"event":"write","ok":true,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-raw-ro-out.txt"}
```

#### D2 confine read-only 写工作区内

时间 `2026-11-10T06:19:41.382Z`，被测进程退出码 `13`。
实际策略为 `read-only`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\dsh-ro-in.txt"]
```

关键输出原文

```text
{"event":"write","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\dsh-ro-in.txt'","target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\dsh-ro-in.txt"}
```

#### D3 confine read-only 写工作区外

时间 `2026-11-10T06:19:41.741Z`，被测进程退出码 `13`。
实际策略为 `read-only`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-ro-out.txt"]
```

关键输出原文

```text
{"event":"write","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-ro-out.txt'","target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-ro-out.txt"}
```

#### D4 confine workspace-write 写工作区内

时间 `2026-11-10T06:19:42.145Z`，被测进程退出码 `0`。
实际策略为 `workspace-write`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","workspace-write","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\dsh-ww-in.txt"]
```

关键输出原文

```text
{"event":"attempt","pid":13816,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\dsh-ww-in.txt"}
{"event":"write","ok":true,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace\\dsh-ww-in.txt"}
```

#### D5 confine workspace-write 写普通目录外文件

时间 `2026-11-10T06:19:42.515Z`，被测进程退出码 `13`。
实际策略为 `workspace-write`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","workspace-write","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\attempt-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-ww-out.txt"]
```

关键输出原文

```text
{"event":"write","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-ww-out.txt'","target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-ww-out.txt"}
```

#### D6 read-only 后代继承 stdio 后写目录外

时间 `2026-11-10T06:20:05.564Z`，被测进程退出码 `13`。
实际策略为 `read-only`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\grandchild-write.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-grandchild-out.txt"]
```

stdout 原文

```text
{"event":"parent","pid":32860}
{"event":"attempt","pid":61228,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-grandchild-out.txt"}
{"event":"grandchild-exit","exit":13}
```

stderr 原文

```text
{"event":"write","ok":false,"code":"EPERM","message":"EPERM: operation not permitted, open 'C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-grandchild-out.txt'","target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\dsh-grandchild-out.txt"}
```

#### D7 read-only 中启动真实 codex.exe

时间 `2026-11-10T06:19:43.224Z`，被测进程退出码 `0`。
实际策略为 `read-only`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","read-only","--","C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/codex.exe","--version"]
```

stdout 原文

```text
codex-cli 0.167.0-alpha.3.2
```

stderr 原文

```text
WARNING: failed to clean up stale arg0 temp dirs: 拒绝访问。 (os error 5)
WARNING: proceeding, even though we could not create PATH aliases: 拒绝访问。 (os error 5) at path "C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\codex-home\\tmp\\arg0-windows\\codex-arg0khXIOK"
```


D6 的首次后代探针使用默认管道 stdio，创建子进程返回 `EPERM`，采证返回 99，该次没有启动孙进程。随后只把后代 stdio 改为 inherit，实际启动的父 PID 32860、子 PID 61228 均记录在 D6 中，子写入返回 EPERM。后代传播结论采用这次成功启动后的结果。

D7 在 DSH read-only runner 下启动了真实 codex.exe。版本命令返回 0，其 stderr 同时记录临时 CODEX_HOME 初始化写入的拒绝。Codex 模型工具链、CodeBuddy 完整工具链在这一外层 wrapper 下仍未验证。

### 4.3 D8—D10 读取范围及 NTFS 硬链接例外

读取样本是本次创建的无敏感信息 fixture，只记录能否读取。硬链接实验先在工作区创建 26 字节的 fixture，再创建工作区外的 alias，二者指向同一 NTFS 文件对象。创建命令如下。

```powershell
New-Item -ItemType HardLink -Path (Join-Path $root 'outside\hardlink-alias.txt') -Value (Join-Path $root 'workspace\hardlink-source.txt')
```

追加探针调用 `fs.appendFileSync(target, 'probe-append\n')`，成功后记录文件长度，失败时记录原始错误并返回 13。

#### D8 read-only 读取目录外无敏感 fixture

时间 `2026-11-10T06:25:59.040Z`，被测进程退出码 `0`。
实际策略为 `read-only`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\read-fixture.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\read-fixture.txt"]
```

关键输出原文

```text
{"pid":60828,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\read-fixture.txt","exists":true,"readSucceeded":true}
```

#### D9 workspace-write 经目录外硬链接追加

时间 `2026-11-10T06:25:59.465Z`，被测进程退出码 `0`。
实际策略为 `workspace-write`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","workspace-write","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\append-fixture.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\hardlink-alias.txt"]
```

关键输出原文

```text
{"pid":28008,"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\hardlink-alias.txt","appended":true,"size":39}
```

#### D10 read-only 经相同硬链接追加

时间 `2026-11-10T06:25:59.856Z`，被测进程退出码 `13`。
实际策略为 `read-only`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\append-fixture.cjs","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\hardlink-alias.txt"]
```

关键输出原文

```text
{"target":"C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\hardlink-alias.txt","code":"EPERM","message":"EPERM: operation not permitted, open 'C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\outside\\hardlink-alias.txt'"}
```


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

### T1 raw-kill-parent

启动时间 `2026-11-10T14:21:46.8704647+08:00`，终止动作时间 `2026-11-10T14:21:48.3966772+08:00`，复查时间 `2026-11-10T14:21:50.4238406+08:00`。controller 退出码为 0，强制结束目标的自然退出码未采集。

动作命令原文

```powershell
Stop-Process -Id 6640 -Force
```

CIM 采集到的 PPID → PID

```text
41976 → 6640 (node.exe)
6640 → 12660 (node.exe)
12660 → 56492 (node.exe)
```

关键输出原文

```text
CASE=raw-kill-parent
ACTION=Stop-Process -Id 6640 -Force
AFTER_COUNT=0
```

### T2 dsh-kill-host

启动时间 `2026-11-10T14:21:50.4637876+08:00`，终止动作时间 `2026-11-10T14:21:52.6351463+08:00`，复查时间 `2026-11-10T14:21:54.6477658+08:00`。controller 退出码为 0，强制结束目标的自然退出码未采集。

动作命令原文

```powershell
Stop-Process -Id 36948 -Force
```

CIM 采集到的 PPID → PID

```text
41976 → 36948 (DeepSeek Harness.exe)
61108 → 22680 (node.exe)
22680 → 61612 (node.exe)
61612 → 55784 (node.exe)
36948 → 61108 (DeepSeek Harness.exe)
```

关键输出原文

```text
CASE=dsh-kill-host
ACTION=Stop-Process -Id 36948 -Force
AFTER_COUNT=0
```

### T3 dsh-terminate

启动时间 `2026-11-10T14:21:54.6519960+08:00`，终止动作时间 `2026-11-10T14:21:56.9100098+08:00`，复查时间 `2026-11-10T14:21:58.9245911+08:00`。controller 退出码为 0，强制结束目标的自然退出码未采集。

动作命令原文

```js
SubprocessHandle.terminate(); await handle.done; await handle.waitForExit()
```

CIM 采集到的 PPID → PID

```text
41976 → 49472 (DeepSeek Harness.exe)
48196 → 47148 (node.exe)
47148 → 51648 (node.exe)
51648 → 54200 (node.exe)
49472 → 48196 (DeepSeek Harness.exe)
```

关键输出原文

```text
CASE=dsh-terminate
ACTION=SubprocessHandle.terminate(); await handle.done; await handle.waitForExit()
AFTER_COUNT=0
```

托管进程完成记录原文

```json
{"result":{"exitCode":1,"signal":null},"time":"2026-11-10T06:21:56.951Z"}
```

### T4 raw-detached-kill-parent

启动时间 `2026-11-10T14:23:20.0174063+08:00`，终止动作时间 `2026-11-10T14:23:21.3930505+08:00`，复查时间 `2026-11-10T14:23:23.4401961+08:00`。controller 退出码为 0，强制结束目标的自然退出码未采集。

动作命令原文

```powershell
Stop-Process -Id 19584 -Force
```

CIM 采集到的 PPID → PID

```text
49720 → 19584 (node.exe)
19584 → 35660 (node.exe)
35660 → 34352 (node.exe)
```

关键输出原文

```text
CASE=raw-detached-kill-parent
ACTION=Stop-Process -Id 19584 -Force
AFTER_COUNT=2
```

残留 PID 与进程名为 `34352 node`、`35660 node`，创建时间仍为该次样本时间。

### T5 dsh-detached-kill-host

启动时间 `2026-11-10T14:23:23.5126280+08:00`，终止动作时间 `2026-11-10T14:23:25.7592759+08:00`，复查时间 `2026-11-10T14:23:27.7763002+08:00`。controller 退出码为 0，强制结束目标的自然退出码未采集。

动作命令原文

```powershell
Stop-Process -Id 48388 -Force
```

CIM 采集到的 PPID → PID

```text
49720 → 48388 (DeepSeek Harness.exe)
11388 → 24652 (node.exe)
24652 → 8100 (node.exe)
8100 → 14060 (node.exe)
48388 → 11388 (DeepSeek Harness.exe)
```

关键输出原文

```text
CASE=dsh-detached-kill-host
ACTION=Stop-Process -Id 48388 -Force
AFTER_COUNT=0
```

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

| 变量名称 | E1 原生继承 | E2 DSH 默认 | E3 DSH 显式 TOKEN | E4 DSH read-only |
| --- | --- | --- | --- | --- |
| `ALL_PROXY` | false | false | false | false |
| `ANTHROPIC_API_KEY` | false | false | false | false |
| `ANTHROPIC_AUTH_TOKEN` | false | false | false | false |
| `AWS_ACCESS_KEY_ID` | false | false | false | false |
| `AWS_SECRET_ACCESS_KEY` | false | false | false | false |
| `AWS_SESSION_TOKEN` | false | false | false | false |
| `CODEBUDDY_API_KEY` | false | false | false | false |
| `CODEX_API_KEY` | false | false | false | false |
| `CODEX_HOME` | true | true | true | true |
| `DEEPSEEK_API_KEY` | false | false | false | false |
| `DSH_HOME` | true | false | false | false |
| `DSH_PERMISSION_MODE` | false | false | false | false |
| `GH_TOKEN` | false | false | false | false |
| `GITHUB_TOKEN` | false | false | false | false |
| `HOME` | false | false | false | false |
| `HTTPS_PROXY` | false | false | false | false |
| `HTTP_PROXY` | false | false | false | false |
| `MT_PROBE_AUTHORIZATION` | true | true | true | true |
| `MT_PROBE_BENIGN` | true | true | true | true |
| `MT_PROBE_COOKIE` | true | true | true | true |
| `MT_PROBE_TOKEN` | true | false | true | false |
| `NPM_TOKEN` | false | false | false | false |
| `OPENAI_API_KEY` | false | false | false | false |
| `SSH_AUTH_SOCK` | false | false | false | false |
| `USERPROFILE` | true | true | true | true |

#### E1 原生 spawn 继承

时间 `2026-11-10T06:20:05.559Z`，被测进程退出码 `0`。

原始 argv

```json
["C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\env-presence.cjs"]
```

关键输出原文

```text
{"name":"DSH_HOME","present":true}
{"name":"MT_PROBE_AUTHORIZATION","present":true}
{"name":"MT_PROBE_COOKIE","present":true}
{"name":"MT_PROBE_TOKEN","present":true}
```

#### E2 DSH 默认 scrub

时间 `2026-11-10T06:20:05.627Z`，被测进程退出码 `0`。
实际策略为 `read-only`，confined 为 `false`。

原始 argv

```json
["C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\env-presence.cjs"]
```

关键输出原文

```text
{"name":"DSH_HOME","present":false}
{"name":"MT_PROBE_AUTHORIZATION","present":true}
{"name":"MT_PROBE_COOKIE","present":true}
{"name":"MT_PROBE_TOKEN","present":false}
```

#### E3 显式 env 回填合成 TOKEN

时间 `2026-11-10T06:20:05.848Z`，被测进程退出码 `0`。
实际策略为 `read-only`，confined 为 `false`。

原始 argv

```json
["C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\env-presence.cjs"]
```

关键输出原文

```text
{"name":"DSH_HOME","present":false}
{"name":"MT_PROBE_AUTHORIZATION","present":true}
{"name":"MT_PROBE_COOKIE","present":true}
{"name":"MT_PROBE_TOKEN","present":true}
```

#### E4 read-only wrapper 中的 env

时间 `2026-11-10T06:20:06.067Z`，被测进程退出码 `0`。
实际策略为 `read-only`，confined 为 `true`，enforcement 为 `partial`。

原始 argv

```json
["C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe","C:\\Users\\30673\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js","--workspace","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\workspace","--temp","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\runtime-temp","--mode","read-only","--","C:/Users/30673/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe","C:\\Users\\30673\\AppData\\Local\\Temp\\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5\\env-presence.cjs"]
```

关键输出原文

```text
{"name":"DSH_HOME","present":false}
{"name":"MT_PROBE_AUTHORIZATION","present":true}
{"name":"MT_PROBE_COOKIE","present":true}
{"name":"MT_PROBE_TOKEN","present":false}
```


本次 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEBUDDY_API_KEY`、`DEEPSEEK_API_KEY`、`GH_TOKEN`、`GITHUB_TOKEN`、`NPM_TOKEN`、三个 AWS 凭据名称均不存在。对这些真实名称，记录只能证明本次样本缺席。TOKEN 过滤行为另由确实存在的合成 TOKEN 实证。

应按工作进程用途建立最小环境白名单，过滤清单至少包含以下类别。清单是后续设计要求，尚待产品实现验收。

- 认证变量与其大小写变体，包括 `*KEY*`、`*TOKEN*`、`*SECRET*`、`*PASSWORD*`、`*CREDENTIAL*`、`*AUTH*`、`*COOKIE*` 以及云厂商、Git、npm 的访问凭据。AUTHORIZATION 和 COOKIE 是本次默认 scrub 实测保留的类别。
- 宿主控制与权限绕过变量，包括 `DSH_*`、`CODEBUDDY_IS_SANDBOX`，以及各 CLI 的授权、配置或 sandbox 覆盖变量。`DSH_*` 当前已有默认过滤，显式 env 回填仍需调用方审核。
- 命令注入和自动加载入口，包括 `NODE_OPTIONS`、`NODE_PATH`、`BASH_ENV`、`ENV`、Python 启动路径/钩子变量、任意指向用户插件与配置目录的覆盖变量。以上类别的实际加载利用保持未验证。
- 代理和代理认证入口，包括 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、SSH/GPG agent socket，以及认证文件定位变量。这些可能指向凭据或带认证信息，默认整包继承应由逐项授权取代。
- 将 `HOME`、`USERPROFILE`、`CODEX_HOME` 和其他 CLI home 映射到受控目录。保留真实 home 可能让工具自行发现文件中的凭据，本次只读目录外 fixture 的成功读取说明还需要独立的读取边界验收。

必要的 CLI 认证可以由受控调用方按用途显式注入最小权限凭据，需同时定义子进程生命周期、日志脱敏与失效规则。文件只读和 env scrub 都需要与凭据可见性一起验收。

## 7. B1 CodeBuddy 当前状态

时间 `2026-11-10T14:24:35.3147472+08:00`，命令退出码 `0`，使用内置 Node v24.21.0 的 PATH。命令原文如下。

```powershell
& 'C:\Users\30673\AppData\Roaming\npm\codebuddy.cmd' --help
```

关键输出原文

```text
  --permission-mode <mode>                         Default permission mode for this process (TUI, --serve Web, ACP). Choices: acceptEdits, bypassPermissions, default, plan, dontAsk, auto. Does not write settings.
  --tools <value>                                  Restrict which built-in tools CodeBuddy can use. Use "" to disable all, "default" for all, or comma-separated tool names like "Bash,Edit,Read".
  --allowedTools <tools...>                        Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")
  --sandbox [url]                                  Run CodeBuddy in sandbox: "container" for Docker/Podman, or E2B API URL (must be complete URL like https://api.e2b.dev)
  --setting-sources <sources>                      Comma-separated list of setting sources to load (user, project, local). Default: user,project,local
```

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

2026-11-10T14:39:00.9259934+08:00 在删除前独立验证了解析后的绝对路径，确认位于本次命名的 TEMP 根目录。目录内 reparse point 数为 0，两条 NTFS 硬链接均指向本次临时 fixture。此前记录的所有进程树 PID 均已消失，另按本次唯一临时目录名查询进程命令行，除检查进程自身外没有匹配项。该查询只输出 PID、PPID、Name。

关键检查输出原文如下，检查命令整体退出 0。

```text
VERIFIED_DELETE_ROOT=C:\Users\30673\AppData\Local\Temp\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5
REPARSE_POINT_COUNT=0
KNOWN_TREE_SURVIVORS=0
TEMP_FILE_COUNT=207
```

实际清理命令原文如下，退出码为 0。

```powershell
Remove-Item -LiteralPath 'C:\Users\30673\AppData\Local\Temp\mt-sandbox-788ad2b5c3bf4975802bb14334e01ce5' -Recurse
```

2026-11-10T14:39:13.0272792+08:00 的 `Test-Path` 复查输出原文如下。

```text
TEMP_ROOT_EXISTS=False
```

删除了这 207 个临时文件及其目录，包括工作区和目录外写入样本、硬链接的两个目录项、五组进程树 PID/控制文件、采证脚本、只含存在性信息的 env 记录、公开官方源码副本、临时 DSH_HOME、两份 CODEX_HOME、CodeBuddy 隔离 home、CLI 初始化和沙箱日志。真实 profile 不在删除范围内。

文中 14 组关键写入/拒绝输出在清理前逐项与原始记录做字符串匹配，全部为 true。仓库交付范围只有 `docs/audit/08-sandbox.md`。P0-08 的审计取证和清理已完成，真实 session、模型执行与产品权限承诺的未验证项保留在第 8—9 节。
