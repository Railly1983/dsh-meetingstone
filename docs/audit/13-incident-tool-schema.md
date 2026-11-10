# 13 · 事故复盘：工具 schema 非法导致 DSH 全局不可用（2026-11-10）

> 严重度：**会话层全局不可用**（本机单用户开发环境；若在团队共享/生产 profile 上发生即 P0）
> 责任：主责在本项目（违反官方工具契约 + 跳过已验证门禁）；次责在宿主（`parameters` 零校验、单工具非法不隔离）
> 状态：已修复并加门禁；独立复核见 §6

## 1. 时间线

| 时间 | 事件 |
| --- | --- |
| 16:16 | 把 `dsh-meetingstone` 装进真实 `desktop` profile（此前只做了"装得上"的沙盘演练） |
| 16:16+ | 每轮对话请求 400，模型一次都没被调用；看起来像"DSH 全崩" |
| ~16:30 | 用户在 WorkBuddy 协助下定位：工具 `parameters` 不是合法 JSON Schema |
| 16:40 | 修复 + 门禁落地；`npm run verify` PASS |
| 16:43 | 重启 DSH，本轮会话中 `meetingstone_*` 三个工具可正常调用（见 §6 实测） |

## 2. 根因链（三层放大）

| 层 | 事实 | 后果 |
| --- | --- | --- |
| 我们的代码 | `src/dsh/register.js` 未用官方 `defineTool`，把作者 DSL 字段字典**原样**交给 `ctx.tools.register`；`readOnly` 这个字段名落在 JSON Schema 根上，而 `readOnly` 是保留注解（必须布尔） | 生成的 schema 非法 |
| 宿主 | `@deepseek-ai/dsh-tools` 的 `register()` 只校验 `output.schema`，**不校验 `parameters`**；`schemas()` 投影时原样深拷贝 | 坏定义进入全局工具集 |
| API | 每轮请求把**全部**工具 schema 整包发出；服务端对 `tools` 数组整包校验，一个非法即 400 `INVALID_REQUEST` | profile 下所有会话都发不出请求 → "DSH 全崩" |

关键错误信息（原文）：

```
Invalid schema for function 'meetingstone_dispatch':
{"type":"boolean","description":"只收紧、不放宽；无法强制时会明确标记"} is not of type "boolean"
```

## 3. 我们的流程失误（比代码 bug 更值得记）

1. **已知风险被跳过**：`register.js` 文件头 TODO 与 `12-arch-review.md` 都写了"defineTool 降级路径未验证，必须真机联调"，但它只是注释，没有变成发布门禁。
2. **演练标准错了**：沙盘演练只验"装得上"（lock 多 3 行、patch 未动），没验"跑得动"（发一轮真实请求）。
3. **测试是假 ctx**：137 项单测全绿，却不经过宿主编译、也不经过 API 校验。
4. **直接动生产 profile**：违反自己写在 R16 的"先在隔离 profile 验证"。

## 4. 修复（WorkBuddy 实施，本项目团队复核）

| 文件 | 改动 |
| --- | --- |
| `src/dsh/register.js` | 新增 `compileParameterSpec` / `compileValueSchema` / `compileToolSpec`，把字段字典**编译成** `{type:'object', properties, required?}`；三个 `output.schema` 补 `additionalProperties:true`；注册前 `assertHostReadySchema` fail-fast（坏定义让插件自己加载失败，不污染全局工具集） |
| `src/index.js` | 同步探测宿主 `@deepseek-ai/dsh-tools` 并注入真实 `defineTool`（刻意不用顶层 await，避免 `require(ESM)` 加载炸） |
| `scripts/verify-host-schema.mjs` | **发布门禁**：用假 ctx 走 `apply()`，校验最终注册产物；内置"事故模式自检"（确认检查器能抓到未编译字典） |
| `package.json` | `npm run verify` = 全量测试 + 门禁 |
| `tests/wiring.test.mjs` | +2 回归：schema 合法性、注入 defineTool 时不双重编译 |
| `tests/dsh-adapter.test.mjs` | 测试桩改为模拟真实编译产物 |

## 5. 杜绝措施（已落地 vs 待流程执行）

| # | 措施 | 状态 |
| --- | --- | --- |
| 1 | **发布门禁**：`npm run verify` 不过不许装真实 profile | ✅ 已落地为脚本 |
| 2 | **装真实 profile 前必须在隔离 `DSH_HOME` 发一轮真实请求**（不是只看 dump-config） | ⏳ 流程规则，写进本文件与 `installation.md` |
| 3 | **开发 / 生产 profile 分离**：`desktop` 只在门禁通过后更新 | ⏳ 流程规则 |
| 4 | **新插件默认禁用**：先进 bundles 但在 `cordis.patch.yml` 里 `disabled: true`，验证后再放开 | ⏳ 流程规则（下次安装照此执行） |
| 5 | **"未验证的降级路径"一律当发布 blocker**，不允许只躺在 TODO 注释里 | ⏳ 流程规则 |
| 6 | **恢复预案**：profile 关键文件已备份（`.bak-20261110-161644`），一键从 `bundles` 移除 + 重启可止血 | ✅ 备份已存在 |

## 6. 独立复核（本项目主 Agent 亲测，不采信转述）

| 检查 | 结果 |
| --- | --- |
| `node scripts/verify-host-schema.mjs` | **PASS**，3 个工具；`meetingstone_dispatch` 的 `readOnly` 落在 `properties` 里 |
| `node --test "tests/**/*.test.mjs"` | **139/139 通过** |
| 真实会话调用 `meetingstone_list_roles` | 返回 `{roles:[],errors:[],projectScoped:true}` —— 插件已加载、schema 被 API 接受 |
| 真实会话调用 `meetingstone_cli_status` | codex 命中 `appx` 源（PATH 查不到）、codebuddy 命中 `path`、claude 如实报未安装 |
| R19（peer 依赖解析） | **已随之解决**：插件在真实 profile 加载成功，说明 `@deepseek-ai/schemastery` 运行时解析成立 |

## 7. 建议向宿主反馈（我们只能外围补，根治在宿主侧）

1. `ctx.tools.register()` 应对 `parameters` 也跑 `assertSupportedJsonSchema`；
2. 投影前逐个工具校验，**单个工具非法时降级隐藏该工具并告警**，而不是整包发给 API 让服务端拒；
3. 这属于"一个插件的错误能拖垮整个 profile"的爆炸半径问题，值得宿主侧做隔离。

> **后续（2026-11-10）**：为彻底消除 peer 依赖解析风险，配置校验改为内置零依赖实现（`src/schema.js`），
> 不再声明 `@deepseek-ai/schemastery` 的 peer/dev 依赖；R19 因此自然消解（插件不再有外部运行时依赖）。
