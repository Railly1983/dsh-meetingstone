# GUI 只读配置页（0.2.0）

> **任务列表由原生 Jobs 提供，插件不自造 UI。** 派单成功后，宿主 `ctx.jobs` 可用时本插件会注册
> `meetingstone-dispatch` Job（`角色简称 · 简短目标`，见 §7）；查看/停止任务使用宿主
> `@deepseek-ai/dsh-tool-jobs` 提供的能力与面板。本页面只负责角色/通道/错误的只读展示，不复制任务列表。

范围：**只读，接真实数据**。V1 精简为三个区，复用宿主 primitives / 主题 / i18n / a11y，
不新增 UI 体系：

1. **CLI 连接**：紧凑一行一个，名称 + 版本 + 状态；区分宿主（DeepSeek Harness）与外部
   CLI（codex / codebuddy / claude）；完整路径移入高级。
2. **默认协作配置**：角色数量 + 默认角色 + 管理入口合并在同一行（左右对齐），全局并发上限、
   同项目写任务串行、全局调度补充规则（可读文本）。
3. **高级设置（默认收起）**：默认隔离方式、CLI 完整路径、通道实例、配置文件与诊断日志、
   打开配置文件入口。

删除 / 移出主页面：**默认模型区域整体删除**（模型 / 思考强度属于角色定义）；通道实例列表
移入高级；项目配置文件路径展示删除（自动识别）；重复的默认角色配置项合并；错误首屏只显示
一行摘要，详情默认折叠，无错误不占位。

不做搜索 / 筛选 / 排序 / 操作按钮 / 编辑 / 任务控制 / 图表 / 动画（除协作区的「管理角色」
入口按钮，点击打开既有右侧栏会话角色面板）。遵循宿主设计：用宿主 UI 组件
（`@deepseek-ai/dsh-client-ui-primitives` 的 `Tag`）与主题 token（`var(--dsw-alias-label-*)`）、
官方间距/字号（gap 12/10px、13px/20px、max-width 760px），不自带 CSS 框架、不自造色板。

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
| 只读展示组件 | 官方只读列表用 `@deepseek-ai/dsh-client-ui-primitives`：`Tag({ tone, children })`。`tone` 取值见官方映射 `neutral / warning / info / danger`。该包在 asar 内**无物理目录**，是 loader 别名提供的共享模块 | `dsh-client-ui-settings-plugin-inventory/lib/client.js:266-281` |

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
  「读取宿主数据失败」+ 错误信息，**不伪造数据**。

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
5. 预期看到 V1 三区：
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

在 0.2.0 只读页之外，本版提供「会话角色」入口与只读面板，复用同一套官方 slot 注册
与无参 `list()` 数据，不新建 UI 体系、不做 DOM/CSS 注入。

### 5.1 顶部集合石入口（header action，稳定性优先）

- slot：`conversation.session.header.actions`（`kind:list, scope:session`）。
- 注册形状（对齐官方约定）：`{ name, id, order, locale, inject(sessionId) }`；组件渲染
  图标按钮（宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 `Icon`，缺失时回退文字）。
- **注册顺序固定为 header → section → sidebar**，每段独立 guard。header 的注册**不依赖**
  `$mount` 成功：挂载失败时仍注册，`inject` 返回 `remoteReady:false`，按钮 tooltip 与
  点击提示均为「远程不可用」，入口不会消失。
- 点击（remote 就绪）→ `ctx.sidebarRight.openTab(TAB_KIND, { params: {} })` 打开右侧栏 tab。
- 注册失败统一日志格式：
  `[meetingstone] gui module=<module> phase=<phase> version=<v> error=… stack=…`；
  成功为同格式 `status=ok`。一段失败不影响其他段；日志不记录凭证。

### 5.2 右侧栏 tab（两步式）

1. `ctx.sidebarRightTabs.register({ id, kind, priority, title })` 注册 tab 本体
   （能力检测：服务不存在时跳过 tab 本体，但仍注册 seat）。
2. 注册两个 keyed seat（scope session，id 与 tab 对齐）：
   - `sidebar.right.pane.tab` → 面板内容 `SidebarRolePane`
   - `sidebar.right.pane.tab.title` → 标题 `SidebarRoleTitle`

### 5.3 面板内容：只读角色列表

- 数据只来自无参 `ctx.remote.meetingstone.list()`（全局角色库快照）；不改写、不写盘。
- 每个角色渲染：角色名、别名、可用性 Tag、通道（`channelId · provider · model`）。
- 顶部固定说明：**当前版本只读（展示全局角色库）；会话级覆盖编辑待宿主生成式 Remote 支持**。
- 没有输入框 / 保存 / 恢复继承等写操作；角色为空或 remote 不可用时显示可读说明。

### 5.4 Host 远程方法：只有无参 `list`

`src/gui/host.js` 只注册 `meetingstone/list`，**三个带参会话方法已移除**。

真机错误（2026-11-11）：
`client api: generated Remote meetingstone/getSessionConfig field "sessionId" has no strict codec`。
宿主 Gateway 要求参数使用 strict codec（zod `typeSymbol` + `create()`）；手写 host 没有类型
符号，无法伪造；`src-json` 参数也被 `requireStrictInputs` 拒绝。**不要试图绕过。**

`src/gui/session.js`、`src/session/config.js`、`src/session/store.js` 的纯逻辑与单测保留
（派单时的会话配置解析仍在用），但**暂不接入客户端**，等宿主提供生成式 Remote 后再接。

### 5.5 验证

```bash
node scripts/run-tests.mjs            # gui.test.mjs（注册顺序 / descriptor=1 / 只读面板 / 日志）
node scripts/smoke-client-inject.mjs  # 真实 Cordis：mount 失败仍注册 header
```

`tests/gui.test.mjs` 覆盖：descriptor 只剩 `list`；header 最先注册且 `$mount` 失败不消失；
pane 只读渲染且无 input/保存控件；错误摘要默认折叠；单模块注册失败不影响其他模块；
统一日志格式与「日志不含凭证」断言。`tests/session-gui-api.test.mjs` 仍直接测试
`createSessionGuiApi` 的继承语义（该能力当前不接入 GUI）。

## 6. 限制与未验证项（如实登记）

- **真机 GUI 未验证**：本环境无法启动 DSH 桌面端，未做截图级确认。`settings.section` 是否
  真实出现、`Tag`/主题 token 的实际渲染、`ctx.remote.$mount` 与宿主 Gateway 的真实传输，
  都只做了源码级对齐 + stub harness。
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
  注册（`sidebarRightTabs.register` + `sidebar.right.pane.tab` / `.title` seat）、`Icon` 渲染、
  `ctx.sidebarRight.openTab(TAB_KIND, …)` 的打开语义，均只做了源码级对齐 + stub harness 结构断言，
  未做真机渲染确认。本次修复的「header 不消失」需在真机重启后再确认一次。
- **`sidebarRightTabs.open` 方法名未核实**：打开右侧栏用的是 `ctx.sidebarRight.openTab(kind, …)`；
  真机若实际为其他方法名，需在 `openRolePanelOf` 内调整（入口本身仍存在，不会因此消失）。
- **带参会话 Remote 已移除（真机硬错误）**：`meetingstone/getSessionConfig` 被 Gateway 以
  `has no strict codec` 拒绝；strict codec 需要 zod 类型符号，手写 host 无法伪造，
  `src-json` 参数也被 `requireStrictInputs` 拒绝。**不要试图绕过**。会话级覆盖编辑等宿主
  生成式 Remote（typert generator）支持后再接；`src/gui/session.js` 与 `src/session/*` 的
  纯逻辑/单测保留，但客户端不可调用。
- **面板为纯只读**：右侧栏只渲染 `list()` 快照，不写盘、无乐观更新；会话级覆盖写入当前
  没有 UI 入口。
- **`sessionRoots` 仍只服务派单解析**：`index.js` 在 `resolveRegistry(exec)` 记录
  sessionId→项目根，用于读取 `.meetingstone/sessions/<sessionId>.json`；与会话编辑 GUI 无关
  （该 GUI 已暂不接入）。


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
