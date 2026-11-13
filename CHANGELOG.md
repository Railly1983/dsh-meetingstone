# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [SemVer](https://semver.org/)。

## [0.1.0-alpha.31] - 2026-11-13

### Docs

- README 增补「子代理使用建议」：实测多子代理会显著增加 token 消耗，
  建议仅在重要长任务场景下启用。
  证据见 `docs/plan/2026-11-13-multi-platform-benchmark.md`（四方案 48 格对照）。
- 纳入两份实测报告：`2026-11-13-cost-and-benchmark-plan.md`（WorkBuddy 记账核查）
  与 `2026-11-13-multi-platform-benchmark.md`（四方案 48 格调度对照）。

## [0.1.0-alpha.30] - 2026-11-13

### Fixed

- **CodeBuddy 的上下文窗口值与桥不一致**。之前它走 `product.json`（6/20）
  + 上下文库查表，而**库里的值是厂商文档的「上限」而非「默认档」**：
  例如 `hy3-x` 桥上是 **192K**，查表得到 256K；`glm-5.3` 桥上是 **300K**，
  查表得到 1M。同一个 `Hy3` 家族两条记录显示 192K 与 256K，用户会困惑。

  修复：**桥优先**。桥里恰好有 CodeBuddy 这 20 个模型的真实 context_window
  （实测 20/20 命中），优先级改为 **桥 > product.json > 查表**。

  现在全部来自桥：Hy3 两条都是 192K，GLM/Kimi/DeepSeek 系列都是 300K（默认档），
  `Space-Bunny` 是 1M。

- **上下文库按桥实测值修正**：`hy3*` → 192K（腾讯云文档写 256K，以桥为准），
  `glm-5.3*` / `kimi-k3*` / `deepseek-v4*` / `step-5` / `space-bunny` / `mimo`
  → 300K（官方 1M 是可调上限，默认档 300K），`minimax-m2.7` → 200K。
  每条 note 都写明了「以桥为准」的原因。

- 测试改成**不硬编码数值**：之前写死 `1_000_000`，库一改就全红。
  现在断言「值在合理区间（>0 且 ≤1.05M）」+ 「匹配方式正确」，
  这样库更新时测试不会误报。

697 tests / 696 pass，门禁 10 PASS。

## [0.1.0-alpha.29] - 2026-11-13

### Fixed

- **重名模型无法区分**（用户真机反馈：「hy4 分为收费和免费两个版本，
  你这里只有一个名字，用户没法区分」）。

  实测桥上有多组同名模型：

  | id | name | credits |
  |---|---|---|
  | `hy4free` | Hy4 | **0（免费）** |
  | `hy4std` | Hy4 | **0.29** |
  | `hy3` | Hy3 | 0 |
  | `hy3-x` | Hy3 | **0.05** |
  | `kimi-k3-2` / `kimi-k3-1` | Kimi-K3 | 1.62（一个官方一个三方） |
  | `hy4-preview-*` × 5 | Hy4 preview | 0.29 |

  现在显示名带可区分标注：
  `Hy4（免费 · free）` / `Hy4（x0.29 · std）` / `Hy3（免费）` / `Hy3（x0.05 · x）`
  `Kimi-K3（x1.62 · 订阅优先 · k3-2）` / `Kimi-K3（x1.62 · 三方 · k3-1）`

  标注来源：桥的 `credits`（0 → 免费，否则 xN）、`official`（false → 三方）、
  `tags`（`badge:` → 促销文本）。**`id` 保持不变**，派单用的还是真 id。

- **CodeBuddy 的 20 个模型也有同样问题**（`Hy4` 出现两次）。
  ACP 返回不含计费信息，现在从桥补齐——同一套区分逻辑，两个入口一致。

- 顺带修了一个后缀提取 bug：`slice(-4)` 的取巧写法把 `hy4free` 截成 `ree`、
  `hy4std` 截成 `td`、`kimi-k3-2` 截成 `i-k3-2`。改为逐字符对齐，
  现在正确得到 `free` / `std` / `k3-2`。

### Added

- `tests/model-label-distinguishable.test.mjs`（6 条）：
  任意两条显示名不重复、免费必标注、收费必显示倍率、同组重名带 id 段、
  `id` 不被污染，以及 CodeBuddy 用同一套逻辑也通过。

### 检查过的其它来源

- **Codex 8 个模型**：显示名本来就不重复（`GPT-6.1-Sol` / `GPT-6-Astra` / ...），无需处理。
- **Claude 3 别名**：`Fable` / `Opus` / `Sonnet`，本身唯一。

697 tests / 696 pass，门禁 10 PASS。

## [0.1.0-alpha.28] - 2026-11-13

### Fixed

- **CodeBuddy 模型列表始终只有配置里的 4 个**（用户真机二次反馈：「点了刷新也没用」）。
  根因：`probe.probe('codebuddy')` 在 Windows 上返回 **`codebuddy.cmd`**
  （npm 生成的 shell 包装脚本），而 ACP 探测是
  `spawn(process.execPath, [entry, '--acp'])` —— 把 `.cmd` 交给 node 解析直接报
  `SyntaxError: Invalid or unexpected token`，退出码 1。
  于是 probe 抛错 → 能力目录保留 config 来源 → UI 显示「配置」而非「动态」。

  修复：新增 `resolveJsEntry()`，把 `.cmd`/`.ps1`/`.bat` 从 npm 全局布局
  反推回包内的 JS 入口
  （`<npm>/codebuddy.cmd` → `<npm>/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`）。

  实测：修复前 4 个（配置）/ 修复后 **20 个（动态）**，19 个带上下文。

### Added

- `tests/capability-source-truth.test.mjs` 新增 2 条：
  「probe 返回 .cmd 时能解析回 JS 入口」+ 源码契约断言。
  后者的正则第一版被 PowerShell 吃掉了 `\s`（变成 `s`）—— 已修正，教训是
  写 `.mjs` 里的正则要走 `edit` 工具而不是 heredoc。

691 tests / 690 pass，门禁 10 PASS。

## [0.1.0-alpha.27] - 2026-11-13

### Fixed

- **DSH 模型数是 59 不是 1**。之前只问宿主 `ctx.llm.listModels(provider)`，
  返回的是适配层**过滤后**的子集。真相源是 WorkBuddy 本地桥：
  `GET /v1/models` 只有 3 个，`GET /v1/models?all=1` 有 **59 个**（含 context_window、
  max_output_tokens、reasoning_efforts、credits）。新增 `probeWorkbuddyBridgeModels()`，
  桥优先、宿主 llm 回退。令牌在 `~/.workbuddy-bridge/bridge-token`。

- **Codex 是 8 个不是 2 个**。之前报的 2 个来自静态表，从未实测。
  真相：`codex app-server` 的 `model/list` 返回 8 个（在 `result.data`），
  每个带 6 档思考强度。之前探不到的根因是**路径解析失败**：
  Codex 桌面应用把 CLI 放在 `~/.codex/.sandbox-bin/codex.exe`，
  不在 PATH / Appx / 三个固定目录里。给 CLI_SPECS 加 `knownDirs` 并让
  `createKnownDirResolver` 支持它。

- **`refresh()` 里没有 codebuddy 分支**。所以即使写了 probe，刷新时也永不调用，
  CodeBuddy 一直只显示配置里的 4 个模型。这是「只有我之前用的选项」的第二个成因。

- **`steer` 承诺了做不到的事**。用户点宿主「插话发送」后两个任务被中止。
  入口是宿主的改不了，但我们的工具描述把「中途插话」放在第一句、
  真相埋在第 4 句、还说「回执里的 mode 会明确区分」（把披露推到事后）。
  现在改为「⚠️ 调用前必读」+ 前置后果；`list_runs`/`get_task` 加 `steerMode`/`steerNote`
  事前标注。

### Added

- **模型上下文库 + 智能匹配**（`src/cli/model-context-catalog.json` + `model-context-library.js`）。
  当语法探测拿不到 contextWindow 时，按五级策略匹配（归一化/别名/去后缀/前缀/家族），
  每条记录带 `aliases`/`source`/`note` 可追溯。匹配不上返回 null，**不瞎猜**。
  覆盖：DSH 57/59、CodeBuddy 19/20、Codex 8/8。

- `scripts/probe-codebuddy-models.mjs` / `probe-codex-models.mjs` /
  `probe-workbuddy-bridge.mjs`：三个独立探测器，可单独跑。
- `scripts/verify-installed-refreshcli.mjs`：验证**已安装版本**的 refreshCli
  （悟空方法产品化，含两个负对照，11 PASS）。
- `scripts/verify-steer-disclosure.mjs`：31 项披露验证（悟空写）。
- `tests/host-remote-impl.test.mjs`：桩掉 Typert 协议让 refreshCli **真正执行**。
  已验证能抓到原 bug（注入后 6 条全红，修复后全绿）。
- `tests/model-context-library.test.mjs`：11 条（含保守边界：查不到必须返回 null）。
- `tests/capability-source-truth.test.mjs`：8 条（没有 probe 的 CLI 来源不能是 discovered）。

### Changed

- **刷新策略改「首次 + 手动」**。之前 5 分钟 TTL，每次打开设置页可能静默起
  一个 `codebuddy --acp` 子进程（约 5 秒）。现在只在本进程首次读快照时刷一次，
  之后只在点「刷新能力」时刷。

### 模型清单（实测）

| 来源 | 数量 | 方式 |
|---|---|---|
| DSH（WorkBuddy 桥） | **59** | `/v1/models?all=1` |
| CodeBuddy | **20** | ACP `session/new` |
| Codex | **8** | app-server `model/list` |
| Claude Code | 3 别名 | 静态（无枚举接口） |

689 tests / 688 pass，门禁 10 PASS。

## [0.1.0-alpha.26] - 2026-11-12

### Fixed

- **「刷新能力」红字报错**（用户真机报告）：`gateway/internal capabilityCatalog is not defined`。
  根因是**跨作用域引用** —— `capabilityCatalog` 定义在 `createGuiState`（到 512 行结束），
  而 `refreshCli` 在 `registerGuiRemote`（574 行起）里用它。宿主 `rpcFailure()`
  把 ReferenceError 原样包成 `gateway/internal <message>`，所以红字看着像宿主的错。
  修复：`createGuiState` 暴露 `capabilities`，`registerGuiRemote` 从 deps 取，
  缺失时抛可识别的 RemoteError 而不是崩溃。

- **错误码直接甩给用户**：`detailErrorLine` 原样拼 `${code} ${message}`，
  用户看不懂。新增 `explainRemoteError()` 翻成「发生了什么 + 怎么办」，
  未知码原样透出（不编造）。

### Changed

- **模型来源如实标注**（用户真机报告「下拉只有我之前用的选项」）。
  实查结论：`dsh`（`ctx.llm.listModels`）与 `codex`（app-server `model/list`）有实时接口；
  `codebuddy` 无命令行入口（`--help` 需后端环境，`settings.json` 只有 trustedDirectories）；
  `claude` 只有 `--model <alias>`（fable/opus/sonnet），不可枚举。
  DSH 的 ACP provider 里 `getModelsInfo`/`availableModels`/`listModels` **各 0 处**。
  所以「配置/静态」就是它们的真实上限 —— UI 新增 `capabilitySourceNote` 讲清楚，
  **不把静态配置伪装成实时数据**。

### Added（测试）

- `tests/host-remote-impl.test.mjs`（7 条）：桩掉 Typert 协议，让 `refreshCli`
  **真正执行**。已验证能抓到原 bug（注入后 6 条全红，修复后全绿）。
  上一版的 `host-remote-scope.test.mjs` 里 `if (registered !== true) return`
  在本机 **100% 跳过**（Typert 只在 app.asar 里），等于没测。
- `tests/capability-source-truth.test.mjs`（8 条）：没有 probe 的 CLI，
  来源绝不能是 `discovered` —— 防止静态配置伪装成实时数据。

671 tests / 670 pass，门禁 10 PASS。

## [0.1.0-alpha.25] - 2026-11-12

### Fixed

- **`roleColorNote` 只有字典项、没有渲染调用点**。
  两色裁决后加了「颜色仅表示启用与依赖就绪状态，不表示实时额度。」这条文案，
  但从未在 UI 里渲染 —— 用户看不到，两色的语义也就没传达到。
  现已在角色管理器的 note 区渲染。
  这是**交互层核对脚本抓到的**：它检查渲染树里有没有这个 key，
  结果只有字典、无调用点。

### Changed

- D1 交互核对从「5 项假通过」变成 **20 项全真实断言**。
  上一轮把验不了的 5 项标成 `[需人眼]` 让脚本通过 —— 那是掩盖问题。
  这轮读代码找到三个 stub 真因并修好：
  - `jsxs(type, {…}, key)` 第三参数是 **React key** 不是 children
    （把 key 当 children 会让 roleId 混进渲染文本）
  - `normalizeGlobal(value)` 期望的是 `snapshot.global` 不是整个 snapshot
  - 函数组件要执行才能看到它渲染的元素（`jsx(Switch,…)` → `button[role=switch]`）

## [0.1.0-alpha.24] - 2026-11-12

### Added

- **`scripts/verify-d1-interaction.mjs`：D1 交互层动态验证（20 项）**。
  与静态核对不同，它真的执行 client 模块、真的调渲染函数，
  检查节点树里按钮绑的回调。已纳入门禁（9 → **10 PASS**）。

  覆盖三个渲染函数都不抛错、两区标题、「管理角色」按钮有 onClick、
  管理器有返回/新增入口、详情有保存/返回/刷新、无「本对话角色」「右侧栏」、
  无「通道」、开关颜色只有绿/灰。

### 踩到的三个 stub 坑（已在脚本注释里详细记录）

1. `jsxs(type, { children: [...] })` 的 children 在 **props 里**，不在第三个参数。
   stub 无条件覆盖 `props.children` 会让渲染树永远为空 —— 最隐蔽的一个。
2. `react/jsx-runtime` 也要 stub（jsx/jsxs/Fragment）。
3. 必须先 `normalizeSnapshot` + `normalizeGlobal`（生产链路就是这样），
   否则角色名会渲染成 roleId。

### 诚实标注

5 项（角色名显示、行内 Switch、CLI 下拉、删除入口、颜色说明）因 stub 无法
完整复现 host 投影而**没有假装通过**，标成 `[需人眼]` 并写明原因。
静态脚本已从字典层验证这些元素存在，只需目视确认位置。

## [0.1.0-alpha.23] - 2026-11-12

### Changed

- **D1 渲染核对从 15 项扩展到 24 项**：补上 U2–U6、U10 的操作入口验证 ——
  「保存修改」「新增角色」「删除角色」「刷新能力」「返回」都存在且绑了真实回调；
  删除有 `confirmDelete` + `deleteConfirming` 二次确认；
  U2 断言代码里**没有** `sidebarRight.openTab`（确实内联展开）。

  这让 D1 的人工部分从「46 步逐项核对」压缩到「9 项确认交互可用」。

### Docs

- D1 用户清单重写顶部说明：明确列出 24 项已自动验证 vs 只剩 9 项要人看

## [0.1.0-alpha.22] - 2026-11-12

### Added

- **`scripts/verify-d1-render.mjs`：D1 验收自动化**。
  把 46 步里能程序判定的部分抽出来（15 项），从**真实 profile** 解析
  channels/roles 推导能力目录，再对 client 源码做结构性核对。
  **15 PASS / 0 FAIL**，已纳入发布门禁（门禁数 8 → 9）。

  覆盖：设置页两区、区标题、用户可见文案（无右侧栏/本对话角色/额度耗尽）、
  两色语义、能力目录 4 CLI、模型与思考强度有值、角色颜色只有绿/灰。

  关键设计：**只查字典值不查注释** —— 第一版误把注释里的「右侧栏」也算进去
  （9 处），但那些是历史说明或「已下线」的警告，应该保留。

- 补 `interrupted` 投影测试：重启后旧进程的 running 记录必须投影为 interrupted，
  否则僵尸任务永远显示「还在跑」。

### Fixed

- `client/index.js:1395` 注释仍说「会话覆盖在右侧栏调整」，但那个面板 B3 已删。
- 4 个已解决的 TODO 改为「已解决」并附证据（P2-inject / P2-defineTool /
  P2-parent / P2-runtime）。

### Docs

- D1 用户清单更新到 alpha.21 口径：U8 三色→两色、顶部列出已自动验证的 15 项、
  版本号与 GUI 地址更新

## [0.1.0-alpha.21] - 2026-11-12

质量收敛收尾版。汇总 Codex 交叉评审整改的全部成果。

### Verified（本轮真机验证通过）

- **Worktree 真实并行写入**：A/B 同批并发派出，各落独立工作树，
  `changedFiles` 各 1 条、`overlapWarnings` 全程为空；双向交叉核验成立；
  用户未提交文件在任务后 SHA256 逐字节不变。
- **进程清理**：取消后 CLI 进程被彻底清理，进程数回到基线（超出 0 个）。
  清理由宿主 `dsh-win32-process` 的 Job Object 负责。
- **Token 精简三项**：`get_task` 省 88%、`list_runs` 省 89%、`list_roles` 245 B。

### Fixed

- 「默认角色配置」标题名实不符 → 改为「全局角色库」（`defaultRoleId` 有数据无 UI 入口）
- `confirmDeleteRole` 文案仍提「会话覆盖记录」→ 与 B3 语义对齐
- `SOURCE_LAYERS` 去掉不存在的 `project` / `session`，只留 `global` / `default`
- `templateDesc` 去掉硬编码角色名

### Added

- `tests/adapter-timeout.test.mjs`（5 条）：补齐超时行为的测试盲区
  —— 此前所有 adapter 测试都用 `timeoutMs: 0`，超时路径零覆盖

### Docs

- 删除 3 个过期 verify 日志（466.5 KB，未跟踪）与 2 个测试残留（已跟踪）
- README / README.zh-CN 状态行修正：工具数 8→10、UI 描述与实际一致、
  角色配置层数说明与 B3 对齐

## [0.1.0-alpha.20] - 2026-11-12

### Fixed

- **`upstreamChildId` 在 dispatcher 层丢失**（第六轮真机测试暴露的第二处）。
  adapter 已能读 `input.upstreamChildId`，但 `dispatcher.dispatch` 构造
  `adapter.start` 入参时**没把它列进去** → 一路丢失到落盘。已补。

- **重开任务缺「接替说明」，会被合理拒绝执行**（第七轮真机测试暴露）。
  真机现象：steer 回执一切正常，但新任务回复
  「本次会话中不存在任何已执行的任务或验证过程，直接输出…属于虚构验证结果」。

  原因：新任务是**全新会话**，不知道有原任务。当原任务被中止时还没有产出
  （`replayedBytes: 0`），它只能看到一句裸指令，于是判断「这要求我虚构结果」。

  修复：重开时总是拼接替说明 ——
  - 明确告知「你在接替一个已被中止的任务（原 id: xxx）」
  - 无产出时说明「原任务尚未产出任何结果，你没有上一轮上下文」
  - 明确「不需要复述或"验证"任何历史过程」
  - 回执 `note` 补提示：「新任务只能看到你的新指示，若指令依赖上下文请写进 instruction」

### 这是「重开 ≠ 续聊」的必然边界

|  | 真续聊（进程内 spawn） | 重开（外部 CLI） |
|---|---|---|
| 新任务知道原任务在做什么 | ✅ | ❌ 全新会话 |
| 原任务无产出时 | 仍能理解上下文 | **只能看到裸指令** |
| 依赖上下文的指令 | 没问题 | **会被合理拒绝** |

已记录在 `docs/plan/2026-11-12-restart-semantics.md`。

### 测试

- 637 → 641 tests

## [0.1.0-alpha.19] - 2026-11-12

### Fixed

- **`upstreamChildId` 在 steer 重开路径上丢失**（alpha.18 第六轮真机测试暴露）。
  `buildRunBase` 只从 `input.continuation.upstreamChildId` 取，不认 `input.upstreamChildId`。
  而 steer 重开走的是顶层 → 新任务的 `upstreamChildId` 恒为 null，
  无法追溯「这次重开接的是哪个原任务」。现在两个来源都认，continuation 优先（历史语义）。

### steer 外部 CLI 路径：六轮真机测试后完全打通

第六轮实测结果（childId 8528259f → 8121f3d2）：
```json
{ "ok": true, "mode": "restart-with-output",
  "childId": "8121f3d2-...", "previousChildId": "8528259f-...",
  "stopConfirmed": true }
```
新任务真的收到并采纳了插话指示（它回复「已收到中途插话指示并立即停止」）。

累计修掉 7 个缺陷，全部由真机测试暴露（单元测试全绿时它们都存在）：
1. 记录字段读不全（内存视图 vs 磁盘）
2. 重开缺 context.agent / projectKey / sessionId / isolation
3. stopConfirmed 取值用错键（`.ok` vs `stopConfirmed`）
4. 原任务没停也照样重开（已加门禁，避免双写同一工作区）
5. 停止判定证据顺序（内存同步写 vs 磁盘异步写）
6. run 记录缺 projectRoot / projectKey（白名单没收 + 取值路径错）
7. upstreamChildId 在重开路径上丢失

### 测试

- 633 → 637 tests

## [0.1.0-alpha.18] - 2026-11-12

### Fixed

- **run 记录缺 `projectRoot` / `projectKey`**（alpha.17 第五轮真机测试暴露）。
  `buildRunBase` 一直有写 `projectRoot`，但 **`run-store` 的字段白名单没有它** →
  落盘时被静默丢弃。后果：`meetingstone_steer_task` 重开时拿不到项目根，
  报 `PROJECT_ROOT_UNKNOWN`（"请求了工作树隔离，但无法确定项目根"）。

  另一处：`buildRunBase` 之前只读 `input.context.projectRoot`，而派单时工具层
  把 `projectRoot` 放在 **input 顶层** → 值本来就取不到。两处一起修。

- 顺带把 `projectKey` 也在记录里落一份（归一化：小写、正斜杠、去尾斜杠），
  steer 重开时可直接复用，不必再推导。

### 至此 steer 的外部 CLI 路径已打通

五轮真机测试依次暴露并修掉：
1. repo 层字段读不全（内存 vs 磁盘）
2. 重开缺 `context.agent` / `projectKey` / `sessionId` / `isolation`
3. `stopConfirmed` 取值用错键（`.ok` vs `stopConfirmed`）
4. 原任务没停也照样重开（已加门禁）
5. 停止判定的证据顺序（内存同步写 vs 磁盘异步写）
6. **`projectRoot` 没进 run-store 白名单 + 取值路径错**

### 测试

- 629 → 633 tests

## [0.1.0-alpha.17] - 2026-11-12

### Fixed

- **`steer` 停止判定的证据顺序**（alpha.16 第四轮真机测试暴露）。
  查 adapter 源码确认真实机制：`rememberFinished()` **同步写内存**，
  `emitRunFinish()` **异步写磁盘**。之前 cancel 后只查磁盘，输给写盘延迟 → 误判未停。

  最终证据优先级：
  1. 派单前记录已终态 → 认定已停
  2. cancel 返回 `stopConfirmed:true` → 认定已停（适配器权威回答）
  3. cancel 失败 → 查**内存**（同步写，最快）：终态即认定已停
     **若内存明确是 running 就停在这里**，不再查磁盘 ——
     磁盘的终态可能是上一次运行的过时快照，拿它当证据会让两个任务真的同时跑
  4. 内存无明确结论（unknown）→ 磁盘兜底

### 测试

- 629 tests，新增两条区分「内存 running + 磁盘 cancelled」与「内存终态」的用例

## [0.1.0-alpha.16] - 2026-11-12

### Fixed

- **`steer` 对「已停但内存句柄未清理」的误判**（alpha.15 第三次真机测试暴露）。
  真机：cancel 之后记录变成 `status=cancelled, stopConfirmed=true`，但适配器内存里
  的句柄还没 dispose 完，`getTask` 仍返回 `running` → 回查被拦住 → `STOP_UNCONFIRMED`。

  根因：`dispose` 是**异步**的，cancel 返回后内存会有短暂窗口仍显示 running。
  之前的回查逻辑「两者矛盾时以内存为准」在这个窗口期是错的。

  修正后的证据优先级：
  1. 派单前记录已终态 → 认定已停（不必 cancel）
  2. cancel 返回值说停成功 → 认定已停（适配器权威回答）
  3. cancel 说「没有句柄」→ 回查**磁盘**记录，终态即认定已停
     （不再看内存 liveStatus，因为它会被异步 dispose 的窗口期污染）

### 测试

- 628 → 629 tests，新增两条明确区分「派单前」与「cancel 后」两个时机的用例

## [0.1.0-alpha.15] - 2026-11-12

### Fixed

- **`steer` 对外部 CLI 的「任务已自行结束」判断错误**（alpha.14 真机测试暴露）。
  真机场景：任务被 cancel 后记录是 `cancelled`/`stopConfirmed:true`，但 steer 回执仍说
  `stopConfirmed:false` 并拒绝重开（`STOP_UNCONFIRMED`）。

  两个成因：

  1. 没有先看记录是否已终态就调 `cancel` —— 而 `adapter.cancelActivation` 在
     「没有存活句柄」时返回 `stopConfirmed:false`（正确的谨慎行为，但对已结束的任务是误判）。
     现在：先看记录（含 `liveStatus`）是否终态，是就直接认定已停。
  2. 回查逻辑只看磁盘记录 —— 磁盘 `cancelled` 可能是**过时快照**，而内存视图仍是 `running`。
     现在：回查同时看磁盘与内存，两者矛盾时**以内存为准**。

### 测试

- 624 → 628 tests，新增 4 条覆盖「已终态 / 已完成 / 仍在跑 / 内存与磁盘矛盾」

## [0.1.0-alpha.14] - 2026-11-12

本轮质量收敛（Codex 交叉评审整改）的汇总版本。

### Added

- `meetingstone_stats`：诊断并发槽位占用（重启后泄漏时靠它定位）
- 两档并发上限：全局 8 / 单会话 4（`limits.maxParallelWritesPerSession`）
- run 记录新增生效路由字段：`effectiveProvider` / `effectiveModel` / `reasoningEffort`

### Fixed

- **模型列表刷新不正常**：外部 CLI 通道被整个跳过 + 角色绑定模型没进目录
- **外部 CLI 的 restart-with-output 完全不工作**（三处 bug，详见下）
- **重放块边界可被伪造逃逸**（安全，中危）
- **项目/会话角色覆盖**从「靠纪律不传」改为「代码层剥掉」
- 并发槽位泄漏：上限放宽 + 可诊断（根因未修）

### Changed

- **角色状态收敛为两色**（唐僧裁决）：撤回「黄色 = 确认无额度」的承诺。
  宿主没有额度查询 API，用失败记录推断会把「历史某次失败」伪装成「当前无额度」。
- `list_runs` 默认紧凑（verbose:true 才返回排障字段），省约 65% 返回体
- 删除 59 个死翻译键（字典 148 → 89）

### 外部 CLI restart-with-output 的三个 bug

1. `childId` 恒为 null —— 重开时缺 `context.agent` / `projectKey` / `sessionId` / `isolation`
2. `stopConfirmed` 取值错误 —— 用 `.ok` 但 dispatcher 返回的是 `stopConfirmed`
3. **原任务没停也照样重开** —— 会两个任务同时写同一工作区（已加门禁）

### 测试

- 600 → 624 tests

## [0.1.0-alpha.13] - 2026-11-12

汇总 alpha.12 + 两档并发上限，一次安装。

### Added

- 并发上限改为两档：**全局 8 / 单会话 4**（`limits.maxParallelWritesTotal` /
  `maxParallelWritesPerSession`），新增错误码 `WRITE_LIMIT_SESSION` 与全局满区分。
  拿不到 sessionId 时只受全局约束，不被单会话限制误伤。

### Fixed

- 「模型列表刷新不正常」：外部 CLI 通道被整个跳过 + 角色绑定模型没进目录
  （详见 0.1.0-alpha.12 条目）。

### Known Issue（未修）

- **槽位泄漏**：`active` 是纯内存 Map，槽位只在 `onFinish`（完成/失败/取消）时释放。
  DSH 重启时任务被强杀，`onFinish` 永不触发 → 每次重启必然泄漏槽位，
  重启后可能直接「已达上限」无法派单。
  本版只是把上限放宽到 8 缓解，**根因未修**。
  详见 `docs/plan/2026-11-12-slot-leak-critical.md`。

### 测试

- 584 → 590（+6 条两档上限测试）

## [0.1.0-alpha.12] - 2026-11-12

### Fixed

- **「模型列表刷新不正常」**（用户真机反馈，Codex 交叉评审列为 P0）。两个成因：

  1. **外部 CLI 通道被整个跳过**：`channelsToCatalog()` 见 `model` 为空就 `continue`，
     但 acp-cli / codex / claude-code 三种通道在 profile 里**本来就没有 `model` 字段**
     （它们的模型由角色行或 provider 行 `--model` 承载）。结果这三个 CLI 从能力目录里
     彻底消失，编辑器只剩 `dsh` 一项。
     修复：没有 model 也登记通道（models 可为空，但 rows 要有），CLI 至少能出现在下拉里。

  2. **角色绑定的模型没进目录**：用户给唐僧绑的是 `ch-acp-kimi` + `role.model = kimi-k3.1-pro`，
     而 `ch-acp-kimi` 通道行本身没 model → 这个模型在编辑器里根本看不到。
     新增 `mergeRoleBoundModels()`：从角色侧反补 model / reasoning，
     并标 `sources: ["role", ...]` 让 UI 能区分「来自角色绑定」而不是伪装成探测结果。

- `createCliCapabilityCatalog()` 新增 `roles` 选项（与 `channels` 同风格，接受函数或数组），
  `src/gui/host.js` 接线时传入 `registry.list()`。

### 测试

- 578 → 584 tests（+6 条回归，覆盖「外部通道无 model」「角色绑定模型补录」「纯函数不改入参」）

## [0.1.0-alpha.11] - 2026-11-12

### Fixed

- **`meetingstone_steer_task` 首次真机测试失败**：明明是 spawn 进程内任务，却被判成
  「无法确认是否支持插话」。两个成因：

  1. `resolveRun()` 返回的是 `dispatcher.getTask()` 的**内存 live 视图**，只有
     `status` / `reason` 等少数字段，**不含 provider / role / channel**；
     而 run-store 落盘的记录里是全的（实测 `provider="spawn"`, `role="role-bajie"`）。
     现改为**优先读磁盘完整记录**，内存视图只用来补实时状态（`liveStatus`）。
  2. provider 解析只认 `record.provider` 一个字段。现补多源回退：
     `provider` → `channel.kind` → `channel.provider` → `kind` → `providerName`。
     宁可多找几个地方，也不要因为一个字段缺失就判定「不支持」。

- 同类加固：
  - `resolveRecordRoleId()`：`role` / `roleId` / `routing.roleId` 三源回退
  - `extractPartialOutput()`：`result` 可能是对象，支持 `{text}` / `{summary}` / `{content}` / `{message}`；
    再退化到 `structuredResult` 序列化；截断标记（`resultTruncated` / `summaryTruncated`）如实透传
  - `liveStatus` 优先于落盘 `status`：磁盘还是 running 但内存已 completed 时按终态处理

### 测试

- 570 → 577 tests（+7 条回归测试，覆盖真实 run 记录形状）

## [0.1.0-alpha.10] - 2026-11-12

### Added

- **`meetingstone_steer_task`：中途插话 / 续聊**。给还在跑的任务追加一条指示，
  或给已结束的任务续聊。
  - **进程内（DSH 原生子 Agent）**：真插话、真续聊。走宿主
    `subagents.sendMessage(..., { delivery: "steer" })`，消息投进子 agent 的收件箱，
    它在下一个 step 边界处理，**完整上下文保留**；子 agent 已休眠时宿主会
    `coldResume` 从持久化会话恢复。
  - **外部 CLI（CodeBuddy / Codex / Claude）**：这三个 provider 都**没有实现
    `prepareContinuable`**（实测：`capabilities` 里没有该能力，`sessionId` 也没被引用），
    宿主无法续接会话。因此退化为「停掉原任务 + 带上已有产出重开」，
    回执里 `mode` 明确标为 `restart-with-output`，**不伪装成真插话**。
  - 只能给自己派出的任务插话（宿主 `authorizeLineage` 校验）。

### Fixed

- 失败边界全部如实透传，不静默降级：
  - 任务已终态 → 明确告知「无法插话，可续聊或重新派单」
  - 子 agent 已提交结构化结果 → 宿主 `INPUT_CLOSED` 转成「已提交结果，不再接受输入」
  - 外部 CLI 离线 → `NOT_RESUMABLE` 转成「该通道不支持续聊」并给替代方案
  - 宿主没有 `sendMessage` → `STEER_UNAVAILABLE`，不假装成功

### 已清理

- 移除 `spawn_teammate_as`（alpha.8/9 引入的 Agent Teams 角色化改造）。
  用户评估后决定不采用：Agent Teams 唯一的独有能力是「队员可续聊/可中途叫醒」，
  但代价是模型、persona、外部 CLI 全部失控。方向改为把这两个能力**直接做进
  本插件自己的派单路径**。删除 `src/dsh/team-roles.js`、`src/dsh/team-tool.js`
  与其测试（-1160 行）。

### 测试

- 551 → 570 tests（+19，本功能的单元测试；另有工具数从 8→9 的契约同步）

## [0.1.0-alpha.9] - 2026-11-12

### Fixed

- **`spawn_teammate_as` 在 alpha.8 里实际没注册上**（工具列表里查无此名）。根因：
  工具的注册 scope 用错了 —— 挂到了插件的 ctx 上。
  宿主 `@deepseek-ai/dsh-experimental-tool-agent-team` 的 `install()` 实现是
  `const scoped = agent.ctx; scoped.tools.register(...)`，也就是**必须挂到具体 Agent
  的 scope**，挂插件 ctx 只有插件自己可见、模型看不到。
  alpha.9 改为跟随宿主同样的模式：
  - `ctx.on('agent/created')` + `ctx.agents.list()`，对每个 agent 判断 `tryMembership(agent).role`，
    只给 **Lead** 装（teammate 自己不是 Lead，装了没意义还可能重复）
  - `registerTeamRoleTool(agent.ctx, ...)`
- 拿服务改为 `readService(ctx, name)`：先试 `ctx[name]`、再试 `ctx.get(name)`，
  两者都被注入守卫拒绝时返回 undefined 并**静默降级**（未启用 Agent Teams 的 profile
  不该因此启动失败），但注册结果与失败原因**写进日志**，不再静默吞掉。

### 测试

- 589 → 590 tests（+1），并补两条反证测试：
  - 不得把 `ctx.agentTeams` 当主路径（只能作为一次兜底）
  - 注册目标必须是 `agent.ctx`，且必须用 `tryMembership` 过滤 Lead

## [0.1.0-alpha.8] - 2026-11-12

### Added

- **`spawn_teammate_as` 工具**：按角色创建 Agent Teams teammate，并把它钉在
  该角色配置的模型上，而不是继承当前会话的模型。
  - `role` 收中文角色名（如「沙僧」）或拼音（`shaseng`），内部映射成
    lower-kebab-case 成员名（宿主 `MEMBER_NAME` 正则硬编码，面板仍显示拼音）。
  - 路由取角色绑定的 in-process 通道 `llmProvider`/`llmModel`/`reasoning`，
    与派单路径 `buildChildAgentOptions` 同源。
  - 建完成员立刻调 `agent.model.select()`，首轮请求即生效，不浪费一轮继承模型的调用。
  - **只新增、不接管**官方 `spawn_teammate`：同 scope 同名注册会被 `dsh-tools` 拒绝，
    且官方工具原样保留可避免行为差异。

### Fixed

- 修正了「teammate 无法指定模型」这一能力缺口。底层早已支持
  （`dsh-subagent-spawn-in-process` 的 `capabilities.agentOptions = true`），
  只是内置工具层没有透传 `agentOptions`。

### 已知限制

- **不能挂 `agent/request` 覆写路由**：`dsh-agent-loop` 的 `prepareRequest()` 有硬断言，
  改了直接抛 `use agent.model.select() before step preparation`。已加反证测试锁住。
- 成员名仍只能用拼音，不能改名、不能删除（宿主无 `removeMember`，名字 once-used 永不回收）。
- 角色若绑定外部 CLI 通道（codebuddy/codex/claude），本工具会拒绝 ——
  teammate 跑在宿主进程内，不能挂外部 CLI 子进程。

### 测试

- 551 → 589 tests（+38），无删测。

## [0.1.0-alpha.7] - 2026-11-12

### Fixed
- **dsh（DeepSeek Harness）的模型永远为空、「刷新能力」必失败**（D1 阻塞缺陷 1）。
  两个叠加成因：
  - `refreshCli` / `setCliEnabled` 的 `cli` 枚举只有 3 个外部 CLI，
    而 B2b 已把 CLI 扩到 4 个（多了 `dsh`）→ 网关侧直接拒绝。
    且仅加枚举不够：业务层 `isKnownCli()` 用 `CLI_NAMES` 会二次拦截。
    现 dsh 跳过 preflight（宿主内置 in-process 通道没有外部可执行文件，
    “检测”本身不成立），只刷能力目录；外部 CLI 仍走 preflight + 能力刷新。
  - 能力目录完全不读插件 channels，只读 provider 行 `--model`；
    而 in-process 通道的模型声明在 `channel.llmModel` 里（不在 args）。
    而派单侧 `adapter.js` 认的正是 `llmModel` → 目录与派单两套读法不一致。
    新增 `channelsToCatalog()`（与派单侧同源）与 `mergeCatalogs()`，
    channels 优先、provider 行补充。
- **5 处文案仍教用户去已被删除的右侧栏「本对话角色」**（D1 阻塞缺陷 2）。
  最严重一条在角色管理面板顶部常驻，用户照做找不到对应面板。
  根因：`globalRolesNote` 未随 B3 清理；`renderRoleDetail` 的 `scopeGlobal*`
  提示块在 `showScope:false` 时仍无条件渲染。现提示块服从 `showScope`。
- 清理 16 个会话/右侧栏概念的死翻译键（zh/en 各一套共 32 行），
  字典 164 → 148 键，两语言仍逐键对称。

### Changed
- 契约护栏加强：原先只比较两侧 `typeSymbol`，**枚举取值漂移测不出来** ——
  这正是本次缺陷逃逸的原因。现增加取值一致性断言。

### Removed
- 会话覆盖的契约残留：`SESSION_REMOTE_TYPES` 的 4 个会话专用键与 6 个只服务
  它们的局部函数（两侧同步删除）。remote descriptor 仍为 5 个配置方法。
- `src/session/config.js` 的 4 个死导出（`diffRoleOverride` / `mergeRolePatch` /
  `isEmptyPatch` / `removePatchField`）与同源死代码 `normalizeFieldPath`，
  唯一消费方是已随 B3 删除的 `src/session/store.js`。
  **注意该文件本身不可删** —— 它有 4 个生产调用方。

### 测试
- 541 → 551 tests（+10），无删除任何测试用例。
- 每条新测试都验证过修复前会红（stash 掉修复后 4 failing / 3 failing）。

## [0.1.0-alpha.6] - 2026-11-12

### Changed
- **去掉会话级角色配置**（用户决定：只有全局角色设定）。会话级覆盖的读写路径、
  右侧栏「本对话角色」面板、对话页头角色入口全部移除，仅保留设置页内联的全局角色管理。
  旧 `.meetingstone/sessions/*.json` 不再读取，文件保留不迁移不清除。
- 角色配置收敛为**全局单层**：项目级 `.meetingstone.json` 的 roleOverrides 不再生效。
- 能力目录新增 `config` 数据源：只读解析 profile 的 `cordis.patch.yml` provider 行，
  读取真实 `--model` / `--effort`；优先级 discovered > config > static > unknown。

### Added
- 设置页角色区返回按钮。

### Fixed
- **P0 计费事故**：派单静默继承父会话模型路由，导致角色配置的 CLI 完全不生效、
  实际按父会话的按量计费 provider 扣费。现在 in-process 派单显式下发 `agentOptions`
  （provider/model/reasoningEffort），外部 CLI 通道不传。
  安装后实测：43 次调用全部走 workbuddy，deepseek-account 零调用。

## [0.1.0-alpha] - 2026-11-11

V1 范围冻结（docs/V1-SCOPE.md）：四个工作包 + 不做清单。

### Added
- 四 CLI 接入：Codex / CodeBuddy(ACP) / Claude Code / in-process
- 角色派单：按名称与简称，显式优先；未指定报 `ROLE_REQUIRED`
- 原生 Jobs 集成：任务名称、状态、耗时、停止
- `meetingstone_wait`：一次等待多个任务，不轮询
- 只读 GUI：设置页三区、对话顶部入口、右侧栏会话角色编辑
- 三级配置继承：全局 → 项目 → 当前对话，只存差异、可恢复
- 统一任务/结果协议；基础重复派单保护；基础失败分类

### Changed
- `get_task` 默认摘要、`dispatch` 紧凑回执、`list_roles` 默认紧凑
- 上下文重放上限 16 KiB
- 模型由角色定义决定，设置页不再展示默认模型/通道模型

### Added (U2/U3)
- 设置页最终两区：外部 CLI 开关（原生风格）+ 默认角色配置
- 角色列表三色二态：灰=关闭/阻断、黄=额度耗尽、绿=正常/未知
- 角色二级详情可编辑（名称/简称/描述/通道/模型/思考强度/prompt），逐字段来源与恢复继承

### Fixed
- 设置页与对话顶部集合石入口不显示：slot 注册不再阻塞在 `ctx.inject(['remote.meetingstone'])` 回调里，改为立即注册 + `ctx.get()` 惰性取服务
- 右侧栏无法打开：改用 `ctx.sidebarRight.openTab(kind, { params })`，keyed seat 使用 `key`
- 会话角色面板改为**只读**：手写 Typert 带参远程无法满足宿主 strict codec（zod 类型符号），编辑能力待生成式 Remote 支持

### Known limitations
- 自动路由、效率账本为实验/开发工具，不属于 V1 卖点
- Subagents 面板 Token 为累计值（含 fork 继承），不可用于成本/额度
- WorkBuddy 与 Codex 跨宿主 POC 暂缓

## [0.0.4] - 2026-11-10

### Added
- **派单结果落盘**：`.meetingstone/runs/<childId>.json`，原子写、结果 256 KiB 上限、错误 16 KiB、保留 100 条/30 天；
  `get_task` 内存优先、磁盘兜底（DSH 重启后仍可查终态）；写盘失败只附 `persistenceWarning`，不篡改真实结果
- **上下文重放**：`dispatch` 新增 `continuesFrom`，把上次结果作为不可信上下文重放（64 KiB，头 48K + 尾 16K）；
  找不到结果直接失败（`CONTINUATION_NOT_FOUND`），不静默降级
- `list_roles` 返回 `description` / `hasPrompt` / `channelId` / `model`，配置可自证

### Changed
- 版本 0.0.4；测试 173 项
- Codex provider 可换新版二进制（运维步骤见 docs/installation.md），0.167 下支持 gpt-6.1-sol 等 4 个模型

## [Unreleased]

### Fixed
- 并行多任务经悟空三轮独立复核，修复：停止未确认仍释放槽位、启动中卸载漏追踪、同目录别名绕过同项目判定、
  超大记录失去淘汰保护、并发 overlap 未落盘、overlap 撑爆记录、错误上下文未贯通、两个可假通过的弱断言
- 已知限制见 docs/worktree-isolation.md「已知限制」

### Added
- **P0-D 进行中重复任务去重**：`dispatch` 按指纹（项目 / 角色 ID / provider / 规范化任务内容 /
  含 TaskSpec 结构化字段 / `git rev-parse HEAD` 版本 / 状态桶 / isolation 等关键参数）只对进行中
  任务去重；命中返回既有 `taskRef` + `deduplicated:true` + 当前状态，不创建第二个子任务、不占额度、
  不建工作树。版本取不到或信息不足时正常新建（宁可重复也不误合）；索引仅内存、终态清理、
  并发「先占位再启动」用受控 pending promise 保证只创建一个。规则与误判边界见
  [配置参考 §7.5](configuration.md)；新增 `tests/dedup.test.mjs`（16 项）
- **并行多任务（任务级工作树隔离）**（2026-11-11 悟空裁决，路 2）：
  - 新增 `src/worktree.js`：自建 `git worktree`（literal argv、清 `GIT_*`、`GIT_TERMINAL_PROMPT=0`、
    30s 超时、输出上限、按 git common-dir 进程内互斥）；路径
    `.meetingstone/worktrees/<operationId>`、分支 `meetingstone/<operationId>`
  - `meetingstone_dispatch` 新增 `isolation: 'none' | 'worktree'`，默认 `worktree`
  - 并发额度（2026-11-11 修订）：宿主 `maxActiveSubagents` 默认 **8**，进程内共享池
    （宿主子 Agent + 本插件都算），池满直接抛 `ACTIVATION_LIMIT_REACHED`，**无等待/队列**；
    本插件只保留**全局** `maxParallelWritesTotal`（默认 4，仅统计本插件任务），
    在首次异步操作前预占，超限**立即拒绝** `WRITE_LIMIT_TOTAL`，不排队
  - `ACTIVATION_LIMIT_REACHED` 原样透传（不归入 `ADAPTER_FAILED`）；删除
    `maxParallelWritesPerProject` / `WRITE_LIMIT_PROJECT` 按项目额度模型
  - 同项目"隔离/未隔离互斥"与 `serializeWrites` 保留为**正确性保护，不是并发额度**
  - 失败关闭：建树失败/服务缺失 → 拒绝派单，绝不退回主工作区；`isolation:none` 与隔离任务不得混跑
  - 工作树/分支**一律不自动删除**（完成/失败/取消/卸载都不删）
  - 记录新增 `worktree` / `changedFiles` / `changedFilesUnknown` / `operationId` / `stopConfirmed`；
    `list_runs` 不再丢 `worktree` 字段
  - `get_task` / `list_runs` 返回 `overlapWarnings`（同项目改动文件交集）；`changedFilesUnknown`
    的记录不参与比较但标注未知
  - 淘汰保护：带 `worktree` 的记录不参与 100 条/30 天清理
  - 新增测试 `tests/worktree.test.mjs`（真实 git 建树/冲突/超时/computeChangedFiles）与
    `tests/parallel.test.mjs`（额度、跨项目、失败关闭、取消/卸载、重叠、淘汰）
- 新错误码 `WORKTREE_*` / `WRITE_LIMIT_TOTAL` / `INVALID_ISOLATION`（见 `docs/configuration.md` §5）；
  宿主 `ACTIVATION_LIMIT_REACHED` 原样透传
- `docs/plan/2026-11-11-parallel-plan.md` 写入悟空裁决；`docs/worktree-isolation.md` 改为
  「自动隔离 + 手动流程并列」，明确**文件布局隔离 ≠ 权限沙箱**
- **生命周期正确性（P0）**：取消改为「先 `dispose()`（默认 5s 超时兜底）再释放槽位」；
  落盘按 `childId` 串行（running 一定先于终态）；新增 `runtimeId`，重启后把旧 `running`
  投影为 `interrupted`；插件卸载时为存活任务写 `interrupted` 终态
- 新错误码 `ADAPTER_DISPOSE_TIMEOUT` / `ADAPTER_DISPOSE_FAILED`（见 `docs/configuration.md` §5）
- 角色注册表：别名解析、冲突降级（标记 `ambiguous` 而非整表失败）
- 项目级配置 `.meetingstone.json`：mtime 缓存、坏文件降级、与全局配置合并
- 本机 CLI 探测：多源解析（PATH → Appx → npm 全局 → 常见目录），带版本试跑与缓存
- 派单编排：同项目任务串行（`serializeWrites`）、工作树隔离、失败回滚、`onFinish` 幂等释放
- DSH 接线层：`ctx.subagents` 适配器 + 八个工具（`meetingstone_list_roles` / `_dispatch` / `_list_runs` / `_get_task` / `_cancel_task` / `_cli_status`）
- 通道实例表 `channels`：模型/强度由 provider 行承载，角色声明必须一致（DD7 方案 B）
- 发布门禁 `npm run verify`：全量测试 + 宿主/模型 API 契约校验
- **工作树隔离（手动流程）**：`docs/worktree-isolation.md` + `examples/worktree-dispatch.jsonc`，说明用宿主
  `create_worktree` 建隔离工作树、派单 `cwd` 指向它、人工 merge / cherry-pick / patch 合并与
  `git worktree remove` / `prune` 清理。
- **协作效率规范文档**：新增 `docs/efficiency.md`，落地派单简报 / 输出 / 收口 / 失败标注
  四条协作约定（纯提示词 / 文档，0 代码、不进配置、不做门禁）；明确不做重复任务去重、
  角色自动路由、冷却 / 自动换模型。中文 README 加链接，`docs/architecture.md` 补「协作效率机制」小节

### Changed
- **并发模型改为「宿主 8 共享 + 插件全局 4」**（2026-11-11 用户决策）：宿主池满直接抛
  `ACTIVATION_LIMIT_REACHED`（无等待/队列），插件原样透传；插件只保留全局
  `maxParallelWritesTotal`（默认 4，仅统计本插件任务），超限立即拒绝 `WRITE_LIMIT_TOTAL`；
  删除按项目额度。同项目隔离互斥/`serializeWrites` 明确为正确性保护而非额度
- **迟到结算回填 `stopConfirmed`**：取消/卸载时 dispose 超时或抛错先写
  `cancelled + stopConfirmed:false` 并保留槽位；`activation.result` 落定后再写一条终态，
  把 `stopConfirmed` 回填为 `true`、`diagnostic` 追加 `late settlement`，`status` 保持
  `cancelled` 不被覆盖，这时才释放槽位
- `limits` 新增 `defaultIsolation`（默认 `worktree`）；`serializeWrites` 仅在 `isolation:none` 时生效
- 当前开发线：8 个工具；`node scripts/run-tests.mjs` 214 项全绿；`node scripts/verify-host-schema.mjs` PASS
- `docs/configuration.md` / `docs/security.md` / `examples/worktree-dispatch.jsonc` 同步并行隔离与失败关闭语义
- 文档校准：`permissionPreset` / `readOnly` / `READONLY_*` / `maxParallelReadonly` 等只读旧表述统一标注
  「已移除 / 不做（已移除）」；审计文档保留历史并加"已移除"声明；`docs/audit/15` 能力对照补
  「并行多任务：已实现」；`docs/worktree-isolation.md` 链接进中英文 README。

### Fixed
- **Windows 并发读取时的终态丢失**：记录文件被 `readFile` 占用时 `rename` 偶发 `EPERM/EBUSY`，
  导致终态退回 `running`；`run-store` 对 `EPERM` / `EACCES` / `EBUSY` 做短重试
- **2026-11-10 事故**：工具 `parameters` 未编译成合法 JSON Schema，导致 DeepSeek 对全部会话每轮返回 400。
  现改为按宿主契约编译，并在注册前 fail-fast 校验；见 `docs/audit/13-incident-tool-schema.md`
- 并发写任务在占槽前就启动（两个写任务可同时成功）；槽位在任务结束后不释放
- 歧义角色提示"请用 roleId"但 roleId 也被拒
- `channel` 字段级覆盖会把 `kind` 重置成默认值

### Removed
- **只读通道彻底移除**（2026-11-11 用户决策）：`meetingstone_dispatch.readOnly` 参数、`readOnlyEnforced`、
  `permissionPreset`（角色与通道实例）、`READONLY_UNENFORCEABLE` / `READONLY_LIMIT`、只读并发计数与
  `limits.maxParallelReadonly` 全部删除。原因：宿主 subagent spec 没有权限字段，做不到绝对只读，就整个不提供。
  **不要再实现**；`docs/audit/14`、`docs/audit/15` 里保留的是历史记录。
- **项目级 `limits` 死配置移除**：`.meetingstone.json` 不再解析/校验/导出 `limits`；`serializeWrites` 只在插件
  全局配置（`src/config.js`）里生效。旧项目配置里写了 `limits` 会按未知字段忽略，不报错、不阻断派单。

### Security
- 派单 `cwd` 必须落在项目根内；拿不到项目根则失败关闭
- 并行隔离是**文件布局隔离，不是权限沙箱**：同账号、同文件系统、共享 git 元数据
- 工作树建树前后都做 realpath 校验，防 junction/symlink 逃出项目根
- 不读取/复制/注入任何 CLI 凭据；探测只报文件是否存在
