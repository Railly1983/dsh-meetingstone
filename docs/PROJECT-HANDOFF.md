# 终版项目交接文档 · MeetingStone（集合石）

> 定稿日期：**2026-11-15**
> 项目状态：**已完结**。源码、文档、CI、发布、本机安装全部到位，作者声明不再更新。
> 后续由其他平台接管维护。

---

## 一、30 秒速览

| 项 | 值 |
| --- | --- |
| 是什么 | **DeepSeek Harness（DSH）的第三方插件**，做「按角色跨 CLI 派单」 |
| 版本 | **`0.1.1`**（终版） |
| GitHub | <https://github.com/Railly1983/dsh-meetingstone> |
| npm | <https://www.npmjs.com/package/dsh-meetingstone> |
| 源码 | `D:\MeetingStone`，分支 `main`，HEAD `cb22fe1` |
| 标签 | `v0.1.0`、`v0.1.1` |
| CI | **5/5 全绿**（Windows/Ubuntu × Node 22/24 + 零依赖检查） |
| 测试 | **721 tests / 719 pass / 0 fail / 2 skipped** |
| 发布门禁 | **10 PASS / 0 FAIL** |
| 本机安装 | **`0.1.1`**（已升级并验证） |
| 代码规模 | `src` 约 20,142 行 / 225 个跟踪文件 / 52 个测试文件 |

---

## 二、这个项目解决什么问题

DSH 内置子代理，但**不提供「按角色绑定不同 CLI 和模型」**。当你在一个项目里同时用 Codex、CodeBuddy、Claude Code 时，
要反复记住谁擅长什么、手动传上下文。

集合石补上这一层：把「谁用什么 CLI、什么模型、什么职责」配成一张角色表，
之后在 DSH 对话里用自然语言派活，执行仍交给各 CLI 原生能力。

**核心边界（重要，接管者必须理解）**：

- 集合石**不自研 Agent 运行时**，复用 DSH 的子代理机制
- 集合石**不是任务管理系统**，不重造任务板/工作流引擎
- 集合石**不是权限沙箱**，worktree 只隔离文件布局，不做 OS 级权限限制
- 集合石**不伪造状态**：拿不到就 `unknown`，不把「装了」当「有额度」

---

## 三、0.1.1 做了什么（相对 0.1.0）

### 3.1 开箱即用（用户明确要求）

之前 `roles` 默认是空数组，新用户装完看到「0 个角色」不知道怎么用。
现在内置 3 个默认角色，全部走 **DSH 原生子 Agent**，装完直接能派单：

| 角色 | roleId | 职责 |
| --- | --- | --- |
| 执行者 | `role-worker` | 实现与修改，交付改动文件与验证证据 |
| 审查员 | `role-reviewer` | 独立复核，只报有证据的问题 |
| 调研员 | `role-researcher` | 只读调研，区分事实与推测 |

**三条硬约束**（`src/roles/defaults.js`，10 项契约测试守护）：

1. **只在用户没有任何角色时生效** —— 用户配过角色就完全不介入（不合并/不覆盖/不追加）
2. **只在内存注入，不写盘** —— 用户不点保存就不会被固化到 profile
3. **不绑定 CLI/模型** —— 跟随用户会话默认路由

> **已实测验证**：升级后本机 profile 的 3 个自定义角色（唐僧/八戒/沙僧）**原封不动**，
> `cordis.patch.yml` 与升级前备份**哈希完全一致**，默认角色未写入配置。

### 3.2 修掉的真实产品 Bug

**Appx 解析在非 Windows 平台完全失效**（`src/cli/resolvers.js`）。

原代码用运行平台的 `isAbsolute` 判断安装路径，在 Linux/macOS 上会把
`C:\Program Files\...` 判成相对路径而跳过 —— 即**非 Windows 用户永远探测不到 Codex**。
改为 `win32.isAbsolute`（Appx 只存在于 Windows）。

### 3.3 修复公开仓库 CI 长期全红

CI 从来没装过依赖，4 个 GUI 测试 `import zod` 直接 `ERR_MODULE_NOT_FOUND`。
另有 3 处跨平台测试假设错误（见 §六）。

### 3.4 修复发布门禁的 asar 解析错位

`scripts/smoke-client-inject.mjs` 从宿主 `app.asar` 抽 cordis 做真实冒烟，
数据区偏移算错 3 字节，导致整条门禁假失败。详见 §六.1。

### 3.5 文档与仓库清理

- README 中/英重写：围绕「解决什么问题 → 场景 → 与 DSH 原生区别 → 三步试用」
- 新增快速开始（中/英）、典型场景、FAQ
- 安装/配置文档重写，旧配置归档到 `docs/reference/legacy-configuration.md`
- **移除** `.meetingstone.json`（作者个人分工，曾被误读成默认配置）
- **移除** `personas.json`（全仓零引用，同样易误读）
- **移除** README 里的「48 格对照实验」引用（样本不足，不足以代表真实使用）

---

## 四、交接清单完成情况

用户要求收尾的 4 项，逐项结果：

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | 升级本机插件到 `0.1.1` | ✅ **完成**，canary 通过，DSH 已重启，用户配置未受影响 |
| 2 | 补 `v0.1.1` git 标签 | ✅ **完成**，已推送（annotated，指向 `cb22fe1`） |
| 3 | 撤销泄露的 npm token | ⚠️ **被 npm 政策阻塞**，见下 |
| 4 | 填 GitHub About（Description/Website） | ✅ **完成** |

### 关于第 3 项（npm token）——需要你在网页手动做

尝试撤销时返回 **403**：

```
npm error 403 403 Forbidden - DELETE https://registry.npmjs.org/-/npm/v1/tokens/token/***
npm notice npm tokens that bypass 2FA are being restricted for account changes
```

**这不是操作错误，是 npm 的新政策**：Bypass-2FA token 不允许执行**账号变更类操作**，
包括撤销自身。所以这项**必须由你在网页上手动完成**。

受影响的 token（明文曾出现在对话记录中，应视为已泄露）：

| 名称 | id | 状态 |
| --- | --- | --- |
| `dsh-meetingstone-publish` | `525438a9-2e25-4615-9b3e-f0ec5061f590` | 仍有效，需撤销 |
| `.npmrc` 里的旧 token（`npm_e46s...`） | — | 已失效（401），可忽略但仍建议删 |

**操作步骤**：打开 <https://www.npmjs.com/settings/railly1983/tokens> → 勾选 `dsh-meetingstone-publish` → Delete。

> 撤销后你将无法再用 CLI 发布。**如果项目确实不再更新，这没有影响**；
> 若将来还要发版，改用带 2FA 的网页发布流程即可。

---

## 五、日常命令

环境约束（**必须遵守**）：

```powershell
# 用 DSH 内置 node（v24）。系统 node 是 v20，跑 pnpm 会崩 node:sqlite。
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
```

| 目的 | 命令 |
| --- | --- |
| 全量测试 | `npm test`（**不要**用 `node --test tests/`，glob 在 Windows/老 Node 不可靠） |
| 四条门禁 | `npm run verify` |
| 发布就绪（10 门禁） | `npm run release:check` |
| 打包 | `npm pack` |
| 安全安装到 profile | `npm run install:safe -- --tgz <path> --previous <old.tgz>` |
| 工具 schema | `node scripts/verify-host-schema.mjs` |
| 客户端注入冒烟 | `node scripts/smoke-client-inject.mjs` |
| 真机验收 | `npm run acceptance` |

### 发新版的完整流程（若将来需要）

1. 改版本号 **5 处**：`package.json`、`src/index.js` `PLUGIN_VERSION`、
   `src/client/index.js` `PLUGIN_VERSION`、`src/cli/capabilities.js` 的 `version`、三份 README 的「当前发布版本」
2. 新建 `docs/release/<version>-checklist.md`（**门禁按该文件 mtime 取目标版本**，不建会取错）
3. `CHANGELOG.md` 加 `## [<version>]` 条目
4. `npm run release:check` → 必须 10 PASS
5. `npm pack` → `npm publish`
6. `git tag -a v<version> -m "..." && git push origin v<version>`

---

## 六、踩过的坑（接管者必读，避免重复）

### 6.1 asar 偏移错 3 字节，让整条门禁假失败

`scripts/smoke-client-inject.mjs` 从宿主 `app.asar` 抽 cordis 做真实冒烟。

- **错**：`base = 16 + headerSize`
- **对**：`base = Math.ceil((16 + headerSize) / 4) * 4`

asar 的 header 后有 4 字节对齐填充。偏移错位后，抽出的每个文件开头都带着前一文件的碎片
（`);`、`:!0})})();`），报 `ERR_INVALID_PACKAGE_CONFIG` / `SyntaxError`，
看起来像插件代码坏了，实际与插件无关。

**已加 `verifyIntegrity()`**：用 asar 自带的 `integrity.hash` 校验每次抽取。
偏移再错会立刻报「integrity 不符」而不是神秘语法错误。已用负对照验证。

### 6.2 跨平台测试陷阱（CI 全红的根因）

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| Appx 测试 Linux 失败 | 用了运行平台 `isAbsolute` | 代码改 `win32.isAbsolute` |
| project-load 2 例失败 | 测试用 `win32.join` 造键，产品用平台 `join` | 测试改用平台 `join` |
| projectKey 断言失败 | 产品按平台折叠大小写，测试硬编码小写 | 断言按平台分支 |
| worktree 2 例失败 | CI Windows 的 `%TEMP%` 是 8.3 短名 `RUNNER~1`，`realpath` 给长名 | 用 `realpathSync.native` |

**通用教训**：测试里凡涉及路径，都要问「这在 Linux 上也成立吗」。
本项目历史上多次「本地全绿、CI 全红」。

### 6.3 CI 日志读不到 → 用 annotation

GitHub Actions 日志需认证才能读，失败只看到 `exit code 1`。
已提供 `scripts/ci-test.mjs`：把失败测试名写成**公开 annotation**，提交页直接可见。
CI 用它代替裸 `npm test`。

### 6.4 npm 发布的坑

**a) token 失效**：`~/.npmrc` 里可能存着失效 token（`E401`）。发布时用临时 userconfig，不动全局：

```powershell
$tmp = "$env:TEMP\ms-npmrc"
"registry=https://registry.npmjs.org/`n//registry.npmjs.org/:_authToken=<TOKEN>" | Set-Content $tmp -Encoding ascii -NoNewline
npm publish --userconfig $tmp
```

**b) registry 缓存延迟**：发布后立刻查可能还是旧版本，实际已成功。
判断依据是再次 publish 报 `403 You cannot publish over the previously published versions`。

**c) Bypass-2FA token 正在被淘汰**：2027 年 1 月起直接发布将受限，需改用带 2FA 的流程。

### 6.5 改文件不要用 PowerShell 写中文

历史三次把 UTF-8 写坏（乱码/吃换行）。用 `write`/`edit` 工具，或 Node 的
`fs.readFileSync/writeFileSync` 带 `'utf8'`。

---

## 七、代码结构速查

```
src/
├── index.js              插件入口（apply/inject、注册表、调度器、GUI 接线）
├── config.js             配置 schema（角色/通道/limits/CLI 偏好）
├── roles/
│   ├── defaults.js       ★ 开箱即用默认角色（只在用户无角色时生效）
│   ├── registry.js       角色注册表、别名解析、冲突检测
│   ├── template.js       五人模板（仅测试引用，未接生产）
│   └── ids.js            roleId 校验
├── cli/
│   ├── capabilities.js   4 CLI × 模型 × 思考强度能力目录（唯一事实源）
│   ├── resolvers.js      本机 CLI 探测（PATH/Appx/npm/常见目录）
│   ├── preflight.js      可用性预检三态
│   └── probe.js          探测与缓存
├── dispatch/
│   ├── dispatcher.js     派单、并发槽位、取消、stats
│   ├── routing.js        自动路由规则
│   └── failure.js        失败分类
├── dsh/
│   ├── adapter.js        ★ 宿主 subagents 适配器（agentOptions 钉路由，计费事故修复点）
│   ├── register.js       10 个工具注册
│   └── steer.js          插话/重开
├── gui/
│   ├── host.js           Host 侧 Remote 服务
│   ├── state-model.js    角色状态投影（两色/三档额度）
│   └── config-api.js     配置写 API
├── client/index.js       浏览器 half（Typert Remote 面板，约 3.2k 行）
├── worktree.js           Git worktree 隔离（不自动删除）
└── run-store.js          执行记录落盘与读取投影
```

### 关键设计决策（**不要轻易改**）

- **始终显式钉死子 Agent 路由**（`buildChildAgentOptions`）：宿主默认
  `{...parent, ...requested}`，requested 为空会静默继承父会话模型 → 曾导致按量计费通道烧钱。
  默认角色不声明通道是**特例且安全**的，因为它不声明任何 provider/model，不存在「声明与实际不一致」。
- **worktree 永不自动删除**：未合并改动可能只在工作树里，自动删 = 丢代码。
- **不伪造状态**：拿不到就 `unknown`。
- **`active` 槽位是实例内 Map**：进程级重启必然清空，**不存在「重启泄漏槽位」**。
  （历史文档曾误记为 P0 缺陷，已用 `tests/restart-slot-reconciliation.test.mjs` 证伪。）
- **并发默认值是本插件的产品默认**（`limits`：全局 8 / 单会话 4 / worktree / serializeWrites）。
  作者本人在自己 profile 里手动设成 1/1 串行，那是**个人配置**，不是产品默认。

---

## 八、仍需真机验收的项（已知边界）

**未验证 ≠ 已损坏**，这些是作者声明的边界，接管者需要知道：

1. **Windows Electron 真重启**：任务在跑时重启，槽位/记录是否符合预期
2. **外部 CLI 真实计费矩阵**：各 provider 的 provider/model/effort 组合实测
3. **取消→重开的进程树清理**：Windows 上外部 CLI 子进程是否干净退出
4. **GUI 视觉验收**：布局、间距、颜色实际像素（自动化只能验 token 名）
5. **WorkBuddy 可移植性**：已出评估，结论**不建议移植**
   （见 `docs/design/portability-to-workbuddy.md`、`workbuddy-appserver-support.md`）

---

## 九、重要路径与备份

| 用途 | 路径 |
| --- | --- |
| 源码仓库 | `D:\MeetingStone` |
| 已安装插件 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-meetingstone` |
| 用户配置 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` |
| **升级前配置备份** | `%USERPROFILE%\.dsh\profile-backup-20261115\` |
| 打包产物 | `D:\MeetingStone\dsh-meetingstone-0.1.1.tgz`（`*.tgz` 已 gitignore） |
| DSH 宿主 | `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar` |

**回滚方式**：重新安装 `dsh-meetingstone-0.1.0.tgz`（可用 `install:safe --tgz ... --previous ...`），
或从备份目录还原 profile 配置。

---

## 十、交付物清单

| 类型 | 位置 |
| --- | --- |
| 源码 | `D:\MeetingStone`（`main` @ `cb22fe1`） |
| npm 包 | `dsh-meetingstone@0.1.1` |
| 本交接文档 | `docs/PROJECT-HANDOFF.md`（本文） |
| 独立审计复核报告 | `docs/review/independent-recheck-2026-11-14.md` |
| 0.1.1 发布清单 | `docs/release/0.1.1-checklist.md` |
| 旧配置归档 | `docs/reference/legacy-configuration.md` |
| 用户文档 | `README.md` / `README.en.md` / `docs/getting-started.*` / `scenarios` / `faq` |
| 变更记录 | `CHANGELOG.md` |

---

## 十一、移交后建议动作

**必做（影响包的可用性与安全）**：

1. **在网页撤销 npm token**（见 §四第 3 项）—— CLI 无法完成
2. 确认后续平台上 `dsh-meetingstone` 这个 npm 包名的归属（若换 npm 账号发布，需先转移包所有权）

**可选**：

3. 若要在 GitHub 上加 Release：<https://github.com/Railly1983/dsh-meetingstone/releases/new?tag=v0.1.1>
4. 真机验收 §八 的五项

**不需要做的**（已全部完成）：

- 代码、文档、CI、测试、门禁、标签、About 元数据、本机安装

---

*本文由开发会话在项目完结时生成，事实均经过当次实测核对。*
