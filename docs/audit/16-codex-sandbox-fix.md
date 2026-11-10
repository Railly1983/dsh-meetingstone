# 16 · Codex 沙箱初始化失败与修复（2026-11-11）

## 现象

Codex 通道派单时，只要子 Agent **调用工具**（读写文件、执行命令），任务立即失败，诊断：

```
Failed to create unified exec process: helper_sandbox_lock_failed:
lock sandbox bin dir C:\Users\30673\.codex\.sandbox-bin failed:
SetNamedSecurityInfoW sandbox dir failed: 5
```

- 纯文本任务（"只回复 PONG"）**不受影响**，所以早期冒烟测试没暴露
- 需要读文件才能干活的角色（如悟空做代码评审）会整单失败，报"工具不可用/被阻止"

## 根因

1. `~/.codex/config.toml` 里 `[windows] sandbox = "elevated"`
2. 该模式会启用 Windows 沙箱专用账户（`XIAOMIBOOK\CodexSandboxUsers`），Codex 需要**修改**
   `C:\Users\30673\.codex\.sandbox-bin` 的 ACL（`SetNamedSecurityInfoW`）
3. 该目录**属主是 `BUILTIN\Administrators`**：

   ```
   C:\Users\30673\.codex\.sandbox-bin XIAOMIBOOK\CodexSandboxUsers:(OI)(CI)(RX)
                                      NT AUTHORITY\SYSTEM:(OI)(CI)(M)
                                      BUILTIN\Administrators:(OI)(CI)(M)
                                      XIAOMIBOOK\30673:(OI)(CI)(M)
   Owner: BUILTIN\Administrators
   ```

   当前进程没有 `WRITE_DAC`（改 DACL 需要属主或相应权限），于是返回 `ERROR_ACCESS_DENIED (5)`。

## 修复

把 `[windows] sandbox` 从 `elevated` 改为 `unelevated`：

```toml
# C:\Users\30673\.codex\config.toml
[windows]
sandbox = "unelevated"
```

- 备份：`config.toml.bak-sandbox`
- 验证：在临时目录让 Codex 执行 `type probe.txt`，输出 `SANDBOX_OK`
- 影响：该配置是**全局**的，用户自己的 Codex CLI 也会用 unelevated（常规模式，非提权沙箱）

## 为什么不选另一条路

| 方案 | 结论 |
| --- | --- |
| 取得 `.sandbox-bin` 属主（`takeown`/改 ACL） | 需要提权；且 Codex 每次版本升级可能重建该目录，修复不稳定 |
| 用 `dangerously-bypass-approvals-and-sandbox` | 关闭沙箱，安全上不可接受 |
| 独立 `CODEX_HOME` 只放 unelevated 配置 | 需要复制/隔离认证，存在 token 轮换冲突风险（未验证） |
| **改全局 `[windows] sandbox = unelevated`** | ✅ 最小改动、已验证；代价是全局生效 |

## 教训

**冒烟测试必须覆盖"会调用工具"的任务**。纯文本 PONG 通过不等于通道可用；
只有当子 Agent 真正读/写文件、执行命令时，沙箱、权限、cwd 这些基础设施才会被触发。
