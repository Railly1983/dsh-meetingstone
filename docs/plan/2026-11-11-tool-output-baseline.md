# 工具回执字节对照基线（A/B）

> 日期：2026-11-11
> 依据：`docs/reference/efficiency-v1.0.md` §7.2（A/B 基准测试方法）、§9 / §11（验收与口径）
> 复现命令：`node scripts/measure-tool-output.mjs`（表格）/ `node scripts/measure-tool-output.mjs --json`（机器可读）
> 数据出处：`scripts/measure-tool-output.mjs` 一次运行的输出（固定合成样本，无时间戳 / 随机值，重复运行字节一致）

## 声明（先读）

**估算≠真实 Token、Provider Usage 优先。** 本文的 `approxTokens` 是 `bytes/4` 与 `CJK 字符数/1` 取大者的粗估，只用于同一脚本内旧/新回执的相对对照，**不是** Tokenizer 或 Provider 计费值。文档 §7.2 明确要求：Provider 不返回 Usage 时必须标记统计不完整，**不用估算数冒充真实 Token**。真实主控 / 子 Agent Token、耗时、派单次数、重试次数、验收质量均不在本脚本测量范围内，一律记「未知」。

对照只证明「工具回执字节数下降」，**不构成**整体 Token 节省、任务质量或完成时长改善的结论（文档 §1.3 / §3.4）。

## 一、新旧对比表

`bytes` = `JSON.stringify(value ?? null)` 的 UTF-8 字节数（与工具 `output.render` 序列化一致）。`approxTokens(估算)` = `ceil(max(bytes/4, CJK 字符数/1))`，**估算**。

| 场景 | 旧机制回执 | 新机制回执 | 旧 bytes | 新 bytes | 节省 bytes | 节省 % | 旧估算 | 新估算 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `dispatch` | 全量（长人设 role + 模型参数 + Context Pack + 工作树） | 紧凑（`taskRef/roleId/roleName/isolation`） | 5056 | 204 | 4852 | 96.0% | 1264 | 51 |
| `get_task` | 默认全文（≈ `full:true`，约 8KB 结果） | 默认摘要（首 1024B + 末 512B + 截断标记） | 8192 | 1731 | 6461 | 78.9% | 2048 | 433 |
| `list_roles` | 全量详情（≈ `verbose:true`，5 角色） | 默认紧凑（每角色 5 字段） | 1884 | 548 | 1336 | 70.9% | 471 | 137 |

> 逐行原始 6 条 `{ name, bytes, approxTokens, note }` 见 `--json` 输出的 `rows`；`comparisons` 给出上表的节省列。

## 二、方法说明

**目标**：给「工具返回瘦身（P0-A）」提供可复现的字节对照，而非只凭沙僧审计的 31k / 10k / 3.4k 估算。

**脚本**：`scripts/measure-tool-output.mjs`，零依赖 Node ESM（仅 `node:` 内置模块 + 本仓库 `src/dsh/register.js`）。

**假环境 → 真实工具**：用假 `ctx.tools.register` + 假 `dispatcher` / 假 `run-store` 调用**真实的** `registerTools()`，工具 `execute()` 产出的回执即当前仓库在跑的代码结果，不是手写数字。

| 场景 | 旧机制（A 基线） | 新机制（B） |
| --- | --- | --- |
| `dispatch` | **构造**：瘦身前 `dispatcher.dispatch()` 原样返回的完整对象（完整 role 含长人设 / 模型参数 / 完整 Context Pack / 工作树细节），对应 §5.2「不得把完整 role description、系统人设、所有模型参数和完整 Context Pack 原样回传」 | 真实工具 `dispatch.execute()` 紧凑回执 |
| `get_task` | 用当前工具保留的 `full:true` 通道**等价重建**「旧版默认全文」 | 真实工具默认摘要（`TASK_RESULT_HEAD_BYTES=1024` + `TASK_RESULT_TAIL_BYTES=512`） |
| `list_roles` | 用当前工具保留的 `verbose:true` 通道**等价重建**「旧版全量详情」 | 真实工具默认紧凑 |

固定合成样本：

1. 带长人设的 role 派单（人设为确定性拼接的长系统提示）；
2. 一个约 8KB 的任务结果（头/尾固定 + CJK 复核记录填充到约 8000B）；
3. 5 个角色。

`approxTokens` 口径：`max(bytes/4, CJK字符数)`，CJK 取 `U+3400-4DBF / U+4E00-9FFF / U+F900-FAFF`，向上取整。对本文这些 ASCII/JSON 结构较多的混合样本，`bytes/4` 项占优；纯 CJK 文本下 `CJK 字符数` 项会占优。

**稳定性**：刻意不含时间戳 / 随机值 / 绝对路径依赖；两次运行 `--json` 与表格输出逐字节一致（已用 `diff` 校验）。

## 三、局限（样本 / 估算口径）

- **样本**：每组仅 1 个固定合成场景，共 3 组 6 个回执；**不是** §7.2 要求的「覆盖代码开发/审查/市场研究/数据分析的一组可重复任务」，也**没有中位数与分布**。与沙僧 35 条运行记录审计（31k / 10k / 3.4k、get_task 83%、dispatch 55%、list_roles 6.9k）口径不同，数字不可直接相互印证或代入。
- **旧机制重建方式**：`dispatch` 的旧回执是按 §5.2 / §11 描述**构造的模拟基线**（当前代码已无「返回全量」的 dispatch 分支）；`get_task` / `list_roles` 的旧回执借当前工具保留的 `full:true` / `verbose:true` 通道等价重建，会带有瘦身实现后来新增的少量元数据字段（如 `resultBytes` / `resultTruncated` / `errors` / `projectScoped`），与历史真实回执并非逐字段相同。三者都用于**同数据、不同投影**的相对对照。
- **估算口径**：`approxTokens` 把 JSON 的引号、花括号、字段名等结构字节也计入 `bytes/4`，CJK 按 1 字符≈1 token 粗估，二者取大；均**不是**任何具体模型 Tokenizer 的结果。不同模型 / Provider 差异很大。
- **未测项**（§7.2 要求记录、本脚本均无）：主控 Token、子 Agent Token、派单次数、重试次数、完成时长、验收结果、质量护栏（验收通过率 / 返工率 / 重复派单率 / 失败率）。这些需要真机跑同一项目版本、同一模型/Provider 并读取 Provider Usage；**无 Usage 即标「未知」，不以本估算填充**。
- 脚本不修改工具实现、不碰 `.meetingstone.json` / profile；`package.json` 仅新增独立 `measure` 脚本，不改动 `verify` 链。

## 四、复现

```
node scripts/measure-tool-output.mjs           # 表格（人类可读）
node scripts/measure-tool-output.mjs --json    # 纯 JSON：rows / comparisons / method / declaration
npm run measure                                # 等价入口
node scripts/run-tests.mjs                     # 回归：不受本脚本影响
```

## 五、结论边界

可复现地证明：在当前固定样本下，三个 P0-A 工具的**回执字节数**分别下降 96.0% / 78.9% / 70.9%。按 §7.2 / §9 / §11 的要求，**不声称**已实现整体 Token 节省、不声称达到第一阶段 20% 总 Token 目标、不声称质量或耗时改善——这些须以 Provider Usage 与真机 A/B（含中位数 / 分布 / 质量护栏）验证后再下结论。
