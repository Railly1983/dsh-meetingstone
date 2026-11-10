# 贡献指南

## 开发环境

| 项 | 要求 |
| --- | --- |
| DSH | `0.2.2-rc.1` |
| Node | ≥ 22.13（**用 DSH 内置 node**：`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`） |
| pnpm | 11+，用上面那个 node 跑 |

> 系统 node v20 跑内置 pnpm 会 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` 直接崩。

## 提交前必跑

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --test "tests/**/*.test.mjs"
& $node scripts/verify-host-schema.mjs
& $node scripts/verify-manifest.mjs
# 或一条：npm run verify
```

**门禁不过，不许装进任何真实 profile。** 理由见 `docs/audit/13-incident-tool-schema.md`（一个非法工具 schema 能让整个 profile 的所有会话不可用）。

## 改文件的硬规矩

**不要用 PowerShell 的 `Get-Content` / `Set-Content` 改写含中文的源文件**——已经三次把 UTF-8 变成乱码或吃掉换行。
用编辑工具，或 Node 的 `fs.readFileSync(...,'utf8')` / `writeFileSync(...,'utf8')`。

## 改动守则

1. **复用优先**：团队/项目/任务/会话/权限/统计一律用 DSH 原生，先证明缺口再写代码（`docs/audit/00-summary.md` 的 A/B/C 分类）。
2. **不自研 CLI 启动器**：派单经宿主 provider（`docs/audit/03-native-capabilities.md` F2/F3）。
3. **不假装**：拿不到的值写 `unknown`/`installed:false`；无法强制的权限**拒绝启动**而不是标个标记。
4. **纯逻辑可测**：解析/合并/并发这类逻辑不要直接依赖 DSH API，用注入的适配器/IO，保证 `node --test` 能覆盖。
5. **clean-room**：不得复制 CLIWorker 的任何实现，见 `docs/CLEAN_ROOM.md`。

## 装进真实 profile 的流程

1. `npm run verify` 通过
2. 隔离 `DSH_HOME` 里安装并**真发一轮请求**（不是只看 `--dump-config`）
3. 新插件先进 `bundles` 但 `disabled: true`，验证后放开
4. 安装前备份 profile 的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`

## 提交信息

用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀；修 bug 时在正文写清"为什么坏、怎么证明好了"。
