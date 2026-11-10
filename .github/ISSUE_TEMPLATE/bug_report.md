---
name: 问题反馈
about: 报告 bug 或兼容性问题
title: ''
labels: ''
assignees: ''
---

> ⚠️ 安全漏洞请不要在这里公开，见 SECURITY.md。

**环境**

- DSH 版本（`dsh --version` 或 profile 的 `package.json`）：
- 插件版本：`dsh-meetingstone@`
- 操作系统：
- 通道类型：`in-process` / `acp-cli` / `codex` / `claude-code`
- 相关 provider 版本（如装了）：

**现象**

发生了什么？期望是什么？

**复现步骤**

1.
2.
3.

**证据**

- 工具返回的错误码（如 `MODEL_UNSUPPORTED` / `PROVIDER_UNAVAILABLE` / `READONLY_UNENFORCEABLE`）：
- 相关日志或报错原文（**不要贴凭据**）：

**已排除**

- [ ] `npm run verify` 通过
- [ ] 已确认 provider 已安装（`--dump-config` 能看到对应行）
- [ ] 已重启 DSH（配置改动需要重启）
