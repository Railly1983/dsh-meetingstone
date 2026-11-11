# P0-U0 证据记录（只读）

构建：DeepSeek Harness `0.2.2-rc.1`（本机安装）
`app.asar`：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`
sha256：`5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637`
大小：`213202918` bytes

## 重建命令

```powershell
node docs/audit/p0-u0-review/extract-evidence.mjs            # 全部片段
node docs/audit/p0-u0-review/extract-evidence.mjs button     # 单节
node --test tests/gui-primitives.stub.test.mjs
```

脚本只读 `app.asar`（不解包、不写宿主目录）。行号对应当前构建；升级宿主后重跑并复核。

## 关键计数（脚本输出）

```text
primitives package in node_modules: false
primitives exports: 310
absent: Icon=false Select=false Popover=false Dropdown=false IconButton=false
icons: IconUserOutlineMedium, IconUserOutlineRegular, IconUsersOutlineMedium, IconUsersOutlineRegular
```

- 共享模块表（`dsh-web-frontend/dist/assets/index-BgUyXZcc.js:1 @947141`）：
  `"@deepseek-ai/dsh-client-ui-primitives": FU`——运行时能 require，但它不是 npm 包。
- 官方规范：`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:34-35`
  ——插件样式只用 `--dsw-alias-*` token；**不要** require `dsh-client-ui-primitives`，
  应复制 primitive 的 markup/CSS/行为到插件内。
- 本机 `node_modules/@deepseek-ai` 无 `dsh-client-ui-primitives` 目录。

## 源码片段索引

| 结论 | 包/文件 | 行 |
| --- | --- | --- |
| Button `{variant,size,icon,...native}`，默认 ghost/md | bundle `index-BgUyXZcc.js` | 1 @647265 |
| Button variant 类 `primary/ghost/outline/toolbar`、size `md/sm` | `index-lh_YM6sT.css` | `_1ulci_`（单行） |
| Switch 受控 `{checked,onChange,label,disabled,title}` | bundle `index-BgUyXZcc.js` | 1 @672801 |
| Switch token：`brand-primary`/`border-l3`/`switch-thumb` | `index.css` | `_switch_1ik0f_`（单行） |
| Tooltip props 与 cloneElement(ref) | bundle `index-BgUyXZcc.js` | 1 @656451 |
| Toast `{text,holdMs=3000,onDone}` | bundle `index-BgUyXZcc.js` | 1 @793526 |
| Modal `{open,onClose,title,footer,...}` | bundle `index-BgUyXZcc.js` | 1 @684921 |
| Icon 只有 `{size,className}` + aria-hidden | bundle `index-BgUyXZcc.js` | 1 @633161 |
| header.actions 声明（list/session） | `dsh-client-ui-conversation/lib/client.js` | 22916-22957 |
| header 注册 `inject(sessionId)` | `dsh-client-ui-subagent/lib/client.js` | 1247-1272 |
| settings.section 声明（list/root） | `dsh-client-ui-settings-general/lib/client.js` | 1547-1562 |
| settings.section 注册 `inject()` | `dsh-client-ui-settings-plugins/lib/client.js` | 255-266 |
| sidebar pane 声明（keyed/session） | `dsh-client-ui-sidebar-right/lib/client.js` | 5667-5716 |
| sidebar pane `inject(sessionId, actions)` | `dsh-client-ui-sidebar-files/lib/client.js` | 2138-2142 |
| tab params/revision | `dsh-client-ui-sidebar-right/lib/client.js` | 2183-2195 |
| 读 `useTabInfo().tab.navigation.params` | `dsh-client-ui-plan/lib/client.js` | 177-182 |
| priority 档位 `extension/builtin/fallback` | `dsh-client-ui-sidebar-right/lib/client.js` | 4834-4846 |
| slot entry 崩溃日志与空位 | `dsh-client-ui-renderer/lib/client.js` | 631-645 |
| locale register/bind/fallback | `dsh-client-locale/lib/client.js` | 1675-1716 |
| token 检视表（12 个主 token） | `dsh-client-ui-theme/lib/client.js` | 1779-1877 |
| 设计平台 token 定义（warn→amber） | `dsh-client-ui-theme/lib/client.js` | 1464,1470 |

## 亲测

```text
node --test tests/gui-primitives.stub.test.mjs
# tests 5 / pass 5 / fail 0
node scripts/run-tests.mjs
# tests 426 / pass 425 / fail 0 / skipped 1
npm run verify
# exit 0（测试 + host schema + manifest + package 全通过）
```

## 限制

- 未启动真实浏览器点击，未在真机验证 Tooltip 定位、Modal 焦点、Toast 消失、Switch 视觉；
  这些由 bundle 实现与官方 CSS 推断，标“待真机核验”。
- `Button` 的 `toolbar` variant 只有 CSS 类、本机构建无调用方，是否公开待核验。
- 行号随宿主升级变化；长期以脚本重跑为准。
