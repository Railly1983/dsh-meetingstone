## 这个 PR 做了什么

<!-- 一句话说清。修 bug 请写"为什么坏、怎么证明好了"。 -->

## 类型

- [ ] feat（新能力）
- [ ] fix（修 bug）
- [ ] docs / test / chore

## 自查（按 docs/CLEAN_ROOM.md 与 docs/architecture.md 的不变量）

- [ ] `npm run verify` 全绿（测试 + 工具 schema 契约 + manifest + 发布包）
- [ ] 没有复制 CLIWorker 的任何实现（clean-room）
- [ ] 没有自研任务队列 / 会话 / 数据库；没有自研 CLI 启动器
- [ ] 权限无法强制的路径**拒绝启动**，没有"标个标记然后照跑"
- [ ] 拿不到的值返回 `unknown` / 明确错误，没有伪造
- [ ] 新增的宿主 API 调用在代码注释里标了出处（文档路径或 commit）
- [ ] 如果改了工具参数/输出 schema：`verify-host-schema.mjs` 已跑过

## 证据

<!-- 命令 + 关键输出；修 bug 请附复现步骤与修复后的对照 -->
