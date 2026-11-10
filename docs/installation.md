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

# 从本地 checkout 安装（开发期）
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
| 想用外部 CLI 派单 | 需要先装官方 provider bundle | 见 `docs/audit/03-native-capabilities.md` §3（B 类），阶段 2 会给出具体命令 |

## 开发者：跑测试

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --test "tests/**/*.test.mjs"
& $node scripts/verify-manifest.mjs
```
