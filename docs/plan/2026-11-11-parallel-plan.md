# 并行多任务方案（2026-11-11 确认版）

> 用户要求：彻底解决"同一项目只能跑一个任务"，同时兼顾安全；对风险与性能消耗要有应对。
> 原则：尽量复用 DSH 自带能力，非必要不重新开发。

## 1. 问题定义

现状（0.0.9 之前）：`dispatcher` 对同一 `projectKey` 的写任务**立即拒绝**（`WRITE_CONFLICT`），
没有等待队列。原因是子 Agent 直接在**主工作区**执行，并发写会互相覆盖。

结论：**并行必须以隔离为前提**；没有隔离的"调大并发"等于拿数据冒险。

## 2. 方案：任务级工作树隔离

| 维度 | 设计 |
| --- | --- |
| 隔离单位 | 每个写任务一个独立 git worktree（默认开启，可关） |
| 工作树位置 | `.meetingstone/worktrees/<childId>`（已在 .gitignore） |
| 分支 | `meetingstone/<childId>` |
| 计数键 | 两层：**工作树**（互斥，天然唯一）+ **项目**（节流上限） |
| 并发上限 | `maxParallelWritesPerProject`（默认 2）、`maxParallelWritesTotal`（默认 4） |
| 失败关闭 | 需要隔离但建树失败 → 拒绝启动，**绝不**退回主工作区 |
| 合并 | 不自动合并；文档给 merge / cherry-pick / patch 三条人工路径 |
| 清理 | 不自动删；`list_runs` 展示 worktree 路径与分支，人工 `git worktree remove` |

### 工作树获取：两条候选路，先验证再选

1. **复用宿主服务**：`ctx.worktrees.create(agent, {name}, signal)`。
   已知副作用：内部 `createCheckout` 会 `workingDirectory.set(agent, path)`，**切走调用方（主 Agent）的 cwd**。
   若采用，需要紧接着 `ctx.workingDirectory.set(agent, 原 cwd)` 恢复；需验证该服务可注入、恢复可靠。
2. **插件自己调 `git worktree add`**（literal argv，禁 shell）：
   无 cwd 副作用、行为确定；但属于自研 git 管理，违背"优先复用"原则，作为兜底。

**决策规则**：先实测路 1；若 cwd 恢复不可靠或服务不可注入，退回路 2，并在文档写明原因。
（决策权：悟空）

### 2026-11-11 01:12 证据补充（供悟空裁决）

- `workingDirectory` 服务确实存在：`dsh/node_modules/@deepseek-ai/dsh-working-directory/lib/index.js`
  - `WorkingDirectoryService extends Service`，服务名 `"workingDirectory"`
  - `set(agent, path, signal)` → 只 `commit` 会话目录（追加 `working-directory/change` 事件），**不改已有进程、不改权限**，返回规范化绝对路径
  - `get(session)` 可读当前目录
- `worktrees.create(agent, request, signal)` 返回 `{ path, branch, baseCommit, repositoryRoot }`，内部调用 `workingDirectory.set(agent, path)`。

因此路 1 的具体做法（待实现验证）：

```text
original = ctx.workingDirectory.get(agent.session)   // 或 agent.session.header.cwd
wt = await ctx.worktrees.create(agent, { name: `meetingstone/<childId>` }, signal)  // 会切走 cwd
await ctx.workingDirectory.set(agent, original, signal)  // 切回
dispatch child with cwd = wt.path
```

残余风险：create→restore 之间父会话若同时执行 `working_directory` 工具会竞态；插件内需串行化这段（一个互斥锁）。


## 3. 冲突检测

- 每个任务记录 `baseSha`（建树时的 commit）与完成时的改动文件列表（`git diff --name-only baseSha`）
- 同一项目内多个并行任务改动文件有交集 → 结果里加 `overlapWarnings: [{ childId, files }]`
- **不做自动合并**；重叠只预警，由人决定

## 4. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 工作树缺依赖（node_modules/.env 等未跟踪文件不复制） | 文档明确"工作树不复制未跟踪/忽略文件"；需构建的任务先自行安装或不开隔离 |
| 合并冲突 | 不自动合并；`overlapWarnings` 预警；保留双方分支 |
| provider 限流（Codex/CodeBuddy 额度） | 全局总上限默认 4；识别 429 后可加退避（后续） |
| 磁盘占用（每棵树≈仓库大小） | 文档给清理命令；不自动 prune |
| Windows 下并发建树争 `.git` 锁 | 建树串行化（单个锁），任务执行并行 |
| 重启后孤儿工作树 | `list_runs` 展示路径/分支；人工清理 |
| 取消后工作树残留 | 不自动删（避免丢未合并代码）；文档说明 |

## 5. 验收标准

1. 同项目两个写任务并行：都 `ok`、各自 `completed`；主工作区 `git status` 干净
2. 两个任务改同一文件：各自完成，`overlapWarnings` 标记交集；不静默覆盖
3. 建树失败（如非 git 目录）：派单被拒且错误可诊断，不退回主工作区
4. 取消一个任务：另一个不受影响；槽位正确释放；工作树保留可人工处理
5. 重启后：`list_runs` 能看到 worktree 元数据；旧 running 映射为 `interrupted`
6. 跨项目并行本来就允许；本次不破坏

## 6. 需要悟空裁决的点

- 路 1（宿主服务 + cwd 恢复）还是路 2（自建 git worktree）
- 默认并发上限（2 还是 3）
- 取消/卸载后工作树是否自动清理（建议：不自动）
