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
| | `track`、`scrim` | 进度条的空槽；弹窗遮罩 |
| 描边 | `border`、`border-soft`、`border-strong` | 面板与分隔 / 面板内分隔 / 浮层；有意安静 |
| | `border-control` | 表单控件（输入框、下拉、勾选框、开关、分段）的边界：在 `sunk`、`surface`、`raised` 上都 ≥ 3:1 |
| 文字 | `fg-1`、`fg-2`、`fg-3` | 正文 / 次要 / 辅助（对 `bg`、`surface`、`raised`、`raised-2` 都 ≥ 4.5:1；不再叠加不透明度） |
| 主操作 | `primary`、`primary-hover`、`primary-foreground` | 白色按钮 |
| 信号（青） | `signal`、`signal-fg`、`signal-line`、`signal-soft` | 执行中、键盘焦点环（`ring`）、调度连线；`signal-soft`（淡底）与 `signal-line`（描边）用于执行中的区段，见 2.4 |
| 选中 | `selected`、`selected-bg`、`selected-ring`、`selection-bg` | 中性高亮；`selection-bg` 是文字选区（`::selection`，不用青色） |
| 状态 | `ok`、`warn`(`-fg`)、`danger`(`-fg`)、`signal`(`-fg`)；`pending`、`skipped`、`cancelled`、`stopped` | 不带 `-fg` 的给状态形状、描边与色块，状态文字用 `-fg`（成功的绿本身够亮）。见 6.1 |
| | `-line`、`-soft` | 描边（在 `surface` 上 ≥ 3:1）；带文字的淡底（≈ 1.15:1，`signal-soft` 是执行中的淡底，故意强一档 1.3:1） |
| | `ok-fill`、`warn-fill`、`danger-fill`、`signal-fill`、`stopped-fill`、`pending-fill` | 状态面积色：进度段、缩略图节点、时间线区段、趋势柱、小地图只用这一组，每种状态一档，不另写 `bg-ok/50` 这样的透明度 |
| 日志 | `log-debug`、`log-info`、`log-warn`、`log-error` | INFO 不上色 |
| 图表 | `chart-1` … `chart-4`、`chart-grid` | 多序列线色（中性灰与灰蓝，按序使用，明度依次拉开：线在 `bg` 与 `surface` 上 ≥ 3:1，两两色差在三种色觉缺陷下 OKLab ΔE ≥ 7，`design-rules.test.ts` 检查）、网格线；状态色只用于节点状态 |
| 阴影 | `shadow-float`、`shadow-pop`、`shadow-inset-top` | 悬浮控件 / 弹窗、菜单 / 可滚动区域顶部的内阴影 |
| 动效 | `--motion-fast` 100ms、`--motion-base` 150ms、`--motion-slow` 200ms；`--motion-ease-out`（`ease-out`、`ease-standard`）、`--motion-ease-in`（`ease-in`）；`--pulse-period` | 见第 11 节；`transition-*` 不写时长与缓动时默认就是 base + ease-out |
| 滚动条 | `--scrollbar-thumb`、`--scrollbar-track` | `:root` 的 `scrollbar-color`；不设 `scrollbar-width` |

shadcn 组件用的 `background`、`foreground`、`popover`、`muted`、`accent`、`destructive`、`input`、`ring` 等名称映射到语义层；**注意 shadcn 的 `accent` 是中性悬停色，不是青色**，新代码直接用我们的名字。

透明变体（`-line`、`-soft`、`-fill`、网格线、遮罩）用 `color-mix(in srgb, var(<基础色>) N%, transparent)` 从同一个颜色派生，不抄写数值；`design-rules.test.ts` 直接从 `tokens.css` 算这些 token 叠在表面上的对比度。

`tokens.css` 末尾有 `@media (prefers-contrast: more)` 加强档：描边三级、控件边界、辅助文字、网格、连线、端口、选中外圈与滚动条滑块各加强一档，组件不用改。

工具类（`app.css` 的 `@utility`）：`selected-row`（`selected-bg` 底 + 左侧 2px 白条，表格、目录、列表的选中项都用它）、`focus-glow`（输入框聚焦光晕）、`pulse-ring`（执行中的脉冲，见 6.1）。

### 2.3 画布专用 `--canvas-*`

`canvas-bg`、`canvas-grid`、`canvas-node-bg` / `-border` / `-selected`、`canvas-port`、`canvas-edge` / `-selected` / `-live` / `-dispatch`、`canvas-subflow` / `-fg` / `-line` / `-soft`、`canvas-annotation-line` / `-soft` / `-band`（注释框：中性实线框和抬起一档的标题带，和紫色虚线的子流程区域分开）、`canvas-run-running` / `-failed` / `-cancelled` / `-stopped` / `-done-bg` / `-done-border`（已完成的节点下沉，不降文字对比度）、`--canvas-minimap-mask`（小地图视口外遮罩）。画布组件（#35 起）只用这一层和语义层。节点几何常量（卡片宽高、端口位置）由 #35 收敛为单一来源。

画布里的文字随缩放比例放大，屏幕上不小于最小字号，只有两档：数字与拉丁字母 11px，含中文 12px；卡片标题 13px，缩小视图时仍约 12px。写法固定用 `components/canvas/zoom-text.ts` 的 `ZOOM_TEXT_11`、`ZOOM_TEXT_12`、`ZOOM_TEXT_TITLE`，不另写字号。

### 2.4 配色规则

- **白色是每屏唯一的主操作**：`<Button variant="primary">` 每屏最多一个（如「新建场景」）；其余按钮用默认（中性）或 `ghost`。Logo 与头像的白底不是操作。全新环境的控制台（「开始使用」）里，白色按钮跟着第一个没完成的步骤走：复制安装命令、新建场景、运行场景；发布节点包那一步在命令行里完成，没有白色按钮，只有开发文档「发布」的链接。
- **青色只用于执行中、键盘焦点环、调度连线**。不要用青色表示选中、链接或强调。
- **执行中的区段是淡底加描边，不是实心青色**：时间线段、链路进度段、场景缩略图节点、平台图表里的节点耗时条按状态表画（`STATUS.running.area`：`signal-fill` 底加 1px `signal-line` 描边），与成功、失败等色块同一量级。实心 `signal` 只给状态形状、时间线段尾的脉冲头和焦点环。
- **选中是中性高亮**：`selected-bg` 底 + 左侧 2px 白色短条（工具类 `selected-row`），画布上是 `selected` 描边 + `selected-ring`，相关连线灰色虚线流动。文字选区是中性的 `selection-bg`。日志按时刻定位到的那一行同样用 `selected-row`（不用青色），没有正好对应的行时插入的「这一刻」是一行文字加一条中性细线（`border-strong`）。
- 绿色 = 成功，红色 = 失败，**琥珀色只有三个意思：等待中（定时 / Sleep）、警告、安装中**。关注项的异常（「需要注意」，四种原因里也包括来源节点失败）算警告，用琥珀三角加原因（`AnomalyNote`）；来源节点本身的状态形状不变，失败仍是红色菱形。排队中（在等 Agent 的槽位）是中性灰；点选日志行时时间轴上的定位线、被点选的日志行、节点的 `always` 标签这类不是警告的东西也不用琥珀（用中性的 `selected`）。
- 状态文字与图标用 `-fg`：`text-warn-fg`、`text-signal-fg`、`text-danger-fg`；不带 `-fg` 的 `text-warn` / `text-signal` / `text-danger` 只写在状态表（`components/status.tsx`）里，别处要状态形状的颜色时取 `STATUS[kind].tone`（`design-rules.test.ts` 检查）。
- **没有信号就不着色**：数值为 0 的计数（控制台页头的「失败 0」）、全零的趋势线用中性色。必填的星号（`*`）用中性 `fg-2`，红色只给错误。保存状态里只有需要处理的才带点（保存被拦截红、未保存琥珀），「已保存」是纯文字。
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
| `text-lg` | 16 / 24 | 页面标题；关注项读数的最新值（等宽加粗） |
| `text-2xl` | 22 / 28 | 运行的已运行时长（控制台运行块的右上角），全站唯一的大字号 |

  字号 token 用 rem（默认根字号 16px 下就是上表的像素值）：用户调大浏览器默认字号时文字与间距一起放大。不在 `html` 上设字号。

  原型里的非整档字号归并：12.5 → 13（正文、菜单、面包屑）、11.5 → 12（徽标、提示、字段说明）、10 → 11；15（弹窗标题）→ 14。
- 圆角只有 `rounded-sm` 4、`rounded-md` 6、`rounded-lg` 8、`rounded-xl` 12（另有 `rounded-full`）。小于 12px 的指示元素（进度段）用 2px。组件里不写色值、不用其他圆角任意值（`src/styles/design-rules.test.ts` 检查）。
- 控件高度：按钮 / 输入框 30（`h-7.5`），小号 26（`h-6.5`）；顶栏 48（`--topbar-height`）；侧栏 208 / 折叠 56；kbd 18。
- 图标（lucide）：根部的 `LucideProvider` 统一线宽为屏幕上的 1.5px（`nonScalingStroke`），不随图标尺寸变粗变细；图标尺寸只用 12 / 14 / 16（`size-3`、`size-3.5`、`size-4`）。勾选框的对勾加粗到 2px。例外：画布里的图标按 em 取尺寸（`size-[1em]`），随语义缩放后的卡片文字一起变化，不受 12 / 14 / 16 的限制（先例：`components/canvas/zoom-text.ts` 的 `KIND_CHIP`，`CardFocus.tsx` 的眼睛图标）。

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
| `Switch` | 开关：30 × 18、`border-control` 描边；关闭 `track` 底 + 灰色圆点，打开 `selected` 底 + 深色圆点（与勾选框一致，不用绿色）；强制颜色模式下用系统颜色画。旁边有文字时写 `label="必填"`：开关和文字包在同一个 `<label>` 里，点文字也切换，文字就是开关的名称（不再另写 `aria-label`）；长说明放在旁边，用 `aria-describedby` 关联 |
| `FormField`、`FormAlert` | 表单字段：标签（必填加中性的 `*`）、控件、帮助、错误；错误与帮助用 `aria-describedby` 关联、出错时控件 `aria-invalid`（控件经 render 函数拿到这些属性）。`FormAlert` 是提交失败的服务端错误（`role="alert"`），写在弹窗里、提交按钮上方。见 6.4 |
| `Segmented` | 分段选择（筛选、显示方式切换；同一块内容换一种看法）：`fieldset` + `aria-pressed` 按钮，`border-control` 描边，当前项中性高亮（`raised-2` 底加一圈 `border-strong` 内描边）；只有图标的选项给 `label` |
| `Badge` | `default` / `ok` / `warn` / `danger`；版本号、计数等（12px） |
| `Dialog` | 模态弹窗：锁定焦点、Esc 关闭、关闭后焦点回到打开前的元素；距顶 12vh、宽 520（`className` 覆盖），最高 76vh。三段：`DialogHeader`、`DialogBody`、`DialogFooter`，内容变高时只有 `DialogBody` 滚动（上下还有内容时边缘出现阴影），标题与按钮一直看得见；外层包 `<form>` 也照样分三段（form 不占版面）。没用 `DialogBody` 的弹窗过高时整个弹窗滚动，按钮行贴在底边。点遮罩关闭由 `pointerDismiss` 决定：默认 `"pristine"`，在弹窗里输入过任何东西后点遮罩不再关闭（Esc 与「取消」照常），搜索类弹窗（命令面板）`"always"`，`"never"` 只能用按钮或 Esc。`DialogDescription` 是决定后果的说明：13px 正文、二级文字 |
| `Sheet` | 抽屉（右侧，默认 460px），焦点与点遮罩关闭的规则同 Dialog |
| `DropdownMenu` / `ContextMenu` | 下拉菜单（有 Trigger）与右键菜单（没有 Trigger，使用方给出 `open` 与 `anchor`：屏幕坐标或元素）是同一种菜单，外观与词汇都来自 `menu-item.tsx`：当前项 `raised-2` 底；`variant="danger"` 只把文字换成 `danger-fg`，高亮底色不变红；`disabledReason` 禁用并把原因写在文字下面一行（12px、三级文字，也读给读屏用户），禁用项不降整项不透明度，只有文字退到三级、图标与按键 40%。两者都不是模态：打开时页面照常滚动，点外面一下就作用到点到的地方。`ContextMenuItem` 的 `shortcut` 从快捷键注册表取按键与名称；关闭后焦点回到打开前的元素。画布上经 `FlowCanvas` 的 `menu` 使用 |
| `Command` / `CommandDialog` | 命令面板（cmdk + Dialog，点遮罩随时关闭）；结果列表的无障碍名称是「结果」 |
| `Tooltip` | 悬浮提示（根部已有 `TooltipProvider`，延迟 400ms）；在相邻触发器之间移动时新提示直接出现、旧提示直接消失（`data-instant` 不做过渡） |
| `Truncate` | 单行截断，见 6.5 |
| `Table` 系列 | 表头 12px 三级文字（不加粗），吸在最近的滚动区顶端（列表页是外壳的主区域），行进入视野时让开表头的高度；行悬停 3% 白；`data-state="selected"` 是 `selected-row`（与节点包列表、版本历史的选中项一致）。`scroll`：默认 `"none"`（不包滚动容器，表头才吸得住）；可能比容器宽的内容表格（文档里的表）传 `"x"`。列宽见 6.5 |
| `Kbd`、`Skeleton`、`Separator`、`Toaster` | 按键、骨架、分隔线、通知容器（右下角，见 6.3） |

### 应用组件 `components/`

| 组件 | 说明 |
|---|---|
| `app-shell/AppShell` | 外壳：侧边栏（导航来自 `navigation.ts`，可折叠，状态存 localStorage；项右侧平时是计数，悬停或键盘聚焦时在同一位置换成跳转快捷键 `Keys`，折叠后不显示）、顶栏（面包屑来自路由 `staticData.crumb`、Ctrl K 搜索入口、昵称） |
| `app-shell/overlays` | 全局浮层：命令面板、快捷键面板、昵称弹窗、运行抽屉、通知；`useOverlays().open("shortcuts")`、`useOverlays().open("run-scenario")`（只列「运行场景」一组的命令面板，控制台的「运行场景」按钮用它）、`useOverlays().runScenario(场景)` |
| `app-shell/CommandPalette` | 「当前页面」「跳转」「场景」「运行」（最近的运行）「运行场景」（打开运行抽屉）「命令」六组。「当前页面」是当前页面已绑定、并在注册表里带 `palette` 的快捷键（取消运行、保存……），名称与按键取自注册表，页面状态变了（运行结束、没有失败节点）就自动出现或消失，为空时整组不渲染；其余命令加在 `commands` 里。`scope="run-scenario"` 时只列「运行场景」一组，在里面按 Ctrl K 切成完整的命令面板 |
| `page`：`Page`、`PageHeader`、`Panel`、`SectionHeading`、`Keys`、`CodeBlock` | 页面版式；`PageHeader` 固定一个控件高（有没有右侧按钮标题都在同一位置），标题 h1 可以被程序聚焦（焦点去向的兜底，见第 7 节）；`Panel` 用 `overflow: clip` 裁圆角，不是滚动容器（里面的表头才能吸顶）；`Keys keys="Ctrl+K"` 显示按键；`CodeBlock` 带复制 |
| `doc-page-link`：`DocPageLink` | 正文里指向开发文档某一页的行内链接（`page` 是文档的 slug） |
| `#/dashboard/DashboardPanel`：`DashboardPanel` | 控制台的面板：标题行（标题、计数、右侧操作）加内容，以标题作区域名称；「开始使用」和实况墙的最近结束、Agent、场景共用 |
| `#/docs/Markdown` | 用户文档（ADR 0013）的 Markdown 渲染：代码块用 `CodeBlock`（```prompt 代码块是给人读、复制给 AI 编程助手的提示词，自动换行、正文字体；其余代码块不换行），表格用 `ui/table`，`<slug>.md` 链接换成文档页 |
| `status`：`STATUS`、`StatusPill`、`StatusDot`、`runStatusView`、`nodeStatusView`、`alignPulses` | 状态语法，见 6.1；运行 / 链 / 节点状态的种类与文字只从 `runStatusView`（含「取消中」）与 `nodeStatusView` 取，颜色、形状、动效只从 `STATUS` 取，不另写映射表。节点状态在各处的显示规则（种类、画布运行状态、时间线、是否算已完成）集中在 `src/lib/node-status.ts` 的 `NODE_STATUS` 一张表里，新增节点状态只改这张表 |
| `slot-cell`：`SlotCell`、`IdleSlots`、`idleSlotCount`、`taskChainLabel`、`slotLabel` | 槽位格：Agent 上一个被占用的槽位（带文字的容器，圆角 8px），写节点（`NodeName`）、场景、运行编号、所在链（主链或子流程名）、尝试号、节点类型和已执行时长；描边与文字色取自 `STATUS` 的执行中（只取描边，底色用 `raised`），状态形状是 `StatusDot`，还在准备（派发中、没有开始时间）的任务时长处写「准备中」。放在 `<ul>` 里，每个槽位格是 `<li>`，可访问名称是「节点 …，场景 …」，调用方在底部追加内容（`children`）时用 `summary` 把要点补进名称。连续的空闲槽用 `IdleSlots` 合并成一行矮条（空闲是在线的 Agent 上没被占用的槽位，离线的 Agent 不画矮条，见 `AgentRack` 一行），网格设 `items-start`，矮条不随旁边的格子拉伸。系统里没有槽位身份，格子不写「槽 1」这样的编号。Agent 管理页的机架（`#/agents/AgentRack`）用它；控制台的 Agent 列用紧凑形式（`compact`，`IdleSlots` 同样传 `compact`）：一行写节点、场景、子流程名和已执行时长，圆角 6px，不写运行编号、尝试号和节点类型（运行块里有），也不放关注项的数值（只在运行块里出现一次） |
| `#/agents/AgentRack`：`AgentRack`；`#/agents/agent-status`：`agentStatusView`、`updateStatus` | 一台 Agent 的机架面板（`Panel`，名称是 Agent 名称）：头部一行是状态（`agentStatusView`，控制台 Agent 列的名称行用同一个）、名称、版本、系统、对外地址、最后在线，右侧是被引用的场景数和「立即更新」，更新、时钟偏差、能力不可调用、节点包安装失败这些告警跟在状态后面，放不下时头部换行；主体是 `SlotCell` 网格（`auto-fill`，最窄 300px）和排队的任务（写排队了多久、多久后排队超时，`queueTiming`）；离线的 Agent 接不了任务，槽位不算空闲：不画空闲矮条、不写「N / M 占用」，断线后租约到期前还占着槽位的任务照常列出，一个都没有时槽位一栏整个不画；底部是节点包与能力的小字 |
| `note-icon`：`NoteIcon` | 备注图标：悬停或键盘聚焦时在提示里显示备注全文（保留换行；长备注不超出视口，在提示里滚动：鼠标用滚轮，键盘用 PageUp / PageDown / Home / End）。页面上它是按钮，可以 Tab 到，名称「备注」、描述是全文；画布上节点卡片不在 Tab 顺序里，图标放在卡片里时传 `host`（卡片的选择器）和 `textId`：图标本身不可聚焦、对读屏隐藏，键盘用户靠卡片的键盘焦点看到提示，读屏用户在卡片的描述里读到备注。大小按所在文字的字号（em），不随画布缩放的提示固定 12px；节点卡片、注释框的标题带、运行监控页的图表组标题都用它，不另写一套 |
| `chain-progress`：`ChainBar`、`ChainBars` | 各链进度条：每个节点一段竖向短段（运行记录、运行抽屉；每段的颜色、描边与高低取自 `STATUS[kind].area`）；「2/3」这样的计数用 `chainProgressText`，进度条、线路的计数和读屏名称都用它 |
| `run-lines`：`RunLines`、`RunLineThumb`、`foldStations`、`layoutLines` | 线路：一个运行的每条链画成一条线，节点是站（`StatusDot`，状态只从 `STATUS` 取），站名写在点下面，右边是「已完成数 / 节点数」；进入执行中节点的那一段是 `signal-line`，其余是 `border-strong`；子流程从触发它的异步任务节点那一列分出，分支竖线是调度连线的青色虚线（`signal-line` 虚线）。所有行共用一套列（CSS subgrid），同一条链分出的几条子流程列靠右的排在前面，分支竖线不会穿过别的线。超过 7 个节点的链按 `foldStations` 折叠：只画当前站（进行中的节点，没有时是第一个待执行的节点）前面最后一站、当前站和之后两站，其余折成「已完成 N 个」「还有 N 个」（点是这一段最后一个节点的状态），失败的节点总是画出来。`RunLineThumb` 是一条链的缩略（只有点和线，折起来的一段是一截虚线），读屏读作「主链 5/10」。控制台的运行块与紧凑行、运行监控的概览用它 |
| `#/dashboard/*`：`RunningRuns`、`RunBlock`、`CompactRunRow`、`EndedPanel`、`AgentsPanel`、`ScenariosPanel`、`PanelLink`；`wall-rules` 的 `wallLayout`、`agentColumn` | 控制台的实况墙：左栏是正在运行的运行块（场景、版本、运行编号、触发人与开始时间，右上角 22px 的已运行时长；线路；执行中节点的主指标；进行中的节点那一行；打开运行监控、在画布中查看、取消运行）和最近结束，右栏是 Agent 列（槽位格的紧凑形式，数据是 Agent 列表接口，与 Agent 管理页共用查询缓存）和场景列。数量多时按 `wall-rules`：3 个以上运行时进行中的节点和读数只列前 2 个，6 个以上运行时运行块换成一行一个的紧凑行（整行是展开按钮，展开后焦点在「收起」上，收起后回到这一行；紧凑行不取读数），Agent 超过 5 台时只列忙碌、离线、不是「在线」状态的，其余合并成「N 台空闲」 |
| `sparkline`：`Sparkline` | 迷你趋势（主指标） |
| `elapsed`：`Elapsed` | 已持续多久（`formatDuration`），按控制面时间每秒刷新，只这一小块重新渲染：节点卡片上的「正在做」、动作表里进行中的耗时都用它 |
| `#/focus/FocusReadout`：`FocusReadout`、`FocusReadoutStrip` | 关注项读数：一个关注项（没设关注项时是执行中节点的主指标）的一格读数，从上到下三行——来源节点的状态形状（`StatusDot`）和名称（最多两行）、最新值和单位（`FocusValue`：等宽 16px 加粗，累计值就是当前累计，平台不算速率；图表有多个序列时先写最近更新的那条的名字）、「来源节点 · 多久前」（来源节点写成「显示名称（节点 ID）」，没有显示名称时只写节点 ID；有值时来源节点成功、已停止或已取消写「最终值」；没有值时写原因：来源节点还没有开始执行（待执行、排队中、准备中、已跳过，以及没开始就失败、已取消、已停止的）写这个状态没有执行的原因（`NODE_STATUS` 的 `notRun`，如「还没有开始执行」「已跳过，没有执行」），已经开始但还没有点写「还没有数据」，尝试已经结束仍没有点写「这次尝试没有上报数据」（这三句由 `lib/copy.ts` 的 `noDataLabel` 给出，运行监控详情的图表工作区用同一个函数）。有没有值只在 `focus-format.ts` 的 `readingState` 判断，脚注、可访问名称和图表卡片的空状态共用）；图表在节点包版本里不存在时写「这个版本的节点没有图表 X」（`FOCUS.chartMissing`，句子来自 `@sfly/schema` 的 `focusChartMissing`；场景设置的「关注项」页和运行通知的卡片也用它），不显示数值，脚注只写来源节点。**读数之间只用 1px 分隔，不套卡片**：`FocusReadoutStrip` 按宽度自动排成几列（每格至少 11rem），换行后每一行的分隔线也一样；外框由调用方的 `className` 决定。整格可点时用 `render` 换成按钮或链接，悬停是 3% 白（与表格行一致），可访问名称写明名称、最新值、来源节点和状态，以及多久前、最终值或没有值的原因（「母单量 1.3M 单，来自 load（执行中），2s 前」）。「多久前」按读数的 `generated_at`（控制面时间）算，不随浏览器时钟跳动。**有异常时**（异常只由控制面判断，见契约 `FocusAnomalyKind`）第三行换成琥珀三角和原因（`AnomalyNote`），可访问名称最后写「需要注意：原因」；没有新数据时最新值退成 `fg-2`。概览和画布运行状态检查器的概况（全部关注项，每格是按钮，点了选中所在的节点）用它；数据一律来自 `#/focus/use-run-focus` 的 `useRunFocus`（`GET /runs/:id/focus`），不另拼指标查询 |
| `#/focus/FocusChart`：`FocusChart`；`#/focus/FocusPlot`：`FocusPlot` | 概览里图表类关注项（折线、面积、柱状）的卡片：状态形状和名称、最新值（`FocusValue`）、「来源节点 · 多久前」、按容器的实际尺寸画的图（`FocusPlot`：绘图区和图例，画布运行状态检查器里的图表也用它，高度由调用方给）（SVG 用测量到的像素宽度，文字不被拉伸；**纵轴从 0 起**，不把正常的小波动画成大起大落，上限包含每个桶的最大值；横轴是来源节点这次尝试的开始到结束，还没结束就到读数生成的时刻）、多个序列时的图例（线色与线型沿用 `MetricChart` 的 `seriesColor`、`seriesDash`；超过 10 个序列时只画平均值最高的 10 条并写明还有几条；挑好以后保持不变，读数刷新、平均值的排名变了也不换，只在出现新序列时重新挑，与详情的图表同一个 `pickShown`）和「在详情里打开 <节点>」（`Button variant="link"`）。文字格式在 `focus-format.ts`（值和序列名的写法来自 `@sfly/schema` 的 `focus-reading.ts`），几何在 `focus-chart.ts`（纯函数，有单测）。有异常时「来源节点 · 多久前」一行换成 `AnomalyNote`（原因后面接「 · 来源节点」）；**没有新数据**（`stale`）时曲线停在最后一个点，之后到现在画斜线（`border-strong` 的 45° 细线，`focus-chart.ts` 的 `plotChart` 给出这一段），斜线旁用 `warn-fg` 写「已 2m 10s 无新数据」，图的可访问名称后面加「曲线停在最后一个点」。这段斜线只在图表的绘图区里表示没有新数据，不是状态色块，和 6.1 里排队中的灰色斜纹（进度段、时间线）不在同一种元素上 |
| `canvas/CardFocus`：`FocusBadge`、`FocusRows` | 画布运行状态下节点卡片上的关注项（场景设了关注项时）：`FocusBadge` 是左上角的眼睛图标和个数（和右上角的标签同一个样子），卡片的可访问名称接上「N 个关注项，M 项需要注意：原因」（`cardFocusLabel`：卡片上的三角旁边放不下原因，原因写在名称里，悬停一行也能看到）；`FocusRows` 在节点开始执行以后代替底部的摘要槽：前两项各一行（`#/focus/focus-preview` 的 `focusPreview`，按控制面排好的顺序：有异常的在前，带 `AnomalyMark`），用图表自己的标题（「CPU」）而不是场景起的名字，多出的写「还有 N 个关注项」；来源节点成功、已停止或已取消后控制面不再判断异常，只剩最终值。卡片按内容长高，子流程区域、注释框和跟随执行按量出来的高度框 |
| `#/focus/AnomalyNote`：`AnomalyMark`、`AnomalyNote` | 关注项的异常：`AnomalyMark` 是琥珀实心三角（状态表的 `warn`，不另写颜色），只是形状，旁边必须有写明原因的文字，或者原因写在所在元素的可访问名称里；`AnomalyNote` 是三角加原因（`warn-fg`，12px），原因的短句由 `focus-format.ts` 的 `anomalyText` 给出（「WARN · 10:58:41」「已 2m 10s 无新数据」「来源节点失败」「重试（尝试 2）· 10:41:02」，文字在 `lib/copy.ts` 的 `FOCUS`）。异常同时用形状和文字表达，色觉缺陷和强制颜色模式下也分得出；读数、图表卡片、「需要注意」（`#/monitor/Attention`）都用它们；别处显示关注项的异常时也用这两个，不另画三角 |
| `#/actions/InspectorActions`：`CurrentActions`、`ActionArea` | 画布运行状态检查器里的「正在做」和「动作」区，数据来自 `useActionSummary`（`GET /tasks/:id/actions/summary`，节点执行中每 `ACTIONS_POLL_MS` 重新读取，结束后再读一次）。显示最近一次开始执行的尝试的动作（重试的新尝试还在排队、准备时，上一次的动作和失败还在），节点重试过时「动作」标题旁写这是第几次尝试。**「正在做」**：只在尝试执行中画；正在进行的动作按层级缩进（最多 3 层，更深的画在第 3 层；缩进读屏读不出来，子动作的名称前有一句只给读屏的「子动作：」），写名称、字段（`key=value`，放不下截断，悬停看全文）和已持续多久（`elapsed` 的 `Elapsed`）；列满 50 个时（`running_complete` 为 false）写「列满 N 个，可能还有没列出的」（N 取列表的个数）。**「动作」区**：每种名称的总数和失败数（一张 `<table>`，名称按第一次出现的先后排，计数变化时行不重排；名称里动作和标记在一起）；上限说明列出每个只计数的名称和它从几点起只计数；「失败的动作除外」只对只超过每种名称上限（`name_limit`）的名称说（失败的动作仍有明细，直到合计满）：全是这种名称时写在开头那一句里，同时有因合计满而只计数（`total_limit`）的名称时写在 `name_limit` 的名称后面，全是 `total_limit` 时不写；合计满了时再说「满了以后开始的动作都只计数（失败的也一样）」和第一个因此没有明细的动作是几点开始的（那个时刻不是明细的终点：更早开始的动作结束时仍可能补上明细，失败的动作在合计满以前会补，所以不说「从那个时刻起都没有明细」），并指向开发文档「开发节点（SDK 参考）」的「数量上限」；最近的失败（接口给的最近 5 个，标题旁写一共多少个，多于 5 个时下面用 `moreLabel()` 写还有几个）原因单独一行、不截断，放不下就折行（`wrap-anywhere`，4096 个字符也不撑破检查器）。「最近 20 个」不放在检查器里（每秒 200 单时只覆盖约 0.1 秒，一直在滚）。没有动作记录的节点这两块都不画；摘要里写进度的说明的条件和卡片一致：尝试执行中、没有正在做的动作。检查器底部有动作记录的节点多一个「打开动作明细」（`ACTION.openActionDetails`：去另一个页面，按第 9 节写「打开」），用 `runMonitorLink` 带上 `tab=actions` 打开运行监控详情的「动作」页 |
| `#/monitor/ViewTabs`：`ViewTabs` | 运行监控页头的「概览 / 详情」标签页：`role="tablist"`，只有选中的标签在 Tab 顺序里，左右方向键切换并立即显示、Home / End 到第一个 / 最后一个（`monitor-view.ts` 的 `nextView`），对应的面板是 `role="tabpanel"`，名称取自当前的标签页。外观沿用分段选择（`raised-2` 底加一圈 `border-strong` 内描边，不用青色；强制颜色下 `aria-selected="true"` 换成 `Highlight` 描边）：它放在页头里，用 `Tabs` 的下划线样式会和页头的底边打架；切换整个页面的两个视图用它，同一块内容换一种看法用 `Segmented` |
| `canvas/CanvasDock`：`ToolButton` | 画布底部工具条（一个 Tab 停靠点）与它的图标按钮：按钮的提示从注册表取名称和按键。运行状态下工具条里多一个「跟随执行」按钮（`F`，准星图标）：打开时镜头框住所有执行中的节点（子流程里的连同子流程区域），框在没被顶栏、检查器、工具条占住的可见区域正中，缩放夹在 0.6 到 1，只移动镜头、不改选中的节点；执行前沿（执行中的节点）变化后停留 2 秒才平移（`FOLLOW_DWELL_MS`），平移的时长与「减少动效」同视口动画（见第 11 节）。拖动画布、缩放（滚轮或工具条的缩放按钮）、用方向键把选中移到视野外的节点时关闭，并在画布里的读屏实时区域（`<output aria-live="polite">`）播报「按 F 恢复」；运行结束后自动关闭、按钮禁用。按下用中性样式（`aria-pressed`，强制颜色下是系统高亮色轮廓），不用青色。第一次默认打开，之后记住这个浏览器里上次的选择（`lib/follow-execution`，localStorage `sfly.canvas.follow`），运行结束的自动关闭不算选择 |
| `ResizeHandle`、`PanelWidthHandle` | 区块边缘的拖动条：拖动调整高度或宽度，可聚焦，方向键每次 16px，双击或 Enter 恢复默认；`role="separator"`，`aria-valuemin` / `aria-valuemax` / `aria-valuenow` 是量出来的值（默认大小也有值），操作说明放在 `aria-describedby` 里，不只写在 `title`。`PanelWidthHandle` 是右侧面板（检查器、运行抽屉）左边缘的调宽条：宽度存 localStorage，所有场景共用，下限是面板的默认宽度（检查器 372px、运行抽屉 460px），上限是视口宽度的 60%；检查器的上限还要给画布留出小地图、工具条与间距（`INSPECTOR_CANVAS_RESERVE`），取两者里小的，拖到最宽也不会让工具条压住小地图；面板用 `usePanelWidth(min)` 取宽度（`lib/panel-width`） |
| `data-table`：`DataTable`、`dataColumns` | 数据表格：行与表头模型用 TanStack Table，外观沿用 `ui/table`；列表页的表格都用它；行的属性（点击、样式、`data-*` 属性）由 `rowProps` 给出 |
| `#/actions/ActionTable`：`ActionTable` | 运行监控「动作」页的表格（一个任务最多 10 万条明细）：行由 `actions/action-table.ts` 整理成「正在做」「最近 20 个」「更早的明细」三组，画成一张虚拟滚动的 `<table>`：每组一个 `<tbody>`，组名是 `scope="rowgroup"` 的表头，上下用占位行撑出高度，表头吸顶，列宽固定（见 6.5）。结果一列按状态语法：成功不着色，失败是红色菱形加完整的原因（换行），进行中是执行中的形状，标记是小旗；只计数的一段是一整行浅斜纹。离开顶部以后，推送来的行插在上面时视口里的行不动；滚到底部附近读更早的一页。开始一列按 `timeKind` 显示 Agent 时间或控制面时间（ADR 0018，默认控制面时间，存在 localStorage 的 `sfly.actions.time`，和日志的互不影响），显示 Agent 时间时表头第二行写时钟偏差（`attemptClockNote`，和「尝试」页签的说明同一份），时间线不跟着切；每行的开始时间是按钮，点它日志跳到那一刻（`onLocate`，始终是控制面时间）；开始时间的按钮合起来只有一个 Tab 停靠点（漫游焦点，同日志列表；没渲染时停靠点退回视口里的第一行），方向键、PageUp / PageDown、Home、End 在行间移动，只计数的行里的按钮照常可以 Tab；焦点所在的行被卸掉（滚出渲染范围、结束后换了组）时焦点落到页面上，Tab 再进来落在停靠点。只计数的一行里有「只看失败」；只看失败时，这一段里失败的个数不知道（个数包括成功的），写明这个名称一共失败多少个，没有失败过的名称这一行不出现 |
| `#/actions/ActionToolbar`：`ActionToolbar` | 运行监控「动作」页的工具条和一行总数：按名称筛选的 `NativeSelect`、「只看失败」开关（`aria-pressed`）、表格里的时间 `Segmented`；下面一行总数，每种名称的个数和「失败 N」是同一份筛选条件的按钮（`aria-pressed`），名称很多时这一块限高、自己滚动。筛选条件由底部面板持有（切到日志再回来还在），换条件重新读明细时工具条不换掉、焦点留在刚操作的控件上，表格显示上一批行（变淡），点按钮之后在实时区域（`<output>`）播报「筛选后 N 个动作」（在点的那一刻算一次，不随摘要的更新重读）。筛选后没有行时写「没有符合条件的动作。」加「清除筛选」，点它以后焦点回到名称下拉 |
| `list-navigation`：`useListNavigation`、`focusFirstListItem` | 列表页的行导航，见第 7 节 |
| `feedback/states`：`EmptyState`、`TableSkeleton`、`RackSkeleton`、`ErrorState`、`QueryView` | 空 / 加载 / 错误；`QueryView` 把查询的四种状态接上 |
| `feedback/notify` | `notify.success / info / warning / error`，见 6.3 |
| `feedback/banner`：`Banner` | 页内横幅（`danger` / `warn` / `info`），见 6.3 |
| `feedback/clipboard`：`writeClipboard` | 复制：先用 Clipboard API，内网 http 下没有它或被拒绝时改用浏览器的复制命令；两条路都失败才提示「复制失败」。在点击处理函数里同步调用 |
| `focus-recovery`：`useFocusRecovery` | 焦点所在的元素被移走时的去向，见第 7 节；根路由挂载一次 |
| `shortcuts`：`useShortcut`、`ShortcutsDialog` | 见第 7 节 |
| `#/editor/inspector/ReferenceEditor`：`ReferenceEditor`、`InsertReferenceButton` | 可以写引用的文本输入框（CodeMirror 6 内核，只引入 `@codemirror/state`、`view`、`commands`）：输入 `$` 或点「插入引用」弹出补全，引用高亮成一块、整块删除，1 到 8 行自动增高；外观与 `Input` 一致。能写引用的字段都用它，不另写一套；`choices` 传 `null` 时是不能写引用的多行输入框（入口参数的默认值）。`$` 触发的补全不预选，方向键或鼠标选中后 `Enter` / `Tab` 才插入 |
| `#/editor/inspector/ReferencePicker`：`ReferencePicker`、`ReferenceChip` | 非字符串参数（数字、布尔、枚举、JSON）：「插入引用」按钮选一个引用作为整个值；值是整值引用时用引用标签代替类型控件，点 × 回到类型控件。没有「常量 / 引用」切换，显示什么由值决定 |
| `#/editor/inspector/ZoomEditor`：`ZoomEditor`、`ReferenceActions` | 字符串、JSON 字段的「放大编辑」：`Dialog` 里放大的 `ReferenceEditor`（等宽、补全、高亮）；修改直接走字段的 `onChange`，没有「保存 / 放弃」。能写引用的文本字段右侧的「插入引用」+「放大编辑」两个按钮用 `ReferenceActions`，不另写 |

## 6. 各状态的样式

### 6.1 状态语法（`components/status.tsx` 的 `STATUS`）

状态的颜色、形状、动效都在 `STATUS: Record<StatusKind, StatusLook>` 一张表里：`tone`（状态形状、描边、色块的颜色）、`text`（状态文字的颜色）、`mark`（8px 的状态形状）、`area`（有面积的色块：`tall` 满高还是矮一档、HTML 的 `box` 类、SVG 的 `svg` 类）、`pulse`（能否脉冲）。`StatusDot`、`StatusPill`、`ChainBar`、`RunLines`、`ScenarioThumbnail`、`SlotCell` 只读这张表；其他要画状态的地方（时间线区段、小地图、趋势柱）也从这里取，不另写颜色。

| kind | 用于 | 状态形状（8px） | 文字 | 面积色块 |
|---|---|---|---|---|
| `ok` | 成功、在线 | 绿色实心圆点 | `ok` | 矮；`ok-fill` |
| `running` | 执行中、准备中、发送中 | 青色圆点加外圈 | `signal-fg` | **满高**；`signal-fill` 底 + `signal-line` 描边 |
| `failed` | 失败 | 红色实心菱形 | `danger-fg` | **满高**；实心 `danger-fill` |
| `warn` | 等待中（定时 / Sleep）、警告（含关注项的异常）、安装中 | 琥珀实心三角 | `warn-fg` | **满高**；`warn-fill` 底 + `warn-line` 描边 |
| `pending` | 待执行、离线 | 灰色空心圈 | `fg-3` | 矮；空槽 `pending-fill` |
| `queued` | 排队中（在等 Agent 的槽位）、通知排队中 | 灰色半实心圈 | `fg-3` | 矮；空槽加灰色斜纹（SVG 里是空槽加灰色描边） |
| `skipped` | 已跳过 | 灰色斜杠圈 | `fg-3` | 矮；空心，`border-strong` 描边 |
| `cancelled` | 已取消、取消中 | 灰色虚线圈 | `cancelled` | 矮；空心，`cancelled` 虚线描边 |
| `stopped` | 已停止（子流程被停止子流程节点停止，不算失败） | 灰色实心方块 | `stopped` | 矮；`stopped-fill` 底 + `stopped` 描边 |

规则：

- **形状**：每种状态一个形状，用 currentColor 画在 8 × 8 的 SVG 里。红绿色觉缺陷时靠形状分辨；强制颜色模式下颜色换成系统文字色，形状照样在；「减少动效」时执行中没有脉冲，靠外圈与成功区分。
- **面积色块**：需要处理或正在发生的状态（执行中、失败、等待）满高，其余矮一档（链路进度 12 / 8px，缩略图节点上下各收进 1/8）。红色盲看来失败的红和成功的绿几乎同色，靠高度分开；形状相同的两种状态在正常视力与三种色觉缺陷模拟下色差都 ≥ 10（OKLab ΔE，`design-rules.test.ts` 检查）。
- **面积色只有 `-fill` 一档**：同一个状态在进度条、缩略图、时间线、趋势柱、小地图里深浅一样。
- **脉冲**：状态点默认静止。一屏内每个执行中的对象只在一处脉冲，取它的前沿：运行监控的详情视图是时间线上执行中区段的段尾脉冲头（每个执行中节点一个），外加顶栏的运行状态标签作为页面级的一处，概览视图没有时间线，执行中的节点（链路下面一行、读数、图表卡片）都不脉冲，只有顶栏的运行状态标签；列表页是每个执行中运行的状态标签；控制台是每个运行块（或紧凑行）的状态标签，线路的站、进行中的节点、Agent 列与场景列的状态点都不脉冲；时间线行标签、链路标签、切换运行按钮、图表分组头、「实时跟随」都不脉冲（「实时跟随」是视图状态，不是执行状态）。调用方用 `<StatusDot pulse>` / `<StatusPill pulse>` 打开（只对执行中生效）；不是状态点的元素（时间线段尾的脉冲头）加工具类 `pulse-ring`，它在元素自己的 `::after` 上画一圈当前色的光环，所以脉冲头要是真实元素，不能是伪元素。脉冲只动 `scale` 与 `opacity`，周期 `--pulse-period`，入口调用的 `alignPulses` 让新出现的脉冲对齐到同一相位。
- 状态文字的颜色在所有表面上 ≥ 4.5:1，状态形状与色块的颜色 ≥ 3:1（`design-rules.test.ts` 检查）。

**时间线区段**（`monitor/Timeline`）按同一套规则画，段的种类对应状态：完成 → `ok`、执行中 → `running`、失败的尝试 → `failed`、等待节点 → `warn`、排队等待 Agent → `queued`、已取消 → `cancelled`、已停止 → `stopped`，用 `STATUS[kind].area.box` 与 `tall`：

- 轨道 12px；矮段在轨道里垂直居中 6px（用 `clip-path: inset()` 或内层元素只改可见高度，点击与悬停的热区保持满高）。
- 完成是矮的 `ok-fill`；失败的尝试是满高实心红；两者相邻时在任何色觉下都靠高度分开。
- 执行中满高，段尾加一个真实元素的脉冲头（实心 `signal`，`pulse-ring`），是监控页唯一按节点脉冲的地方。
- 已取消是矮的空心虚线框（不再是斜纹）；排队是矮的灰色斜纹；等待是满高的琥珀底加描边，三者形状互不相同。
- 图例按同样的形状画。时间线轨道与图例色块加 `data-viz`（见 6.2）。

**时间轴的跨度**（`monitor/timeline-model.ts`）：运行中的轴不随「现在」每秒伸缩。跨度只取一级一级的固定值（10 秒起，到一天，相邻两级相差 25% 到 50%），取已用时长加 20% 余量后向上的那一级；「现在」线越过轴的 1 / 1.2 才扩到下一级，两次扩轴之间区段与刻度纹丝不动，只有「现在」线向右推进，扩轴时一次到位。已结束的运行按实际时长定轴，末端留 8% 的空白，短运行也铺满轨道。

### 6.2 强制颜色与高对比度

- **强制颜色模式**（Windows 高对比度）：浏览器换掉作者的颜色、去掉 `box-shadow` 与渐变。状态形状是 currentColor 画的 SVG，不用处理。`app.css` 的 components 层集中补其余的：`aria-current="page"`、`aria-pressed="true"`、`aria-selected="true"`、`data-state="selected"`、`selected-row` 换成 2px `Highlight` 内描边；数据图形（链路进度、线路、缩略图、时间线轨道与图例）加 `data-viz`，保留作者颜色并垫一块 `bg` 底（`forced-color-adjust: none` 只给这些颜色本身就是信息的地方）。开关用系统颜色画（`switch.tsx`）；输入框的焦点由 `focus:outline-hidden` 的透明轮廓在强制颜色下显示出来。新组件不要只靠底色或阴影表达状态。
- **更高对比度**（`prefers-contrast: more`）：`tokens.css` 末尾的加强档，见第 2 节。

### 6.3 空、加载、错误、禁用

- **空**：`EmptyState`——图标方块、14px 标题、说明（最宽 40em，居中）、下一步操作（按钮或 `CodeBlock` 命令示例），放在 `Panel` 里。
- **加载**：`TableSkeleton`（按表格列数画骨架，`role=status` 名称「加载中」）；不是表格的页面用与内容同形的骨架，Agent 管理页是 `RackSkeleton`（每台 Agent 一个面板：头部一行加一排槽位格）；首次加载才显示，后台刷新不闪；出现前先等 200ms，加载在 200ms 内完成时不闪骨架。
- **错误**：`ErrorState`——红色描边块，标题「无法加载 …」、原因、一行错误详情（`GET /api/agents → 503 code`）、「重试」与「复制错误详情」（含 details）。已有数据时后台刷新失败不替换页面。查询默认失败后再重试 2 次（间隔 1 秒），4xx 不重试（`src/router.tsx`）。
- **禁用**：40% 不透明、`cursor-not-allowed`，不换颜色。
- **通知**：见下面的「通知与横幅」。

**通知与横幅**。两者分工按信息要不要留在原处、要不要立刻注意：

| | 通知（`notify`） | 页内横幅（`Banner`） | 弹窗里的错误（`FormAlert`） |
|---|---|---|---|
| 用于 | 刚做完的操作的回执：已保存、已复制、已归档（带「撤销」） | 页面状态里需要立刻注意的事：运行失败、连接断开、数据可能过期 | 弹窗里的提交被服务端拒绝（重名、地址无效） |
| 位置 | 右下角（不盖住全屏页顶栏中间的运行状态与失败摘要） | 它影响的区域顶部，跟着页面滚动 | 弹窗里、提交按钮上方 |
| 消失 | 成功 / 信息 2.6 秒，警告 5.2 秒；失败的、带操作的（「撤销」）不自动消失，有关闭按钮 | 状态解除时由页面移除，不自己计时；`onDismiss` 只是收起 | 下次提交时清掉 |
| 读屏 | 通知区域「通知（Alt+T 跳到这里）」；Alt+T 把焦点移进去 | `announce` 时读一次（失败用 alert）；页面已有状态播报（运行监控的 `<output>`）时不要再开 | `role="alert"` |

- 通知里的信息在别处也要看得到：「撤销」在「已归档」里也能做，运行结果在监控页顶栏一直显示。列表里的移除是例外：就地移除的列表（可排序的列表，§7）把「撤销」放在列表上方原处，不进通知，因为键盘用户要能直接回到它。
- **运行失败不发通知**：运行监控页的详情视图在时间线上方显示页内横幅「运行失败」（带「查看失败节点」，可以收起，收起后失败摘要回到顶栏）；概览视图没有横幅，失败摘要一直在顶栏，点它切到详情并打开失败节点的「尝试」页签；成功与取消才在页面上看着结束时发一次回执通知。
- 弹窗打开时不发通知（会被遮罩挡住、读屏也读不到），错误写在弹窗里。
- 横幅颜色之外靠图标形状区分：失败八边形、警告三角、信息圆形。

### 6.4 表单与校验

- 提交按钮只在提交进行中禁用，不用禁用来拦校验：禁用的按钮不能聚焦，键盘和读屏用户不知道为什么点不了。
- 第一次提交之前不显示错误；提交时校验，失败就在字段下写明原因（`FormField` 的 `error`），焦点放到第一个出错的字段；之后随输入更新错误。必填字段标签后加中性的 `*`，控件带 `aria-required`。
- 服务端拒绝时用 `FormAlert` 写在弹窗里、提交按钮上方，弹窗不关闭，不发通知。
- 表单弹窗输入过内容后点遮罩不关闭（`Dialog` 默认如此），Esc 与「取消」照常关闭。
- 编排画布检查器里的字段没有「提交」：输入到一半不报错，字段第一次失焦（交互过）才显示错误，之后随输入更新；错误文字与控件用 `aria-describedby` 关联，读屏能读到。保存被字段错误拦下时把焦点放到最先出错的字段。
- 运行抽屉的入口参数表单（`run-drawer/TriggerForm`）是参照实现。

### 6.5 长文本、截断与列宽

- **标题不截成一行**：面板里的标题（卡片、检查器）最多两行，`line-clamp-2`；放不下的部分在详情页或悬停里看。
- **工具条里的标题、表格与列表里的名称**：用 `Truncate` 单行截断。真的被截断时，悬停或键盘聚焦都会用提示显示全文（只有 `title` 不行：键盘和触屏拿不到）；截断的是链接、按钮本身时传 `render={<Link …/>}`，提示跟着它的聚焦出现；普通文字被截断时自己可以 Tab 到。按钮里还有图标、徽标等别的内容、或者好几段文字都可能被截断时，传 `render` 和 `label`（提示里的全文）：按钮本身是触发器，里面的 `Truncate` 只截断，不再多一个可聚焦的元素和第二个提示，按钮上不再写 `title`。全文始终在 DOM 里，读屏、页内查找、复制拿到的都是全文，不在脚本里截字符串。
- **标识符保留结尾**：包名@版本、文件名这类最有区分度的在末尾，`Truncate keepEnd={n}` 让结尾 n 个字符始终可见、省略号落在中间。
- **标识符不折行**：等宽的标识符（包名@版本、地址、运行编号）不在连字符处折成两行，宁可截断；整段的路径、堆栈要换行时用 `overflow-wrap: anywhere`（`wrap-anywhere`），不用 `break-all`（它把普通单词也从中间切开）。
- **虚拟滚动的表格**（动作表）列宽固定（`table-fixed` 加 `<colgroup>`）：只渲染视口附近的行时，自动列宽会随滚动跳动。
- **列表表格的列宽**（`TableHead` / `TableCell` 的 `width`，DataTable 写在列的 `meta.width`）：编号、状态、进度、版本、触发人、时间、耗时、操作这类列用 `"fit"`（按内容收紧、不折行）；场景名、说明、错误信息这类列用 `"grow"`（吃掉剩下的宽度，里面用 `Truncate`），每张表只有一列 `"grow"`。宽屏上余量都给 `"grow"` 列，数值列聚在一起，不平摊到每一列。

### 6.6 浮层体系

浮层继续用 Base UI（Dialog、Popover、Menu、Tooltip）、cmdk、sonner，不迁移到原生 `<dialog>`、`popover`、CSS anchor positioning、`interestfor`（2026-11 设计评审的评估结论）：

- Base UI 已经做到原生 `<dialog>` 给的东西：页面其余部分对读屏不可见、焦点锁定、Esc 关闭、焦点归还（还能用 `finalFocus` 指定菜单项已经不在时的去处），菜单靠近视口边缘会翻转；`popover` 的声明式开关用不上（开关状态在 React 里）；anchor positioning 达不到碰撞翻转；`interestfor`、`closedby`、`focusgroup` 的浏览器支持还不够。改用原生要重写受控打开、`finalFocus`、退场动画，收益小于成本。
- 原生的几条行为在组件层吸收：表单弹窗输入过后不能点外面关闭（对应 `closedby="none"`，见 `Dialog` 的 `pointerDismiss`）；带操作的通知不自动消失；通知区域与命令列表用中文名称；进出场用 Base UI 的 `data-starting-style` / `data-ending-style` 加 CSS 过渡（作用同 `@starting-style`，退场等过渡结束再卸载，可以中途反向），不用关键帧。
- 以后真的改用原生 `<dialog>` / `popover` 的组件，再按原生方案加 `overlay` 与 `transition-behavior: allow-discrete`。

## 7. 键盘、焦点与快捷键

- 焦点环统一是 2px 青色外框（`:focus-visible`，在 `components` 层，第三方库的样式去不掉它），组件不要用 `outline-none` 去掉它（输入框改用青色描边 + 光晕，并用 `focus:outline-hidden` 给强制颜色模式留轮廓）。所有元素平时的 `outline-color` 就是焦点色（base 层），所以带 `transition-colors` 的元素聚焦时焦点环也是即时出现、不会先灰后青。
- 画布节点卡片的焦点环 `outline-offset` 是 3px：读作「框在卡片外面」，与执行中节点的青色描边区分开。
- 编排画布只有一个 Tab 停靠点：画布区域。进入后方向键沿链选中节点，焦点跟着移到节点卡片上；Esc 取消选中、焦点回到画布区域。节点卡片与连线都不进 Tab 顺序（React Flow 的 `nodesFocusable` / `edgesFocusable` 关闭）。顶栏控件在 DOM 里排在画布之前，工具条与检查器在画布之后。底部的画布工具条同样只有一个 Tab 停靠点：← → 在按钮之间移动，禁用的按钮不参与。
- 弹窗与抽屉用 `Dialog` / `Sheet`：锁定焦点、Esc 关闭、关闭后焦点回到原处；自己写的浮层也必须满足，并加端到端测试。
- **可排序的列表**（场景设置的「关注项」页是参照实现）：拖动手柄只服务鼠标（`aria-hidden`，不进 Tab 顺序）；键盘和读屏靠每行的「上移」「下移」按钮，到头的按钮用 `aria-disabled` 而不是 `disabled`（禁用的按钮不能聚焦，连按到头时焦点会掉出列表），焦点跟着被移动的那一项走，实时区域（`<output class="sr-only">`）播报「X 移到第 N 位，共 M 项」。移除后在列表上方原处给「撤销」，焦点移到它上面；撤销只管刚做的那一次移除。
- **焦点所在的元素被移走时**（归档、恢复、删除了它所在的列表项，空状态被列表替换），焦点不留在 body 上（`useFocusRecovery`，根路由挂载，不用逐页接）：它在列表项（`data-list-item`）里就交给下一项的主链接，没有下一项交给上一项；列表空了、或它不在列表项里，交给页面标题（`PageHeader` 的 h1）。弹窗、菜单关闭时焦点先回到打开它的元素，那个元素随后被移走也照这个规则处理。只管外壳页的主区域，全屏页（画布、运行监控）自己管焦点；用户自己点空白处让焦点离开时不处理。新增内容（登记了第一个机器人）后要把焦点放到新的那一项时，页面自己聚焦它。
- **快捷键注册表** `src/lib/shortcuts.ts` 的 `SHORTCUTS` 是唯一来源：快捷键面板（?）从它生成，页面用 `useShortcut(id, handler, enabled)` 绑定（`enabled` 为 false 时不绑定，键不被拦截）。新增快捷键先登记（分组「全局 / 编排画布 / 运行监控 / 列表页」、名称、按键、是否允许在输入框或弹窗中触发），再绑定；没有绑定的不要登记。写法：`Ctrl+K`（同时按）、`G D`（1 秒内依次按）；Ctrl 同时匹配 ⌘；默认焦点在输入框里或有弹窗打开时不触发。
- 不同页面分组（编排画布、运行监控、列表页）可以登记同一个键（画布与监控页的 `E`、`R`，画布与列表页的 `/`），因为它们属于互斥的路由：按键只匹配当前已绑定处理函数的那一个。「全局」的键不能与任何分组重复，同一分组内也不能重复（`shortcuts.test.ts` 检查）。
- **列表页行导航**（分组「列表页」）：场景列表（卡片与表格视图）、运行记录（进行中的卡片与历史表格）、节点包列表是「列表页」。`J` / `K` 把真实的键盘焦点移到下一项 / 上一项的主链接上（Enter 走链接本来的行为，不循环；焦点不在任何一项里时 J 去第一项、K 去最后一项），`/` 聚焦并选中搜索框的文字，搜索框里按 ↓ 进入第一项。实现基于 DOM、不保存状态：每项容器写 `data-list-item`、主链接写 `data-list-primary`，页面调用一次 `useListNavigation()`；搜索框用 `useSearchInput`（返回 `ref` 与 `onKeyDown`，`/` 与 ↓ 在里面接好）。焦点环就是全局的键盘焦点环；所在的行或卡片另加与悬停相同的中性强调（表格行 `has-[:focus-visible]:bg-fg-1/3`，卡片 `has-[:focus-visible]:border-border-strong`），只写在带 `data-list-item` 的行上，`selected` 样式留给真正的选中。Agent 页与飞书机器人页没有可打开的目标，不接入；导航键不是命令，不进命令面板。
- 登记时带 `palette: true`，这个快捷键在页面绑定期间同时是命令面板「当前页面」分组里的一条命令（名称、按键取自注册表，`PAGE_COMMAND_ICON` 给每个配图标，少一个编译不过）；`useShortcut` 的 `enabled` 同时决定键是否拦截、命令是否出现。`canvas-save` 一直绑定（无改动时 Ctrl S 说明「没有未保存的修改」，不让浏览器弹出另存为）。
- 界面上显示的按键也从注册表取，不写死：按钮提示用 `ToolButton shortcut="<id>"`、菜单项用 `ContextMenuItem shortcut="<id>"`、单独显示用 `<Keys shortcut="<id>" />`，写在文字里用 `shortcutText(id)`。`Kbd` 只接受注册表给出的按键文字（`KeyLabel`），写死的按键过不了类型检查。只说明怎么操作眼前控件、不算快捷键的按键（命令面板底部的「↑ ↓ 选择」）用 `KeyHint`，可用的键限定在 `OperationKey` 里。

## 8. HTTP 契约与数据获取

约定的完整说明在 `packages/schema/src/http/contract.ts` 顶部，要点：

- 每个接口在 `@sfly/schema` 的 `http/<领域>.ts` 中用 `endpoint({ method, path, client, key, params?, query?, body?, response })` 定义；数据 schema 用名词（`AgentView`），接口表用 `<领域>Api`（`agentsApi.list`）。SSE 用 `stream({ path, client, params?, query?, events })`，字节流下载用 `download({ path, client, params?, contentType })`。
- `client` 写明接口是否进入 API 客户端（`@sfly/client`，ADR 0022）：开放给自建页面的为 true，给 Agent、安装脚本、控制台自己用的和上传接口为 false。`pnpm gen` 从契约生成 API 客户端的类型和路由表。
- 控制面的**每个** HTTP 路由都在契约里：`httpApis`（`http/index.ts`）按领域列出全部接口表，`httpContract` 由它展开；控制面启动时 `guardHttpContract` 检查注册的路由与它一一对应，多一个少一个都启动失败。
- 响应 schema 用 `z.object`，不写 transform / default / coerce（生产环境前端不解析响应）；请求部分可以用。字段 snake_case，时间用 `Timestamp`。
- 控制面用 `contractRoute(app, agentsApi.list, handler)`（`apps/server/src/http/contract-route.ts`）注册，SSE 用 `contractStream`（只能发送契约里声明的事件），下载用 `contractDownload`：请求不符合契约返回 400 `invalid_request`（需要更具体的错误码时在契约里写 `requestError`，例如保存版本的 `base_version_required` / `invalid_document`），handler 的返回值受响应类型约束；控制面测试用 `xxxApi.yyy.response.parse(body)` 校验实际响应。
- 前端：`useQuery(apiQuery(agentsApi.list))`、`callApi(packagesApi.version, { params })`、`useEventSource(runsApi.events, { params }, handlers)`、`apiUrl(logsApi.download, { params })`（下载链接）。没有手写的接口函数和类型。query key 一律由 `queryKey()` 生成（`[...key, { params?, query? }]`），失效按领域前缀：`invalidateQueries({ queryKey: domainKey(packagesApi.list) })`。开发环境下响应不符合契约时抛出 `contract_violation`，页面显示为错误状态。
- 定时重新查询的间隔与搜索防抖只用 `src/lib/polling.ts` 的命名常量（`LIVE_POLL_MS` 等），不在组件里写数字；列表页的搜索框用 `useSearchInput`（`src/lib/use-search-input.ts`：本地输入、防抖后写进地址，地址变化时同步回搜索框）。
- 浏览器经 `/api` 前缀访问（docs/ARCHITECTURE.md §7），契约里的 `path` 不含前缀。
- 指标接口在 `http/metrics.ts` 的 `metricsApi`（摘要、目录、序列、平台自带图表）；实时增量是运行事件流上的 `metrics` 事件（`MetricIncrement`）。
- 一次运行的关注项读数在 `http/run-focus.ts` 的 `runFocusApi.focus`（`GET /runs/:id/focus?points=N`）：最新值、最终值（`final`）都在控制面算好，页面只显示；异常的判断也只在控制面做（`anomaly` 字段现在一律是 null），页面不自己判断。前端只用 `useRunFocus`（运行中每 `LIVE_POLL_MS` 读一次）。
- 一个任务的动作摘要在 `http/actions.ts` 的 `actionsApi.summary`（`GET /tasks/:id/actions/summary`）：正在做的、每种名称的总数和失败数、最近的失败都在控制面准备好，页面只显示。前端只用 `use-task-actions.ts` 的 `useActionSummary`（缓存只有一份：「动作」页连着推送时由推送更新；没连着、任务还在执行时按调用方给的间隔重新读，结束时再读一次——画布检查器每 `ACTIONS_POLL_MS`，不为它另开推送）。

## 9. 文案

界面只用中文，不引入 i18n 框架；多处共用的文字集中在 `src/lib/copy.ts`：

- `TERM`：术语（与 `GLOSSARY.md` 一致，「编排」只作动词）；`chainLabel()`：链实例名称（主链 / 子流程 X），手上只有子流程名称（主链为 null）时用 `namedChainLabel()`。
- `PAGE`：导航与页面名（侧边栏、面包屑、页面标题、命令面板）；`FOCUS`：关注项共用的句子；`INSPECTOR_PAGE`：检查器的页名（页签、页面标题，以及「先在场景设置的「关注项」页移除一项」这类指路的提示：都引用它，改名不会漏）。
- `RUN_STATUS_LABEL`、`CANCELLING_LABEL`：运行状态文字；节点状态文字在 `src/lib/node-status.ts` 的 `NODE_STATUS`（显示时都用 `components/status` 的 `runStatusView` / `nodeStatusView`）。
- `ACTION`：通用操作（运行、取消运行、强制终止、重试、清除筛选、展开、收起……）；`MESSAGE`：通用的加载 / 错误 / 空状态文字（含「还没有数据」「这次尝试没有上报数据」，`noMatch(X)`：筛选之后什么都没有的「没有符合条件的X」，日志、运行、动作共用）。
- 运行监控、运行抽屉与关注项读数用的：`MONITOR_VIEW_LABEL`（概览 / 详情两个视图的名称）、`FINAL_VALUE_LABEL`（最终值）、`FOCUS` 里异常的文字（`attention`「需要注意」，`logReason`、`staleFor`、`sourceFailed`、`retryReason` 四种原因的短句，`logDetail`、`staleDetail`、`noDataDetail`、`failedDetail`、`retryDetail`「需要注意」每行写清哪个节点、为什么，`dataUpdated`「数据更新于 HH:MM:SS」）、`LOG_LEVEL_LABEL`（日志级别的写法 DEBUG / INFO / WARN / ERROR，日志列表、级别筛选、运行抽屉和异常原因共用）与 `LOG_ALERT_LEVELS`（「WARN / ERROR」）、`MESSAGE.logsExpired`（日志已过保留期）、`chainCountLabel()`（「N 条链 · N 个节点」）、`LIST_LABEL`（列表的可访问名称：图例、各链进度、概览里执行中的节点、运行抽屉里进行中的节点）；`MESSAGE.noRunningNodes`（没有执行中的节点）、`MESSAGE.noActiveNodes`（没有进行中的节点）。概览只列在 Agent 上的节点（准备中、执行中，统称执行中）；运行抽屉列排队中、准备中、执行中、等待中的节点，标题和列表名用 `ACTIVE_LABEL`（进行中），不用任何一个节点状态名。控制台的运行块和运行抽屉一样列进行中的节点。「进行中」在运行记录页指运行（进行中的卡片），在运行抽屉和控制台指节点，在运行监控「动作」页的结果里指还没结束的动作，几处不在同一屏。
- `NODE_ACTIONS`：动作与标记（GLOSSARY「动作」「标记」）共用的文字：`doing`（「正在做」：画布卡片和读屏的「正在做 X」、检查器的「正在做」、「动作」页的第一组）；`runningIncomplete()`（「列满 N 个，可能还有没列出的」：正在做的动作列满了，检查器和「动作」页共用）；`results`（动作的结果：进行中、成功、失败、未结束、标记），是动作自己的一组状态文字，不是运行状态，不引用 `RUN_STATUS_LABEL`，「进行中」引用 `ACTIVE_LABEL`。「动作」页的文字在 `ACTION_PAGE`（工具条、三组的名称、表头里的 Agent 时间、只计数的一行里的起止、原因和失败的个数、读屏播报、跳到日志），列名和只计数那一行的主句写在 `ActionTable` 里；检查器的计数表表头和上限说明写在 `InspectorActions` 里，只在那里出现。术语「动作」是 `TERM.action`；`attemptLabel()`（「第 2 次尝试」，运行监控的尝试页签和画布检查器的动作区共用）；`PROGRESS_LABEL`（节点上报的「进度」，图表工作区、时间线、运行抽屉、画布检查器共用；运行记录表里的「进度」是各链进度，不是它）；`DOC_PAGE.sdkReference` 是开发文档「开发节点（SDK 参考）」的页名。和 `ACTION`（界面上的通用操作）不是一回事。
- 指向运行监控「详情」视图的写法：`MONITOR_DETAIL_LABEL`（「运行监控详情」：运行监控页之外的地方，如画布检查器，用它指路）、`openInLabel()`（「在详情里打开 fetch」「在运行监控详情里打开 fetch」：跳到这个视图里某个节点的按钮或链接）、`hiddenSeriesLabel`（图例里放不下的序列：概览是页内切到详情，写「在详情里查看」；检查器要去另一个页面，写「打开运行监控详情」）与 `ZOOM_IN_DETAIL_LABEL`（「要缩放，打开运行监控详情」）。
- 「打开 X」是去另一个页面（「打开运行监控」「打开失败节点」：控制台的失败行进入运行监控并选中失败节点），「查看 X」是在当前页面里展开（运行监控页横幅的「查看失败节点」）；同一个意思不换着说。
- 时长、数量与 Agent 状态：`ELAPSED_LABEL`（已运行）、`DURATION_LABEL`（耗时）、`moreLabel()`（「还有 N 个」：列表或线路只画出一部分时）、`AGENT_STATUS_LABEL`（在线、离线；Agent 的完整状态用 `#/agents/agent-status` 的 `agentStatusView`）、`slotUsageLabel()`、`queuedLabel()`（「2 / 8 占用」「排队 1」）、`RUNNING_PRIMARY_LABEL`（「执行中节点的主指标」）。
- `DOC_PAGE`：界面里引用的开发文档页名（与 `docs/guide/pages.json` 的标题一致）。

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
- 只动 `transform`（`translate` / `scale`）与 `opacity`；图表数据刷新、日志跟随、列表焦点移动都是瞬时的。唯一的例外是 SVG 连线的虚线流动（`stroke-dashoffset`：选中的连线、刚变成执行中的连线），连线没有 `transform` 能表达的位移。
- **减少动效**（`prefers-reduced-motion: reduce`）：去掉位移、缩放、视口平移和持续循环的动画，保留淡入淡出与颜色变化，状态信息不能只靠动画表达。不用全局把时长压成 0 的写法，按动效逐个处理，规则写在动效定义旁边：
  - 持续循环的动画只在 `prefers-reduced-motion: no-preference` 下启用：执行中的脉冲（`pulse-ring`）、骨架屏的明暗呼吸（`animate-pulse`）。静止时它们的形状已经说明了状态。画布选中连线的虚线流动不是持续循环：流动 2 个周期后停住，减少动效时不流动。运行状态下进入执行中节点的连线同理：静止的青色实线，只在一段连线刚变成执行中的那一刻（页面看着它变成执行中）流动 2 遍（`edge-enter`）后变回实线，减少动效时不流动；打开页面时已经在执行的连线是静止的。
  - 加载图标（`animate-spin`）放慢到 3 秒一圈，不停下来。
  - 浮层的进出场（`components/ui/overlay.ts` 的 `POPUP_MOTION`：Base UI 的 `data-starting-style` / `data-ending-style` 加过渡）只剩淡入淡出：缩放写在 `motion-safe:` 里，抽屉的位移由 `app.css` base 层清掉。进场 `--motion-base`、退场 `--motion-fast`；通知进出场 `--motion-slow`，堆叠时高度变化不做过渡。
  - 颜色、底色、描边的过渡照常。
- **暂停动效**（全站一个开关）：没开系统「减少动效」的人也能停掉持续自动运动（一盯几个小时的运行监控、控制台的「正在运行」）。键名 `sfly.motion.paused`（localStorage，`lib/motion-pause.ts`），状态写在 `<html data-motion="paused">`，`app.css` 据此停掉所有持续循环：执行中的脉冲（`pulse-ring`）、骨架屏的呼吸，加载图标放慢到 3 秒一圈而不停；执行中的形状（带外圈的点、段尾的脉冲头）照旧。画布运行状态里一次性的动效不受它影响：刚变成执行中的连线流动 2 遍就停，跟随执行的镜头平移是执行前沿变化时才发生，想停掉后者就关「跟随执行」。入口两处：运行监控顶栏的「暂停动效」按钮（运行中，或已经暂停时显示），命令面板的全局命令「暂停动效 / 恢复动效」；两处是同一个开关。
- **页面过渡**：只有「编排画布的运行状态 ↔ 运行监控」这一对入口做 View Transition（`lib/view-transition.ts`；`runViewTransition("to-monitor" | "to-canvas")` 传给 `Link` 的 `viewTransition`）：整页淡入淡出并朝前进的方向平移 12px（150ms），运行状态标签（工具类 `vt-run-state`）移动到另一页的位置（200ms）。全局路由切换与列表重排不做过渡；系统开了「减少动效」时不发起，直接切换。过渡的样式写在 `app.css` 末尾，按 type 区分。
