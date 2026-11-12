# B3 契约残留与死代码清理报告

> 执行日期：2026-11-12 15:58 ~ 16:25（Asia/Shanghai）
> 基线：`main` @ `3c28579`（工作区 clean，`git status --porcelain` 为空）
> 依据：`docs/plan/verify/2026-11-12-alpha6-audit.md`（审计基线 `c44bd96`）
> 纪律：**未唤醒任何旧 teammate**；未改 profile、未重启 DSH、未增删插件；未派单给外部 CLI。

## 结论摘要

| 项 | 结果 |
| --- | --- |
| 1. `SESSION_REMOTE_TYPES` 会话覆盖残留 | ✅ **已清理**：4 个键两侧同步删除 + 6 个死局部函数删除 |
| 2. 4 个死导出（+1 个审计漏报的） | ✅ **已清理**：共 5 个死导出，120 行 |
| 3. 过时注释 | ✅ **已修**：`host.js` 4 处、`typert-spec.js` 1 处、`config-api.js` 1 处、`config.js` 3 处 |
| 4. `npm test` | ✅ 全绿 **541 tests / 540 pass / 0 fail / 1 skip**（与基线一致，见 §4 说明） |
| 5. `release-check.mjs` | ✅ **8 PASS / 0 SKIP** |
| 未做项 | `docs/` 文档残留、`smoke-client-inject` 已另修（见 §5） |

**净变化：5 个文件、184 行删除 / 19 行新增（新增全为注释），0 个测试用例删除。**

---

## 1. `SESSION_REMOTE_TYPES` 会话覆盖残留清理

### 1.1 先核对审计结论（未直接采信）

审计 §A4 称 4 个键为会话覆盖专用：`sessionId` / `field` / `sessionConfigView` / `overrideResult`。
按任务要求，动手前逐个确认「是否还被任何生产代码使用（不是测试）」：

```
$ grep -rn "sessionConfigView|overrideResult|sessionIdCodec|fieldCodec" <repo>
src/gui/typert-spec.js:34,35,119,131      ← 只有声明（本轮要删的）
src/client/index.js:107,108,118,122       ← 只有声明（本轮要删的）
```

- `sessionId` 键：`typert-spec.js:105` 的局部函数 + `client:118` 的 `sessionIdCodec`，**均为仅声明无引用**
- `field` 键：`typert-spec.js:109` 局部函数 + `client:122` `fieldCodec`，**均为仅声明无引用**
  （`typert-spec.js` 原 `:142` 的 `z.enum(['field','role'])` 位于已删的 `overrideResult` 内部，随之消失）
- `sessionConfigView` / `overrideResult` 键：仅对象字面量键 + 同名的死局部函数

**审计结论成立。** 4 个键的生产消费方为 0，可安全删除。

### 1.2 改动

| 文件:行 | 动作 |
| --- | --- |
| `src/gui/typert-spec.js:29-40` → `:29-35` | 删 4 个键；`roleId` / `value` / `cliName` / `booleanValue` / `jsonResult` 保留（仍是 5 个配置方法的真实 typeSymbol） |
| `src/gui/typert-spec.js` 原 `:104-105,108-109,119-129,131-145` | 删死局部函数 `sessionId` / `field` / `sessionConfigView` / `overrideResult` |
| `src/client/index.js:102-112` → `:102-107` | 删同一批 4 个键（**逐字副本，必须同步**） |
| `src/client/index.js` 原 `:118-119,122-123` | 删 `sessionIdCodec` / `fieldCodec` |

**两侧同步的必要性复核**：`tests/gui.test.mjs:1326` 做
`assert.deepEqual(exports.__test.SESSION_TYPES, SESSION_REMOTE_TYPES)`。
两侧都删后仍相等（`{roleId,value,cliName,booleanValue,jsonResult}`），测试**不需要改**。
没有任何测试断言这 4 个键的存在——这是本轮唯一可以「只删代码不改测试」的前提，已实测确认。

代码层面还顺带验证了删除后的产物仍然正确：

```
$ node -e "…createTypertRemoteInfo(createSessionRemoteSpec(z),z)…"
descriptors: 5
methods: setCliEnabled,refreshCli,updateGlobalRole,createGlobalRole,deleteGlobalRole
types: roleId,value,cliName,booleanValue,jsonResult
```

### 1.3 证据

删除前 `deepEqual` 两侧一致 → 删除后仍一致，测试全绿；且 descriptor 数量保持 5（`typert-contract.test.mjs:39` 与 `:117` 硬断言 5，未受影响）。

```diff
 // src/gui/typert-spec.js
 export const SESSION_REMOTE_TYPES = Object.freeze({
-  sessionId: 'dsh-meetingstone/types#SessionId',
   roleId: 'dsh-meetingstone/types#RoleId',
-  field: 'dsh-meetingstone/types#OverrideField',
   value: 'dsh-meetingstone/types#JsonValue',
-  sessionConfigView: 'dsh-meetingstone/types#SessionConfigView',
-  overrideResult: 'dsh-meetingstone/types#SessionOverrideResult',
```

---

## 2. 死导出清理（`src/session/config.js`）

### 2.1 ⚠️ 发现审计漏报第 5 个死导出：`normalizeFieldPath`

审计 §A6 列了 4 个：`diffRoleOverride` / `mergeRolePatch` / `isEmptyPatch` / `removePatchField`。
**但紧挨着它们的 `normalizeFieldPath`（原 `:539`）同源同因，审计漏了**：

```
$ grep -rn "normalizeFieldPath" <repo>     （动手前）
src/session/config.js:539  声明
src/session/config.js:558  仅出现在 removePatchField 的 JSDoc 里（同样是死代码）
docs/design/role-model-b2.md:19   文字描述
```

同一条溯源证据链可以证明它也是 B3 遗留：

```
$ git show 23cd7e5~1:src/session/store.js | Select-String "normalizeFieldPath|clearOverride"
  normalizeFieldPath,
  async function clearOverride(projectRoot, sessionId, input) {
      const field = normalizeFieldPath(input.field)
```

唯一消费方是已删 `store.js` 的 `clearOverride`，且 `clearOverride` 本身也已随 B3 删除
（这也是审计清单 #7「`config.js:26` 注释提 clearOverride」能成立的原因——那是个已不存在函数的语义）。
`src/` 下 0 引用，**确认死代码，与另外 4 个一并删除**。

> 处置说明：审计「结论有误」的门槛是**会造成错误删除**；这里审计是**漏报**而非误报，
> 且新增删除项有同一份 git 溯源证据，故按「确认后处理」执行，并在本报告登记，未先阻塞 lead。

### 2.2 删了什么

`src/session/config.js`，共 **120 行**（`891 → 766`，另有无关注释改动）：

| 原行号 | 符号 | 说明 |
| --- | --- | --- |
| `452-506` | `diffRoleOverride` | 唯一消费方 `store.js` 已删 |
| `508-526` | `mergeRolePatch` | 同上 |
| `528-531` | `isEmptyPatch` | 同上 |
| `533-553` | `normalizeFieldPath` | **审计漏报**，唯一消费方 `store.js:clearOverride` 已删 |
| `555-575` | `removePatchField` | 唯一消费方 `store.js` 已删 |

**任务书要求「连带清理审计提到的 6 个死局部函数」——实际只有 4 个在 `config.js` 同族**
（`sessionId` / `field` / `sessionConfigView` / `overrideResult` 全在 `typert-spec.js`，
其 client 侧对应 `sessionIdCodec` / `fieldCodec` 在 `client/index.js`）。
这 6 个已全部在 §1 删除，`config.js` 内不存在其他「仅声明无引用」的局部函数。

**执行方式防呆**：用一次性脚本按「行号区间」删除，并**逐区间断言**
首行是 `/**`、末行是 `}`、下一行是空行——首次运行因 CRLF 与单行 JSDoc 断言失败而
**拒绝写入**（未损坏文件），修正断言后才执行。脚本用完即删（`.cleanup-tmp.mjs` 已 `Remove-Item`，不在 diff 内）。

### 2.3 为什么没连带删掉共享 helper

删除后逐一确认 `deepEqual` / `ROLE_SOURCE_FIELDS` / `CHANNEL_SOURCE_FIELDS` / `isPlainObject`
**仍被保留代码使用**，未成孤儿：

```
deepEqual              → 仍在 :141,:150（自身递归）、:622、:717、:732 使用（diffFieldPaths / resolveEffectiveConfig）
ROLE_SOURCE_FIELDS     → 仍在 :621、:709、:762 使用
CHANNEL_SOURCE_FIELDS  → 仍在 :624、:723、:766 使用
```

**`src/session/config.js` 文件本身保留**——4 个生产调用方（`global-writer.js:29`、
`state-model.js:26`、`index.js:28`、`project/write.js:24`）全部不受影响。已复核
`sanitizeRolePatch` / `resolveEffectiveConfig` / `fieldSource` / `SESSION_CONFIG_ERRORS` 均未动。

---

## 3. 过时注释修正

### 3.1 `src/gui/host.js`（审计点名 2 处，实际修了 4 处）

| 行 | 原文 | 改为 | 理由 |
| --- | --- | --- | --- |
| `:3` | 「三个 strict 会话方法」 | 「五个 strict 配置方法」 | 实际 `GUI_STRICT_METHODS` = 5 个配置方法，0 个会话方法 |
| `:11-14` | 第二块数据链路：`→ 同一 service 的会话方法` / `→ src/gui/session.js（已随 B3 删除）` | **整块替换**为 5 个配置方法的真实链路（spec → typert.js → descriptor 注册） | 按审计建议整块删，而非只留 `:14` |
| `:66` | 「list → 会话三方法 → 配置三方法」 | 「list → 五个配置方法；B3 起无会话方法」 | **审计未列的同类过时** |
| `:78-81` | 「无参 list + 三个带参会话方法 + 三个配置方法」／「恢复（会话 3 + 配置 3）」 | 「无参 list + 五个带参配置方法」／「（配置 5）：」 | **审计未列的同类过时** |

关于审计要求「`:14` 是准确孤证，建议整段第二块整体删」：**已按此执行**。
`:14` 描述的是一个确实已被删除的文件，但它挂在一条已不存在的调用链末尾；
保留它等于留着「会话方法 → session.js」的错误暗示。故整块替换为现状（5 个配置方法的真实链路），
这既保留了原块「解释第二个数据链路」的作用，又不留过时信息。

### 3.2 其余注释

| 文件:行 | 原文 | 改为 |
| --- | --- | --- |
| `src/gui/typert-spec.js:3` | 「**会话级** Remote 的 strict 契约」 | 「**配置** Remote 的 strict 契约；B3 起只剩五个配置方法」 |
| `src/gui/config-api.js:5-6` | 「三类写入：- 会话：`src/gui/session.js`（**已有**，P0-S0）」 | 「三类写入（B3 后只剩后两类）」+ 标注会话级写入已随 B3 删除（审计清单 #5：指向已删文件且「已有」是事实错误） |
| `src/session/config.js:14` | 「IO 全部在 store.js」 | 「本文件不含任何 IO（B3 已删 store.js）」——**§2 删完 `clearOverride` 后此句已无对象** |
| `src/session/config.js:16` | 「清空字段用 clearOverride」 | 删去该分句（`clearOverride` 已随 store.js 删除，见 §2.1 溯源） |
| `src/session/config.js:26` | 「因此退化为 `.meetingstone/sessions/<id>.json`，局限见…」 | 加「历史说明：该路径读写代码已随 B3 下线，`src/` 下无代码再读它」（审计清单 #7） |

`:14` / `:16` 是审计未点名的：它们在 §2 删除 `clearOverride` 相关死代码后**才变成**悬空引用，
属于本轮的连带修正（不动就会留下新的过时注释）。

---

## 4. 验证

### 4.1 `npm test`

| 时点 | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- |
| 基线（动手前实测） | 541 | 540 | 0 | 1 |
| 契约清理后（§1） | 541 | 540 | 0 | 1 |
| 死导出清理后（§2） | 541 | 540 | 0 | 1 |
| 注释修正后（§3，终态） | **541** | **540** | **0** | **1** |

```
# tests 541
# suites 0
# pass 540
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 13959.7722
```

### 4.2 关于「测试总数应减少」的说明

任务书预期「删死代码后总数应减少」，**实际未减少，且这是正确结果**。原因：

- 被删的 5 个死导出与 6 个死局部函数**本来就没有任何测试覆盖**。
  审计 §A6 已明示：`tests/session-config.test.mjs`（474 行）**随 B3 一起删除了**，
  所以这 4 个函数「连测试都没有」。实测复核：全仓 `diffRoleOverride` 等 5 个符号在
  `tests/` 与 `scripts/` 下 **0 命中**（仅 `docs/` 有 2 处文字提及）。
- 因此本轮**没有删除任何测试用例**——也就不存在「删了哪几条、为什么」需要解释的问题。
- 测试数不变恰是「删的是真死代码」的正面证据：若某个测试引用过它们，删除必然掉测试数或直接变红。

### 4.3 `node scripts/release-check.mjs`

```
[PASS] package.json 版本        0.1.0-alpha.6 == 0.1.0-alpha.6
[PASS] PLUGIN_VERSION 版本      0.1.0-alpha.6 == 0.1.0-alpha.6
[PASS] CHANGELOG 条目           存在 "## [0.1.0-alpha.6]"
[PASS] 门禁 · 测试              13.6s · 541 tests / 540 pass / 0 fail / 1 skipped
[PASS] 门禁 · 客户端注入冒烟     0.3s · OK: real Cordis 4.1.0 from installed app.asar
[PASS] 门禁 · 工具 schema        PASS: 8 个工具的注册产物符合宿主 / 模型 API 契约
[PASS] 门禁 · manifest          manifest 自检通过
[PASS] 门禁 · 发布包            PASS: 发布包含 40 个文件，共 774.5 KB
结果：可发布（元数据 + 门禁通过） —— 8 PASS / 0 SKIP
```

**8 PASS** 与任务书预期一致。注意「客户端注入冒烟」这一项已在 `3c28579`
（`fix(gate): 修复腐坏的客户端注入冒烟并纳入发布门禁`）里修好并纳入门禁，
审计 §A2/问题 #1 记录的那个「必挂且门禁看不见」的坏脚本已不再存在，
故本轮无需再动 `scripts/smoke-client-inject.mjs`。

发布包由 780.4 KB（审计时）降到 774.5 KB，与删除的代码量吻合。

### 4.4 残留扫描

```
$ Select-String -Path src\**\*.js,tests\*.mjs,scripts\*.mjs -Pattern "OverrideField|SessionConfigView|SessionOverrideResult|#SessionId"
src\client\index.js:1013  overrideFieldsLabel: '覆盖字段'      ← i18n 文案键，非 typeSymbol（未动）
src\client\index.js:1190  overrideFieldsLabel: 'Override fields'

$ Select-String … -Pattern "diffRoleOverride|mergeRolePatch|isEmptyPatch|removePatchField|normalizeFieldPath"
none
```

i18n 的 `overrideFieldsLabel` 是设置页文案键（历史遗留标签），与 Remote 契约无关，
属于 UI 文案清理范畴，不在本轮「后端/契约」范围内，故保留。

---

## 5. 未做项与原因

| # | 项 | 原因 |
| --- | --- | --- |
| 1 | `docs/configuration.md:307-325` 整节失效 API（审计问题 #2，误导性最高） | **不在本任务范围**（本任务是「后端/契约清理」）；且属用户文档改写，需产品口径确认后由文档 owner 处理。建议优先级仍高。 |
| 2 | `docs/gui-0.2.0.md:246,251,312,417-419,551` 指向已删模块 | 同上，历史设计文档，建议加「已废弃」头注而非逐行改。注意 `:551` 现在也死了（讲 `diffRoleOverride`，本轮已删该函数）。 |
| 3 | `docs/design/role-model-b2.md:19` 提及 `diffRoleOverride` / `normalizeFieldPath` | 同上，设计文档文字描述。本轮删除后该行**已成过时引用**，登记待文档轮次清理。 |
| 4 | `scripts/smoke-client-inject.mjs` | **已不需要**：`3c28579` 已修复并纳入 release 门禁，当前 8 PASS 中「客户端注入冒烟」为通过态。 |
| 5 | 审计 §A6 的 8 个低风险死导出（`CliPreferencesSchema` 等） | 审计明确其非 B3 产物、多为对外契约/调试用途，**不建议本轮动**，本轮遵从。 |
| 6 | 仓库卫生 100+ MB（工作树 / tgz / canary profile） | 超出本任务范围，且涉及 DSH 全局 profile（需 Lead 授权）。 |
| 7 | `src/session/config.js` 整文件删除 | 🔴 **红线，未做**：4 个生产调用方，删除会炸插件入口。已复核文件完好。 |
| 8 | 修改 `tests/gui.test.mjs:1326` 的 `deepEqual` | **不需要改**：两侧同步删除后两侧仍逐字相等。断言既未被削弱，也未删测试——这是最理想的结果（护栏保留，契约瘦身）。 |

### 需要 Lead 关注的两点

1. **客户端产物不会自动更新**：`src/client/index.js` 是宿主的浏览器 half 脚本。
   本次改动只改了仓库源码，**已安装的 `desktop` profile 里仍是 alpha.6 的旧构建**。
   若要在真机验证「5 个 descriptor 无会话残留」，需重新 `npm pack` + `install:safe`
   （属于发布动作，**我未执行**）。
2. **审计 §A6 有 1 处漏报**（`normalizeFieldPath`，见 §2.1）。我已按同一证据链处理并登记；
   其余审计结论经本轮实测**全部成立**，未发现需要推翻的判断。

---

## 6. 改动文件清单（本轮全部实际改动）

```
 src/client/index.js       |   8 ---     契约 4 键 + 2 个死 codec（纯删除）
 src/gui/config-api.js     |   5 ±       头注释（会话写入路径过时）
 src/gui/host.js           |  16 ±       头注释 2 块 + 方法列表注释 2 处
 src/gui/typert-spec.js    |  41 ±       契约 4 键 + 4 个死局部函数 + 头注释
 src/session/config.js     | 133 ±       5 个死导出（120 行）+ 3 处注释
 5 files changed, 19 insertions(+), 184 deletions(-)
```

19 行新增**全部是注释重写**（无一行新增可执行代码）；184 行删除中 120 行是
`config.js` 的死导出本体，其余为契约键、死局部函数与过时注释。

> 注：本轮 `git status` 中另有 `docs/plan/verify/2026-11-13-d1-windows.md` 为**并发 teammate**
> 修改，非本轮产物，我未读写该文件。
