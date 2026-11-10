# 架构

> 只描述**当前实现**。所有与宿主打交道的地方都标注了出处，便于核验。

## 1. 分层

```
src/index.js            装配层：读 Config → 建注册表/探测/适配器/派单器 → 注册工具 → 生命周期
├── src/config.js       Config schema（Schemastery）+ 通道实例表
├── src/roles/          C1 角色注册表（纯逻辑）
│   ├── ids.js          roleId 规则、别名规范化
│   └── registry.js     全局 + 项目合并、别名冲突降级、权限只收紧
├── src/project/        项目级配置（纯解析 + IO 缓存）
│   ├── config-file.js  .meetingstone.json 解析，永不抛异常
│   └── load.js         按 mtime 缓存读取
├── src/cli/            C2 本机 CLI 探测
│   ├── probe.js        多源编排 + 版本试跑 + 缓存（纯逻辑，可注入）
│   └── resolvers.js    PATH / Appx / npm 全局 / 常见目录（IO）
├── src/dispatch/       C3 派单编排（纯逻辑 + 可注入适配器）
│   └── dispatcher.js   角色解析、只读收紧、并发纪律、失败回滚
└── src/dsh/            DSH 接线层
    ├── adapter.js      ctx.subagents 适配器（provider 查询、startActivation、parent）
    └── register.js     三个工具的注册与返回值整形
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
      2. 只读判定只允许更严
      3. adapter.canStart → ctx.subagents.getProvider(name) 真实查询
      4. **先占并发槽**（写任务串行 / 只读限流），失败回滚
      5. adapter.start({ role, task, cwd, readOnly, context, onFinish })
  → adapter.start 前置校验（任一不满足即拒，不触达宿主）
      - parent 必须来自当次 exec.agent
      - readOnly 无法强制 → READONLY_UNENFORCEABLE
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
| 3 | 权限无法强制就**拒绝启动** | 2026-11-10 的 P2 Gate 结论；"标个标记然后照跑"是假安全（`audit/12`） |
| 4 | 拿不到的服务/值一律 `unknown` 或报错 | 不猜、不伪造（探测结果、provider 可用性、版本） |
| 5 | 注册工具前必须产出合法 JSON Schema | 一个坏 `parameters` 能让整个 profile 所有会话 400（`audit/13`） |
| 6 | 纯逻辑层不 import 宿主包 | 保证 `node --test` 可测；宿主依赖只出现在 `src/dsh/` |
| 7 | 所有资源挂 `ctx.effect()`，dispose 幂等 | 卸载/重启不留子进程与句柄 |

## 4. 与宿主能力的对应

| 我们用的 | 宿主来源 | 说明 |
| --- | --- | --- |
| `ctx.tools.register` / `defineTool` | `@deepseek-ai/dsh-tools` | 工具注册；未注入时用等价本地编译（schema 仍合法） |
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
