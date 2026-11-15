# 项目交接文档 · MeetingStone（集合石）

> 最后更新：2026-11-15
> 交接范围：`D:\MeetingStone`（源码仓库）→ GitHub → npm
> 状态：**已发布终版 `0.1.1`，CI 全绿，门禁全绿**

本文是**项目级**交接文档，回答「现在是什么状态、怎么跑、哪里可能坑、下一步该做什么」。
与 [handoff.md](handoff.md) 区分：那份描述的是**插件功能**里的角色间交接模板，不是本项目交接。

---

## 一、一句话结论

集合石是 **DeepSeek Harness（DSH）的第三方插件**，做「按角色跨 CLI 派单」：
把「谁用什么 CLI、什么模型、什么职责」配成一张角色表，在 DSH 对话里用自然语言派活。

**当前已发布终版 `0.1.1`**，代码、文档、CI、门禁全部就绪，作者声明**后续不再更新**。

---

## 二、当前真实状态（2026-11-15 实测）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 源码版本 | `0.1.1` | `package.json` |
| Git HEAD | `d7f3805` | `git log -1` |
| 远端同步 | 已同步（工作区干净） | `git status -sb` → `main...origin/main` |
| GitHub CI | **5/5 全绿** | Windows/Ubuntu × Node 22/24 + 零依赖检查 |
| npm 已发布 | `0.1.1`，`dist-tags.latest = 0.1.1` | registry 实测 |
| 测试 | **721 tests / 719 pass / 0 fail / 2 skipped** | `npm test` |
| 发布门禁 | **10 PASS / 0 FAIL** | `npm run release:check` |
| 发布包 | 45 文件 / 约 910 KB | `npm pack` |
| 工具数 | 10 个 `meetingstone_*` | `verify-host-schema.mjs` |
| 代码规模 | `src` 约 20,142 行；tests 52 个文件约 16,900 行 | 实测 |

### ⚠️ 一处需要你知道的不一致

**本机安装的插件仍是 `0.1.0`，源码/npm 已是 `0.1.1`。**

```powershell
# 查看
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-meetingstone\package.json" -Raw | ConvertFrom-Json).version
```

是否升级到 `0.1.1` **需要你决定**。升级方式（用仓库自带的安全安装脚本）：

```powershell
cd D:\MeetingStone
npm run install:safe    # 会先备份 profile，再安装
```

> 不要用 `pnpm add` 手工替换，也不要在 DSH 运行时直接改 `node_modules`。
> 重启 DSH 也必须经你确认——历史上反复重启曾影响其他项目。

---

## 三、发版历史与本次（0.1.1）做了什么

| 版本 | 时间 | 内容 |
| --- | --- | --- |
| `0.1.0` | 2026-11-13 | 首个公开发布（跨 CLI 角色派单、10 工具、worktree 隔离、设置页 UI） |
| **`0.1.1`** | **2026-11-14** | **开箱即用默认角色 + 文档重写 + CI/门禁修复** |

### 0.1.1 的四类实质改动

**1. 开箱即用（用户明确要求）**

之前 `roles` 默认空数组，新用户装完看到「0 个角色」不知道怎么用。
现在内置 3 个默认角色，全部走 **DSH 原生子 Agent**，不绑定外部 CLI/模型，装完直接能派单：

| 角色 | roleId | 职责 |
| --- | --- | --- |
| 执行者 | `role-worker` | 实现与修改，交付改动文件与验证证据 |
| 审查员 | `role-reviewer` | 独立复核，只报有证据的问题 |
| 调研员 | `role-researcher` | 只读调研，区分事实与推测 |

三条硬约束（`src/roles/defaults.js`，有 10 项契约测试守护）：

1. **只在用户没有任何角色时生效** —— 一旦用户配过角色，完全不介入（不合并/不覆盖/不追加）
2. **只在内存注入，不写盘** —— 用户不点保存就不会被固化到 profile
3. **不绑定 CLI/模型** —— 跟随用户会话默认路由，不会重蹈静默计费事故

**2. 修掉一个真实产品 bug**

`src/cli/resolvers.js` 的 Appx 解析用了**运行平台的** `isAbsolute`，在 Linux/macOS 上
会把 `C:\Program Files\...` 判成相对路径而全部跳过 —— 也就是**非 Windows 用户永远探测不到 Codex**。
改用 `win32.isAbsolute`（Appx 只存在于 Windows）。

**3. 修复公开仓库 CI 长期全红**

CI 从来没装过依赖，4 个 GUI 测试 `import zod` 直接 `ERR_MODULE_NOT_FOUND`。
另外 3 个测试有跨平台假设错误（见 §五）。

**4. 文档与仓库清理**

- README 中/英重写，围绕「解决什么问题 → 场景 → 与 DSH 原生区别 → 三步试用」
- 新增快速开始（中/英）、典型场景、FAQ
- 安装/配置文档重写，旧配置归档到 `docs/reference/legacy-configuration.md`
- **移除** `.meetingstone.json`（作者个人分工）与 `personas.json`（零引用，曾被误读成默认配置）
- **移除** README 里的「48 格对照实验」引用（样本不足，不足以代表真实使用）

---

## 四、怎么跑（日常命令）

环境约束（重要）：

```powershell
# 必须用 DSH 内置 node（v24）。系统 node 是 v20，跑 pnpm 会崩 node:sqlite。
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
```

| 目的 | 命令 |
| --- | --- |
| 全量测试 | `npm test`（= `node scripts/run-tests.mjs`，**不要**用 `node --test tests/`） |
| 四条门禁 | `npm run verify` |
| 发布就绪（10 门禁） | `npm run release:check` |
| 打包 | `npm pack` |
| 安全安装到 profile | `npm run install:safe` |
| 工具 schema | `node scripts/verify-host-schema.mjs` |
| 客户端注入冒烟 | `node scripts/smoke-client-inject.mjs` |
| 真机验收 | `npm run acceptance` |

### 发新版的完整流程

1. 改版本号 **5 处**：`package.json`、`src/index.js` `PLUGIN_VERSION`、
   `src/client/index.js` `PLUGIN_VERSION`、`src/cli/capabilities.js` 的 `version`、三份 README 的「当前发布版本」
2. 新建 `docs/release/<version>-checklist.md`（**门禁按它的 mtime 取目标版本**）
3. `CHANGELOG.md` 加 `## [<version>]` 条目
4. `npm run release:check` → 必须 10 PASS
5. `npm pack` → `npm publish`
6. `git tag v<version> && git push --tags`

> `v0.1.1` 标签**尚未创建**（`v0.1.0` 有）。需要的话补：
> ```powershell
> git tag v0.1.1 && git push origin v0.1.1
> ```

---

## 五、踩过的坑（重要，避免重复）

### 5.1 asar 偏移算错导致门禁假失败（2026-11-15 修复）

`scripts/smoke-client-inject.mjs` 从宿主 `app.asar` 抽 cordis 做真实冒烟。
原代码用 `base = 16 + headerSize` 定位数据区，**实际错 3 字节** —— asar header 后有 4 字节对齐填充，
正确公式是 `Math.ceil((16 + headerSize) / 4) * 4`。

后果：抽出的每个文件开头都带着上一段代码的碎片（`);`、`:!0})})();`），
报 `ERR_INVALID_PACKAGE_CONFIG` / `SyntaxError`，看起来像插件代码坏了，实际与插件无关。

修复后加了 `verifyIntegrity()`：用 asar 自带的 `integrity.hash` 校验每次抽取，
偏移错了会立刻报「integrity 不符」而不是神秘的语法错误。**已用负对照验证。**

### 5.2 跨平台测试陷阱（CI 全红根因）

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| Appx 测试 Linux 失败 | 用了运行平台 `isAbsolute` | 代码改用 `win32.isAbsolute` |
| project-load 2 例失败 | 测试用 `win32.join` 造键，产品用平台 `join` | 测试改用平台 `join` |
| projectKey 断言失败 | 产品按平台折叠大小写，测试硬编码小写 | 断言按平台分支 |
| worktree 2 例失败 | CI Windows 的 `%TEMP%` 是 8.3 短名 `RUNNER~1`，`realpath` 给长名 | 用 `realpathSync.native` 规范化 |

**通用教训**：测试里凡是涉及路径的，都要问一句「这在 Linux 上也成立吗」。
本项目历史上多次出现「本地全绿、CI 全红」。

### 5.3 CI 日志读不到

GitHub Actions 的日志需要认证才能读，失败时只看到 `exit code 1`。
已提供 `scripts/ci-test.mjs`：把失败测试名写成 **公开 annotation**，在提交页直接可见。
CI 现在用它代替裸 `npm test`。

### 5.4 npm 发布的两个坑

**a) token 失效**：`~/.npmrc` 里可能存着已失效的 token（`E401`）。
你账号下有一个可用的 `dsh-meetingstone-publish` token（Bypass 2FA）。
发布时用临时 userconfig，不动全局 `.npmrc`：

```powershell
$tmp = "$env:TEMP\ms-npmrc"
"registry=https://registry.npmjs.org/`n//registry.npmjs.org/:_authToken=<TOKEN>" | Set-Content $tmp -Encoding ascii -NoNewline
npm publish --userconfig $tmp
```

**b) registry 缓存延迟**：发布后立刻查可能还是旧版本，实际已成功。
判断依据是再次 publish 报 `403 You cannot publish over the previously published versions`。

> ⚠️ 安全提醒：文中出现的 token 应视为**已泄露**，建议到
> <https://www.npmjs.com/settings/railly1983/tokens> 撤销并重新生成。

### 5.5 npm 2FA 政策变化

npm 顶部已警告：**Bypass-2FA token 将被限制**，直接发布（direct publishing）2027 年 1 月生效。
届时需要一个带 2FA 的发布流程（网页点确认或 security key）。

---

## 六、代码结构速查

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
│   ├── adapter.js        宿主 subagents 适配器（★ agentOptions 钉路由，计费事故修复点）
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

### 关键设计决策（不要轻易改）

- **始终显式钉死子 Agent 路由**（`buildChildAgentOptions`）：宿主默认 `{...parent, ...requested}`，
  requested 为空会静默继承父会话模型 → 曾导致按量计费通道烧钱。默认角色不声明通道是**特例且安全**的，
  因为它不声明任何 provider/model，不存在「声明与实际不一致」。
- **worktree 永不自动删除**：未合并改动可能只存在于工作树里，自动删=丢代码。
- **不伪造状态**：拿不到就 `unknown`，不把「装了」当「有额度」。
- **`active` 槽位是实例内 Map**：进程级重启必然清空，不存在「重启泄漏槽位」。
  （历史文档曾误记为 P0 缺陷，已用 `tests/restart-slot-reconciliation.test.mjs` 证伪。）

---

## 七、仍需真机验收的项（已知边界，未验证不等于坏）

这些**没有**在 CI/单测里覆盖，属于作者声明的边界：

1. **Windows Electron 真重启**：任务在跑时重启，槽位/记录是否如预期
2. **外部 CLI 真实计费矩阵**：各 provider 的 provider/model/effort 组合实测
3. **取消→重开的进程树清理**：Windows 上外部 CLI 子进程是否干净退出
4. **GUI 视觉验收**：布局、间距、颜色实际像素（自动化只能验 token 名）
5. **WorkBuddy 可移植性**：已出评估文档，结论是**不建议移植**（见 `docs/design/`）

---

## 八、下一步建议

按优先级：

1. **决定是否把本机插件升级到 `0.1.1`**（`npm run install:safe`，需你确认重启）
2. **补 `v0.1.1` git 标签**（npm 已有，GitHub 标签缺失）
3. **撤销已泄露的 npm token**，重新生成一个
4. **GitHub About 填写**：仓库 `description` 仍为 `null`、`homepage` 为空
   （topics 已有 `dsh-plugin` 等，无需再改）
5. 可选：做一次真机验收（§七 的五项）

若确实到此为止、不再更新，**1–4 建议做完**，它们影响的是「别人怎么找到并信任这个包」，
而不是代码本身。

---

## 九、对外链接

- GitHub：<https://github.com/Railly1983/dsh-meetingstone>
- npm：<https://www.npmjs.com/package/dsh-meetingstone>
- 安装（用户视角）：DSH 插件市场搜索 `dsh-meetingstone`，或
  ```powershell
  dsh plugin --profile desktop add dsh-meetingstone
  ```
  （`desktop` 是示例 profile 名，需换成实际使用的）

---

## 十、交付物清单

| 类型 | 位置 |
| --- | --- |
| 源码 | `D:\MeetingStone`（Git `main` @ `d7f3805`） |
| npm 包 | `dsh-meetingstone@0.1.1` |
| 本次独立审计复核报告 | [docs/review/independent-recheck-2026-11-14.md](review/independent-recheck-2026-11-14.md) |
| 0.1.1 发布清单 | [docs/release/0.1.1-checklist.md](release/0.1.1-checklist.md) |
| 旧配置归档 | [docs/reference/legacy-configuration.md](reference/legacy-configuration.md) |
| WorkBuddy 评估 | `docs/design/portability-to-workbuddy.md`、`workbuddy-appserver-support.md` |
| 打包产物（本地） | `dsh-meetingstone-0.1.1.tgz`（`*.tgz` 已 gitignore） |
