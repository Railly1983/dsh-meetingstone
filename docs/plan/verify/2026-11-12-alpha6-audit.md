# 0.1.0-alpha.6 代码审计与清理盘点

> 审计日期：2026-11-12 15:50 ~ 16:05（Asia/Shanghai）
> 审计基线：`main` @ `c44bd96`
> 审计范围：B3 残留（只读）、仓库卫生（只读）、版本一致性
> 纪律：**本次未删除/移动/修改任何被审计文件**；产品代码零改动；清理动作只列清单待批准
>
> ⚠️ 基线说明：审计开始时（15:50）`git status --porcelain` 为空。审计过程中（15:53 起）仓库根目录开始出现 `.d1-verify*` 未跟踪文件（`.d1-verify{,2,3}.{err.txt,out.json,tmp.mjs}`，数量随另一个 teammate 的采集轮次增长），系**并发执行的 D1 真机验收证据采集脚本**，非本次审计产物。本次审计**未读写、未修改**这些文件，仅在本报告 §B3 与清理清单中登记。审计结束时 `git status` 的唯一本次新增项为 `docs/plan/verify/2026-11-12-alpha6-audit.md`；**已跟踪文件零修改**（`git status | Where-Object { $_ -match '^\s*M' }` 为空）。

## 结论摘要

| 维度 | 结论 |
| --- | --- |
| B3 代码层下线 | ✅ **干净**：`src/` 下 0 处指向 4 个已删文件的 import/require；3 个下线 remote 在 `src/` 下 0 命中 |
| B3 契约层残留 | ⚠️ **有残留**：`SESSION_REMOTE_TYPES` 仍保留 3 个会话覆盖专用类型符号，两侧共 7 处声明+5 个死局部函数 |
| B3 文档/注释残留 | ⚠️ **4 处过时**：`docs/configuration.md` 整节 API 已失效、`docs/gui-0.2.0.md` 5 处、`src/` 内 2 处注释 |
| `src/session/config.js` 存活 | ✅ **必须保留**：5 个生产调用方（任务书假设「应只剩测试」不成立，详见 §1.3） |
| 版本一致性 | ✅ 三处均 `0.1.0-alpha.6`，CHANGELOG 一致 |
| 发布清单准确性 | ⚠️ §3/§4 未勾选但实际已完成；§0 有两处事实性夸大（见 §3.3） |
| 仓库卫生 | ⚠️ **99.16 MB / 34 个已合并工作树 + 22 个 tgz + 2 个 canary profile** 可回收 |
| 阻塞发布项 | **0 条** |

---

# 任务 A：B3 残留审计

## A1. 是否还有 import/require 指向 4 个已删文件

**结论：✅ 无残留。代码层已完全下线。**

证据：

```
$ git grep -n -E "(session-remote|session-root|gui/session|session/store|from ['\"].*session\.js|require\(.*session\.js)" -- .
--- exit: 1 ---     ← git grep 无匹配时 exit 1

$ foreach ($f in @('src\gui\session.js','src\gui\session-remote.js','src\gui\session-root.js','src\session\store.js')) { Test-Path $f }
src\gui\session.js         -> False
src\gui\session-remote.js  -> False
src\gui\session-root.js    -> False
src\session\store.js       -> False
```

已安装产物与磁盘一致（`C:\Users\30673\.dsh\profiles\desktop\node_modules\dsh-meetingstone`）：

```
--- src/gui ---        config-api.js 13615 / host.js 28998 / state-model.js 14655 / typert-spec.js 10034 / typert.js 5882   （5 个）
--- src/session ---    config.js 33450                                                                                     （1 个）
--- 已删文件是否存在 --- 4 项全部 False
--- version ---        0.1.0-alpha.6
```

与 Lead 陈述吻合：`src/gui/` = 5 文件，`src/session/` = 1 文件，4 个文件真删除。

## A2. 三个下线 remote（`setSessionOverride` / `clearSessionOverride` / `getSessionConfig`）在 `src/` 下是否还有注册/调用/类型声明

**结论：✅ `src/` 下 0 处注册与调用；⚠️ 但类型符号（typeSymbol）有残留，见 A4。**

```
$ git grep -n -E "setSessionOverride|clearSessionOverride|getSessionConfig" -- src/
  (0 hits in src/)
```

全仓命中位置分两类：

| 位置 | 性质 | 判定 |
| --- | --- | --- |
| `tests/gui.test.mjs:967,1380` | **反向断言**（`doesNotMatch` / `includes === false`） | ✅ 正确，是防回归护栏 |
| `tests/gui-primitives.stub.test.mjs:333` | **反向断言**（源码审计 `doesNotMatch`） | ✅ 正确 |
| `tests/gui.test.mjs:508-518` | 测试夹具里给 stub 造的假 remote 对象 | ✅ 无害（仅在测试作用域） |
| `scripts/smoke-client-inject.mjs:274-276,143,317` | **正向断言旧契约**：期望 `descriptors.length === 9` 且含 3 个已删方法 | 🔴 **已失效，必挂**（见 §1.7） |
| `docs/configuration.md`、`docs/gui-0.2.0.md` | 历史文档 | ⚠️ 过时（见 A5） |

`scripts/smoke-client-inject.mjs:269` 仍写着 `assert.equal(..., 9, 'list + 8 个 strict 方法（会话3+配置5）')`，而 B3 后实际是 6 个（`list` + 5 配置方法）。该脚本**不在 `npm test` 链路内**（`scripts/run-tests.mjs` 内无 `smoke` 匹配），因此 541 测试全绿并不覆盖它 —— 这是一个「测试全绿但冒烟脚本已坏」的盲区。

## A3. `src/session/config.js` 是否还有生产调用方

**结论：🔴 任务书假设不成立。它不是测试专属模块，仍有 5 个生产调用方，绝对不能删。**

```
$ git grep -n "session/config.js" -- .
src/config/global-writer.js:29:import { sanitizeRolePatch } from '../session/config.js'
src/gui/state-model.js:26:   import { fieldSource } from '../session/config.js'
src/index.js:28:              import { resolveEffectiveConfig } from './session/config.js'
src/project/write.js:24:      import { SESSION_CONFIG_ERRORS, sanitizeRolePatch } from '../session/config.js'
tests/role-template.test.mjs:25 / tests/state-model.test.mjs:36   ← 测试
```

生产调用方 **4 个**（`global-writer.js` / `state-model.js` / `index.js` / `project/write.js`），测试 2 个。B3 只删掉了 `store.js` / `session.js` 这条**持久化会话覆盖**的写入路径，`resolveEffectiveConfig`（全局+项目两层合并）、`sanitizeRolePatch`、`fieldSource` 仍在服务配置读取与设置页来源展示。

⚠️ 因此「`src/session/config.js` 只剩测试引用」这一前提若被采信并据此删除，会直接炸掉插件入口。**建议在 B3 后续清理中明确标注该文件不可删。**

## A4. `src/gui/typert-spec.js` 的 `SESSION_REMOTE_TYPES` 是否残留会话覆盖类型

**结论：⚠️ 残留。5 个键里有 3 个是会话覆盖专用（`sessionId` / `field` / `sessionConfigView` / `overrideResult` —— 准确说是 4 个），且两侧各复制一份。**

```js
// src/gui/typert-spec.js:29-40
export const SESSION_REMOTE_TYPES = Object.freeze({
  sessionId: 'dsh-meetingstone/types#SessionId',              // ← 残留
  roleId: 'dsh-meetingstone/types#RoleId',                    // 仍需（全局角色写）
  field: 'dsh-meetingstone/types#OverrideField',              // ← 残留
  value: 'dsh-meetingstone/types#JsonValue',                  // 仍需（patch/role）
  sessionConfigView: 'dsh-meetingstone/types#SessionConfigView',   // ← 残留
  overrideResult: 'dsh-meetingstone/types#SessionOverrideResult',  // ← 残留
  cliName / booleanValue / jsonResult,                        // 仍需
})
```

`src/client/index.js:102-112` 有一份逐字复制的 `SESSION_TYPES`，由 `tests/gui.test.mjs:1326` 做 `deepEqual` 双向断言锁死。**这意味着清理必须两侧同步改，否则测试失败。**

连带产生的**死局部代码**（已逐个用精确 grep 确认「仅声明、无引用」）：

| 文件:行 | 符号 | 精确证据 |
| --- | --- | --- |
| `src/gui/typert-spec.js:105` | `const sessionId = () => ...` | 仅 1 次有效出现（105 声明；30 是对象键、104 是注释） |
| `src/gui/typert-spec.js:109` | `const field = () => ...` | 仅 109 声明；32 是对象键、68 是注释、142 是 `z.enum('field')` 字符串字面量 |
| `src/gui/typert-spec.js:119` | `const sessionConfigView = () => z.object({...})` | 仅 119 声明 + 34 对象键 |
| `src/gui/typert-spec.js:131` | `const overrideResult = () => z.object({...})` | 仅 131 声明 + 35 对象键 |
| `src/client/index.js:118` | `const sessionIdCodec = () => ...` | 仅 1 次出现 |
| `src/client/index.js:122` | `const fieldCodec = () => ...` | 仅 1 次出现 |

即：**6 个死局部函数 + 4 个死 typeSymbol 键（两侧重复=8 处声明）**。这些是 B3 的纯遗留物，不影响运行（真机在跑的是 6 个 descriptor），但会误导后续维护者以为会话接口还在。

## A5. 注释/文档里的过时引用（含 `host.js:14` 准确性核对）

**结论：`host.js:14` 的注释本身是「准确」的，但整段描述已自相矛盾；另有 1 处 `src/` 注释与 6 处文档明确过时。**

### `host.js:2-14` 逐行核对

```js
  3: * GUI 数据提供者（Host half）：无参只读快照 + 三个 strict 会话方法。
 11: *   browser `ctx.remote.meetingstone.list()` 等（B3：会话级 remote 已下线）
 13: *     → 同一 service 的会话方法
 14: *     → `src/gui/session.js`（已随 B3 删除）
```

| 行 | 判定 |
| --- | --- |
| `:14` 「已随 B3 删除」 | ✅ **事实正确**（`Test-Path src\gui\session.js` → False） |
| `:3` 「三个 strict 会话方法」 | 🔴 **过时**：实际是 5 个配置方法，0 个会话方法；`GUI_STRICT_METHODS = [...CONFIG_REMOTE_METHODS]`（`typert-spec.js:52`） |
| `:13` 「同一 service 的会话方法」 | 🔴 **过时**：会话方法已不存在 |
| `:11` 「B3：会话级 remote 已下线」 | ✅ 正确 |

所以 `:14` 是「准确的孤证」—— 它准确描述了一个已经不存在的调用链。整段 §数据链路 第二块应整体删除，而不是只保留 `:14`。

### 其余过时引用

| 文件:行 | 内容 | 判定 |
| --- | --- | --- |
| `src/gui/config-api.js:6` | `` * - 会话：`src/gui/session.js`（已有，P0-S0） `` | 🔴 指向已删文件，且「已有」为事实错误 |
| `docs/configuration.md:307-325` | 整节「新增/改字段的宿主侧 API（`src/session/store.js` + `src/gui/session.js`）」，含 `store.setOverride` / `store.clearOverride` / `store.get` / `getSessionConfig` / `clearSessionOverride` 签名 | 🔴 **整节已失效**，是误导性最强的一处（文档教用户调用已删除的 API） |
| `docs/gui-0.2.0.md:246,251,312,417-419` | 称 3 个已删文件承担业务层/sessionId→cwd 解析 | ⚠️ 历史设计文档，建议加「已废弃」头注而非逐行改 |
| `docs/gui-0.2.0.md:816` | B3 变更说明，**正确记录了删除动作** | ✅ 保留（这是变更史，不是当前态描述） |
| `src/session/config.js:26` | 注释仍提 `.meetingstone/sessions/<sessionId>.json` | ⚠️ 说明历史局限，`src/` 已无任何代码读取该路径（`git grep "sessions" -- src/` 仅此 1 条注释） |

## A6. 死代码：导出了但无人使用的函数

**结论：确认 4 个 B3 遗留死导出（`src/session/config.js`），另有 8 个「仅本文件内部或仅测试使用」的低风险导出。**

### 🔴 B3 直接遗留（可安全删，已用 git 历史溯源证明）

| 文件:行 | 符号 | 证据 |
| --- | --- | --- |
| `src/session/config.js:464` | `diffRoleOverride` | 全仓仅剩声明 + 2 处文档提及；唯一调用方 `src/session/store.js` 已随 B3 删除 |
| `src/session/config.js:514` | `mergeRolePatch` | 全仓仅 1 处（声明）；原调用方 `store.js` 已删 |
| `src/session/config.js:529` | `isEmptyPatch` | 全仓仅 1 处（声明）；原调用方 `store.js` 已删 |
| `src/session/config.js:561` | `removePatchField` | 全仓仅 1 处（声明）；原调用方 `store.js` 已删 |

溯源证据（B3 前的 `src/session/store.js`）：

```
$ git show 23cd7e5~1:src/session/store.js | Select-String "diffRoleOverride|mergeRolePatch|isEmptyPatch|removePatchField"
  diffRoleOverride,
  isEmptyPatch,
  mergeRolePatch,
  removePatchField,
    const { patch: diff, restored } = diffRoleOverride(input?.inherited ?? null, sanitized)
    let nextPatch = mergeRolePatch(existing, diff)
    for (const field of restored) nextPatch = removePatchField(nextPatch, field)
    if (isEmptyPatch(nextPatch)) delete config.roleOverrides[roleId]
```

四个符号的唯一消费点全部在已删除的 `store.js` 中 → 确认为 B3 死代码。

⚠️ 注：`tests/session-config.test.mjs`（474 行）也随 B3 删除，所以这 4 个函数现在**连测试都没有**。表里 `diffRoleOverride` 在全仓 3 处命中中，其余 2 处是 `docs/design/role-model-b2.md:19` 与 `docs/gui-0.2.0.md:551` 的文字描述。

### 🟡 低风险死导出（导出但无外部引用，未逐个改，仅记录）

`src/config.js:124 CliPreferencesSchema`、`src/run-store.js:62 MAX_HANDOFF_ITEM_CHARS`、`src/gui/host.js:700 GUI_REMOTE_DESCRIPTOR`、`src/gui/state-model.js:58 ROLE_COLOR_LABEL` / `:65 LEGACY_AVAILABILITY` / `:351 deriveCliOptions` / `:380 deriveRoleEditorFields`、`src/roles/registry.js:102 ERROR_CODES`。

这些**不是 B3 产物**，多为对外契约/调试用途的合理导出，**不建议本轮动**。

### ✅ 确认不是死代码的（避免误删）

`getSessionConfig` / `setSessionOverride` / `clearSessionOverride` 在 `tests/gui.test.mjs:508-518` 出现在 stub 夹具里，是测试替身，不属于死代码。

---

# 任务 B：仓库卫生盘点

## B1. `.meetingstone/worktrees/` 工作树

**结论：34 个工作树，合计 99.16 MB；34 个分支 100% 已合并进 `main`（可全部回收，但需先确认无未提交改动）。**

```
$ git branch --merged main | Where-Object { $_ -like "meetingstone/*" }   → 34 条
$ git branch --no-merged main | Where-Object { $_ -like "meetingstone/*" } → 0 条
$ (Get-ChildItem .meetingstone\worktrees -Recurse -File | Measure-Object Length -Sum).Sum → 99.16 MB
```

| # | 路径（前 8 位） | 分支 | 创建时间 | childId | 已合并 | 磁盘 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `1cdc02e3` | `meetingstone/1cdc02e3` | 11-11 11:50 | `9382e0a1` | ✅ | 1.86 MB |
| 2 | `c03bc332` | `meetingstone/c03bc332` | 11-11 12:02 | `35050722` | ✅ | 1.42 MB |
| 3 | `868b4a0f` | `meetingstone/868b4a0f` | 11-11 12:02 | `1d9d86dc` | ✅ | 1.31 MB |
| 4 | `51774a26` | `meetingstone/51774a26` | 11-11 12:02 | `3ac7e06f` | ✅ | 1.34 MB |
| 5 | `fc3c4e0a` | `meetingstone/fc3c4e0a` | 11-11 12:45 | `5bf4d9b0` | ✅ | 1.41 MB |
| 6 | `f5373af5` | `meetingstone/f5373af5` | 11-11 12:45 | `f223fd9e` | ✅ | **31.64 MB** ⚠️ |
| 7 | `b0a7b286` | `meetingstone/b0a7b286` | 11-11 12:45 | `e54516b0` | ✅ | 1.65 MB |
| 8 | `e6dc7f50` | `meetingstone/e6dc7f50` | 11-11 12:45 | `3fae3f67` | ✅ | 1.38 MB |
| 9 | `8e4edfb9` | `meetingstone/8e4edfb9` | 11-11 12:46 | `8616b05e` | ✅ | 1.38 MB |
| 10 | `8a598e24` | `meetingstone/8a598e24` | 11-11 12:49 | `3ad8ec59` | ✅ | 1.38 MB |
| 11 | `b0128790` | `meetingstone/b0128790` | 11-11 12:50 | `eaeafa4d` | ✅ | 1.39 MB |
| 12 | `e347b33f` | `meetingstone/e347b33f` | 11-11 12:52 | `518f0127` | ✅ | 1.38 MB |
| 13 | `f7804ce3` | `meetingstone/f7804ce3` | 11-11 14:02 | `274cbe89` | ✅ | 2.57 MB |
| 14 | `0815b1fa` | `meetingstone/0815b1fa` | 11-11 15:19 | `e4659f8d` ⚠️running | ✅ | 1.90 MB |
| 15 | `03c8e83f` | `meetingstone/03c8e83f` | 11-11 15:26 | `6ddbe84e` | ✅ | 1.90 MB |
| 16 | `0bd30eb5` | `meetingstone/0bd30eb5` | 11-11 17:31 | `efc87779` | ✅ | 1.92 MB |
| 17 | `c71a8276` | `meetingstone/c71a8276` | 11-11 17:47 | `f647f11a` | ✅ | 1.92 MB |
| 18 | `f4f9ab9d` | `meetingstone/f4f9ab9d` | 11-11 21:46 | `9a88bbf8` | ✅ | 2.15 MB |
| 19 | `71017bc6` | `meetingstone/71017bc6` | 11-12 11:09 | `b1cf61c5` | ✅ | 2.34 MB |
| 20 | `6209334d` | `meetingstone/6209334d` | 11-12 11:09 | `662ee560` | ✅ | 2.34 MB |
| 21 | `db9a0d01` | `meetingstone/db9a0d01` | 11-12 11:10 | `3a9c3a97` | ✅ | 2.34 MB |
| 22 | `5e212cab` | `meetingstone/5e212cab` | 11-12 11:11 | `77b2a4d2` | ✅ | 2.34 MB |
| 23 | `cf90e76d` | `meetingstone/cf90e76d` | 11-12 11:12 | `f1133b2d` | ✅ | 2.34 MB |
| 24 | `c3e38515` | `meetingstone/c3e38515` | 11-12 11:12 | `7cbb46e2` | ✅ | 2.34 MB |
| 25 | `036e2fb0` | `meetingstone/036e2fb0` | 11-12 12:59 | `33b87e20` | ✅ | 2.35 MB |
| 26 | `e5d5b9b7` | `meetingstone/e5d5b9b7` | 11-12 13:00 | `8e9017f4` | ✅ | 2.34 MB |
| 27 | `6390a4f5` | `meetingstone/6390a4f5` | 11-12 13:02 | `3ca77be6` | ✅ | 2.35 MB |
| 28 | `26f04a11` | `meetingstone/26f04a11` | 11-12 13:03 | `260403fe` | ✅ | 2.57 MB |
| 29 | `0e187e62` | `meetingstone/0e187e62` | 11-12 13:58 | `a4a1ac16` | ✅ | 2.61 MB |
| 30 | `8a56ebb3` | `meetingstone/8a56ebb3` | 11-12 13:58 | `107630cb` | ✅ | 2.61 MB |
| 31 | `255a540f` | `meetingstone/255a540f` | 11-12 14:01 | `d2ef1faf` | ✅ | 2.61 MB |
| 32 | `b094c439` | `meetingstone/b094c439` | 11-12 14:01 | `f1448dd1` | ✅ | 2.61 MB |
| 33 | `d4008e88` | `meetingstone/d4008e88` | 11-12 14:02 | `238f53b6` | ✅ | 2.61 MB |
| 34 | `7d4d46e1` | `meetingstone/7d4d46e1` | 11-12 14:02 | `583c7a4a` | ✅ | 2.61 MB |

补充事实：
- `.meetingstone/` 整体已被 `.gitignore:36` 忽略，这些工作树**不进库**，纯属本地磁盘占用。
- 34 个目录全部能通过 run record 的 `worktree.path` 反查到 childId（mapped 34/34），映射完整。
- `f5373af5` 单目录 31.64 MB，是唯一异常项（其余均值约 2 MB），推测内部残留了 `node_modules` 或产物，值得单独确认后再删。
- 对应本地分支 `meetingstone/*` 亦共 34 条，删除工作树后可用 `git worktree prune` + `git branch -d` 一并清掉。

## B2. `.meetingstone/runs/` 记录

**结论：106 条记录，1.19 MB；其中 1 条 `running` 需投影为 `interrupted`。**

```
$ Get-ChildItem .meetingstone\runs -File -Filter *.json   → 106 个
$ 总大小                                                 → 1.19 MB

status 分布：
  completed    100
  cancelled      3
  interrupted    2
  running        1     ← 需投影
```

需投影的那条：

| 字段 | 值 |
| --- | --- |
| 文件 | `e4659f8d-356f-4994-bb4c-cc0825d6a814.json` |
| childId | `e4659f8d-356f-4994-bb4c-cc0825d6a814` |
| status | `running` |
| createdAt | `1794381545840` |
| finishedAt | *（空）* |
| role | `role-xiaobai` |
| 对应工作树 | `0815b1fa`（11-11 15:19，分支已合并） |

该记录创建于 11-11 15:19，至今已跨进程多轮，DSH 重启后必然不会再有宿主结算 → 属**遗留 running**，符合项目既定「上一个进程遗留的 running 会投影为 interrupted」规则。读取侧已自动投影，磁盘上的 `status` 字段仍是 `running`。

另外 2 条 `interrupted`（`ab95d1dd` role-wukong、`b9ff8bc4` role-xiaobai）是正常的终态，无需处理。

## B3. `.token-test/`、`.acl-recovery/` 等临时目录

| 目录 | 是否存在 | 大小 | 文件数 | 是否入 .gitignore | 是否被 git 跟踪 |
| --- | --- | --- | --- | --- | --- |
| `.token-test/` | ✅ 存在 | 0.03 MB | 10 | ✅ `.gitignore:38`（`.token-test/`） | ✅ 0 个（`git ls-files .token-test` 为空） |
| `.acl-recovery/` | ❌ 不存在 | — | — | — | — |
| `.tmp/` | ❌ 不存在 | — | — | 有规则（`.gitignore:10` `.tmp/`） | — |
| `node_modules/` | ✅ 存在 | 5.66 MB | 1092 | ✅ `.gitignore:2` | ✅ 0 个 |
| `dist/` `coverage/` | ❌ 不存在 | — | — | 有规则 | — |

**结论：✅ 卫生状况良好。** `.token-test/` 是 2026-11-12 计费排查的本地诊断脚本，已正确忽略且未入库（`git check-ignore -v .token-test` → `.gitignore:38`）。`.acl-recovery/` 已被清理，无残留。

唯一提醒：`.token-test/` 是诊断产物，若计费排查已收口（清单 §9 已确认「扣费问题已彻底解决」），可考虑删除，但**属可保留的排查留痕**，风险为零。

### 附带发现：根目录 `.d1-verify*` 未跟踪文件

```
$ git status --porcelain=v1        (审计结束时刻)
?? .d1-verify.err.txt            0 B
?? .d1-verify.out.json           50448 B
?? .d1-verify.tmp.mjs            12804 B
?? .d1-verify2.err.txt           0 B
?? .d1-verify2.out.json          25750 B
?? .d1-verify2.tmp.mjs           11228 B
?? .d1-verify3.out.json          （审计结束时仍在增长）
?? .d1-verify3.tmp.mjs
```

| 判定 | 说明 |
| --- | --- |
| 来源 | **非本次审计**。文件头写明「D1 真机验收 · 只读证据采集脚本」，是另一个 teammate 并发跑的验收采集，创建于审计进行中（15:53 起，按轮次递增） |
| 是否被跟踪 | ❌ 全部未跟踪，且**未被 `.gitignore` 覆盖** → 会持续污染 `git status` |
| 建议 | 采集完成后删除；若后续还要复用，建议加 `.gitignore` 规则 `.d1-verify*`（比逐次手工删更稳） |
| 本次处理 | **未动**（只读纪律 + 避免干扰并发中的 teammate） |

## B4. `D:\MeetingStone-hotfix-billing\` detached worktree

**结论：🔴 仍然存在，且带着 5 个文件的未提交改动。已提交部分 100% 在 main 内；未提交部分与 main 功能等价。**

```
$ Test-Path D:\MeetingStone-hotfix-billing  → EXISTS   2.96 MB   created=2026/11/12 15:20:46
$ git -C ... log --oneline -3
aec7ef3 chore(config): 角色模型改为 ACP（唐僧 kimi-k3.1-pro / 悟空 hy4free / 沙僧 glm-5.3-flash / 小白 hy3，均 high）
c3f55d5 fix(install-safe): 修 fs 引用与 rollback 路径展示；依赖串同步 alpha.5
52d3933 chore(release): 0.1.0-alpha.5

$ git branch --contains aec7ef3  → main          ← HEAD 已在 main
```

**未提交改动（dirty）清单：**

```
 M CHANGELOG.md
 M package.json          (0.1.0-alpha.5 → 0.1.0-alpha.5.1)
 M src/config.js
 M src/dsh/adapter.js
 M tests/dsh-adapter.test.mjs
```

**关键判定：这些改动的内容在 `main` 里已经有了。** 证据：

```
$ git grep -n "llmProvider|llmModel" -- src/ tests/     ← 在 main 工作区执行
src/config.js:49:    llmProvider: S.string().description(
src/config.js:52:    llmModel: S.string().description('进程内通道的宿主 LLM 模型 ID；仅 kind=in-process 生效'),
src/dsh/adapter.js:357,371,372  （buildChildAgentOptions 完整实现）
tests/dsh-adapter.test.mjs:846-884
```

即 `buildChildAgentOptions()` + `channel.llmProvider/llmModel` 这套 P0 计费修复，已通过 alpha.6 正常进入 `main`；hotfix worktree 只是 alpha.5.1 时期的临时落点，其价值已被 alpha.6 完全吸收。

**剩余风险**：该 worktree 是 detached HEAD，**不在 `git worktree list` 的常规管理之外**（实际会计入），若长期遗留会造成「磁盘上有一份 2.96 MB 的游离代码 + 5 个未提交改动无人认领」。建议删除；删除前确认 `tests/dsh-adapter.test.mjs` 的 70 行改动确已被 main 覆盖（建议 diff 一次再删）。

## B5. canary profile / 多余 tgz

**tgz 清点：`C:\Users\30673\.dsh\packages\` 共 22 个，合计 2.64 MB。**

| 分组 | 文件 | 数量 | 合计 | 可弃性 |
| --- | --- | --- | --- | --- |
| 远古 0.0.x | `0.0.1 / 2 / 3 / 4 / 5 / 6 / 8 / 9 / 10 / 11 / 12 / 13 / 14 / 15 / 16` | 15 | ≈1.09 MB | 🟢 可弃（无 profile 引用） |
| alpha 早期 | `0.1.0-alpha` / `alpha.2` / `alpha.3` / `alpha.4` | 4 | ≈0.86 MB | 🟡 `0.1.0-alpha` 被 2 个 canary 引用 |
| alpha 回滚锚点 | `0.1.0-alpha.5` / `alpha.5.1` | 2 | 0.48 MB | 🔴 **必须保留**（清单 §5 指定 `.5.1` 为回滚目标） |
| 当前 | `0.1.0-alpha.6` | 1 | 0.22 MB | 🔴 **必须保留**（desktop 正在用） |

**默认 profile 实际安装版本（`C:\Users\30673\.dsh\profiles\<p>\package.json` → `dependencies.dsh-meetingstone`）：**

| profile | 安装的 tgz | 体积 | 判定 |
| --- | --- | --- | --- |
| `desktop` | `dsh-meetingstone-0.1.0-alpha.6.tgz` | 2542.86 MB | ✅ 当前主 profile，正确 |
| `web` | *（空）* | 0 MB | — |
| `ms-canary-test` | `dsh-meetingstone-0.1.0-alpha.tgz` | 0.71 MB | 🟢 **可弃**（创建于 11-12 10:37，早于 alpha.6） |
| `ms-canary2` | `dsh-meetingstone-0.1.0-alpha.tgz` | 0.71 MB | 🟢 **可弃**（同上，11-12 10:38） |

两个 canary profile 都是 11-12 上午 alpha 阶段的一次性验证环境，仍挂载远古 `0.1.0-alpha`（比当前版本落后 6 个迭代）。它们合计 1.42 MB，删除后 `0.1.0-alpha.tgz` 即可一并清理。**注意：删除 profile 目录属于 DSH 全局操作，不在本次授权范围，需 Lead 决定。**

## B6. git 仓库体积

**结论：✅ 健康。`.git` 仅 3.61 MB，无超大对象。**

```
$ (Get-ChildItem .git -Recurse -File -Force | Measure-Object Length -Sum).Sum   → 3.61 MB
$ git count-objects -vH
count: 429
size: 1.82 MiB
in-pack: 1426
packs: 2
size-pack: 1.03 MiB
prune-packable: 0
garbage: 0
$ git rev-list --objects --all | Measure-Object → 1832 objects
$ 单个 blob > 200 KB 的对象  → none（0 个）
```

1832 个对象里**没有任何 >200 KB 的 blob**，最大 pack 1.03 MiB。无需 `gc --aggressive`，无需 LFS，无需改写历史。`garbage: 0` 说明也没有悬空对象堆积。

---

# 任务 C：版本一致性核对

## C1. 三处版本号

**结论：✅ 全部一致，均为 `0.1.0-alpha.6`。**

```
$ (Get-Content package.json -Raw | ConvertFrom-Json).version
0.1.0-alpha.6

$ Select-String -Path src\index.js -Pattern "PLUGIN_VERSION"
src\index.js:77:export const PLUGIN_VERSION = '0.1.0-alpha.6'

$ Select-String -Path src\client\index.js -Pattern "PLUGIN_VERSION"
src\client\index.js:90:    const PLUGIN_VERSION = '0.1.0-alpha.6'
```

已安装产物同样是 `0.1.0-alpha.6`（`desktop\node_modules\dsh-meetingstone\package.json` → `0.1.0-alpha.6`），磁盘与安装态一致。

## C2. CHANGELOG 最新条目

**结论：✅ 一致。`## [0.1.0-alpha.6] - 2026-11-12` 位于首个版本条目位置，与 `package.json` 版本相同。**

`release-check.mjs` 亦独立验证通过：

```
[PASS] CHANGELOG 条目   存在 "## [0.1.0-alpha.6]"
```

## C3. `docs/release/0.1.0-alpha.6-checklist.md` 勾选项与实际状态

**结论：⚠️ 无「勾了但没做」，但有「做了却没勾」，另有 2 处事实性夸大。**

### 三态核对

| 清单项 | 勾选 | 实际状态 | 判定 |
| --- | --- | --- | --- |
| §1 `package.json` version = alpha.6 | ☑ | ✅ 属实 | ✅ |
| §1 `src/index.js` PLUGIN_VERSION | ☑ | ✅ 属实 | ✅ |
| §1 `src/client/index.js` PLUGIN_VERSION | ☑ | ✅ 属实 | ✅ |
| §1 CHANGELOG 存在条目 | ☑ | ✅ 属实 | ✅ |
| §2 测试全绿 541/540/1skip | ☑ | ✅ **实测复现** | ✅ |
| §2 工具 schema 校验（8 个工具） | ☑ | ✅ 实测 `PASS: 8 个工具` | ✅ |
| §2 manifest 自检 | ☑ | ✅ 实测 PASS | ✅ |
| §2 发布包内容校验 | ☑ | ✅ 实测 `40 个文件，780.4 KB` | ✅ |
| §3 `npm pack` 生成 alpha.6 tgz | ☐ | ✅ **已完成**（`dsh-meetingstone-0.1.0-alpha.6.tgz`，15:32:50） | 🟡 做了没勾 |
| §3 `install:safe --tgz ... --previous` | ☐ | ✅ **已完成**（desktop 已装 alpha.6） | 🟡 做了没勾 |
| §3 重启后版本号 = alpha.6 | ☐ | ✅ **已完成**（profile 与包一致） | 🟡 做了没勾 |
| §4 设置页角色列表/开关 | ☐ | 未验证（需真机） | ⏳ 真实未完成 |
| §4 角色编辑器 4 CLI/模型/强度/刷新 | ☐ | 未验证 | ⏳ 真实未完成 |
| §4 设置页角色区有返回按钮 | ☐ | 未验证 | ⏳ 真实未完成 |
| §4 右侧栏**无**角色面板、对话页头**无**按钮 | ☐ | 未验证（B3 效果，需真机确认） | ⏳ 真实未完成 |
| §4 派单一次，provider = workbuddy | ☐ | 清单 §9 已记录 100% workbuddy（2 次调用） | 🟡 部分做了没勾 |
| §4 三个原生面板可用 | ☐ | 未验证 | ⏳ 真实未完成 |

### 事实性夸大（应修正文档）

| 位置 | 原文 | 实况 | 判定 |
| --- | --- | --- | --- |
| §0 变更表 B3 行 | 「去掉会话级角色配置与会话入口（**3834 行**）」 | B3 提交 `23cd7e5` 实际 `18 files changed, 336 insertions(+), 3834 deletions(-)` | ✅ 数字准确（3834 = 删除行数） |
| §9 结论 | 「扣费问题**已彻底解决**」 | 同节「唯一残留风险」写明仍有 16 个固化 deepseek-account 的旧 subagent 会话，「一旦被唤醒就会恢复按量计费」 | ⚠️ **表述矛盾**：残留风险真实存在，建议改为「新会话已解决，存量 16 个会话仍有唤醒即计费风险」 |

§0 的 3834 与 git 统计吻合，**不是问题**；需要修正的是 §9 的绝对化措辞。

### 自动门禁实测复现

```
$ node scripts/run-tests.mjs
# tests 541  # pass 540  # fail 0  # skipped 1   duration_ms 13993

$ node scripts/release-check.mjs
[PASS] package.json 版本        0.1.0-alpha.6 == 0.1.0-alpha.6
[PASS] PLUGIN_VERSION 版本      0.1.0-alpha.6 == 0.1.0-alpha.6
[PASS] CHANGELOG 条目           存在 "## [0.1.0-alpha.6]"
[PASS] 门禁 · 测试              14.2s · 541 tests / 540 pass / 0 fail / 1 skipped
[PASS] 门禁 · 工具 schema       8 个工具的注册产物符合契约
[PASS] 门禁 · manifest          manifest 自检通过
[PASS] 门禁 · 发布包            40 个文件，共 780.4 KB
结果：可发布（元数据 + 门禁通过） —— 7 PASS / 0 SKIP
```

Lead 陈述的「541 / 540 pass / 1 skip」「release:check 7 PASS / 0 FAIL」**完全复现，零偏差**。

---

# 清理清单（待批准，本次未执行任何删除）

> 全部动作均**未执行**。每条给出路径 / 大小 / 建议动作 / 风险。「执行建议」列假定 Lead 批准后由有权限者操作。
> ⚠️ 全局约束：任务纪律禁止 `meetingstone_cancel_task` 之外的破坏性操作，profile 与插件增删不在本审计授权内。

## 第 1 组：B3 代码残留（改代码，非删文件）

| # | 路径 / 位置 | 规模 | 建议动作 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | `src/session/config.js:464,514,529,561`（`diffRoleOverride` / `mergeRolePatch` / `isEmptyPatch` / `removePatchField`） | 4 个函数，约 60 行 | **删除** | 🟢 低：唯一消费方 `store.js` 已删；但无测试覆盖，删前建议 `git grep` 二次确认 |
| 2 | `src/gui/typert-spec.js:105,109,119,131`（`sessionId` / `field` / `sessionConfigView` / `overrideResult` 局部函数） | 4 个局部 + 约 25 行 | **删除** | 🟢 低：均为仅声明无引用 |
| 3 | `src/gui/typert-spec.js:30,32,34,35` + `src/client/index.js:103,105,107,108`（4 个 typeSymbol 键 × 2 侧） | 8 处键值 | **删除（两侧必须同步）** | 🟡 中：`tests/gui.test.mjs:1326` 做 `deepEqual(SESSION_TYPES, SESSION_REMOTE_TYPES)`，只改一侧必挂 |
| 4 | `src/client/index.js:118,122`（`sessionIdCodec` / `fieldCodec`） | 2 个局部 + 4 行 | **删除** | 🟢 低：各仅 1 次出现 |
| 5 | `src/gui/config-api.js:6` 注释「会话：`src/gui/session.js`（已有，P0-S0）」 | 1 行 | **删除该行** | 🟢 无 |
| 6 | `src/gui/host.js:3,13` 注释「三个 strict 会话方法」「同一 service 的会话方法」 | 2 行 | **改**为「5 个 strict 配置方法」 | 🟢 无 |
| 7 | `src/session/config.js:26` 注释提 `.meetingstone/sessions/<id>.json` | 1 行 | **加「历史说明」前缀**（代码已不读该路径） | 🟢 无 |

## 第 2 组：B3 文档残留

| # | 路径 | 规模 | 建议动作 | 风险 |
| --- | --- | --- | --- | --- |
| 8 | `docs/configuration.md:307-325` 整节「宿主侧 API（store.js + session.js）」 | 约 19 行 | **删除或整节标注「已随 B3 废弃」** | 🟡 中：这是当前面向用户的配置文档，教的是已删 API，**误导性最高** |
| 9 | `docs/gui-0.2.0.md:246,251,312,417-419` | 6 处 | **归档并加顶部「历史设计文档，B3 后部分失效」横幅** | 🟢 低：文档名带版本号，属历史件 |
| 10 | `scripts/smoke-client-inject.mjs:269-283,143,314-317` | 约 25 行 | **修**为 6 个 descriptor（`list` + 5 配置方法） | 🟡 中：**当前必挂**，但不在 `npm test` 链路内，机器门禁发现不了 |

## 第 3 组：磁盘卫生（可回收 100+ MB）

| # | 路径 | 大小 | 建议动作 | 风险 |
| --- | --- | --- | --- | --- |
| 11 | `.meetingstone/worktrees/`（34 个，分支全部已合并 main） | **99.16 MB** | **删除工作树 + `git worktree prune` + `git branch -d meetingstone/*`** | 🟡 中：删前须逐个 `git status` 确认无未提交改动；`f5373af5` 单占 31.64 MB 异常，先单独查明 |
| 12 | `D:\MeetingStone-hotfix-billing\`（detached HEAD `aec7ef3`） | 2.96 MB | **删除**（含 5 个未提交改动，功能已被 alpha.6 吸收） | 🟡 中：删前建议先 `git diff` 核对 `src/dsh/adapter.js` / `tests/dsh-adapter.test.mjs` 确已被 main 覆盖 |
| 13 | `C:\Users\30673\.dsh\packages\dsh-meetingstone-0.0.*.tgz`（15 个） | ≈1.09 MB | **删除** | 🟢 低：无任何 profile 引用 |
| 14 | `dsh-meetingstone-0.1.0-alpha.2/3/4.tgz`（3 个） | ≈0.65 MB | **归档或删除** | 🟢 低：无 profile 引用 |
| 15 | `C:\Users\30673\.dsh\profiles\ms-canary-test\` + `ms-canary2\` | 1.42 MB | **删除**（后 `0.1.0-alpha.tgz` 才可清） | 🔴 **高**：属 DSH 全局 profile 操作，需 Lead 明确授权，且不在本审计纪律范围 |
| 16 | `.token-test/`（10 个诊断脚本） | 0.03 MB | **保留**（已正确 gitignore，是计费排查留痕） | 🟢 无 |
| 17 | `.meetingstone/sessions-archive/session-417e6b6a....json` | 219 B | **保留**（B3 前会话配置归档，体积可忽略） | 🟢 无 |
| 18 | `.meetingstone/sessions/`（空目录） | 0 B | **保留**（结构占位） | 🟢 无 |
| 19 | `.meetingstone/runs/e4659f8d-....json`（status 仍为 running） | 16 KB | **保留**（读取侧已自动投影 interrupted；改盘上字段需插件逻辑支持） | 🟢 无 |
| 19b | 根目录 `.d1-verify*`（数量随并发采集递增） | ~100 KB+ | **待并发 teammate 采集完后删除**，并考虑加 `.gitignore` 规则 `.d1-verify*` | 🟡 中：**非本审计产物**，正在被另一 teammate 使用，勿抢先删 |

## 第 4 组：必须保留（防误删）

| # | 路径 | 理由 |
| --- | --- | --- |
| 20 | `src/session/config.js` **整文件** | 🔴 **不可删**：4 个生产调用方（`global-writer.js:29`、`state-model.js:26`、`index.js:28`、`project/write.js:24`）。仅其中的 4 个死导出（清单 #1）可删 |
| 21 | `C:\Users\30673\.dsh\packages\dsh-meetingstone-0.1.0-alpha.6.tgz` | 当前 desktop profile 正在使用 |
| 22 | `C:\Users\30673\.dsh\packages\dsh-meetingstone-0.1.0-alpha.5.1.tgz` | 清单 §5 指定的回滚目标 |
| 23 | `.gitignore` 的 `.token-test/` 规则 | 已正确生效 |

---

# 问题分级

## 🔴 阻塞发布（0 条）

**无。** `release:check` 7 PASS / 0 FAIL，541 测试全绿，已安装产物与磁盘一致，三处版本号一致。alpha.6 **不存在阻塞发布的代码问题。**

## 🟡 应修但不阻塞（5 条）

| # | 问题 | 影响 | 证据 |
| --- | --- | --- | --- |
| 1 | `scripts/smoke-client-inject.mjs` 仍断言 9 个 descriptor 且含 3 个已删方法 | **该脚本现在必然失败**；因不在 `npm test` 链路，机器门禁完全无感知 | `smoke-client-inject.mjs:269` vs `typert-spec.js:52`；`run-tests.mjs` 无 `smoke` 匹配 |
| 2 | `docs/configuration.md:307-325` 教用户调用 3 个已删除 API | 用户按文档写代码会直接失败，误导性最强 | `docs/configuration.md:307,309,311,313,316,320-325` |
| 3 | `SESSION_REMOTE_TYPES` 4 个会话覆盖类型符号 + 6 个死局部函数双份残留 | 契约面虚胖，维护者会误判会话接口尚在；清理时两侧不同步必挂测试 | `typert-spec.js:29-40,105,109,119,131`；`client/index.js:102-112,118,122`；`gui.test.mjs:1326` |
| 4 | `src/session/config.js` 4 个死导出（`diffRoleOverride` 等）且已无测试覆盖 | 死代码无护栏，后续误改无人发现 | `git show 23cd7e5~1:src/session/store.js` 显示唯一消费方已删 |
| 5 | 清单 §9「扣费问题已彻底解决」与同节「16 个存量会话唤醒即计费」自相矛盾 | 会让人误以为风险清零而随意唤醒旧 teammate —— **这正是真金白银的风险点** | `docs/release/0.1.0-alpha.6-checklist.md` §9 |

## 🟢 仅为卫生问题（其余全部）

| # | 问题 | 规模 |
| --- | --- | --- |
| 6 | 34 个已合并工作树长期滞留 | 99.16 MB |
| 7 | `D:\MeetingStone-hotfix-billing\` 游离 worktree 带 5 个未提交改动 | 2.96 MB |
| 8 | 15 个 0.0.x 远古 tgz + 3 个 alpha 早期 tgz | ≈1.74 MB |
| 9 | 2 个过期 canary profile（仍挂 `0.1.0-alpha`） | 1.42 MB |
| 10 | `docs/gui-0.2.0.md` 6 处指向已删模块 | 文本 |
| 11 | `src/gui/host.js:3,13`、`config-api.js:6`、`session/config.js:26` 注释过时 | 4 行 |
| 12 | 8 个低风险死导出（`CliPreferencesSchema` 等，非 B3 产物） | — |
| 13 | 1 条 runs 记录 status 仍为 `running`（读取侧已投影） | 16 KB |
| 14 | 清单 §3 三项已完成但未勾选 | 文本 |
| 15 | 根目录 `.d1-verify*` 未跟踪文件污染 `git status`（并发 teammate 产生） | ~100 KB+ |

---

# 给 Lead 的决策点

1. **无阻塞项**，alpha.6 可继续推进真机冒烟（§4 那 6 项才是真正的未完成项，需人工验证）。
2. **最该优先修的是问题 #1 和 #5**：#1 是「门禁看不见的坏脚本」，#5 是「文档自相矛盾会诱导人唤醒旧会话烧钱」——后者与本次计费事故同源，风险最高。
3. **清理清单共 19 条可执行项**（第 1~3 组），其中 **第 3 组 9 条可回收约 103 MB 磁盘**，但 #11 需逐个确认未提交改动、#15 涉及 DSH 全局 profile 需单独授权。
4. **两条防误删红线**：`src/session/config.js` 整文件不可删（仅有 4 个死导出可删）；`alpha.5.1` 与 `alpha.6` 两个 tgz 不可删。
