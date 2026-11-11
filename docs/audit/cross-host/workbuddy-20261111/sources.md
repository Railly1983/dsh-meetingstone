官方资料索引（2026-11-11 访问；行号为 web 文本视图；以下为归纳，非全文复制）

- https://www.codebuddy.cn/docs/workbuddy/Plugins ：普通插件类型含 Skill/MCP/Hook/Agent/Rule，可添加第三方市场；未声明桌面 extension.json 宿主 API 授权。
- https://open.workbuddy.cn/docs ：L6–23，开发者入驻、资质认证、创建资源、审核和发布。
- https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide ：L225–232 用户/项目配置路径；L249–280 配置入口与状态检查。
- https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project ：项目 .codebuddy/agents 支持，项目与用户层有优先级；未用 CLI 的 ~/.codebuddy 文档直接替代桌面全局目录证据。
- https://open.workbuddy.cn/docs/expert-team ：L28–50 包内 agents/MCP/settings 目录；L312–332 工具由系统分配，MCP 依赖需连接。
- https://open.workbuddy.cn/docs/connector ：MCP＋Skill 或 CLI＋Skill 接入及平台审核；此审核不能替代桌面扩展签名许可。
- https://www.workbuddy.cn/docs/cli/acp ：L885–923 独立 codebuddy --acp；L944–991 prompt 元信息与工具代理；不说明桌面 extension.json 可以接管会话。
- https://www.workbuddy.cn/docs/cli/ide-integrations ：L879–952，ACP 为独立服务端/客户端配对，外部编辑器承载 UI。
- https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Worktree-Task ：L248–273 用户任务 Worktree 开关与目录；L285–303 清理及产品范围。
- https://open.workbuddy.cn/docs/third-party-app ：L24–29、L61–65、L119–137，硬件/合作伙伴范围、平台审核及本地助理 Scope；积分兑换应用不提供其他能力域。分享接入的企业证书要求不等于桌面扩展包可信签名体系。
- https://open.workbuddy.cn/docs/openapi ：L255–409 本地在线状态、发消息与轮询历史；L413–473 云任务 ACP link/token。全文查找 cancel/取消/终止均无匹配；不能由此证明未公开的服务端接口不存在。
- https://www.codebuddy.cn/docs/workbuddy/Changelog ：5.9.3 对应 2026-10-27；5.11.0 在 2026-11-03 标灰度，本机不代表该灰度包。

公开支持路径查找范围：上述文档及站内检索 site:open.workbuddy.cn extension.json / ACP / 桌面 SDK，site:workbuddy.cn createDefaultThirdPartyDistribution / WB_ALLOW_UNSIGNED_EXTENSION_SERVICE；未找到用户桌面扩展签名申请或权限开关规范。这是有范围的“未找到”，不是厂商书面拒绝。
未调用第三方业务 API，未登录开发者平台、申请权限、发送消息或下载/安装新版本。
