# 发布检查清单（0.1.0-alpha 起）

> 0.1.0-alpha 的具体执行页（版本同步、发布步骤、回滚、已知限制）见
> [release/0.1.0-alpha-checklist.md](release/0.1.0-alpha-checklist.md)；本文件保留通用门禁与安全审查。

> 每一项都要留下证据（命令 + 输出）。打不开的勾不许发版。
> 2026-11-10 事故后的教训：**"装得上"不等于"跑得动"**。

## 0. 门禁（必须全绿）

```powershell
npm run verify
```

包含四件：

| 检查 | 命令 | 通过标准 |
| --- | --- | --- |
| 单元/集成测试 | `node scripts/run-tests.mjs` | 全绿 |
| 工具 schema 契约 | `node scripts/verify-host-schema.mjs` | PASS，6 个工具（`list_roles` / `dispatch` / `list_runs` / `get_task` / `cancel_task` / `cli_status`） |
| manifest 自检 | `node scripts/verify-manifest.mjs` | 通过（name/engines/files/补丁一致） |
| 发布包内容 | `node scripts/verify-package.mjs` | 只含该含的文件，< 2 MB |

## 1. 隔离环境"跑得动"

```powershell
$env:DSH_HOME = "$env:TEMP\mt-release\dsh-home"
& $dsh plugin --profile mt-release add <包或本地目录>
& $dsh --profile mt-release --dump-config   # 层存在
# 启动该 profile，发一轮最小消息：工具可见 + 模型正常回复（200）
```

- [ ] `--dump-config` 出现 `# == dsh-meetingstone`
- [ ] 真实会话能看到 `meetingstone_list_roles` 并成功调用
- [ ] 没有 400 / schema 报错（查会话日志）

## 2. 新插件默认禁用（防爆炸半径）

- [ ] 先进 `dsh.profile.bundles`，同时在 profile 的 `cordis.patch.yml` 里 `disabled: true`
- [ ] 验证通过后再放开，再重启

## 3. 备份与回滚

- [ ] 安装前备份 profile 的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`
- [ ] 回滚命令写进 `docs/installation.md` 且实际演练过一次

## 4. 安全与文档

- [ ] `docs/security.md` 的权限承诺与最新 `audit/08` 一致（不许出现"绝不修改项目外路径"这类话）
- [ ] `docs/compatibility.md` 的实测组合是最新的
- [ ] `CHANGELOG.md` 有本版本条目
- [ ] README 中英文都更新
- [ ] 依赖许可扫描（`npm run verify` 之外，手动跑一次许可证检查）
- [ ] 无凭据泄漏（`git grep -n -E "sk-|AUTH_TOKEN|eyJ"` 无命中）

## 5. 发布

- [ ] `package.json` 版本号与 CHANGELOG 一致
- [ ] `npm pack` 产物人工看一眼（`verify-package` 已自动校验）
- [ ] npm 发布 + GitHub Release（附 tarball）
- [ ] 发布说明写明：第一版无 UI、外部派单需装 provider、权限承诺边界
- [ ] 不出现"官方插件/官方认证"表述（未获授权前）
