# 兼容性矩阵

> 只列**实测过**的组合。未测的一律写"未验证"。
> 最后更新：2026-11-10（DSH `0.2.2-rc.1`）

## 1. DSH 宿主

| 项 | 实测值 | 说明 |
| --- | --- | --- |
| DSH 包版本 | `0.2.2-rc.1` | `engines.dsh = ">=0.2.2-rc.1 <0.3.0-0"`，别的版本会被安装器拒绝 |
| hostProtocolVersion | `4` | |
| 宿主 node | `24.21.0` | 插件运行在宿主的 node 上 |
| 宿主 pnpm | `11.28.5` | 安装 bundle 用；**必须用宿主 node 跑**（系统 node v20 会崩） |
| 平台 | Windows 11 25H2 x64 | 其它平台未验证 |
| 通道 | nightly | 宿主 API 可能漂移；`<0.3.0-0` 已挡住整个 0.3 预发布线 |

## 2. 执行通道（provider）

> ⚠️ 官方 provider **不解析本机 PATH 的 codex/claude**，用它自带的 pinned CLI（`audit/03-native-capabilities.md` F2）。

| 通道 | 需要安装 | 装完是否自动生效 | 状态 |
| --- | --- | --- | --- |
| `in-process` | 无需额外安装（`dsh-subagent-*-in-process` 随宿主） | 是 | ✅ 可用 |
| `codex` | `@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1` | 是（declares `dsh.bundle`） | ✅ 隔离安装实测 |
| `acp-cli` | `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.1` | **否**：还要手写 `subagent-acp` 行（`command`/`args`） | ✅ 隔离安装实测 |
| `claude-code` | `@deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.1` | 是 | ⚠️ 未验证（本机未装 Claude CLI，也不影响 provider 自带） |

版本必须写精确值：`next` = `0.2.2-rc.1`；`latest` 是 2026-08 的 `0.0.1-rc.1`，与宿主不匹配。

## 3. 本机 CLI（仅用于状态探测，不用于执行）

| CLI | 探测结果 | 来源 | 备注 |
| --- | --- | --- | --- |
| Codex | `0.167.0-alpha.3.2` | **appx**（PATH 查不到） | 商店应用包内路径，随应用升级漂移 → 必须运行时解析 |
| CodeBuddy | `2.181.0` | path | 另有 `cbc` / `codebuddy-code` / `codebuddy-lowmem` 入口 |
| Claude | 未安装 | — | 探测如实返回 `installed:false` |

## 4. 已知不兼容 / 风险

| 项 | 影响 | 处理 |
| --- | --- | --- |
| Windows 沙箱 `enforcement=partial` | 目录外硬链接可越界写 | 不承诺"绝不修改项目外路径" |
| provider 带入 `cosmokit 1.9.0` / `schemastery 3.19.0` | 与第三方插件带入的 `1.8.6` / `3.18.5` 可能去重升级 | 先隔离 profile 验证再动 desktop（`audit/10-provider-install.md`） |
| 宿主 `register()` 不校验 `parameters` | 坏 schema → 全局 400 | `npm run verify` 门禁 + 注册前 fail-fast（`audit/13`） |
| 外部任务不进原生 Subagents UI | 无法在原生面板看到进度 | 产品文案不承诺（`audit/06`） |
