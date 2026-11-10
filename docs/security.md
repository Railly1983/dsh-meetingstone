# 安全与权限边界

> 本文只写**实测支持**的内容。所有结论都指向 `docs/audit/` 里的证据，不做超出证据的承诺。
> 最后更新：2026-11-10

## 1. 一句话

本插件不自己造权限体系，而是把 DSH 原生的权限/审批/沙箱**显式**用起来；哪个档位无法真正强制，就报错或不承诺，不靠 Prompt 约束。

## 2. 四档权限能诚实承诺到什么程度

| 档位 | 能承诺 | 不能承诺 | 依据 |
| --- | --- | --- | --- |
| `read-only` | **条件化**：在带原生只读沙箱的通道上，受控命令的普通文件写入会被拒 | 完整 CLI 初始化、插件代码、已登录模型执行、CodeBuddy 通道、网络边界都未验证 | `audit/08-sandbox.md` §3、§8 |
| `restricted` | 启动前的 executable/argv 与受控工具名单可作为独立设计范围 | 外部 CLI 内部工具、后代执行命令及其解释器行为未验收 | 同上 §8 |
| `project-write` | 普通写入限制在所选工作区内 | ⚠️ Windows 当前 `enforcement="partial"`：**目录外硬链接 alias 写入已实测成功**。"绝不修改项目外路径"不承诺 | 同上 §4.3、§8 |
| `approval` | 对启动、提权、额外目录、凭据注入分别设批准点 | 真实 session 的审批往返未验证；工作进程内部每次工具调用是否再批准需单独集成 | 同上 §8 |

**关键实现细节**：官方子任务启动 spec **没有** permission/readOnly 字段，所以只读只能由 **provider 行（通道实例）** 保证。

现行规则：
- 角色是 `read-only` → 必须引用 `permissionPreset: read-only` 的通道实例，否则 `READONLY_UNENFORCEABLE` 拒绝启动；
- 实例声明只读且启动成功 → `taskRef.readOnlyEnforced = true`；
- 没有实例、或实例不是只读 → **拒绝启动**，绝不启动后标 `readOnlyEnforced:false` 假装生效（2026-11-10 P2 Gate 结论）。

## 3. 凭据与环境变量

| 项 | 事实 | 我们的处理 |
| --- | --- | --- |
| 普通 `spawn` | 会继承合成 `TOKEN`、`AUTHORIZATION`、`COOKIE` | 不经我们的手：执行交给宿主 provider |
| DSH 默认 scrub | 过滤 `TOKEN` 与 `DSH_HOME`，**保留 `AUTHORIZATION`、`COOKIE`** | 产品文档如实记录；不宣称"已过滤全部密钥" |
| 显式 env | 可以重新传入 `TOKEN` | 我们**不注入**任何凭据变量 |
| 登录凭据 | 各 CLI 自己的 `auth.json` / `settings.json` | **不读取、不复制、不导出、不共享**；探测只报文件是否存在（`audit/01-environment.md` §6） |

## 4. 进程与清理

| 场景 | 结论 |
| --- | --- |
| 杀父进程 | 普通 detached 子进程及孙进程会**残留** |
| 走 DSH 托管入口 | 普通与 detached 样本在强杀宿主后**都消失**（实测） |
| 插件卸载 | 单一 `ctx.effect` disposer 串行 await 全部收尾；取消时先 abort 再 `activation.dispose()` |

> 所以：**不要绕过宿主去 spawn CLI**。这是"不自研启动器"红线的安全理由（`audit/03-native-capabilities.md` F2/F3）。

## 5. 工具 schema 契约（2026-11-10 事故）

一个非法的工具 `parameters` 会让 DeepSeek 对**整个 tools 数组**返回 400，导致 profile 下所有会话不可用。现行防御：

1. `npm run verify`（测试 + `scripts/verify-host-schema.mjs`）**装真实 profile 前必须通过**；
2. 注册前 `assertHostReadySchema` fail-fast，坏定义让插件自己加载失败；
3. 两条注册路径（官方 `defineTool` / 本地等价编译）都只交合法 JSON Schema。

复盘：`audit/13-incident-tool-schema.md`。

## 6. 项目隔离

- 派单的 `cwd` 必须落在当前会话项目根之内，否则 `PATH_OUTSIDE_PROJECT` 拒绝；拿不到项目根则失败关闭。
- 不建平行项目管理、不做跨项目写入。
- 项目级配置只读项目根下的 `.meetingstone.json` 一个文件，不遍历目录。

## 7. 报告安全问题

请用仓库的 SECURITY.md 流程（不要开公开 issue）。本文件只描述**当前版本**的边界，不是永久承诺。
