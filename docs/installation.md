# 安装与卸载

> 适用版本：DSH `0.2.2-rc.1`（插件已用 `engines.dsh = ">=0.2.2-rc.1 <0.3.0-0"` 声明兼容范围）

## 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `0.2.2-rc.1` 或 0.2.x 后续版本 | 版本不符会被安装器拒绝（这是官方行为，不是本插件的限制） |
| Node | ≥ 22.13（推荐用 DSH 内置 node v24.21.0） | ⚠️ 系统 node v20 跑内置 pnpm 会崩（`node:sqlite`），见 `docs/audit/01-environment.md` §4.2 |

## 安装

本插件是标准 DSH bundle，用官方 CLI 安装（`dsh` 不在 PATH，用安装目录里的转发脚本）：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 方式 A（推荐，生产/日常）：先打包，再装 tarball
#   ⚠️ tgz 必须放在**仓库之外**的稳定目录：pnpm 处理 file: 依赖时会去读该目录的
#      node_modules/依赖图，放在仓库内会因符号链接权限报 EPERM
& $node $pnpm pack                      # 在仓库根执行，产出 dsh-meetingstone-<版本>.tgz
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\packages" | Out-Null
Move-Item .\dsh-meetingstone-*.tgz "$env:USERPROFILE\.dsh\packages\" -Force
& $dsh plugin --profile desktop add "$env:USERPROFILE\.dsh\packages\dsh-meetingstone-0.0.1.tgz"

# 方式 B（开发期，改代码即生效）：linked 安装
#   ⚠️ profile 里会创建指向仓库的 **junction**；**不要对 profile 目录做递归删除**
#      （本次已实测：递归删除会顺着 junction 进入仓库）
& $dsh plugin --profile desktop add "D:\MeetingStone"
```

安装成功会看到：

```text
dependencies:
+ dsh-meetingstone 0.0.1 <- D:\MeetingStone
```

## 验证

```powershell
# 确认 bundle 层进入了有效配置
& $dsh --profile desktop --dump-config | Select-String -Pattern "meetingstone" -Context 0,1
```

应当看到：

```yaml
# == dsh-meetingstone
- id: meetingstone
  name: dsh-meetingstone
```

> `--dump-config` 只证明**配置组合**成功，不证明插件 `apply()` 已执行——两者要分开看（见 `docs/audit/02b-engine-probe.md` §4）。

## 可选：安装执行通道（provider）

第一版不做 UI，"角色 → 通道"的通道本身由**官方 provider bundle** 提供。按需安装：

```powershell
# Codex 通道（是 bundle，装完自动出现 subagent-codex / tool-subagent-codex 两层）
& $dsh plugin --profile desktop add '@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1'

# ACP 通道（不是 bundle，装完还要手写一行配置，见下）
& $dsh plugin --profile desktop add '@deepseek-ai/dsh-subagent-acp@0.2.2-rc.1'
```

> ⚠️ 版本必须写精确版本 `0.2.2-rc.1`（= `next` 标签）。`latest` 是 2026-08 的 `0.0.1-rc.1`，与宿主不匹配。

### ACP 通道必须手写这一行

`@deepseek-ai/dsh-subagent-acp` **不声明 `dsh.bundle`**，`plugin add` 只装依赖、不会产生配置层。要在 profile 的 `cordis.patch.yml` 里自己加：

```yaml
- insert:
    - id: subagent-acp
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        command: <一个可执行文件名>
        args: [<参数...>]
```

- `command` 是**单个可执行文件字符串**，参数放 `args` 数组（不是数组形式的 command）
- **没有 `cwd` 字段**，子进程使用父会话当前目录
- `permission` 默认 `reject`
- 具体的 `command` 取决于你接哪个 ACP CLI，第一版不预置默认值（CodeBuddy 无头入口在本机非 TTY 下会崩，见 `docs/audit/04-cli-matrix.md`）

> ⚠️ 装 provider 会带入 `cosmokit 1.9.0` / `schemastery 3.19.0`，而你的 `desktop` profile 里目前是 `1.8.6` / `3.18.5`（第三方插件带入）。装之前建议先在隔离 `DSH_HOME` 里试一遍，确认 pnpm 的去重升级不会打断现有插件。实测记录见 `docs/audit/10-provider-install.md`。

## 配置角色与通道（第一版无 UI，改配置后重启生效）

第一版没有图形界面，配置写在 profile 的 `cordis.patch.yml` 里。**关键是 `channels` 表**：

```yaml
- id: meetingstone
  name: dsh-meetingstone
  config:
    # 通道实例：一行 = 一个已配置好的 provider（模型写在这里）
    channels:
      - channelId: ch-acp-flash
        kind: acp-cli
        provider: acp
        model: deepseek-v4.1-flash      # 该 provider 行实际用的模型
        reasoning: high
    roles:
      - roleId: role-sashi
        name: 沙僧
        aliases: [SS, 主力执行]
        description: 主力开发和批量执行
        channel:
          kind: acp-cli
          channelId: ch-acp-flash        # 引用上面的通道实例
          model: deepseek-v4.1-flash     # 声明期望值，必须与实例一致
          reasoning: high
        enabled: true
    defaultRoleId: role-sashi
```

**为什么模型写在通道实例上**：DSH 的子任务启动 spec 不接收 model/reasoning，模型只能在 provider 行上配置。角色写了 model 就必须引用一个配置了同一模型的 `channelId`，否则派单会被拒绝（`MODEL_UNSUPPORTED`）——我们宁可报错，也不做"配置成功、执行没采用"的假象。

> **本项目不提供只读通道**：宿主 subagent 启动 spec 没有权限字段，做不到绝对只读，所以没有 `permissionPreset` / `readOnly` 参数，也不要再实现。实际权限由 provider 行（如 Codex 的 `permissionMode`）决定；Windows 上仍有边界（目录外硬链接可能越界），别把它理解成"绝对只读"。详见 `docs/audit/08-sandbox.md`。

## 安装前必做（发布门禁 · 2026-11-10 事故后新增）

> **教训**：一个非法的工具 `parameters` 会让 DeepSeek 对**整个 tools 数组**返回 400，
> profile 下所有会话每一轮都发不出请求。详见 `docs/reference/incident-tool-schema.md`。

```powershell
# 1) 门禁：全量测试 + 宿主/模型 API 契约校验（不过不许装）
npm run verify

# 2) 隔离 profile 里"跑得动"（不是只看 --dump-config）
$env:DSH_HOME = "$env:TEMP\mt-isolated\dsh-home"
& $dsh plugin --profile mt-test add "D:\MeetingStone"
# 启动该 profile 后发一轮最小消息，确认 200 且工具可见，再动 desktop
```

三条硬规则：

1. **`npm run verify` 不过，不装真实 profile。**
2. **"装得上" ≠ "跑得动"**：必须真发一轮请求。
3. 新插件先进 `bundles` 但在 `cordis.patch.yml` 里 `disabled: true`，验证后再放开。

## 回滚（一分钟止血）

```powershell
# 方式一：CLI 卸载
& $dsh plugin --profile desktop remove dsh-meetingstone

# 方式二：profile 文件已备份（安装前自动备份）
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-<时间戳>" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
# 然后重启 DeepSeek Harness
```

### ACP 通道实战：接 CodeBuddy（2026-11-10 实测）

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
    command: 'C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    args:
      - 'C:\Users\<你>\AppData\Roaming\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy'
      - '--acp'
    permission: allow
```

**关键坑**：CodeBuddy 的 ACP 入口必须**保持 stdin 打开**才能起来——如果启动后立刻关闭 stdin，
会崩在 headless 初始化（`Failed to start the backend application`），这也是早期探测误判"不可用"的原因。
用 `command: codebuddy`（.cmd）不行：子进程直接 spawn 不经过 shell，.cmd 起不来；要用 node + bin 脚本。

握手验证（不依赖 DSH，可单独跑）：向 `node <bin> --acp` 的 stdin 写一行
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}`，
应收到带 `agentCapabilities` 的 result。

## 卸载

```powershell
& $dsh plugin --profile desktop remove dsh-meetingstone
```

卸载后应确认：`package.json` 的 `dsh.profile.bundles` 不再包含 `dsh-meetingstone`，`--dump-config` 不再出现该层。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `installation rejected: ... is incompatible with dsh ...` | `engines.dsh` 不匹配 | 确认 DSH 版本；本插件要求 `>=0.2.2-rc.1 <0.3.0-0` |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | 用系统 node v20 跑了内置 pnpm | 用 DSH 内置 node v24.21.0 执行 |
| 安装成功但界面上看不到任何东西 | 第一版**没有 UI**（已决定排到 0.2.0） | 角色表通过 `meetingstone_list_roles` 工具查看，配置写在 profile 的 `cordis.patch.yml` |
| 想用外部 CLI 派单 | 需要先装官方 provider bundle | `& $dsh plugin --profile desktop add @deepseek-ai/dsh-subagent-codex@0.2.2-rc.1` |
| 安装报 `EPERM: rename ... dsh-meetingstone_tmp_*` | profile 里残留了旧的 junction，pnpm 无法在它上面 rename | 先 `cmd /c rmdir "<profile>\node_modules\dsh-meetingstone"`（只删链接），再重装 |
| 安装报 `EPERM: symlink` | tgz 放在仓库内，pnpm 试图链接其 devDependencies | 把 tgz 移到仓库外（如 `~/.dsh/packages`）再装 |

## 开发者：跑测试

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --test "tests/**/*.test.mjs"
& $node scripts/verify-manifest.mjs
```

### 换成新版 Codex（2026-11-10 实测可用）

provider bundle 自带 `@openai/codex@0.153.4`，且**在自己的 node_modules 里解析**二进制
（`createRequire(import.meta.url).resolve("@openai/codex/package.json")`），
所以不能靠 profile 的 `pnpm.overrides` 换版本（实测被插件管理器忽略）。

可行做法是**物理镜像**：先把新版装成 profile 的直接依赖，再把它的内容镜像进 provider 的嵌套目录。

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$dsh  = "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1. 装新版（作为普通依赖，不产生 profile 层）
& $dsh plugin --profile desktop add @openai/codex@0.167.0-alpha.3.2

# 2. 镜像到 provider 的嵌套依赖（先确认目标不是 reparse point！）
$root = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@openai\codex"
$prov = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-subagent-codex\node_modules\@openai\codex"
robocopy $root $prov /MIR /R:1 /W:1

# 3. 验证 provider 解析到新版本
$script = "const {createRequire}=require('node:module');const r=createRequire('file:///$($prov -replace '\\','/')/lib/index.js');console.log(require(r.resolve('@openai/codex/package.json')).version)"
& $node -e $script
```

**注意**：provider 重装/升级会把嵌套依赖还原成 pinned 版本，需要重新执行第 2 步。
已验证 0.167 与 provider 的 app-server 协议兼容（initialize / thread/start / turn/start / turn/completed），
且该版本下可用模型包括 `gpt-6.1-sol`、`gpt-5.6-sol`、`gpt-6-astra`、`gpt-6-luna`。

> 不要写 `pnpm-workspace.yaml` 的 overrides：profile 自带该文件（`nodeLinker: hoisted`），
> 覆盖它会把 profile 当成 workspace 根，安装直接失败。


### 必做：Codex 沙箱改 unelevated（2026-11-11 实测）

若 Codex 子 Agent 一调用工具就报：

```
helper_sandbox_lock_failed: lock sandbox bin dir ...\.sandbox-bin failed:
SetNamedSecurityInfoW sandbox dir failed: 5
```

把 `%USERPROFILE%\.codex\config.toml` 的 `[windows] sandbox` 从 `elevated` 改为 `unelevated`（先备份）。
原因：elevated 模式要改 `.sandbox-bin` 的 ACL，而该目录属主是 Administrators，当前进程没有 WRITE_DAC。
详见 `docs/audit/16-codex-sandbox-fix.md`。
