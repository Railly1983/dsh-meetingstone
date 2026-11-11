# P0-B/C 独立复核：打回
审计日期：2026-11-11；生产代码、原测试和文档未修改；全部操作及产物位于当前工作目录。
安全基准为 docs/reference/efficiency-v1.0.md:157 的 §8；configuration.md 的 §8 实际是 Jobs，不能混淆。
证据边界：受控宿主 startActivation，实际执行 apply→工具 execute→dispatcher→adapter→run-store；不是仅拼接函数测试，也没有调用实际 CLI/provider。

## 逐项证据（命令与输出摘录）
1. `node scripts/run-tests.mjs` → exit 1，`tests 20 / pass 0 / fail 20`，测试文件 worker `spawn EPERM`。[日志](standard-tests.log)
   同进程补跑命令见 result.json.tests[2] → `tests 291 / pass 266 / fail 24 / skipped 1`；不宣称标准命令已通过。[日志](inprocess-tests.log)
   24项均涉及受限 Node/Git子进程：独立 runCommand(node --version) 返回 `{code:127,stderr:"spawn EPERM"}`；1项Windows文件名限制跳过。[证据](environment.log)
2. `node scripts/verify-host-schema.mjs` → exit 0，`PASS: 7 个工具的注册产物符合宿主 / 模型 API 契约`。[日志](schema.log)
3. 目标三测试同进程补跑（完整命令见 result.json.tests[3]）→ `37/37 pass`。[日志](targeted-tests.log)
4. `node .meetingstone/runs/p0-bc-review/probe.mjs` → exit 0，`checks:11,reproducedIssues:9`；9个复现含F6b子项。[日志](probe.log)
   结构化 dispatch 实际提示词五段位置 `[10,34,608,771,795]`，顺序为人设→简报→重放→任务→输出契约；15个字段哨兵均保留。
   JSON/纯文本/坏JSON分别经真实完成回调落盘；JSON的 summary/evidence/openIssues 等相等，自报partial与宿主completed分开；后两者summary回退原文。
   三种结果 get_task 默认均 `resultOmitted:true` 且无result；full:true/artifact全文与原文逐字相等；真实磁盘行范围正确，字节小窗口有F8。
   role+task、仅title、空scope查询接受；结构化缺title、非空scope缺acceptance、acceptance类型错误均TASKSPEC_INVALID；没有发现简单查询乱拒。

## 问题清单（均有可重跑复现）
- F1/P1：continuesFrom 优先直接返回内存终态；adapter.js:1204/1287 的终态没有 runBase。短 acceptance/scope.exclude/doNotRepeat 全丢；同一磁盘记录在新插件实例重放时完整。 定位：src/dsh/register.js:372。
- F2/P1：summarizeTaskSpec/ContextPack 的前10条及每条200字符裁剪丢弃保护字段；adapter.js:285 与 run-store.js:575 使用此结果。第250字符及第11条约束初次 prompt 有、磁盘及重启重放无。 定位：src/taskspec.js:369。
- F3/P1：校验成功却静默 slice；scope/acceptance 500字符、doNotRepeat 300字符，中间第650字符约束在首次 prompt 前就消失。 定位：src/taskspec.js:82。
- F4/P1：有 summary 分支跳过自由文本保护段提取；真实 adapter 对纯文本也生成8KiB摘要，正文中间有验收/权限/安全标题仍从 get_task 默认结果消失。full:true 原文完整。 定位：src/dsh/register.js:314。
- F5/P1：保护段只识别行首白名单；中间“注意：…不得写盘；必须验收…”在36,094字节文本重放中丢失，违背 §8 无丢失承诺。 定位：src/context-replay.js:34。
- F6/P1：选第一个含已知键候选，正文示例 completed 覆盖末尾真实 blocked，真实 openIssues 被清空；114行只扫描前三个裸对象，第四个最终结果不解析。 定位：src/result-contract.js:118。
- F7/测试缺口：手工顶层 acceptance/permissions/safetyPolicy 绕过真实落盘白名单；172行又没有 summary，绕过真实完成路径。result-contract.test.mjs:183 直接注入简报写盘；taskspec.test.mjs:236 只验 prompt。删掉 adapter 落盘简报后37/37仍绿，独立实际派单证实数据全丢。未发现可证实的蓄意造假。 定位：tests/token-output.test.mjs:119。
- F8/P2：artifact 小字节窗口未约束截断标记，headBytes=8/tailBytes=6 实返34字节且头部丢失；register.js:863直接调用。现有 artifact 测试仅40+20窗口，未覆盖小预算。 定位：src/run-store.js:167。

## 变异与测试可信度
`mutant/src/dsh/adapter.js:285` 将 buildRunBase 的 taskSpec/contextPack 设为null；只改复制目录，生产文件不动。
复制三测试运行命令见 result.json.tests[5] → `37/37 pass; MUTANT SURVIVED`。[日志](mutant-tests.log)
`node .meetingstone/runs/p0-bc-review/mutation-witness.mjs` → exit 0，真实派单prompt含验收，终态磁盘两个简报均null。[证据](mutation-witness.json)
因此“现有测试全绿”不能证明简报持久化及跨任务保护有效。没有证据认定蓄意造假；已证明的是手工fixture与弱断言掩盖真实路径。
长文变异：第250字符/第11条在初次prompt中存在，落盘及重启重放消失；第650字符在校验阶段消失。
正文中间的验收/权限/安全标题：真实纯文本完成后默认查询遗漏，full:true保留；非标题形式约束在重放中丢失。
末尾blocked契约前加入completed示例：实际记录resultStatus=completed、openIssues=[]；前三个无关裸对象之后的最终JSON也不解析。

## 未验证与交付
- 未验证：实际 DSH/CLI/provider 与官方 defineTool 运行时；本次宿主边界使用受控 startActivation stub，执行真实仓库装配/派单/解析/存储实现，没有启动模型子Agent。
- 未验证：正常隔离测试命令的291全绿、受限子进程/Git相关24项；Windows不合法文件名测试1项按原条件跳过。
- git diff/status 最终为空；changedFiles=[] 指生产/原测试变更，新增内容全部是忽略目录内审计产物（含变异副本）。
- 修复优先级：先关闭F1–F6，再补真实链路回归杀死变异；修复F8后在允许子进程环境补跑标准门禁。
- [结构化完整结果](result.json)；[数据变异明细](probe-results.json)；[源码SHA256](source-manifest.json)。
