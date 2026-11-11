# GUI 只读配置页（0.2.0）

> **任务列表由原生 Jobs 提供，插件不自造 UI。** 派单成功后，宿主 `ctx.jobs` 可用时本插件会注册
> `meetingstone-dispatch` Job（角色 · 通道 · 任务摘要）；查看/停止任务使用宿主
> `@deepseek-ai/dsh-tool-jobs` 提供的能力与面板。本页面只负责角色/通道/错误的只读展示，不复制任务列表。

范围：**只读，接真实数据**。V1 精简为三个区，复用宿主 primitives / 主题 / i18n / a11y，
不新增 UI 体系：

1. **CLI 连接**：四平台自动检测（codex / codebuddy / claude，DSH 宿主本身不重复展示）、
   版本、状态；完整路径移入高级。
2. **默认协作配置**：全局角色库（只显角色数量 + 管理入口，不在此做编辑器——编辑器在对话
   顶部入口已实现）、全局默认角色（一个设置项）、全局并发上限、同项目写任务串行、全局调度
   补充规则（可读文本）。
3. **高级设置（默认折叠）**：默认隔离方式、CLI 完整路径、通道模型映射、配置文件与诊断日志、
   打开配置文件入口。

删除 / 移出主页面：**默认模型区域整体删除**（模型 / 思考强度属于角色定义）；通道模型列表
移入高级；项目配置文件路径展示删除（自动识别）；重复的默认角色配置项合并；「最近错误：无」
不占位，有错误时显示一条可点击看详情的警告。

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
  2. `await ctx.remote.$mount(contribution)` 安装 `remote.meetingstone`；
  3. 注册唯一一个 `settings.section`（`id:"meetingstone"`, `order:100`），并通过
     slot 的 `inject` 把 `{ list, openRoles }` 传给组件（`openRoles` 打开右侧栏会话角色面板）；
  4. `list()` 调 `ctx.remote.meetingstone.list()`，失败即抛错；成功后用
     `normalizeSnapshot()` 收窄形状。
- 组件渲染 V1 三区（CLI 连接 / 默认协作配置 / 高级设置），高级区默认折叠。除协作区的
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
   - **CLI 连接**：codex / codebuddy / claude 的检测状态（已安装/未安装）+ 版本，无完整路径；
   - **默认协作配置**：角色数量 + 「管理角色」入口、全局默认角色、并行写上限、同项目串行、
     调度补充规则（只读文本）；
   - **高级设置（默认折叠）**：展开后见默认隔离、CLI 完整路径、通道模型映射、配置文件入口。
   可用性标签来自 `ctx.subagents.getProvider`。有错误时顶部一条可点击警告，无错误不占位。
   控制台应出现 `[meetingstone] loaded …`；若出现
   `[meetingstone] GUI remote unavailable: TYPERT_UNAVAILABLE`，说明宿主未解析到
   `@deepseek-ai/dsh-typert-protocol`，页面会显示读取失败而不是假数据。

## 5. V1 UI：对话顶部入口 + 右侧栏会话角色编辑（决策 2/3/4/5/6）

在 0.2.0 只读页之外，本次新增「会话级角色覆盖」入口与编辑面板，复用同一套官方 slot 注册
与 Typert Remote，不新建 UI 体系、不做 DOM/CSS 注入。

### 5.1 顶部集合石入口（header action）

- slot：`conversation.session.header.actions`（`kind:list, scope:session`）。
- 注册形状（对齐官方 header-actions 约定）：
  `{ name, id, order, locale, inject(sessionId) }`，组件渲染一个图标按钮
  （宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 `Icon`，缺失时回退文字）。
- 点击 → `ctx.sidebarRightTabs.open(TAB_ID)` 打开右侧栏 tab（见 5.2）。
- tooltip / aria 走宿主 locale（`settings.meetingstone` 命名空间），新增 key：
  `headerTitle` / `headerDesc` / `openPanel`。
- 代码：`src/client/index.js` 的 `registerHeaderAction()`，在 `ctx.inject([REMOTE_INJECT])`
  回调内注册（与 `settings.section` 同一就绪子 ctx）。

### 5.2 右侧栏 tab（两步式）

不能直接注册 rightbar，按官方两步：

1. `ctx.sidebarRightTabs.register({ id, kind, priority, title })` 注册 tab 本体
   （`src/client/index.js` 的 `registerSidebarTab()`）。
2. 注册两个 keyed seat（scope session，id 与 tab 对齐）：
   - `sidebar.right.pane.tab` → 面板内容组件 `SidebarRolePane`
   - `sidebar.right.pane.tab.title` → 标题组件 `SidebarRoleTitle`

### 5.3 面板内容：当前会话角色覆盖编辑

`SidebarRolePane` 通过新 remote 方法拉取并写回当前会话的角色覆盖：

- 角色列表来自全局角色库（经 `getSessionConfig` 的 `effective.roles`，即 global→project→
  session 合并后的生效表）。
- 每个角色可覆盖字段（白名单）：
  `alias`（别名）、`description`（描述）、`provider`（CLI/provider）、`model`（模型）、
  `reasoning`（思考强度）。别名字段统一记作 `aliases`；通道字段写成 `channel.<key>`。
- 每个字段显示「继承 / 覆盖」状态（`sources.roles[roleId].fields['channel.model']`
  等来自 `resolveEffectiveConfig` 的字段级来源）。
- 修改即写入会话覆盖（`setSessionOverride`），**只存差异**；等于继承值时自动删除旧覆盖
  （= 恢复继承）。每个字段有「恢复继承」按钮（`clearSessionOverride`）。

### 5.4 Host 远程方法（复用 src/session 继承模型）

`src/gui/host.js` 的 `registerGuiRemote` 在 `meetingstone` 命名空间下新增 3 个方法
（`deps.session` 为 `createSessionGuiApi`，见 `src/gui/session.js`）：

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `getSessionConfig(sessionId)` | sessionId | `{ effective, overrides, sources }` |
| `setSessionOverride(sessionId, roleId, field, value)` | 见上 | store 写盘结果（written/patch/errors） |
| `clearSessionOverride(sessionId, roleId, field)` | field 缺省=整角色 | store 写盘结果（removed） |

- 校验白名单，坏输入返回明确错误码（见 `src/gui/session.js` 的 `SESSION_GUI_ERRORS`）：
  `SESSION_GUI_SESSION_ROOT_UNKNOWN` / `INVALID_SESSION_ID` / `INVALID_ROLE_ID` /
  `INVALID_FIELD`。`sessionId`/`roleId`/`field` 任一非法即拒绝，不静默生效。
- `getSessionConfig` 只接受一个 `sessionId`，但 host 需要项目根才能定位
  `.meetingstone/sessions/<sessionId>.json`。项目根来自 `index.js` 在每次派单/工具执行时
  记录的 `sessionRoots` 映射（sessionId→cwd）；若找不到则返回 `SESSION_ROOT_UNKNOWN`。

### 5.5 继承语义（与 src/session/config.js 一致）

- 会话层**只影响当前 Session**：存储按 sessionId 分文件（store.js），解析时只传入当前会话覆盖。
- 只写差异：值等于继承值时不写入；恢复字段用 `clearSessionOverride`。
- 字段级来源（`sources`）在 `resolveEffectiveConfig` 中逐项标注，面板据此显示「继承/覆盖」。

### 5.6 验证

```bash
node scripts/run-tests.mjs            # 含 tests/gui.test.mjs（header/tab/seat/remote 注册）
                                      # + tests/session-gui-api.test.mjs（get/set/clear/继承）
```

`tests/session-gui-api.test.mjs`（Node 级真相测试）：直接驱动 `createSessionGuiApi` 验证
get/set/clear 的继承语义、只写差异、恢复继承、session 隔离、白名单校验与错误码。
`tests/gui.test.mjs` 的 stub harness 扩展覆盖：header 注册形状与点击打开右侧栏、右侧栏两步式
注册、两个 keyed seat、以及 pane 通过 `remote.meetingstone` 的 get/set/clear 调用。

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
  `ctx.sidebarRightTabs.open(TAB_ID)` 的打开语义，均只做了源码级对齐 + stub harness 结构断言，
  未做真机渲染确认。
- **`sidebarRightTabs.open` 方法名未核实**：打开右侧栏用的是 `open(id)`（参考官方右侧栏 API 命名），
  真机若实际为 `activate`/`show`/`select` 等，需在 `registerHeaderAction` 内调整。
- **会话方法 contribution 的 `parameters` 写的是 `[]`**：与 `list` 一致按最小 descriptor 手写，
  未经 `typert.remotes.register()` 对带参方法的 codec 校验；真机若要求参数描述符，需补
  `parameters` 形状（本仓库无生成器，属未验证项）。
- **`sessionRoots` 依赖派单/工具先触发**：右侧栏远程方法只有 sessionId、没有 cwd，靠 `index.js`
  在 `resolveRegistry(exec)` 时记录 sessionId→项目根。若用户**未在该会话内触发过任何派单/工具**
  就打开面板，host 找不到项目根，返回 `SESSION_GUI_SESSION_ROOT_UNKNOWN`；真机需确认该映射时机。
- **面板为只读渲染 + 覆盖写入**：字段编辑走 `setSessionOverride`/`clearSessionOverride` 的
  差异写盘，未做乐观更新与写入失败重试（store 写失败会在 `errors` 中返回，面板保持原值）。
