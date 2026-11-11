结论：**打回**。取消终态违反本机宿主契约，且摘要/重放丢失 §8 保护字段；不能以单测通过验收。
复核范围：2026-11-11，HEAD `5ac2f70b1ef1157364e0d1b4bd8faccce87665aa`，Node v20.16.0。
仅在当前 worktree 新增复核材料；未修改生产源码、主仓库、DSH profile。

**命令与亲测证据**

- `node scripts/run-tests.mjs` → exit 1，`pass 0 / fail 18`，均在测试 worker 启动时报 `spawn EPERM`；[日志](run-tests.log)。
- `node scripts/verify-host-schema.mjs` → exit 0，`PASS: 6 个工具的注册产物符合宿主 / 模型 API 契约`；[日志](schema.log)。
- `npm run verify` → exit 1，同样卡在测试 worker 的 `spawn EPERM`，后续链未执行；[日志](npm-verify.log)。
- 补跑 `node docs/audit/p0-a-review/all-direct.mjs` → `235 pass / 24 fail / 1 skipped`；24 个失败涉及进程/git 被 EPERM 拒绝，[日志](all-direct.log)。
- `node --input-type=module -e "import './tests/jobs.test.mjs'; import './tests/token-output.test.mjs'; import './tests/context-replay.test.mjs'" → `27 pass / 0 fail`；[日志](p0-direct.log)。
- 单独 `node scripts/verify-manifest.mjs` → 通过；`node scripts/verify-package.mjs` → `spawnSync ...cmd.exe EPERM`；[清单](manifest.log)、[打包](package.log)。
- `node docs/audit/p0-a-review/extract-host.mjs` → 只读提取本机 app.asar 的 Jobs 实现/UI/契约，文件 SHA-256 见[提取记录](host-extraction.log)。
- `node docs/audit/p0-a-review/review.mjs` → `PROBES_COMPLETE`；实际经过 registerTools → dispatcher → adapter，[探针](review.mjs)、[结果](probes.log)。

**工具契约实测（UTF-8 JSON 字节；与 output.render 的文本序列化一致，不是 Token）**

- 旧输入仅 `{role:'WK',task:'旧调用：审核即可'}` 成功，dispatch 回执 191 B；roleId/name/isolation 和 childId/name/provider/jobId 齐全。
- 33,137 B 长结果：get_task 默认回执 1,745 B、正文 1,533 B；full:true 回执 33,348 B，正文逐字相等，均无重复 output。
- list_roles 默认 145 B、5 个角色字段；verbose:true 为 336 B，恢复 description/channel/channelId/model/hasPrompt/source；人设全文按既有设计不返回。
- Job kind=`meetingstone-dispatch`，label=`悟空 · codex · 旧调用：审核即可`，owner 为当前 session id，taskRef/running 记录 jobId 一致。
- 正常/异常 outcome 分别 completed/failed；面板 hooks.cancel 独立调用：signal.aborted=true、dispose 调用 1 次、模型 activation 停止；工具取消经 jobs.kill 一次。
- jobs.start 抛错仍成功派单且 warning；服务完全缺失仍派单，但 warnings=[]。停止失败时 stopConfirmed=false，done.detail 含 `stop unconfirmed`。
- 更换 runtimeId 读取旧 running → interrupted=true；pathFor 指向该 childId 的记录，保留的旧 jobId 只作历史引用。

**问题清单与反例**

1. **阻断：取消 outcome 写错。** `src/dsh/adapter.js:450–472` 把取消/卸载映射成 cancelled；宿主契约和 isTerminal 仅接受 completed/killed/failed。
   将适配器实际 outcome 送入本机原始 isTerminal/statusLabel：completed、failed 正常，cancelled → terminal=false、`unhandled job status: "cancelled"`。
   宿主证据：`host-jobs.js:348`、`host-jobs-client.js:112`、`host-contract.md:32`（位于本目录，可通过提取命令重建）。
   应保留插件任务状态 cancelled，但原生 Job outcome 改为 killed，并补宿主状态集合与 UI 消费断言。
2. **阻断：§8 护栏未实现。** `src/dsh/register.js:278`、`src/context-replay.js:57–73` 无条件首尾截断；重放只取 output/result，忽略结构化保护字段。
   在正文中间放“验收标准/权限限制/任务边界/安全策略”后，默认 get_task 与重放均丢失；重放输入另有 acceptance/permissions/safetyPolicy/scope 也未保留。
   get_task 的 full:true 能恢复本次内存正文；这不能补救已注入下游的缺失重放。需保留保护字段或在无法安全摘要时显式阻断并提供完整引用。
3. **契约缺项：** `src/dsh/adapter.js:664` 缺 jobs 时直接 return null，未发出要求的 warning；`tests/jobs.test.mjs:230` 附近也未断言告警。
4. **断言过弱，未发现恶意造假证据。** `tests/jobs.test.mjs:96` 的 dispose 是空函数；`:204–207`、`:275–277` 只断言返回值/计数/自定义终态。
   变异①把 `hooks.cancel` 改为空函数：原 Jobs 测试仍 10/10 通过；独立探针显示 aborted=false、dispose=0、activation 仍 running。
   变异②跳过 `activation.dispose()`：原 Jobs 测试仍 10/10 通过；独立探针显示 dispose=0、模型仍活着，却回 stopConfirmed=true。
   重现：`node docs/audit/p0-a-review/.generated/no-panel-cancel/tests/jobs.test.mjs`；[10/10 日志](mutation-no-panel-cancel.log)。
   重现：`node docs/audit/p0-a-review/.generated/no-dispose/tests/jobs.test.mjs`；[10/10 日志](mutation-no-dispose.log)；变异副本由 review.mjs 生成，未改原文件。
5. **全文边界：** `src/run-store.js:410–452` 有既存 256KiB 落盘上限；300,000 B 结果落盘只剩 262,144 B，不能把重启后的 full:true 宣称为原始全文。

**Jobs 面板真机验证指引（修复阻断项后验收；当前版本可用于复现失败）**

1. 在隔离测试项目/测试 profile 加载待验 worktree；确认原生 jobs-local、tool-jobs 与客户端 ui-jobs/API controller 已加载，并使用同一会话。
2. 派一项约 60 秒的无外部写入测试任务；保存 dispatch 的 childId/jobId。到**会话顶部、preset 标签后的“后台任务”计数**点开；至少有一个 Job 才出现入口。
3. 在“进行中”找到 `meetingstone-dispatch`；核对“角色 · 实际 provider · ≤40 字任务摘要”、运行中状态、已启动进度及增长的耗时；展开行查看可用输出。
4. 让一项自然完成、另一项使用可控测试 provider 抛错；在“已结束”核对已完成/失败、耗时冻结、detail 与 get_task 证据一致。模型拒答不等于 provider 抛错。
5. 再派长任务，点击行右侧停止图标，**3 秒内再点“确认停止”**；观察“正在停止”→“已取消”（原生 wire 状态应为 killed），界面不得消失或报未知状态。
6. 用同一 childId 调 get_task，核对 cancelled + stopConfirmed:true；同时检查实际 CLI/子进程退出及测试心跳/写入停止。只见面板“已取消”不能证明停止；false 时不得重派写任务。
7. 另用 meetingstone_cancel_task 停一项，重复第 5–6 步的核对；如果 jobs 缺失或无 controller，派单仍可成功，但应有 warning 且不捏造 jobId。
8. 留一项运行任务后正常重启 DSH，再查其 childId/list_runs：旧任务应 interrupted，原生内存 Job 不应伪装为持续运行；记录旧/新进程及时间戳。必要时在隔离环境补做崩溃重启。
9. 显式 continuesFrom 再派才是“携带旧输出的新任务”：应产生新 childId/jobId，核对 continuationBytes；不是恢复旧 CLI 会话。旧 jobId 留在磁盘不代表旧 Job 已恢复。

**未验证项**：未操作真机 GUI，未启动真实 provider/CLI，未证明真实 OS 子进程退出、UI 通知/耗时/停止、实际重启恢复；默认 worktree 建树和打包受 EPERM 阻断。
输入兼容已在无建树 harness 验证，真实默认配置流程尚待真机；16KiB 是正文预算，本例含重放边界元数据实际 16,654 B；未测真实 Usage/Token 或质量下降比例。
