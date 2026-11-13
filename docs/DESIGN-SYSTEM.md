# 前端设计规范

前端（`apps/web`）的设计 token、配色规则、组件清单、各状态的样式，以及写页面时要遵守的约定（HTTP 契约、query key、快捷键、CSS layer）。实现与评审都以本文为依据；信息架构、布局与交互以定稿原型 `docs/prototype/frontend-v2.html` 为准，原型里的演示数据不是规格。相关决定：ADR 0005（E2E 优先）、0006（SPA）、0007（HTTP 契约用 zod）、0008（shadcn/ui + Base UI）。

定位：内网专业工具，只做深色主题、只支持桌面（最小宽度 1280；运行监控页窄到 1024 仍可用，顶栏按钮收成图标）、界面只用中文。

与定稿原型不同、以本文为准的交互：取消运行的确认弹窗列出影响后直接确认，不要求输入运行编号（只做测试的平台，取消可以用相同参数再跑一次；2026-11 设计评审决定）。

## 1. 代码布局

| 位置 | 内容 | 规则 |
|---|---|---|
| `src/styles/tokens.css` | 三层设计 token | 只有这里写色值 |
| `src/styles/app.css` | 样式入口：CSS layer 顺序、Tailwind 主题映射、元素基础样式 | 新样式不要加在这里，写在组件的 Tailwind 类里 |
| `src/components/ui/*` | shadcn/ui（base-nova，Base UI 原语）拉取后按本规范改写的基础组件 | 归我们维护，不跟随上游；内部用 `@/` 别名（CLI 生成） |
| `src/components/*` | 应用级组件：外壳、状态、页面版式、反馈、快捷键 | 应用代码用 `#/` 别名 |
| `src/routes/_shell/*` | 带外壳（侧边栏 + 顶栏）的页面 | 全屏页（编排画布、运行监控）放在 `src/routes/` 下、不进 `_shell` |
| `src/lib/api.ts` | 契约调用 `callApi` / `apiQuery` | 见第 8 节 |
| `src/lib/shortcuts.ts` | 快捷键注册表（纯逻辑，有单测） | 见第 7 节 |

拉取新的 shadcn 组件：在 `apps/web` 下运行 `pnpm dlx shadcn@4.23.0 add <组件>`（配置在 `components.json`），然后**立刻按本规范改写**：把 `bg-popover`、`ring-foreground/10`、`shadow-md`、`text-base` 等换成下面的 token 与字号，去掉 `"use client"`，关闭按钮的 `sr-only` 文案改成 `aria-label="关闭"`，跑 `pnpm format`。缺少的组件（数字输入等）按同样风格自己写在 `components/ui/`。

## 2. 设计 token（三层）

组件**只引用第 2、3 层**。第 1 层不生成工具类；Tailwind 默认色板、字号、圆角、阴影已在 `app.css` 清空，写 `bg-red-500`、`text-xl`、`rounded-2xl` 不会生成样式。

### 2.1 基础色阶 `--base-*`

炭灰无色偏：`--base-gray-950 #141414` … `--base-gray-50 #f2f2f2`，另有 `--base-cyan-*`、`--base-green-400`、`--base-amber-*`、`--base-red-*`、`--base-violet-*`。只在 `tokens.css` 里被第 2、3 层引用。

### 2.2 语义层（工具类名 = 变量名去掉 `--`）

| 类别 | token（Tailwind 类） | 用途 |
|---|---|---|
| 表面 | `sunk` < `bg` < `surface` < `raised` < `raised-2` | 输入框 / 页面 / 面板与侧栏 / 按钮与菜单 / 悬停与选中 |
| | `inset` | 面板里的井（图表卡、代码块、日志区），等于 `sunk`；`bg` 只做页面底色 |
| | `track`、`scrim` | 槽位条与进度条的空槽；弹窗遮罩 |
| 描边 | `border`、`border-soft`、`border-strong` | 面板与分隔 / 面板内分隔 / 浮层；有意安静 |
| | `border-control` | 表单控件（输入框、下拉、勾选框、开关、分段）的边界：在 `sunk`、`surface`、`raised` 上都 ≥ 3:1 |
| 文字 | `fg-1`、`fg-2`、`fg-3` | 正文 / 次要 / 辅助（对 `bg`、`surface`、`raised`、`raised-2` 都 ≥ 4.5:1；不再叠加不透明度） |
| 主操作 | `primary`、`primary-hover`、`primary-foreground` | 白色按钮 |
| 信号（青） | `signal`、`signal-fg`、`signal-line`、`signal-soft` | 执行中、键盘焦点环（`ring`）、调度连线；`signal-soft`（淡底）与 `signal-line`（描边）用于执行中的区段，见 2.4 |
| 选中 | `selected`、`selected-bg`、`selected-ring`、`selection-bg` | 中性高亮；`selection-bg` 是文字选区（`::selection`，不用青色） |
| 状态 | `ok`、`warn`(`-fg`)、`danger`(`-fg`)、`signal`(`-fg`)；`pending`、`skipped`、`cancelled`、`stopped` | 不带 `-fg` 的给标记、描边与色块，状态文字用 `-fg`（成功的绿本身够亮）。见 6.1 |
| | `-line`、`-soft` | 描边（在 `surface` 上 ≥ 3:1）；带文字的淡底（≈ 1.15:1，`signal-soft` 是执行中的淡底，故意强一档 1.3:1） |
| | `ok-fill`、`warn-fill`、`danger-fill`、`signal-fill`、`stopped-fill`、`pending-fill` | 状态面积色：进度段、缩略图节点、时间线区段、趋势柱、小地图只用这一组，每种状态一档，不另写 `bg-ok/50` 这样的透明度 |
| 日志 | `log-debug`、`log-info`、`log-warn`、`log-error` | INFO 不上色 |
| 图表 | `chart-1` … `chart-4`、`chart-grid` | 多序列线色（中性灰与灰蓝，按序使用）、网格线；状态色只用于节点状态 |
| 阴影 | `shadow-float`、`shadow-pop`、`shadow-inset-top` | 悬浮控件 / 弹窗、菜单 / 可滚动区域顶部的内阴影 |
| 动效 | `--motion-fast` 100ms、`--motion-base` 150ms、`--motion-slow` 200ms；`--motion-ease-out`（`ease-out`、`ease-standard`）、`--motion-ease-in`（`ease-in`）；`--pulse-period` | 见第 11 节；`transition-*` 不写时长与缓动时默认就是 base + ease-out |
| 滚动条 | `--scrollbar-thumb`、`--scrollbar-track` | `:root` 的 `scrollbar-color`；不设 `scrollbar-width` |

shadcn 组件用的 `background`、`foreground`、`popover`、`muted`、`accent`、`destructive`、`input`、`ring` 等名称映射到语义层；**注意 shadcn 的 `accent` 是中性悬停色，不是青色**，新代码直接用我们的名字。

透明变体（`-line`、`-soft`、`-fill`、网格线、遮罩）用 `color-mix(in srgb, var(<基础色>) N%, transparent)` 从同一个颜色派生，不抄写数值；`design-rules.test.ts` 直接从 `tokens.css` 算这些 token 叠在表面上的对比度。

`tokens.css` 末尾有 `@media (prefers-contrast: more)` 加强档：描边三级、控件边界、辅助文字、网格、连线、端口、选中外圈与滚动条滑块各加强一档，组件不用改。

工具类（`app.css` 的 `@utility`）：`selected-row`（`selected-bg` 底 + 左侧 2px 白条，表格、目录、列表的选中项都用它）、`focus-glow`（输入框聚焦光晕）、`pulse-ring`（执行中的脉冲，见 6.1）。

### 2.3 画布专用 `--canvas-*`

`canvas-bg`、`canvas-grid`、`canvas-node-bg` / `-border` / `-selected`、`canvas-port`、`canvas-edge` / `-selected` / `-live` / `-dispatch`、`canvas-subflow` / `-fg` / `-line` / `-soft`、`canvas-run-running` / `-failed` / `-cancelled` / `-stopped` / `-done-bg` / `-done-border`（已完成的节点下沉，不降文字对比度）、`--canvas-minimap-mask`（小地图视口外遮罩）。画布组件（#35 起）只用这一层和语义层。节点几何常量（卡片宽高、端口位置）由 #35 收敛为单一来源。

### 2.4 配色规则

- **白色是每屏唯一的主操作**：`<Button variant="primary">` 每屏最多一个（如「新建场景」）；其余按钮用默认（中性）或 `ghost`。Logo 与头像的白底不是操作。
- **青色只用于执行中、键盘焦点环、调度连线**。不要用青色表示选中、链接或强调。
- **执行中的区段是淡底加描边，不是实心青色**：时间线段、链路进度段、场景缩略图节点、平台图表里的节点耗时条按状态表画（`STATUS.running.area`：`signal-fill` 底加 1px `signal-line` 描边），与成功、失败等色块同一量级。实心 `signal` 只给状态标记、时间线段尾的脉冲头和焦点环。
- **选中是中性高亮**：`selected-bg` 底 + 左侧 2px 白色短条（工具类 `selected-row`），画布上是 `selected` 描边 + `selected-ring`，相关连线灰色虚线流动。文字选区是中性的 `selection-bg`。
- 绿色 = 成功，红色 = 失败，**琥珀色只有三个意思：等待中（定时 / Sleep）、警告、安装中**。排队中（在等 Agent 的槽位）是中性灰；日志定位标记线、被标记的日志行、节点的 `always` 标签这类不是警告的东西也不用琥珀（用中性的 `selected`）。
- 状态文字用 `-fg`：`text-warn-fg`、`text-signal-fg`、`text-danger-fg`；不带 `-fg` 的 `text-warn` / `text-signal` 只用于图标与标记（currentColor 着色）。
- **没有信号就不着色**：数值为 0 的统计、全零的趋势线用中性色；「运行中」统计前的执行中状态点只在有运行时出现。必填标记（`*`）用中性 `fg-2`，红色只给错误。保存状态里只有需要处理的才带点（保存被拦截红、未保存琥珀），「已保存」是纯文字。
- **已停止**用中性灰实心小方块（画布卡片灰色描边、进度条与时间线灰色带描边的矮段），与已取消、已跳过区分：停止是场景的正常流程，不用警示色。
- **紫色只用于子流程区域**（`canvas-subflow*`），语义层没有紫色。
- **日志 INFO 不上色**（`log-info` = 正文色），只有 WARN / ERROR 着色，DEBUG 用辅助文字色。
- 阴影带偏移和模糊，不用零偏移的彩色发光。

## 3. 字体、字号、圆角、尺寸

- 字体随前端打包（`@fontsource`，`src/styles/fonts.css`，按字重整包导入，每个子集带 `unicode-range`，只下载用到的拉丁子集）：IBM Plex Sans（400/500/600）界面文字；JetBrains Mono 用于数值、ID、版本号、命令（`font-mono`）。不依赖外网。
- 两套字体栈都写明中文黑体（苹方、HarmonyOS Sans、Noto Sans CJK / 思源黑体、微软雅黑 UI、微软雅黑）：中文是全角，不需要等宽中文；等宽栈落到通用族 `monospace` 时 Windows 会挑新宋体。
- 等宽字关掉编程连字（`--font-mono--font-feature-settings` 与 base 层的 `code, kbd, pre, samp`）：文档里的 `>=`、`!=`、`->` 和日志照原样显示，看到的就是复制出来的。
- 中文的层级不靠 500（微软雅黑只有 400 与 700）：要比旁边醒目，用颜色台阶或 600。
- 数字一律等宽：`body` 设了 `tabular-nums`；`body` 行高 `calc(20 / 13)`，13px 时正好 20px。
- 字号只有这几档（`text-*`）：

| 类 | 字号 / 行高 | 用途 |
|---|---|---|
| `text-2xs` | 11 / 16 | 最小字号：只给数字、拉丁字母与 kbd（计数、刻度、ID、按键）；有中文就用 `text-xs` |
| `text-xs` | 12 / 18 | 辅助：表头、说明、次要信息、表格里的等宽数据、徽标；中文的最小字号 |
| `text-sm` | 13 / 20 | 正文（body 默认）、按钮、输入框、菜单项 |
| `text-base` | 14 / 20 | 区块与弹窗标题、空状态标题、命令面板输入 |
| `text-lg` | 16 / 24 | 页面标题 |
| `text-2xl` | 22 / 28 | 统计数字（控制台） |

  字号 token 用 rem（默认根字号 16px 下就是上表的像素值）：用户调大浏览器默认字号时文字与间距一起放大。不在 `html` 上设字号。

  原型里的非整档字号归并：12.5 → 13（正文、菜单、面包屑）、11.5 → 12（徽标、提示、字段说明）、10 → 11；15（弹窗标题）→ 14。
- 圆角只有 `rounded-sm` 4、`rounded-md` 6、`rounded-lg` 8、`rounded-xl` 12（另有 `rounded-full`）。小于 12px 的指示元素（槽位格、进度段）用 2px。组件里不写色值、不用其他圆角任意值（`src/styles/design-rules.test.ts` 检查）。
- 控件高度：按钮 / 输入框 30（`h-7.5`），小号 26（`h-6.5`）；顶栏 48（`--topbar-height`）；侧栏 208 / 折叠 56；kbd 18。
- 图标（lucide）：根部的 `LucideProvider` 统一线宽为屏幕上的 1.5px（`nonScalingStroke`），不随图标尺寸变粗变细；图标尺寸只用 12 / 14 / 16（`size-3`、`size-3.5`、`size-4`）。勾选框的对勾加粗到 2px。

## 4. CSS layer

`app.css` 声明 `@layer theme, base, vendor, components, utilities;`，所有样式都在这些层里，后面的层优先，与选择器权重无关：

- `theme`：Tailwind 主题变量与 `tokens.css`；`base`：preflight、字体、元素基础样式；
- `vendor`：第三方样式（xyflow；sonner 运行时注入的样式由 `vite.config.ts` 的插件包进这一层）；
- `components`：全局焦点环（第三方样式会写 `outline: none`，焦点环要压过 vendor 层）、强制颜色模式的降级（见 6.2），以及确实需要的组件级 CSS（尽量不用）；`utilities`：Tailwind 工具类——组件样式都在这里，所以低层的全局规则覆盖不了组件。

端到端测试会检查页面上没有未分层的样式规则（`e2e/shell.spec.ts`）。例外：CodeMirror（`ReferenceEditor`）在运行时注入自己的样式表，不在任何层里；它只作用于编辑器内部的 `.cm-*` 元素，编辑器内部的样式写在组件的 `EditorView.theme` 里（只引用 token），外框照常用 Tailwind 类。不写按页面的全局样式文件（MVP 时期的 `.sf-*` 样式与 `legacy` 层已在 #44 删除）。

## 5. 组件清单

### 基础组件 `components/ui`

| 组件 | 说明 |
|---|---|
| `Button` | `variant`: `default`（中性）/ `primary`（白色主操作）/ `ghost` / `danger` / `danger-solid`（红底深色字，悬停 `danger-fg` 底）/ `link`；`size`: `default` 30px / `sm` 26px / `icon` / `icon-sm`（图标按钮必须有 `aria-label`）；悬停亮一档、按下深一档（中性按下 `surface`，ghost 按下 `raised-2`，白色按下 `selected`，红色按下回到 `danger`），不用缩放；禁用 40% 不透明 |
| `Input` | `sunk` 底、`border-control` 描边，聚焦时青色描边 + `focus-glow` 光晕（强制颜色模式下另有透明轮廓兜底，`focus:outline-hidden`），`aria-invalid` 时红色描边 |
| `Textarea`、`NativeSelect` | 多行输入、原生下拉选择，外观与 `Input` 一致 |
| `Checkbox` | 勾选框：原生 `input`，16px、`sunk` 底、`border-control` 描边；勾选后中性高亮（`selected` 底 + 深色对勾），不用青色 |
| `Switch` | 开关：30 × 18、`border-control` 描边；关闭 `track` 底 + 灰色圆点，打开 `selected` 底 + 深色圆点（与勾选框一致，不用绿色）；强制颜色模式下用系统颜色画 |
| `Segmented` | 分段选择（筛选、视图切换）：`fieldset` + `aria-pressed` 按钮，`border-control` 描边，当前项中性高亮（`raised-2` 底加一圈 `border-strong` 内描边）；只有图标的选项给 `label` |
| `Badge` | `default` / `ok` / `warn` / `danger`；版本号、计数等（12px） |
| `Dialog` | 模态弹窗：锁定焦点、Esc 与点遮罩关闭、关闭后焦点回到打开前的元素；距顶 12vh、宽 520（`className` 覆盖） |
| `Sheet` | 抽屉（右侧，默认 460px），焦点行为同 Dialog |
| `DropdownMenu` | 菜单（Base UI Menu） |
| `ContextMenu` | 右键菜单（Base UI Menu，没有 Trigger）：使用方给出 `open` 与 `anchor`（屏幕坐标或元素）；`ContextMenuItem` 的 `shortcut` 从快捷键注册表取按键与名称，`disabledReason` 禁用并写明原因；关闭后焦点回到打开前的元素。画布上经 `FlowCanvas` 的 `menu` 使用 |
| `Command` / `CommandDialog` | 命令面板（cmdk + Dialog） |
| `Tooltip` | 悬浮提示（根部已有 `TooltipProvider`，延迟 400ms） |
| `Table` 系列 | 表头 12px 三级文字；行悬停 3% 白；`data-state="selected"` 为中性选中 |
| `Kbd`、`Skeleton`、`Separator`、`Toaster` | 按键、骨架、分隔线、通知容器 |

### 应用组件 `components/`

| 组件 | 说明 |
|---|---|
| `app-shell/AppShell` | 外壳：侧边栏（导航来自 `navigation.ts`，可折叠，状态存 localStorage；项右侧平时是计数，悬停或键盘聚焦时在同一位置换成跳转快捷键 `Keys`，折叠后不显示）、顶栏（面包屑来自路由 `staticData.crumb`、Ctrl K 搜索入口、昵称） |
| `app-shell/overlays` | 全局浮层：命令面板、快捷键面板、昵称弹窗、运行抽屉、通知；`useOverlays().open("shortcuts")`、`useOverlays().runScenario(场景)` |
| `app-shell/CommandPalette` | 「当前页面」「跳转」「场景」「运行」（最近的运行）「运行场景」（打开运行抽屉）「命令」六组。「当前页面」是当前页面已绑定、并在注册表里带 `palette` 的快捷键（取消运行、保存……），名称与按键取自注册表，页面状态变了（运行结束、没有失败节点）就自动出现或消失，为空时整组不渲染；其余命令加在 `commands` 里 |
| `page`：`Page`、`PageHeader`、`Panel`、`SectionHeading`、`Keys`、`CodeBlock` | 页面版式；`Keys keys="Ctrl+K"` 显示按键；`CodeBlock` 带复制 |
| `#/docs/Markdown` | 用户文档（ADR 0013）的 Markdown 渲染：代码块用 `CodeBlock`（```prompt 代码块是给人读、复制给 AI 编程助手的提示词，自动换行、正文字体；其余代码块不换行），表格用 `ui/table`，`<slug>.md` 链接换成文档页 |
| `status`：`STATUS`、`StatusPill`、`StatusDot`、`SlotBar`、`runStatusView`、`nodeStatusView`、`alignPulses` | 状态语法与槽位，见 6.1；运行 / 链 / 节点状态的种类与文字只从 `runStatusView`（含「取消中」）与 `nodeStatusView` 取，颜色、形状、动效只从 `STATUS` 取，不另写映射表。节点状态在各处的显示规则（种类、画布运行状态、时间线、是否算已完成）集中在 `src/lib/node-status.ts` 的 `NODE_STATUS` 一张表里，新增节点状态只改这张表 |
| `chain-progress`：`ChainBar`、`ChainBars` | 各链进度条（`ticks` / `wide` 两种形状；每段的颜色、描边与高低取自 `STATUS[kind].area`） |
| `sparkline`：`Sparkline` | 迷你趋势（控制台统计卡、主指标） |
| `ResizeHandle`、`PanelWidthHandle` | 区块边缘的拖动条：拖动调整高度或宽度，可聚焦，方向键每次 16px，双击或 Enter 恢复默认。`PanelWidthHandle` 是右侧面板（检查器、运行抽屉）左边缘的调宽条：宽度存 localStorage，所有场景共用，下限是面板的默认宽度（检查器 372px、运行抽屉 460px），上限视口宽度的 60%；面板用 `usePanelWidth(min)` 取宽度（`lib/panel-width`） |
| `data-table`：`DataTable`、`dataColumns` | 数据表格：行与表头模型用 TanStack Table，外观沿用 `ui/table`；列表页的表格都用它；行的属性（点击、样式、`data-*` 标记）由 `rowProps` 给出 |
| `list-navigation`：`useListNavigation`、`focusFirstListItem` | 列表页的行导航，见第 7 节 |
| `feedback/states`：`EmptyState`、`TableSkeleton`、`ErrorState`、`QueryView` | 空 / 加载 / 错误；`QueryView` 把查询的四种状态接上 |
| `feedback/notify` | `notify.success / info / warning / error` |
| `shortcuts`：`useShortcut`、`ShortcutsDialog` | 见第 7 节 |
| `#/editor/inspector/ReferenceEditor`：`ReferenceEditor`、`InsertReferenceButton` | 可以写引用的文本输入框（CodeMirror 6 内核，只引入 `@codemirror/state`、`view`、`commands`）：输入 `$` 或点「插入引用」弹出补全，引用高亮成一块、整块删除，1 到 8 行自动增高；外观与 `Input` 一致。能写引用的字段都用它，不另写一套；`choices` 传 `null` 时是不能写引用的多行输入框（入口参数的默认值）。`$` 触发的补全不预选，方向键或鼠标选中后 `Enter` / `Tab` 才插入 |
| `#/editor/inspector/ReferencePicker`：`ReferencePicker`、`ReferenceChip` | 非字符串参数（数字、布尔、枚举、JSON）：「插入引用」按钮选一个引用作为整个值；值是整值引用时用引用标签代替类型控件，点 × 回到类型控件。没有「常量 / 引用」切换，显示什么由值决定 |
| `#/editor/inspector/ZoomEditor`：`ZoomEditor`、`ReferenceActions` | 字符串、JSON 字段的「放大编辑」：`Dialog` 里放大的 `ReferenceEditor`（等宽、补全、高亮）；修改直接走字段的 `onChange`，没有「保存 / 放弃」。能写引用的文本字段右侧的「插入引用」+「放大编辑」两个按钮用 `ReferenceActions`，不另写 |

## 6. 各状态的样式

### 6.1 状态语法（`components/status.tsx` 的 `STATUS`）

状态的颜色、形状、动效都在 `STATUS: Record<StatusKind, StatusLook>` 一张表里：`tone`（标记、描边、色块的颜色）、`text`（状态文字的颜色）、`mark`（8px 标记的形状）、`area`（有面积的色块：`tall` 满高还是矮一档、HTML 的 `box` 类、SVG 的 `svg` 类）、`pulse`（能否脉冲）。`StatusDot`、`StatusPill`、`ChainBar`、`ScenarioThumbnail` 只读这张表；其他要画状态的地方（时间线区段、小地图、趋势柱）也从这里取，不另写颜色。

| kind | 用于 | 标记（8px） | 文字 | 面积色块 |
|---|---|---|---|---|
| `ok` | 成功、在线 | 绿色实心圆点 | `ok` | 矮；`ok-fill` |
| `running` | 执行中、准备中、发送中 | 青色圆点加外圈 | `signal-fg` | **满高**；`signal-fill` 底 + `signal-line` 描边 |
| `failed` | 失败 | 红色实心菱形 | `danger-fg` | **满高**；实心 `danger-fill` |
| `warn` | 等待中（定时 / Sleep）、警告、安装中 | 琥珀实心三角 | `warn-fg` | **满高**；`warn-fill` 底 + `warn-line` 描边 |
| `pending` | 待执行、离线 | 灰色空心圈 | `fg-3` | 矮；空槽 `pending-fill` |
| `queued` | 排队中（在等 Agent 的槽位）、通知排队中 | 灰色半实心圈 | `fg-3` | 矮；空槽加灰色斜纹（SVG 里是空槽加灰色描边） |
| `skipped` | 已跳过 | 灰色斜杠圈 | `fg-3` | 矮；空心，`border-strong` 描边 |
| `cancelled` | 已取消、取消中 | 灰色虚线圈 | `cancelled` | 矮；空心，`cancelled` 虚线描边 |
| `stopped` | 已停止（子流程被停止子流程节点停止，不算失败） | 灰色实心方块 | `stopped` | 矮；`stopped-fill` 底 + `stopped` 描边 |

规则：

- **形状**：每种状态一个标记，用 currentColor 画在 8 × 8 的 SVG 里。红绿色觉缺陷时靠形状分辨；强制颜色模式下颜色换成系统文字色，形状照样在；「减少动效」时执行中没有脉冲，靠外圈与成功区分。
- **面积色块**：需要处理或正在发生的状态（执行中、失败、等待）满高，其余矮一档（链路进度 `ticks` 12 / 8px，`wide` 8 / 5px，缩略图节点上下各收进 1/8）。红色盲看来失败的红和成功的绿几乎同色，靠高度分开；形状相同的两种状态在正常视力与三种色觉缺陷模拟下色差都 ≥ 10（OKLab ΔE，`design-rules.test.ts` 检查）。
- **面积色只有 `-fill` 一档**：同一个状态在进度条、缩略图、时间线、趋势柱、小地图里深浅一样。
- **脉冲**：状态点默认静止。一屏内每个执行中的对象只在一处脉冲，取它的前沿：运行监控是时间线上执行中区段的段尾脉冲头（每个执行中节点一个），外加顶栏的运行状态标签作为页面级的一处；列表页是每个执行中运行的状态标签；时间线行标签、链路标签、切换运行按钮、图表分组头、「实时跟随」都不脉冲（「实时跟随」是视图状态，不是执行状态）。调用方用 `<StatusDot pulse>` / `<StatusPill pulse>` 打开（只对执行中生效）；不是状态点的元素（时间线段尾的脉冲头）加工具类 `pulse-ring`，它在元素自己的 `::after` 上画一圈当前色的光环，所以脉冲头要是真实元素，不能是伪元素。脉冲只动 `scale` 与 `opacity`，周期 `--pulse-period`，入口调用的 `alignPulses` 让新出现的脉冲对齐到同一相位。
- 状态文字的颜色在所有表面上 ≥ 4.5:1，标记与色块的颜色 ≥ 3:1（`design-rules.test.ts` 检查）。

**时间线区段**（`monitor/Timeline`）按同一套规则画，段的种类对应状态：完成 → `ok`、执行中 → `running`、失败的尝试 → `failed`、等待节点 → `warn`、排队等待 Agent → `queued`、已取消 → `cancelled`、已停止 → `stopped`，用 `STATUS[kind].area.box` 与 `tall`：

- 轨道 12px；矮段在轨道里垂直居中 6px（用 `clip-path: inset()` 或内层元素只改可见高度，点击与悬停的热区保持满高）。
- 完成是矮的 `ok-fill`；失败的尝试是满高实心红；两者相邻时在任何色觉下都靠高度分开。
- 执行中满高，段尾加一个真实元素的脉冲头（实心 `signal`，`pulse-ring`），是监控页唯一按节点脉冲的地方。
- 已取消是矮的空心虚线框（不再是斜纹）；排队是矮的灰色斜纹；等待是满高的琥珀底加描边，三者形状互不相同。
- 图例按同样的形状画。时间线轨道与图例色块加 `data-viz`（见 6.2）。

### 6.2 强制颜色与高对比度

- **强制颜色模式**（Windows 高对比度）：浏览器换掉作者的颜色、去掉 `box-shadow` 与渐变。状态标记是 currentColor 画的 SVG，不用处理。`app.css` 的 components 层集中补其余的：`aria-current="page"`、`aria-pressed="true"`、`data-state="selected"`、`selected-row` 换成 2px `Highlight` 内描边；数据图形（链路进度、缩略图、槽位条、时间线轨道与图例）加 `data-viz`，保留作者颜色并垫一块 `bg` 底（`forced-color-adjust: none` 只给这些颜色本身就是信息的地方）。开关用系统颜色画（`switch.tsx`）；输入框的焦点由 `focus:outline-hidden` 的透明轮廓在强制颜色下显示出来。新组件不要只靠底色或阴影表达状态。
- **更高对比度**（`prefers-contrast: more`）：`tokens.css` 末尾的加强档，见第 2 节。

### 6.3 空、加载、错误、禁用

- **空**：`EmptyState`——图标方块、14px 标题、说明（最宽 40em，居中）、下一步操作（按钮或 `CodeBlock` 命令示例），放在 `Panel` 里。
- **加载**：`TableSkeleton`（按表格列数画骨架，`role=status` 名称「加载中」）；首次加载才显示，后台刷新不闪。
- **错误**：`ErrorState`——红色描边块，标题「无法加载 …」、原因、一行错误详情（`GET /api/agents → 503 code`）、「重试」与「复制错误详情」（含 details）。已有数据时后台刷新失败不替换页面。查询默认失败后再重试 2 次（间隔 1 秒），4xx 不重试（`src/router.tsx`）。
- **禁用**：40% 不透明、`cursor-not-allowed`，不换颜色。
- **通知**：右下角，不盖住页面顶栏；成功 / 信息 2.6 秒、警告 5.2 秒后消失。运行失败这类需要立刻注意的信息不用通知，用页内横幅。

## 7. 键盘、焦点与快捷键

- 焦点环统一是 2px 青色外框（`:focus-visible`，在 `components` 层，第三方库的样式去不掉它），组件不要用 `outline-none` 去掉它（输入框改用青色描边 + 光晕，并用 `focus:outline-hidden` 给强制颜色模式留轮廓）。所有元素平时的 `outline-color` 就是焦点色（base 层），所以带 `transition-colors` 的元素聚焦时焦点环也是即时出现、不会先灰后青。
- 画布节点卡片的焦点环 `outline-offset` 是 3px：读作「框在卡片外面」，与执行中节点的青色描边区分开。
- 编排画布只有一个 Tab 停靠点：画布区域。进入后方向键沿链选中节点，焦点跟着移到节点卡片上；Esc 取消选中、焦点回到画布区域。节点卡片与连线都不进 Tab 顺序（React Flow 的 `nodesFocusable` / `edgesFocusable` 关闭）。顶栏控件在 DOM 里排在画布之前，工具条与检查器在画布之后。
- 弹窗与抽屉用 `Dialog` / `Sheet`：锁定焦点、Esc 关闭、关闭后焦点回到原处；自己写的浮层也必须满足，并加端到端测试。
- **快捷键注册表** `src/lib/shortcuts.ts` 的 `SHORTCUTS` 是唯一来源：快捷键面板（?）从它生成，页面用 `useShortcut(id, handler, enabled)` 绑定（`enabled` 为 false 时不绑定，键不被拦截）。新增快捷键先登记（分组「全局 / 编排画布 / 运行监控 / 列表页」、名称、按键、是否允许在输入框或弹窗中触发），再绑定；没有绑定的不要登记。写法：`Ctrl+K`（同时按）、`G D`（1 秒内依次按）；Ctrl 同时匹配 ⌘；默认焦点在输入框里或有弹窗打开时不触发。
- 不同页面分组（编排画布、运行监控、列表页）可以登记同一个键（画布与监控页的 `E`、`R`，画布与列表页的 `/`），因为它们属于互斥的路由：按键只匹配当前已绑定处理函数的那一个。「全局」的键不能与任何分组重复，同一分组内也不能重复（`shortcuts.test.ts` 检查）。
- **列表页行导航**（分组「列表页」）：场景列表（卡片与表格视图）、运行记录（进行中的卡片与历史表格）、节点包列表是「列表页」。`J` / `K` 把真实的键盘焦点移到下一项 / 上一项的主链接上（Enter 走链接本来的行为，不循环；焦点不在任何一项里时 J 去第一项、K 去最后一项），`/` 聚焦并选中搜索框的文字，搜索框里按 ↓ 进入第一项。实现基于 DOM、不保存状态：每项容器写 `data-list-item`、主链接写 `data-list-primary`，页面调用一次 `useListNavigation()`；搜索框用 `useSearchInput`（返回 `ref` 与 `onKeyDown`，`/` 与 ↓ 在里面接好）。焦点环就是全局的键盘焦点环；所在的行或卡片另加与悬停相同的中性强调（表格行 `has-[:focus-visible]:bg-fg-1/3`，卡片 `has-[:focus-visible]:border-border-strong`），只写在带 `data-list-item` 的行上，`selected` 样式留给真正的选中。Agent 页与飞书机器人页没有可打开的目标，不接入；导航键不是命令，不进命令面板。
- 登记时带 `palette: true`，这个快捷键在页面绑定期间同时是命令面板「当前页面」分组里的一条命令（名称、按键取自注册表，`PAGE_COMMAND_ICON` 给每个配图标，少一个编译不过）；`useShortcut` 的 `enabled` 同时决定键是否拦截、命令是否出现。`canvas-save` 一直绑定（无改动时 Ctrl S 说明「没有未保存的修改」，不让浏览器弹出另存为）。
- 界面上显示的按键也从注册表取，不写死：按钮提示用 `ToolButton shortcut="<id>"`、菜单项用 `ContextMenuItem shortcut="<id>"`、单独显示用 `<Keys shortcut="<id>" />`，写在文字里用 `shortcutText(id)`。`Kbd` 只接受注册表给出的按键文字（`KeyLabel`），写死的按键过不了类型检查。只说明怎么操作眼前控件、不算快捷键的按键（命令面板底部的「↑ ↓ 选择」）用 `KeyHint`，可用的键限定在 `OperationKey` 里。

## 8. HTTP 契约与数据获取

约定的完整说明在 `packages/schema/src/http/contract.ts` 顶部，要点：

- 每个接口在 `@sfly/schema` 的 `http/<领域>.ts` 中用 `endpoint({ method, path, key, params?, query?, body?, response })` 定义；数据 schema 用名词（`AgentView`），接口表用 `<领域>Api`（`agentsApi.list`）。SSE 用 `stream({ path, params?, query?, events })`，字节流下载用 `download({ path, params?, contentType })`。
- 控制面的**每个** HTTP 路由都在契约里：`httpContract`（`http/index.ts`）列出全部接口表，控制面启动时 `guardHttpContract` 检查注册的路由与它一一对应，多一个少一个都启动失败。
- 响应 schema 用 `z.object`，不写 transform / default / coerce（生产环境前端不解析响应）；请求部分可以用。字段 snake_case，时间用 `Timestamp`。
- 控制面用 `contractRoute(app, agentsApi.list, handler)`（`apps/server/src/http/contract-route.ts`）注册，SSE 用 `contractStream`（只能发送契约里声明的事件），下载用 `contractDownload`：请求不符合契约返回 400 `invalid_request`（需要更具体的错误码时在契约里写 `requestError`，例如保存版本的 `base_version_required` / `invalid_document`），handler 的返回值受响应类型约束；控制面测试用 `xxxApi.yyy.response.parse(body)` 校验实际响应。
- 前端：`useQuery(apiQuery(agentsApi.list))`、`callApi(packagesApi.version, { params })`、`useEventSource(runsApi.events, { params }, handlers)`、`apiUrl(logsApi.download, { params })`（下载链接）。没有手写的接口函数和类型。query key 一律由 `queryKey()` 生成（`[...key, { params?, query? }]`），失效按领域前缀：`invalidateQueries({ queryKey: domainKey(packagesApi.list) })`。开发环境下响应不符合契约时抛出 `contract_violation`，页面显示为错误状态。
- 定时重新查询的间隔与搜索防抖只用 `src/lib/polling.ts` 的命名常量（`LIVE_POLL_MS` 等），不在组件里写数字；列表页的搜索框用 `useSearchInput`（`src/lib/use-search-input.ts`：本地输入、防抖后写进地址，地址变化时同步回搜索框）。
- 浏览器经 `/api` 前缀访问（docs/ARCHITECTURE.md §7），契约里的 `path` 不含前缀。
- 指标接口在 `http/metrics.ts` 的 `metricsApi`（摘要、目录、序列、平台自带图表）；实时增量是运行事件流上的 `metrics` 事件（`MetricIncrement`）。

## 9. 文案

界面只用中文，不引入 i18n 框架；多处共用的文字集中在 `src/lib/copy.ts`：

- `TERM`：术语（与 `GLOSSARY.md` 一致，「编排」只作动词）；`chainLabel()`：链实例名称（主链 / 子流程 X）。
- `PAGE`：导航与页面名（侧边栏、面包屑、页面标题、命令面板）。
- `RUN_STATUS_LABEL`、`CANCELLING_LABEL`：运行状态文字；节点状态文字在 `src/lib/node-status.ts` 的 `NODE_STATUS`（显示时都用 `components/status` 的 `runStatusView` / `nodeStatusView`）。
- `ACTION`：通用操作（运行、取消运行、强制终止、重试、清除筛选……）；`MESSAGE`：通用的加载 / 错误 / 空状态文字。

规则：两处及以上用到的文字、状态与术语放在这里，新增时先加到这里再引用，不要在组件里另写一份；只在一个页面出现的说明文字（空状态说明、提示语）留在组件里。

## 10. 新页面检查清单

1. 路由放在 `routes/_shell/`（或全屏页放 `routes/`），写 `staticData: { crumb }`；一级页面同时加到 `navigation.ts` 与快捷键注册表。
2. 数据走契约（先在 `@sfly/schema` 定义接口，再在控制面用 `contractRoute`），查询用 `apiQuery`。
3. 版式用 `Page` / `PageHeader` / `Panel`；列表用 `QueryView` 接上空 / 加载 / 错误。
4. 只用语义层与画布层 token、规定的字号与圆角；状态用 `StatusPill` + `runStatusView` / `nodeStatusView`；共用文案从 `lib/copy.ts` 取；每屏最多一个 `primary` 按钮。
5. 弹窗用 `Dialog` / `Sheet`；操作结果用 `notify`。
6. 端到端测试覆盖用户可见的行为，关键状态加视觉基线（`pnpm test:e2e:docker --update-snapshots`）。

## 11. 动效

- **token**（`tokens.css`）：`--motion-fast` 100ms（退场、悬停、按下）、`--motion-base` 150ms（浮层与提示进场、选中、颜色变化）、`--motion-slow` 200ms（抽屉、画布视口）；`--motion-ease-out`（进场与状态变化，工具类 `ease-out` / `ease-standard`）、`--motion-ease-in`（退场，`ease-in`）。`transition-*` 不写时长与缓动时默认就是 `--motion-base` + `--motion-ease-out`；浮层用 `duration-(--motion-base)` 这样的写法取值。JS 驱动的动效（画布视口）用同样的数值。
- 只动 `transform`（`translate` / `scale`）与 `opacity`；图表数据刷新、日志跟随、列表焦点移动都是瞬时的。
- **减少动效**（`prefers-reduced-motion: reduce`）：去掉位移、缩放、视口平移和持续循环的动画，保留淡入淡出与颜色变化，状态信息不能只靠动画表达。不用全局把时长压成 0 的写法，按动效逐个处理，规则写在动效定义旁边：
  - 循环动画只在 `prefers-reduced-motion: no-preference` 下启用：执行中的脉冲（`pulse-ring`）、画布选中连线的流动（`animate-edge-flow`）、骨架屏的明暗呼吸（`animate-pulse`）。静止时它们的形状已经说明了状态。
  - 加载图标（`animate-spin`）放慢到 3 秒一圈，不停下来。
  - 浮层的进出场（tw-animate 的 `zoom-*`、`slide-*`，Base UI 的 `data-starting-style` / `data-ending-style` 位移）只剩淡入淡出（`app.css` base 层）。
  - 颜色、底色、描边的过渡照常。

