# Windows 真机验收（V1 / 0.1.0-alpha）

> 目的：在 **Windows 11 + 真实 DSH** 上验收六类行为——四通道派单、Jobs 面板、取消与进程清理、
> 工作树隔离、双项目配置隔离、三面板回归。
> 自动化部分用 `npm run acceptance`；人工部分按本文 §2 a–f 逐项执行并留证据。
>
> 相关文档：[0.1.0-alpha 发布清单](0.1.0-alpha-checklist.md) · [通用发布检查清单](../release-checklist.md) ·
> [工作树隔离](../worktree-isolation.md) · [三面板职责与命名](../gui-0.2.0.md#6-三个面板的职责与命名规则p0-1) ·
> [安全与权限边界](../security.md)

## 0. 前置条件与记录

### 0.1 环境

| 项 | 要求 | 核对命令 |
| --- | --- | --- |
| 系统 | Windows 11（本项目只在 Windows 11 验证） | `Get-ComputerInfo \| Select-Object WindowsProductName,OsVersion` |
| Node | ≥ 18（本仓库实测 v20.16.0） | `node --version` |
| git | 支持 `git worktree`（实测 2.54.0.windows.1） | `git --version` |
| DSH | `0.2.2-rc.1`（见 `engines.dsh`） | `dsh --version` |
| 安装形态 | **用 `npm pack` 的 tarball 安装到隔离 profile**；linked 安装不算验收 | 见 [0.1.0 清单 §3.2](0.1.0-alpha-checklist.md#32-真机冒烟隔离-profile不动-desktop) |
| 项目 | 必须是 git 仓库，且验收前 `git status --short` 干净 | `git -C <项目根> status --short` |

隔离 profile 建议：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$env:DSH_HOME = "$env:TEMP\mt-acceptance\dsh-home"     # 只影响当前窗口
npm pack                                              # 产出 dsh-meetingstone-<版本>.tgz
& $dsh plugin --profile mt-acceptance add "<tgz 的绝对路径>"
& $dsh --profile mt-acceptance --dump-config | Select-String "meetingstone"
```

### 0.2 记录模板（每个环境填一次）

| 项 | 值 |
| --- | --- |
| 验收日期 / 验收人 | |
| OS / Node / git / DSH | |
| 被测 tarball 与 SHA-256 | `Get-FileHash <tgz> -Algorithm SHA256` |
| profile 名 | |
| 项目根（A） | `D:\MeetingStone` |
| 第二个项目根（B） | `%TEMP%\mt-acceptance-b` |
| 自动化日志路径 | `.meetingstone\acceptance-<日期>.log` |

> 证据统一放 `.meetingstone/`（已 gitignore）或仓库外；不要提交到仓库。
> 每个勾选项都要附命令输出、截图或 `.meetingstone/runs/<childId>.json`。

## 1. 可自动化部分

### 1.1 一条命令跑完

```powershell
npm run acceptance 2>&1 | Tee-Object -FilePath ".meetingstone\acceptance-$(Get-Date -Format yyyyMMdd-HHmm).log"
```

`scripts/acceptance-windows.mjs`（零依赖）会依次检查 8 项，输出 PASS/FAIL 表（版本未就绪时可出现 WARN）：

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 门禁 · 测试（`npm test`） | 0 fail；平台 skip 需注明原因 |
| 2 | 门禁 · 工具 schema | PASS，8 个工具的注册产物符合宿主 / 模型 API 契约 |
| 3 | 门禁 · manifest | PASS，name / engines / files / 补丁一致 |
| 4 | 门禁 · 发布包 | PASS，只含该含文件，< 2 MB |
| 5 | `release:check`（版本/CHANGELOG + 门禁重跑） | 目标版本、`PLUGIN_VERSION`、CHANGELOG 条目一致 |
| 6 | 工具数 = 8 | `TOOL_NAMES` 与 `apply()` 实际注册产物逐个对齐 |
| 7 | 命名清洗函数存在 | `src/naming.js` 的 `stripMarkdown` / `buildTaskLabel` 行为正确 |
| 8 | `git worktree` 命令可用 | `git worktree list` 成功，当前目录在列表中 |

**退出码**：`0` = 无 FAIL；`1` = 有 FAIL；`2` = 参数错误/脚本自身异常。

> 版本未 bump 时的已知状态：`package.json` / `PLUGIN_VERSION` 仍是 `0.0.16`，而
> [0.1.0 清单](0.1.0-alpha-checklist.md) 的目标是 `0.1.0-alpha`，第 5 项会 FAIL。这是**预期**的未发布状态，
> 不是脚本缺陷；bump 三处版本后应转 PASS。bump 前若只想验证其它 7 项：
>
> ```powershell
> npm run acceptance -- --allow-pending-version   # 只把第 5 项降级为 WARN，退出码 0
> ```
>
> **发布验收不得使用该参数**：发布前必须让第 5 项 PASS。

### 1.2 分步命令（需要单独取证时）

```powershell
node scripts/run-tests.mjs            # = npm test，TAP 摘要
node scripts/verify-host-schema.mjs   # 8 个工具的 schema 契约
node scripts/verify-manifest.mjs      # package / 补丁 / 入口契约
node scripts/verify-package.mjs       # npm pack --dry-run 内容校验
npm run release:check                 # 目标版本 + CHANGELOG + 四条门禁
npm run acceptance                    # 本文件：四条门禁 + release:check + 结构检查
```

包结构人工核对（`verify-package` 已自动校验，这里只留证据）：

```powershell
npm pack --dry-run
```

- 期望：包含 `package.json`、`README.md`、`LICENSE`、`cordis.patch.yml`、`src/**`（含 `src/naming.js`、
  `src/worktree.js`）；**不含** `tests/`、`scripts/`、`docs/audit/`、`examples/`、`.meetingstone.json`、
  `personas.json`；总大小 < 2 MB（当前基线约 30 个文件 / 525 KB）。
- 工具数人工核对：`node scripts/verify-host-schema.mjs` 末行 `PASS: 8 个工具…`，并逐个列出工具名。

自动化通过只说明“构建与契约没坏”，**不能替代 §2 的真机人工项**。

## 2. 需人工执行的部分

> 以下每节固定给出 **操作 → 期望 → 失败判定**。派单任务都用 `isolation: "none"` 以排除工作树干扰
> （工作树单独在 §2d 验证）；同一项目同时只跑一个任务（`serializeWrites` 默认串行）。

### a. 四通道派单（每通道至少一次）

**准备**：先确认通道可用，不可用记 SKIP（不是 FAIL）：

```text
meetingstone_cli_status({ cli: "codex" })
meetingstone_cli_status({ cli: "codebuddy" })
meetingstone_cli_status({ cli: "claude" })
```

| 通道 | kind / provider | 建议角色 | 不可用时的 SKIP 原因（如实填） |
| --- | --- | --- | --- |
| in-process | `in-process` / `spawn` | 八戒（`role-bajie`） | 宿主未注册 `spawn` provider（`PROVIDER_UNAVAILABLE`） |
| codex | `codex` / `codex` | 悟空（`role-wukong`） | 未装 `@deepseek-ai/dsh-subagent-codex`，或 `cli_status.installed=false` |
| acp | `acp-cli` / `acp` | 沙僧（`role-sashi`） | 未装 `@deepseek-ai/dsh-subagent-acp`，或 CodeBuddy CLI 不可用 |
| claude | `claude-code` / `claude-code` | Claude（`role-claude`，默认 `enabled:false`） | 未装 provider 或本机无 Claude CLI；本机历史记录为**未安装** |

> Claude 角色默认禁用：验收前在项目 `.meetingstone.json` 用同 `roleId` 覆盖 `enabled: true`
>（或临时改全局配置），重启/重载后再派单；验收结束还原。启用后 `meetingstone_list_roles({ verbose: true })`
> 的 `availability` 应为 `available`，否则按 SKIP 记录 `provider-unavailable`。

每次派发（示例为 in-process）：

```text
meetingstone_dispatch({
  "role": "八戒",
  "task": "只回复 PONG。不要调用任何工具，不要读写文件。",
  "isolation": "none",
  "acceptance": ["结果文本包含 PONG"]
})
```

**期望**：

- 返回 `ok: true` + `taskRef.childId`（以及 `provider`；Jobs 可用时还有 `jobId`）；
- `meetingstone_get_task({ childId })` 终态 `status=completed`、`stopReason=completed`，摘要 / 结果含 `PONG`；
- `meetingstone_list_runs` 能看到该条记录（标题含角色与目标，无 Markdown 符号）；
- 无 400 / schema 报错，DSH 会话日志无 `Invalid schema`。

四通道各记一行：通道、角色、childId、耗时、结果、结论（PASS / SKIP + 原因）。

**失败判定**：任意通道返回 `ADAPTER_FAILED` / `PROVIDER_UNAVAILABLE`（且 provider 与 CLI 都已安装）、
结果不含 PONG、会话出现 400、或任务启动后一直无终态（超过角色 `timeoutMs` 仍 `running`）。
外部通道额度耗尽（`failureClass=quota`）记为环境问题 + SKIP，不算产品 FAIL，但必须写明。

### b. Jobs 面板（Background Tasks）

**操作**：

1. 打开 Background Tasks 面板，记下当前条目数。
2. 派一个**可控长任务**（建议 in-process）：

   ```text
   meetingstone_dispatch({
     "role": "八戒",
     "task": "先运行 PowerShell 命令 Start-Sleep -Seconds 60，然后只回复 DONE。",
     "isolation": "none"
   })
   ```

3. 隔 5 秒观察两次面板；然后点该条目的**停止**按钮。
4. 立刻用 `meetingstone_get_task({ childId })` 查状态。

**期望**：

- 派单后约 2 秒内面板出现一条，`kind=meetingstone-dispatch`，标题为 `角色简称 · 简短目标`；
- 运行中进度只显示 `已启动`，耗时/运行时长随时间增长（两次观察数值变大）；
- 点停止后宿主 Job 终态为 **`killed`**（宿主 Job 状态闭集是 `completed/failed/killed`）；
  detail 可能是 `cancelled` 或 `cancelled (stop unconfirmed)`；
- 同时 `meetingstone_get_task` 的 `status=cancelled`、`stopConfirmed:true`（未确认时见 §2c）。

**失败判定**：jobs 服务已加载但面板无条目；条目 `kind` 不是 `meetingstone-dispatch`；
标题含 Markdown 符号或绝对路径；停止后 Job 一直 `running`；`get_task` 仍是 `running`。
若宿主未加载 `@deepseek-ai/dsh-tool-jobs`，面板无 Job 属**已知限制**：记 SKIP + 宿主 bundle 缺失证据。

### c. 取消后无残留进程（Windows 进程清理）

**操作**：取消前后各采一次基线。**基线差值是权威判据**——任务正文走 API/stdin，不保证出现在
子进程命令行里；`$marker` 只在能拿到 `worktree.path`（默认隔离）时较可靠，`isolation:none` 时用
进程名过滤 + PID 对比：

```powershell
$marker = '<get_task 返回的 worktree.path；没有就填空字符串>'
$snapshot = {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and (
        ($marker -and $_.CommandLine.Contains($marker)) -or
        $_.CommandLine -match 'codebuddy|codex-cli|claude-code|--acp'
      )
    } |
    Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine
}
$before = & $snapshot | Select-Object ProcessId, Name
# …派单、等它进入运行、然后停止 / meetingstone_cancel_task…
Start-Sleep -Seconds 10
$after = & $snapshot
$after | Format-List
$beforeIds = @($before | ForEach-Object { $_.ProcessId })
$afterIds  = @($after  | ForEach-Object { $_.ProcessId })
Compare-Object $beforeIds $afterIds
```

**期望**：

- `$after` 为空，或仅剩取消前就存在、与该任务无关的进程；
- `Compare-Object` 不出现该任务新启动的 PID；
- 记录里 `stopConfirmed:true`，`.meetingstone/runs/<childId>.json` 的 `status=cancelled`。

**失败判定**：

- 10 秒后仍有命令行含 `$marker` / 该任务 ACP 入口的新进程；
- `stopConfirmed:false` 且 `diagnostic` 显示 dispose 超时，30 秒后进程仍在；
- 槽位未释放（随后再派单报 `ACTIVATION_LIMIT_REACHED` / `WRITE_LIMIT_TOTAL`）。

处理：先保存 `ProcessId`、`CommandLine`、`CreationDate` 与记录 JSON 作为证据；确认是本次任务拉起的孤儿进程后，
再**人工**结束（`Stop-Process -Id <pid>`），不要批量杀 `node.exe`（会误伤 DSH 自身）。
`stopConfirmed:false` 本身是保守记录（不伪造），只有“进程持续存活”才算 FAIL。

### d. 工作树隔离

**操作**：项目 A 干净时派一个会写文件的任务（**不传** `isolation`，使用默认 worktree）：

```text
meetingstone_dispatch({
  "role": "沙僧",
  "task": "在项目根创建文件 acceptance-probe.txt，内容写 OK；不要改其它文件。",
  "acceptance": ["acceptance-probe.txt 内容为 OK"]
})
```

**期望**：

- `meetingstone_dispatch` / `meetingstone_get_task` 返回
  `worktree: { path: <项目根>\.meetingstone\worktrees\<uuid>, branch: meetingstone/<uuid>, baseSha, repositoryRoot }`；
- 工作树目录真实存在，`git -C <项目根> worktree list` 包含它；
- `changedFiles` 含 `acceptance-probe.txt`（`changedFilesUnknown` 不是 `true`）；
- 文件只出现在工作树：`git -C <worktree> status --short` 有 `?? acceptance-probe.txt`；
  `git -C <项目根> status --short` **不出现**该文件（`acceptance-probe.txt` 不应落到主工作区）；
- 主仓库最终仍然干净（`.meetingstone/` 已忽略）。

```powershell
$proj = 'D:\MeetingStone'
$wt   = '<get_task 返回的 worktree.path>'
git -C $proj status --short
git -C $proj worktree list
git -C $wt status --short
Get-Content (Join-Path $wt 'acceptance-probe.txt')
git -C $proj status --short
```

**失败判定**：主工作区出现 `acceptance-probe.txt`；`worktree.path` 逃出项目根；
派单在 git 仓库上静默退回主工作区；`changedFiles` 为空/`changedFilesUnknown:true` 但文件确实存在；
建树失败没有返回 `WORKTREE_*` 错误码。带 worktree 的记录**不会自动清理**，验收后按
[worktree-isolation.md §6](../worktree-isolation.md) 人工 `git worktree remove` + `git branch -d` 清理。

### e. 两个项目的配置互不影响

**操作**：

1. 建项目 B（独立 git 仓库 + 只属于 B 的项目级角色）。**代码块内容从行首开始抄**：

```powershell
$B = Join-Path $env:TEMP 'mt-acceptance-b'
New-Item -ItemType Directory -Force $B | Out-Null
git -C $B init -q
$config = @{
  version = 1
  roles = @(
    @{
      roleId  = 'role-proj-b'
      name    = '项目B专属'
      channel = @{ kind = 'in-process'; provider = 'spawn' }
      enabled = $true
    }
  )
} | ConvertTo-Json -Depth 5
$config | Set-Content -Encoding utf8 (Join-Path $B '.meetingstone.json')
```

2. 在 A（`D:\MeetingStone`）开会话，调用 `meetingstone_list_roles({ verbose: true })`；
3. 在 B 开会话（用宿主新建会话、工作目录选 `$B`），同样调用；
4. 回 A 再查一次，并核对 A 的 `.meetingstone.json` 哈希未变：

   ```powershell
   (Get-FileHash 'D:\MeetingStone\.meetingstone.json' -Algorithm SHA256).Hash
   ```

**期望**：

- B 的列表含 `role-proj-b`，`source: "project"`；A 的列表**不含** `项目B专属`；
- A 的全局角色在 B 仍可见（全局 → 项目合并符合 `docs/configuration.md`）；
- A 的项目配置哈希在 B 会话操作前后不变；B 的 `.meetingstone.json` 不被 A 会话改写；
- A 设置页里给当前会话做的角色覆盖，不会出现在 B 的会话（会话级覆盖按 session 隔离）。

**失败判定**：B 的项目角色出现在 A；A 的项目角色被 B 覆盖；一次会话的覆盖写进了另一项目的
`.meetingstone.json`；配置文件被无关节目的会话改写（比对 mtime/哈希）。

### f. 三面板回归（Todo / Background Tasks / Subagents）

**操作**：

1. Todo：调用 `todo_write` 建一条 `[验收] 三面板回归`（status `in_progress`）；
2. Background：按 §2b 派一个长任务；
3. Subagents：用 **in-process** 派一个短任务（外部 CLI 是否出现在 Subagents 由宿主决定，见“已知限制”）；
4. 观察三个面板，逐项记录标题/状态/详情。

**期望**：

| 面板 | 正确条目 | 通过标准 |
| --- | --- | --- |
| Todo | 你手工建的 `[验收] 三面板回归` | 只出现这一条（及原有项目 Todo）；**派单不会自动建 Todo** |
| Background Tasks | 长任务 Job | `kind=meetingstone-dispatch`；标题 `角色 · 目标`；运行中可停止；终态 `killed` |
| Subagents | in-process 子 Agent | 目录行标题与 Jobs 标签**同一字符串**（同一 `buildTaskLabel`）；父子关系/状态可见 |

命名规则（三处必须一致，详见 [gui-0.2.0.md §6.2](../gui-0.2.0.md#62-命名规则)）：

- 格式 `角色简称 · 简短目标`；目标 ≤ 14 字（超长以 `…` 结尾）；
- **不含 Markdown 符号**：``* _ # ` [ ] ( ) { } < > | ~ \``；不出现 `meetingstone:` 前缀、
  `任务：` / `Task:` 标签、`[object Object]`、换行；
- 不把工作树绝对路径写进面板；Job 终态详情 ≤ 80 字。

**失败判定**：派单在 Todo 里造出条目；三个面板标题不一致；标题出现 Markdown 符号、绝对路径或空标题；
in-process 任务在 Subagents 面板完全不可见（外部 CLI 不可见属已知限制，只记录不判 FAIL）。

## 3. 已知限制（验收时按此解释）

完整清单见 [0.1.0-alpha 清单 §7](0.1.0-alpha-checklist.md#7-已知限制发布说明必须同步)，与本次验收直接相关的有：

1. **外部 CLI 的 Subagents 可见性不受插件控制**：插件用 `delivery:'caller'`，`label` 对
   acp / codex / claude-code 行标题不生效；外部任务是否进 Subagents 面板取决于宿主会话目录。
   因此 §2f 的 Subagents 项**只用 in-process 判定通过**。
2. **Jobs 是进程内的**：DSH 重启后旧 Job 不续跑、不再出现在面板；插件卸载会把存活任务写 `interrupted`。
3. **取消不保证“立即”确认**：dispose 超时先记 `stopConfirmed:false` 并保留槽位，等结果落定再回填 `true`；
   记录保守不等于进程泄漏，但必须按 §2c 实测进程。
4. **工作树是文件布局隔离，不是权限沙箱**：子 Agent 同账号、可主动写主工作区；共享 git 元数据。
5. **Claude 通道默认未启用**：本机历史上未安装 Claude CLI / provider；无环境时记 SKIP。
6. **版本元数据可能未就绪**：`release:check` 的版本/CHANGELOG FAIL 是 bump 前预期状态（§1.1）。
7. **平台范围**：只在 Windows 11 + DSH `0.2.2-rc.1` 验证；其他组合不纳入本次签收。
8. **单插件实例**：多 DSH 进程同时操作同一仓库 / `.meetingstone/runs` 未压测，不纳入签收。

## 4. 不通过怎么办

### 4.1 先分类，再决定是否阻塞发布

| 现象 | 判定 | 动作 |
| --- | --- | --- |
| 四条门禁任一 FAIL | 产品/构建缺陷（P0） | 修代码后重跑 `npm run acceptance`；不 bump 版本 |
| `release:check` 仅版本/CHANGELOG FAIL | 未发布状态（预期） | 按 [0.1.0 清单 §1–2](0.1.0-alpha-checklist.md) bump 后重跑；发布前必须转 PASS |
| CLI 未安装 / provider 未加载 | 环境不满足（SKIP） | 记录 `cli_status` 证据与缺失 provider 名；不判产品 FAIL |
| 额度耗尽（`failureClass=quota`） | 环境/账号（SKIP） | 记录原始错误；不自动重试、不换模型/registry |
| Jobs 面板无条目（jobs 服务已加载） | 产品缺陷（P0） | 留面板截图 + `meetingstone_get_task` 输出 |
| 停止后进程仍存活 > 30s | 进程清理缺陷（P0） | 留 PID/命令行/记录 JSON；人工清进程后报主控 |
| 主工作区出现任务文件 / 工作树逃出项目根 | 隔离缺陷（P0） | 立即停止继续派单，保留现场，报主控 |
| 项目配置串项目 / 覆盖写错文件 | 配置隔离缺陷（P0） | 保留两份配置哈希与 diff，报主控 |
| 面板标题含 Markdown / 三面板不一致 | 命名/集成缺陷（P1） | 截图 + 对应 `buildTaskLabel` 输入，报主控 |
| 仅视觉/截断差异（无功能影响） | 观察项（P2） | 记录版本与截图，不阻塞发布 |

### 4.2 证据包（每项 FAIL 都要有）

- 命令完整输出（`npm run acceptance` 用 `Tee-Object` 落盘）；
- 派单记录：`.meetingstone/runs/<childId>.json`（含 `status` / `stopConfirmed` / `worktree` / `changedFiles`）；
- 进程证据：`Get-CimInstance Win32_Process` 的 `ProcessId` / `ParentProcessId` / `CommandLine` / `CreationDate`；
- 隔离证据：`git -C <项目根> status --short` 与 `git -C <worktree> status --short` 的成对输出；
- 面板证据：三个面板截图（含标题与状态），以及是否加载 `@deepseek-ai/dsh-tool-jobs`。

### 4.3 禁止事项

- 不要为了让检查变绿而删测试、放宽断言、改 `release-check` 的版本目标或 `engines.dsh`；
- 不要在验收 profile 之外动 `desktop` profile 或用户仓库；
- 不要自动删工作树/分支（未合并改动可能只在工作树里）；不要批量杀 `node.exe`；
- 不要用 `--allow-pending-version` 的 WARN 状态签发发布。

### 4.4 回滚（验收发现 P0 时）

按 [0.1.0 清单 §6](0.1.0-alpha-checklist.md#6-回滚一分钟止血) 回退：profile 换回上一版 tgz →
重启 DSH → `--dump-config` 只出现预期层 → 派一个 in-process 任务确认可用。npm / GitHub 尚未发布时无需回滚远端。

## 5. 签收表

| # | 项目 | 结果（PASS / FAIL / SKIP） | 证据 |
| --- | --- | --- | --- |
| 1 | `npm run acceptance`（8 项） | ⬜ | 日志路径 |
| 2 | a. 四通道派单（in-process / codex / acp / claude） | ⬜ / ⬜ / ⬜ / ⬜ | childId 清单 |
| 3 | b. Jobs 出现、耗时增长、停止 → `killed` | ⬜ | 截图 + `get_task` |
| 4 | c. 取消后无残留进程 | ⬜ | 进程快照 + 记录 JSON |
| 5 | d. 工作树创建 / 改动只在 worktree / 主仓库干净 | ⬜ | `worktree list` + 双 `status` |
| 6 | e. 两个项目配置互不影响 | ⬜ | 两份 `list_roles` + 哈希 |
| 7 | f. 三面板回归 + 命名无 Markdown | ⬜ | 三张截图 |
| 8 | 已知限制已逐条确认 | ⬜ | 备注 |

**签收结论**：☐ 通过（可进入发布）　☐ 有条件通过（仅 SKIP 项，附原因）　☐ 不通过（有 P0 FAIL）

> 自动化 + 人工全部 PASS 才可进入 `npm publish`；SKIP 项必须写明原因与影响，不能留空。
