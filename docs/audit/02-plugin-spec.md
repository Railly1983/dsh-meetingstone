# 02 · 插件开发规范核验（P0-02）

| 项 | 内容 |
| --- | --- |
| 采集时间 | 2026-11-10 13:30 +0800（下载/取用集中在此刻，命令实测至 13:35） |
| 采集人 | xiaobai（小白） |
| 任务 | P0-02 插件开发规范核验；阶段 0，只产出审计证据，不写产品代码 |
| 网络状态 | **可用**。`api.github.com` 与 `raw.githubusercontent.com` 均返回 HTTP 200，未触发「网络不可用」回退流程 |
| 依据来源 | ① DSH 官方 GitHub 文档（英文原文为主，`*.zh.md` 中文对照）；② 本机已安装包与 profile 的**只读配置/包结构**；③ 本机命令只读实测 |
| ref / 版本 | 官方文档统一取 `ref=master`；取用时 master HEAD = `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，commit 日期 **2026-11-04**，提交信息 `Merge pull request #7873 ... Merge release/dsh-0.2.2 (0.2.2-rc.1) into master`。本机 DSH `dsh.cmd --version` = `0.2.2-rc.1`，与 master HEAD 合并的版本一致，文档/运行时证据链闭合 |
| Clean-room 纪律 | 本机 `dsh-cliworker-now` **仅读取 `package.json` 与 `cordis.patch.yml` 的包结构**（项目允许的取证范围，见 `docs/CLEAN_ROOM.md` 第 2/3 节），**未读取任何实现源码**。所有 API、生命周期、schema、UI 机制结论均来自 DSH 官方文档，未从 CLIWorker 反推 |

> 本文所有结论以「来源编号」标注，编号与完整路径/ref/日期见第 0 节。凡未在本次取用/实测中确认的，一律进第 6 节「未验证项」，不推断成「应该有」。

---

## 0. 来源清单与标记约定

### 0.1 官方文档（GitHub，统一 `ref=master` @ `fcc0ad4` / commit 2026-11-04 / 采集 2026-11-10）

| 编号 | 仓库内路径（英文 + 中文对照） | 用途 |
| --- | --- | --- |
| S1 | `docs/user/develop/basic/publish.md` · `publish.zh.md` | Bundle 打包、profile、层顺序、engines.dsh、git 安装 |
| S2 | `docs/user/develop/framework/index.md` · `index.zh.md` | Fiber 状态机、生命周期、dispose、HMR |
| S3 | `docs/user/develop/framework/service.md` · `service.zh.md` | inject、service 注册、依赖行为 |
| S4 | `docs/user/develop/framework/events.md` · `events.zh.md` | 事件模式、typed events |
| S5 | `docs/user/develop/basic/tool.md` · `tool.zh.md` | `defineTool` 最小注册 |
| S6 | `docs/user/develop/basic/config.md` · `config.zh.md` | Config schema（Schemastery） |
| S7 | `docs/user/develop/basic/index.md` · `index.zh.md` | 插件导出、三种形式、ctx.effect |
| S8 | `docs/user/develop/practice/index.md` · `index.zh.md` | 三角色能力设计 |
| S9 | `docs/user/develop/practice/dynamic-cordis.md` · `.zh.md` | Plugin Manager / `install_bundle` |
| S10 | `docs/user/develop/practice/llm-adapter.md` · `.zh.md` | Config/registerAdapter 佐证 |
| S11 | `docs/cookbook/adding-a-tool.md` · `.zh.md` | 工具契约、执行策略与审批扩展点 |
| S12 | `docs/cookbook/adding-a-settings-card.md` · `.zh.md` | 设置页 UI、volatile、`dsh.client`、slots |
| S13 | `docs/subsystems/settings.md` · `.zh.md` | SettingsForms / config-editor 持久化 |
| S14 | `docs/subsystems/slots.md` · `.zh.md` | Web Client slots 注册与生命周期 |
| S15 | `docs/subsystems/approval.md` · `.zh.md` | `ctx.approval`、fail-closed 结果 |
| S16 | `docs/subsystems/permission-presets.md` · `.zh.md` | sandbox + approval 预设 |

> 说明：任务指定的 `docs/user/develop/{basic,framework,practice}` 全部目录已用 GitHub API 列出并取回全部 10 个英文页 + 中文对照。S11–S16 是为补齐「工具权限/审批」与「设置页 UI」两问而追加的**官方**文档：`develop/basic/tool.md` 自身把进阶契约指向 `docs/cookbook/adding-a-tool.md`（S5:51），`develop/` 下确实没有设置页 UI 专页，故按官方交叉引用外扩，均已单独编号、可追溯。

### 0.2 本机只读证据（采集 2026-11-10，均为只读）

| 编号 | 路径 / 命令 | 用途 |
| --- | --- | --- |
| L1 | `C:\Users\30673\.dsh\profiles\desktop\package.json` | profile manifest 实测（bundles 顺序） |
| L2 | 同目录 `cordis.yml` | 空根 `[]` 与注释 |
| L3 | 同目录 `cordis.patch.yml` | 用户覆盖层实例 |
| L4 | 同目录 `pnpm-workspace.yaml` | `allowBuilds` 是否存在 |
| L5 | `...\node_modules\dsh-cliworker-now\package.json`（**仅包结构**） | 第三方 bundle 的 `dsh.bundle` / `dsh.client` / `engines` 实例 |
| L6 | `...\node_modules\dsh-cliworker-now\cordis.patch.yml`（**仅包结构**） | 第三方 patch 写法实例 |
| L7 | `...\resources\runtime\cli\bin\dsh.cmd` | 转发脚本内容 |
| L8 | 命令：`command -v dsh`、`dsh.cmd --version` / `--help` / `plugin --help`、`node + 宿主自带 semver` | 命令可用性、版本号、SemVer 实测 |
| A1 | 仓库内 `docs/audit/01-environment.md`（P0-01 已实测） | 版本/运行时/插件清单交叉引用 |

---

## 1. Bundle 打包规范（依据 S1）

### 1.1 `package.json` 的 `dsh.bundle` 结构

Bundle 是「附带一个配置层的 npm 包」，`dsh.bundle` 回答「这个包贡献什么」。最小结构（S1:33-44）：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

| 要点 | 结论 | 来源 |
| --- | --- | --- |
| `dsh.bundle.patch` | 指向 patch 文件路径；可为**单个字符串**，也可为**有序数组** `["./base.patch.yml","./web.patch.yml"]`，launcher 按序作为「同一层」应用，且每个文件里的相对插件路径相对该文件解析 | S1:42,64 |
| 没有 `dsh.bundle` 的包 | 仍能安装，但只作为普通依赖：`dsh plugin` 打印 warning，且**不激活任何层**（适用于「供插件 import 的库」而非「供用户启用的插件」） | S1:64 |
| `files` | 必须把 `cordis.patch.yml` 与入口一起打进包 | S1:41 |
| 入口引用方式 | patch 行用**包名**（不是相对源码路径）引用，让 Node 解析找到已安装代码 | S1:56 |

**本机实例（L5，仅包结构）**：`dsh-cliworker-now@0.8.7` 的 `dsh` 键为 `{"bundle":{"patch":"./cordis.patch.yml"},"client":{...}}`，`files` 含 `cordis.patch.yml`；`engines` **只有** `{"node":">=22.19.0"}`，**没有** `engines.dsh`（见 1.5）。

### 1.2 `cordis.patch.yml` 的写法

官方最小例（S1:56-62）：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

本机合法写法的**构造示例**（为遵守 `docs/CLEAN_ROOM.md` 的来源边界，此处不复述任何第三方包的实际 patch 内容，仅示意语法形式）：

```yaml
- insert:
    - id: some-bundle                # 行 id
      name: some-bundle              # 形式一：包名
      inject: [someService]          # 行级 inject
    - id: some-bundle-ui
      name: ./lib/client/index.js    # 形式二：相对路径
      inject: [someService]
- id: some-service                   # 按 id 覆盖前面层已有行的 config
  config:
    enabled: false
- id: some-legacy-row
  disabled: true                     # 按 id 禁用前面层的行
```

> 说明：以上四种形式（`insert` + 行级 `inject`、包名/相对路径两种 `name`、按 id 覆盖 config、按 id `disabled`）来自官方示例与官方 app-boot 文档；**不再引用第三方包的 patch 原文**（P0-02b 复核指出原稿摘录违反了 clean-room 契约，已按悟空勘误修正）。

| 结构 | 含义 | 来源 |
| --- | --- | --- |
| `- insert:` + 子项 `id`/`name`/`inject` | 插入新行；`id` 是层内/跨层覆盖的键 | S1:58-62 · L6 |
| `- id: <x>` + `config:` | 按 id 覆盖已有行的配置 | S1:133 · L3 |
| `- id: <x>` + `disabled: true` | 禁用该行 | L6 · L3 |
| `name:` 可为包名或相对路径 | 官方 bundle 用包名；本机实例两种都出现 | S1:56 · L6 |
| `!!js` 表达式 | patch 允许 `!!js`（如 `!!js ctx.myAppStartup.port ?? 8080`、`!!js process.env.MY_API_KEY`） | S1:156 · S10:132 · L2 |

### 1.3 bundle 与 profile 的区别

| 维度 | bundle | profile |
| --- | --- | --- |
| 是什么 | 自带配置层的 npm 包（**作者编写并分发**） | `$DSH_HOME/profiles/<name>` 下的目录，描述一份可启动组合 |
| manifest | `dsh.bundle` | `dsh.profile`（含 `bundles` 有序列表） |
| 回答的问题 | 「这个包贡献什么」——插入/覆盖插件行的 patch 文件 | 「这套配置由哪些 bundle、按什么顺序组成」 |
| 谁用 | 被 `dsh plugin add` 安装进 profile | 用户用 `dsh --profile <name>` 启动 |
| 目录内容 | `package.json` + `cordis.patch.yml` + 入口 js | `package.json`（树外依赖 + `dsh.profile`）+ `cordis.patch.yml`（用户层） |
| 互斥性 | **Nothing is both**：没有东西同时是两者 | 同左 |

来源：S1:9-16, 68-75（中文对照 S1.zh:13-16,70-73 一致）。

**本机实测（L1/L2）**：活动 profile `desktop` 的 `package.json` 里 `dsh.profile.bundles` 有 7 项，`@deepseek-ai/dsh-base` 排第 1；`cordis.yml` 是 `[]` 空根，注释原文：`The tree is composed as patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays. Edit cordis.patch.yml, not this file.` —— 即**插件启停不写在 `cordis.yml`**，由 bundle 叠加 + `cordis.patch.yml` 覆盖组合而成。A1:3.2/3.3 记录一致。

### 1.4 `dsh.profile.bundles` 的顺序语义

生效配置在**空根**之上按以下顺序逐层组合（S1:120-129）：

| 层序 | 内容 |
| --- | --- |
| 1 | `dsh.profile.bundles` 里各 bundle 的 patch，**按列表顺序**：`@deepseek-ai/dsh-base` 第一，然后按各 bundle 加入顺序 |
| 2 | profile 自己的 `cordis.patch.yml` |
| 3 | home 级 `$DSH_HOME/cordis.patch.yml`（所有 profile 共享的机器本地偏好） |
| 4 | 每个 `--patch <path>` overlay，按 argv 顺序 |

- 应用参数不是另一层 patch；表层 bundle 可用 app-owned service 解析（S1:129,138-159）。
- 官方 bundle 名始终从 DSH 安装本身解析，pnpm 只管理树外包，故 bundle 可依赖 `@deepseek-ai/dsh-base` 存在且为最新（S1:136）。A1:3.2 印证：官方 5 个 bundle 不在 profile `node_modules`、由宿主 `sharedPackages` 解析，只有 2 个第三方包落在 profile 目录。
- 本机 L2 注释只列了 3 层，是省略了 home 级与 `--patch` 的简化说法，与 S1 的 4 层不矛盾。

### 1.5 patch 的覆盖语义：整行替换，不是深合并

> **原文（S1:131）**："Later layers win per row, and a patch **replaces a row's entire `config` value rather than deep-merging keys**."（中文对照 S1.zh:131：「后应用的层按行胜出，且 patch 会替换目标行的整个 `config` 值，而不是深度合并各键。」）

| 推论 | 说明 | 来源 |
| --- | --- | --- |
| 后层按**行**胜出 | 不是按键合并，是整行 `config` 被替换 | S1:131 |
| 覆盖必须重述全部键 | 按 `id` 覆盖前面层的行（如 `dsh-web-app` 覆盖 `dsh-base` 行）时，**必须重述该行需要的每一个键**，不能只写改动的那一个 | S1:133 |
| 给用户留覆盖口 | 用户可在自己 profile 的 `cordis.patch.yml` 覆盖我们的行而不改我们的包；官方建议优先给出用户大概率保留的默认值，其余交给 schema 承担 | S1:134 |
| 本机实例 | L3 中 `- id: ui-settings / config: { enabled: false }` 就是「按 id 覆盖 + 只写一个 config 键」；按整行替换语义，该行其余键依赖 schema 默认值补齐（S1:134 的「let the schema carry the rest」）。此处只记录写法，不断言其是否丢配置 | L3 · S1:134 |

### 1.6 `engines.dsh`：写法 + 本机陷阱 + 具体建议值

> ## ⚠️ 本节结论已被 `02b-engine-probe.md` 推翻，以 02b 为准
>
> 原节基于**默认** `semver.satisfies`（`includePrerelease: false`）推理，结论「官方示例 `>=0.2.0 <0.3.0` 在本机不匹配」**经实证为假**。悟空在隔离 `DSH_HOME` 里做了真实安装：`>=0.2.0 <0.3.0` 安装退出码 0、layer 正常组合；`0.2.2`（正式版精确值）才被拒。
>
> 已实证机制：DSH 的比较**带 `includePrerelease: true`**，且保留完整 rc 版本号（不剥 rc）。
>
> **最终取值：`"engines": { "dsh": ">=0.2.2-rc.1 <0.3.0-0" }`**（E 组已实装验证）。下界取当前唯一实测基线，上界 `<0.3.0-0` 才是真正排除整个 0.3 预发布线。
>
> 以下原文保留作为推理留痕，**不得作为实现依据**。

**官方规则（S1:66）**：用 SemVer 范围声明 bundle 支持的 DSH 版本，例 `"engines": { "dsh": ">=0.2.0 <0.3.0" }`；安装与 profile 启动会拒绝当前 DSH 不满足范围的 bundle；**不写 `engines.dsh` 时改为检查其 `@deepseek-ai/dsh*` peer 依赖范围**（规则指向 `packages/boot/app-boot/README.md#profiles`）。

**本机关键实测（L8）**：本机 `dsh.cmd --version` = `0.2.2-rc.1`，是**预发布（prerelease）版本**。用宿主自带 `pnpm/dist/node_modules/semver@7.8.5`（纯 JS，系统 node v20.16.0 加载）实测标准 `semver.satisfies`：

```
semver version: 7.8.5
  >=0.2.0 <0.3.0               satisfies 0.2.2-rc.1 ? false
  >=0.2.2-rc.1 <0.3.0          satisfies 0.2.2-rc.1 ? true
  >=0.2.0                      satisfies 0.2.2-rc.1 ? false
  >=0.2.2-0 <0.3.0             satisfies 0.2.2-rc.1 ? true
  ^0.2.0                       satisfies 0.2.2-rc.1 ? false
  0.2.2-rc.1                   satisfies 0.2.2-rc.1 ? true
```

即：**S1 文档给的示例范围 `>=0.2.0 <0.3.0`、`>=0.2.0`、`^0.2.0`，在本机 `0.2.2-rc.1` 上全部不匹配**。npm SemVer 规则下，prerelease 版本只有在范围内存在与之 `[major,minor,patch]` 相同且带 prerelease 的比较器时才纳入。

| 项 | 结论 |
| --- | --- |
| **建议值（推荐）** | `"engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }` —— 覆盖本机 rc、后续 `0.2.2` 正式版、`0.2.x` 后续补丁，且排除 `0.3.0+` |
| 更宽松备选 | `">=0.2.2-0 <0.3.0"` —— 允许 `0.2.2` 的任意 prerelease（`-0` 是最低 prerelease），适合 rc 版本号会变动时 |
| 不推荐直接照抄 | `">=0.2.0 <0.3.0"`（S1 示例）在当前 rc 运行时上按标准 semver 会判 false，可能导致安装/启动被拒 |
| 备选路线 B | 不写 `engines.dsh`，只靠 `peerDependencies` 的 `@deepseek-ai/*` 范围兜底（S1:66 的回退规则）。本机 L5 的第三方 bundle 正是这么做的；但其 peer 多为 `*`（`@deepseek-ai/cordis` 例外，为 `4.0.4 \|\| 4.0.5 \|\| ~4.1.0`），**等于几乎不设版本门槛** |
| ⚠️ 待实测 | DSH 内部 `engines.dsh` 检查**是否**用标准 `semver.satisfies`、**是否**在比较前把 `0.2.2-rc.1` 规范化为 `0.2.2`，本次未读 `cli.js` / `app-boot` 实现源码验证（见第 6 节）。阶段 1 首次安装前必须用一次真实 `plugin add` + `--dump-config` 实测确认 |

### 1.7 从 git 安装：`prepare` 与 `allowBuilds`

官方流程 `dsh plugin --profile demo add github:you/hello-plugin`（S1:161-186）。git 安装取的是**源码，不是构建产物**：不跑 `build`，TS 包会缺少 `lib/` 而加载失败。两端各需一件事：

| 侧 | 要求 | 来源 |
| --- | --- | --- |
| **作者** | 提供 `prepare` 脚本（pnpm 在 git 安装后运行），从源码构建发布入口，且必须**自包含**：不得假设 dev-only 上下文（如旁边的 monorepo checkout）；专用 tsdown 配置可直接转译 `src/`，不做项目引用/类型检查 | S1:169-171 |
| **用户** | pnpm ≥10 默认拒绝运行 git 依赖的 `prepare`，首次 `add` 会失败。把 pnpm 打印的**确切包名**写进 profile 的 `pnpm-workspace.yaml` 并重试 | S1:172-179 |

profile 的 `pnpm-workspace.yaml` 需加（S1:174-177）：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

| 补充要点 | 来源 |
| --- | --- |
| `allowBuilds` 等于「允许安装时在本机执行该包代码」，在 agent 沙箱之外；只信任源码、并 pin commit（`github:you/hello-plugin#<sha>`）避免后续 push 静默改动执行内容 | S1:181 |
| 免 allowance 的两种分发：① 发 npm（`lib/` 在 `pnpm publish` 时构建好）；② 发 tarball（`pnpm pack` → `dsh plugin add ./pkg-0.1.0.tgz`）。两者都不需要任何构建权限 | S1:183-186 |

**本机实测（L4/A1）**：profile `pnpm-workspace.yaml` 当前**没有** `allowBuilds` 段，现有内容为：

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAgeExclude:
  - dsh-remote-plugin@0.8.0
```

本机 DSH 自带 pnpm `11.28.5`（A1:2.2，≥10），满足「首次 git 安装会触发 allowBuilds 拒绝」的前提。`autoInstallPeers: false` 与 S1:105 的「共享 dsh 包要同时写进 `peerDependencies` + `devDependencies`」需一并注意。

---

## 2. 插件入口与生命周期

### 2.1 模块导出什么

| 导出 | 作用 | 来源 |
| --- | --- | --- |
| `export const name = '...'` | 插件名 | S7:22-27 · S5:15 |
| `export function apply(ctx: Context, config: Config)` | 框架加载时调用；第二参数是校验/填默认值后的配置 | S7:17-27 · S6:29 |
| `export const inject = ['tools', ...]` | 声明依赖服务；全部就绪前不调用 `apply` | S2:28-36 · S3:19-32 |
| `export interface Config` + `export const Config` | 同名类型 + Schemastery schema（详见 4.1） | S6:9-31 |
| `export default`（对象/类形式） | 见下表 | S7:105-138 |

三种插件形式（S7:105-138）：

```ts
// ① 函数形式（多数场景足够）
export const name = 'hello-plugin'
export function apply(ctx: Context) { /* ... */ }

// ② 对象形式
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) { /* ... */ },
}

// ③ 类形式：当插件要「向其他插件提供服务」时使用
export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

> 注：任务里举例的 `ctx.on('dispose')` 并非官方写法。官方清理机制是 **`ctx.effect()` 返回 disposer** + Fiber 自动撤销注册 + `fiber.dispose()` 主动停止（见 2.4），本次核验未在官方文档中检索到 `ctx.on('dispose')` 这一约定。

### 2.2 依赖注入与注册 service

**消费服务**（S3:19-32）：`export const inject = ['tools']`；`apply` 运行时所有被声明的服务已就绪；服务未就绪则插件等待。可选依赖不写 `inject`，改用 `ctx.get('metrics')` 在用例处查询（S3:91-99）。服务在运行时消失（如 provider 被替换）→ 依赖插件自动卸载，服务恢复后重新加载（S2:38 · S3:102-109）。

**提供服务**（S3:34-85）：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {   // 声明合并，给 ctx.metrics 加类型
  interface Context { metrics: MetricsService }
}

export default class MetricsService extends Service {
  static inject = ['llm']               // service 本身也可依赖别的 service
  constructor(ctx: Context) {
    super(ctx, 'metrics')               // 第二参数 = 服务名
  }
  record(event: string, value: number) { /* ... */ }
}
// 消费方：export const inject = ['metrics'] → ctx.metrics.record(...)
```

内置服务示例：`ctx.tools`（ToolRuntime）、`ctx.llm`、`ctx.agents`（S3:9-15）；完整服务名/方法由生成的 subsystem 页面维护，官方明确「不要维护第二份静态清单」（S3:141-143）。三层能力拆分（Service Definition / Provider / Consumer）见 S8:9-56（Bash 例：`dsh-shell` / `dsh-bash-local` / `dsh-tool-bash`），并提醒「不要预防性拆包」：简单 tool 插件不需要拆（S8:149）。

### 2.3 事件（补充，供子进程/派单通信参考）

`ctx.on` / `ctx.emit`；四种模式：`emit`（广播）、`bail`（短路）、`serial`（有序 await）、`waterfall`（监听器**必须调用 `next()`**，否则刻意短路）（S4:23-81）。typed events 用 `declare module '@deepseek-ai/cordis' { interface Events {...} }`（S4:83-100）。Cordis 事件用 `namespace/action` 命名（`agent/pre-step`、`tools/result`、`session/event`）；`turn/*`、`tool/call`、`compaction/*` 等是 **durable session-event 类型，不是同名 Cordis 事件**，需监听 `session/event` 并看 `event.type`（S4:102-106）。`ctx.on()` 注册本身是 effect，插件卸载时自动移除（S4:108-117）。

### 2.4 卸载/停用清理约定 —— 对子进程管理至关重要

**Fiber 状态机（S2:9-24）**：

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

**自动清理（S2:40-63 / S7:66-84）**：所有通过 `ctx` 的注册在卸载时自动撤销：

```ts
export function apply(ctx: Context) {
  ctx.on('some-event', handler)            // 事件监听：自动移除
  ctx.tools.register(tool)                 // 工具注册：自动注销
  ctx.llm.registerAdapter(names, adapter)  // LLM adapter：自动注销
  ctx.effect(() => {                       // 自定义资源：返回 disposer
    const connection = createConnection()
    return () => connection.close()        // 卸载时运行
  })
}
```

| 约定 | 结论 | 来源 |
| --- | --- | --- |
| 自动撤销范围 | `ctx.on()`、`ctx.tools.register()`、`ctx.llm.registerAdapter()`、`ctx.effect()` | S2:57-61 |
| **⚠️ 逆序 + 并发陷阱** | 卸载时 disposer **按注册逆序开始调用**，但**多个异步 disposer 并发执行、不保证逐个完成**。有顺序依赖的清理（如「先终止子进程、再关 IPC/释放端口」）**必须放进同一个 `ctx.effect()` 返回的单一 disposer 里，在其中串行 await** | S2:63（中文对照 S2.zh:63 一致） |
| 嵌套 context | `ctx.plugin(child)` 创建子 Fiber，继承父 context 但独立生命周期，随父卸载 | S2:65-76 |
| 主动停止 | `const fiber = ctx.plugin(myPlugin); await fiber.dispose()` → ①移除该插件所有注册 ②递归卸载子插件 ③Promise 在**所有异步清理完成后**兑现 | S2:78-97 |
| 依赖消失 | 服务消失 → 依赖插件自动 ACTIVE→DISPOSED，服务回来后重载 | S2:38 · S3:102-109 |
| HMR | `@deepseek-ai/dsh-hmr` 下改源码 → 卸载旧实例清理注册 → 加载新代码 → 跑新 `apply`；改配置同样热替换（S6:98-100） | S2:99-107 · S6:98-100 |

> **对 MeetingStone 的含义**：我们要管的子进程，其「停止」逻辑应集中在**一个** `ctx.effect()` 的 disposer 内按序 await（kill → wait exit → 关闭通道），不要拆成多个并列 `ctx.effect()` 指望逆序执行；插件被禁用/依赖服务消失/HMR 都会走同一条卸载路径。工具注册本身是 effect，dispose 即自动注销，无需手动 unregister。

---

## 3. 注册工具（tool）

### 3.1 最小注册与 schema（S5）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']          // 等待工具注册表就绪

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

| 要点 | 结论 | 来源 |
| --- | --- | --- |
| `inject` | `['tools']` 让 Cordis 等待工具注册表；`ctx.tools.register(defineTool(...))` 完成注册 | S5:16,19,36 |
| `parameters` | 字段 → `{ type, required?, description? }`；`defineTool` 由此**推断并校验** `args`（`InferArgs`） | S5:22-24,36 · S11:42 |
| `output.schema` | 声明**一个** canonical JSON 值（`ValueSchemaSpec`，可为 object/array/scalar/null 根）；`execute` 只返回该值，由 registry 快照、校验、冻结 | S11:45 |
| `output.render` | 把 canonical 值转成模型可见 content blocks（如 `[{type:'text', text:value}]`）；UI 专用格式化不得写进 canonical 值 | S5:27,36 · S11:87-88 |
| `exec` 第二参数 | 携带不可变身份/token、`exec.signal`（**必须遵守，取消在途工作**）、`exec.agent`（异步通知，用 `agent.inject(...)`） | S11:29-49 |
| 注册是 effect | dispose 插件 fiber 即自动注销工具；schema 自动进入 system-prompt 组装 | S11:38 · S2:59 |
| 抛错/非法返回 | 一律视为 `isError`；基础设施失败才 throw，领域「非理想结果」用 canonical 值表达 | S11:46 |

进阶契约（S11）：`presentationMeta` 投影可重放的卡片数据；`presentCall`/`presentResult` 返回 `card` 标记的 render intent，且**必须是纯函数**（直播与 session-log 重放都会跑，禁止 I/O、读 session state、时钟/随机）；PTC 模式下所有可见工具自动变成 `await tools.<name>(args)`，无需额外接入（S11:61-65,67-97）。

### 3.2 权限 / 审批怎么接

**不要把部署策略写进工具**，用扩展点（S11:57-59）：

| 扩展点 / API | 作用 | 来源 |
| --- | --- | --- |
| `tools/pre-execute` | 可扩展的 **allow / deny / ask** 策略（官方指向 `extension-cookbook.md` 的 permission-gate 例子） | S11:59 |
| `ctx.tools.guard()` | 最终**单调 deny**，后续监听器无法撤销 | S11:59 |
| `tools/execute` | 包装 dispatch：加 deadline / retry / metrics | S11:59 |
| `tools/post-execute` | 替换展示内容或返回值、阻断结果、附加模型可见上下文 | S11:59 |
| `tools/result` | 观察不可变的规范化结果 | S11:59 |
| executor 内 | 沙箱实现也可放在工具的 executor 内部 | S11:59 |

**用户审批 seam（S15）**：`ctx.approval.request(req)`（`dsh-user-approval`），`approval/request` 为 waterfall answerer；结果 **fail-closed**：

| 项 | 结论 | 来源 |
| --- | --- | --- |
| `ApprovalOutcome` | 闭集 `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`；**只有 `allowed-once` 放行**，其余一律拒绝 | S15:21-29 |
| `unavailable` | 缺少/不归其所有/抛错/返回非法值的 answerer → `unavailable`，即关闭闸门，不会误开 | S15:21,86 |
| per-session 策略 | `ApprovalPolicy = 'ask' \| 'never'`；`never` 不派发任何 answerer，确定性返回 `rejected`（headless/CI 严格姿态）；读 `ctx.approval.effectivePolicy(session)`，写走 `setApprovalPolicy` | S15:31-49,134-139 |
| 请求约束 | `ctx.approval.request()` 要求 session 处于**已开启的 turn** 内；`ApprovalRequest` 故意不含工具参数（用 `callId` 关联已流式展示的 tool call） | S15:51-86 |
| 审计 | `approval/asked` 与 `approval/decided` 成对、log-only，不进模型 transcript；answerer 监听器独立 effect-bound 到所属插件 | S15:84-88 |

**权限预设（S16）**：`ctx.permissionPresets` 把两个独立旋钮 `sandbox/mode` + `approval/policy` 打成命名预设供客户端一个 Permissions 选择器使用；默认表 `workspace-write`（`workspace-write` + `ask`）与 `danger-full-access`（`danger-full-access` + `never`），`custom`/`auto` 保留；服务依赖有约束能力的 `ctx.shell` executor 与 `ctx.approval`，错误配置在插件加载时失败（S16:5-45,11）。

---

## 4. 配置 schema 与设置页

### 4.1 Config：Schemastery，不是 zod

官方明确用 **`@deepseek-ai/schemastery`**（S6 / S10:15,38）：导出同名 `interface Config` 与 `const Config: Schema<Config>`，默认值写在 schema 字段上，`apply(ctx, config)` 收第二参数。

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'
export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})
export function apply(ctx: Context, config: Config) { /* config 已校验/填默认值 */ }
```

| 要点 | 结论 | 来源 |
| --- | --- | --- |
| 库 | `@deepseek-ai/schemastery`（`Schema.object/string/number/boolean/union/array/.default()/.required()`） | S6:13,23-27,63-67 · S10:15,38-41 |
| 不能导出普通对象 | 官方明确「不要导出 plain object 作为 `Config`」，因为它不实现 Cordis 要求的 **Standard Schema 接口** | S6:45（中文 S6.zh:45 一致） |
| 校验时机 | 插件加载时由导出 schema 校验并填默认值；非法配置导致加载失败并给出可操作错误 | S6:45,74 |
| 设计原则 | 任何「两个部署可能想设不同值」的东西都必须是配置字段（判据：`cordis.yml` 能否不改代码就改值）；自包含约束写进 schema，服务/资源引用走依赖注入 | S6:76-96 |
| 配置从哪来 | 写在 patch 行的 `config:` 下（S6:34-43），经 Cordis 校验 | S6:34-45 |
| zod 辨析 | 本机 L5 的第三方包 `dependencies` 里同时有 `@deepseek-ai/schemastery@3.18.5` 与 `zod@4.4.3`；且 S12 里写 `import z from '@deepseek-ai/schemastery'`（把 schemastery 别名成 `z`），**容易误读成 zod**。按 S6/S10，插件 Config 规范是 Schemastery；zod 出现在依赖里不等于 Config 用它。此处只记录事实，不推断该包内部用法 | L5 · S12:11 · S6 |

### 4.2 持久化在哪个文件

| 层次 | 落点 | 来源 |
| --- | --- | --- |
| 静态配置 | patch 行的 `config:` → 由 bundle 的 `cordis.patch.yml` 提供默认值 | S6:34-43 · S1:58-62 |
| 用户覆盖 | profile 的 **`cordis.patch.yml`**（后于所有 bundle 层应用，按 id 覆盖整行 config） | S1:125,131-134 · L2/L3 |
| 设置页编辑的持久化 | settings 服务把 volatile Config 字段投影成表单，**config-editor 通过 Cordis patches 持久化编辑**；`ctx.settings.prepareDocument()` 返回「existing profile patch path」；`ctx.settingsController.openSettingsDocument(signal)` 用原生文本编辑器打开该文档 | S13:5,40-43,123-128 |
| 写入语义 | `update` 合并字段、`replace` 先重置 live 字段再套用、`mutate` 按路径编辑（保留响应里缺失的 secret）；每次写都校验完整 Config 且**拒绝过期 revision** | S13:11-15,51-71 |
| 编辑后生效 | 配置变更 → 热替换插件实例（HMR），注册自动清理重载；volatile 消费者监听 `loader/volatile-update` 读 `.get()` | S6:98-100 · S12:24-30 · S13:15 |

**本机印证（L2/L3/A1:3.3-3.4）**：`cordis.yml` 是 `[]` 空根且注释明确 `Edit cordis.patch.yml, not this file`；用户覆盖确实写在 profile `cordis.patch.yml`。⚠️ 其中 `ui-settings` 行为 `enabled: false`，即**当前 profile 上原生 Settings 面板被显式禁用**，且 A1:3.4 已标注「是用户手动关还是模板默认」待确认 —— 这是设置页路线的前置阻塞，属 P0-07 范围，本文只记录事实。

### 4.3 设置页 UI：机制与第三方可行性

结论：**第三方插件能加自己的设置界面**，但要同时满足 Host 侧 schema 表单 + Client 侧浏览器页面，且有构建格式门槛。

**(a) Host 侧：live 字段与自动表单（S12 / S13）**

```ts
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'       // 注意：这是 schemastery 的别名，不是 zod

export interface Config {
  endpoint: Volatile<string | undefined>
  retries: Volatile<number>
}
export const Config = z.object({
  endpoint: z.string().volatile(),
  retries: z.number().step(1).min(0).default(3).volatile(),
})
export function apply(ctx: Context, config: Config): void {
  ctx.on('loader/volatile-update', () => {
    ctx.logger.info('Retry limit: %d', config.retries.get())
  })
}
```

| 机制 | 说明 | 来源 |
| --- | --- | --- |
| `.volatile()` / `Volatile<T>` | 声明可被设置页实时编辑的字段；操作开始时读 `.get()`，需要一致快照就一次性捕获；`.check()` 做跨字段校验（在 Host 持久化前跑，且不进序列化表单 schema） | S12:7-30 |
| 自动页面策略 | `ctx.settings.configure({ auto: true })`（默认 auto=true）注册实例级页面策略；返回 disposer，需随插件 effect 注册 | S13:31-38 |
| 表单来源 | settings 服务 `describe()` 投影 Config schema 的 live 值与继承值/显式覆盖/乐观 revision；Plugins 页据此渲染表单 | S13:7-15,45-49 · S12:40-42 |
| 保密字段 | `role('secret')` 让值不出现在表单响应里；凭据类值用 credentials domain 的引用；普通字段不进设置 schema | S12:36 · S13:77-79 |
| 前提 | **base bundle 挂载 settings 与 config-editor**；自定义 profile 需先看对应包 README 再挂同样服务 | S12:34 |

**(b) Client 侧：`dsh.client` + `./client` 导出（S12:56-70）**

```jsonc
{
  "exports": {
    ".":       { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client":{ "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] } }
}
```

| 机制 | 说明 | 来源 |
| --- | --- | --- |
| 发现方式 | client module system 扫描 enabled Loader entries 里**声明了 `dsh.client`** 的包，serve 各包构建好的 `./client` export | S12:58 |
| 挂载规则 | half **只挂到 specifier 是裸包名的根行**；从子路径导出 mounted 的行不带 half，故一个包拆成多行时 half 留在根行，该行被关掉则它注册的所有页面一起消失 | S12:58 |
| **⚠️ 第三方门槛** | 构建的 `./client` 必须是 client module system 的 **lazy-CJS factory 格式**（一个脚本：注册包名 + `factory(require)` 带页面模块加载器）；产生它的 `clientBundle` tsdown preset 在 `packages/client/tsdown.client.ts`，**不在已发布的包里** —— 原文："a package outside this repository reproduces that build itself"（仓库外的包需自己复现该构建） | S12:60 |
| 自定义页面 | 通过 `ctx.configForms.whileServed` 注册进 `plugins.item`；自定义插件页从 Plugins 页 owner 收到 `form.state` 与 `form.mutate(operations, expectedRevision)`，Host 校验完整 Config 并经 ConfigEditor + volatile HMR 应用编辑 | S12:42,72 |

**(c) slot 机制（S12:44-54 / S14）**

```tsx
ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
  name: 'plugins.detail.badge',
  id: 'acme-update',
  locale: 'acmeUpdate',
}, ({ t, subject }) => subject.kind === 'bundle' && hasUpdate(subject.pkg)
  ? <Tag tone="info">{t('update')}</Tag> : null))
```

| 机制 | 说明 | 来源 |
| --- | --- | --- |
| 往别人页面贡献 | `plugins.detail.actions`（页头控件）/ `plugins.detail.badge`（标题旁标签）/ `plugins.detail.section`（页面内容下的一段），每项带 `subject`（`{kind:'bundle',pkg}` / `{kind:'row',pkg,row}` / `{kind:'item',id}`），无关时返回 null | S12:44-54 |
| 注册/注入 | 功能插件用 `ctx.slots.register()` 贡献 UI，**不 import 其他功能插件的组件**；贡献到别人的 slot 用 `ctx.slots.inject(key, callback)` | S14:5,27 |
| 生命周期 | slots 注册/声明遵循 Cordis effect 生命周期：dispose 条目时移除其贡献并递归折叠它声明的子 slot；`inject` 回调在每个声明生命周期内运行，owner 卸载时效果移除、重新挂载时再跑 | S14:27 |

**本机旁证（L5，仅包结构）**：`dsh-cliworker-now` 的 `dsh.client` = `{"platform":"web","inject":[... "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-theme" ...]}`，且 `exports["./client"]` 存在 —— 与 S12:62-69 的官方 jsonc 结构一致。这是**结构级**旁证，未读取其实现源码。

---

## 5. 实现方式差异：本地安装途径核验

### 5.1 前提事实

| 事实 | 实测 | 来源 |
| --- | --- | --- |
| `dsh` 不在 PATH | `command -v dsh` → `dsh NOT in PATH` | L8 |
| 转发脚本存在 | `C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（243 B，2026-11-04 17:30） | L7 |
| 脚本内容 | 以 `ELECTRON_RUN_AS_NODE=1` 用 `DeepSeek Harness.exe --expose-internals` 跑 asar 内的 `dsh-desktop-host/lib/cli.js`，`%*` 透传参数 | L7（全文见下） |
| 脚本可用 | `dsh.cmd --version` → `0.2.2-rc.1`；`dsh.cmd --help` 列出 `dsh plugin --profile <name> <pnpm-args...>`、`--dump-config`、`--patch`、`--from-default-profile` 等；`dsh.cmd plugin --help` →「转发剩余参数给 profile 目录里的 pnpm，首次使用初始化 profile」 | L8 |
| 运行时 | 宿主自带 node `24.21.0` / pnpm `11.28.5`（A1:2.2）；本机 profile 的 `pnpm-workspace.yaml` 用 `nodeLinker: hoisted`、`autoInstallPeers: false` | A1 · L4 |

```bat
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
```

### 5.2 三条安装途径对比

| # | 途径 | 做法 | 前提条件 | 风险 / 备注 | 来源 |
| --- | --- | --- | --- | --- | --- |
| **1** | **`.cmd` 转发 CLI**（官方 `dsh plugin add` 的等价路径） | `"...\dsh.cmd" plugin --profile desktop add ./<本地目录>`；`--dump-config` 验证层；`remove` 卸载 | ① 知道 `.cmd` 绝对路径（不在 PATH）；② profile 名正确；③ 调用宿主自带 pnpm 11.28.5；④ 会写 profile 的 `package.json`（dependencies + `bundles`）与 `node_modules` | 官方 S1:79-118 的完整语义都适用：首次使用以 `@deepseek-ai/dsh-base` 为首 bundle 初始化 profile、自动把声明 `dsh.bundle` 的包追加进 `bundles`、`remove` 同时删依赖和层。**阶段 0 不执行** | S1:77-118 · L8 |
| **2** | **DSH 桌面端插件管理器** | Standard/Creator 模式提供 Plugin Manager；agent 写一个「configuration-only bundle」的 patch，用 `plugin_manager install_bundle` 安装；看 `application: applied`（`restart-required` = 尚未激活）；Creator 模式另有只读运行检查 | ① 桌面端正在运行；② Creator 模式；③ 通过 agent 提示词驱动；④ HMR 开启才能「同会话生效」 | 配置属于**当前 profile**、影响其会话、**跨进程重启保留**；用 Plugin Manager 禁用条目/移除 bundle。本机 `.plugin-manager\logs` 存在安装/卸载历史（A1:3.6 已记录），本次未复核日志内容 | S9:5-15 · A1:3.6 |
| **3** | **手工改 profile `package.json` + pnpm link** | 在 `dependencies` 加 `"<pkg>": "link:/abs/path"`，并在 `dsh.profile.bundles` **按目标顺序**插入包名；保持 `cordis.yml` 为空根；再用宿主 pnpm 建链 | ① 知道 profile 目录与 bundle 顺序语义（1.4）；② 改文件时 `dsh` 未运行，避免被回写；③ 官方 bundle 由宿主 `sharedPackages` 解析，**第三方包必须真实落在 profile `node_modules`**（A1:3.2）；④ `engines.dsh`/peer 范围需自行核对 | 绕过 `dsh plugin` 的校验与「无 `dsh.bundle` 则 warning/不激活层」逻辑；顺序写错会改变层叠加结果。S1:85-103 只给出 `add` 产生的 `link:` 依赖形态，**未给出手工 `pnpm link` 的确切命令**，属推断、待验证（第 6 节） | S1:85-109 · L1/L2 · A1:3.2 |

**补充第 4 种（开发期临时加载，不产生持久安装）**：`--patch <file>` overlay，如 `pnpm dsh web --patch ./scratch-plugin/cordis.yml` 或 `dsh.cmd --profile desktop --patch <file>`；插件路径**必须绝对路径**（因为 patch 只贡献配置、不改 loader 解析模块所用的 profile 目录），且 overlay 在层序第 4 位、按 argv 顺序应用。适合阶段 1 快速验证，不是安装手段。来源 S7:46-62 · S1:127 · L8。

---

## 6. 未验证项 / 风险登记

| # | 未验证项 | 原因 | 影响 | 建议验证方式（阶段 1） |
| --- | --- | --- | --- | --- |
| U1 | DSH 内部 `engines.dsh` 检查**是否**用标准 `semver.satisfies`、比较前**是否**把 `0.2.2-rc.1` 规范化为 `0.2.2` | 本次只读官方 `publish.md` 规则 + 用宿主自带 semver 7.8.5 测标准行为，**未读** `cli.js` / `app-boot` 实现源码 | 决定 1.6 的建议值是否真的必要；若 DSH 规范化了 prerelease，则官方示例 `>=0.2.0 <0.3.0` 反而可用 | 一次真实 `plugin add` + `--dump-config` 实测（阶段 0 禁止安装，故未做） |
| U2 | `dsh plugin --profile <name> add <本地目录>` 的实际执行结果 | 阶段 0 禁止安装任何包、禁止改本机 profile | 途径 1 的落地行为未实测 | 阶段 1 在**专用临时 profile** 上做，不动 `desktop` |
| U3 | 桌面端 `plugin_manager install_bundle` 的具体 API 参数、UI 流程、`restart-required` 触发条件 | 本次只读了 S9（develop practice），未取 `packages/boot/plugin-manager/README.md` | 途径 2 的操作细节不明 | 后续任务按需取该 README |
| U4 | `./client` 的 **lazy-CJS factory 格式**具体字节结构 | S12:60 指向 `packages/client/modules/README.md`，本次未取；且该构建 preset 不在发布包内 | 决定第三方设置页能否自行复现构建 | 取该 README + `packages/client/tsdown.client.ts`（仓库外需自建） |
| U5 | `extension-cookbook.md` 的 permission-gate 例子、`dsh-tools` README 扩展点签名与顺序 | S11:59 指向，本次未取 | `tools/pre-execute` 的精确返回值/顺序未知 | 取 `docs/cookbook/extension-cookbook.md` 与 `packages/core/tools/README.md` |
| U6 | `ctx.slots` 完整 slot key 清单与基数/scope | S14:218 指向生成的 `slot-catalog.ts`，本次未取 | 设置页能挂哪些 slot 未穷举 | 取 catalog 或运行时 `cordis_inspect what:"client"` |
| U7 | 本机 `ui-settings` 的 `enabled: false` 是用户手动关闭还是模板默认 | A1:3.4 已标注待确认，本次未动本机配置 | **设置页路线的前置阻塞** | 归 P0-07 处理 |
| U8 | 手工途径 3 中 `pnpm link` 的确切命令、`link:` 依赖在宿主 pnpm 11.28.5 + `hoisted` 下的解析细节 | 官方 develop 文档未给出；S1:105-109 只讲 linked import 的祖先/peer 解析规则 | 途径 3 作为兜底是否可靠 | 阶段 1 在临时 profile 实测 |
| U9 | `!!js` 表达式在 patch 中的完整求值上下文与安全边界 | S1/S10 只给了用例，未取专门说明 | 影响我们 patch 里能否放动态值 | 归 P0-08（沙箱）交叉核对 |

---

## 7. 对我们的直接影响

> 只给结论与路线，不写产品代码。

### (a) 我们的 bundle 该怎么写 `package.json`

按 S1 + 1.6 的建议值，形状如下（**示意，非产品代码**）：

```jsonc
{
  "name": "meetingstone",              // 具体名称待 P0-09 名称占用核验
  "version": "0.0.0",
  "type": "module",
  "main": "./lib/index.js",
  "files": ["lib", "cordis.patch.yml"],
  "engines": {
    "node": ">=22.19.0",
    "dsh": ">=0.2.2-rc.1 <0.3.0-0"     // 以 02b-engine-probe.md 实证结论为准（DSH 比较带 includePrerelease）
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "peerDependencies": {                // 与宿主共享实例的 @deepseek-ai/* 包
    "@deepseek-ai/cordis": "...",
    "@deepseek-ai/dsh-tools": "*"
  },
  "devDependencies": { /* 同上，供类型检查/独立测试，S1:105 */ }
}
```

配套 `cordis.patch.yml` 用 `- insert:` 按包名引用入口，行 `id` 稳定（供用户/profile 按 id 覆盖）；**覆盖已有行时必须重述该行全部 config 键**（整行替换，非深合并，S1:131-134）。共享宿主实例的 `@deepseek-ai/*` 依赖要同时写进 `peerDependencies` 与 `devDependencies`，独立第三方依赖/无状态工具放 `dependencies`（S1:105）。若走 git 分发，需自包含 `prepare` 脚本（S1:171）；若发 tarball/npm 则可免 `allowBuilds`（S1:183-186）。

### (b) 设置页走什么路线

**路线：Host 侧 Schemastery Config + `.volatile()` live 字段 + `ctx.settings.configure({auto:true})` 自动表单为主；Client 侧 `dsh.client` + slots 为辅；阶段 0/1 先不自建 `./client`。**

- 可行：第三方能加设置界面（S12 全文）。Config 用 `@deepseek-ai/schemastery`（不是 zod），默认值写 schema（S6）。
- 最小可用路径：把需要用户改的字段标 `.volatile()`，靠 settings 服务把 Config schema 自动投影成 Plugins 页表单，编辑经 config-editor 持久化到 profile `cordis.patch.yml`，HMR 生效（S12:7-30 · S13:5,11-15 · S6:98-100）。这条路**不需要**自己构建 `./client`。
- 需要自定义 UI 时：`dsh.client` + `exports["./client"]` + `ctx.slots.register/inject`（`plugins.detail.*` / `plugins.item`）。但 `./client` 必须是 lazy-CJS factory 格式，且构建 preset 不在发布包内、仓库外要自己复现（S12:58-60，U4）—— 这是明确的成本与风险，建议后置。
- **前置阻塞**：本机 profile 的 `cordis.patch.yml` 把 `ui-settings` 设为 `enabled: false`（L3 / A1:3.4，U7），原生 Settings 面板当前不启用；且 base bundle 才挂载 settings/config-editor（S12:34）。设置页路线必须先由 P0-07 确认该禁用可恢复，否则「设置页入口」走不通。退路：用 profile `cordis.patch.yml` 的静态 config 覆盖 + 普通配置文档，不强依赖 UI。

### (c) 工具怎么注册

用 `defineTool` + `ctx.tools.register`，`inject = ['tools']`，`parameters` 描述入参、`output.schema` 声明唯一 canonical 值、`output.render` 转模型可见内容、`execute(args, exec)` 里必须遵守 `exec.signal`（S5 / S11）。注册是 effect，dispose 自动注销（S11:38 / S2:59）。

- 权限/审批**不写进工具**：用 `tools/pre-execute` 做 allow/deny/ask、`ctx.tools.guard()` 做最终 deny、`tools/execute` 包 deadline/retry、`tools/post-execute`/`tools/result` 做观察（S11:59）；需要人工确认时走 `ctx.approval.request()`，它是 **fail-closed**（只有 `allowed-once` 放行），并受 per-session `'ask'|'never'` 策略约束（S15）。这与我们要管的子进程/派单直接相关，具体扩展点签名见 U5。
- 若工具要「后台长跑」，用 `ctx.jobs.start({ kind, label, owner: exec.agent, run })`，且发布 id 后改用 task-owned 取消信号而非 `exec.signal`（S11:51-55）—— 这条对 P0-03/04 的子进程生命周期设计是关键输入。

### (d) 本地安装走哪条路最稳

**阶段 0：不安装**（本任务硬性约束）。**阶段 1 主路径：`.cmd` 转发 CLI 的 `dsh plugin --profile <name> add ./<本地目录>`**，理由：

1. 它是官方文档 `dsh plugin add`（S1:77-118）的等价路径，L8 已实测 `.cmd` 可用、`--version`/`--help`/`plugin --help` 均正常，`plugin` 明确转发 pnpm 并在首次使用时初始化 profile；
2. 由它自动维护 `dependencies` 与 `dsh.profile.bundles` 顺序、自动激活声明了 `dsh.bundle` 的层、`remove` 同时删依赖和层，避免手工改文件绕过校验或写错层序；
3. 可用 `--dump-config`（`dsh.cmd --help` 已列出）在不启动的情况下验证层是否生效（S1:114），便于把 U1 的 `engines.dsh` 风险一次实测掉；
4. 应在**专用临时 profile** 上做，不要动 `desktop`（A1/L1 的 7 个 bundle 是用户现状）。

桌面端插件管理器（途径 2）定位为**面向最终用户的安装入口**：配置归属当前 profile、跨重启保留、需 Creator 模式与 agent 提示词驱动（S9）。手工改 `package.json` + pnpm link（途径 3）仅作兜底，且 U8 的确切命令未验证，使用前需人工核对 bundles 顺序与 `cordis.yml` 空根。开发期快速验证可用 `--patch` overlay（插件路径必须绝对路径），但它不产生持久安装。

---

*本文为阶段 0 审计证据，仅记录「怎么得到的」；未验证项一律登记于第 6 节，未推断成结论。*
