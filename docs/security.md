# 安全与权限边界

> 本文只写**实测支持**的内容。所有结论都指向 `docs/audit/` 里的证据，不做超出证据的承诺。
> 最后更新：2026-11-11

## 1. 一句话

本插件不自己造权限体系。**本项目不提供只读通道**：宿主 subagent 启动 spec 没有权限字段，做不到绝对只读，所以整个功能已移除，不做半吊子承诺。实际权限由 provider 行（profile 配置）决定，不由插件保证。

## 2. 为什么不提供只读通道

官方 `SubagentActivationSpec` / `SubagentStartRequest` **没有** permission / readOnly / sandbox 字段；provider 的 `permissionMode`（codex/claude-code）与 `permission`（acp）是**挂载时的行配置**（`audit/10-provider-install.md` §8.1），不是每次 start 的参数。插件既无法在派单时强制只读，也无法验证 provider 行真的限制了写入。

2026-11-11 用户决策：**彻底移除只读通道**——`readOnly` 参数、`readOnlyEnforced`、`permissionPreset`、`READONLY_*` 错误码与只读限流全部删除。**不要再实现**。

派单时插件仍能保证的边界：

- `cwd` 必须落在当前会话的项目根之内，否则 `PATH_OUTSIDE_PROJECT` 拒绝；拿不到项目根则失败关闭；
- provider 未注册、parent 缺失、模型与通道实例不一致 → 拒绝启动；
- 默认每个任务在独立 git 工作树里执行（并行上限 2/项目、4/全局）；请求隔离但建树失败 → 拒绝派单，
  绝不退回主工作区；`isolation:none` 与隔离任务不得混跑。
- **工作树隔离不是权限沙箱**：子 Agent 仍在同一系统账号下运行，可以主动写主工作区，
  也共享同一份 git 元数据。它只保证"默认 cwd 不同、改动不直接落主工作区"。
- 工作树/分支一律不自动删除（完成/失败/取消/卸载都不删），避免丢掉未合并代码。

权限本身请按 provider 行配置并自行验收；`audit/08-sandbox.md` 记录的实测边界仍然适用（例如 Windows 上目录外硬链接可能绕过工作区限制）。

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
- 任务级工作树固定建在 `<projectRoot>/.meetingstone/worktrees/<operationId>`，建树前与建树后都做
  realpath 校验（防 junction/symlink 逃逸）；但这仍是**文件布局隔离，不是权限沙箱**。

## 7. 报告安全问题

请用仓库的 SECURITY.md 流程（不要开公开 issue）。本文件只描述**当前版本**的边界，不是永久承诺。
