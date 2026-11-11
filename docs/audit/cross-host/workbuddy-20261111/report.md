WorkBuddy 接入可行性验收：NO-GO（普通用户安装的完整桌面集成）；角色＋MCP 子集可 GO。
验收日期：2026-11-11；本机版本 5.9.3。仅分析文件、官方文档及执行提取的纯策略函数，无安装、配置修改或真实会话调用。
W＝C:/Users/30673/AppData/Local/Programs/WorkBuddy/resources/app.asar；W/… 表示 ASAR 虚拟内部路径，非普通磁盘目录。
H＝W/node_modules/@genie/agent-harness/lib；R＝W/renderer/assets；混淆包保留原始行号，列号与代码片段在 code-evidence.log。
安装包 SHA256：dcabcd90f07a627a06f1fd55bc872a1c25a79aab43c3012930b6287840ab3d20。

1. 扩展授权：UI 有限支持；宿主特权需厂商授权，普通用户自行提权不支持。
- 修正上一轮：不能由 processPolicy.renderer=null 推导“所有 UI 都不可用”。R/extension-mount-Dfjnas5X.js:94 的 selectExtensionSettings 接受 platform，resolveContainer 接受 HTML iframe，拒绝非 builtin Module Federation。
- R/DataManagementPanel-DrmkV68V.js:1 将 target=dataManagement 的贡献挂载为 settings；R/contexts-Cfdc2AZw.js:195 也挂载扩展设置。内存测试证明普通 platform 设置项被选中，HTML→iframe，remoteEntry.js→拒绝；尚未实际装载页面。
- 实现候选为配置根/extensions-dev/<id>/extension.json，声明 ui.entry.url=HTML、ui.settings；W/main/pidusage.js:1 的 resolveExtensionsScanRoots/resolveExtensionRoot 接受显式 dev 来源。它是代码支持的本地开发入口，未找到公开承诺的普通插件安装分发规范，不能视为已验收发布路径。
- W/main/daemon-bootstrap.js:35 createDefaultThirdPartyDistribution 返回空 grantedPermissions；resolveDistribution/allowDiskDistribution 对用户根忽略自带 distribution.json，唯一硬编码例外 Ac=[iwiki]，不能由用户追加。
- 同处 createExtensionPermissionSetup 另给 platform 基线 bus.emit/on、context.set/delete；不是“完全零权限”，但不含会话或数据读取权限。
- 同处 allowService 仅允许 bundled、已验证 installed 或非 production 调试；生产版即使设置 WB_ALLOW_UNSIGNED_EXTENSION_SERVICE=1，dev 服务仍被拒（已执行验证）。
- 同处 setupExtensionRegistry 强制目录签名；verifyExtensionIntegritySignature 检查 trustedSigners、allowedKinds 和 Ed25519。WB_ALLOW_UNSIGNED_REMOTE_BUILTIN 也受非 production 条件限制；分发 URL 覆盖并非授权开关。
- 正式开放路径为插件内容、连接器、专家/专家团及审核后的外部应用；[开放平台](https://open.workbuddy.cn/docs)、[插件](https://www.codebuddy.cn/docs/workbuddy/Plugins)。未找到桌面 extension.json 签名资格的公开申请流程；需厂商明确提供授权与兼容承诺。

2. ACP 运行时：普通扩展接管桌面会话不支持；独立 CodeBuddy CLI ACP 支持。
- “dsh-protocol/acp-v2”不是本机已确认入口：扫描 7163 个可读包内文本文件无此字面量；15 个 unpacked 文件缺失，详见日志。实际 H/protocol/acp-v2.js:1 引入 @agentclientprotocol/sdk/experimental/v2，定义 new/resume/prompt/cancel/update，属于 Harness 协议层。
- 桌面实际链路证据：W/main/server.js:1159 WorkbuddyACPClient 将 newSession/prompt/cancel 映射到 session/new、session/prompt、session/cancel；:1160 createWorkbuddyAgentAcpClient 包装它，后端使用 --serve --session-id 由宿主管理进程与端口。
- 协议定义存在不等于桌面授予接入。W/main/stdio-framing.js:11 createBridgeAuthorizer＋W/main/netdrive-env-route.js:1 PermissionRegistry 按实际授权拒绝特权调用；提取执行时 create/ensureRuntime 等候选调用均 MISSING_GRANT，未派发真实 RPC。
- W/main/rpc-connection.js:1 明确拒绝扩展调用非 wb:* 通道，返回 PERMISSION_DENIED；没有验证出普通扩展获取桌面 ACP endpoint/token、注册 ACP client 或启动桌面会话的公开入口。
- [官方 ACP](https://www.workbuddy.cn/docs/cli/acp)支持 codebuddy --acp，由外部客户端承载会话；它是独立 CLI，不能据此声称控制 WorkBuddy 桌面现有会话。
- 正式但需授权的替代：[第三方应用](https://open.workbuddy.cn/docs/third-party-app)的硬件/合作伙伴应用经审核、OAuth 后可申请 user.localassistant.invokable/readable；[Open API](https://open.workbuddy.cn/docs/openapi)提供 POST/GET /openapi/v2/localassistant/message，回 message_id、可轮询历史，未列本地 session/new/cancel；云任务返回 ACP link/token，属于云端。

3. 角色/工具：支持用户扩展点；不需要使用内部 Harness SDK。
- agents：W/main/app-instance.js:2 configureElectronApp 设置 CODEBUDDY_CONFIG_DIR；W/main/workbuddy-product-config.js:3 默认配置根为 ~/.workbuddy；W/cli/dist/codebuddy-lite-wb.mjs:2191 resolveCliHomeDir 读取该根，:2259 getHomeAgentsDir 拼接 agents，:572 loadCustomAgents/scanAgentsDirectory 扫描用户 .md，与项目角色合并且项目优先。
- 因而默认 ~/.workbuddy/agents/<角色>.md 是真实用户发现路径；自定义配置根会改变位置。未创建角色文件或实测模型选角；角色可发现不等于可创建独立桌面会话。
- MCP：[WorkBuddy 官方 MCP 文档](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)的“配置方式”明确列 ~/.workbuddy/mcp.json 和项目 .workbuddy/mcp.json，属于受支持用户配置；未读取/导出用户凭据，未启动服务。
- 可分发路径：[专家团](https://open.workbuddy.cn/docs/expert-team)定义 agents/*.md、plugin.json 和 MCP 依赖；系统分配工具权限，不能把 Agent Markdown 当作任意宿主 API 授权。

4. worktree：用户界面支持；普通用户扩展调用 createWorktreeTaskService 不支持；并非仅内部自动化。
- W/main/server.js:442 createWorktreeTaskService 实现 createWorktree、继承信任及失败回滚；registerWorktreeTaskHandlers 注册原生 IPC；W/main/handler-registry.js:1 通道为 worktreeTask:createWorktree 等。
- W/main/rpc-connection.js:1 的扩展非 wb:* 禁令直接挡住该通道；未发现公开 wb.worktrees 用户扩展接口。不能把内部服务函数当成插件可导入 API。
- [官方 Git/worktree 文档](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Worktree-Task)说明新建任务界面的 Worktree 开关、基础分支及 ~/WorkBuddy/Worktrees 目录，纠正“仅自动化可用”的判断。

决策与执行建议：
- NO-GO：暂不投入“普通用户插件＝宿主设置列表＋确定性派单＋桌面 session/prompt/cancel＋原生 worktree 管理”的完整接入；阻断在生产扩展服务/会话授权与公开桌面控制契约，UI iframe 已不是单独阻断。
- 子集 GO：角色 Markdown＋Skill＋MCP 暴露集合石工具，状态列表放集合石现有 UI；主 Agent 在 WorkBuddy 内按技能调用。原型估计 2–3 人日，角色/工具权限与取消验收另需 1–2 人日（工程估算，非实测）。这不提供程序化桌面调度保证。
- 需要确定性启动/取消时：继续由集合石控制外部 CLI；CodeBuddy 走官方 ACP，队列、预算和 Git worktree 由集合石管理。若改走合作伙伴 Open API，先取得适用资质及 Scope，并要求厂商确认本地会话隔离与取消能力；目前不计为完整 GO。

验证与边界：
- python -X utf8 -B .meetingstone/runs/workbuddy-feasibility-20261111/verify_readonly.py：14 项纯策略断言全部通过；脚本只在内存执行提取函数，未启动桌面/CLI/MCP、未连本地端口、未调用模型。完整命令输出见 policy-tests.log。
- 静态证据与官方文档索引见 code-evidence.log、sources.md；git status --short 初始及复核均为空；仅新增被忽略的本次产物，无源码/配置改动，changedFiles=[]。
- 未验证：真实页面渲染、重启发现、真实派单/流式回读/取消/进程清理、授权后签名扩展及 Open API、Workbench/Harness v2 与现有桌面会话互通、真实 worktree 创建清理；未安装测试插件、未申请平台资格。
- 版本范围：本机 5.9.3；[官方更新日志](https://www.codebuddy.cn/docs/workbuddy/Changelog)已列 5.11.0 灰度，未获取其安装包。不可把本报告外推为全版本、私有发行版或厂商合作扩展永久不支持。
- 另有 15 个 ASAR 清单指向的 unpacked 文档/脚本不存在，未纳入字面量检索；策略及运行时核心证据文件均已读到。进程 CIM 查询被系统拒绝，未据此推断运行状态。
