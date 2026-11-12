# Worktree 真实并行写入验收

**日期**：2026-11-12
**执行角色**：八戒（技术主管 / 主控）
**执行 Agent**：悟空（role-wukong），3 个独立隔离工作树
**结论**：**并行写入安全** —— 隔离、合并、用户文件保护三项全部通过

---

## 1. 基线记录

### 1.1 主仓库状态（派发前）

| 项目 | 值 |
|---|---|
| `git log --oneline -1` | `07c52dc test(timeout): 补上超时行为的测试盲区（此前 0 覆盖）` |
| `git rev-parse HEAD` | `07c52dc797c98c666f93d508fd420c6954d9dcc0` |
| `git status --porcelain` | **空**（工作区干净） |
| `docs/plan` 目录 | 已存在 |

### 1.2 ⚠️ 基线期间发生的外部并发提交（重要旁证）

派发后约 42 秒，主仓库 HEAD 被**另一个会话**推进：

```
ae1ccf87d574c594129ef4b2ed86413e89a18b59
docs: Token 精简优化核实（三项全部落地，实际优于估算）
docs/plan/2026-11-12-token-verification.md | 116 +++++
author/committer: MeetingStone <meetingstone@local>
date: 2026-11-12 21:48:52 +0800
```

- 该提交**不是**本次验收任务派生的（我的 3 个子任务均为 isolation=worktree 且被明确禁止 commit）
- 它只新增 `docs/plan/2026-11-12-token-verification.md`，与 A/B 三侧产物无交集
- `git merge-base --is-ancestor 07c52dc HEAD` 退出码 0，确认 `07c52dc` 是 `ae1ccf8` 的祖先，历史线性
- **结论**：这是「第三方会话提交」与「并行 worktree 写入」共存的实测场景，两者未互相干扰，属额外正向证据

---

## 2. 并行派发（第 1 步）

任务 A、B 在**同一批**工具调用中同时派出，未串行等待。

| 项目 | 任务 A | 任务 B |
|---|---|---|
| childId | `2e1964b8-9ccc-4104-895e-fb9396a78990` | `29a47b73-a490-4708-a4a6-eec2596d01bb` |
| 角色 | 悟空 (role-wukong) | 悟空 (role-wukong) |
| 隔离 | worktree | worktree |
| worktree.path | `D:\MeetingStone\.meetingstone\worktrees\fccd3914-8e1d-451a-ac3e-e7b6178b7f3e` | `D:\MeetingStone\.meetingstone\worktrees\f2c7079a-b35f-42c0-8b37-78f05c3eb4c4` |
| branch | `meetingstone/fccd3914-...` | `meetingstone/f2c7079a-...` |
| baseSha | `07c52dc` | `07c52dc` |
| 目标文件 | `docs/plan/wt-parallel-a.md` | `docs/plan/wt-parallel-b.md` |
| 目标内容 | 由任务 A 创建，内容 ABC | 由任务 B 创建，内容 XYZ |

**并行性证据**：两者 `startedAt` 均为 `1794491311316` 附近的同一时间片（A `1794491308465`，B `1794491311316`），
`createdAt` 相差 4851 ms，且在主仓库 `git worktree list` 中同时存在两个独立树。

---

## 3. 终态与 changedFiles（第 3 步）

### 任务 A

- status：`completed`，stopReason `completed`，持续时间 364,635 ms
- `changedFiles`：`["docs/plan/wt-parallel-a.md"]`（`changedFilesTotal=1`，`changedFilesUnknown=false`，`changedFilesTruncated=false`）
- `overlapWarnings`：`[]`（`overlapTotal=0`）
- run 记录：`D:\MeetingStone\.meetingstone\runs\2e1964b8-9ccc-4104-895e-fb9396a78990.json`

### 任务 B

- status：`completed`，stopReason `completed`，持续时间 178,954 ms
- `changedFiles`：`["docs/plan/wt-parallel-b.md"]`（`changedFilesTotal=1`，`changedFilesUnknown=false`，`changedFilesTruncated=false`）
- `overlapWarnings`：`[]`（`overlapTotal=0`）
- run 记录：`D:\MeetingStone\.meetingstone\runs\29a47b73-a490-4708-a4a6-eec2596d01bb.json`

---

## 4. 隔离验证结果（第 3 步核心）

主控在工作树外独立核验（非采信子 Agent 自述）：

| 检查项 | A 树 `fccd3914…` | B 树 `f2c7079a…` | 判定 |
|---|---|---|---|
| 自己的文件在 | `wt-parallel-a.md` **存在** | `wt-parallel-b.md` **存在** | ✅ |
| 对方的文件不在 | `wt-parallel-b.md` **不存在** | `wt-parallel-a.md` **不存在** | ✅ |
| `git status --porcelain` | 仅 `?? docs/plan/wt-parallel-a.md` | 仅 `?? docs/plan/wt-parallel-b.md` | ✅ |
| 内容（UTF-8 核验） | 由任务 A 创建，内容 ABC | 由任务 B 创建，内容 XYZ | ✅ |
| worktree 独立性 | `--git-dir` 指向 `.git/worktrees/fccd3914…`，`--git-common-dir` 指向 `.git` | 同构 | ✅ |
| 是否越界 commit | 未 add/commit/push，HEAD 仍 `07c52dc` | 同 | ✅ |

**双向交叉核对闭环**：A 树无 B 文件 且 B 树无 A 文件，两条独立证据互不依赖，交叉成立。

> 说明：PowerShell 控制台默认 GBK 解码会显示乱码（`鐢变换鍔?`），已改用 UTF-8 读取工具核验，内容无误。

---

## 5. 合并验证（第 4 步）

1. **内容确认**：两个 worktree 文件内容均正确（见 §4）
2. **复制回主仓库**：`Copy-Item` 两文件 → `D:\MeetingStone\docs\plan\`
3. **无冲突**：目标路径原本均不存在（`Test-Path` 均 False），不同文件名，无覆盖、无冲突
4. **字节一致性**：合并后主仓库文件与 worktree 源文件 SHA256 **完全相同**（`a identical: True`、`b identical: True`）
5. **主仓库 status**（`--porcelain` 与 `-uall` 口径一致）：

```
?? docs/plan/wt-parallel-a.md
?? docs/plan/wt-parallel-b.md
```

`git ls-files --others --exclude-standard` 全量未跟踪清单同样仅这 2 项 —— **只多了这两个文件，无任何额外副作用**。

---

## 6. 用户未提交文件保护验证（第 5 步）

### 6.1 布置

在主仓库创建未提交文件 `docs/plan/wt-user-protect.txt`，内容「用户数据」。

- 该文件被 `.gitignore:44` 的 `docs/plan/wt-*.txt` 规则忽略（`git check-ignore -v` 命中），因此**不出现在 git status**，是典型的「用户本地未提交工作」模拟
- SHA256（布置后）：`9997ED5E8201DCCC53CC73704B94CAE830A3322E77958D43ABF80BB7B0D04F5A`

### 6.2 派发任务 C

| 项目 | 值 |
|---|---|
| childId | `0214aec0-3f04-4db8-b2da-0b8bb98b3a27` |
| worktree.path | `D:\MeetingStone\.meetingstone\worktrees\2b767acf-6a18-4514-ad80-ab1cf9b3a2be` |
| changedFiles | `["docs/plan/wt-parallel-c.md"]` |
| 产物内容 | 由任务 C 创建，内容 123（UTF-8 核验通过） |
| 独立 status | 仅 `?? docs/plan/wt-parallel-c.md` |
| C 树内是否含 a.md / b.md | `a=False b=False` —— 前两轮产物同样未外溢 |

### 6.3 保护结果

| 检查项 | 结果 |
|---|---|
| C 工作树内 `wt-user-protect.txt` | **不存在**（用户文件未被复制进 worktree） |
| 主仓库 `wt-user-protect.txt` 是否仍存在 | **是** |
| SHA256（任务 C 执行后） | `9997ED5E8201DCCC53CC73704B94CAE830A3322E77958D43ABF80BB7B0D04F5A` |
| 与布置时是否一致 | **完全一致**（未改写、未删除） |
| 主仓库 status 是否被污染 | 否，仍只有 a.md / b.md 两条 |

**判定**：并行 worktree 写入**不影响**用户在主仓库的未提交工作。

> 收尾：该保护文件已在报告定稿后删除，仅在本文档保留其验证结果。

---

## 7. 结论：并行写入是否安全

**安全。** 四条独立结论：

1. **写入隔离成立**：每个 Agent 的改动严格落在自己的 linked worktree 内（独立 index、独立工作目录、共享 objects），三侧 `changedFiles` 均为单文件且互不出现对方文件。`overlapWarnings` 全程为空。
2. **合并无冲突**：不同文件的并行改动可直接回收进主仓库，字节级一致，主仓库仅新增预期文件。
3. **用户工作零影响**：被 gitignore 的用户未提交文件在并行写入前后 SHA256 不变、未被删除、未被带进任何 worktree。
4. **与外部并发提交共存**：基线期间另一会话向主仓库提交了 `ae1ccf8`，未与三个 worktree 的任何写入发生冲突，历史保持线性。

**边界与注意事项**（不影响本次结论，但需在主控实践中遵守）：

- **文件级隔离 ≠ 语义隔离**：本次验证的是「不同文件」。若两个任务修改同一文件（哪怕不同行），worktree 机制不会自动合并，需主控在派单时用 `scope` 显式排除或串行化。
- **`overlapWarnings` 是事后检测，不是事前锁**：它只能报告重叠，不能阻止重叠写入。
- **产物目录 `.meetingstone/runs/` 是多任务共享**：本次子 Agent 用含工作树 ID 的文件名规避撞名，这是必要的实践约定。
- 工作树不会自动回收：本次 3 个验收树（`fccd3914…`、`f2c7079a…`、`2b767acf…`）仍在 `git worktree list` 中，需要主控决定是否 `git worktree remove` 清理。
- 未跟踪文件（`??`）不进 git 对象库，合并只能靠文件复制，不能靠 cherry-pick —— 本次即采用复制方式。

---

## 8. 产物清单

| 类型 | 路径 |
|---|---|
| 本报告 | `docs/plan/2026-11-12-worktree-parallel-write.md` |
| 合并产物 A | `docs/plan/wt-parallel-a.md` |
| 合并产物 B | `docs/plan/wt-parallel-b.md` |
| A 的 run 记录 | `.meetingstone/runs/2e1964b8-9ccc-4104-895e-fb9396a78990.json` |
| B 的 run 记录 | `.meetingstone/runs/29a47b73-a490-4708-a4a6-eec2596d01bb.json` |
| C 的 run 记录 | `.meetingstone/runs/0214aec0-3f04-4db8-b2da-0b8bb98b3a27.json` |
| A 的详细报告 | `.meetingstone/runs/wt-parallel-a-fccd3914-8e1d-451a-ac3e-e7b6178b7f3e.md` |
| B 的详细报告 | `.meetingstone/runs/wt-parallel-b-report.md` |
| 任务 C 树内产物 | `.meetingstone/worktrees/2b767acf-.../docs/plan/wt-parallel-c.md`（未合并回主仓库） |
