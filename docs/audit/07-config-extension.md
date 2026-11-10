# 07 · Settings / Workspace 配置扩展点核验（P0-07）

| 项 | 值 |
| --- | --- |
| 采集时间 | 2026-11-10 13:25–14:12（UTC+08:00） |
| 采集人 | 沙僧（CodeBuddy CLI 会话，模型 `deepseek-v4.1-flash`） |
| 宿主版本 | DeepSeek Harness `0.2.2-rc.1`（`hostProtocolVersion: 4`） |
| 官方依据 | GitHub `deepseek-ai/deepseek-harness`，`ref=master` → commit **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`**（commit date 2026-11-04，message: `Merge release/dsh-0.2.2 (0.2.2-rc.1) to master`） |
| 本机依据 | 宿主 `app.asar` 内已安装包源码/README（`dsh/node_modules/@deepseek-ai/*`）+ profile 实文件 |
| 对 profile 的改动 | **无**（未改任何配置文件，故无恢复动作） |

> 本文所有结论均给「文件 + 行号 + 原文片段」或「命令 + 输出」。凡未实际执行的验证，一律写「未验证」，不推断。

---

## 0. 结论卡（先看这里）

| # | 问题 | 结论 | 置信度 |
| --- | --- | --- | --- |
| 1 | `ui-settings` 为什么 `enabled: false` | 它**不是插件禁用开关**，而是该插件 Config 里的一个普通偏好字段（"开发者工具 / Coding Tools"）。当前值 false 是 **2026-11-09 12:41 桌面引导流程（Onboarding）写入**的：用户跳过引导 → 引导把 `developerTools: false` 通过 `configForms.developerTools.setEnabled()` 写进了 `ui-settings.enabled` | 高（代码链路 + 4 份文件版本对照） |
| 2 | 能否/该不该恢复 | **能恢复，但不必也不该动**：它与设置页是否出现无关；恢复等于替用户改偏好。本次未改 | 高 |
| 3 | 设置页会不会出现 | **会**。设置面板由 `ui-settings-general`（`sidebar.settings` 宿主）提供，该行处于启用状态；`ui-settings` 只是表单/槽契约服务。UI 实拍**未验证**（无观察通道），但组成与历史使用痕迹证据充分 | 中高 |
| 4 | 全局配置落在哪 | `C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml` 的**顶层序列行**：`- id: <profile entry id>` + `config: {...}`。路径可由 `ctx.settings.prepareDocument()` / `configEditor.patchPath` 取得 | 高（本机已有 3 行实证） |
| 5 | 项目根怎么拿 | 首选 `exec.agent.session.header.cwd`（原始项目，不可变）；当前有效目录用 `ctx.workingDirectory.get(session)`；`ctx.workspaceRegistry.resolveByPath()` 只做「路径→工作区记录」映射，**WorkspaceId 是 uuid，不能当路径用** | 高（官方 API 目录 + 宿主源码用法） |
| 6 | 两层在哪里合并 | **每次工具调用入口合并**：全局走 `config.<field>.get()`（本来就是实时快照），项目文件按 `realpath + mtime + size` 缓存重读。理由：无失效竞态、用户手改文件可立即生效 | 建议方案 |
| 7 | 自动表单（auto:true）可用吗 | **不可用**：全量扫描宿主 8 个 JS 命中 `autoGenerate`，**没有任何客户端包消费它**。P1-04 必须自带 browser half（`plugins.row.config` 或 `settings.section`） | 高（全树扫描） |

> ⚠️ 第 7 条与交接时「小白已确认：`ctx.settings.configure({auto:true})` 会把 schema 自动投影成 Plugins 页表单」**不一致**，证据见 §3.6，请负责人裁决是否修订 P0-02 结论。

---

## 1. 方法与证据来源

### 1.1 官方文档（commit `fcc0ad4`）

| 文档 | 大小 | 用途 |
| --- | --- | --- |
| `docs/subsystems/settings.md` | 7,873 B | 表单身份、`settings/*` 事件、Cordis API 目录 |
| `docs/subsystems/workspace.md` | 38,017 B | `WorkspaceId`、`ctx.workspaceRegistry` 全量签名 |
| `docs/subsystems/working-directory.md` | 4,050 B | `ctx.workingDirectory` 三方法 |
| `docs/subsystems/filesystem.md` | 41,236 B | `ctx.fs` 的 `resolve` / `readText` / `watch` 签名 |
| `packages/boot/config-editor/README.md` | 3,063 B | 落盘与 HMR 协调、可编辑范围 |

下载命令（2026-11-10）：

```bash
curl -s "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/settings.md"
```

### 1.2 本机包（`app.asar`，未解包到磁盘）

宿主 `resources\app.asar` 用 node 解析 asar 头后按偏移读取，未落地任何临时包文件。关键包：

| 包 | 版本 | 作用 |
| --- | --- | --- |
| `@deepseek-ai/dsh-settings` | 0.2.2-rc.1 | `ctx.settings` 表单服务 |
| `@deepseek-ai/dsh-config-editor` | 0.2.2-rc.1 | 写入 profile patch + 触发重载 |
| `@deepseek-ai/dsh-client-ui-settings` | 0.2.2-rc.1 | 表单域/槽契约 + 开发者工具偏好 |
| `@deepseek-ai/dsh-client-ui-settings-general` | 0.2.2-rc.1 | 设置面板外壳（`sidebar.settings`） |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 0.2.2-rc.1 | Plugins 页（`plugins.item` / `plugins.bundle.config` / `plugins.row.config`） |
| `@deepseek-ai/dsh-workspace` | 0.2.2-rc.1 | `ctx.workspaceRegistry` |
| `@deepseek-ai/dsh-working-directory` | 0.2.2-rc.1 | `ctx.workingDirectory` |
| `@deepseek-ai/dsh-fs` + `dsh-fs-sandbox` | 0.2.2-rc.1 | `ctx.fs`（本 profile 挂的是 sandbox 后端） |

---

## 2. 问题一：`ui-settings` 为什么是 `enabled: false`

### 2.1 直接原文：当前 patch 与 3 份历史备份对照

当前 `C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml`（mtime **2026-11-09 12:41:11**）相关两行：

```yaml
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: false
```

同一目录下 3 份备份（全部 `enabled: true`）：

| 文件 | mtime | `ui-settings.enabled` | 同文件 `ui-settings-account` 关键值 |
| --- | --- | --- | --- |
| `cordis.patch.yml.bak-1794091300858` | 2026-10-12 08:28:35 | `true` | `purpose: both` / `completion: completed` / `usage: detailed` / `developerTools: true` |
| `cordis.patch.yml.bak-1794093856575` | 2026-11-08 06:58:38 | `true` | 同上 |
| `cordis.patch.yml.bak-20261108-072259` | 2026-11-08 06:58:38 | `true` | 同上 |
| **当前 `cordis.patch.yml`** | **2026-11-09 12:41:11** | **`false`** | **`purpose: null` / `completion: skipped` / `usage: compact` / `developerTools: false`** |

> 四个版本里 `developerTools` 与 `ui-settings.enabled` **完全同向**（true/true、false/false），这是后面定位"谁写的"的关键线索。

命令：

```powershell
stat -c '%y %n' C:/Users/30673/.dsh/profiles/desktop/cordis.patch.yml*
# 2026-11-09 12:41:11  .../cordis.patch.yml
# 2026-10-12 08:28:35  .../cordis.patch.yml.bak-1794091300858
# 2026-11-08 06:58:38  .../cordis.patch.yml.bak-1794093856575
# 2026-11-08 06:58:38  .../cordis.patch.yml.bak-20261108-072259
```

`grep` 结果（当前 vs 备份）：

```bash
grep -n -A2 "id: ui-settings$" cordis.patch.yml*
# cordis.patch.yml:31:  config:
# cordis.patch.yml:32:    enabled: false
# cordis.patch.yml.bak-*: enabled: true
```

### 2.2 它是不是"插件禁用"？不是——机制不同

DSH 里真正的"禁用一行"用的是 `disabled` 字段，而不是 `config.enabled`。宿主 base bundle 里有现成对照：

```yaml
# resources\app.asar → dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:15-16
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
```

```yaml
# 同文件 :45-47
- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  disabled: !!js "!ctx.get('profileContext')"
```

也就是说：**`disabled` 是 loader 层的启停开关，`config.enabled` 只是插件自己声明的字段名**。本项目这行用的是后者。

### 2.3 `enabled` 在插件里是什么：开发者工具偏好

`dsh-client-ui-settings/lib/index.js`（宿主包，逐行原文）：

```js
// :5
const DeveloperToolsSettingsFields = { enabled: z.boolean().default(true) };
// :10
const Config = z.object({ enabled: DeveloperToolsSettingsFields["enabled"].volatile() });
// :16
child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
```

`dsh-client-ui-settings/lib/client.js:1068-1069` 注释与常量写得更直白：

```js
/** Shared Web and desktop developer-tool preference stored by the Host. */
/** Namespace for developer UI and HTML preview capabilities. */
const DEVELOPER_TOOLS_NAMESPACE = "ui-settings";
/** New installations and missing values enable the full interface. */
const DeveloperToolsSettingsFields = { enabled: Schema.boolean().default(true) };
```

官方包 README 原文（`dsh-client-ui-settings/README.md`）：

> `ctx.configForms.developerTools` owns the Coding Tools switch and the shared Web and desktop preference `ui-settings.enabled`, defaulting to `true`. … **This controls presentation and HTML preview permissions, not Host authorization or Session recording.**

`dsh-client-ui-settings-general/README.md`：

> **The Coding Tools switch** controls the shared `ui-settings.enabled` preference described by ui-settings.

所以：`enabled: false` = **"Coding Tools / 开发者工具"开关被关掉**，与插件加载、设置页存在与否都无关。

### 2.4 谁写的：桌面引导流程（Onboarding）

`dsh-client-ui-settings-account/lib/client.js` 的引导控制器在构造时把一个透传函数接到了开发者工具偏好上：

```js
// :5348
const controller = new DesktopOnboardingController(
  ctx.configForms.get(DESKTOP_ONBOARDING_NAMESPACE),
  ctx.configForms.get("ui-chat"),
  (enabled) => ctx.configForms.developerTools.setEnabled(enabled),   // ← 写 ui-settings.enabled
  operations.hooks.account, readOnboardingApiKeyPresence, ctx.configForms.describe());
```

引导保存时分三步（`:3945-3970`，原文节选）：

```js
async save(next, applyPreferences) {
  ...
  if (applyPreferences) {
    const mode = next.process;
    const accepted = await this.chat.mutate([
      { op: "set", path: ["transcriptView"], value: mode },          // → ui-chat
      { op: "set", path: ["performanceUsage"], value: next.usage },   // → ui-chat
    ]);
    ...
    await this.setDeveloperTools(next.developerTools);                // → ui-settings.enabled
  }
  ... // 最后写引导进度字段（purpose/process/completion/usage/developerTools）
}
```

`setEnabled` 的落点（`dsh-client-ui-settings/lib/client.js:1059-1062`）：

```js
async setEnabled(enabled) {
  if (!await this.scope.set("enabled", enabled)) throw new Error("Developer tools preference was not saved");
}
```

这与当前 patch 的**三处同时变化**完全吻合：

| 当前值 | 由谁写 |
| --- | --- |
| `ui-chat.transcriptView: standard` / `performanceUsage: compact` | 引导的 `chat.mutate` |
| `ui-settings.enabled: false` | 引导的 `setDeveloperTools(false)` |
| `ui-settings-account.purpose: null` / `completion: skipped` / `usage: compact` / `developerTools: false` | 引导进度写入 |

**结论**：2026-11-09 12:41 有人（用户本人）在桌面端跑了一遍/跳过了一遍引导，选择"不需要开发者工具"，于是 `ui-settings.enabled` 被写成 false。既不是模板默认（模板默认是 `true`，且 web-app bundle 里这一行**根本没有 config**），也不是用户手动"禁用插件"。

模板证据（`dsh-web-app/cordis.patch.yml`，`ui-settings` 行）：

```yaml
# :302-303
- id: ui-settings
  name: '@deepseek-ai/dsh-client-ui-settings'
```

无 `config`、无 `disabled` → 走 schema 默认 `true`。

### 2.5 能否安全恢复？恢复后设置页会不会出现？

| 问题 | 回答 | 依据 |
| --- | --- | --- |
| 能恢复吗 | **能**。把 `enabled` 改为 `true`（或删掉该 `config` 键回落到 schema 默认）。因为它是 `.volatile()` 字段，loader 会走"仅 volatile 变更"路径：不重挂插件、直接提交新值并派发 `loader/volatile-update`，无需重启 | `vendor/loader/README.md:63`；`dsh-settings` 表单路径 |
| 该恢复吗 | **不该，也没必要**。它与"设置页是否可用"**没有因果关系**；改它等于替用户改偏好（会重新打开开发者工具/HTML 预览相关界面）。本次**未做任何修改** | §2.3 能力范围 + 用户偏好属性 |
| 设置页会出现吗 | **会**。设置面板 = `ui-settings-general` 提供的 shell（`sidebar.settings` 占用者），`ui-settings` 只提供表单域与 slot 契约。两者在 `dsh-web-app` 中都是无 `disabled` 的 active 行 | `dsh-client-ui-settings-general/README.md`（"Users reach the shell through the sidebar's bottom Settings control"）+ `dsh-web-app/cordis.patch.yml:302-307` |

补充证据（间接但有力）：`ui-settings-account` 这一行里的 `step: done`、`completion: skipped` 是**引导 UI 自己写进去的**——说明引导/设置面板在本机确实渲染过并完成过写入。

**未验证**：设置面板的实际渲染（本任务无 UI 观察通道，也未截屏）。

### 2.6 更正 01-environment.md 的 D-15

`docs/audit/01-environment.md` 的差异表 D-15 写的是：

> `@deepseek-ai/dsh-client-ui-settings` 为 `enabled: false` → **计划缺项**：影响 P0-07 / P1-04 的 Settings 页路线

该判断**不成立**，正确表述是：

> `ui-settings` 行的 `config.enabled: false` 是"开发者工具"偏好，不是插件禁用；设置页路线不受影响。它由 2026-11-09 12:41 的桌面引导写入。

（按本任务"只创建 07 文件"的约束，未回头修改 01；建议由负责人批准后一次性订正 01 的 D-15。）

---

## 3. 问题二：全局配置的读写路径

### 3.1 值实际存在哪里

**落点**：活动 profile 的 patch 文件 —— `C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml`。

**结构**：顶层 YAML 序列，一行一个条目；配置写在该行的 `config` 键下。

**行 id 从哪来**：profile 的 patch 只能**按 id 覆盖**别的层已声明的行。真实样例（本机）：

| profile patch 行 | 该行在哪里声明 | 说明 |
| --- | --- | --- |
| `id: ui-chat` | `dsh-web-app/cordis.patch.yml:331` | `dsh-web-app` 负责 insert，profile 只补 config |
| `id: ui-settings-account` | `dsh-web-app:140` | 同上 |
| `id: ui-settings` | `dsh-web-app:302` | 同上 |

也就是说，**我们的 bundle patch 声明行，profile patch 里只出现 `id + config`**（可带 `name`，见本机样例）。

路径的权威来源（代码）：

```js
// dsh-config-editor/lib/index.js:23-25
/** The profile patch edited by this service. */
get patchPath() { return this.ownerContext.profileContext.patchPath; }
```

```js
// dsh-settings/lib/index.js:406
prepareDocument() { ... }   // 返回现有 profile patch 路径，供"打开配置文件"用
```

### 3.2 插件怎么声明（Schemastery + volatile）

官方参考实现（宿主包 `dsh-agent-default-model/lib/index.js:18-25`，原文）：

```js
var AgentDefaultModelConfig = class extends Service {
  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
  });
  ...
}
```

三个事实：

1. **只有 `.volatile()` 字段会出现在设置表单里**。`dsh-settings/README.md`："Forms expose only volatile fields from active, uniquely addressed profile entries."
2. volatile 值**只能是纯 JSON**：不能含函数、类实例、循环引用（`cosmokit/src/volatile.ts` 的 `snapshot()` 会抛 `TypeError`）。
3. volatile 字段在运行时不是值，而是**稳定引用** `Volatile<T>`，只能通过 `.get()` 取当前快照（`cosmokit/src/volatile.ts`）：

```ts
export interface Volatile<T> {
  /** @returns the current immutable snapshot, including undefined for an absent value. */
  get(): VolatileSnapshot<T>
}
```

### 3.3 运行时怎么读

| 场景 | API | 出处 |
| --- | --- | --- |
| 插件主体（host 侧） | `apply(ctx, config)`，`config.roles.get()` | `dsh-agent-default-model:33-38`（`const reasoningEffort = this.config.reasoningEffort.get()`） |
| 想拿服务 | `ctx.inject(['settings'], child => ...)` | `dsh-settings/README.md` |
| 客户端（browser half） | `ctx.configForms.get(entryId)` → `.getSnapshot()`（含 `value/base/user/revision/writable`） | `dsh-client-ui-settings/README.md`「Configuration forms」 |

**不要缓存 `.get()` 的结果跨调用**：它是不可变快照，但会随 volatile 更新换新对象；每次用前取一次即可（成本极低）。

### 3.4 运行时怎么写

| 写入方 | API | 适用 |
| --- | --- | --- |
| host 侧插件自己写 | `ctx.get('configEditor').edit(ctx.fiber.entry, () => nextConfig)` | 官方同款（`dsh-agent-default-model:66`） |
| 客户端表单 | `ctx.configForms.get(id).set/unset/mutate` → 服务端 `ctx.settings.update/replace/mutate(ns, ..., revision)` | 设置页保存 |
| 直接改文件 | 不推荐（绕过校验与 HMR 协调） | — |

`config-editor` 的保证（官方 README 原文）：

> Writes validate the complete candidate before touching disk and serialize with profile changes and HMR. Invalid values and higher-layer overrides leave the file unchanged.

三条已知边界（同 README「Known Limitations」）：

- 只写 active profile patch；home patch 与命令行 overlay **只读不写**，且它们优先 → 被更高层覆盖时写入会被拒（`dsh-config-editor/lib/index.js:121` 抛 `Configuration for "..." is overridden by a home patch or command-line overlay`）。
- 完整 config 覆盖会把普通字段"钉"在 profile 层。
- 只有**唯一寻址且属于 profile root Include** 的条目可编辑。

### 3.5 业务方怎么收到"配置变了"

| 变更类型 | 行为 | 我们该怎么做 |
| --- | --- | --- |
| 只改 `.volatile()` 字段 | **不重挂插件**；新值直接提交进运行中的引用，并向所属 fiber 派发 `loader/volatile-update` | 若维护派生缓存（如别名索引），监听事件重建；否则什么都不做，下次 `.get()` 自然最新 |
| 改了普通（非 volatile）字段 | 走普通重挂（remount） | 校验必须在 `apply` 里做，不要依赖跨重挂的实例状态 |
| UI 刷新 | `settings/document-updated`（仅 UI 通知） | 与我们无关 |

事件签名（`cordis-plugin-loader/src/index.ts:29-34`，原文）：

```ts
/**
 * Volatile config values were committed into the running fiber without a remount; dispatched to the owning fiber only.
 * @param paths - changed config paths as key arrays; every value is committed before dispatch.
 * @mode emit
 */
'loader/volatile-update'(paths: readonly (readonly string[])[]): void
```

官方 settings.md 原文：

> `settings/document-updated` invalidates form descriptors after Loader configuration changes. It is a UI notification; consumers use `loader/volatile-update` only when they need to refresh registration facts.

### 3.6 关键更正：`auto: true` 不会生成可用的表单页

**事实 A**：`configure({auto})` 只是"页面策略"，不改 Config，也不渲染界面。`dsh-settings/README.md` 原文：

> Each form reports `autoGenerate`, enabled by default, **for clients that build pages from the schema; no shipped client does so yet**.

**事实 B**：全树扫描宿主 8 个 JS 命中 `autoGenerate`，全部在 API/Settings 服务层，**没有一个 UI 包消费它**：

```bash
# 扫描 app.asar 内全部 .js/.mjs/.cjs（不设体积上限），查找 autoGenerate
node /tmp/scan2.js autoGenerate
dsh/.../dsh-api-remotes/lib/client.js
dsh/.../dsh-api-settings-controller/lib/index.js
dsh/.../dsh-api-settings-controller/lib/typert.host.js
dsh/.../dsh-api-settings-controller/lib/typert.remote-client.js
dsh/.../dsh-api-settings-controller/lib/types/index.js
dsh/.../dsh-settings/lib/index.js
dsh/.../dsh-settings/lib/types/index.js
dsh/.../dsh-tool-cordis/lib/types/api-catalog.js
count 8
```

**事实 C**：Plugins 页的行配置页**只渲染 slot**，没有兜底的通用表单：

```js
// dsh-client-ui-plugin-manager/lib/client.js:5867-5873（RowDetail）
children: [
  renderSlot("plugins.row.config", { view: "page", form }, { entryKey: key }),
  renderSlot("plugins.detail.section", { subject }),
]
```

而 `form` 只在"该 namespace 被 Host 服务"时才有（`:6919-6927`），且该页**只有注册了 `plugins.row.config` 才会被打开**（README：`A row's page exists only while a plugins.row.config entry names the row`）。

**结论**：P1-04 的"设置页最小可见"**必须自带 browser half**（`package.json` 的 `dsh.client.platform: "web"` + `./client` 导出），二选一：

| 方案 | 页面位置 | 注册 key | 参考实现 |
| --- | --- | --- | --- |
| A（推荐） | Plugins → 本 bundle → 本行 → **Configure** | `name: 'plugins.row.config'`, `key: '<包名>#<row id>'` | `dsh-client-ui-plugin-manager/README.md:91-97` |
| B | 侧边栏 Settings → 自定义分区 | `name: 'settings.section'`, `id`, `order`, `label` | `dsh-client-ui-settings-general/README.md`（shell 投影 `settings.section`） |

官方页面注册的最小骨架（`dsh-client-ui-settings-shell/lib/client.js:263-297` 原文节选，方案 A 的同构写法）：

```js
const inject = ["slots", "locale", "configForms"];
function apply(ctx) {
  const form = ctx.configForms.get("meetingstone");        // 参数 = profile entry id
  ctx.effect(() => () => form.dispose(), "meetingstone: form subscription");
  ctx.effect(() => ctx.configForms.whileServed(["meetingstone"], (served) =>
    ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
      name: "plugins.row.config",
      key: "@meetingstone/dsh-plugin#meetingstone",
      locale: "meetingstone",
    }, ConfigPage))), "meetingstone: page");
}
```

> 注意：`whileServed` 是"Host 确实在服务该 namespace 才出现"，避免在未装载时留下空页面——这是官方推荐的正确姿势。

---

## 4. 问题三：项目级配置 `.meetingstone.json` 怎么接

### 4.1 "当前项目根"有三个候选，语义不同

| 候选 | 语义 | 会不会随 `cd` 变 | 适合做 `.meetingstone.json` 基准吗 |
| --- | --- | --- | --- |
| `exec.agent.session.header.cwd` | **原始项目目录**（Session 头，不可变） | ❌ 不变 | ✅ **推荐** |
| `ctx.workingDirectory.get(session)` | 当前有效目录（`working-directory/change` 之后会变） | ✅ 会变 | 可选；用于"跟随用户当前所在目录"的语义 |
| `ctx.workspaceRegistry.resolveByPath(path)` / `.list()` | 工作区**记录**（uuid + 规范化路径） | — | ❌ 不用于拼路径；只用于判断"是否属于某工作区" |

官方表述（`working-directory.md` 原文）：

> The immutable header identifies the original project; `working-directory/change` records the effective directory used by later directory-based operations.

`workspace.md` 原文：

> `type WorkspaceId = Branded<'WorkspaceId'>` —— "**A generated uuid, never the path**: path normalization rewrites paths, and a reference anchor must stay stable."

**推荐**：以 `header.cwd` 为基准解析 `.meetingstone.json`；若文件不存在且需要"仓库根"语义，可向上找 `.git`（官方 `dsh-agent-instructions` 就是这么做的：`".git" marks the project root`，且"权限/IO 失败要停止发现而不是跳到祖先目录"）。第一版建议**只做 header.cwd，不向上走**，避免跨项目读到别人的配置。

### 4.2 用哪个 API 拿

```js
// 工具执行体内（ToolExecution 提供 agent）
if (exec.agent === undefined) throw new Error("meetingstone requires an agent Session");
const projectRoot = exec.agent.session.header.cwd;          // 原始项目，string | undefined
const cwd = ctx.workingDirectory.get(exec.agent.session);   // 当前有效目录
```

证据：

- `exec.agent` 的用法：`dsh-tool-working-directory/lib/index.js`（`if (exec.agent === void 0) throw ...`，随后 `ctx.workingDirectory.ensure(exec.agent, exec.signal)`）。
- `agent.session` 的用法：`dsh-api-terminal-controller/lib/index.js:789`（`cwd: workingDirectory.get(agent.session)`）。
- `session.header.cwd` 的用法：`dsh-api-session-controller/lib/index.js:334`（`live.session.header.cwd`）。
- `resolveByPath` 签名（`workspace.md`）：`async resolveByPath(path: string): Promise<Workspace | undefined>` —— 只读解析，**不创建、不改写**；不存在会 reject。

> `ctx.workspaceRegistry` 在本 profile 可用：`dsh-web-app/cordis.patch.yml:87-88` 有 `- id: workspace / name: '@deepseek-ai/dsh-workspace'`，无 `disabled`。它是**可选服务**，插件里应 `ctx.inject(['workspaceRegistry'], ...)`，缺失时不阻塞主流程。

### 4.3 读一个普通 JSON 有没有原生 utils

| 候选 | 能否读文件 | 结论 |
| --- | --- | --- |
| `@deepseek-ai/dsh-util-workspace-path` | ❌ 纯词法路径工具（join/缩略/title），**不访问文件系统** | 不可用 |
| `dsh-util-values` / `dsh-util-time` / `dsh-util-code-language` | ❌ 与文件无关 | 不可用 |
| `ctx.fs`（本 profile 挂 `dsh-fs-sandbox`） | ✅ `resolve` + `readText` / `stat` / `watch` | ✅ **首选** |
| `node:fs/promises` | ✅ | 兜底（简单、无依赖） |

`ctx.fs` 签名（`filesystem.md` 的 `ctx.fs` 目录，原文）：

```ts
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
```

**读不会被沙箱拦**：`dsh-fs-sandbox/README.md` 原文——"confines model file **writes** … while preserving the local filesystem's **read** behavior … **reads stay unconfined**"。所以读项目根的 `.meetingstone.json` 走 `ctx.fs` 与 `node:fs` 结果一致；`ctx.fs` 的好处是换成远程/受限后端时行为仍正确。

**结论**：没有"项目配置文件"专用 util，也没有"读任意 JSON 配置"的官方抽象；要么 `ctx.fs`，要么 `node:fs`。**不需要自己造通用读取框架**，一个 30 行的 `readProjectConfig()` 足够。

### 4.4 损坏 / 不存在的降级

| 情形 | 建议行为 | 理由 |
| --- | --- | --- |
| 文件不存在（ENOENT） | 视为"没有项目覆盖"，只用全局，**不报错** | 绝大多数项目不会有此文件 |
| JSON 语法错 | **拒绝派单**，返回 `PROJECT_CONFIG_INVALID`（fail-closed） | 项目文件可能承载"只读/收紧"约束，读不懂就不能假装没有它 |
| schema 校验失败（字段类型错、roleId 非法） | 拒绝派单，错误里带 `path`（如 `roles[2].roleId`） | 同上 |
| 文件过大（建议上限 256 KB） | 拒绝并提示 | 防止误放二进制/超大文件 |
| IO 权限错误 | 拒绝（fail-closed） | 官方 `agent-instructions` 同策略：失败要暴露，不替换成祖先目录 |
| 别名与全局冲突 | 拒绝保存/拒绝派单，指明冲突双方 | 计划 §7.1 已定"跨角色全局唯一" |

> 与"只能收紧不能放宽"配套：**只有成功解析的项目配置才允许收紧**；解析失败时按"最严"处理（即拒绝），而不是回落到全局更宽松的权限。

---

## 5. 问题四：两层配置在哪里合并

### 5.1 建议方案：**每次工具调用入口合并 + 文件级 mtime 缓存**

| 层 | 读取方式 | 成本 | 变更感知 |
| --- | --- | --- | --- |
| 全局（插件 Config） | `config.roles.get()` 等 | 一次内存读，无 IO | 自动最新（volatile 引用） |
| 项目（`.meetingstone.json`） | `ctx.fs.stat` → 比对 `mtimeMs + size` → 变了才 `readText` + `JSON.parse` + 校验 | 一次 stat（~几十 µs） | 用户手改文件下次调用即生效 |

**为什么不在启动时缓存一份**：项目文件是用户手动维护的，可能被编辑器/其他工具在会话中途改；启动缓存要么过期、要么需要 `watch` 才能正确失效，而 `watch` "unsupported providers reject without polling"（`filesystem.md`），可靠性不如一次 stat。

**为什么不用长驻 `ctx.fs.watch` 作为唯一机制**：`watch` 是单文件观察、需要 signal 生命周期、且可能不支持；作为"加速器"可以，作为"正确性来源"不行。第一版不做 watch。

### 5.2 伪代码（审计级，不是产品代码）

```ts
// 每次 dispatch 工具调用
const globalRoles = config.roles.get()               // 冻结快照
const projectPath = join(exec.agent.session.header.cwd, '.meetingstone.json')
const project = await loadProjectConfig(projectPath)  // { kind: 'absent' | 'ok' | 'invalid', value?, error? }

if (project.kind === 'invalid') return error(project.error)   // fail-closed
const merged = mergeRoles(globalRoles, project.kind === 'ok' ? project.value : undefined)
// merge 规则：项目 > 全局；别名冲突直接报错
// （permissionPreset 只能收紧的规则已于 2026-11-11 随只读通道移除，不要再实现）
```

### 5.3 失败时的降级行为

| 失败点 | 降级 |
| --- | --- |
| 全局 config 缺失/为空 | 用内置默认（空角色表 + `defaultRoleId: null`），`list_roles` 返回空数组而不是报错 |
| 项目文件 absent | 单层配置，正常派单 |
| 项目文件 invalid | 拒绝派单，附错误路径 + 行号（JSON.parse 的 `position` 可换算） |
| `ctx.fs` 不可用 | 回落到 `node:fs/promises`（同样 fail-closed 规则） |
| 合并后角色不存在 | `ROLE_NOT_FOUND`，列出可用角色名，方便模型自我纠正 |

---

## 6. 给 P1-04 的可执行清单

| # | 要做的事 | 依据 | 验收 |
| --- | --- | --- | --- |
| 1 | bundle patch 声明行 `- id: meetingstone / name: '@meetingstone/dsh-plugin'`，**不要在 `config` 里放必须保留的值** | profile patch 整行替换 config（`dsh-base` 头注释） | 安装后 profile patch 无该行也能跑（靠 schema 默认） |
| 2 | `Config` 用 Schemastery，`roles` / `defaultRoleId` / `dispatchNotes` 三个字段 `.volatile()` | §3.2 | 改值不重启即生效 |
| 3 | 提交 browser half（`dsh.client.platform = web`，导出 `./client`），注册 `plugins.row.config`，key = `<包名>#meetingstone` | §3.6 事实 C | Plugins → 本 bundle → 行 → Configure 出现表单 |
| 4 | 页面用 `ctx.configForms.get('meetingstone')`，读 `snapshot.value`，写 `.mutate([{op:'set',...}])` | §3.4 | 保存后 patch 出现 `config:` 段 |
| 5 | `ctx.effect(() => () => form.dispose())` + `whileServed` 包裹注册 | `ui-settings-shell` 同款 | 卸载/禁用后无残留订阅与空页面 |
| 6 | 监听 `loader/volatile-update` 只做"派生索引重建" | §3.5 | 别名索引改完立即可查 |
| 7 | 项目配置读取：`header.cwd` + `ctx.fs`（回退 `node:fs`）+ mtime 缓存 | §4 | 手改 `.meetingstone.json` 下一条派单生效 |
| 8 | 失败码：`PROJECT_CONFIG_INVALID` / `PROJECT_CONFIG_TOO_LARGE` / `ROLE_NOT_FOUND` / `PERMISSION_ESCALATION_DENIED` | §4.4 / 计划 §7.2 | 单测覆盖 6 种降级 |

**P1-04 的最小可行版本**：1 + 2 + 3 + 4 + 5（一个占位字段 + 保存 + 重启保持）。项目配置（7/8）属于 P2。

---

## 7. 未验证项

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 设置面板实际渲染 / 截图 | **未验证** | 无 UI 观察通道；未截屏、未操作界面 |
| 改 `ui-settings.enabled` 后 UI 的实际变化 | **未验证** | 同上；且判定为"不该为验证而改用户偏好" |
| HMR 对本插件 volatile 变更的实测 | **未验证** | 尚无插件可装；未修改 profile 做黑盒试验 |
| `configEditor.edit()` 写入后 patch 的具体排版（注释保留/字段顺序） | **未验证** | 未实际调用；仅有官方 README 承诺 |
| 非 loopback 浏览器下"打开配置文件"能力 | **未验证** | 本机为桌面端 |
| `ctx.workspaceRegistry` 在本机是否已有记录 | **未验证** | 未读取 `~/.dsh` 内的 storage 数据（避免触碰用户数据） |
| 向上查找项目根（`.git`）行为 | **未验证** | 本任务未实现，属 P2 设计选择 |

---

## 8. 与既有结论/计划的差异

| # | 既有说法 | 本次实测 | 处理建议 |
| --- | --- | --- | --- |
| D-1 | `01-environment.md` D-15：`ui-settings` 被禁用 → 设置页路线受阻 | **不成立**：`enabled` 是插件 Config 字段（开发者工具偏好），不是 loader 的 `disabled`；由引导流程写入 | 批准后订正 01 的 D-15 |
| D-2 | 小白已确认：`ctx.settings.configure({auto:true})` 把 schema 自动投影成 Plugins 页表单 | **不成立**：`autoGenerate` 无任何客户端消费；RowDetail 只渲染 slot；官方 README 明说"no shipped client does so yet" | P1-04 必须自带 browser half；P0-02 的该结论应加注 |
| D-3 | 计划 §3.5：配置 schema 用 Schemastery、`ctx.settings.configure({auto:true})`、**第一版不自建 `./client`** | 前半正确；"不自建 client"与"要有一个可见设置页"**互相冲突** | 拆开：schema 仍用 Schemastery；UI 需要最小 client（约 1 个组件 + 1 个 slot 注册） |
| D-4 | 计划 §7.1：用 `provider/cli/model` 等字段描述角色 | 未发现冲突；但注意这些字段要进设置表单就必须 `.volatile()`，且值只能是纯 JSON（不能存函数/枚举对象/Map） | 角色表设计保持纯 JSON |
| D-5 | 计划 §2 未提 profile patch 的"整行替换" | `dsh-base` 头注释明确：patch **替换整行 config，不合并**；`dsh-settings` 只在表单层做 merge | 文档化为 P1 陷阱 |

---

## 9. 附：本次用到的命令与输出（可复现）

```powershell
# 1) profile patch 与备份对照
Get-Content C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml -Raw
Get-Content C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml.bak-1794093856575 -Raw
Get-ChildItem C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml* | Select Name,LastWriteTime

# 2) 模板默认：ui-settings 行无 config / 无 disabled
#    （node 读 asar 内 dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:302-303）
node /tmp/asar.js cat dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml | Select-String -Pattern "ui-settings" -Context 0,3

# 3) 插件 Config 定义（证明 enabled 是普通字段，默认 true）
node /tmp/asar.js cat dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/index.js
# :5   const DeveloperToolsSettingsFields = { enabled: z.boolean().default(true) };
# :10  const Config = z.object({ enabled: DeveloperToolsSettingsFields["enabled"].volatile() });

# 4) 引导流程写入链路
node /tmp/asar.js cat dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js
# :5348  (enabled) => ctx.configForms.developerTools.setEnabled(enabled)
# :3966  await this.setDeveloperTools(next.developerTools);

# 5) autoGenerate 全树扫描（无客户端命中）
node /tmp/scan2.js autoGenerate   # 8 命中，全部在 api/settings 服务层

# 6) Plugins 行页只渲染 slot
node /tmp/asar.js cat dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js
# :5867-5873  renderSlot("plugins.row.config", { view: "page", form }, { entryKey: key })
```

> 说明：`/tmp/asar.js`、`/tmp/scan2.js` 是本次审计用的**只读分析脚本**（位于系统临时目录，未写入仓库）；它们只解析 asar 头并按偏移读取，不修改宿主任何文件。
