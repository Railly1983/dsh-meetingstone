# 工作树隔离（自动 + 手动）

> 状态：2026-11-11。**`meetingstone_dispatch` 默认自动为每个任务创建独立 git 工作树**
> （`limits.defaultIsolation: 'worktree'`）。并发模型见 §3.1：**宿主 `maxActiveSubagents` 默认 8
> （进程内共享池，宿主子 Agent + 本插件都算，池满立即抛 `ACTIVATION_LIMIT_REACHED`，不排队）**；
> **本插件只保留全局额度 `maxParallelWritesTotal`（默认 4，仅统计本插件派发的任务，超限立即拒绝）**。
> 本文同时保留**手动流程**：用于不想开自动隔离、或需要自己控制建树/合并/清理的场景。
>
> ⚠️ **隔离的准确含义：文件布局隔离，不是权限沙箱。**
> 子 Agent 默认 cwd 是工作树，改动不会直接落到主工作区；但它仍在同一系统账号下运行，
> 可以主动 `cd` 到主工作区写文件，也共享同一份 git 元数据。不要把它当安全边界。
>
> ⚠️ 本文命令**只用于照抄执行，本文档自身不执行任何会改动仓库的操作**。
> 合并前请先 `git status` 看清当前改动，必要时先备份。

## 1. 两种方式怎么选

| | 自动隔离（默认） | 手动流程 |
| --- | --- | --- |
| 谁建树 | 插件（`src/worktree.js`，literal argv） | 宿主 `create_worktree` 工具或你手敲 git |
| 路径 | `<projectRoot>/.meetingstone/worktrees/<operationId>` | 你指定（必须在项目根内） |
| 分支 | `meetingstone/<operationId>` | 你指定 |
| 并行 | 默认开（插件**全局**额度 4，仅本插件任务计数；宿主共享池默认 8） | 需**同时**：① 手动建好独立工作树 ② 设 `isolation:'none'` ③ 关掉 `serializeWrites`（正确性保护，否则同项目仍串行） |
| 合并/清理 | 不自动，人工（§5） | 不自动，人工（§5） |
| 记录 | `worktree` / `changedFiles` / `overlapWarnings` 自动落盘 | 插件不感知，记录里没有 worktree 字段 |

### 1.1 自动隔离（默认行为）

```text
meetingstone_dispatch({
  "role": "沙僧",
  "task": "重构 src/foo 模块并补单测"
})
```

会发生什么：

1. 生成 `operationId`（UUID），在**任何异步操作之前**预占本插件的全局额度；
2. `git worktree add -b meetingstone/<operationId> .meetingstone/worktrees/<operationId> <baseSha>`；
3. 用 `cwd = 工作树路径` 启动子 Agent；
4. 终态时计算 `changedFiles` 并落盘；**不删除**工作树与分支。

失败关闭：项目不是 git 仓库、建树超时/失败、路径或分支已存在、实际路径逃出项目根，
都会**拒绝派单**并返回 `WORKTREE_*` 错误码；**绝不退回主工作区执行**。

想临时关闭隔离（回到主工作区串行）：

```text
meetingstone_dispatch({
  "role": "沙僧",
  "task": "只改一个文件",
  "isolation": "none"
})
```

`isolation:'none'` 与隔离任务**不得混跑**：同项目已有任一方向的任务在执行时，派单会被
`WRITE_CONFLICT` 拒绝。关闭隔离时仍受 `limits.serializeWrites` 约束（默认 `true`，同项目串行）。

全局默认值在插件配置里（`cordis.patch.yml`）：

```yaml
limits:
  defaultIsolation: worktree    # worktree | none
  maxParallelWritesTotal: 4     # 本插件派发的并行写任务全局上限（仅本插件，超限立即拒绝）
  serializeWrites: true         # 仅 isolation:none 时生效：同项目串行，正确性保护而非额度
```

### 1.2 手动流程（需要自己控制时）

1. 用宿主 `create_worktree` 工具建一棵隔离工作树（或手工 `git worktree add`）；
2. 派单时把 `cwd` 指向这棵工作树（片段见 [examples/worktree-dispatch.jsonc](../examples/worktree-dispatch.jsonc)），
   并传 `isolation: "none"`；
3. 任务完成后**人工**把改动合回主干，再清理工作树。

这只是一个**人肉流程**：插件不会感知这棵树、不会自动合并、不会自动清理。
`cwd` 边界校验仍会检查路径在项目根内（§2.2）。

## 2. 三条硬约束（先看）

### 2.1 工作树不复制未跟踪 / 忽略文件

`git worktree` 只检出**已提交**的内容。下列文件**不会**出现在新工作树里：

- `node_modules/`（被 `.gitignore` 忽略）
- `.env`、`.env.*`（被忽略的本地配置）
- `dist/`、`build/`、`coverage/` 等构建产物
- `.meetingstone/` 里的派单记录与本机数据

因此：**需要装依赖 / 读本地配置 / 跑构建的任务，进工作树后要先自行准备**，否则子任务很可能因为缺依赖或读不到配置而失败。准备方式见 §4 Step 2。
另外，不要把含密钥的文件提交进仓库；复制 `.env` 是人工决定，插件不会替你读取或注入凭据。

> 建议把 `.meetingstone/` 加进项目的 `.gitignore`。自动工作树就建在这个目录下；
> 不忽略的话，主工作区的 `git status` 会显示这一大坨未跟踪目录（不影响功能，但很吵）。
> 本仓库的 `.gitignore` 已经忽略 `.meetingstone/`。

### 2.2 `cwd` 必须在项目根内（适配器有边界校验）

派单的 `cwd` 会经过 `src/dsh/adapter.js` 的边界校验：

- `cwd` 不在当前会话项目根之内 → `PATH_OUTSIDE_PROJECT`，**拒绝启动**；
- 拿不到项目根 → `PROJECT_ROOT_UNKNOWN`，**失败关闭**。

项目根取自 `exec.agent.session.header.cwd`（见 [配置参考](configuration.md) §4）。所以：

- 自动隔离的工作树固定建在 `<projectRoot>/.meetingstone/worktrees/`，天然在项目内；
- 手动建树时，宿主 `create_worktree` 返回的**路径必须落在项目根内**；建议也放到
  `.meetingstone/worktrees/<name>`（该目录已在 `.gitignore` 里，不会污染 `git status`）；
- 若工具把工作树建到项目根**之外**（例如仓库的兄弟目录），**不要**直接把它的路径当 `cwd` 传进去，派单会被拒绝；
- 边界校验只保证「路径在项目内」，**不保证**该路径是 git 工作树；路径写错请自己核对。

### 2.3 并行不是权限沙箱

| 能做到 | 做不到 |
| --- | --- |
| 默认 cwd 不同，改动不直接落主工作区 | 阻止子 Agent 主动写主工作区（同账号、同文件系统） |
| 每任务独立分支/工作树，便于人工合并 | 进程级/系统级隔离（没有 sandbox、没有独立用户） |
| 共享 git 对象库，建树快、省磁盘 | 独立仓库（共享 common-dir，git 元数据是同一份） |

真正的权限边界请按 provider 行配置并自行验收（见 [安全与权限边界](security.md)）。

## 3. 自动隔离的额度、错误与记录

### 3.1 并发额度（新模型）

- **宿主共享池**：宿主 `maxActiveSubagents` 默认 **8**，进程内共享——宿主自己的子 Agent 与本插件
  派单都计入。池满时宿主直接抛 `ACTIVATION_LIMIT_REACHED`，**没有等待/排队机制**；插件只做
  **原样透传**（不归入 `ADAPTER_FAILED`），不重复实现容量控制。只能等现有任务结束再重试。
- **本插件全局额度**：仅保留 `limits.maxParallelWritesTotal`（默认 **4**），只统计**本插件派发**
  的在跑任务，不按通道/项目拆分。额度在**首次异步操作前**（含建树）预占；超限**立即拒绝**
  `WRITE_LIMIT_TOTAL`，不排队。
- 已删除按项目额度（`maxParallelWritesPerProject` / `WRITE_LIMIT_PROJECT`）：额度不再是"每项目几个"。
- **隔离互斥是正确性保护，不是额度**：同项目 `isolation:'none'` 与隔离任务不得混跑
  （`WRITE_CONFLICT`）；`serializeWrites` 在 `isolation:none` 时保护同一工作区串行。
- 项目键先归一化（realpath + Windows 大小写/尾斜杠折叠），`D:/P` 与 `d:/p/`、`原路径/src/..`、
  junction/symlink 都不会绕过同项目的隔离互斥判断。
- **迟到结算回填 `stopConfirmed`**：取消/卸载时 dispose 超时或抛错，先写
  `cancelled + stopConfirmed:false` 并保留槽位；等 `activation.result` 落定后再写一条终态，
  把 `stopConfirmed` 回填为 `true`、`diagnostic` 追加 `late settlement`，`status` 保持
  `cancelled` 不被覆盖，这时才释放槽位（见 [配置参考](configuration.md) §6）。

### 3.2 错误码

| 错误码 | 含义 |
| --- | --- |
| `ACTIVATION_LIMIT_REACHED` | 宿主子 Agent 共享池已满（默认 8）：原样透传，不排队，等现有任务结束 |
| `WRITE_LIMIT_TOTAL` | 本插件并行写任务达全局上限（默认 4）：立即拒绝，不排队 |
| `WRITE_CONFLICT` | 同项目隔离/未隔离互斥或 `serializeWrites` 串行（正确性保护，不是额度） |
| `WORKTREE_UNAVAILABLE` | 请求隔离但工作树服务缺失 |
| `WORKTREE_NOT_GIT_REPOSITORY` | 项目根不是 git 工作区 |
| `WORKTREE_BASE_INVALID` | `base` 无法解析为 commit |
| `WORKTREE_PATH_EXISTS` | 工作树路径已存在或已被 git 登记 |
| `WORKTREE_BRANCH_EXISTS` | `meetingstone/<operationId>` 已存在 |
| `WORKTREE_GIT_FAILED` | 其他 git 失败 |
| `WORKTREE_TIMEOUT` | git 命令超时（建树 30s / 计算改动 10s） |
| `WORKTREE_PATH_OUTSIDE` | 实际路径逃出项目根（junction/symlink） |
| `INVALID_ISOLATION` | `isolation` 不是 `none`/`worktree` |

### 3.3 记录与重叠预警

`meetingstone_get_task` / `meetingstone_list_runs` 会返回：

- `worktree: { path, branch, baseSha, repositoryRoot, operationId }`
- `changedFiles: string[]`（已提交/暂存/未暂存/未跟踪/重命名的新旧路径）
- `changedFilesUnknown: boolean`（计算失败时为 true；**不能当成无改动**）
- `overlapWarnings: [{ childId, files }]`（同项目、带工作树、改动文件有交集的记录）
- `stopConfirmed`（取消/卸载时是否确认进程已停；dispose 超时/抛错先记 `false`，
  `activation.result` 迟到落定后回填为 `true`，见 §3.1）

**带 worktree 的记录不参与"100 条 / 30 天"自动清理**：元数据是人工合并/清理的唯一线索。
代价是这类记录会一直保留，请在合并后人工删除。

## 4. 手动流程步骤

以下命令用 PowerShell 演示；`$PROJ` 换成你的项目根，`$NAME` 换成任务代号。

```powershell
# Step 0 · 变量（改成你的实际值）
$PROJ = "D:\MeetingStone"                              # 当前会话项目根
$NAME = "issue-42"                                     # 本次任务代号
$BR   = "meetingstone/$NAME"                           # 工作树分支名
$WT   = "$PROJ\.meetingstone\worktrees\$NAME"          # 工作树路径：必须在项目根内
```

**Step 1 · 用宿主 `create_worktree` 工具建树**

这是**会话里调用宿主工具**，不是终端命令；参数名以宿主工具实际 schema 为准，下面只是示意：

```text
create_worktree({ "name": "meetingstone/issue-42", "base": "main" })
```

记下工具返回的 `path`、`branch`（以及 `baseCommit`）；若工具允许指定检出目录，请指定为 `$WT`（项目根内）。
建完用只读命令核对工作树已登记、路径在项目内：

```powershell
git -C $PROJ worktree list
```

**Step 2 · 准备工作树（因为未跟踪/忽略文件不会被复制）**

```powershell
# 需要装依赖时才做；按项目实际包管理器调整
npm --prefix $WT install
# 确有 .env 且允许复制时才做（注意别把密钥提交进仓库）
Copy-Item "$PROJ\.env" "$WT\.env"
```

**Step 3 · 派单，`cwd` 指向工作树**

把 `meetingstone_dispatch` 的 `cwd` 设为 `$WT`（必须在项目根内），并显式关闭自动隔离：

```text
meetingstone_dispatch({
  "role": "沙僧",
  "task": "在工作树里重构 src/foo 模块并补单测",
  "cwd": "D:/MeetingStone/.meetingstone/worktrees/issue-42",
  "isolation": "none"
})
```

> 不传 `isolation:'none'` 时，插件会忽略你给的 `cwd`，另外建一棵自动工作树。

**Step 4 · 等结果**

用 `meetingstone_get_task` / `meetingstone_list_runs` 看终态，再进工作树核对实际改动：

```powershell
git -C $WT status --short
git -C $WT log --oneline main..HEAD
```

**Step 5 · 人工合回**（三选一，见 §5）

**Step 6 · 清理工作树**（见 §6）

## 5. 合并：三条人工路径

合回前先确认主工作区干净、并已切到要合入的分支（如 `main`）：

```powershell
git -C $PROJ status --short
git -C $PROJ switch main
```

三条路径**任选其一**，不要叠加执行。

### 方式 A · merge（整分支合并，保留分支历史）

```powershell
git -C $PROJ merge --no-ff $BR
```

适合「工作树里是一组完整提交、想整体合回」。有冲突就人工解决后 `git -C $PROJ commit`。

### 方式 B · cherry-pick（只挑某几个提交）

```powershell
# 先看待合提交
git -C $PROJ log --oneline "$BR" --not main
# 把 <commit> 换成上一步挑出的 SHA（可一次给多个）
git -C $PROJ cherry-pick <commit>
```

适合「只要其中一两个提交，其余丢弃」。

### 方式 C · patch（只搬改动、不带分支历史）

用 `format-patch -o` 让 git 自己写文件（避免 PowerShell 重定向的编码问题），
再用 `git apply --3way` 打到主工作区；**只改工作区，不自动提交**，由你确认后再提交。

```powershell
git -C $WT format-patch -o "$PROJ\.meetingstone\patches" main
Get-ChildItem "$PROJ\.meetingstone\patches\*.patch" | Sort-Object Name | ForEach-Object {
  git -C $PROJ apply --3way $_.FullName
}
git -C $PROJ status --short    # 核对后再自行 commit
```

三种方式都**不自动合并**：冲突保留双方，由人裁决（与 [并行多任务方案](plan/2026-11-11-parallel-plan.md) §4 的「不做自动合并」一致）。

## 6. 清理

合并完成后：

```powershell
# 自动隔离的树：路径来自 get_task/list_runs 的 worktree.path
git -C $PROJ worktree remove <worktree.path>
# 手动流程的树
git -C $PROJ worktree remove $WT
# 清理残留的管理元数据（例如手工删过工作树目录之后）
git -C $PROJ worktree prune
# 可选：删除已合并分支
git -C $PROJ branch -d meetingstone/<operationId>
git -C $PROJ worktree list    # 确认已清干净
```

注意：

- `git worktree remove` 遇到未提交改动会拒绝，避免误删未合并代码；`--force` 前务必确认。
- 插件**不会**自动删工作树/分支：取消任务 / 插件重启 / 卸载都不会删，未合并的改动可能留在里面；
  请定期 `git worktree list` 检查孤儿。
- `prune` 只清理 git 的登记元数据，不会帮你恢复被删目录里的未提交改动。
- 如果不再需要记录，可手工删除 `.meetingstone/runs/<childId>.json`；带 worktree 的记录不会自动淘汰。

## 7. 边界与注意

| 事项 | 自动隔离 | 手动流程 |
| --- | --- | --- |
| 谁建树 | 插件 `src/worktree.js` | 宿主工具或你 |
| 未跟踪/忽略文件 | 不复制 | 不复制，需人工准备 |
| `cwd` 越界 | 拒绝（路径构造 + realpath 校验） | `PATH_OUTSIDE_PROJECT` 拒绝启动 |
| 并行 | 插件全局额度 4（宿主共享池默认 8） | 需 `isolation:'none'` 并调整 `serializeWrites` |
| 合并 | 不自动，人工 merge / cherry-pick / patch | 同左 |
| 清理 | 不自动，人工 `worktree remove` / `prune` | 同左 |
| 结果落盘 | 项目根 `.meetingstone/runs/`，含 worktree/changedFiles | 仍在项目根，但没有 worktree 字段 |
| 安全边界 | **文件布局隔离，不是权限沙箱** | 同左 |

## 8. 相关文档

- [并行多任务方案（悟空裁决与实现）](plan/2026-11-11-parallel-plan.md)
- [配置参考：`limits`、`isolation`、错误码](configuration.md)
- [安全与权限边界](security.md)
- [可照抄的派单片段](../examples/worktree-dispatch.jsonc)

## 已知限制（2026-11-11 复核后）

1. **overlap 回写是异步的**：两份记录都显示 `completed` 之后，交叉回写可能还有一个很短的可见性窗口；
   查询接口（`get_task`/`list_runs`）会在读取时重算，因此查询结果不受影响，但如果直接读原始 JSON，
   需要稍等或轮询。测试里用 `waitForOverlap` 显式等待。
2. **诊断字段不完整**：建树/工作树错误的 `path/branch/phase` 会透传；但普通启动异常或没有 taskRef 时，
   结果里可能只有 `path/branch/residualPath`，`phase` 缺失（不伪造）。
3. **跨进程并发未验证**：工作树创建锁与 overlap 写锁都是**进程内**的；多个 DSH 进程同时操作同一仓库
   或同一 `.meetingstone/runs` 未压测。
4. **真实 provider 并行未真机验证**：单测使用假 provider + 真实 git 工作树；真实 codex/acp/spawn
   的并行执行、限流与 Windows 文件锁仍需在真机会话验收。
5. **文件布局隔离 ≠ 权限沙箱**：工作树共享 git 元数据，`cwd` 不能阻止越界写。
