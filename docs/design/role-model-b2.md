# B2 · 角色模型与编辑器契约（PDF 第 2 条）

> 任务：B2（task-7）｜执行：沙僧｜2026-11-12｜状态：**实现完成（源码级）**
> 依据：PDF 第 2 条 / `docs/plan/2026-11-12-b0-native-roles.md`（no-go：不接原生 preset）/ C1 契约
> 边界：未改 profile、未重启 DSH；运行中宿主仍加载已安装 tgz，UI 真机验证待 D1。

## 1. 结论

1. **角色 = 名称 + 简称 + 单一「角色设定」+ CLI → 模型 → 思考强度**；用户界面不再出现「通道」概念（内部 `channel` 结构保留，仅作执行组合的落盘载体）。
2. **描述与 prompt 合并为 `setting`**：配置 schema 只认 setting；旧 `description`/`prompt` 在读取（registry）、写入（session/project/global writer）时迁移，内容不丢；内存 Role 保留 `description`/`prompt` 兼容镜像（均等于 setting，不持久化）。
3. **CLI→模型→强度 三级联动**：选项只来自已配置的 channels（不伪造）；某一层没有声明 → 显示「不支持」；派单时按「kind + model + reasoning」解析出唯一执行组合，找不到/歧义/不支持都失败关闭。
4. 实现后 `npm test`：**567 tests / 566 pass / 0 fail**；源码级 e2e 已验证「只声明 CLI+模型+强度的角色」可解析到正确组合并启动。

## 2. 数据模型

| 层 | 字段 | 说明 |
| --- | --- | --- |
| 持久化（config schema） | `roles[].setting` | 唯一设定字段（`src/config.js` RoleSchema） |
| 持久化（旧） | `description` / `prompt` | 迁移入口：读取时 `setting = setting ?? prompt ?? description`；写入时统一折叠到 setting（`src/session/config.js:sanitizeRolePatch`、`diffRoleOverride`、`normalizeFieldPath`） |
| 内存 Role | `setting` + 兼容镜像 `description`/`prompt` | `src/roles/registry.js:readRole/mergeRole`；镜像不写盘 |
| 模板 | 五人模板全部带 `setting` | `src/roles/template.js` |
| 会话覆盖 | `setting`（旧写入自动迁移） | `ROLE_SOURCE_FIELDS` 只列 setting（description/prompt 不再作为来源字段） |

## 3. CLI → 模型 → 强度

- **能力来源**：`src/roles/capabilities.js`
  - `buildCliCapabilities(channels)`：按 `channel.kind` 聚合模型/强度；实例没声明 reasoning → `reasoningSupported:false`（UI 显示「不支持」，不隐藏、不伪造）。
  - `modelOptionsFor` / `effortOptionsFor`：编辑器下拉的唯一来源。
  - `resolveRoleChannel(role, channels)`：有 channelId → 校验一致性；无 channelId → 按 kind(+model+reasoning) 找**唯一**匹配；错误码 `CHANNEL_NOT_CONFIGURED / MODEL_UNSUPPORTED / REASONING_UNSUPPORTED / CHANNEL_AMBIGUOUS / CHANNEL_NOT_FOUND / CHANNEL_MISMATCH`。
- **派单路径**：`src/dsh/adapter.js:resolveRoute` 先解析组合，后续 provider/model/提示词/落盘记录都用解析后的角色；无实例表的旧路径仍按 kind/provider 兼容启动。
- **记录**：run 记录 `channel/provider/model` 为解析后的真实组合（可复核「保存的组合=执行的组合」）。

## 4. UI（B1 入口复用）

- 编辑器字段：名称 / 简称 / **角色设定（textarea）** / **CLI（select）** / **模型（select）** / **思考强度（select，未支持显示「不支持」）**；`src/client/index.js:renderRoleDetail`。
- 切换 CLI 会清空模型/强度（避免残留非法组合）；保存时由唯一匹配组合解析出 `channelId/kind/provider/model/reasoning`（会话：只写差异；全局：一次 patch）。
- 用户文案：`fieldSetting/fieldCli` 新增；`通道` → `CLI`/`执行组合`（设置页高级区标签同步）；`noModelOptions/noReasoningOptions` 改为 CLI/组合口径。
- Host 快照新增 `global.capabilities`（`src/gui/host.js`）；客户端在缺失时从 channels 现场聚合（旧快照兼容）。

## 5. 验证证据

| 项 | 证据 |
| --- | --- |
| 单元/回归 | `npm test` 567 tests / 566 pass / 0 fail（新增 capabilities、迁移、联动相关用例） |
| 迁移 | 旧 `description+prompt` → `setting`（prompt 优先）；新字段优先；覆盖也折叠到 setting |
| 组合解析 | kind+model+reasoning → 唯一实例；不支持强度 → `REASONING_UNSUPPORTED`；只选 CLI 且多组合 → `CHANNEL_AMBIGUOUS` |
| 派单使用所选组合 | 源码级 e2e：role 仅声明 `{kind:'acp-cli', model:'flash-1', reasoning:'high'}` → provider=acp / model=flash-1 / channel=acp-cli；不支持的 `reasoning:'max'` 被拒绝启动 |

## 6. 未验证 / 待 D1

- 运行中宿主加载旧 tgz：新 UI 与真实派单需 Lead 重打包 install:safe 后在 D1 真机验收（窗口/下拉/保存/重开）。
- 设置页高级区仍展示执行组合（内部概念），未删除；`docs/gui-0.2.0.md` 未同步更新（B1 文档范围）。
- 思考强度的「真实能力值」仍以 channels 实例声明为准；没有 CLI 能力目录（B0 §缺口 G3，未在 B2 引入伪造能力表）。
