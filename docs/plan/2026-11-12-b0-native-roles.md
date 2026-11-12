# B0 调研 · DSH 原生角色/Agent 能力能否复用为角色库（go / no-go）

> 执行：沙僧（只读调研）｜2026-11-12 13:10–13:25（Asia/Shanghai）
> 环境：DSH Desktop **0.2.2-rc.1**（`hostProtocolVersion=4`、`nodeVersion=24.21.0`），profile `desktop`，仓库 `D:\MeetingStone` @ `79b1de4`
> 方法：**只读**——解析宿主 `app.asar`（文件表 + 指定文件文本）、只读 profile 配置与 `node_modules`、只读仓库源码；**未改 profile / 未改产品代码 / 未重启 DSH / 未装插件**
> 必核输入：V1 报告 `docs/plan/verify/2026-11-12-v1-goal.md` §4③（F5 冲突）、PDF 三条问题（原文 `docs/plan/verify/_bugs-pdf-utf8.txt`）

---

## 0. 结论（TL;DR）

1. **no-go：不能用 DSH 原生 agent-preset 机制替换 MeetingStone 自建角色库。** 原生能表达「一个 agent 的插件组合（工具集 + persona 身份文本）」，但**没有**「角色名/别名 → 外部 CLI + 模型 + 思考强度」的映射层，且**外部/出进程后端明确拒绝 `agentPreset`**（只对 in-process spawn 子代理有效）。
2. **partial（局部复用）：** `dsh-persona` 的 `prefix/suffix/complete` 语义可作为「角色设定」文本的内部组织参考；**in-process（八戒通道）派单**未来可通过 `agentPreset` 承载 persona——但这属于 V1 范围外，当前 `src/` 无任何 preset/agentOptions 接线（grep 0 命中）。
3. **F5 冲突裁决：两个前序结论都对，scope 不同。**
   - goal R1「`dsh-agent-preset` 物理存在」→ **成立**：宿主 `app.asar` 内 `@deepseek-ai/dsh-agent-preset@0.2.2-rc.1` 真实存在，且列入 `sharedPackages`（329 项），并由 `dsh-web-app` bundle 挂载。
   - 沙僧 R2「profile `@deepseek-ai` 无该包」→ **成立**：profile `node_modules` 只放第三方包（8 个），宿主随附带包不落在那里（口径见 `docs/audit/03-native-capabilities.md:58-62`）。
4. **B3 应关闭**（任务书定义为「B0 若 go 才执行」）；B1/B2 不采用原生 preset 作为角色库实现，只借鉴 persona 字段语义。

---

## 1. F5 冲突裁决（必核输入，逐条给证据）

| # | 主张 | 判定 | 证据（本次实测，2026-11-12） |
| --- | --- | --- | --- |
| 1 | goal R1：原生 `dsh-agent-preset` 物理存在 | **成立** | asar 文件表 `dsh/node_modules/@deepseek-ai/dsh-agent-preset/package.json`（offset=`13913341`，size=`1513`）→ `name=@deepseek-ai/dsh-agent-preset`，`version=0.2.2-rc.1` |
| 2 | goal R1：可表达身份/prompt/工具集 | **成立** | preset 字段 `id / plugins(必填) / name / description / order`（`dsh-agent-preset/README.md` 字段表）；`dsh-persona` 提供 `prefix/suffix/complete` 身份文本；`plugins` 即工具/技能组合行 |
| 3 | 沙僧 R2：profile `@deepseek-ai` 无该包 | **成立（scope 不同）** | profile `node_modules\@deepseek-ai` 实测仅 8 个：`cosmokit / dsh-brand / dsh-sdk-protocol / dsh-subagent-acp / dsh-subagent-claude-code / dsh-subagent-codex / dsh-tool-subagent / schemastery`。宿主随附带 ≠ profile 第三方依赖（审计口径见 03-native-capabilities.md:58-62） |
| 4 | 是否**已挂载**（不只是存在） | **是（composition 静态证据）** | `dsh-web-app/cordis.patch.yml:590-591` 挂 `agent-preset-registry`；`:425-426` 挂 `@deepseek-ai/dsh-client-ui-agent-preset`；`:586-592` 注释说明内置 preset 声明在其后 `presets/` 下；profile `package.json` 的 `dsh.profile.bundles` 含 `@deepseek-ai/dsh-web-app` |
| 5 | 服务/API 是否存在 | **存在** | `dsh-agent-preset-registry/lib/index.js:456`：`super(ctx, "agentPresets")`；该类实测方法含 `register / activate / bind / list / readDocument / composedPreset / select / presetForSession / generationFor / inspectCompositions` |
| 6 | 能否用于外部 CLI 派单 | **不能（硬边界）** | `dsh-subagent/README.md:65`：「In-process spawn accepts an independent `agentPreset`; **fork and external backends reject this option**」；`dsh-subagent/lib/types/out-of-process.js:45`：出进程后端**先拒绝**需要 `agentOptions/agentPreset/outputSchema/maxDepth` 的请求；profile 内 `dsh-subagent-acp/lib/index.js:465-466`：`{ agentOptions: false, agentPreset: false }` |
| 7 | 谁能用 `agentPreset` | **仅 in-process spawn** | asar `dsh-subagent-spawn-in-process/lib/index.js`：`capabilities = { agentOptions: true, agentPreset: true, ... }`；`dsh-subagent-fork-in-process`：`{ agentOptions: true, agentPreset: false }`；session 事件 `agent-preset/selected`（`dsh-subagent/lib/typert.host.js:761`） |
| 8 | 编辑/写回 | **只读 registry，写=改 bundle patch** | `dsh-agent-preset-registry/README.md`：「The registry writes no declarations … nothing accepts YAML back」；新增/覆盖 preset = `insert` 一行 `@deepseek-ai/dsh-agent-preset` 或用 patch 覆盖，经 `plugin_manager` 安装（审计 03-native-capabilities.md:220：plugin_manager 动作需 danger-full-access 或逐次审批）；Web 编辑器保存按 id 覆盖 profile patch 的 `config.plugins`（`dsh-web-app/presets/*.patch.yml` 头部注释） |

**结论口径**：goal R1 的「物理存在/可表达身份」与 R2 的「profile 无该包」**不矛盾**，冲突来自「宿主随附带」与「profile 第三方依赖」两个目录口径。真正限制 B3 的是第 6/7/8 行：**preset 只作用于 DSH in-process agent，不可用于外部 CLI 派单，且没有别名→CLI/模型/强度映射**。

---

## 2. 原生能力全景（本次可复现的证据）

| 能力 | 证据 | 边界 |
| --- | --- | --- |
| preset 定义（YAML row） | `dsh-agent-preset/README.md` 字段表：`id`(required) / `plugins`(required) / `name` / `description` / `order` | 静态声明；「edits affect subsequently created Agents」 |
| 会话级选择 | preset 身份由 session 保存（`config.id`）；registry `default` 必填；`selectedDefault` 为 volatile 用户默认（新会话优先）；事件 `agent-preset/selected` | 选择是「整包切换」，不是字段级覆盖 |
| 身份/prompt | `dsh-persona`：`prefix`(required) / `suffix` / `complete` / `includeRuntimeContext` | **必须挂在 preset（agent scope）内**；全局挂载与 prompt registry 冲突并 fail loud |
| 内置 roster | `dsh-web-app/presets/{standard,minimal,ptc,cordis}.patch.yml`，每个均含 `@deepseek-ai/dsh-persona` 的 `prefix` 行 | 面向 DSH 会话「agent 组合」，不是用户业务角色库 |
| 编辑入口 | Web「View configuration」只读 YAML；Creator 模式以 bundle 形式编辑/覆盖 preset | Registry 只读；改配置需 bundle/patch + `plugin_manager` 权限 |

> 关键对照：原生 preset 的「一个 preset 一套插件 + 一段 persona 文本」≈ **角色身份层**，但 MeetingStone 角色库的核心是 **「别名 → 目标 CLI/模型/强度 → 派单」的路由表**（见 §3），二者不是同一层能力。

---

## 3. 能力对比：MeetingStone `Role` vs 原生 preset

MeetingStone 角色字段来源：`src/roles/registry.js:36-51`（`roleId / name / aliases[] / description / prompt / channel{kind,channelId,provider,cli,model,reasoning} / enabled / fallbackRoleId / timeoutMs / source`）、`src/roles/template.js:43-85`、合并规则 `:10-13`。

| 维度 | MeetingStone 现状 | 原生 preset 等价物 | 差距 |
| --- | --- | --- | --- |
| 唯一标识 | `roleId` | preset `id` | ≈ 近似 |
| 展示名/描述 | `name` / `description` | `name` / `description` | ≈ 近似 |
| **简称/别名 + 冲突消解** | `aliases[]`，跨角色唯一，冲突降级 `ALIAS_CONFLICT`（`registry.js:10-13,94-107`） | **无别名概念**，只能按 preset id 选 | ✗ 缺 |
| 角色设定（prompt） | `prompt` 独立字段，派单时前缀注入（`src/dsh/adapter.js:348-363`） | `dsh-persona.prefix/suffix`（仅 in-process agent scope） | ◐ 语义可借鉴，不能直接用于外部 CLI |
| **外部 CLI 绑定** | `channel.kind` ∈ `in-process | acp-cli | codex | claude-code`（`registry.js:87-89`） | **无 CLI 字段**；外部后端拒绝 `agentPreset`（§1 行6） | ✗ 缺（核心） |
| **模型绑定** | `channel.model`，且必须与 provider 行一致（`adapter.js:954-982`「模型只能由 provider 行承载」） | preset 无 model 字段；`{{model}}` 是会话级变量 | ✗ 缺 |
| **思考强度** | `channel.reasoning`（当前一律靠 provider 行声明；见 V1 §4②、本报告 §4） | preset 无 reasoning 字段 | ✗ 缺 |
| **启停/禁用/回退** | `enabled` / `fallbackRoleId` / `ambiguous` | 无对应字段（preset 失败会显示但无 fallback 语义） | ✗ 缺 |
| **三级配置继承** | 全局 / 项目 `.meetingstone.json` / 会话 `roleOverrides`，字段级覆盖 | 部署 `default` + 用户 `selectedDefault` + bundle patch，无字段级覆盖、无项目级文件配置 | ✗ 缺 |
| **设置页内全局角色管理** | PDF#1 要求「本页内弹开全局角色管理」 | preset UI = 会话 agent 组合选择器；编辑需 Creator/bundle patch | ✗ 不匹配 |
| 派单执行/结果契约/worktree/取消/等待 | MeetingStone 自建（`src/dispatch/*`、`run-store`） | 不涉及 | — 非 B0 讨论域 |

---

## 4. 缺口清单：原生缺哪几项、能否补齐

| # | 缺口 | 原生证据 | 能否用原生补齐 | 补齐路径/成本 |
| --- | --- | --- | --- | --- |
| G1 | 别名/简称 → 角色解析、跨角色冲突消解 | preset 无别名概念 | **不能** | 保持自研（`registry.js` 已有，成本≈0） |
| G2 | 角色 → 外部 CLI（Codex/CodeBuddy/Claude）派单 | 外部后端拒绝 `agentPreset`（§1 行6）；官方 provider 不接本机 PATH CLI（`docs/audit/03-native-capabilities.md:124-133`） | **不能** | 保持自研（MeetingStone 核心价值，不可替代） |
| G3 | 角色 → 模型 / 思考强度 | preset 无该字段；模型只能由 provider 行承载（`src/dsh/adapter.js:954` 注释） | **不能**（in-process 的 `agentOptions` 可选，见 U4） | 自研：provider 行能力目录 + UI 联动（B2） |
| G4 | 三级配置继承（全局/项目/会话） | 仅 default + selectedDefault + patch | **不能** | 保持自研（`src/project/*`、`src/session/config.js` 已有） |
| G5 | 设置页内全局角色管理（PDF#1） | preset 编辑=Creator/bundle patch；registry 只读 | **不能** | 自研（B1：设置页内联全局面板） |
| G6 | 角色启停/禁用/回退 | 无字段 | **不能** | 保持自研 |
| G7 | 会话级字段级角色覆盖 | preset 是整包切换 | **不能** | 保持自研（`roleOverrides`） |
| G8 | 变更即时生效 | preset 编辑「只影响后续创建的 Agent」 | **不能**（语义冲突） | 保持自研（现有写入即可生效） |
| G9 | 身份文本组织（角色设定） | `dsh-persona` prefix/suffix/complete | **◐ 可借鉴语义** | 不引入依赖；仅在「角色设定」文本组织上对齐（C1/B2） |

**若坚持 go 的迁移面（仅记录，作为否决依据）**：需为每个角色造 1 个 `@deepseek-ai/dsh-agent-preset` bundle patch + `dsh-persona` 行（静态、随 profile 安装），再自研「角色→外部 CLI/模型/强度」桥接层 + 三级继承 + 设置页编辑——**迁移后仍需保留全部自研核心**，等于在现有系统上再加一套 preset 索引。风险：experimental API 版本漂移、profile patch 冲突、`plugin_manager` 需 danger-full-access、外部 CLI 能力不可得、与 `roleOverrides` 字段级覆盖模型冲突。→ **收益为负，否决**。

---

## 5. PDF 三条问题代码落点（V1 定位 + 本轮复核校正；B1/B2 输入）

> 依据 V1 报告 §4（Goal R2 复核修正）+ 本报告对源码的只读核对；行号可直接复核。

### P1 · 设置页「管理角色」错跳会话级面板（PDF 第 1 条）
- 入口链：`src/client/index.js:1504-1509` 按钮 `onClick: openRoles` → `:1808-1815 openRoles` → `:1710-1716 openRolePanelOf` → `:1713` `sidebarRight.openTab(TAB_KIND, {params:{}})`，**不传 sessionId/scope**。
- 面板强制会话作用域：`:2715` `SidebarRolePane` 初始 `scope='session'`；`:3027` keyed seat `scope:session` + `inject(sessionId)` + `loadSession(sessionId)`；`:598-599` 无 sessionId 时返回 `SESSION_ID_MISSING`。
- 全局/会话分级只在角色详情页：`:2461-2487` scope 按钮；`:2849` `scope==='global'` 才走 `buildGlobalPatch + updateGlobalRole`。
- 设置页本身无角色列表：`:1383-1390 / :1492 / :1515-1523`（roles 仅用于计数）。
- **V1 goal R2 校正（重要）**：通道数据其实已具备（`fullSnapshot`）；真正缺的是 `roleView` 的 `description/prompt/source` 投影（`src/gui/host.js:131`）与设置页内联全局视图；写路径 `updateGlobalRole`（`src/gui/config-api.js:270`、`src/client/index.js:2234-2235`）与 `sanitizeRolePatch`（`src/session/config.js:181`）已就绪 → B1 是「入口 + 视图」工作，不是数据层重建。

### P2 · 角色编辑器「通道」概念 / 思考强度不可选（PDF 第 2 条）
- 数据层：`src/config.js:36-61` channel 相关 schema；`:43` `reasoning` 为**自由字符串、无枚举**；`:118-120` `channels` 默认 `[]`；`cordis.patch.yml:7-9`（仓库）无 channels。
- UI：`src/client/index.js:2400-2426` channel/model/reasoning 下拉；reasoning 选项仅来自 channels（`:2063-2099`、`:2090`）；为空时渲染「不支持·当前通道没有配置思考强度」（`:2363`）。
- **直接原因（R2 归因修正）**：已部署 profile patch `C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml` L75-L94 有 **5 个 channels**（ch-codex-astra / ch-codex-sol / ch-acp-flash / ch-acp-hy4 / ch-inprocess），但**全文件无任何 reasoning 声明**（grep 0 行）→ UI 正确显示「不支持」。R1「仓库无 channels」不对，R2「profile 有 5 channels 但均无 reasoning」成立。
- 能力层：`src/cli/probe.js:15-30` 只探测安装/路径/版本，不提供模型或强度能力表；`src/dsh/adapter.js:954-982` 只做「声明值必须与通道实例一致」的拒单（模型只能由 provider 行承载）。
- **V1 goal R2 补充**：`spec.request.agentOptions` 对声明该能力的后端生效（host：spawn `agentOptions:true/agentPreset:true`；fork `agentPreset:false`；profile 的 `dsh-subagent-acp` `agentOptions:false/agentPreset:false`）——但 **MeetingStone `src/` 当前无 `agentOptions/agentPreset` 接线**（本次 grep 0 命中，`src/dsh/adapter.js:954` 注释仍写「官方 spec 不收 model/reasoning」）→ in-process 真传模型/强度属「宿主有能力、插件未接」，B2 需单独立项。

### P2b · 描述与 prompt 重叠（PDF 第 2 条）
- 字段：`src/config.js:83-84` 两独立字段；`src/roles/registry.js:226-227` 分别赋值；UI 两控件 `src/client/index.js:2391-2399 / 2427-2440`；写盘分开 `:2121-2130 / :2179-2186`。
- 语义重叠点：`src/dsh/adapter.js:350-355` prompt 为空时回退 description；`src/roles/template.js:129-137` 模板角色只有 description；`src/dispatch/routing.js:315` 自动路由用 description 做匹配信号。
- **与原生对照**：原生恰好把 `name/description`（展示）与 persona `prefix`（prompt）分开——**与 PDF 目标态（合并为单一「角色设定」）相反**，因此 B2 **不应照搬**原生字段模型。

### P3 · 能否复用 DSH 自带角色插件（PDF 第 3 条）
- 见本报告 §1-§4；一句话：**存在且可用，但只服务于 DSH in-process agent 组合**，不能承担 MeetingStone 跨 CLI 角色库。

---

## 6. 对 B1 / B2 / B3 的调整建议

- **B3（接入原生角色机制替换自建库）：关闭。** B0 判 no-go，任务书条件不成立。保留一条 V1 外可选研究项：未来若 MeetingStone 支持「in-process（八戒）派单按角色选 preset」，可在 `src/dsh/adapter.js` 接 `agentPreset`/`agentOptions`（当前未接），但需要先证明 UI/产品价值，V1 不做。
- **B1（设置页内联全局角色管理）：保持自建。** 原生 preset 选择器继续留在 DSH 设置页（不移植、不重复）；在设计中明确分工：**DSH preset = DSH 会话 agent 组合；MeetingStone 角色库 = 跨 CLI 派单角色**。B1 工作按 §5 P1 的「入口 + roleView 透传 + 内联视图」做，数据层已就绪。
- **B2（角色编辑器概念）：保持自建字段模型。**
  - 字段按 PDF 目标态：名称 / 简称 / 描述+角色设定（合并为单一文本）/ CLI → 模型 → 思考强度；**去掉「通道」用户概念**（内部仍需要 provider 行/实例，仅不再暴露）。
  - **不引入 preset / presetId 用户概念**，不照搬原生 `name/description + persona` 分离模型（与 PDF 目标相反）。
  - 「思考强度按 CLI 动态联动」需要一张 CLI→模型→强度能力来源；当前 `probe.js` 只探安装/版本、provider 行未声明 reasoning → B2 需先定「能力来源」（provider 行显式声明 or 内置能力表），否则只能是「如实展示 provider 行已声明值 + 不支持置灰」。
- **依赖关系**：B1/B2 均不依赖 B0（B0 结论为不接入），可并行/顺序执行；B3 关闭后不再占用排期。

---

## 7. 未验证项

| # | 项 | 原因/影响 |
| --- | --- | --- |
| U1 | `agentPresets` service 是否对第三方插件（MeetingStone）注入可用 | service 存在（§1 行5），但未实测插件侧 `inject:['agentPresets']`；B3 已否，影响低 |
| U2 | preset 内能否绑定模型/思考强度 | 未找到字段（schema 仅 id/plugins/name/description/order）；未做运行时验证；B2 相关但非阻塞 |
| U3 | GUI 内 preset 选择器本机实际可用性与默认值 | 仅有 composition 静态证据（dsh-web-app 挂载）；未打开 GUI 实测 |
| U4 | host spawn 的 `agentOptions` 模型传递能否被 MeetingStone 使用 | host 能力存在（spawn `agentOptions:true`），但 `src/` 无接线；in-process 真传模型/强度未实测（B2 需另立项验证） |
| U5 | `dsh-subagent-codex` / `-claude-code` 的 `agentPreset` 能力标志 | 包内未找到能力声明；按出进程契约（out-of-process.js:45）拒绝，行为未逐包实测 |

---

## 8. 复现命令（只读）

```powershell
# 1) 解析 app.asar，列出 persona/preset 包与版本、sharedPackages
node -e "const fs=require('fs');const b=fs.readFileSync('C:/Users/30673/AppData/Local/Programs/DeepSeek Harness/resources/app.asar');const hs=b.readUInt32LE(12);const h=JSON.parse(b.subarray(16,16+hs).toString('utf8'));const t=Object.keys(h.files['dsh'].files['node_modules'].files['@deepseek-ai'].files).filter(n=>/preset|persona/i.test(n));console.log(t)"
# 2) profile 第三方包（应只有 8 个，无 persona/preset）
Get-ChildItem "C:\Users\30673\.dsh\profiles\desktop\node_modules\@deepseek-ai" -Directory | Select-Object Name
# 3) preset 服务与能力
#    dsh-agent-preset-registry/lib/index.js:456  -> super(ctx,"agentPresets")
#    dsh-subagent-spawn-in-process  capabilities -> { agentOptions:true, agentPreset:true }
#    dsh-subagent-fork-in-process   capabilities -> { agentOptions:true, agentPreset:false }
#    dsh-subagent/README.md:65 -> "fork and external backends reject this option"
# 4) 已部署 profile channels（5 个，均无 reasoning）
Select-String -Path "C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml" -Pattern "channelId:|reasoning"
```

## 9. 写入边界声明

仅写入本文件（`docs/plan/` 内）；未改 `src/**`、`tests/**`、`package.json`、profile 配置，未重启 DSH，未安装/启用插件。所有结论均附可复核的文件/命令证据；未观测项列入 §7，不以推断代替。
