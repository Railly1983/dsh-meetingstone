# 架构

> 只描述**当前实现**。所有与宿主打交道的地方都标注了出处，便于核验。

## 1. 分层

```
src/index.js            装配层：读 Config → 建注册表/探测/适配器/派单器 → 注册工具 → 生命周期
├── src/config.js       Config schema（内置零依赖校验，见 src/schema.js）+ 通道实例表
├── src/roles/          C1 角色注册表（纯逻辑）
│   ├── ids.js          roleId 规则、别名规范化
│   └── registry.js     全局 + 项目合并、别名冲突降级
├── src/project/        项目级配置（纯解析 + IO 缓存）
│   ├── config-file.js  .meetingstone.json 解析，永不抛异常
│   └── load.js         按 mtime 缓存读取
├── src/cli/            C2 本机 CLI 探测
│   ├── probe.js        多源编排 + 版本试跑 + 缓存（纯逻辑，可注入）
│   └── resolvers.js    PATH / Appx / npm 全局 / 常见目录（IO）
├── src/dispatch/       C3 派单编排（纯逻辑 + 可注入适配器）
│   └── dispatcher.js   角色解析、并发纪律、失败回滚
└── src/dsh/            DSH 接线层
    ├── adapter.js      ctx.subagents 适配器（provider 查询、startActivation、parent）
    └── register.js     十个工具的注册与返回值整形（工具数由 verify-host-schema 门禁断言）
```

## 2. 一次派单的数据流

```
用户："让沙僧改一下 X"
  → 模型调用 meetingstone_dispatch({ role: "沙僧", task: "...", cwd? })
  → register.js: 用 exec.agent.session.header.cwd 取项目根
      → projectStore.get(项目根) 读 .meetingstone.json（mtime 缓存，坏文件降级）
      → createRegistry(全局 + 项目覆盖)          ← 每次调用重建，避免脏配置
  → dispatcher.dispatch({...})
      1. 解析角色（歧义只挡名称/别名，roleId 仍可用）
      2. adapter.canStart → ctx.subagents.getProvider(name) 真实查询
      3. **先占并发槽**（全局上限 4，不按项目限额），失败回滚
      4. adapter.start({ role, task, cwd, context, onFinish })
  → adapter.start 前置校验（任一不满足即拒，不触达宿主）
      - parent 必须来自当次 exec.agent
      - model/reasoning 必须与引用的通道实例一致 → 否则 MODEL_UNSUPPORTED
      - cwd 必须在项目根内 → 否则 PATH_OUTSIDE_PROJECT / PROJECT_ROOT_UNKNOWN
  → ctx.subagents.startActivation(spec) → 返回 taskRef(childId/provider/name)
  → 任务终态时适配器回调 onFinish → dispatcher 幂等释放槽位
```

## 3. 设计不变量（改动时不许破）

| # | 不变量 | 为什么 |
| --- | --- | --- |
| 1 | 不自研任务队列/会话/数据库 | 宿主已有；重造只会与原生状态不一致（`audit/00-summary.md` A 类） |
| 2 | 不自研 CLI 启动器 | CodeBuddy 无头入口在非 TTY 下必崩；官方 provider 不解析本机 PATH（`audit/03` F2） |
| 3 | 不提供做不到的权限承诺 | **本项目不提供只读通道**：宿主 subagent spec 没有权限字段，做不到绝对只读就整个移除，不标假标记（`audit/12`，2026-11-11 决策） |
| 4 | 拿不到的服务/值一律 `unknown` 或报错 | 不猜、不伪造（探测结果、provider 可用性、版本） |
| 5 | 注册工具前必须产出合法 JSON Schema | 一个坏 `parameters` 能让整个 profile 所有会话 400（`audit/13`） |
| 6 | 纯逻辑层不 import 宿主包 | 保证 `node --test` 可测；宿主依赖只出现在 `src/dsh/` |
| 7 | 所有资源挂 `ctx.effect()`，dispose 幂等 | 卸载/重启不留子进程与句柄 |

## 4. 与宿主能力的对应

| 我们用的 | 宿主来源 | 说明 |
| --- | --- | --- |
| `ctx.tools.register` / `defineTool` | `@deepseek-ai/dsh-tools` | 工具注册；未注入时用等价本地编译（schema 仍合法） |
| `src/schema.js` | 本项目自带 | 配置校验（类型/默认值/枚举/必填），**零运行时依赖** |
| `ctx.subagents.getProvider` / `startActivation` | `docs/subsystems/subagent.md` | 派单执行 |
| `ctx.effect` | Cordis | 生命周期 |
| `exec.agent.session.header.cwd` | `audit/07` §4.2 | 项目根的权威来源 |
| `ctx.configEditor` / profile `cordis.patch.yml` | `@deepseek-ai/dsh-config-editor` | 配置持久化（第一版手改） |

## 5. 为什么这些不自己做

| 能力 | 官方已有 | 依据 |
| --- | --- | --- |
| 团队 / 任务 / Todo | `dsh-experimental-agent-team`、`dsh-jobs`、`dsh-tool-todo` | `audit/03` §2 |
| 会话 / 轨迹 | `dsh-session*`、`dsh-client-ui-trajectory` | 同上 |
| 权限 / 审批 / 沙箱 | `dsh-permission-presets`、`dsh-user-approval`、`dsh-sandbox*` | `audit/08` |
| 用量统计 | `dsh-token-meter` | 外部 CLI 用量单独标来源 |
| 子进程原语 | `dsh-subprocess`（PATH 解析、进程树终止、凭据擦除） | `audit/03` F3 |

我们只补三件：**角色注册表、本机 CLI 探测、派单编排**（`audit/00-summary.md` C 类）。

## 6. 协作效率机制（约定，非实现）

> 本节只指路：下面这四条是**纯提示词 / 文档约定**，不落到代码、不进配置、不是门禁，
> 也不改 `.meetingstone.json`。它与 §3 的不变量、§5 的"为什么不做"同属协作纪律，不是实现。

派单简报（目标 / 范围 / 验收标准 / 证据格式，且**不硬拒绝**）、输出（只给结论 / patch / JSON
+ 证据路径，全文写 `.meetingstone/runs`）、收口（不周期轮询，一次 `list_runs` / `get_task`
批量汇报）、失败标注（429 / 超时 / refusal / 宿主容量满 + 等待 / 换模型建议）统一写在
[协作效率规范](efficiency.md)。重复任务去重、**规则式角色路由（P1-B，显式关键词表 +
enabled/available 过滤，结果可解释）** 已作为代码级派单功能落地；AI 语义自动路由、
冷却 / 自动换模型明确不做。
