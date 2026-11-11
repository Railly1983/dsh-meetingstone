# 宿主 GUI API 核验（P0-U0）

核验对象：本机 DeepSeek Harness `0.2.2-rc.1`，`app.asar` sha256 `5FA8A6B2…E637`（只读）。
方法：解 asar + 反查 `dsh-web-frontend` bundle 的共享模块表；重建命令 `node docs/audit/p0-u0-review/extract-evidence.mjs`，原始输出见 `docs/audit/p0-u0-review/evidence.md`。
**总判断**：primitives 在本机 Web bundle 里确实存在（模块表把 `@deepseek-ai/dsh-client-ui-primitives` 映射到 bundle 内 `FU`，`index-BgUyXZcc.js:1 @947141`），但 asar 的 `node_modules` **没有这个包**，且本机官方插件规范**明确禁止**第三方插件 require 它（`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`）。因此它不是稳定 API；“自己写控件 + 只用 `--dsw-alias-*` token”才是合规路径。

## 1. Button / IconButton
- 定义在 bundle 共享模块：`...index-BgUyXZcc.js:1 @647265`。`forwardRef`，props `{variant='ghost', size='md', icon, className, children, ...nativeButtonProps}`；`type="button"` 固定；`disabled/title/aria-*/onClick` 透传。
- `variant`: `primary | ghost | outline | toolbar`（CSS `_1ulci_`）；`toolbar` 有类但本机无官方使用，标“待核验”。`size`: `md`(36px) / `sm`(28px)。**无 danger variant**（危险操作靠 className 或菜单项 danger），**无 IconButton 导出**。
- 最小用法（官方）：`Button{variant:'outline',size:'sm',icon:<IconRefreshOutlineRegular size={13}/>,'aria-label':t('updateLabel'),disabled:busy,onClick,children:t('update')}`（`dsh-client-ui-plugin-manager/lib/client.js:4742-4751`）。
- 当前 header 是原生 `<button>`（`src/client/index.js:1008-1026`），且 `dsh-meetingstone-header-entry` 全仓无 CSS；按官方做法应复制宿主 button 样式，而不是把 primitives 当 API 粘进来。

## 2. Switch
- 定义：`...index-BgUyXZcc.js:1 @672801`。**受控**：`checked` + `onChange(next)`；无 `defaultChecked`；另有 `disabled`、`label`（→`aria-label`）、`title`、`className`；渲染 `role="switch"`、`aria-checked`。
- 样式 token（CSS `_switch_1ik0f_`）：开=`--dsw-alias-brand-primary`（亮色近黑/暗色近白），关=`--dsw-alias-border-l3`，滑块=`--dsw-alias-switch-thumb`，disabled `opacity:.5`。**没有黄/灰专用 token**；黄/灰请用状态语义：`--dsw-alias-state-warn-primary`（amber-500，黄）、`--dsw-alias-label-tertiary` / `--dsw-alias-state-idle-primary`（灰），或 `Tag tone="warning|quiet"`、`StateDot state="warning|idle"`。
- 与 Tooltip：Tooltip 用 `cloneElement(child,{ref})`，而 Switch 是普通函数组件、无 forwardRef，**不能** `<Tooltip><Switch/></Tooltip>`（由源码推断，待真机确认）；用 `<span>` 包一层，或直接用 `title`/`label`。官方裸 Switch 用法：`dsh-client-ui-settings-general/lib/client.js:713-726`。

## 3. Select / Dropdown（模型与思考强度）
- 导出表 310 项中**没有 `Select`、没有 `Dropdown`**。官方模型/思考强度选择器是“触发按钮 + `MenuSurface`（portal）+ `MenuGroup` + `role="menuitem"` 按钮”，见 `dsh-client-ui-model-selection/lib/client.js:1522-1569`、`:1632`；少量互斥项用 `SegmentedControl`。
- 菜单行用 `MenuItemButton`：`{children, shortcut, icon, current, disabled, disabledReason, danger, separatorBefore, onSelect}`（`...:1 @659975`）。
- 结论：不要等 Select；按上述结构自绘，或退回原生 `<select>`（会失去宿主外观）。

## 4. Tooltip / Toast / Modal / Popover
- 可用导出：`Tooltip`、`Toast`、`Modal`、`Menu`、`MenuGroup`、`MenuItemButton`、`MenuSurface`、`HoverCard`、`HoverCardGroup`、`SegmentedControl`、`SegmentedTabs`、`Input`、`Checkbox`。**无 `Popover`**；悬浮卡用 `HoverCard({anchor,content,...})`，锚定面板用 `MenuSurface` + `useAnchoredPosition`。
- Tooltip：`{label, shortcutKeys, side='right', align='center', delayMs=0, focusDelayMs=0, gap=8, disabled=false, portal=false, maxWidth, openOnClick=false, onlyWhenClipped=false, children}`；单子元素且必须可接 ref。用法见 `dsh-client-ui-plugin-manager/lib/client.js:5131-5139`。
- Toast：`{text, icon, tone, anchor, holdMs=3000, actions, onDone}`；`role="alert"`、portal 到 body、约 4s 后 `onDone`；最小 `{text,onDone}`（`dsh-client-ui-file-drag/lib/client.js:19-22`）。
- Modal：`{open, onClose, title, closeLabel, description, children, footer, className, contentClassName, onKeyDownCapture, headless=false, backdropBlur=true, shortcutModal}`；`role="dialog" aria-modal="true"`、portal、焦点/ESC/Tab 由 `useModalLayer` 托管（`...:1 @684921`）。

## 5. Icon
- **无通用 `Icon` 导出**，也**无 `users` / `users-round` 图标名**。图标是具名组件：`IconUsersOutlineRegular` / `IconUsersOutlineMedium`（双人 `users-outline`）、`IconUserOutlineRegular` / `IconUserOutlineMedium`（单人）。最接近 `users-round` 的是 `IconUsersOutlineRegular`。
- 图标 props 只有 `{size, className}`，强制 `aria-hidden="true"`；**不接收 aria-label/title**。因此“`Icon name='users'`”永远不会命中：`src/client/index.js:1001-1004` 的 `primitives.Icon` 是 undefined，实际渲染的是文字回退。
- 最小用法：`<button type="button" aria-label={label}><IconUsersOutlineRegular size={16}/></button>`；可访问名必须在外层 button 上。

## 6. 详情导航（点角色名 → 二级页面）
- **没有通用的 detail/route slot**（109 个 slot 中只有 `plugins.detail.*` / `conversation.approval.detail` 等专用扩展点，无通用二级路由；`DetailDocument` 只是 Markdown 文档渲染器）。官方通用机制是**右侧栏 tab 类型 + params**：
  - `ctx.sidebarRightTabs.register({id, kind, title, priority?})`；`ctx.sidebarRight.openTab(kind,{params:{roleId}})` 或 `tab.actions.openTab(kind,{params})`；
  - 正文 `ctx.slots.register({name:'sidebar.right.pane.tab', key:id}, Body)`，用 `useTabInfo().tab.navigation.params` 读取；同一 (kind, contentId) 再 open 会更新 params、`revision++`（`dsh-client-ui-sidebar-right/lib/client.js:2183-2195`、`:5433-5473`）。
- 若点击角色名：`tab.actions.openTab(kind,{params:{roleId}})`，正文读 `useTabInfo().tab.navigation.params` 切列表/详情；机制已证，交互待真机。不想用 tab params 时降级为**右侧栏内详情**（pane 内 state）或 `Modal`；官方没有二级路由。
- 当前 `tabs.register({...,priority:50})` 的 `priority` 应为字符串档 `extension|builtin|fallback`，数字不在契约内（`...sidebar-right:4834-4846,4905-4912`）。

## 7. scoped slot 的 inject 形状
- `settings.section`：`kind:list, scope:root`；`inject()` **无参**；组件额外得 ownerProps `{close}`；**无 sessionId**（`dsh-client-ui-settings-general/lib/client.js:1547-1559,341`）。
- `conversation.session.header.actions`：`kind:list, scope:session`；`inject(sessionId)`（官方注册只用第一个参数）；组件标准 props 含 `sessionId`、`useSession` 等；**无 params**（`dsh-client-ui-conversation/lib/client.js:22916-22957`；`dsh-client-ui-subagent/lib/client.js:1247-1272`）。
- `sidebar.right.pane.tab`：`kind:keyed, scope:session`；`inject(sessionId, actions)`；标准 props 含 `sessionId`（string）；**params 不在 inject**，只能 `useTabInfo().tab.navigation.params`（`navigation` 形如 `{address, params?, revision}`，params 为任意 JSON 对象）；`key` = tab 类型 `definition.id`（`...sidebar-right:5667-5716,5433-5459`；`dsh-client-ui-sidebar-files/lib/client.js:2138,2228-2238`）。
- 记忆：session slot 的 `sessionId` 是框架标准 props，不写 inject 也有；inject 只加额外闭包。

## 8. 主题 token
- 颜色：`--dsw-alias-*`（`label-primary/secondary/tertiary`、`bg-layer-1..4`、`border-l1..l4`、`state-*`、`button-*`、`interactive-bg-*`、`toast-*`、`tooltip-*`、`switch-thumb`、`settings-card-*`）；原始色板 `--dsw-static-*`（amber/blue/deepseek/green/neutral）只用于 artwork。
- 圆角：`--dsw-radius-xs|sm|md|lg|xl|panel`；字体：`--dsw-font-family`、`--dsw-font-xs-13`、`--dsw-font-markdown-*`；阴影/焦点：`--dsw-elevation-*`、`--dsw-focus-ring-*`。
- **没有间距 scale token**（全 asar 无 `--dsw-space/gap/spacing`）；按官方 practices 抄同类型页面的 px（设置页 gap 12/14、卡片 padding 12/14、行高 20/22）。
- 证据：`dsh-client-ui-theme/lib/client.js:1464,1470`（base/design-platform CSS）。

## 9. i18n
- `ctx.locale.register(ns,{zh,en})`（或 `(ns,'zh',dict)`）返回 disposer，须放进 `ctx.effect`；`ctx.locale.bind(ns)` → `t(key,params)`；`{name}` 插值；缺 key 回退 `en` → `common` → key；同一 namespace 重复注册同一 locale 会 throw（`dsh-client-locale/lib/client.js:1675-1716`）。
- 注册项写 `locale: NS` 即把 `t` 作为 prop 注入组件；`label: () => t('nav')` 每次投影重读，语言切换无需重注册。

## 10. slot 注册失败的表现（对照我们的 guard）
- 宿主按 entry 隔离：渲染或 inject 工厂崩溃 → `console.error("slot entry crashed in '<slot>'")`，只渲染 `<div data-slot-error="<slot>">` 空位，兄弟 entry 不受影响；single/keyed 冲突让位给下一个 survivor；装配错误（缺 provider）会 rethrow（`dsh-client-ui-renderer/lib/client.js:621-645`）。
- 尚未声明的 slot 不报错：`ctx.slots.inject(name, fn)` 等到声明出现才执行，声明折叠时自动注销并重装。
- 我们的 guard 只覆盖 `register/inject` 同步异常并写 `[meetingstone] gui module=…` 日志；**不覆盖组件渲染期崩溃**（由宿主 boundary 吞掉，只剩 `data-slot-error`）。保持数据 normalize + 组件内防御，别把“页面没炸”当成注册成功。

## 不可用项与降级建议
1. **不要 require primitives**：本机 bundle 能解析，但无包、无类型、无版本保证，且官方明令禁止；当前 `Tag`/`Icon` 应改为插件内自绘（Tag 用 span+token；图标用 16px 内联 SVG）。
2. `Icon`/`Select`/`Popover`/`Dropdown`/`IconButton`/`users(-round)` 均不存在，按 §1/§3/§4/§5 降级。
3. 详情导航无官方二级路由：首选右侧栏 tab + `params`，次选右栏内 state 或 `Modal`。
4. 修正 `sidebarRightTabs.register` 的 `priority` 为档位字符串；Switch 不要直接塞进 Tooltip。
