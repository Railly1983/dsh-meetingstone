# 09 · 发布规范与名称占用核验（P0-09）

> 采集人：八戒 ｜ 日期：2026-11-10 ｜ 结论先行：**npm 名可用；中文名有品牌冲突风险**

## 1. npm 包名

| 候选 | 查询 | 结果 |
| --- | --- | --- |
| `dsh-meetingstone` | `https://registry.npmjs.org/dsh-meetingstone` | **404 Not found → 可用** ✅ |
| `meetingstone` | 未查（不打算用裸名，避免与通用词/他人项目冲突） | — |

结论：**主推 `dsh-meetingstone`**。若后续要发多个包，可考虑 `@meetingstone/*` scope（scope 归属取决于账号/组织，发布前再定）。

## 2. GitHub 仓库名

`https://api.github.com/search/repositories?q=meetingstone+in:name` → **total_count = 17**。

| 仓库 | 情况 |
| --- | --- |
| `brooklynb7/MeetingStone_Happy`（74★, Lua, WTFPL） | **魔兽世界「集合石」插件**（组队找队伍） |
| `Lianzy-Baimiao/MeetingStone_Happy`（26★, Lua, MIT） | 同上的修改版，描述原文「魔兽世界集合石插件修改版」 |
| `DollKM/MeetingStoneEX`（12★, Lua） | 同系列扩展 |
| `anti-meetingstone/anti-meetingstone`（9★） | 同社区 |
| `dop-amen/MeetingStone`（TypeScript UI demo） | 同名但完全无关的 demo |

**关键事实**：「集合石 / MeetingStone」在中文社区**已经是魔兽世界插件的既有名字**（多个仓库、有星数、有衍生版）。GitHub 仓库名只需在账号内唯一，所以技术上可用；但作为面向中文用户的开源项目，重名会造成明显检索混淆。

## 3. 商标与声明

- 未做商标检索（境内商标库需人工/专业检索，超出本次范围）。
- 无论最终是否改名，README 必须声明：本项目与暴雪/网易、DeepSeek、OpenAI、Anthropic、腾讯等**均无隶属或背书关系**；如仍用 MeetingStone，须额外说明与本项目与魔兽世界插件无关。
- 正式发布前建议补一次商标初筛（记录在 `docs/security.md`）。

## 4. 发布路径（当前版本可走通的部分）

| 环节 | 结论 | 依据 |
| --- | --- | --- |
| 本地安装 bundle | ✅ 可行：`resources\runtime\cli\bin\dsh.cmd plugin --profile <name> add ./<dir>`，`--dump-config` 验证 | P0-02b 已实证（A/B/C/E 五组真实安装） |
| 打包形态 | ✅ `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` | P0-02 §1 |
| 版本门槛 | ✅ `engines.dsh = ">=0.2.2-rc.1 <0.3.0-0"` | P0-02b 实装验证 |
| npm 发布 | ⏳ 未验证（没有发过包；发布前需确认包名最终归属与 2FA 流程） | — |
| GitHub Release | ⏳ 未验证 | — |
| Discover / 插件市场 | ⏳ 未核验当期提交规则（交接文档要求「不要把自建索引说成官方市场」） | — |
| 从 git 安装 | ⚠️ 需要 `prepare` 自包含构建 + 用户侧 `allowBuilds` 放行 | P0-02 §1.7 |

## 5. 建议（需负责人决策）

| 方案 | 说明 | 影响 |
| --- | --- | --- |
| **A. 保留 MeetingStone** | 仓库叫 `meetingstone-dsh` 或 `dsh-meetingstone`，README 首段明确「与魔兽世界集合石插件无关」 | 名字好记、契合"组队找人"的产品隐喻；但检索会与 WOW 插件撞车 |
| **B. 改名** | 换一个不与既有项目冲突的名字（如 `stonefall` / `muster` / `rallypoint` 之类待选） | 无混淆；但"集合石"这个你已认可的中文名要放弃 |
| C. 中文名保留、英文名换 | 中文口头叫集合石，仓库/npm 用独立英文名 | 兼顾；但两份名字长期需维护 |

**本文不替负责人决定**，仅记录事实与选项。

## 6. 决议（2026-11-10，负责人已定）

**采用方案 A：保留 MeetingStone + 显式声明。**

| 项 | 定稿值 |
| --- | --- |
| GitHub 仓库 | **`dsh-meetingstone`** |
| npm 包 | **`dsh-meetingstone`**（已核验 404 可用） |
| 插件 ID | `meetingstone` |
| 中文名 | 集合石 |
| 必须声明 | README 首段写明：**本项目与魔兽世界的「集合石 / MeetingStone」插件无关**，也与 DeepSeek / OpenAI / Anthropic / 腾讯等厂商无隶属或背书关系 |
| 后续动作 | 发布前补一次商标初筛，结果记入 `docs/security.md` |

