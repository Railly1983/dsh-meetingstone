# 17 · Claude Code 接入：官方 provider 不兼容，第三方方案被否决（2026-11-11）

## 结论

**当前无法用"官方原生"方式接入 Claude Code。** 已回滚第三方适配器方案，等待上游发布兼容版本的 provider。

## 事实

| 项 | 值 |
| --- | --- |
| 本机 claude CLI | `2.1.322 (Claude Code)`，已登录 |
| 官方 provider | `@deepseek-ai/dsh-subagent-claude-code@0.0.1-rc.1`（npm 上唯一版本） |
| 宿主 DSH | `0.2.2-rc.1` |
| 不兼容证据 | provider 的 peerDependencies 为 `@deepseek-ai/dsh-timeout: ^0.0.1-rc.1` 等（0.0.x 系列）；宿主提供 `0.2.2-rc.1`，semver 不匹配 |
| 实际表现 | 插件行 `fiberPhase: null`（无法激活）；直接 import 报 `Cannot find package '@deepseek-ai/dsh-timeout'` |

## 走过的弯路（记录以免重犯）

1. 接受版本豁免强行安装 → 能装上，但永远无法激活（peer 不匹配）
2. 改用 `@zed-industries/claude-code-acp@0.16.2`（Zed 官方 ACP 适配器）挂到我们的 acp 通道 → 技术上可用（ACP 握手、认证、prompt 都通）
3. **用户否决第三方方案**：项目原则是"尽量复用 DSH 原生能力"，对 DSH 而言第三方适配器仍属外来件，且引入未批准的供应链依赖

## 正确的下一步

1. **等待** `@deepseek-ai/dsh-subagent-claude-code` 发布与宿主 0.2.x 兼容的版本（届时按普通 provider 行接入，零自研）
2. 若用户明确批准"第三方例外"，再启用 ACP 适配器方案（需写进配置与文档，默认关闭）
3. 不采用"自研 claude CLI 包装"（违反薄原则）

## 回滚内容

- 卸载 `@zed-industries/claude-code-acp`
- 移除 profile 行 `subagent-acp-claude` / `subagent-claude-code`
- 移除通道 `ch-claude` 与角色 `role-claude`
- 备份：`cordis.patch.yml.bak12-*`
