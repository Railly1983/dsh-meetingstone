# 安装与连接 CLI

本页面向**插件使用者**。安装已发布插件不需要克隆源码、不需要跑 `npm run verify`，
也不需要任何维护者电脑上的路径。

> 兼容范围由 `package.json` 的 `engines.dsh` 声明：当前为 `>=0.2.2-rc.1 <0.3.0-0`。

## 安装前确认

- 已安装兼容版本的 DeepSeek Harness。
- 若计划调用 Codex / CodeBuddy / Claude Code：先按各 CLI 官方指引安装并登录。
- 外部 CLI 还需要匹配版本的 DSH 子代理 Provider。**只装集合石不会自动安装或登录任何外部 CLI。**

安装、登录、Provider 配置、模型可用性、订阅额度是五件不同的事。集合石只负责把角色映射到**你已经配好**的执行通道。

## 推荐：在 DSH 插件管理 / 市场安装

打开 DSH 的插件管理 / 市场，搜索 **`dsh-meetingstone`**，核对包名与来源为
[Railly1983/dsh-meetingstone](https://github.com/Railly1983/dsh-meetingstone)，安装后按宿主提示刷新或重启。

如果通过 DSH CLI 管理插件，也可以直接安装公开 npm 包：

```powershell
dsh plugin --profile desktop add dsh-meetingstone
```

- `desktop` 是 **Profile 名示例**，请换成你实际使用的 Profile。插件装在 `web` Profile 不会自动出现在 `desktop` Profile。
- `dsh plugin add` 会把参数原样转发给 pnpm（`pnpm add <pkg>`），因此也支持 `@版本号` / tarball / 本地目录等写法。
- 找不到 `dsh` 命令时，请按 DSH 官方安装说明定位 CLI 入口；**不要照抄任何文档里的本机绝对路径**。
- 卸载：`dsh plugin --profile desktop remove dsh-meetingstone`（同样换成你的 Profile）。

## 首次使用

1. 打开 **DSH 设置 → 集合石**。
2. 查看「外部 CLI 连接」的检测状态。**开关开启不等于底层 CLI 已登录或有额度**；检测失败时按页面给出的步骤排查。
3. 打开「全局角色库」。**插件自带 3 个开箱即用的默认角色**（执行者 / 审查员 / 调研员），全部走 DSH 原生子 Agent，无需配置外部 CLI 即可派单。想换成外部 CLI 或指定模型时再编辑它们，或新增自己的角色。
   **默认角色只在你还没有任何角色时出现，不会覆盖你已经配置好的角色。**
4. 回到 DSH 对话，输入「让执行者检查这个项目的 README 与启动命令是否一致，并给出证据」。
5. 用集合石工具查询任务状态、执行记录和产物。失败时先看回执里的 Provider / CLI 错误码。

完整演示见 [5 分钟快速开始](getting-started.zh-CN.md)。

## 安装外部 Provider（需要时）

DSH 的 Provider 由相应官方包提供，集合石本身不启动、不替代这些 CLI。
**包版本必须与当前 DSH 宿主匹配**；下面是 DSH `0.2.2-rc.1` 版本线的示例，未来版本请查对应官方文档：

```powershell
# Codex 子代理（官方 DSH bundle）
dsh plugin --profile desktop add '@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1'

# ACP 子代理运行组件：装包不等于已配置具体的 CLI
dsh plugin --profile desktop add '@deepseek-ai/dsh-subagent-acp@0.2.2-rc.1'
```

ACP 还需要在 DSH Profile 中按你安装的 CLI 与操作系统配置实际执行的命令与参数。
**不要直接复制任何历史示例里的绝对路径、模型 ID 或宽松权限设置。**
已登录 CLI 与 DSH Provider 是否使用同一账号，应通过一次最小派单核验。

## 常见故障

| 现象 | 优先检查 |
| --- | --- |
| 设置中看不到集合石 | 是否装在当前 Profile；是否重启；DSH 版本是否兼容 |
| CLI 检测不到 | 是否安装、PATH 是否正确、检测所依赖的入口是否可用 |
| 显示已启用但无法派单 | 对应 Provider 是否存在且配置正确、CLI 登录与权限 |
| 模型列表没有想要的模型 | 真实能力枚举与本机配置；并非所有 CLI 都提供完整动态列表 |
| 显示额度未知 | 插件不把未知余额伪装成可用或耗尽；请到服务商官方入口确认 |
| Worktree 留有文件 | 这是保护未合并改动的策略；检查后手动合并或清理，不要直接删 |

## 开发者与高级配置

- [配置说明](configuration.md)：全局角色、CLI → 模型 → 思考强度、高级参数
- [工作树隔离](worktree-isolation.md)：文件布局隔离 ≠ 权限沙箱、人工合并与清理
- [安全与权限](security.md)：权限边界与「不提供只读通道」的原因
- [示例配置](../examples/meetingstone.desktop.yml)：**历史示例，含特定机器的模型与权限，仅供理解字段，勿直接照搬**

从本地源码开发 / 打包 / 安装，见 [贡献指南](../CONTRIBUTING.md) 与本仓库 `docs/release/publish-guide.md`，
不属于普通用户的安装步骤。
