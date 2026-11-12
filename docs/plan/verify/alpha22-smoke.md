# alpha.22 发布前真实冒烟

执行时间：2026-11-12
执行环境：工作树 `d:\MeetingStone\.meetingstone\worktrees\35ef2bea-d24f-489e-b3de-a1d8ecb23bc0`

## 冒烟项

| # | 项目 | 命令 | 结果 |
|---|------|------|------|
| 1 | HEAD 提交 | `git log --oneline -1` | `3a1fc97 chore(release): 0.1.0-alpha.22（D1 验收自动化 + 门禁 9 项）` |
| 2 | Node 版本 | `node --version` | `v20.16.0` |
| 3 | src/dsh 下 .js 文件数 | `find src/dsh -name "*.js" -type f \| wc -l` | `3` |

## src/dsh .js 文件清单（Glob 核对）

1. `src/dsh/adapter.js`
2. `src/dsh/register.js`
3. `src/dsh/steer.js`

## 结论

三项冒烟均实际执行并通过：HEAD 停在 alpha.22 发布提交（3a1fc97），Node v20.16.0 可用，src/dsh 目录包含 3 个 .js 文件，与预期一致。
