# 效率机制 P0 实施计划（对齐《协作效率与 Token 优化机制 V1.0》）

> 依据：`docs/reference/efficiency-v1.0.md`（用户提供的交接文档 V1.0）
> 原则：先基线、再最小实现；保留 full/verbose 诊断能力；不把估算 Token 当真实 Usage；
> 不新建独立调度 Agent / 任务面板 / 队列 / 数据库；任务展示复用 DSH Jobs。

## 一、文档要求与当前状态对照

| 文档 P0 项 | 现状 | 差距 |
| --- | --- | --- |
| A. get_task 默认摘要（首 1KB + 末 512B，full:true 全文） | 沙僧实现中 | 需补 `truncated`/原始长度标记、结构化字段优先 |
| A. dispatch 紧凑回执（taskRef + roleId/name + isolation） | 沙僧实现中 | 需确认真实返回体与文档字段一致 |
| A. list_roles 紧凑（verbose:true 详细） | 沙僧实现中 | — |
| B. TaskSpec（title/objective/scope/acceptance/evidence/contextRefs） | **未做** | 需 schema + 最小校验 + Prompt 组装修正 |
| B. Context Pack（已知事实/文件/前序成果/禁止重复） | **未做** | 与 TaskSpec 一并做，传递最小上下文 |
| B. 重放 64KiB→16KiB（先评估影响） | 沙僧实现中 | 需保留结构化字段、不截断安全规则 |
| C. 结构化结果（status/summary/evidence/artifacts/openIssues/nextAction） | **未做** | 需输出契约 + 解析/落盘 + artifactRef |
| C. Handoff 模板 | **未做** | 文档模板 + 记录字段 |
| D. 进行中任务去重（非仅 prompt hash） | **未做** | 指纹需含 project/role/provider/任务规范化/版本/状态/权限 |
| D. 免轮询 + 一次汇报多任务 | 规范已有（小白文档中） | 保持，等 DSH 事件/Jobs 通知可用后再强化 |
| Jobs 集成（Codex 方案） | 沙僧实现中 | 需真机验证面板名称/状态/时长/停止 |

## 二、任务拆分与负责人

| 阶段 | 任务 | 负责人 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P0-A | 本轮：get_task 摘要、dispatch 瘦身、list_roles 紧凑、重放 16KiB、Jobs 包装 | 沙僧（进行中） | — | 单测 + verify；返回体字节前后对比 |
| P0-B | TaskSpec + ContextPack schema、最小校验、prompt 组装（不新增 AI 调用） | 沙僧（下一轮） | P0-A 合并 | 简单任务不被表单化；缺关键字段才拒绝 |
| P0-C | 结构化结果契约 + 解析落盘 + artifactRef + Handoff 模板 | 沙僧（下一轮） | P0-B | 主控默认只拿摘要；全文可按需读取 |
| P0-D | 进行中任务去重（多因素指纹） | 沙僧（第三轮） | P0-A/B | 相同进行中任务返回既有 taskRef；不同上下文不误判 |
| 文档 | 效率规范落地（按文档 V1.0 重写 `docs/efficiency.md`） | 小白（进行中，需按本文档校准） | — | 与文档一致、无死链 |
| Jobs 验证 | 原生 Jobs 面板真机验证（名称/状态/时长/停止/重启丢失） | 悟空（复核）+ 用户（面板目视） | P0-A | 面板可见；停止能停 activation；重启后不伪装续跑 |
| 复核 | 统计口径、去重安全、摘要不丢安全/验收字段 | 悟空 | P0-B/C/D | 独立验证报告，不照抄估算 |
| 阶段验收 | P0 范围与边界确认、最终签字 | 唐僧 | 复核通过 | 签字或否决理由 |

## 三、明确不做（文档 §9.1）

- 独立工作流引擎、独立 AI 调度 Agent
- 独立任务面板 / 队列 / 数据库 / 全量任务历史仓库
- 把所有任务强制成复杂表单
- 默认自动换模型 / 自动提升权限 / 无条件自动重试
- 把完整聊天历史复制给每个 CLI

## 四、P1（不混入本轮）

失败分类与冷却重试、确定性角色路由、效率账本（前后对照报告）。
先完成 P0 并出基线对比，再单独立项。

## 五、Token 计量与验收

- 工具回执字节数：插件直接统计（对旧/新输出做对照）
- 主控/子 Agent Token：优先 Provider Usage；拿不到写"未知"，不估算冒充
- 质量护栏：验收通过率、返工率、重复派单率、失败率不得因摘要/截断恶化
- 第一阶段目标：代表性任务可观测总 Token 中位数较基线下降 20%（目标，非承诺）
