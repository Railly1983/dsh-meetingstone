# 多 CLI 协作架构小规模验证 · 测试协议

> 立项：2026-11-12（八戒调度）｜基线 commit `79b1de4`｜宿主 DSH 0.2.2-rc.1
> 约束：**只验证、不开发、不改插件正式代码、不合并任何 worktree。**

## 1. 本次可执行范围（先划边界）

| 执行者 | 通道 / 模型 | 可用性 | 依据 |
| --- | --- | --- | --- |
| 八戒（Lead） | DSH 原生 in-process · deepseek-flash | ✅ 可测（四桶真实 usage） | 会话日志含 `cacheReadTokens` |
| 沙僧 | CodeBuddy ACP · `deepseek-v4.1-flash` · effort max | ⚠️ 待实测（11-11 曾出现 quota 拒答） | `~/.codebuddy` jsonl 含 `rawUsage` |
| 小白 | CodeBuddy ACP · `hy3` · effort high | ⚠️ 待实测 | 同上 |
| 唐僧 | Codex · `gpt-6-astra` | ❌ 通道不可用 + 无额度 | `meetingstone_list_roles` = provider-unavailable |
| 悟空 | Codex · `gpt-6.1-sol` | ❌ 无额度（用户明确） | 用户指令 |
| Claude / Kimi | claude-code / acp-kimi | ⛔ 已停用 | 角色表 enabled=false |

**因此：任务书第三节"Codex A/B/C"标记为「不可执行」，不以推测填充；改用 CodeBuddy + DSH 做同构验证。**

## 2. 测量口径（真实数据，不估算）

### 2.1 DSH 侧（八戒 / in-process 子代理）
源：`~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`（多帧 zstd）
- 四桶：`uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`
- 缓存命中率 = `cacheRead / (cacheRead + uncachedInput)`
- 同一 `(turn,step)` 流式样本按替换处理，`llm/retry-started` 后重新计
- 工具：`.token-test/scan-sessions.mjs`（只读）

### 2.2 CodeBuddy 侧（沙僧 / 小白）
源：`~/.codebuddy/projects/<project-dir>/<sessionId>.jsonl`
- 每个 API 调用一条 `providerData.rawUsage`：`prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens`
- 未命中 = `prompt - cached`；命中率 = `cached / prompt`
- 工具：`.token-test/scan-codebuddy.mjs`（只读）

### 2.3 不可得项（一律写「未知」，不推算）
- Codex usage（无额度，无法产生数据）
- 跨供应商价格（不同 CLI 模型 ID 不同，不横向比原始 token/费用）
- 宿主是否把缓存命中按折扣计费（只记录 token 口径）

## 3. 测试分组与本轮执行

### T1 · 原生子代理 vs 独立线程（Codex 版不可执行）
- Codex A/B/C：❌ 不执行（无额度）
- **替代验证（DSH 原生）**：一个子代理串行做两任务 vs 两个独立子代理并行做两任务，比总 token / 调用数 / 耗时
- CodeBuddy 简化验证：是否支持原生 subagent（`codebuddy --help` / 文档），能否观测子代理用量

### T2 · 同一角色多实例（沙僧）
- 任务 P1：只读分析 `src/result-contract.js`（职责/导出/依赖/3 风险，≤300 字）
- 任务 P2：只读分析 `src/cli/preflight.js`（同上）
- A 组：1 个沙僧实例顺序完成 P1 → P2（1 次派单）
- B 组：2 个沙僧实例并行各完成 P1 / P2（2 次派单，独立 worktree）
- 指标：墙钟耗时、请求数、prompt/cached/output token、是否重复读文件、输出质量、文件冲突
- 顺序：先 B 后 A（避免两组同时抢额度/限流污染耗时对比）

### T3 · 交接效率（沙僧 → 小白）
- 阶段 1（沙僧）：只读分析 `src/context-replay.js`，输出现状摘要 + 3 条改进建议 + 2 条风险（≤400 字）
- A 组（完整历史）：把阶段 1 的**完整回复原文**（含过程叙述）连同要求交给小白
- B 组（结构化精简）：只交 6 字段（目标/约束、已确认决策、已完成、产物位置、证据、未决问题与下一步）
- 指标：接收者首次请求 prompt token、总请求数、是否重读项目文件（工具调用）、遗漏事实、返工

### T4 · Prompt Cache 命中
- A 稳定前缀：固定的角色指令 + 项目规范在前，变化的任务信息在后
- B 动态前缀：在固定内容前插入变化的任务 ID / 时间
- C 同一 CLI 多实例：相同角色、相同公共上下文，依次发独立任务
- D 跨 CLI：DSH 与 CodeBuddy 的模型 ID 不同（deepseek-flash vs deepseek-v4.1-flash），**不满足"同一模型同一服务端"前提 → 标记不可比**
- 每组先预热一次再采样

## 4. 统一记录表字段

完成耗时 / 输入 token（未命中+命中）/ 输出 token / 缓存命中 token / 命中率 / 请求数 / 实际成本（不可得写未知）/ 验收结果 / 上下文遗漏 / 重复工作 / 人工干预次数

## 5. 禁区

1. 不改 `src/`、`tests/`、`scripts/` 正式代码；不 commit；不合并 worktree。
2. 不伪造 token；拿不到就写「未知」。
3. 不因为"能实现"就建议开发进插件。
4. 测试产物只落 `.token-test/`（未入库）与各自 worktree（不合并）。
