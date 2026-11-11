# GUI 最小骨架（0.2.0）

范围：**只读**。只保留三段——角色列表（名称 + 别名 + 是否可用）、通道列表（channelId + kind）、
最近错误（无则显示「无」）。不做搜索 / 筛选 / 排序 / 操作按钮 / 编辑 / 任务控制 / 图表 / 动画。
遵循宿主设计：用宿主 UI 组件（`@deepseek-ai/dsh-client-ui-primitives` 的 `Tag`）与主题 token
（`var(--dsw-alias-label-*)`）、官方间距/字号（gap 12/10px、13px/20px、max-width 760px），
不自带 CSS 框架、不自造色板。

## 1. 调研结论（证据）

证据均取自本机 `C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
（DSH `0.2.2-rc.1`），用 `scripts/asar-extract.mjs` 同款方式抽取内部文件。内部路径前缀统一为
`dsh/node_modules/@deepseek-ai/`。

| 问题 | 结论 | 证据（app.asar 内） |
| --- | --- | --- |
| `dsh.client` 声明 | `package.json` 里 `dsh.client = { platform: "web", inject: [...] }`。`inject` 列的**是插件包**（本 half 依赖的宿主包），不是服务名 | `dsh-client-ui-settings-plugins/package.json:29-37` |
| 入口形式 | `exports["./client"]` 指向一个**普通脚本**，脚本体是 `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ... exports.apply / exports.inject ... } })`（lazy-CJS factory）。`factory` 内 `require()` 解析的是宿主共享模块（`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等）；`id` 必须等于包名 | `dsh-client-ui-settings-plugins/lib/client.js:1-6,269-273`、`.../package.json:16-24` |
| 发现机制 | client module system 扫描 enabled Loader 行里**声明了 `dsh.client`**、且 specifier 是**裸包名的根行**的包，serve 其 `./client` 导出 | `docs/audit/02-plugin-spec.md` §4.3(b)；结构旁证 `dsh-cliworker-now` |
| Host half | 只需一个空 `apply()` 占位，让包在 cordis.yml/Loader 里有一行；section 由 browser half 拥有 | `dsh-client-ui-settings-plugins/lib/index.js:1-13` |
| 设置页 section 注册 | `settings.section` 是 `dsh-client-ui-settings-general` 声明的 root list slot（`kind:"list", scope:"root"`）。贡献方式：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id, order, label, locale }, Component))`；服务 `inject = ["slots","locale"]` | `dsh-client-ui-settings-general/lib/client.js:1547-1550,1587-1597`；`dsh-client-ui-settings-plugins/lib/client.js:210,255-266` |
| 自动表单能不能蹭 | **不能**。全树扫描 8 个 `autoGenerate` 命中全在 API/Settings 服务层，没有任何客户端消费；`ctx.settings.configure({auto})` 只是页面策略。故必须自带 browser half | `docs/audit/07-config-extension.md` §3.6；`dsh-client-ui-settings/lib/index.js:14-18` |
| 怎么拿宿主侧数据 | 浏览器 half 通过 `ctx.remote.<face>` 的**生成式 RPC** 取 Host 数据，并把 `remote` / `remote.<name>` 写进 `inject`。例：`ctx.remote.pluginInventory.list()`；`dsh-client-ui-settings/lib/client.js:1261` 注释要求「每个调用方在自己的 inject 里声明 `remote.settings`」 | `dsh-client-ui-settings-plugin-inventory/lib/client.js:965-989`；`dsh-client-ui-settings/lib/client.js:1261` |
| 只读展示用什么组件 | 官方只读列表用 `@deepseek-ai/dsh-client-ui-primitives`：`Tag({ tone, children })`、`StateDot({ state })`、`SettingsForm`/`SettingsValueField`。该包在 asar 内**无物理目录**，是 loader 别名提供的共享模块 | `dsh-client-ui-settings-plugin-inventory/lib/client.js:266,277-280`；`dsh-client-ui-settings-shell/lib/client.js:173-210` |

补充：本仓库现有工具（`meetingstone_list_roles` 等）是 `ctx.tools` 的**模型工具**，不是浏览器 remote；
Host 侧 `roles` / `channels` / `errors` 在 `src/index.js` 的 registry / cfg / projectStore 里。
浏览器 half 既读不到 `.meetingstone.json`，也没有现成 remote face → 本次按任务允许用**占位数据**。

## 2. 注册方式（本次落地）

- `package.json`：新增 `dsh.client`（`platform:"web"`，`inject` = locale + ui-settings，对齐官方
  settings-plugins）与 `exports["./client"] = "./src/client/index.js"`。
- `files` 不改：client 放在 `src/` 下，随现有 `files:["src"]` 一起打包（`verify-package` 已覆盖）。
- `cordis.patch.yml` 不改：已有 `- id: meetingstone / name: dsh-meetingstone` 是裸包名根行，
  正是 client half 的挂载条件。
- `src/client/index.js`：一个 lazy-CJS factory，`apply()` 里注册**唯一**一个
  `settings.section`（`id:"meetingstone"`, `order:100`），组件 `Section` 只渲染三段列表；
  可用性用宿主 `Tag`，颜色用宿主 `--dsw-alias-label-*` token。

## 3. 数据来源

- **现在**：`src/client/index.js` 内的 `SNAPSHOT` 常量，形状对齐
  `registry.list()`（name/aliases/available）、`cfg.channels`（channelId/kind）、
  `registry.errors`（空 → 显示「无」）。页面顶部明确标注「占位数据」，不冒充真实状态。
- **接真实数据（后续）**：在 Host 侧声明一个 remote face（参考 `dsh-api-remotes` +
  `ctx.remote.*` 的生成式 RPC），把 `meetingstone_list_roles` / channel / errors 的结果投影给
  浏览器 half；client 的 `inject` 增列 `remote`、`remote.<name>`，用 `useX` hook 订阅快照替换
  `SNAPSHOT`。这属于 0.2.0 之后的接线，本骨架不做。

## 4. 验证步骤

```bash
node scripts/run-tests.mjs
node scripts/verify-manifest.mjs
node scripts/verify-package.mjs
```

外加一次本地一致性自检（stub 掉 `window.__ModuleLoader__` / `require` / `ctx.slots`，
确认 factory 能执行、`settings.section` 被注册、三段列表能渲染且错误为「无」）——
这是**结构级**校验，不是真机渲染，命令见交付说明。

### 真机加载步骤（需操作者手动执行，本任务未执行、未改 profile）

1. 用**隔离/临时 profile**（不要动默认 `desktop`）：把本仓库作为 bundle 安装，
   例如 `"…\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile <tmp> add <本地绝对目录>`，
   或桌面端 Plugin Manager 安装 configuration-only bundle。
2. 确认 Loader 行 `- id: meetingstone` 处于 enabled（`cordis.patch.yml` 已提供）。
3. 重启 DSH / 等 HMR，让 client module system 为裸包名根行 serve `./client`。
4. 打开 Settings（外壳由 `dsh-client-ui-settings-general` 提供）→ 侧栏「集合石」section。
5. 预期看到：5 行角色（名称/别名/可用标签）、5 行通道（channelId/kind）、「最近错误：无」，
   以及顶部「占位数据」说明；无任何可点控件。

## 5. 未验证项（如实登记）

- **真机 GUI 未验证**：本环境无法启动 DSH 桌面端，未做截图级确认；`settings.section`
  是否真实出现、`Section` 收到的 `t` / `renderSlot` props、`Tag` 与主题 token 的实际渲染都
  未经真机复核。源码级形状已对齐官方 `settings-plugins` / `inventory`。
- **lazy-CJS factory 字节契约**：官方 `lib/client.js` 是 tsdown `clientBundle` 构建产物，
  `docs/audit/02-plugin-spec.md` U4 标注该构建 preset 不在发布包内、仓库外需自行复现；
  本次手写 factory 是否与宿主加载器**完全**兼容，只能靠上面的真机步骤确认。
- **`dsh.client.inject` 对第三方包的解析**：仅有结构级旁证（官方包 + `dsh-cliworker-now`），
  未验证第三方包声明这些 inject 时模块系统是否按挂载体处理。
- **数据为占位**：Host remote face 未实现，`./client` 未接 `ctx.remote.*`；真实角色/通道/错误
  接入属后续工作。
- **既有 flaky 测试**：`tests/parallel.test.mjs` 的「真实并行：两任务时间重叠」在全量并发下
  偶发失败（两任务区间恰好相切），单跑 3/3 通过；与本次改动无关。
