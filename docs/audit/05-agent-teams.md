# 05 · Agent Teams 兼容性（P0-05）

> 采集人：八戒（汇总 01/03 的实测 + 负责人决策）｜日期：2026-11-10
> **结论：不纳入第一版。** 本文只记录现状与代价，供 0.2.0 再评估。

## 1. 现状（证据来自 01-environment 与 03-native-capabilities）

| 项 | 事实 | 来源 |
| --- | --- | --- |
| 官方包 | `@deepseek-ai/dsh-experimental-agent-team@0.2.2-rc.1` **随宿主一起附带**（329 个 sharedPackages 之一） | 01 §3.5 / 03 §2.1 |
| 当前 profile | **未挂载**（`dsh.profile.bundles` 里没有） | 01 §3.2 |
| 性质 | 命名带 `experimental`，官方未承诺稳定 | 交接文档 3.2 |
| 第三方先例 | 本机 2026-11-09 装过 `@nanmicoder/dsh-agent-teams@0.1.29`，同日 16:07 卸载 | 01 §3.6 |
| 配套 UI | 仓库有 `packages/client/ui-agent-team`、`packages/team/*`，但本机未启用 | 03 §2.1 |

## 2. 为什么第一版不用

1. **Experimental**：API 可能随 nightly 通道漂移（风险 R6），而我们的第一版要稳定可发布。
2. **成员模型不匹配**：Team 成员要求可持续交互的 agent；我们第一阶段的外部 CLI 是一次性任务型 subagent，把它当 Team 成员会制造"看起来在、其实不在"
   的假象（交接文档 3.2 明确警告）。
3. **价值不在第一版**：我们要验证的是"角色 → 通道 → 派单"这条主链路，`ctx.subagents` + `dsh-tool-subagent` 已经够；Team 是协作形态的增强，不是地基。
4. **已有一次失败尝试**：本机有人装过第三方 agent-teams 又当天卸载，说明这条路当前不顺畅——不值得我们第一版去踩。

## 3. 后续评估条件（0.2.0 前置）

- 官方把 `dsh-experimental-agent-team` 从 experimental 转正，或给出稳定 API 承诺；
- 明确外部 provider 的 subagent 能否成为 Team 成员，以及成员断线/超时后的语义；
- 用临时 profile 实测启用一次（不碰真实 `desktop`），记录 `--dump-config` 与运行行为；
- 到那时再回答："角色派单能否升级成团队协作"。

## 4. 未验证项

| 项 | 状态 |
| --- | --- |
| 启用 agent-team bundle 的实际命令与副作用 | 未验证（第一版不需要） |
| `dsh-experimental-agent-team` 与仓库 `packages/team/agent-team` 是否同一产物 | 未验证（03 §4 U2） |
| Team 成员对一次性 subagent 的兼容性 | 未验证（官方文档语义不支持，未实测） |
