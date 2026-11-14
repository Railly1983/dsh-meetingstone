# 集合石 0.1.0 · 独立审计复核（本机 DSH / 真实源码）

**时间**：2026-11-14
**复核对象**：Codex 交付包 `MeetingStone-review-and-docs-v1.1.zip`（`INDEPENDENT_REVIEW.md` / `review/AUDIT-REPORT.zh-CN.md`）与线上仓库 `main@790df90`
**复核方式**：本地完整源码静态核对 + `npm test` 全量运行 + 新增运行级探针（生产代码）
**范围限制**：未重启 DSH、未做真机 GUI 视觉验收、未做真实外部 CLI 计费派单矩阵。运行时探针是**进程内等价模拟**，不等同 Windows Electron 进程重启的端到端测试。

---

## 一、总裁决

**Codex 的文档方向正确、可以采纳；但有 2 条关键工程结论证据链不成立，不能照单执行。**

| 结论 | 判定 |
|---|---|
| README / 安装文档过时，需重写 | ✅ 确认（线上 `main` 仍是 alpha.20 旧版） |
| 设置页信息层级、首次成功路径不清 | ✅ 确认（文案层面；`src/client/index.js` 已达 3216 行） |
| 「五个西游角色是产品默认配置」 | ❌ **误报**（`personas.json` 不参与运行；真正默认角色数为 0） |
| 「DSH 重启必然泄漏并发槽位」 | ❌ **误报**（运行级探针证伪；见 §三） |
| 「`quota` 枚举仍含 `exhausted`」 | ❌ **误报**（常量已删，只残留 JSDoc） |
| 架构文档写 8 个工具、实际 10 个 | ✅ 确认（`docs/architecture.md:23`、`src/dsh/register.js:375`） |
| 配置文档写「第一版没有 UI」/ 会话覆盖 | ✅ 确认（`docs/configuration.md:5-7` 与实现 B3 冲突） |
| worktree 不自动清理 | ✅ 确认（`src/worktree.js:18-19`，且是**刻意的正确性设计**，不是缺陷） |
| 发布门禁 D1 断言可靠 | ❌ **新发现**（见 §九：`verify-d1-render.mjs` 是绑定私有 profile 的伪测试，已修） |

**Codex 未覆盖、本次复核额外揪出的两类问题**：

1. **发布门禁伪测试**（§九）：`release:check` 的 D1 门禁把开发者私有 profile 当产品契约，
   且断言的 `snapshot` 从未喂给任何渲染函数；用户删角色就红、产品代码改坏却可能绿。
   已改为生产模块契约断言 + 负对照实证。
2. **Codex 重写稿丢失用户硬性要求**：原 README 里「多子代理模式会大幅度增加 token
   消耗，建议仅在重要长任务情境下启用」及 48 格实测出处被删成泛泛一句。
   本次已补回中英文两份，并保留实测数据链接。

---

## 二、最重要的一条：线上 README 没有"新版"

用户说"GitHub 上的 README 我也让 codex 改了一版"。实测：

- `GET /repos/Railly1983/dsh-meetingstone/branches` → 只有 `main`，SHA `790df90`
- `GET .../pulls?state=all` → `[]`
- `GET .../commits?per_page=10` → 最新提交仍是 `release: 0.1.0 first public release`
- `raw.githubusercontent.com/.../main/README.md` → **仍是 `0.1.0-alpha.20`、`D:\MeetingStone`、214 项测试**

结论：审核包里的重写稿是**候选文件，未推送**。本次本地改完需要用户确认后才推 GitHub。

另：仓库 `topics` 已含 `dsh-plugin` / `dsh-plugins`（之前记的"待用户自己加"已完成），但 `description` 仍为 `null`、`homepage` 为空 → D-10 部分成立。

---

## 三、运行级复核：R-01 / CODE-02「重启必然泄漏槽位」证伪

### 3.1 这个结论的来源链

1. `docs/plan/2026-11-12-slot-leak-critical.md` 记录了一次**真实阻塞**：重启后所有派单返回 `WRITE_LIMIT_TOTAL`。
2. 但同一文档第 43-50 行自己写着：

   > 「等等，重启应该清空内存。那为什么还是 4？」→「## 需要进一步确认」→
   > 两种可能：(1) 重启没有真正发生（进程还在用旧的 Map）(2) 磁盘上有残留状态被重新加载。

3. `CHANGELOG.md:591-595` 却把它固化成「**每次重启必然泄漏槽位**，根因未修」。
4. Codex 审核包 R-01 / CODE-02 引用了 CHANGELOG，未验证源码。

### 3.2 源码事实

- `src/dispatch/dispatcher.js:450` `const active = new Map()` —— **dispatcher 实例内的纯内存 Map**。
- `src/index.js:393` `const dispatcher = createDispatcher({...})` —— **插件每次 apply 都新建**。
- `src/dispatch/dispatcher.js` 中 `active.set(` 只有 1 处（同步占位，第 788 行）；无 `readRecords` / `createRunStore` / `listRuns` 等任何磁盘回填路径。
- `src/run-store.js:723-726` 的 `interrupted` 是**读取时投影**，不回写磁盘、更不重建 `active`。

即：**进程/宿主重启 → 新进程 + 新 dispatcher + 空 `active` → 不可能继承旧槽位。**
那次真实阻塞最可能是文档自己列的第 1 种可能（宿主未真正重启，旧进程仍在用旧 Map），
或当时 `maxParallelWritesTotal=4` 被 4 个仍在运行的任务占满。

### 3.3 运行级探针（已提交为回归测试）

新增 `tests/restart-slot-reconciliation.test.mjs`，用**真实** `createDispatcher` + `createRegistry`，4 个用例：

| 用例 | 结果 |
|---|---|
| 负对照：`onFinish` 不触发 → 槽位占满、第 3 次派单 `WRITE_LIMIT_TOTAL` | ✅ 证明探针能抓到真实占用 |
| 新建 dispatcher 实例（重启等价路径）→ `stats().active === 0`，可正常派 2 单 | ✅ **证伪"必然泄漏"** |
| 源码契约：`active.set` 恰好 1 处、dispatcher 不读运行记录回填 | ✅ |
| `onFinish` 到达后槽位释放、可继续派单 | ✅ |

`node --test tests/restart-slot-reconciliation.test.mjs` → **4 pass / 0 fail**。

**裁决**：R-01/CODE-02 的"已知 P0 缺陷"降级为 **「历史一次未复现的阻塞，根因未定位；当前源码在进程级重启路径上不存在该泄漏」**。
仍保留 `CHANGELOG` 的 Known Issue 措辞修正 + 该探针作为守护；**不新增 reconciliation 逻辑**（没有可修复的缺陷，自研反而增加风险）。

⚠️ 仍待真机验收：Windows Electron 真重启、任务在跑、新版宿主是否复用插件实例。这需要用户批准重启，本轮不做。

---

## 四、误报拆解

### 4.1 D-05 / UX-02「默认角色偏向个人工作流」

Codex 说：`personas.json` 绑定 5 个西游角色与特定模型，是产品默认值，应改成「执行者/审查员/助手」且**不覆盖老用户配置**。

本地证据：

| 事实 | 出处 |
|---|---|
| `package.json` `files` 只有 `src/ cordis.patch.yml README.md LICENSE` | `package.json:12-17` |
| `scripts/verify-package.mjs:36` 把 `personas.json` 列为**禁止打进 tarball** 的文件 | 发布门禁 |
| `git grep 'personas.json'` 在 `src/**/*.js` 中 **0 引用**；只有 4 处文档/脚本提及 | 全仓 |
| `src/config.js:129` `roles: S.array(RoleSchema).default([])` | **新装默认 0 个角色** |
| `src/roles/template.js` 的 `FIVE_ROLE_TEMPLATE` 只定义职责、**不绑定 CLI/模型**，且 `seedFiveRoleTemplate()` 只被 `tests/role-template.test.mjs` 调用 | 生产代码无调用点 |
| 用户实际看到的 5 个西游角色来自 **`C:\Users\30673\.dsh\profiles\desktop\cordis.patch.yml`**（本机 profile） | 实测 |

结论：**发布包里根本不含这批角色；新用户装完是 0 角色，不会被强制绑定付费模型。**
真正的问题是另外两个：

1. `src/client/index.js:1032` 设置页**无条件**显示卡片标题「取经五人组」（`templateName`），
   即使快照里 0 个角色也显示 —— 这才是"看起来像默认团队"的观感误导。
2. `README.md` / `README.zh-CN.md` / `examples/meetingstone.desktop.yml` 用西游五角色表当**主叙事**，
   让新读者以为必须这样配。

所以正确修法不是"迁移默认角色"（没有默认角色可迁移、老用户配置也不会被碰），
而是：**修正这张卡片的文案，让它反映真实角色数；README 改成通用「执行者/审查员」示例。**

### 4.2 D-08「函数 JSDoc 仍列 exhausted」

`src/gui/state-model.js:46-58`：`QUOTA` 常量已是 `{ AVAILABLE, UNKNOWN, NOT_APPLICABLE }`，
`EXHAUSTED` 在 2026-11-12 已删除，且有测试 `tests/state-model.test.mjs:90` 守护。
残留的只是 `@returns` 注释里写了 `'available' | 'exhausted' | ...`（第 265 行）与 `deriveRoleView` 的 JSDoc（第 333 行）。
→ **注释瑕疵，不是类型/行为缺陷**。清掉注释即可，不需要改逻辑。

### 4.3 D-09「worktree 不自动删除」

`src/worktree.js:18-19` 明确写了「一律不自动删除：未合并的改动可能只在工作树里，自动删除等于丢代码」。
这是**刻意的安全设计**，Codex 自己也写了「不自动删未合并改动」。记为"已确认设计取舍"，不是待修缺陷。

---

## 五、确认成立的问题（本轮修复）

| ID | 证据 | 处理 |
|---|---|---|
| D-01 | `README.md:9` / `README.zh-CN.md:7` 写 `0.1.0-alpha.20`；`package.json:3` = `0.1.0` | 采用 Codex 重写稿并本地校准 |
| D-02 | `README.md:68-88` 用 `D:\MeetingStone` + `214 项`；`docs/installation.md:25,30` 用 `0.0.1.tgz`、`D:\MeetingStone`、未定义 `$node/$pnpm` | 替换为市场安装 / npm 包安装；开发安装移入贡献文档 |
| D-03 | `docs/configuration.md:5-7`「第一版没有 UI」「项目级/会话级覆盖」与 B3 实现冲突 | 归档旧文，写现行配置路径 |
| D-04 | `docs/architecture.md:23`「八个工具」、`src/dsh/register.js:375`「注册八个工具」；实际 `TOOL_NAMES` 10 个且有测试守护 | 改成 10 并与测试对齐 |
| D-07 | `src/client/index.js:2`「GUI 只读」、`:2241`「会话覆盖仍只走右侧栏」、`:2340`「canRestore 只在来源是 session」 | 清理过时注释；`src/index.js:171,403` 同类 |
| D-10 | GitHub `description=null`, `homepage=""` | 需用户在网页补（本轮不擅自改远端） |
| UX-01 | 「取经五人组」卡片无条件渲染 | 改成反映真实角色数的中性文案 |

**P1 不做**：`src/client/index.js` 3216 行拆分、`capabilities.js` / `adapter.js` 重构。
理由：用户长期原则「尽量复用 DSH 自带功能」「最简化」；审核包自己也写「避免激进重构」「不因代码过长删除安全校验」。
本轮只做零风险注释/文案清理。

---

## 六、R-02 / R-03 / R-04 的边界

| 项 | 本机已有的守护 | 仍缺什么 |
|---|---|---|
| R-02 取消→重启竞态 | `docs/plan/2026-11-12-cancel-timing.md` + `tests/lifecycle.test.mjs`（dispose 未确认保留槽位）、`tests/steer.test.mjs:571`「原任务停不干净→拒绝重开」 | Windows 真机进程树清理的端到端 |
| R-03 模型静默继承计费 | `src/dsh/adapter.js:1137-1181` 显式 `agentOptions` 钉死 in-process 路由；`tests/dsh-adapter.test.mjs:842`、`tests/adapter-route-evidence.test.mjs` | 各 provider 真实派单计费矩阵（需真机 + 低预算账号） |
| R-04 CLI 状态可操作提示 | `src/cli/preflight.js` 三态 + `tests/cli-preferences.test.mjs` 全套 | 真机 4 种失败态的文案验收 |

这三项**不能凭静态阅读宣称通过**，本轮不写「已验证」，留待用户批准后的真机窗口。

---

## 七、验收

- `npm test` → 704 tests / 702 pass / 0 fail / 2 skip（含新增探针 4 项；改动前基线 700 / 698 / 0 / 2）
- 新增 `tests/restart-slot-reconciliation.test.mjs` → 4 pass / 0 fail，含负对照
- `npm run verify` → PASS（发布包 44 文件 / 902.6 KB）
- `npm run release:check` → 见 §九与本轮最终结果
- 相对链接校验：10 份改动/新增文档，0 断链
- 未执行：DSH 重启、真机 GUI、外部 CLI 真实计费派单

---

## 八、给维护者的行动清单

1. **本轮已做**：README 中英文重写（补回 token 实测原句）、中文别名同步、安装/配置文档重写 + 旧文归档、
   4 份新用户文档、架构/CHANGELOG/事故文档数字与结论校准、过时注释清理、模板卡文案、
   运行级探针、D1 门禁伪测试整改、本复核报告。
2. **需用户批准**：推 GitHub、发新版 npm（当前 `latest=0.1.0`）、重启 DSH 做真机验收。
3. **需用户在网页操作**：GitHub About 的 Description / Website（D-10）；可选 GitHub Release。
4. **可选低风险**：把 `personas.json` 从仓库移到 `examples/` 并改名 `personas.example.json`，
   彻底消除"它是默认配置"的误读；但 `verify-package.mjs` 已禁止它进包，**非必须**。

---

## 九、Codex 未发现：发布门禁是绑定私有 profile 的伪测试

`npm run release:check` 首次跑出 `1 FAIL / 9 PASS`；D1 渲染核对 4 项红：

```
❌ CodeBuddy 有模型值        ❌ 空
❌ Codex 有模型值            ❌ 空
❌ DSH 与 CodeBuddy 都有 high
❌ 真实 profile 至少有 5 个启用角色   3 个：唐僧/八戒/沙僧
```

### 9.1 定性

`scripts/verify-d1-render.mjs` 有两处结构性问题：

1. **硬编码私有路径**：`readFileSync('C:/Users/30673/.dsh/profiles/desktop/cordis.patch.yml')`
   与 `readFileSync('D:/MeetingStone/src/client/index.js')`。换台机器直接崩。
2. **伪测试**：`buildSnapshot()` 自己造出 `snapshot.global.capabilities`，
   6 项断言全部在测这份自造 fixture；`snapshot` **从未喂给任何渲染函数**。
   脚本头部却写着「把设置页真实渲染出来」。产品代码改坏它照样绿，
   用户删一个角色它反而红 —— 完全违背「能失败的测试才是测试」。

这 4 项 FAIL 与本次文档/文案改动**无关**（`git diff --name-only` 未涉及该脚本），
是 HEAD 上既有的发布门禁缺陷；用户 profile 从 5 角色减到 3 后就一直红。

### 9.2 修法（不降低门槛，改为真契约）

- 路径改为相对仓库（`fileURLToPath(import.meta.url)`），删除 `buildSnapshot` / React stub /
  `flatten` / `collectNodes` 等全部死代码。
- 6 项伪断言换成**直接 import 生产模块**的契约断言：
  `CLI_IDS` 固定 4 个且顺序稳定、4 个 CLI 都有名称、`STATIC_CATALOG` 覆盖全部 CLI、
  DSH 静态模型必须为空（模型只能来自宿主/探测，不写死）、Claude 静态别名与档位非空、
  `QUOTA` 三档且不含 `exhausted`、`ROLE_COLOR` 两色、
  `deriveRoleColor` 启用+就绪→绿 / 禁用→灰（负对照）、额度不参与颜色派生。
- 结果：26 项全 PASS。

### 9.3 负对照（关键）

只改断言不够，必须证明它们**会失败**。临时向 `src/gui/state-model.js` 的
`ROLE_COLOR` 注入 `YELLOW: 'yellow'` 后重跑：

```
❌  ROLE_COLOR 只有 green/gray
结果：25 PASS / 1 FAIL / 26 项      退出码 1
```

还原后回到 `26 PASS / 0 FAIL / 退出码 0`；`git diff` 确认源码只剩预期的 JSDoc 修改，
临时注入脚本已删除。**断言有效，不是摆设。**

> 顺带修正：`src/cli/capabilities.js` 的 DSH 静态模型数为 0 是**刻意设计**
> （模型必须来自宿主 `listModels` / 探测），旧断言却要求「DSH 有模型值」，
> 等于逼迫代码写死模型列表。新断言改为守护"不得伪造"。
