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
- 角色注册表：别名解析、冲突降级（标记 `ambiguous` 而非整表失败）、权限只收紧
- 项目级配置 `.meetingstone.json`：mtime 缓存、坏文件降级、与全局配置合并
- 本机 CLI 探测：多源解析（PATH → Appx → npm 全局 → 常见目录），带版本试跑与缓存
- 派单编排：写任务串行、只读限流、按项目隔离、失败回滚、`onFinish` 幂等释放
- DSH 接线层：`ctx.subagents` 适配器 + 三个工具（`meetingstone_list_roles` / `_dispatch` / `_cli_status`）
- 通道实例表 `channels`：模型/强度由 provider 行承载，角色声明必须一致（DD7 方案 B）
- 发布门禁 `npm run verify`：全量测试 + 宿主/模型 API 契约校验

### Fixed
- **2026-11-10 事故**：工具 `parameters` 未编译成合法 JSON Schema，导致 DeepSeek 对全部会话每轮返回 400。
  现改为按宿主契约编译，并在注册前 fail-fast 校验；见 `docs/audit/13-incident-tool-schema.md`
- 只读无法强制时改为**拒绝启动**，不再启动后标记 `readOnlyEnforced:false`
- 并发写任务在占槽前就启动（两个写任务可同时成功）；槽位在任务结束后不释放
- 歧义角色提示"请用 roleId"但 roleId 也被拒
- `channel` 字段级覆盖会把 `kind` 重置成默认值

### Security
- 派单 `cwd` 必须落在项目根内；拿不到项目根则失败关闭
- 不读取/复制/注入任何 CLI 凭据；探测只报文件是否存在
