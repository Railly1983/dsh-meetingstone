# 工作树隔离（手动流程）

> 状态：2026-11-11，**手动流程**。插件**不会**自动创建、合并或清理工作树。
> 自动的「任务级工作树隔离 / 并行多任务」仍在设计中，见 [并行多任务方案](plan/2026-11-11-parallel-plan.md)。
> 本文**复用宿主 `create_worktree` 工具**（由已启用的 `dsh-experimental-tool-worktree` bundle 提供），
> 不在插件里新写 git 管理代码；建树之后的合并与清理全部由人按标准 git 命令完成。

> ⚠️ 本文中的命令**只用于照抄执行，本文档自身不执行任何会改动仓库的操作**。
> 合并前请先 `git status` 看清当前改动，必要时先备份。

## 1. 什么时候用

`meetingstone_dispatch` 默认在**主工作区**执行，多个任务直接改同一份文件会互相覆盖。
在自动隔离落地之前，如果你想让一次派单的改动与主工作区隔开，可以：

1. 用宿主 `create_worktree` 工具建一棵隔离工作树；
2. 派单时把 `cwd` 指向这棵工作树（片段见 [examples/worktree-dispatch.jsonc](../examples/worktree-dispatch.jsonc)）；
3. 任务完成后**人工**把改动合回主干，再清理工作树。

这只是一个**人肉流程**：插件不感知工作树、不自动合并、不自动清理，也不保证并行。

## 2. 三条硬约束（先看）

### 2.1 工作树不复制未跟踪 / 忽略文件

`git worktree` 只检出**已提交**的内容。下列文件**不会**出现在新工作树里：

- `node_modules/`（被 `.gitignore` 忽略）
- `.env`、`.env.*`（被忽略的本地配置）
- `dist/`、`build/`、`coverage/` 等构建产物
- `.meetingstone/` 里的派单记录与本机数据

因此：**需要装依赖 / 读本地配置 / 跑构建的任务，进工作树后要先自行准备**，否则子任务很可能因为缺依赖或读不到配置而失败。准备方式见 §3 Step 2。
另外，不要把含密钥的文件提交进仓库；复制 `.env` 是人工决定，插件不会替你读取或注入凭据。

### 2.2 `cwd` 必须在项目根内（适配器有边界校验）

派单的 `cwd` 会经过 `src/dsh/adapter.js` 的边界校验：

- `cwd` 不在当前会话项目根之内 → `PATH_OUTSIDE_PROJECT`，**拒绝启动**；
- 拿不到项目根 → `PROJECT_ROOT_UNKNOWN`，**失败关闭**。

项目根取自 `exec.agent.session.header.cwd`（见 [配置参考](configuration.md) §4）。所以：

- 宿主 `create_worktree` 返回的**路径必须落在项目根内**；建议放到项目内的
  `.meetingstone/worktrees/<name>`（该目录已在 `.gitignore` 里，不会污染 `git status`）。
- 若工具把工作树建到项目根**之外**（例如仓库的兄弟目录），**不要**直接把它的路径当 `cwd` 传进去，派单会被拒绝；
  请改用项目根内的目录，或放弃 `cwd` 隔离。不要绕过这道校验。
- 边界校验只保证「路径在项目内」，**不保证**该路径是 git 工作树；路径写错请自己核对。

### 2.3 建树 ≠ 并行：`serializeWrites` 仍然生效

并发计数键 `projectKey` 取自**会话项目根**，不是 `cwd`。插件全局配置里
`limits.serializeWrites` 默认 `true`（见 [配置参考](configuration.md) §1），
所以同一项目根下的派单**仍默认串行**，建两棵工作树并不会自动变成并行。

- 只要想「一次一个任务、把改动隔离出来」，默认配置即可，不用改任何东西。
- 若确实要并行，需先在**插件全局配置**里把 `serializeWrites` 设为 `false`（会失去串行保护，风险自负），
  或等 [并行多任务方案](plan/2026-11-11-parallel-plan.md) 落地。项目级 `.meetingstone.json` **不提供** `limits`。

## 3. 步骤

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

把 `meetingstone_dispatch` 的 `cwd` 设为 `$WT`（必须在项目根内）。
可照抄的片段见 [examples/worktree-dispatch.jsonc](../examples/worktree-dispatch.jsonc)。

```text
meetingstone_dispatch({
  "role": "沙僧",
  "task": "在工作树里重构 src/foo 模块并补单测",
  "cwd": "D:/MeetingStone/.meetingstone/worktrees/issue-42"
})
```

**Step 4 · 等结果**

用 `meetingstone_get_task` / `meetingstone_list_runs` 看终态，再进工作树核对实际改动：

```powershell
git -C $WT status --short
git -C $WT log --oneline main..HEAD
```

**Step 5 · 人工合回**（三选一，见 §4）

**Step 6 · 清理工作树**（见 §5）

## 4. 合并：三条人工路径

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

三种方式都**不自动合并**：冲突保留双方，由人裁决（与 [并行多任务方案](plan/2026-11-11-parallel-plan.md) §3 的「不做自动合并」一致）。

## 5. 清理

合并完成后：

```powershell
# 移除已合并的工作树（有未提交改动会拒绝；确认要丢弃才加 --force）
git -C $PROJ worktree remove $WT
# 清理残留的管理元数据（例如手工删过工作树目录之后）
git -C $PROJ worktree prune
# 可选：删除已合并分支
git -C $PROJ branch -d $BR
git -C $PROJ worktree list    # 确认已清干净
```

注意：

- `git worktree remove` 遇到未提交改动会拒绝，避免误删未合并代码；`--force` 前务必确认。
- 取消任务 / 插件重启 / 卸载**不会**自动删工作树，未合并的改动可能留在里面；请定期 `git worktree list` 检查孤儿。
- `prune` 只清理 git 的登记元数据，不会帮你恢复被删目录里的未提交改动。

## 6. 边界与注意

| 事项 | 结论 |
| --- | --- |
| 谁建树 | 宿主 `create_worktree` 工具；插件不写 git 管理代码 |
| 未跟踪/忽略文件 | 不复制，需人工准备（§2.1 / Step 2） |
| `cwd` 越界 | `PATH_OUTSIDE_PROJECT` 拒绝启动（§2.2） |
| 并行 | 不自动并行，`serializeWrites` 仍默认串行（§2.3） |
| 合并 | 不自动合并，人工 merge / cherry-pick / patch（§4） |
| 清理 | 不自动清理，人工 `worktree remove` / `prune`（§5） |
| 结果落盘 | 仍在项目根的 `.meetingstone/runs/`，与工作树路径无关 |

## 7. 相关文档

- [并行多任务方案（自动隔离，设计中）](plan/2026-11-11-parallel-plan.md)
- [配置参考：`cwd` 边界、`serializeWrites`、项目级配置](configuration.md)
- [安全与权限边界](security.md)
- [可照抄的派单片段](../examples/worktree-dispatch.jsonc)
