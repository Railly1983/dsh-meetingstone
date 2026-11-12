# GUI 只读配置页（0.2.0）

> **任务列表由原生 Jobs 提供，插件不自造 UI。** 派单成功后，宿主 `ctx.jobs` 可用时本插件会注册
> `meetingstone-dispatch` Job（`角色简称 · 简短目标`，见 §7）；查看/停止任务使用宿主
> `@deepseek-ai/dsh-tool-jobs` 提供的能力与面板。本页面只负责角色/通道/错误的只读展示，不复制任务列表。

范围：**V1 最终 UI**（U2+U3）。设置页只保留两个区；右侧栏「本对话角色」提供三色二态开关与可编辑的二级详情。
所有数据接真实 Remote，不新增 UI 库、不 require primitives、不做 DOM/CSS 注入；控件是原生
`input/select/textarea/button[role=switch]`，样式只用宿主 token（`var(--dsw-alias-*)`、
`--dsw-radius-*`、`--dsw-focus-ring-*`）。历史章节（§1–§9）保留为调研与实现证据；**当前行为以 §10 为准**。

1. **外部 CLI 连接**：Codex / CodeBuddy / Claude 三行，每行只有名称 + 原生风格 Switch。
   不显示版本、路径、额度、通道 ID、宿主信息、徽章。开关读 CLI 偏好（`unset` 且 preflight
   通过 → 默认开）；关闭持久化；开启前强制 preflight，失败保持关并显示一行摘要 + 人工步骤 +
   「重新检测」。不做自动修复。
2. **默认角色配置**：模板名「取经五人组」+ 一句说明 + 角色数量 +「管理角色」入口。

删除：并行上限、同项目串行、全局调度、高级设置、通道实例、配置文件路径、DSH 宿主行。

右侧栏**本对话角色**：每行角色名 + 三色二态 Switch（灰=关闭或依赖阻断；黄=启用且额度耗尽；
绿=启用且正常/未知）；点击名称进入同栏二级详情（全局 / 本会话两 scope 复用），可编辑名称、简称、
描述、CLI/通道、模型、思考强度、角色 Prompt；每字段显示来源并可恢复继承。开关只写当前会话覆盖
（`session` scope），不污染全局/项目，失败不做乐观假开启。

不做搜索 / 筛选 / 排序 / 图表 / 动画；不新增模型注册表 / 路由 / 接替规则。错误首屏只显示
一行摘要，详情默认折叠，无错误不占位。遵循宿主设计：本地 `Tag` span + 16px 内联 SVG +
主题 token，不自带 CSS 框架、不自造色板。**不 require**
`@deepseek-ai/dsh-client-ui-primitives`：P0-U0 核验确认该包不在 asar 的 `node_modules`，
且官方 `practices.md:35` 明确禁止第三方插件 require 它。

## 1. 调研结论（证据）

证据均取自本机 `C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
（DSH `0.2.2-rc.1`，运行时 Node `24.21.0`），用 `scripts/asar-extract.mjs` 抽取内部文件。
内部路径前缀统一为 `dsh/node_modules/@deepseek-ai/`。

| 问题 | 结论 | 证据（app.asar 内） |
| --- | --- | --- |
| `dsh.client` 声明 | `package.json` 里 `dsh.client = { platform: "web", inject: [...] }`。`inject` 列的**是插件包**（客户端 half 的加载前置包），不是服务名。要用 Remote 的包会列 `@deepseek-ai/dsh-api-remotes` | `dsh-client-ui-settings-plugin-inventory/package.json:29-40`；`dsh-api-remotes/package.json:33-41` |
| 入口形式 | `exports["./client"]` 指向一个**普通脚本**，脚本体是 `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ... exports.apply / exports.inject ... } })`（lazy-CJS factory）。`factory` 内 `require()` 解析宿主共享模块（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等）；`id` 必须等于包名 | `dsh-client-ui-settings-plugins/lib/client.js:1-6,269-273` |
| 发现机制 | client module system 扫描 enabled Loader 行里**声明了 `dsh.client`**、且 specifier 是**裸包名的根行**的包，serve 其 `./client` 导出 | `docs/audit/02-plugin-spec.md` §4.3(b)；结构旁证 `dsh-cliworker-now` |
| Host half | 只需一个 `apply()` 让包在 Loader 里有一行；section 由 browser half 拥有。本版额外在 `apply()` 里注册只读 Remote 服务 | `dsh-client-ui-settings-plugins/lib/index.js:1-13`；本仓库 `src/index.js` |
| 设置页 section 注册 | `settings.section` 是 `dsh-client-ui-settings-general` 声明的 root list slot（`kind:"list", scope:"root"`）。贡献方式：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id, order, label, locale, inject }, Component))`；服务 `inject = ["slots","locale"]`，组件通过 `inject()` 拿数据加载器 | `dsh-client-ui-settings-general/lib/client.js:1547-1550,1587-1597`；`dsh-client-ui-settings-plugins/lib/client.js:210,255-266` |
| Host 只读 RPC 的形状 | Host 侧继承 `TypertRemoteService`（`super(ctx, "<namespace>")`），方法上用 `Remote("<method>")` 装饰器打 SRC marker；Gateway 扫描 `ctx.reflect.props` 中带 `typertRemote` binding 的 service 暴露端点 | `dsh-host-plugin-inventory/lib/index.js:1,69-99`；`dsh-api-gateway/lib/index.js:924-938,1268-1272,1731-1745` |
| Client 怎么拿 Host 数据 | 浏览器 half 先 `ctx.remote.$mount(contribution)` 安装 `remote.<namespace>` 服务，再 `ctx.remote.<namespace>.<method>()`；返回值是 `{ ok:true, value }` / `{ ok:false, error }`。官方生成物 `typert.remote-client.js` 提供 contribution descriptor | `dsh-client-ui-settings-plugin-inventory/lib/client.js:963-1015`；`dsh-api-gateway/lib/client.browser.js:1599-1702`；`dsh-host-plugin-inventory/lib/typert.remote-client.js:51-70` |
| 生成物字段 | contribution = `{ package, descriptors:[{ id, service, namespace, method, parameters, invocation:{kind:"direct"}, result:{mode:"strict"\|"src-json", ...} }] }`。`remotes.register()` 会校验：`id/service/namespace/method` 非空；result codec 必须是 strict + `typeSymbol` + `create()`，或 `{mode:"src-json"}`。零参数只读方法不需要参数 codec | 同上 `typert.remote-client.js`；`dsh-typert-registry/lib/index.js:143-155,584-627`；`dsh-api-gateway/lib/client.browser.js:1720-1760,1820-1845` |
| `require()` 宿主 ESM 包 | 桌面运行时 Node 24 支持 `require()` ESM；本仓库已有 `require('@deepseek-ai/dsh-tools')` 先例，故 Host 侧用同样的 `createRequire` 懒加载 `@deepseek-ai/dsh-typert-protocol` | `resources/runtime/versions.json`（node `24.21.0`）；`src/index.js:40-46` |
| 只读展示组件 | 官方内部用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tag({ tone, children })`（`tone`: `neutral/warning/info/danger`）。但该包在 asar 内**无物理目录**，只是 loader 别名提供的 bundle 共享模块，且官方 `practices.md:35` **禁止第三方插件 require**；U1a 起本插件**不 require**，按官方 `._tag_*[data-tone=...]` CSS 自绘 `span`（token 同上），图标用 16px 内联 SVG | `dsh-client-ui-settings-plugin-inventory/lib/client.js:266-281`；`dsh-web-frontend/dist/assets/index-lh_YM6sT.css`（tag/tone 规则）；`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35` |

补充：本仓库现有工具（`meetingstone_list_roles` 等）是 `ctx.tools` 的**模型工具**，不是浏览器 remote。
本版把同一份 Host 数据投影到 Remote face：`src/gui/host.js` 直接复用
`registry.list()` / `cfg.channels` / 现有错误记录，**没有第二个数据源**。

## 2. 数据链路（本次落地）

```
Settings 页面
  └─ Section（src/client/index.js）
       └─ ctx.remote.meetingstone.list()            ← $mount 安装的 namespace
            └─ Typert Gateway /api（Host）
                 └─ MeetingStoneGuiRemote.list()    ← src/gui/host.js
                      └─ createGuiState().snapshot()
                           ├─ registry.list()                角色（与 list_roles 同一份）
                           ├─ cfg.channels                   通道（与派单器同一份）
                           └─ lastError                      注册表/项目配置/派单/落盘错误
```

### 2.1 Host 侧（`src/gui/host.js`）

- `createGuiState({ ctx, registry, channels })`
  - `snapshot()` → `{ roles, channels, lastError }`，整体是无损 JSON。
  - 角色：`{ roleId, name, aliases, enabled, availability }`；`availability` 复用
    `src/dsh/register.js` 的 `roleAvailability()`（`ctx.subagents.getProvider`）。
  - 通道：`{ channelId, kind }`，来自插件配置 `cfg.channels`。
  - `lastError`：`{ code, message, at, source }`。初始化取注册表最后一条错误；之后由
    项目配置加载、派单失败、落盘失败更新。**成功派单不会清掉历史错误**（“最近错误”语义）。
- `registerGuiRemote(ctx, { snapshot })`
  - 懒加载 `@deepseek-ai/dsh-typert-protocol`；宿主没有该包时返回
    `{ registered:false, reason:"TYPERT_UNAVAILABLE" }`，**不抛错、不影响工具/派单**。
  - 用 `TypertRemoteService` + `Remote("list")` 创建 `meetingstone/list` 只读端点。
  - `src/index.js` 在插件 effect 内注册；服务随插件 fiber 卸载自动注销。

### 2.2 Browser 侧（`src/client/index.js`）

- `inject = ["slots","locale","remote"]`。
- `apply()`：
  1. 注册 locale 字典；
  2. 能力检测后调用 `ctx.remote.$mount(contribution)` 安装 `remote.meetingstone`；
     失败只记 `mountError`，**不中断后续注册**；
  3. 按 **header → section → sidebar** 顺序注册，每段独立 guard（一段失败只写一条
     统一格式日志，不影响其他段）；
  4. `settings.section` 的 `list()` 调 `ctx.remote.meetingstone.list()`，失败即抛错；
     成功后用 `normalizeSnapshot()` 收窄形状；
  5. 右侧栏面板同样只消费无参 `list()`，只读渲染角色名/别名/可用性/通道。
- 组件渲染 V1 三区（CLI 连接 / 默认协作配置 / 高级设置），高级区默认收起。除协作区的
  「管理角色」入口按钮外，无任何编辑/搜索/动画控件。加载中显示「加载中…」，失败显示
  「读取宿主数据失败」+ 错误信息，**不伪造数据**。（**历史阶段**：0.2.0 只读页；
  U2+U3 已改为两区 + 可编辑详情，见 §10。）

> **V1 字段核查（2026-11-11）**：设置页投影的底层字段逐一核过——
> `maxParallelWritesTotal` / `serializeWrites` / `defaultIsolation` 真实生效（见
> `src/dispatch/dispatcher.js:431-435,538,553,703`）；`channels` 承载模型/强度且被
> `src/dsh/adapter.js` 消费；`defaultRoleId` 是自动路由兜底（见 `src/dispatch/routing.js`）。
> `dispatchNotes` 仅持久化并在设置页作为「全局调度补充规则（可读文本）」展示，**未接入派单/
> 路由逻辑**（语义上即辅助说明，不影响通道与并发）；V1 保留该字段与展示，未新增行为接线。
> 未删除任何已生效底层配置。

## 3. 注册方式（本次落地）

- `package.json`
  - `dsh.client.inject` 增加 `@deepseek-ai/dsh-api-remotes`（提供 `ctx.remote` 与 `$mount`）。
  - `exports["./client"] = "./src/client/index.js"`（已有）。
  - `files` 不改：`src/gui/host.js` 随 `files:["src"]` 打包（`verify-package` 已覆盖）。
- `cordis.patch.yml` **不改**：已有 `- id: meetingstone / name: dsh-meetingstone` 是裸包名
  根行，正是 client half 与 host half 的挂载条件。
- **profile 无需新增行**。若用户已在 profile 覆盖 `meetingstone` 行，保持原样即可；设置页读的是
  该行生效后的 `config.roles` / `config.channels`。

可粘贴的 YAML 片段（**仅在需要显式固定配置时使用；本任务没有改 profile**）：

```yaml
# profile 的 cordis.patch.yml（示例：只读页要展示的角色/通道就来自这里）
- id: meetingstone
  name: dsh-meetingstone
  config:
    roles: []      # 与工具共用；这里写什么，设置页就显示什么
    channels: []   # 一行 = 一个 provider 实例（channelId + kind + model/strength）
```

> 注意：patch 是整值替换，不是深合并；一旦覆盖 `config` 就要写全。

## 4. 验证步骤

```bash
node scripts/run-tests.mjs        # 含 tests/gui.test.mjs（stub harness）与 tests/session-gui-api.test.mjs
node scripts/verify-manifest.mjs
node scripts/verify-package.mjs
```

`tests/gui.test.mjs` 是本次的 **stub harness**（结构级，不是真机渲染）：

- Host：`createGuiState().snapshot()` 的角色可用性 / 通道形状 / lastError 更新 /
  无损 JSON；缺少 Typert 协议时 `registerGuiRemote` 安全降级。
- Browser：用假的 `window.__ModuleLoader__`、`require`、`ctx` 执行真实
  `src/client/index.js`，断言 `settings.section` 被注册、contribution 被 `$mount`、
  `list()` 走 `ctx.remote.meetingstone.list()` 并收窄数据；Remote 失败时抛错。

### 真机加载步骤（需操作者手动执行；本任务**未执行**，未改 profile）

1. 用**隔离/临时 profile**（不要动默认 `desktop`）：把本仓库作为 bundle 安装，例如
   `"…\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile <tmp> add <本地绝对目录>`，
   或桌面端 Plugin Manager 安装 configuration-only bundle。
2. 确认 Loader 行 `- id: meetingstone` 处于 enabled（`cordis.patch.yml` 已提供）。
3. 重启 DSH / 等 HMR，让 client module system 为裸包名根行 serve `./client`。
4. 打开 Settings（外壳由 `dsh-client-ui-settings-general` 提供）→ 侧栏「集合石」section。
5. 预期看到 V1 三区（**历史阶段**；U2+U3 当前为两区，见 §10）：
   - **CLI 连接**：紧凑一行一个，名称 + 版本 + 状态；首行「宿主 / DeepSeek Harness /
     运行中」，其余为「外部」CLI（codex / codebuddy / claude）的检测状态与版本；
   - **默认协作配置**：角色数量 + 默认角色 + 「管理角色」入口合并在同一行（左右对齐），
     并行写上限、同项目串行、调度补充规则左标签右值对齐；
   - **高级设置（默认收起）**：展开后见默认隔离、CLI 完整路径、通道实例、配置文件入口、
     日志目录。
   可用性标签来自 `ctx.subagents.getProvider`。有错误时首屏只显示一行摘要（不换行），
   点击「查看详情」才展开时间/来源/完整消息；无错误不占位。控制台应出现
   `[meetingstone] gui module=<header|section|sidebar> phase=register version=… status=ok`
   （失败时同一格式带 `error=` 与 `stack=`）；若出现
   `[meetingstone] gui module=remote phase=mount … error=TYPERT_UNAVAILABLE`，说明宿主未
   解析到 `@deepseek-ai/dsh-typert-protocol`，页面会显示读取失败而不是假数据。

## 5. V1 UI：对话顶部入口 + 右侧栏只读角色面板（决策 2/3/4/5/6）

> **历史阶段**：本节与 §9 描述的是只读面板；U2+U3 已把同一面板升级为三色二态 + 二级详情，
> 当前行为以 §10 为准。

在 0.2.0 只读页之外，本版提供「会话角色」入口与只读面板，复用同一套官方 slot 注册；
设置页仍用无参 `list()`，侧栏面板改用 strict `getSessionConfig(sessionId)`，不新建 UI
体系、不做 DOM/CSS 注入。

### 5.1 顶部集合石入口（header action，稳定性优先）

- slot：`conversation.session.header.actions`（`kind:list, scope:session`）。
- 注册形状（对齐官方约定）：`{ name, id, order, locale, inject(sessionId) }`；组件渲染
  **内联 SVG（users 风格 16px）+ 文案「角色」**（U1a：不再依赖 primitives 的 `Icon`）。
  `aria-label` / `title` 保留在外层 button，SVG 自身 `aria-hidden="true"`、
  `focusable="false"`。
- 样式全部用宿主 token：`background: var(--dsw-alias-button-tool-bar-fill)`、hover
  `--dsw-alias-button-tool-bar-hover`、`border: 0.5px solid var(--dsw-alias-border-l3)`
  （替换掉原生 button 粗边框）、`border-radius: var(--dsw-radius-sm)`、focus
  `--dsw-focus-ring-width/color`；尺寸对齐官方 `sm` Button（28px / 12px 字号 / 0 10px padding）。
- **注册顺序固定为 header → section → sidebar**，每段独立 guard。header 的注册**不依赖**
  `$mount` 成功：挂载失败时仍注册，`inject` 返回 `remoteReady:false`，按钮 tooltip 与
  点击提示均为「远程不可用」，入口不会消失。
- 点击（remote 就绪）→ `ctx.sidebarRight.openTab(TAB_KIND, { params: {} })` 打开右侧栏 tab。
- 注册/渲染失败统一日志格式：
  `[meetingstone] gui module=<module> phase=<register|render> version=<v> error=… stack=…`；
  成功为同格式 `status=ok`。一段失败不影响其他段；日志不记录凭证。

### 5.2 右侧栏 tab（两步式）

1. `ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title })` 注册 tab
   本体（能力检测：服务不存在时跳过 tab 本体，但仍注册 seat）。
   **`priority` 必须是官方档位字符串** `extension|builtin|fallback`，不是数字（P0-U0 §6）。
2. 注册两个 keyed seat（scope session，id 与 tab 对齐）：
   - `sidebar.right.pane.tab` → 面板内容 `SidebarRolePane`
   - `sidebar.right.pane.tab.title` → 标题 `SidebarRoleTitle`

### 5.3 面板内容：只读会话生效配置（strict Remote）

- 数据来自 strict `ctx.remote.meetingstone.getSessionConfig(sessionId)`，返回
  `{ effective, overrides, sources }`；**不改写、不写盘、不调用 set/clear**。
- 每个角色渲染：角色名、角色 ID、别名、通道（`channelId · provider · model`），以及
  **来源层**（全局 / 项目 / 会话，来自 `sources.roles[roleId].layer`）和**是否有会话覆盖**
  （`overrides[roleId]` 非空；有覆盖时列出覆盖字段名）。
- 顶部固定说明：**只读：展示三层继承（全局 → 项目 → 会话）后的生效角色与来源；
  会话级编辑待真机验证后接入**。
- 调用失败（`ok:false` 或抛错）不抛出、不空白：保留标题 + 只读说明，并显示**一行**
  错误摘要（`[code] message`，`nowrap + ellipsis`，完整内容在 `title` 里）。
- 没有输入框 / 保存 / 恢复继承等写操作；角色为空时显示可读说明。

### 5.4 Host 远程方法：`list` + 三个 strict 会话方法（P0-S0）

`src/gui/host.js` 注册四个方法（**历史阶段**；U2+U3 已扩到 7 个，见 §10.4）：

| 方法 | 参数 codec | 说明 |
| --- | --- | --- |
| `meetingstone/list` | 无参（SRC marker） | 全局只读快照，0.2.0 既有行为不变 |
| `meetingstone/getSessionConfig` | `sessionId` strict | 读当前会话生效角色/覆盖/来源 |
| `meetingstone/setSessionOverride` | `sessionId/roleId/field/value` strict | 写字段级会话覆盖（只写差异） |
| `meetingstone/clearSessionOverride` | `sessionId/roleId/field?` strict | 恢复单字段/整角色继承 |

契约实现（**不是空壳**）：

- Host：`src/gui/typert-spec.js` 用真实 zod 构造 spec；`src/gui/typert.js`
  调官方 `createTypertRemoteInfo(spec, zod)` 得到 descriptor，再经
  `ctx.inject(['typert']) → ctx.typert.register(manifest)` 注册 Host strict 定义。
  Gateway 会优先使用它（`dsh-api-gateway/lib/index.js:1255-1259`），并在调用边界用
  `codec.create().parse(value)` 做真实参数校验（同文件 1796-1820）。
- Client：`src/client/index.js` 的 `REMOTE_CONTRIBUTION` 恢复三个方法，参数 codec 为
  `{ mode:"strict", typeSymbol, create: () => z.<schema>() }`，typeSymbol 与 Host 逐字一致。
- zod 来源：宿主 web 模块表 `staticModules` 已包含 `zod`（`dsh-web-frontend` 的 `YZ()`），
  官方 `dsh-api-remotes/lib/client.js:7` 也直接 `require("zod")`；Host 侧优先
  `require('zod')`，失败时从 `dsh-typert-protocol` 的依赖解析。
- 降级：Host 缺 zod/协议/typert 时只跳过 strict 方法并记日志；Client 缺 zod 时只挂无参
  `list`，日志 `module=remote phase=strict error=ZOD_UNAVAILABLE`，**不伪造 strict**。

`src/gui/session.js` 仍是纯业务层（继承解析、只写差异、白名单）；`src/gui/session-remote.js`
只负责把业务错误转成宿主 `RemoteError`（稳定 code 原样回传）。

#### 5.4.1 新会话定位（不依赖先派单）

`src/gui/session-root.js` 按官方路径解析 sessionId → cwd：

1. `ctx.sessions.get(id).header.cwd`（live Session；`dsh-session/lib/index.js:1993-2000`）；
2. `ctx.agents.get(id).session.header.cwd`（live Agent；`dsh-agent/README.md:28-35`）；
3. 派单时记录的 `sessionRoots` 映射（兼容兜底）。

不使用 `ctx.sessionController.resolveAgent()`：它会对冷会话执行 resume（创建 Agent），
侧栏读取不应触发写副作用。新会话在 `session.create` 时已创建 Agent
（`dsh-api-session-controller/lib/index.js:265-355`），因此**未派单也能读**。若会话尚未
激活且没有兜底映射，方法如实返回 `SESSION_GUI_SESSION_ROOT_UNKNOWN`，不猜路径。

### 5.5 验证

```bash
node scripts/run-tests.mjs            # gui.test.mjs（注册顺序 / 4 个 descriptor / strict 契约 / 日志）
node scripts/smoke-client-inject.mjs  # 真实 Cordis：mount 失败仍注册 header
```

`tests/gui.test.mjs` 覆盖：Client 4 个 descriptor（list + 三个 strict 会话方法）；Host/Client
method、参数 wire 与 typeSymbol 完全一致；header 最先注册且 `$mount` 失败不消失；header 用
内联 SVG + aria-label/title；pane 调 strict `getSessionConfig` 且只读展示来源/覆盖、无
input/保存控件；失败时一行错误摘要；单模块注册失败不影响其他模块；注册/渲染统一日志格式与
「日志不含凭证」断言。`tests/gui-primitives.stub.test.mjs` 额外断言源码不再 require
primitives、priority 为字符串档位。`tests/session-gui-api.test.mjs` 直接测试
`createSessionGuiApi` 的继承语义；`tests/typert-contract.test.mjs` 覆盖 Host strict 注册与
参数校验。会话写 UI 仍未接入（见 §8/§9）。

## 6. 限制与未验证项（如实登记）

- **真机 GUI 未验证**：本环境无法启动 DSH 桌面端，未做截图级确认。`settings.section` 是否
  真实出现、本地 `Tag`/内联 SVG/主题 token 的实际渲染、`ctx.remote.$mount` 与宿主 Gateway
  的真实传输，都只做了源码级对齐 + stub harness。
- **项目级 `.meetingstone.json` 覆盖在设置页不可见**：Remote 调用没有会话 cwd，
  无法定位项目根，因此只展示插件行生效的全局 `config`。项目覆盖仍只影响派单/工具。
  若将来要展示项目视图，需要 `RemoteScope` 或由客户端显式传项目身份（会引入权限/上下文问题）。
- **手写 contribution**：没有 `@deepseek-ai/dsh-typert-generator`，`src/client/index.js` 按
  生成物字段手写最小 descriptor（零参数、`result.mode:"src-json"`，无结果解码）。字段形状已对
  `typert.remote-client.js`、`typert-registry` 的 `validateInvocation()` 与 Gateway 客户端实现
  核对，并由 stub harness 断言；但未经生成器/Typert 编译器与真机 `$mount` 验证。
- **Host 依赖解析**：`@deepseek-ai/dsh-typert-protocol` 通过 `createRequire` 懒加载，依赖宿主的
  共享模块解析（与现有 `@deepseek-ai/dsh-tools` 相同机制）。若该包与宿主 Cordis 不是同一实例，
  `TypertRemoteService` 可能无法注册；届时按第 4 步日志定位。
- **无订阅/自动刷新**：快照在组件挂载时拉取一次；页面停留期间不推送更新。切换 section 重新挂载
  才会刷新。没有加轮询/按钮，符合“最简、无操作按钮”的要求。
- **lastError 是进程内状态**：只保存本进程最近一条错误（注册表错误在启动时初始化），
  不落盘、不跨重启。
- **既有 flaky 测试**：`tests/parallel.test.mjs` 的「真实并行：两任务时间重叠」在全量并发下
  偶发失败（两任务区间恰好相切），单跑通过；与本次改动无关。
- **V1 UI 真机未验证**：header action（`conversation.session.header.actions`）、右侧栏两步式
  注册（`sidebarRightTabs.register` + `sidebar.right.pane.tab` / `.title` seat）、内联 SVG 与
  token 样式、`ctx.sidebarRight.openTab(TAB_KIND, …)` 的打开语义，均只做了源码级对齐 + stub
  harness 结构断言，未做真机渲染确认。本次修复的「header 不消失」需在真机重启后再确认一次。
- **`sidebarRightTabs.open` 方法名未核实**：打开右侧栏用的是 `ctx.sidebarRight.openTab(kind, …)`；
  真机若实际为其他方法名，需在 `openRolePanelOf` 内调整（入口本身仍存在，不会因此消失）。
- **带参会话 Remote 已恢复，但真机未验证**：Host strict 定义、Client strict 参数 codec、
  `ctx.typert.register` 时序、卸载注销目前只做了源码级对齐 + 单测（`tests/typert-contract.test.mjs`、
  `tests/gui.test.mjs`）。必须在隔离 profile 真机确认：无 `has no strict codec`、set/clear 生效、
  非法参数被 Host 拒绝、卸载后端点消失。真机步骤见 §8.4。
- **面板只读且已接 strict Remote**：右侧栏读 `getSessionConfig(sessionId)`（来源/覆盖只读投影），
  **不调用** set/clear、不写盘；写 UI 仍受 P0-S0 门禁约束（见 §9.3）。
- **`sessionRoots` 降为兜底**：`index.js` 仍在派单/工具执行时记录 sessionId→项目根；正常读取
  优先走 `ctx.sessions`/`ctx.agents` 的 `header.cwd`（`src/gui/session-root.js`）。


## 7. 三个面板的职责与命名规则（P0-1）

### 7.1 职责边界（不互相顶替）

| 面板 | 负责什么 | 谁写入 | 本插件做什么 |
| --- | --- | --- | --- |
| **Todo** | **项目级工作包与里程碑**（跨派单的进度视图） | 主控 / 用户通过 `todo_write` | **派单不建 Todo**；本插件不写 Todo |
| **Background Tasks** | **真实外部 CLI / 子 Agent 的宿主 Job**（后台长跑、可停止） | 插件 `ctx.jobs.start({ kind, label, owner, run })` | 每次派单建一条 `kind=meetingstone-dispatch` Job；没有 `ctx.jobs` 时不建、不伪造 |
| **Subagents** | **Agent 执行会话目录**（父子关系、运行状态、结果） | 宿主 `subagent/descriptor` + `subagent/catalog` | 只通过官方 `startActivation({ label })` 提供行标题，不自造列表 |

一句话：**Todo 看项目进度，Background Tasks 看真实后台任务，Subagents 看 Agent 会话**。
三者不是同一份数据的三种皮肤，不能把派单塞进 Todo，也不能自建 Subagents 列表。

### 7.2 命名规则

统一格式：`角色简称 · 简短目标（≤14 字）`，例如 `沙僧 · 修复 F1–F8`。

- **角色简称**：优先 `role.name`；没有名字时退回 `roleId`（去掉 `role-` 前缀）。
- **简短目标**：优先 `taskSpec.title`（结构化简报的短任务名），否则取任务首个有效行。
- **清洗**：去掉 Markdown 符号（`*` `_` `#` `` ` `` `[` `]` `(` `)` `{` `}` `<` `>` `|` `~` `\`）、
  `meetingstone:` 内部前缀、`任务：` / `Task:` 正文标签与控制字符；英文 / 数字保留。
- **回退**：空任务 → `未命名任务`；空角色 → `未知角色`。
- **长度**：目标按码点截到 ≤14 字（含省略号），不会切坏 emoji / 汉字。
- **一处实现**：`src/naming.js` 的 `buildTaskLabel()` 同时用于 Subagents 的
  `startActivation({ label })` 与 Background Tasks 的 Job `label`，避免两处漂移。
- **进度与详情**：Job 运行中进度只写 `已启动`；终态只写 `已完成` / `失败` / `已取消`；
  工作树绝对路径不进面板。`JobView.detail`（终态）截到 ≤80 字，完整内容仍在
  `.meetingstone/runs/<childId>.json` 与 Job output ring。

### 7.3 宿主 API 证据（app.asar / 已安装 provider）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| `startActivation` 有没有能决定 Subagents 标题的字段 | **有 `label`**（可选字符串）；README 契约是 `startActivation({ provider, label, request, signal, delivery })`。没有 `title` 字段 | `dsh-subagent/README.md:61`；`dsh-subagent/lib/index.js:3051`（startActivation） |
| `label` 如何进入 Subagents 面板 | 本地 provider 把 `label` 写进 `subagent/descriptor`，并 `establishCatalogChild(parent.session, …, descriptor)`；客户端目录行读 `entry.label ?? entry.id` | `dsh-subagent/lib/index.js:1410-1417,1471`；`dsh-client-ui-subagent/lib/client.js:202` |
| 外部 provider 是否透传 | 宿主把 `label` 传给 provider（`...spec.request, label: spec.label`），但仅 `delivery:'parent'` 才写 external catalog；本插件用 `delivery:'caller'`，且已安装的 acp / codex / claude-code 实现里没有读取 `label`。**外部通道的 label 不影响面板** | `dsh-subagent/lib/index.js:1504-1514`；`dsh-subagent-acp` / `-codex` / `-claude-code` 的 `lib/index.js`（grep 无 label 使用） |
| 会话标题（sidebar / 第二行） | 由宿主 `dsh-session-title` 从首条用户消息自动生成，**不能**通过 `startActivation` 设置；我们控制的是目录行 `label` | `dsh-session-title/lib/index.js:386-415,630-650`；`dsh-client-ui-subagent/lib/client.js:207` |
| Jobs 有没有可控 `detail` | `JobSpec` 只有 `kind/label/owner/run`；`progress` 由 `handle.updateProgress(line)` 控制；`JobView.detail` 来自终态 `hooks.done` 的 `detail`。宿主不自动截断，插件自己截到 80 字 | `dsh-jobs-local/lib/index.js:416,448,589-590,750-760,769-773`；`dsh-client-ui-jobs/lib/client.js:205-210` |

### 7.4 未验证 / 限制

- **Subagents 行标题真机渲染未截图验证**：`label` 的数据链路已按源码核对；真实桌面端目录行的
  显示仍需一次人工确认（本任务不改宿主、不做 DOM 注入）。
- **外部 provider 的 Subagents 可见性**：`delivery:'caller'` 下宿主不写 external catalog，
  因此 acp / codex / claude-code 是否出现在 Subagents 面板取决于宿主会话列表，而不是我们的
  `label`；不要承诺"外部 CLI 任务一定出现在 Subagents 面板"。
- **会话标题仍是宿主生成**：若宿主把首条 Prompt 当作 sidebar 标题，标题可能仍含任务正文；
  本插件只负责目录行 `label`，不伪造/覆盖宿主会话标题。

## 8. P0-S0：strict Remote + 新会话定位（0.2.0 垂直切片）

本节是「角色面板可配置」的门禁实现说明。**未通过真机验证前，不得扩写会话写 UI。**

### 8.1 契约形状

Host（`src/gui/typert-spec.js` + `src/gui/typert.js`）：

```js
// 参数 codec（真实 zod，不是空壳）
{ mode: 'strict', typeSymbol: 'dsh-meetingstone/types#SessionId', create: () => z.string().min(1).max(128) }

// 方法定义（经 createTypertRemoteInfo 变成 descriptor）
{
  service: 'meetingstone',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec }],
  result: { mode: 'strict', typeSymbol: 'dsh-meetingstone/types#SessionConfigView', create: () => z.object({...}) },
}

// 注册
ctx.inject(['typert'], (typeCtx) => typeCtx.typert.register({
  package: 'dsh-meetingstone', face: 'host', schemas: [],
  invocations: createTypertRemoteInfo(spec, z).descriptors,
  model: { services: [], events: [], objects: [] },
}))
```

Client（`src/client/index.js` 的 `REMOTE_CONTRIBUTION`）：参数 codec 同形同 typeSymbol；
`result` 用 `{ mode: 'src-json' }` 原样透传（Gateway 客户端只强制输入 codec）。

> 调用约定：Client 的 `prepareInvocation` 按 descriptor 参数个数校验实参（`dsh-api-gateway/lib/client.browser.js:1832-1836`）。
> `clearSessionOverride` 的 `field` 虽在 Host 侧可省略，Client 调用需显式传第三参
> `undefined`（`clearSessionOverride(sessionId, roleId, undefined)`）表示整角色恢复继承；
> 不能只传两个实参。

typeSymbol 清单（Host/Client 必须逐字一致，`tests/gui.test.mjs` 断言）：

| 键 | typeSymbol |
| --- | --- |
| sessionId | `dsh-meetingstone/types#SessionId` |
| roleId | `dsh-meetingstone/types#RoleId` |
| field | `dsh-meetingstone/types#OverrideField` |
| value | `dsh-meetingstone/types#JsonValue` |
| 读取结果 | `dsh-meetingstone/types#SessionConfigView` |
| 写入结果 | `dsh-meetingstone/types#SessionOverrideResult` |

### 8.2 文件

| 文件 | 职责 |
| --- | --- |
| `src/gui/typert-spec.js` | 纯契约：真实 zod schema、typeSymbol、strict 自检 |
| `src/gui/typert.js` | 懒加载宿主 zod/协议；`createTypertRemoteInfo` + `ctx.typert.register` |
| `src/gui/session-remote.js` | 业务错误 → 宿主 `RemoteError`（稳定 code） |
| `src/gui/session-root.js` | sessionId → `header.cwd` 官方解析 + 派单兜底 |
| `src/gui/session.js` | 原有继承/白名单/落盘逻辑（未改语义） |
| `src/gui/host.js` | 四个 Remote 方法 + SRC marker + strict 注册接线 |
| `src/index.js` | 构造 session GUI API、注入 resolver、日志 |
| `src/client/index.js` | 三个 strict client descriptor + zod 降级 |
| `package.json` | 仅新增 `devDependencies`（zod / typert-protocol / typert-registry / cordis），运行时依赖仍为 0 |

### 8.3 测试

```bash
npm install --no-package-lock   # 仅 devDependencies（zod / typert-protocol / typert-registry / cordis）
npm test
# 新增/更新：
#   tests/typert-contract.test.mjs  strict codec、参数校验、非 strict 拒绝、真实 registry 注册/注销
#   tests/session-root.test.mjs     新会话 header.cwd、agents 回退、派单兜底、无证据 null
#   tests/session-remote.test.mjs   RemoteError code 透传
#   tests/gui.test.mjs              Client 4 个 descriptor、Host/Client typeSymbol 一致、zod 降级
npm run verify
```

覆盖点：descriptor strict + typeSymbol 非空 + 真实 zod；非法参数被 zod 拒绝；Host/Client
typeSymbol 一致；真实 `TypertRegistry` 接受 manifest 且 `dispose()` 后端点注销；空 typeSymbol /
空壳 create 被 registry 拒绝；注册失败只记录不抛出；缺 zod 时 Client 只挂 `list`。
`package.json` 的 `dependencies` 仍为空（`verify-manifest` 断言），zod 仅作 devDependency；
发布包依赖宿主 `dsh-typert-protocol` 的 zod 依赖解析（`loadHostZod` 的双路径）。

### 8.4 真机验证步骤（主控在合并后执行；本任务未执行）

1. 用**隔离 profile**（不要动默认 desktop）安装本仓库构建的 tarball；确认 Loader 行
   `- id: meetingstone` enabled。
2. 重启 DSH（或等 HMR），打开设置页与一个**新建、未派单**的会话。
3. 浏览器 DevTools/宿主日志确认：
   - `[meetingstone] gui module=remote phase=register … status=ok strict=ok|deferred`
     （`deferred` 表示 typert 稍后才就绪，随后会出现 `phase=strict status=ok`）；
   - 无 `client api: generated Remote meetingstone/... has no strict codec`；
   - 无 `TYPERT_UNAVAILABLE` / `ZOD_UNAVAILABLE` / `phase=strict … error=`。
4. 在侧栏/控制台调用（或用后续 UI）：
   - `ctx.remote.meetingstone.getSessionConfig('<sessionId>')` → `{ok:true,value:{effective,overrides,sources}}`；
   - `setSessionOverride(sessionId,'<roleId>','model','m-x')` → 写 `.meetingstone/sessions/<id>.json`，
     且 A/B 两个 session 文件互不影响；
   - `clearSessionOverride(sessionId,'<roleId>','model')` → 字段从文件消失；
   - 传空 sessionId / 错误类型 → Host 返回 `gateway/input-invalid`；传非法 role/field →
     返回 `SESSION_GUI_INVALID_ROLE_ID` / `SESSION_GUI_INVALID_FIELD`。
5. 派单一次，确认派单读取到新值；检查 global/project 文件未被改动。
6. 停用/卸载插件（或 HMR 重载），确认 `meetingstone/getSessionConfig` 端点消失、无重复注册报错。

### 8.5 未验证 / 风险

- **真机未执行**：本任务只做代码、单测与步骤；strict 注册时序、zod 在真实 web 模块表的解析、
  `RemoteError` 回传、卸载注销均待 §8.4 确认。
- **Host `require(ESM)`**：桌面 Node 24 支持；本地 Node 20 单测通过注入真实
  `createTypertRemoteInfo` 覆盖。若宿主未来改为更严格 ESM 解析，`loadCreateTypertRemoteInfo`
  需改成异步加载（当前同步注册路径不支持 TLA）。
- **冷会话**：只有 live Session/Agent 能直接给出 cwd；未激活且无派单兜底的会话返回
  `SESSION_GUI_SESSION_ROOT_UNKNOWN`（不触发 resume 副作用）。若要覆盖冷会话，可后续接
  `ctx.sessionQuery.observeSession()`（异步、只读），需要把 resolver 改成 async。
- **结果 codec**：Host 结果虽为 strict，但未提供 `encode/decode`；Gateway 原样透传，
  Client 端 `result.mode:"src-json"`。这不影响参数校验，但结果不做结构裁剪。

## 9. U1a 客户端合规化（去 primitives + strict 只读面板）

> **已被 §10 取代（U2+U3）**：本节描述的是“只读面板”阶段；当前版本已在同一面板接入
> 三色二态开关与二级详情（会话写只写差异，全局写走 S2 global writer）。合规化结论
> （不 require primitives、priority 字符串、统一日志）仍然有效。

### 9.1 合规说明

| 项 | 之前 | U1a 之后 | 依据 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-primitives` | `require(...)` + `Tag`/`Icon` | **不 require**；本地 `Tag`（span + token）+ 16px 内联 SVG | `docs/gui-api-verification.md` §1/§5/§8；官方 `practices.md:35` |
| `Tag` 外观 | `primitives.Tag({tone})` | 逐条抄官方 `._tag_*[data-tone=...]` CSS（`--dsw-alias-border-l4`、`--dsw-alias-state-*`、`bg-module-platform`） | `index-lh_YM6sT.css`（tag 规则） |
| 顶部入口 | `<button>` 默认样式 + 文字回退 | 内联 users SVG + 文案「角色」；`border: 0.5px solid var(--dsw-alias-border-l3)`、toolbar fill/hover、`radius-sm`、focus ring token；保留 aria-label/title | 官方 `_button_1ulci_` / `_toolbar_` CSS |
| 侧栏 tab `priority` | 数字 `50` | 字符串 `'extension'` | `dsh-client-ui-sidebar-right/lib/client.js:4834-4846` |
| 诊断 | 只覆盖注册期 | 注册 + 渲染期统一 `[meetingstone] gui module=… phase=… version=…`（失败带 `error=`/`stack=`，不记凭证） | 本文件 §5.1 |
| 能力检测 | `sidebarRightTabs` 先检测 | 额外：调用 `getSessionConfig` 前检测服务/方法；缺失返回可解释错误 | — |

### 9.2 只读范围（本版边界）

- 侧栏面板**只调用** strict `getSessionConfig(sessionId)`，只投影
  `{ effective, overrides, sources }`：角色名/ID/别名/通道 + 来源层（全局/项目/会话）+
  是否有会话覆盖（覆盖字段名）。
- **不调用** `setSessionOverride` / `clearSessionOverride`，不写 `.meetingstone/sessions/*`。
- 失败（`ok:false` / 抛错 / 缺 sessionId / 服务未就绪 / `$mount` 失败）一律收口为
  `{ ok:false, error:{ code, message } }`：面板显示一行 `[code] message` 摘要，不抛、不空白。
- 没有输入框、下拉、保存、恢复继承等写控件；`renderRolePane` 的结构测试会断言这一点。

### 9.3 后续可写计划（门禁不变）

1. **真机验证先行**：按 §8.4 在隔离 profile 确认 `getSessionConfig` 的 strict 传输、来源层
   与覆盖字段与 Host 一致；确认面板打开不产生写副作用。
2. **只读面板稳定后**再评估字段级编辑：复用 `getSessionConfig` 的 `overrides` 渲染
   「恢复继承」与单字段编辑；写入仍只走 `setSessionOverride`/`clearSessionOverride`。
3. 写 UI 必须先过 P0-S0 门禁（真机 `$mount`、参数校验、卸载注销、A/B 会话隔离），
   并保持「只写差异」与「恢复继承」语义；在此之前不新增任何写控件。
4. 若真机确认 `sidebarRightTabs.open` 等入口方法名有变化，只调整 `openRolePanelOf`，不影响
   只读数据链路。

## 10. U2+U3 最终 UI（两区设置页 + 三色二态 + 二级详情）

### 10.1 设置页（`settings.section`）

只渲染两个区，顺序固定：

| 区 | 内容 | 不显示 |
| --- | --- | --- |
| 外部 CLI 连接 | Codex / CodeBuddy / Claude 三行，名称 + `button[role=switch]` | 版本、路径、额度、通道 ID、宿主行、徽章 |
| 默认角色配置 | 「取经五人组」+ 一句说明 + 角色数量 +「管理角色」 | 并发上限、同项目串行、全局调度、高级设置、通道实例、配置文件路径 |

开关语义（Host `src/gui/config-api.js` + `src/cli/preferences.js`）：

- **读**：`cliPreferences[cli]` 只有 `true/false` 是显式偏好；缺失 = `unset`。
  `unset` 且 preflight `ready` → 生效开关默认开（不写盘）。
- **关**：立即写 `false` 并持久化，不跑 preflight。
- **开**：Host 强制 `preflight.check(cli, { force:true })`；`ready !== 'ready'` 时
  **不写任何配置**（保持关闭），返回 `CLI_PREFERENCE_PREFLIGHT_FAILED`、
  `blockedReason` / `manualSteps` / `retryable`。客户端在该行显示一行摘要 + 人工步骤 +
  「重新检测」（`refreshCli(force=true)`），失败时 Switch 强制显示为关，**不做乐观假开启**。
- 不做自动修复：不安装、不登录、不改 PATH/ACL、不写宿主配置。

错误：首屏一行 `[code] message`（`nowrap + ellipsis`，全文在 `title`），详情按钮展开
时间/来源；无错误不渲染 alert、不占位。

### 10.2 角色列表（`sidebar.right.pane.tab`）

- 每行只有角色名（可点击，进入同栏详情）+ 三色二态 Switch；**不显示**模型、别名、通道细节。
- 三色来自 Host `deriveRoleView`（`src/gui/state-model.js`）：
  - 灰：`userPreference=disabled` 或 `readiness != ready`；
  - 黄：非 disabled + ready + `quota=exhausted`；
  - 绿：非 disabled + ready + quota 为 available/unknown/not_applicable。
  Switch 只有开/关两态，颜色只表达上述语义（不是自绘三态控件）。
- 阻断/额度原因：Switch `title` + 行下一行小字说明（`readinessReason` / `quota`），不展开细节。
- 列表开关只调用 `setSessionOverride(sessionId, roleId, 'enabled', next)`：
  - 写的是**当前会话**覆盖，不碰全局/项目；
  - 等值写入由 Host `diffRoleOverride` 归一为“删除覆盖”（恢复继承）；
  - 失败原样返回错误，不 reload、不改变列表状态；成功后才 reload。

### 10.3 二级详情（会话 / 全局两 scope 复用）

- 同栏切换（列表 ↔ 详情，`selectedRoleId` 局部 state）；不新造弹窗体系。
- 可编辑字段：名称、简称（逗号分隔）、描述、CLI/通道（`channel.channelId`）、模型、思考强度、
  角色 Prompt。
- **选项只列真实可用项**：全部来自 `cfg.channels`（经 `getSessionConfig` 的 `channels` 返回）。
  - 选中某个 `channelId` → 模型/强度只列该实例声明的值；
  - 未选 `channelId` → 列同 `kind/provider` 实例的值（去重）；
  - 没有真实选项 → 显示「不支持 · 当前通道没有配置模型/思考强度」，不伪造下拉项。
  - 切换 `channelId` 时同时对齐 `kind/provider/model/reasoning`（避免派单
    `CHANNEL_MISMATCH`）；无法对齐时提示「待配置」并拒绝保存。
- **字段来源**：`sources.roles[roleId].fields[<field>]` 投影为 全局/项目/会话/默认 Tag，
  逐字段展示。
- **恢复继承**：仅会话 scope 且该字段来源为 `session` 时出现「恢复继承」→
  `clearSessionOverride(sessionId, roleId, field)`。全局层没有“删除字段”语义，因此不提供
  伪造的全局恢复入口，只显示来源。
- **会话修改只写差异**：客户端把 draft 与生效角色逐字段比较，只对变化字段调用
  `setSessionOverride`；等值字段由 Host 再次 diff 并删除旧覆盖。任一步失败立即停止并显示
  一行错误摘要（已成功的字段不回滚，避免隐式写第二次）。
- **全局修改**：一次 `updateGlobalRole(roleId, patch)`（S2 global writer，profile patch
  保留未知字段）；保存前必须先点一次「保存修改」进入内联二次确认，再点「确认」。
  全局层不能清空 Prompt/名称，也不能“删除通道字段”，相关输入会返回明确错误。
- 会话新增角色（只在会话 `roles` 里、全局不存在的角色）：全局 scope 仍可查看字段来源，
  但写入会由 global writer 以 `GLOBAL_CONFIG_ROLE_NOT_FOUND` 拒绝，客户端显示该错误。

### 10.4 Remote 契约（7 个方法）

`src/gui/typert-spec.js` 的 `GUI_STRICT_METHODS`（Host 注册）与 client descriptor 逐字一致：

| 方法 | 参数（全部 strict，真实 zod） | 语义 |
| --- | --- | --- |
| `list` | 无参（SRC marker） | 全局只读快照 + CLI 状态 |
| `getSessionConfig` | `sessionId` | 三层生效角色 + overrides + sources + **channels + roleStates** |
| `setSessionOverride` | `sessionId/roleId/field/value` | 字段级会话覆盖（只写差异） |
| `clearSessionOverride` | `sessionId/roleId/field?` | 恢复单字段/整角色继承 |
| `setCliEnabled` | `cli/enabled` | CLI 开关（开前强制 preflight；失败不写） |
| `refreshCli` | `cli/force` | 只读重检（force 绕过 probe 缓存），不写配置 |
| `updateGlobalRole` | `roleId/patch` | S2 global writer 字段级写入 |

新增 typeSymbol：`#CliName`（`z.enum(['codex','codebuddy','claude'])`）、
`#BooleanValue`（`z.boolean()`）、`#JsonResult`（`z.unknown()`，写结果原样透传）。
`SessionConfigView` 的 strict result 增加可选的 `channels` / `roleStates`；旧 Host 不返回时
客户端按空数组处理（不伪造状态）。

### 10.5 测试与验证

```bash
node scripts/run-tests.mjs   # 551 项：0 fail
npm run verify               # exit 0（host-schema / manifest / package）
```

新增/更新的 stub：

- `tests/gui-u2-u3.test.mjs`：设置页两区、失败保持关、三色派生、会话只写差异、
  恢复继承、详情字段来源、真实选项/不支持、全局 patch 差异。
- `tests/gui.test.mjs`：7 个 descriptor、Host/Client typeSymbol 一致、两区渲染、
  CLI 失败行摘要/人工步骤/重检、角色列表无模型/别名、详情 input/select/textarea。
- `tests/session-gui-api.test.mjs`：`getSessionConfig` 透传 `channels` / `roleStates`，
  `roleState` 抛错只丢状态不影响继承视图。
- `tests/typert-contract.test.mjs` / `tests/gui-primitives.stub.test.mjs`：6 个 strict 端点 /
  7 个 descriptor，source 审计仍禁止 primitives。

### 10.6 限制与未验证项（如实登记）

- **真机未验证**：本任务未启动 DSH 桌面端、未改 profile、未重启；两区实际渲染、
  `button[role=switch]` 在宿主 webview 的外观、`select` 选项、`getSessionConfig` 新增
  `channels/roleStates` 的真实传输，都只做源码级 + stub 断言。真机要点：
  设置页只出现两区；关闭 Codex 后重启仍关；在未安装 CLI 上开启 → switch 回弹为关并出现
  人工步骤；角色列表三色与 Host 状态一致；开关后只改 `.meetingstone/sessions/<id>.json`；
  详情「恢复继承」后字段消失；全局保存出现二次确认。
- **全局层不能删除字段**：S2 global writer 是字段合并，没有 delete 语义，因此全局 scope
  不提供“恢复继承”；需要删除全局字段时只能手工编辑 profile。这是当前 API 的边界，不是 UI 遗漏。
- **模型/强度不是注册表**：只列 `cfg.channels` 已声明的值；同一 provider 的其他模型不会
  自动出现。新增模型仍需先在 profile 的 `channels` 中配置（V1 边界）。
- **会话保存不是事务**：多字段按顺序写；中途失败会保留已成功字段并显示错误，不回滚。
  若需要原子性，应在后续增加 Host 端“批量覆盖”方法（本期未新增）。
- **全局写仍受宿主覆盖限制**：profile 被 home patch/命令行 overlay 覆盖时返回
  `GLOBAL_CONFIG_OVERRIDDEN`，UI 显示一行错误，不做绕过。
- **三色中的额度仍是 unknown**：V1 没有可靠额度源，除按量付费 `not_applicable` 外不会
  出现黄色；黄色只在 Host 显式注入 `quota=exhausted` 时出现（测试覆盖）。
- **真机未验证 Remote 的 7 个 descriptor**：新增 3 个 strict 方法已过真实
  `ctx.typert.register()` 单测，但真实 Gateway 往返仍待隔离 profile 验证；若出现
  `has no strict codec`，按 §8.4 的日志定位。

## 11. B1 修复：设置页内联全局角色管理（2026-11-12，task-6）

> 对应 PDF 第 1 条。B0（`docs/plan/2026-11-12-b0-native-roles.md`）判 **no-go**：
> 原生 agent-preset 只服务 in-process、无「别名→CLI/模型/强度」路由层 → 继续用自建角色库。
> 本节只做**入口 + 视图**，不改角色编辑器字段（CLI→模型→强度联动归 B2/task-7）。

### 11.1 问题与根因

- 现象：设置页区 2「管理角色」点了之后跳到**会话级**右侧栏角色面板。
- 根因：`settings.section` 是 **root** slot（无 sessionId），旧实现 `openRoles`
  → `openRolePanelOf` → `sidebarRight.openTab(TAB_KIND, { params: {} })`，而 tab 注册在
  `sidebar.right.pane.tab`（**scope=session**，`inject(sessionId)`）；无 sessionId 时面板
  只能显示会话视角，语义与入口不符。
- 数据层并不缺：写路径 `updateGlobalRole` / `sanitizeRolePatch` 已就绪；
  缺的是 `roleView` 的 `description/prompt/source` 投影 + 设置页内联全局视图。

### 11.2 实现（入口 + 视图）

1. **Host `roleView` 扩字段**（`src/gui/host.js`）：新增
   `description`、`prompt`、`kind`、`sourceLayer`、`fieldSources`（键与
   `src/session/config.js` 的 `sources.roles[].fields` 一致；未知→`default`，不猜）。
   供设置页内联管理器读取/编辑，也供 B2 复用同一字段模型。
2. **Client `normalizeSnapshot`**（`src/client/index.js`）：保留上述字段 +
   `state`（三色派生）+ 嵌套 `channel`（`draftOfRole()` 直接可用）；`fieldSources` 按
   三层枚举收窄。
3. **设置页入口改为内联**：`settings.section` inject 删除 `openRoles`，新增
   `updateGlobalRole`（走既有 strict Remote，不新建写 API）；区 2「管理角色」按钮
   只切换本页 `managerOpen`，**不调用 `sidebarRight.openTab`、不离开设置页**。
4. **新增 `renderGlobalRoleManager`**：设置页内联列表 ↔ 全局详情（标题带「全局」标识；
   说明「写 profile、影响所有会话；会话覆盖请在右侧栏调整」）；保存复用
   `buildGlobalPatch` + `saveGlobalPatch`（二次确认，一次 patch 写入）。
5. **右侧栏只保留会话覆盖**：`SidebarRolePane` 移除 session/global scope 切换与
   global 写分支（`showScope:false`），列表开关与详情保存都只写当前会话差异。
   两个入口数据源不同：设置页 = 无参 `list()` 全局快照；右侧栏 = strict
   `getSessionConfig(sessionId)` 三层生效视图。

### 11.3 边界（不是遗漏）

- **B1 阶段只支持编辑现有全局角色**：create/delete 在 B1b（§12）补齐；
  `updateGlobalRole` 语义不变（只做 update，不存在的 roleId 返回
  `GLOBAL_CONFIG_ROLE_NOT_FOUND`）。
- 全局层仍不能「清空字段」：Prompt/名称留空视为无效输入（沿用 §10 边界）。
- 会话覆盖入口仍只在右侧栏；全局视图不再提供会话覆盖，反之亦然。

### 11.4 测试

- `tests/gui.test.mjs`：设置页 inject 形状（无 `openRoles`、有 `updateGlobalRole`）、
  内联管理器列表/详情渲染、**点击区 2 不产生 `openTab` 调用**、右侧栏无 scope 按钮。
- `tests/gui-u2-u3.test.mjs`：`renderGlobalRoleManager` 列表/详情/空态、
  `saveGlobalPatch` 一次写入 + 失败不 reload。
- 结果：GUI 相关 45 项全过；全量 `npm test` 554 项（+3，0 fail；并发任务改动带来的
  临时失败不属于本次改动）。

### 11.5 未验证项

- **真机渲染未验证**：未启动 DSH 桌面端、未改 profile、未重启；内联面板外观、
  `aria-expanded` 行为、`select` 选项与真实 `updateGlobalRole` 网关往返均只做
  stub/单测断言。
- **多角色列表滚动/长文本**：未做真机长列表验证。
- **B2 联动**：CLI→模型→强度联动、去「通道」措辞不在本节；字段模型已就绪，
  由 task-7 接手。

## 12. B1b：全局角色新增/删除（2026-11-12，task-14）

> 补齐 B1 的 create/delete 缺口（D1 验收需要）。仍是**同一** global writer /
> `configEditor.edit` 写路径；不新建队列/进程/写通道。B2 已把角色字段统一为
> `setting` + CLI→模型→强度组合，本节直接复用。

### 12.1 Remote 契约（7 → 9 descriptors）

`list`（无参 SRC）+ 8 个 strict：会话 3（`getSessionConfig` / `setSessionOverride` /
`clearSessionOverride`）+ 配置 5（`setCliEnabled` / `refreshCli` / `updateGlobalRole` /
**`createGlobalRole`** / **`deleteGlobalRole`**）。

| 方法 | 参数（strict） | 语义 |
| --- | --- | --- |
| `createGlobalRole` | `role`（JSON 对象） | 在 profile `roles` 追加一个全局角色；roleId 由客户端生成、Host 校验合法/唯一 |
| `deleteGlobalRole` | `roleId` | 从 profile `roles` 删除该全局角色；只删全局定义，不动会话覆盖记录 |

Host 侧新增两个 handler（`src/gui/host.js`），参数 codec 与 client descriptor 逐字一致；
`GUI_REMOTE_METHODS` / `GUI_STRICT_METHODS` 已同步（契约测试断言 8 个 strict 端点）。

### 12.2 新增（create）

- 设置页内联管理器列表底部「新增角色」→ 新建态（空 draft）；字段：名称 / 简称 /
  角色设定 / CLI → 模型 → 思考强度（选项来自真实 `channels`，复用 B2 capabilities）。
- **roleId 系统生成**：`role-<slug>`（小写 ASCII slug，截 32）；无可用 ASCII 时
  `role-custom`；与现有 id 冲突自动追加 `-2/-3…`。生成函数 `generateRoleId()` 为纯函数。
- 保存前二次确认（沿用全局写确认）；成功后重新拉 `list()`，切到该角色编辑态。
- 组合解析失败（无 CLI / 组合不存在 / 不一致）→ 返回与编辑保存一致的 `pendingConfig`，
  **不伪造 channel、不写盘**。

### 12.3 删除（delete）

- 编辑态底部「删除角色」→ 二次确认卡片：文案明确「只删 profile 全局定义；已有会话
  覆盖记录不会被改写（可能指向已删角色）」。
- 删除失败（`GLOBAL_CONFIG_ROLE_NOT_FOUND` / 写失败）→ 保持当前详情，**不刷新列表、
  不乐观删除**；错误落详情一行摘要。
- 成功 → 重新拉 `list()` 回到列表态。
- 不跨会话枚举/清理 `roleOverrides`（无该能力；设计上由会话侧自行恢复继承）。

### 12.4 错误码（沿用/新增）

`GLOBAL_CONFIG_INVALID_ROLE_ID`、`GLOBAL_CONFIG_INVALID_ROLE_PATCH`、
`GLOBAL_CONFIG_ROLE_NOT_FOUND`、**`GLOBAL_CONFIG_ROLE_EXISTS`**（新增，重复 roleId）、
以及既有 `GLOBAL_CONFIG_OVERRIDDEN` / `ENTRY_STALE` / `WRITE_FAILED` 等原样透传。

### 12.5 测试

- `npm test`：**572 tests / 571 pass / 0 fail / 1 skipped**。
- 新增用例：`generateRoleId`（slug/中文回退/冲突序号）、`buildCreateRolePayload`
  （名称必填、CLI 组合必填、不存在组合拒绝）、`saveCreateGlobalRole` /
  `saveDeleteGlobalRole`（一次写入 + reload；失败不 reload）、
  `renderGlobalRoleManager`（新增入口/新建态/删除二次确认）、global-writer
  create/delete（同一 edit 路径、重复/不存在错误码、失败不改配置）。
- 契约同步：descriptor 数量 7→9（`tests/gui.test.mjs`、`tests/gui-primitives.stub.test.mjs`、
  `scripts/smoke-client-inject.mjs`）；strict 端点 6→8（`tests/typert-contract.test.mjs`）。

### 12.6 未验证项

- **真机渲染/真实网关往返**：未启动 DSH 桌面端、未改 profile、未重启；新增/删除的
  二次确认、错误提示、下拉联动只做 stub/单测断言。
- 会话覆盖指向已删角色时的运行时表现（宿主读配置会报 `UNKNOWN_ROLE_ID` 告警）未真机验证。
