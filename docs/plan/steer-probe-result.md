# src 目录 .js 文件行数统计

- 统计时间：2026-11-12 17:28 (+08:00)
- 统计范围：`D:\MeetingStone\src` 递归下所有 `.js` 文件
- 统计方式：逐目录读取、逐步累加（`Get-Content | Measure-Object -Line`）

## 结果

**总计：18473 行，36 个 .js 文件**

## 分目录明细

| 目录 | 文件数 | 行数 | 累计 |
| --- | ---: | ---: | ---: |
| `src`（顶层） | 9 | 4043 | 4043 |
| `src\cli` | 5 | 1904 | 5947 |
| `src\client` | 1 | 3101 | 9048 |
| `src\config` | 1 | 311 | 9359 |
| `src\dispatch` | 4 | 1686 | 11045 |
| `src\dsh` | 3 | 3305 | 14350 |
| `src\gui` | 5 | 1766 | 16116 |
| `src\project` | 3 | 685 | 16801 |
| `src\roles` | 4 | 965 | 17766 |
| `src\session` | 1 | 707 | 18473 |

## 逐文件明细

| 文件 | 行数 |
| --- | ---: |
| `cli\capabilities.js` | 1037 |
| `cli\preferences.js` | 167 |
| `cli\preflight.js` | 218 |
| `cli\probe.js` | 282 |
| `cli\resolvers.js` | 200 |
| `client\index.js` | 3101 |
| `config.js` | 211 |
| `config\global-writer.js` | 311 |
| `context-replay.js` | 427 |
| `dispatch\dispatcher.js` | 938 |
| `dispatch\failure.js` | 199 |
| `dispatch\reuse-policy.js` | 149 |
| `dispatch\routing.js` | 400 |
| `dsh\adapter.js` | 1780 |
| `dsh\register.js` | 1275 |
| `dsh\steer.js` | 250 |
| `gui\config-api.js` | 347 |
| `gui\host.js` | 681 |
| `gui\state-model.js` | 366 |
| `gui\typert.js` | 153 |
| `gui\typert-spec.js` | 219 |
| `index.js` | 445 |
| `naming.js` | 153 |
| `project\config-file.js` | 206 |
| `project\load.js` | 111 |
| `project\write.js` | 368 |
| `result-contract.js` | 332 |
| `roles\capabilities.js` | 215 |
| `roles\ids.js` | 26 |
| `roles\registry.js` | 540 |
| `roles\template.js` | 184 |
| `run-store.js` | 1104 |
| `schema.js` | 153 |
| `session\config.js` | 707 |
| `taskspec.js` | 491 |
| `worktree.js` | 727 |

## 说明与偏差

统计期间源码树存在并发写入，`src\dsh` 目录三次读到的值不同：

- 第一次读到 3255 行（`dsh\steer.js` = 200 行）
- 全量交叉校验读到 3306 行
- 最终快照（17:28:31）读到 3305 行（`dsh\steer.js` = 250 行，字节数 11691）

`dsh\steer.js` 与 `dsh\register.js` 的 mtime 分别为 17:28:21 和 17:27:52，落在统计窗口内，因此**最终值 18473 行为 17:28:31 时刻的快照**，与最初逐目录累加的 18423 相差 50 行，差异全部来自 `dsh\steer.js` 的改动，不是统计脚本误差。

若需要严格一致的数值，建议在源码树静默时重跑同一命令。
