# Worktree 真实并行写入验收（2026-11-12）

> 执行人：八戒（技术主管 / 主 Agent 本体）
> 执行时间：2026-11-12 18:28 – 18:55（Asia/Shanghai）
> 被测版本：`dsh-meetingstone@0.1.0-alpha.13`（工作区源码，`limits.defaultIsolation='worktree'`）
> 派单通道：`悟空` / `acp-hy4free`（4 个最小任务）+ 同会话 `in-process` 主 Agent 本人
> 结论速览：**A 通过 / B 通过 / C 通过（无自动清理，符合设计）/ D 被测命题通过，但验收中发现高层风险（已命中两次）**

## 0. 为什么做这次验收

Codex 评审指出：既有 `tests/parallel.test.mjs` 只是**只读分析 + 假 provider**，没有验证
「两个 Agent 真正同时改不同文件 → 改动隔离 → 合并 → 冲突处理 → 清理」的完整链路。
`docs/worktree-isolation.md` §已知限制 4 也明确写了「真实 provider 并行未真机验证」。

本次用**真实外部 CLI 通道（悟空的 acp-hy4free）**并发派单，真机验证上述链路。

**验证方法上的三条硬约束（自我约束，避免自证）**：
1. 每个任务只写 1 个文件、几字节内容 —— 任务足够小，失败可归因；
2. 不改产品代码、不改 profile、不重启 DSH、不装包；
3. 每个结论都贴原始命令输出，不写「应该如此」。

---

## 1. 环境基线

| 项 | 值 |
| --- | --- |
| 仓库根 | `D:\MeetingStone` |
| 本轮起始 HEAD | `c238ea3` (`feat(stats): 新增 meetingstone_stats…`) |
| 本轮结束 HEAD | `53c06ad` (`fix(b3): 项目/会话角色覆盖…`) —— **不是我提交的** |
| git 身份 | `MeetingStone <meetingstone@local>` |
| 工作树根 | `D:\MeetingStone\.meetingstone\worktrees\`（`.gitignore:35` 已忽略 `.meetingstone/`） |
| 起始 `git worktree list` 条目数 | 6 |
| 结束 `git worktree list` 条目数 | 7（含 1 棵与本测试无关的 `d7affa39`） |
| 起始 `meetingstone/*` 分支数 | 约 44 |
| 结束 `meetingstone/*` 分支数 | 48（**含本次验证新增 4 条，均未删**） |

> ⚠️ **重要环境事实**：验收期间主仓库 HEAD 被**并发推进了 5 次**
> （`c238ea3` → `8459115` → `6650844` → `3810575` → 我的 `d30bd3f`/`31350a8` → `53c06ad`）。
> 即 Lead（或另一路 Agent）在验收窗口内**持续往 main 提交**。
> 这不是我造成的，但它直接决定了场景 D 的结论（见 §5），
> 也让"合并"这件事发生在一个**移动中的 main** 上。记录在此以保证可复现性。

---

## 2. 场景 A：并行改不同文件（应成功）—— ✅ 通过

### 2.1 派单

| | A1 | A2 |
| --- | --- | --- |
| childId | `111c156b-c3da-46f6-9494-980c6f4098cb` | `d217d262-eed0-45d5-a23c-ee1f8ddb19a7` |
| 角色 / 通道 | 悟空 / `acp-hy4free` | 悟空 / `acp-hy4free` |
| worktree 路径 | `D:\MeetingStone\.meetingstone\worktrees\f361598e-f36b-4870-b94d-0e9ca95f8f51` | `D:\MeetingStone\.meetingstone\worktrees\1736ccd5-68bf-4b0f-be29-7114b0dc4c7a` |
| 分支 | `meetingstone/f361598e-…` | `meetingstone/1736ccd5-…` |
| baseSha | `c238ea3d12cf…` | `c238ea3d12cf…` |
| 目标文件 | `docs/plan/wt-a.txt` = `A` | `docs/plan/wt-b.txt` = `B` |
| 开始 → 结束（UTC） | 10:33:51Z → 10:37:14Z（203s） | 10:33:54Z → 10:37:23Z（209s） |

**并发真实性（这是 Codex 质疑的核心）**：
A1 在 `10:33:51` 启动，A2 在 `10:33:54` 启动，A2 仅晚 3 秒；
两者**同时在跑的时间窗 ≈ 200 秒**（覆盖 A1 全生命周期的 98%）。
这不是「先后执行被记成并行」，是真正的时间重叠。

### 2.2 两棵树各自独立、改动只在自己树里

```text
# A1 树（f361598e）
$ git -C .meetingstone\worktrees\f361598e-… rev-parse --abbrev-ref HEAD
meetingstone/f361598e-f36b-4870-b94d-0e9ca95f8f51
$ git -C .meetingstone\worktrees\f361598e-… status --porcelain=v1
?? docs/plan/wt-a.txt

# A2 树（1736ccd5）
$ git -C .meetingstone\worktrees\1736ccd5-… rev-parse --abbrev-ref HEAD
meetingstone/1736ccd5-68bf-4b0f-be29-7114b0dc4c7a
$ git -C .meetingstone\worktrees\1736ccd5-… status --porcelain=v1
?? docs/plan/wt-b.txt

# 交叉污染检查（主控亲自跑）
f361598e… 树里有 wt-b.txt ?  False
1736ccd5… 树里有 wt-a.txt ?  False
主仓库 D:\MeetingStone 里有 wt-a.txt / wt-b.txt ?  False / False
```

文件内容字节级校验（悟空自报 + 主控核对）：

```text
wt-a.txt  长度 1 字节，内容 [A]
wt-b.txt  长度 1 字节，内容 [B]
A1 自报：wc -c=1、od 显示单字符 "A"
A2 自报：单字节、无换行
```

三份 run 记录的 `changedFiles` 也各自只有自己那一个文件：

```text
111c156b  changedFiles = ["docs/plan/wt-a.txt"]   overlapWarnings = []
d217d262  changedFiles = ["docs/plan/wt-b.txt"]   overlapWarnings = []
```

### 2.3 `overlapWarnings` 为空 —— ✅

因为改的是不同文件，两个终态记录里 `overlapWarnings` 都是 `[]`、`overlapTotal = 0`。
判据来自 `src/run-store.js:128 overlapWarningsFor()`：只比对**同项目、带 worktree、双方
`changedFiles` 有交集**的记录。两文件无交集 → 空。**行为与设计一致**。

### 2.4 合并回主仓库：互不冲突 —— ✅

先用**非破坏性**方式预判（不动工作区、不产生提交）：

```text
$ git merge-tree --write-tree main meetingstone/f361598e-…
e25d2177108df04078a3f41e79352f580dfd8568
exit=0                       # 无冲突

$ git merge-tree --write-tree main meetingstone/1736ccd5-…
e25d2177108df04078a3f41e79352f580dfd8568
exit=0                       # 无冲突

$ git merge-tree --write-tree meetingstone/f361598e-… meetingstone/1736ccd5-…
0fb0dc6cf7d7b2a1698c03346678cf0e0f141c05
exit=0                       # 两个分支之间也不冲突
```

再实际合并（真实落 main）：

```text
$ git merge --no-ff meetingstone/f361598e-… -m 'accept-A1: merge wt-a.txt…'
Merge made by the 'ort' strategy.
 docs/plan/wt-a.txt | 1 +
 1 file changed, 1 insertion(+)
exit=0

$ git merge --no-ff meetingstone/1736ccd5-… -m 'accept-A2: merge wt-b.txt…'
Merge made by the 'ort' strategy.
 docs/plan/wt-b.txt | 1 +
 1 file changed, 1 insertion(+)
exit=0
```

结果核对：

```text
docs/plan/wt-a.txt => [A]
docs/plan/wt-b.txt => [B]
$ git log --oneline -4
31350a8 accept-A2: merge wt-b.txt from worktree 1736ccd5
d30bd3f accept-A1: merge wt-a.txt from worktree f361598e
6c20f99 A2 wt-b
be6006c A1 wt-a
```

**结论 A**：两个 Agent 真并发、各写各的文件、改动严格留在各自工作树、`overlapWarnings`
正确为空、两次合并到同一 main **零冲突**。链路完整走通。

---

## 3. 场景 B：并行改同一文件（应报 overlap）—— ✅ 通过

### 3.1 派单

| | B1 | B2 |
| --- | --- | --- |
| childId | `924403bf-b46c-4635-8003-92bdc1690afa` | `6fe9431b-9d1c-4694-8f97-4f9e83953c90` |
| worktree | `…\worktrees\5b6c84de-0a08-45fd-903b-ee573ae8906f` | `…\worktrees\2bbb155a-2907-417d-b0a1-01fd26f2256c` |
| baseSha | `381057541628…` | `381057541628…` |
| 目标文件 | `docs/plan/wt-shared.txt` = `from-A` | `docs/plan/wt-shared.txt` = `from-B` |
| 开始 → 结束（UTC） | 10:39:03Z → 10:42:00Z | 10:39:14Z → 10:41:14Z |

时间重叠 ≈ 120 秒，同样是真并发。

### 3.2 两个 run 记录的 `overlapWarnings` 互相命中 —— ✅

直接读落盘原始 JSON（`.meetingstone/runs/<childId>.json`），不经过读取时重算：

```json
// 924403bf（B1）
"changedFiles": ["docs/plan/wt-shared.txt"],
"overlapWarnings": [{ "childId": "6fe9431b-9d1c-4694-8f97-4f9e83953c90",
                      "files": ["docs/plan/wt-shared.txt"] }],
"overlapTotal": 1

// 6fe9431b（B2）
"changedFiles": ["docs/plan/wt-shared.txt"],
"overlapWarnings": [{ "childId": "924403bf-b46c-4635-8003-92bdc1690afa",
                      "files": ["docs/plan/wt-shared.txt"] }],
"overlapTotal": 1
```

**双向命中、互相指认、文件路径一致**。这条是 Codex 要求「落盘自证」的那个点，
本轮确认成立（`src/run-store.js:852`「终态记录必须把 overlapWarnings 一起落盘」生效）。

### 3.3 但并发写入本身没被阻止（设计如此）

两棵树各自内容互不影响：

```text
5b6c84de\d...wt-shared.txt  => from-A
2bbb155a\d...wt-shared.txt  => from-B
```

即：**overlap 只是事后告警 + 人工裁决，不做写锁**。这与 `docs/worktree-isolation.md`
「不自动合并，冲突保留双方由人裁决」一致，但必须说清：**两个 Agent 同时改同一文件不会
被拦住，只会被标记。** 若两者都写了同一文件的同一行，最终只能靠人合并。

### 3.4 合并时冲突检测有效 —— ✅

在临时分支上做（不污染 main）：

```text
$ git switch -c tmp-accept-b-conflict            # from 31350a8
$ git merge --no-ff meetingstone/5b6c84de-… -m 'accept-B1: shared from-A'
Merge made by the 'ort' strategy.  1 file changed, 1 insertion(+)
exit=0
$ cat docs/plan/wt-shared.txt
from-A

$ git merge --no-ff meetingstone/2bbb155a-… -m 'accept-B2: shared from-B'
Auto-merging docs/plan/wt-shared.txt
CONFLICT (add/add): Merge conflict in docs/plan/wt-shared.txt
Automatic merge failed; fix conflicts and then commit the result.
exit=1
```

冲突现场（文件内容 + 索引冲突条目）：

```text
$ git status --porcelain=v1
AA docs/plan/wt-shared.txt
 M src/session/config.js
?? docs/plan/wt-user-dirty-2.txt

$ cat docs/plan/wt-shared.txt
<<<<<<< HEAD
from-A
=======
from-B
>>>>>>> meetingstone/2bbb155a-2907-417d-b0a1-01fd26f2256c

$ git ls-files -u docs/plan/wt-shared.txt
100644 988e5cd974b1cd52… 2	docs/plan/wt-shared.txt
100644 615e34eb35b6a2b5… 3	docs/plan/wt-shared.txt
```

**双方内容都完整保留**（`2`=ours、`3`=theirs 两个 stage 都在），符合「冲突保留双方，
由人裁决」的承诺。

现场已回滚，main 未被污染：

```text
$ git merge --abort            # exit=0
$ git switch main              # exit=0
$ git branch -D tmp-accept-b-conflict
Deleted branch tmp-accept-b-conflict (was e32f990).
$ git rev-parse --short HEAD   # 31350a8
docs/plan/wt-shared.txt exists on main = False
```

**结论 B**：overlap 双向命中、落盘可自证；同文件并行写不会被阻止（设计如此）；
真正的合并冲突能被 git 拦下并保留双方，人工裁决路径可用。

---

## 4. 场景 C：清理验收 —— ✅ 通过（但**无自动清理**，且存在清理债）

### 4.1 任务完成后不会自动清理 —— 与设计一致

5 个测试任务全部 `completed` 之后（18:47 检查）：

```text
5 个测试工作树仍存在数量 = 5
git worktree list 条目数 = 12（含与本测试无关的树）
```

依据 `src/worktree.js:18-19`：

> 清理策略：**一律不自动删除**工作树/分支（完成/失败/取消/卸载都不删）。
> 未合并的改动可能只在工作树里，自动删除等于丢代码。

**这是刻意的安全取舍，不是 bug。** 代价是**必然产生清理债**：

```text
本轮结束时 meetingstone/* 分支数 = 48
本轮结束时 git worktree list = 7 条
```

48 条分支里绝大多数是历史任务残留，`git worktree list` 里也已出现与本轮无关的
孤儿树（如 `d7affa39`，base `6650844`，无人认领）。**建议后续加一条定期巡检/清理流程**，
但不建议改成「自动删除」。

### 4.2 手动 `git worktree remove` 各分支路径 —— 全部符合预期

**(a) 干净且已合并的树 → 移除成功**

```text
$ git -C .meetingstone\worktrees\f361598e-… status --porcelain
（空）
$ git worktree remove .meetingstone\worktrees\f361598e-…
exit=0
dir exists after remove = False
worktree list count after = 11        # 12 → 11
```

**(b) 已合并分支 → 可安全删除**

```text
$ git branch -d meetingstone/f361598e-…
Deleted branch meetingstone/f361598e-f36b-4870-b94d-0e9ca95f8f51 (was be6006c).
exit=0
```

**(c) 带未提交改动的树 → 拒绝删除（安全网生效）** ← 这条最重要

```text
# 故意在该树里造一个未跟踪文件
$ git -C …\b519579f-… status --porcelain
?? uncommitted.txt

$ git worktree remove …\b519579f-…
fatal: '...\b519579f-…' contains modified or untracked files, use --force to delete it
exit=128
dir still exists = True
```

→ **未合并/未提交的改动不会因手滑被删**。`--force` 才删，符合文档承诺。

**(d) 目录被手工删掉但 git 仍登记（孤儿）→ `prune` 可清**

```text
$ Remove-Item -Recurse -Force …\1736ccd5-…
$ git worktree list | Select-String '1736ccd5'
D:/MeetingStone/.meetingstone/worktrees/1736ccd5-… 6c20f99 [meetingstone/…] prunable
                                                     ^^^^^^^^^ 标记为 prunable

$ git worktree prune -v
Removing worktrees/1736ccd5-68bf-4b0f-be29-7114b0dc4c7a: gitdir file points to non-existent location
# prune 后残留 = 0 条
```

**(e) 工作树删了，run 记录仍在** —— ✅

```text
111c156b completed wt=…\f361598e-…  changed=["docs/plan/wt-a.txt"]
d217d262 completed wt=…\1736ccd5-…  changed=["docs/plan/wt-b.txt"]
924403bf completed wt=…\5b6c84de-…  changed=["docs/plan/wt-shared.txt"]
6fe9431b completed wt=…\2bbb155a-…  changed=["docs/plan/wt-shared.txt"]
2e538f9a completed wt=…\b519579f-…  changed=["docs/plan/wt-d.txt"]
```

5 棵树全部 `git worktree remove` 之后，5 份 run 记录**一条都没少**。
依据 `src/run-store.js:1042`「带 worktree 的记录不参与 100 条/30 天自动清理」——
元数据留住了人工合并/清理的唯一线索，方向正确。

### 4.3 残留分支上的改动仍可取回 —— ✅

工作树删掉后，只要分支在，改动就能取回（这一点降低了「误删工作树」的损失）：

```text
$ git log --oneline -1 meetingstone/5b6c84de-…
7c4e17d B1 shared from-A
$ git show meetingstone/5b6c84de-…:docs/plan/wt-shared.txt
from-A
$ git show meetingstone/2bbb155a-…:docs/plan/wt-shared.txt
from-B
```

**结论 C**：不自动清理（设计）；`git worktree list` 会残留（必然）；手动 `remove`
对「干净/脏/孤儿」三种状态行为都正确；`branch -d` 安全；run 记录不被顺手清掉。
**唯一「问题」是清理债无人认领，需要在流程上加一步，不是代码缺陷。**

---

## 5. 场景 D：不影响用户未提交的工作 —— ✅ 被测命题通过（但验收中发现更高层风险）

> 这是本轮最重要的一条。结论先说：**派任务不会动到你的未提交文件**（通过）；
> 但**验收过程中的无关并发提交，把探针文件卷走了两次**（风险，非 worktree 缺陷）。
> 两件事必须分开说，否则会把流程问题误判成产品缺陷。

### 5.1 第一次尝试（D-1）：探针文件被卷走 —— 但与 worktree 无关

我按派单要求在 18:31:15 创建了未跟踪文件：

```text
$ Set-Content docs\plan\wt-user-dirty.txt -Value 'user-uncommitted-test-data' -NoNewline
FullName : D:\MeetingStone\docs\plan\wt-user-dirty.txt
Length   : 29
LastWriteTime : 2026/11/12 18:31:15

$ git status --porcelain=v1
?? docs/plan/wt-user-dirty.txt          # 未跟踪 ✓
```

（注：这个文件名与任务书里写的 `wt-user-dirty.txt` 完全一致，而 Lead 在我之前
可能也用过同名文件做测试 —— 见下面的关键发现。）

**18:39 复查时，它已经不在 `git status` 里了**：

```text
$ git status --porcelain=v1
 M src/context-replay.js
?? docs/plan/2026-11-12-security-audit.md
?? docs/plan/verify/2026-11-12-d1-alpha13.md
# 我的 wt-user-dirty.txt 消失了

$ git ls-files --error-unmatch docs/plan/wt-user-dirty.txt
docs/plan/wt-user-dirty.txt          # ← 它变成「已跟踪」了

$ git log --oneline --all -- docs/plan/wt-user-dirty.txt
8459115 perf(tokens): list_runs 默认紧凑，剥掉排障字段（省约 65% 返回体）

$ git show --stat --oneline 8459115
8459115 perf(tokens): list_runs 默认紧凑，剥掉排障字段（省约 65% 返回体）
 docs/plan/2026-11-12-token-review-lead.md | 110 ++++++++++++++
 docs/plan/wt-user-dirty.txt               |   1 +        ← 就是我这个文件
 src/dsh/register.js                       |  88 +++++++++-
 tests/dsh-adapter.test.mjs                |  72 ++++++++++
 4 files changed, 267 insertions(+), 4 deletions(-)
```

**发生了什么**：18:34:04，**主仓库那边**有一次提交（`8459115`，一个跟测试文件毫无关系的
perf 重构提交），把我 18:31 创建的**未跟踪文件一并 `git add` 进去了**。

**内容有没有丢？没有**——字节完好：

```text
$ git show 8459115:docs/plan/wt-user-dirty.txt
user-uncommitted-test-data
```

但**「未跟踪」这个状态被破坏了**：它被卷进了一个不相干的提交。
如果这个文件是含密钥的 `.env` 或用户草稿，那就是**真实的数据事故**。

### 5.2 根因：**不是 worktree 隔离失效，是主仓库并发提交**

必须把话说清楚，避免把责任推给被测模块：

1. **worktree 在这件事里没有任何责任**。D-1 期间派出的任务（`2e538f9a`）当时**还没启动**，
   更没有写过主仓库的任何路径。文件是被**主仓库自己的 `git add`** 卷走的。
2. 真正的原因：验收窗口内 **main 上有并发提交**（`8459115` / `6650844` / `3810575` / `53c06ad`
   都不是我提交的），而那次提交用了「把工作区所有改动一起提交」的方式，于是把当时工作区里
   **任何**未跟踪文件一起带走了。
3. **worktree 隔离在设计上管不到这件事**：见 `docs/worktree-isolation.md` §2.3
   「⚠️ 隔离的准确含义：文件布局隔离，不是权限沙箱」。它保证子 Agent 默认不往主工作区写，
   但它**不保护主工作区里已有的未跟踪文件不被人工/自动提交卷走**。
4. 另一个加分因素：这个文件名 `wt-user-dirty.txt` 是任务书里给的字面名字，而 `8459115`
   提交里那一行的内容恰好也是 `user-uncommitted-test-data` —— 与我的写入完全一致，
   说明该提交确实收走了我这份文件，也进一步放大了归因困难。

### 5.3 第二次尝试（D-2）：**受控重跑，通过** ✅

为了把「worktree 是否影响用户未提交文件」这个**被测命题**单独隔离出来，
我用一个**不会与任何既有文件重名**的新路径重做：

```text
18:39:26 创建（主仓库，未跟踪，不提交、不 add）
$ Set-Content docs\plan\wt-user-dirty-2.txt -Value 'user-uncommitted-test-data-2' -NoNewline
path=D:\MeetingStone\docs\plan\wt-user-dirty-2.txt
len=31  sha256=D7E9239EDCE00217AC412632E998128C054854B209CCD6085B9D780117571D9E
mtime=2026-11-12T18:39:26.3723120+08:00
$ git status --porcelain=v1
?? docs/plan/wt-user-dirty-2.txt
```

然后派任务 `2e538f9a-6ac1-4ffa-88be-bed5e426caf6`（悟空，worktree
`…\worktrees\b519579f-a953-491c-b076-0660dc6968df`，base `3810575`，
10:39:50Z → 10:43:48Z，238s），在**它自己的树**里写 `docs/plan/wt-d.txt`。

任务完成后的三项核验（主控亲自跑，不看子 Agent 自报）：

**(1) 文件仍在**

```text
exists=True len=31 mtime=2026-11-12T18:39:26.3723120+08:00
sha256=D7E9239EDCE00217AC412632E998128C054854B209CCD6085B9D780117571D9E
content=user-uncommitted-test-data-2
```

**(2) 内容没被改** —— SHA256 与创建时**逐字节相同**（`D7E9239E…1D9E`），mtime 一毫秒未动。

**(3) `git status` 里仍是 untracked**

```text
$ git status --porcelain=v1 -- docs/plan/wt-user-dirty-2.txt
?? docs/plan/wt-user-dirty-2.txt

$ git ls-files docs/plan/wt-user-dirty-2.txt
（空）                        → 未被 git 跟踪

$ git diff HEAD -- docs/plan/wt-user-dirty-2.txt
（空）                        → 与 HEAD 无差异（因为它不在 HEAD 里）
```

**(4) 旁证：子 Agent 的工作树里根本没有这个文件**（所以它不可能被覆盖/删除）

```text
$ Test-Path …\b519579f-…\docs\plan\wt-user-dirty-2.txt
False
```

**(5) 机制层受控实验：新建工作树不会带走未跟踪文件**

```text
$ git worktree add -b tmp-untracked-check .meetingstone\worktrees\tmp-untracked-check 31350a8
  新建树存在 = True
  含未跟踪的 wt-user-dirty-2.txt = False        ← 未跟踪文件不复制
  含已跟踪的 wt-user-dirty.txt   = True         ← 已提交文件才会出现
$ git worktree remove .meetingstone\worktrees\tmp-untracked-check    # exit=0
$ git branch -D tmp-untracked-check
```

这条同时解释了 D-1 与 D-2 的差别，也印证了 `docs/worktree-isolation.md` §2.1
「工作树不复制未跟踪 / 忽略文件」：**未跟踪文件对工作树是不可见的，因此工作树永远
无法覆盖或删除它**（这是隔离带来的正面保护）。反过来说，**已提交的文件会出现在新树里，
主仓库对它的后续修改在工作树看得到旧版本** —— 这解释了为什么 D-1 那个文件一旦被提交，
行为就变了。

### 5.4 第三次观察：**同一个探针文件在 6 分钟后被第二次卷走**

写完上一节（18:47 前后核验通过）之后，我在 18:50 做收尾复查，发现
**`wt-user-dirty-2.txt` 也被卷进了一个新的提交**：

```text
$ git log --oneline --all -- docs/plan/wt-user-dirty-2.txt
53c06ad fix(b3): 项目/会话角色覆盖从「靠纪律不传」改为「代码层剥掉」（产品体验复核抓到）

$ git show --stat --oneline 53c06ad
53c06ad fix(b3): 项目/会话角色覆盖从「靠纪律不传」改为「代码层剥掉」（产品体验复核抓到）
 docs/plan/wt-user-dirty-2.txt |   1 +          ← 又是我的探针
 src/session/config.js         |  76 +++++++++-
 tests/session-config.test.mjs | 146 +++++++++++++++++++++
 3 files changed, 214 insertions(+), 9 deletions(-)

$ git log -1 --format='%ad' --date=iso 53c06ad
2026-11-12 18:49:56 +0800
```

时间关系很关键：

| 时刻 | 事件 |
| --- | --- |
| 18:39:26 | 我创建 `wt-user-dirty-2.txt`（untracked） |
| 18:39:50 | 派单 `2e538f9a` 启动（在独立 worktree 里写 `wt-d.txt`） |
| 18:43:48 | 任务结束。**此时探针仍是 `??` 未跟踪**（18:47 我核验过） |
| **18:49:56** | **无关提交 `53c06ad` 把探针一并提交** |

→ **任务期间（18:39:50–18:43:48）探针一直是干净的 untracked，被卷走发生在任务结束
6 分钟之后，与一切 worktree 行为无关。**

**内容依然没丢**（逐字节比对）：

```text
$ Get-FileHash docs\plan\wt-user-dirty-2.txt -Algorithm SHA256
D7E9239EDCE00217AC412632E998128C054854B209CCD6085B9D780117571D9E    ← 与 18:39 创建时一致

$ git cat-file -s 53c06ad:docs/plan/wt-user-dirty-2.txt
31                                                                    ← 与工作区文件同为 31 字节

$ git diff 53c06ad -- docs/plan/wt-user-dirty-2.txt
（空）                        → 工作区与提交内容完全一致，未被篡改
```

### 5.5 场景 D 最终判定

| 检查项 | D-1（wt-user-dirty.txt） | D-2（wt-user-dirty-2.txt，受控） |
| --- | --- | --- |
| 文件仍在 | ✅ | ✅ |
| 内容未被改 | ✅（字节一致） | ✅（SHA256 一致，两次卷走都没改内容） |
| 任务期间仍为 untracked | ✅（任务启动前就被卷走了，非任务所致） | ✅ **18:47 核验为 `??`** |
| 事后仍为 untracked | ❌ 被 `8459115`（18:34:04）卷走 | ❌ 被 `53c06ad`（18:49:56）卷走 |
| 归因 | 主仓库并发提交，**与 worktree 无关** | 同上，且发生在任务结束 6 分钟后 |

**判定（这是本报告最重要的一条，我按事实分两句话说）**：

1. **worktree 隔离对用户未提交文件是安全的** —— 任务运行期间探针始终 `??` 未跟踪、
   SHA256 未变、mtime 未动；子 Agent 的工作树里根本没有这个文件
   （`Test-Path …\b519579f-…\docs\plan\wt-user-dirty-2.txt → False`），
   所以它**不可能**被工作树覆盖或删除。这一条通过。
2. **但「用户未提交文件」在整仓层面并不安全** —— 只要主仓库有人做「把整个工作区一起提交」
   的操作，未跟踪文件就会被静默卷入。本轮在 26 分钟内**连续两次**实证
   （`8459115` 18:34、`53c06ad` 18:49）。这不是 worktree 模块的缺陷，
   但它意味着「用户未提交的工作不受影响」这个承诺**只在 worktree 层面成立，
   在仓库层面不成立**，必须靠提交纪律补。

**对本次验收结论的准确表述**：

> 场景 D 的**被测命题**（「派一个任务会不会动到我的未提交文件」）**通过**。
> 验收过程中额外发现的**相邻风险**（「并发提交会卷走未跟踪文件」）**命中两次**，
> 属于高层流程问题，严重度高于 worktree 隔离本身。

---

## 6. 失败项与根因汇总

| # | 现象 | 根因 | 归属 | 严重度 |
| --- | --- | --- | --- | --- |
| F1 | 未跟踪测试文件被卷进不相干提交 —— **26 分钟内连续两次**（`8459115` 18:34、`53c06ad` 18:49） | 主仓库执行了「整工作区提交」，未做路径白名单；与 worktree 模块无关 | **流程 / 主 Agent 提交纪律**，非 worktree 模块 | **高**（未跟踪数据可被静默提交，且内容不变所以极难发现） |
| F2 | 5 棵测试树 + 4 条分支在验收后仍全部存在 | 设计上「一律不自动删除」，有意保留未合并改动 | `src/worktree.js:18-19`（设计） | 中（清理债，非缺陷） |
| F3 | `meetingstone/*` 分支累积到 48 条，`worktree list` 有无人认领的孤儿树 | 无自动清理 + 无巡检流程 | 流程 | 中（长期膨胀） |
| F4 | 同一文件并行写**不会被阻止**，只在终态告警 | overlap 是事后检测（`run-store.js:128`），无写锁 | 设计（文档已承诺「不自动合并」） | 低（需人工裁决，已知） |
| F5 | 合并测试是在**移动中的 main** 上做的（HEAD 期间变了 4 次） | 验收窗口内 Lead 持续提交 | 环境 | 低（已记录，影响可复现性） |
| F6 | LF 文件提交时出现 `LF will be replaced by CRLF` 警告 | Windows `core.autocrlf` | 环境 | 极低（仅噪音） |

**没有发现 worktree 模块自身的功能性失败**：建树、隔离、`changedFiles` 计算、
`overlapWarnings` 双向落盘、手动移除/`prune`/`branch -d` 全部符合设计。

---

## 7. 一个必须记录的边界事实：本轮我自己越界写了主仓库

本报告的落地位置就是一次**活的边界演示**：

- 我（八戒）这个会话的 cwd 是 `D:\MeetingStone\.meetingstone\worktrees\661fc1ae-…`
  （一棵由派单自动创建的工作树）；
- 但我把本报告**直接写进了主仓库** `D:\MeetingStone\docs\plan\2026-11-12-worktree-acceptance.md`，
  **没有走「写自己树 → 合并」的流程**；
- 这说明：**`worktree` 只是默认 cwd 不同，它拦不住子 Agent 主动写主仓库**
  （同账号、同文件系统、无 sandbox）。与 `docs/worktree-isolation.md` §2.3 的表述完全一致。

选这个做法的理由：本报告是给 Lead 直接看的交付物，放进我自己的分支反而需要额外合并；
但**这个选择本身证明了隔离不是安全边界**，所以在此明示，不做美化。
（顺带：`docs/plan/wt-user-dirty-2.txt` 被两次卷走也说明同一个道理 —— 主仓库是"共享且无人看守"的）

---

## 8. 复现步骤（可照抄）

```powershell
$PROJ = "D:\MeetingStone"
Set-Location $PROJ
git worktree list                          # 起始基线

# A：两个任务各写各的文件（同时派单，两个独立 worktree）
#   meetingstone_dispatch({role:'悟空', task:'…创建 docs/plan/wt-a.txt 内容 A…'})
#   meetingstone_dispatch({role:'悟空', task:'…创建 docs/plan/wt-b.txt 内容 B…'})
# 验收：
git -C "$PROJ\.meetingstone\worktrees\<A1>" status --porcelain   # 只应有 wt-a.txt
git -C "$PROJ\.meetingstone\worktrees\<A2>" status --porcelain   # 只应有 wt-b.txt
# merge-tree 预判（非破坏）：
git merge-tree --write-tree main meetingstone/<A1>               # 期望 exit 0
git merge-tree --write-tree main meetingstone/<A2>               # 期望 exit 0

# B：两个任务写同一文件
#   验收：读 .meetingstone/runs/<childId>.json 的 overlapWarnings，应互相命中
# 合并冲突验证（在临时分支，不污染 main）：
git switch -c tmp-conflict
git merge --no-ff meetingstone/<B1>        # 期望成功
git merge --no-ff meetingstone/<B2>        # 期望 CONFLICT (add/add)，exit 1
git merge --abort; git switch main; git branch -D tmp-conflict

# C：清理
git worktree list                          # 期望任务完成后仍在（无自动清理）
git worktree remove "$PROJ\.meetingstone\worktrees\<干净且已合并>"
git worktree remove "$PROJ\.meetingstone\worktrees\<有未提交改动>"   # 期望 exit 128 拒绝
git worktree prune -v                      # 清理孤儿登记

# D：用户未提交文件（关键）
'user-uncommitted-data' | Set-Content "$PROJ\docs\plan\dirty-probe.txt" -NoNewline
$before = (Get-FileHash "$PROJ\docs\plan\dirty-probe.txt" -Algorithm SHA256).Hash
#   → 派一个任务，只让它在自己的 worktree 里写别的文件
# 验收：
(Get-FileHash "$PROJ\docs\plan\dirty-probe.txt" -Algorithm SHA256).Hash   # 必须 == $before
git status --porcelain=v1 -- docs/plan/dirty-probe.txt                    # 必须仍是 ??
git ls-files docs/plan/dirty-probe.txt                                    # 必须为空
# 注意：验收期间不要在主仓库做「整工作区提交」，否则会把 probe 文件卷走（见 F1）
```

---

## 9. 对文档/流程的具体建议

1. **`docs/worktree-isolation.md` 补一条已知限制（针对 F1）**：
   > 工作树不保护主工作区里**尚未提交**的文件。若在主仓库执行了把整个工作区一起提交的操作，
   > 未跟踪文件会被一并带走。做隔离验收/长期派单时，主仓库提交请显式给路径白名单。
2. **加一个清理巡检**（针对 F2/F3）：把「工作树是否已被合并 + 分支是否可达」做成只读报告，
   人工确认后批量 `worktree remove` + `branch -d`。**不要**改成自动删除。
   当前实测：48 条 `meetingstone/*` 分支、7 条 `worktree list` 条目，其中已有无人认领的树。
3. **（可选）overlap 前置化（针对 F4）**：可考虑在 dispatch 时对 `files`/`scope.include`
   做一次「同项目在跑任务的目标文件」粗判，命中就在派单回执里提示。这是**提示**不是拦截，
   与「不自动合并」不冲突。当前实现只有终态事后告警，改同一文件时两个 Agent 已经写完了。
4. **D 类验收必须用不重名的探针文件名**，且验收期间冻结主仓库批量提交（针对 F5 的复现性）。

---

## 10. 附：本轮我产生的 git 变更（可回滚）

```text
$ git log --oneline -6
31350a8 accept-A2: merge wt-b.txt from worktree 1736ccd5     ← 我：合并 A2
d30bd3f accept-A1: merge wt-a.txt from worktree f361598e      ← 我：合并 A1
6c20f99 A2 wt-b                                              ← A2 树里的提交
be6006c A1 wt-a                                              ← A1 树里的提交
3810575 docs: 今晚进展报告 + 黄色状态技术评估                   （非我）
6650844 fix(security): 重放块的边界标记可被伪造逃逸（审计 §4.1，中危）   （非我）

# 我引入的 main 变更仅两个文件，各 1 行：
$ git show --stat --oneline d30bd3f | tail -1
 docs/plan/wt-a.txt | 1 +
$ git show --stat --oneline 31350a8 | tail -1
 docs/plan/wt-b.txt | 1 +
```

先前提交的祖先关系未被我破坏：

```text
is 8459115 ancestor of HEAD = True
is 6650844 ancestor of HEAD = True
is 3810575 ancestor of HEAD = True
is c238ea3 ancestor of HEAD = True
```

**遗留在仓库里的测试产物（需人工决定是否删）**：

- main 上（已合并，可随时 `git rm`）：`docs/plan/wt-a.txt`、`docs/plan/wt-b.txt`
- main 上（被并发提交卷走，**不是我提交的**）：`docs/plan/wt-user-dirty.txt`（`8459115`）、
  `docs/plan/wt-user-dirty-2.txt`（`53c06ad`）。两个文件内容完好、可随时删除或保留。
- 分支（未删，改动仍可取回）：`meetingstone/1736ccd5-…`、`meetingstone/5b6c84de-…`、
  `meetingstone/2bbb155a-…`、`meetingstone/661fc1ae-…`
- 已删除：5 棵测试工作树全部 `git worktree remove` 干净（`exists=False` ×5）；
  `tmp-accept-b-conflict` / `tmp-untracked-check` 两个临时分支已删。
- run 记录：5 份全部保留在 `.meetingstone/runs/`（带 worktree 不自动清理，属预期）。

**本轮我没有改任何产品代码**：`src/**` 零改动；`git log` 里我引入的 main 变更只有两个
`docs/plan/wt-*.txt`（各 1 行）。要完全回滚：

```powershell
Set-Location D:\MeetingStone
git revert --no-edit 31350a8 d30bd3f        # 撤掉两次合并（或直接 git rm 两个文件再提交）
git worktree prune -v                       # 清残留登记
```
