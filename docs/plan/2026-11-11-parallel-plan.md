# 并行多任务方案（2026-11-11 确认版）

> 用户要求：彻底解决"同一项目只能跑一个任务"，同时兼顾安全；对风险与性能消耗要有应对。
> 原则：尽量复用 DSH 自带能力，非必要不重新开发。
>
> **状态：已实现（2026-11-11）。** 本文已按悟空裁决更新，实现见 `src/worktree.js`、
> `src/dispatch/dispatcher.js`、`src/dsh/adapter.js`、`src/run-store.js`。

## 1. 问题定义

现状（0.0.9 之前）：`dispatcher` 对同一 `projectKey` 的写任务**立即拒绝**（`WRITE_CONFLICT`），
没有等待队列。原因是子 Agent 直接在**主工作区**执行，并发写会互相覆盖。

结论：**并行必须以隔离为前提**；没有隔离的"调大并发"等于拿数据冒险。

## 2. 悟空裁决（照此实现，不再另设方案）

### 2.1 路线：自建 `git worktree`（路 2）

**决定：不使用宿主 `ctx.worktrees.create()`。**

理由（经代码核对）：

- 宿主内部 `createCheckout` 会调用 `workingDirectory.set(agent, path)`，把**父会话**的 cwd
  切到新建工作树；
- `create → restore` 之间没有事务锁，restore 可能被宿主其他 `working_directory` 调用覆盖；
- 一旦恢复失败，父会话 cwd 会留在工作树里，后续所有相对路径操作都会错位。

路 2 只接管 git 工作树管理，不碰 `workingDirectory`，父会话 cwd 始终不变。
代价是插件自己维护一段 git 调用代码；边界严格限定为 `worktree add` / `status` / `diff`。

### 2.2 并发上限：两级额度，先预占再异步

- `limits.maxParallelWritesPerProject` 默认 **2**
- `limits.maxParallelWritesTotal` 默认 **4**
- 两级额度在**首次异步操作之前一起预占**（包括建树）。否则两个并发请求会同时通过检查，
  然后一起 `git worktree add`。
- 所有 provider（spawn / acp / codex / claude-code）共用同一个 dispatcher 计数器。

### 2.3 清理：一律不自动删除

完成 / 失败 / 取消 / 插件卸载，**都不删除**工作树与分支。原因：未合并的改动可能只在工作树里，
自动删除等于丢代码。记录里的 `worktree` 元数据也不能被"100 条 / 30 天"淘汰，否则人工合并时
找不到树在哪。

### 2.4 失败关闭

请求隔离但建树失败 / 工作树服务缺失 → **拒绝派单**，返回明确错误码与预期残留位置；
绝不退回主工作区执行。`isolation:'none'` 与隔离任务也不得混跑：同项目任一方向有活动任务就拒绝。

### 2.5 隔离的准确含义

**这是文件布局隔离，不是权限沙箱。**

- 子 Agent 默认 cwd 是工作树，改动不会直接落到主工作区；
- 但子 Agent 仍在同一系统账号下运行，可以主动 `cd` 到主工作区写文件；
- 共享同一份 git 元数据（common-dir），工作树不是独立仓库；
- 不复制未跟踪 / 忽略文件（`node_modules`、`.env`、构建产物等）。

## 3. 实现结构

| 模块 | 职责 |
| --- | --- |
| `src/worktree.js` | 建树（literal argv、清理 `GIT_*`、禁交互、超时、输出上限）、按 common-dir 进程内互斥、`computeChangedFiles` |
| `src/dispatch/dispatcher.js` | 两级额度预占、隔离/未隔离互斥、失败回滚、operationId → childId 记录 |
| `src/dsh/adapter.js` | 用 `cwd=worktree.path` 启动；终态记录 `worktree` / `operationId` / `stopConfirmed` |
| `src/index.js` | 注入工作树管理器；终态落盘前计算 `changedFiles`（失败写 `changedFilesUnknown`） |
| `src/run-store.js` | 记录字段、`overlapWarnings`、带 worktree 记录免淘汰 |

### 工作树命名

```text
路径：<projectRoot>/.meetingstone/worktrees/<operationId>
分支：meetingstone/<operationId>
```

`operationId` 是 `randomUUID()`；路径或分支已存在时失败，绝不覆盖。

### 错误码

| 错误码 | 场景 |
| --- | --- |
| `WRITE_LIMIT_PROJECT` | 同项目并行写任务达上限（可重试） |
| `WRITE_LIMIT_TOTAL` | 全局并行写任务达上限（可重试） |
| `WORKTREE_UNAVAILABLE` | 请求隔离但工作树服务未注入 |
| `WORKTREE_NOT_GIT_REPOSITORY` | 项目根不是 git 工作区 |
| `WORKTREE_BASE_INVALID` | `base` 无法解析为 commit |
| `WORKTREE_PATH_EXISTS` | 工作树路径已存在 / 已被 git 登记 |
| `WORKTREE_BRANCH_EXISTS` | 分支已存在 |
| `WORKTREE_GIT_FAILED` | 其他 git 失败（含 `worktree add` 非零退出） |
| `WORKTREE_TIMEOUT` | git 命令超过 30 秒（建树）/ 10 秒（计算改动） |
| `WORKTREE_PATH_OUTSIDE` | 实际路径逃出项目根（Windows junction / symlink） |
| `INVALID_ISOLATION` | 请求里的 `isolation` 不是 `none`/`worktree` |

## 4. 冲突检测

- 建树时记录 `baseSha`（`git rev-parse <base>^{commit}` 的结果）
- 终态时计算 `changedFiles`：
  - `git status --porcelain -z --untracked-files=all`：暂存 / 未暂存 / 未跟踪 / 重命名（旧+新）
  - `git diff --name-status -z --find-renames <baseSha>`：已提交 / 暂存 / 未暂存（重命名旧+新）
  - 两路取并集
- 计算失败写 `changedFilesUnknown: true`，**绝不当成"无改动"**
- `get_task` / `list_runs` 返回 `overlapWarnings: [{ childId, files }]`：
  同项目、带工作树、`changedFiles` 有交集的记录；`changedFilesUnknown` 的记录不参与比较，
  但会在结果里标注未知
- **不做自动合并**；重叠只预警，由人决定

## 5. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 工作树缺依赖（node_modules/.env 等未跟踪文件不复制） | 文档明确"工作树不复制未跟踪/忽略文件"；需构建的任务先自行安装或不开隔离 |
| 合并冲突 | 不自动合并；`overlapWarnings` 预警；保留双方分支 |
| provider 限流（Codex/CodeBuddy 额度） | 全局总上限默认 4；识别 429 后可加退避（后续） |
| 磁盘占用（每棵树≈仓库大小） | 文档给清理命令；不自动 prune |
| Windows 下并发建树争 `.git` 锁 | 按 git common-dir 做**进程内**互斥；跨进程并发未验证 |
| 重启后孤儿工作树 | `list_runs` 展示路径/分支；人工清理 |
| 取消后工作树残留 | 不自动删（避免丢未合并代码）；文档说明 |
| 读取记录与 rename 竞争（Windows） | `run-store` 对 `EPERM/EACCES/EBUSY` 做短重试，避免终态退回 running |

## 6. 验收标准与结果

1. 同项目两个写任务并行：都 `ok`、各自 `completed`；主工作区文件内容不被直接改动
   （`.meetingstone/` 建议加入 `.gitignore`，否则 `git status` 会显示未跟踪的工作树目录）
   —— 已由 `tests/parallel.test.mjs` 的真实 git 用例覆盖
2. 两个任务改同一文件：各自完成，`overlapWarnings` 标记交集 —— 已覆盖（含未跟踪、重命名）
3. 建树失败（如非 git 目录）：派单被拒且错误可诊断，不退回主工作区 —— 已覆盖
4. 取消一个任务：另一个不受影响；槽位正确释放；工作树保留 —— 已覆盖
5. 重启后：`list_runs` 能看到 worktree 元数据；旧 running 映射为 `interrupted` —— 已覆盖
6. 跨项目并行本来就允许；本次不破坏 —— 已覆盖

**未验证**：真实多 provider 同时运行（本机测试全部使用假 subagents）；Windows 跨进程并发建树；
超时路径下 git 子进程是否完全退出（测试用假 gitRunner，未触发真实 kill）。
