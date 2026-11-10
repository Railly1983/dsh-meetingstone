# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [SemVer](https://semver.org/)。

## [0.0.4] - 2026-11-10

### Added
- **派单结果落盘**：`.meetingstone/runs/<childId>.json`，原子写、结果 256 KiB 上限、错误 16 KiB、保留 100 条/30 天；
  `get_task` 内存优先、磁盘兜底（DSH 重启后仍可查终态）；写盘失败只附 `persistenceWarning`，不篡改真实结果
- **上下文重放**：`dispatch` 新增 `continuesFrom`，把上次结果作为不可信上下文重放（64 KiB，头 48K + 尾 16K）；
  找不到结果直接失败（`CONTINUATION_NOT_FOUND`），不静默降级
- `list_roles` 返回 `description` / `hasPrompt` / `channelId` / `model`，配置可自证

### Changed
- 版本 0.0.4；测试 173 项
- Codex provider 可换新版二进制（运维步骤见 docs/installation.md），0.167 下支持 gpt-6.1-sol 等 4 个模型

## [Unreleased]

### Added
- **并行多任务（任务级工作树隔离）**（2026-11-11 悟空裁决，路 2）：
  - 新增 `src/worktree.js`：自建 `git worktree`（literal argv、清 `GIT_*`、`GIT_TERMINAL_PROMPT=0`、
    30s 超时、输出上限、按 git common-dir 进程内互斥）；路径
    `.meetingstone/worktrees/<operationId>`、分支 `meetingstone/<operationId>`
  - `meetingstone_dispatch` 新增 `isolation: 'none' | 'worktree'`，默认 `worktree`
  - 两级额度 `maxParallelWritesPerProject`（默认 2）/ `maxParallelWritesTotal`（默认 4），
    在首次异步操作前一起预占；超限返回可重试的 `WRITE_LIMIT_PROJECT` / `WRITE_LIMIT_TOTAL`
  - 失败关闭：建树失败/服务缺失 → 拒绝派单，绝不退回主工作区；`isolation:none` 与隔离任务不得混跑
  - 工作树/分支**一律不自动删除**（完成/失败/取消/卸载都不删）
  - 记录新增 `worktree` / `changedFiles` / `changedFilesUnknown` / `operationId` / `stopConfirmed`；
    `list_runs` 不再丢 `worktree` 字段
  - `get_task` / `list_runs` 返回 `overlapWarnings`（同项目改动文件交集）；`changedFilesUnknown`
    的记录不参与比较但标注未知
  - 淘汰保护：带 `worktree` 的记录不参与 100 条/30 天清理
  - 新增测试 `tests/worktree.test.mjs`（真实 git 建树/冲突/超时/computeChangedFiles）与
    `tests/parallel.test.mjs`（额度、跨项目、失败关闭、取消/卸载、重叠、淘汰）
- 新错误码 `WORKTREE_*` / `WRITE_LIMIT_*` / `INVALID_ISOLATION`（见 `docs/configuration.md` §5）
- `docs/plan/2026-11-11-parallel-plan.md` 写入悟空裁决；`docs/worktree-isolation.md` 改为
  「自动隔离 + 手动流程并列」，明确**文件布局隔离 ≠ 权限沙箱**
- **生命周期正确性（P0）**：取消改为「先 `dispose()`（默认 5s 超时兜底）再释放槽位」；
  落盘按 `childId` 串行（running 一定先于终态）；新增 `runtimeId`，重启后把旧 `running`
  投影为 `interrupted`；插件卸载时为存活任务写 `interrupted` 终态
- 新错误码 `ADAPTER_DISPOSE_TIMEOUT` / `ADAPTER_DISPOSE_FAILED`（见 `docs/configuration.md` §5）
- 角色注册表：别名解析、冲突降级（标记 `ambiguous` 而非整表失败）
- 项目级配置 `.meetingstone.json`：mtime 缓存、坏文件降级、与全局配置合并
- 本机 CLI 探测：多源解析（PATH → Appx → npm 全局 → 常见目录），带版本试跑与缓存
- 派单编排：同项目任务串行、按项目隔离、失败回滚、`onFinish` 幂等释放
- DSH 接线层：`ctx.subagents` 适配器 + 六个工具（`meetingstone_list_roles` / `_dispatch` / `_list_runs` / `_get_task` / `_cancel_task` / `_cli_status`）
- 通道实例表 `channels`：模型/强度由 provider 行承载，角色声明必须一致（DD7 方案 B）
- 发布门禁 `npm run verify`：全量测试 + 宿主/模型 API 契约校验
- **工作树隔离（手动流程）**：`docs/worktree-isolation.md` + `examples/worktree-dispatch.jsonc`，说明用宿主
  `create_worktree` 建隔离工作树、派单 `cwd` 指向它、人工 merge / cherry-pick / patch 合并与
  `git worktree remove` / `prune` 清理。

### Changed
- `limits` 新增 `defaultIsolation`（默认 `worktree`）；`serializeWrites` 仅在 `isolation:none` 时生效
- 当前开发线：6 个工具；`node scripts/run-tests.mjs` 214 项全绿；`node scripts/verify-host-schema.mjs` PASS
- `docs/configuration.md` / `docs/security.md` / `examples/worktree-dispatch.jsonc` 同步并行隔离与失败关闭语义
- 文档校准：`permissionPreset` / `readOnly` / `READONLY_*` / `maxParallelReadonly` 等只读旧表述统一标注
  「已移除 / 不做（已移除）」；审计文档保留历史并加"已移除"声明；`docs/audit/15` 能力对照补
  「并行多任务：已实现」；`docs/worktree-isolation.md` 链接进中英文 README。

### Fixed
- **Windows 并发读取时的终态丢失**：记录文件被 `readFile` 占用时 `rename` 偶发 `EPERM/EBUSY`，
  导致终态退回 `running`；`run-store` 对 `EPERM` / `EACCES` / `EBUSY` 做短重试
- **2026-11-10 事故**：工具 `parameters` 未编译成合法 JSON Schema，导致 DeepSeek 对全部会话每轮返回 400。
  现改为按宿主契约编译，并在注册前 fail-fast 校验；见 `docs/audit/13-incident-tool-schema.md`
- 并发写任务在占槽前就启动（两个写任务可同时成功）；槽位在任务结束后不释放
- 歧义角色提示"请用 roleId"但 roleId 也被拒
- `channel` 字段级覆盖会把 `kind` 重置成默认值

### Removed
- **只读通道彻底移除**（2026-11-11 用户决策）：`meetingstone_dispatch.readOnly` 参数、`readOnlyEnforced`、
  `permissionPreset`（角色与通道实例）、`READONLY_UNENFORCEABLE` / `READONLY_LIMIT`、只读并发计数与
  `limits.maxParallelReadonly` 全部删除。原因：宿主 subagent spec 没有权限字段，做不到绝对只读，就整个不提供。
  **不要再实现**；`docs/audit/14`、`docs/audit/15` 里保留的是历史记录。
- **项目级 `limits` 死配置移除**：`.meetingstone.json` 不再解析/校验/导出 `limits`；`serializeWrites` 只在插件
  全局配置（`src/config.js`）里生效。旧项目配置里写了 `limits` 会按未知字段忽略，不报错、不阻断派单。

### Security
- 派单 `cwd` 必须落在项目根内；拿不到项目根则失败关闭
- 并行隔离是**文件布局隔离，不是权限沙箱**：同账号、同文件系统、共享 git 元数据
- 工作树建树前后都做 realpath 校验，防 junction/symlink 逃出项目根
- 不读取/复制/注入任何 CLI 凭据；探测只报文件是否存在
