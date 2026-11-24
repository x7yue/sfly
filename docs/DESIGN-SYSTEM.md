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
| `src/lib/api.ts` | 契约调用 `callApi` / `apiQuery` | 见 §8 |
| `src/lib/shortcuts.ts` | 快捷键注册表（纯逻辑，有单测） | 见 §7 |

拉取新的 shadcn 组件：在 `apps/web` 下运行 `pnpm dlx shadcn@4.23.0 add <组件>`（配置在 `components.json`），然后**立刻按本规范改写**：把 `bg-popover`、`ring-foreground/10`、`shadow-md`、`text-base` 等换成下面的 token 与字号，去掉 `"use client"`，关闭按钮的 `sr-only` 文案改成 `aria-label="关闭"`，跑 `pnpm format`。缺少的组件（数字输入等）按同样风格自己写在 `components/ui/`。

## 2. 设计 token（三层）

组件**只引用第 2、3 层**。第 1 层不生成工具类；Tailwind 默认色板、字号、圆角、阴影已在 `app.css` 清空，写 `bg-red-500`、`text-xl`、`rounded-3xl` 不会生成样式。

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
| 动效 | `--motion-fast` 100ms、`--motion-base` 150ms、`--motion-slow` 200ms；`--motion-ease-out`（`ease-out`、`ease-standard`）、`--motion-ease-in`（`ease-in`）；`--pulse-period` | 见 §11；`transition-*` 不写时长与缓动时默认就是 base + ease-out |
| 滚动条 | `--scrollbar-thumb`、`--scrollbar-track` | `:root` 的 `scrollbar-color`；不设 `scrollbar-width` |

shadcn 组件用的 `background`、`foreground`、`popover`、`muted`、`accent`、`destructive`、`input`、`ring` 等名称映射到语义层；**注意 shadcn 的 `accent` 是中性悬停色，不是青色**，新代码直接用我们的名字。

透明变体（`-line`、`-soft`、`-fill`、网格线、遮罩）用 `color-mix(in srgb, var(<基础色>) N%, transparent)` 从同一个颜色派生，不抄写数值；`design-rules.test.ts` 直接从 `tokens.css` 算这些 token 叠在表面上的对比度。

`tokens.css` 末尾有 `@media (prefers-contrast: more)` 加强档：描边三级、控件边界、辅助文字、网格、连线、端口、选中外圈与滚动条滑块各加强一档，组件不用改。

工具类（`app.css` 的 `@utility`）：`selected-row`（`selected-bg` 底 + 左侧 2px 白条，表格、目录、列表的选中项和运行监控时间线上范围里的节点行都用它）、`focus-glow`（输入框聚焦光晕）、`pulse-ring`（执行中的脉冲，见 6.1）。

### 2.3 画布专用 `--canvas-*`

`canvas-bg`、`canvas-grid`、`canvas-node-bg` / `-border` / `-hover` / `-selected`、`canvas-port`、`canvas-edge` / `-selected` / `-travelled` / `-ahead` / `-dispatch`、`canvas-subflow` / `-fg` / `-line` / `-soft`、`canvas-annotation-panel` / `-panel-drop` / `-line` / `-chip` / `-chip-hover` / `-chip-fg` / `-note` / `-note-line` / `-note-fg` / `-fg-2` / `-swatch`（注释框，ADR 0025：比画布亮的底板加一圈淡描边、20px 圆角；框里三层明暗是注释框的备注（一张卡片）最亮、底板居中、节点卡片最暗；标题是框外左上方的同色胶囊；和紫色虚线、框里写标题的子流程区域分开。这几个 token 按注释框的颜色算出，写在 `[data-annotation-color]` 上而不是 `:root`：每种颜色是一个色相和一个色度系数，各部分在 OKLCH 里取固定的亮度，所以六种颜色亮度相同；颜色选择器的色块也带这个属性；`canvas-annotation-fg-2` 是底板上的次要文字，见下面的 `-done-*`），`canvas-run-done-bg` / `-done-border`（已完成、跳过、停止的节点下沉成只有轮廓的胶囊，不降文字对比度。按卡片所在的底色算，写在卡片上：`data-ground` 是所在注释框的颜色或画布，在子流程区域里另有 `data-ground-subflow`，再叠上区域自己的 `canvas-subflow-soft`（`--node-ground-tint`，和区域画的是同一个 token，框里的子流程也和区域分毫不差）。`-done-bg` 就是这层底色，`-done-border` 是 `fg-3` 混四成进底色的灰线（对底色约 1.8:1，屏幕上始终 1px），所以在注释框里既不会挖出一块最暗、最显眼的洞，也不会整个溶进底板、分不清哪里是站。注释框的底板比卡片亮，叠上子流程的淡紫后更亮：`fg-3` 在上面只剩约 3.6–4.3:1，`fg-2` 约 4.5:1，所以注释框里下沉的卡片（包括选中或悬停注释框时框里的非成员）的次要和辅助文字都换成 `canvas-annotation-fg-2`（按底板色相算，两种底上都 ≥ 5.3:1，仍比标题暗一档），框里子流程区域标题行的说明也用它）。状态色不在这一层：要盯的状态画在卡片描边、站外一行、进入它的连线上的颜色和站点灯的样子都取自状态表（`STATUS[kind].canvas`，见 6.1）、`--canvas-minimap-mask`（小地图视口外遮罩）。画布组件（#35 起）只用这一层和语义层。节点几何常量（卡片宽高、端口位置）由 #35 收敛为单一来源。

画布里的文字随缩放比例放大，屏幕上不小于最小字号，只有两档：数字与拉丁字母 11px，含中文 12px；卡片标题 14px，缩小视图时仍约 12px；卡片第二行、右侧的数字和标签 12px；注释框的标题平时 15px、缩小视图时不小于 14px，比卡片标题大一号，看全图时先读到阶段名；注释框的备注直接显示在框里最上方的备注卡片上（两行，缩小视图时一行），全文在检查器里看。写法固定用 `components/canvas/zoom-text.ts` 的 `ZOOM_TEXT_11`、`ZOOM_TEXT_12`、`ZOOM_TEXT_TITLE`、`ZOOM_TEXT_BAND`，不另写字号。

节点卡片（`components/canvas/NodeCard.tsx`，「站点胶囊」，DESIGN.md 的 Node Card）：
- **样子**：256 × 60、圆角 20 的矮胶囊，`canvas-node-bg` 底、1px `canvas-node-border`，悬停 `canvas-node-hover`。左边一盏 34px 的圆灯：编辑时是种类图标；运行时换成状态标记（`STATUS` 的形状），要盯的状态（执行中、失败、等待中）是状态色的淡底加描边，走完了的（成功、跳过、停止）贴着底色，还没轮到的（待执行、排队、取消）只有一圈描边。
- **两行字**：第一行是标题（14px 半粗）和右侧的数字——运行时是这次运行最要紧的那个数（有总数的进度 282/600、其余状态的耗时），编辑时是「N 警告」，版本对比时是差异标签。第二行只排一行：节点 ID（优先显示，运行时后面有失败原因或主指标时最多占这一行的六成；放不下时开头截断、结尾按 `_` 分段整段保留，最后一段很短时带上前一段，省略号落在中间；全文在悬停提示和读屏名称里）、配置摘要和原来的标题（有显示名称、且和显示名称不同时；排在最后、最多五个字宽，放不下或缩放低于 90% 时不显示）；放不下的项整个不显示，不剩半个字，运行时换成失败原因（错误的第一行，红字，去掉开头的异常类名，比如 `AssertionError: `；带类名的这一行在悬停提示和检查器里，多行错误的全文在运行监控里）、主指标的最新值与迷你趋势或「第 N 次尝试」；备注图标在第二行末尾。执行中的卡片底边有一条 2px 的进度线（有总数的进度时）。上边线外右侧是标签（always、另选的 Agent、重试 N），不压标题。编辑时的「N 警告」缩小视图时只留琥珀三角和数字。
- **运行状态**画在描边上：执行中青、失败红、等待中琥珀 `warn-line`；已完成、跳过、停止下沉成只有轮廓的胶囊：底色等于所在底色、一圈屏幕上 1px 的灰描边（见上面 `canvas-run-done-*`），已取消是 `border-control` 虚线；待执行、排队、跳过、停止、取消的标题换成次要文字色。状态文字不显示在卡片上（灯就是状态），读屏名称里接在标题后面。
- **正在做与关注项**（运行状态）：执行中的站第二行在节点 ID 后面写此刻正在做的事（`ActivityLine`：最外层开始得最早的动作和已持续多久，没有动作时是进度的说明；站点灯已经是执行中的形状），第二行已经有失败原因、主指标时另起一行。场景设了关注项时，关注项的个数贴在上边线外左侧（`FocusBadge`，和右侧的标签同一个样子），节点开始执行以后两行字下面列出前两项（`FocusRows`）。多出来的行让卡片按内容长高，灯和前两行留在原来的位置（端口按原高度放），子流程区域和注释框按量出来的高度算；缩小视图时这些行都隐藏，卡片回到原高度。
- **缩小视图**（语义缩放，缩放比例低于 65%）时字号不变、卡片变小，一行只够放标题：卡片只留站点灯、标题和底边的进度线，右侧的数字、第二行、标签都不显示，调度连线也不写「◆ 调度」。低于 40% 时进度线也收起，要盯的状态的灯放大到屏幕上 18px（失败是实心红灯），走完了和还没轮到的缩成屏幕上约 10px 的小点；要盯的状态的描边加粗到屏幕上 2px。看全图时只有要盯的状态显眼。
- **站外一行**：缩小视图时，执行中、失败、等待中的站在胶囊下方挂一行（屏幕上 12px），写这次最要紧的数：有总数的进度 `282/600`、「已运行 4m 16s」或失败原因（红字，去掉异常类名）。它和胶囊共用底色与状态描边、没有上边线，从标题的位置开始，最多约 16 个字宽，可以伸到右边一站的下面（一条链上相邻的两站不会同时要盯），越过子流程区域的下边框时盖住那一段。看全图时前面再写上标题（胶囊里只剩两三个字），所在子流程区域标题行右侧的运行状态隐藏，不重复。其余状态不挂；65% 以上第二行写得下，也不挂。
- 子流程区域和注释框的标题按底边放在框上方的留白里，字变大时往上长，不被卡片挡住。

运行状态下连线画成线路图（`FlowEdge.tsx`，状态来自 `editor/run-state/run-overlay.ts`）：两端都已完成的路段是「走过的」，`canvas-edge-travelled` 变亮、加粗到屏幕上 2px；还没走到的是 `canvas-edge-ahead`，比编辑时暗一档；进入执行中、失败、等待中节点的那一段着那个节点的状态色（`STATUS[kind].canvas.stroke`，和卡片描边同色：青、红、琥珀 `warn-line`），都是实线，不降不透明度。调度连线只在子流程还有实例在运行时是青色虚线，子流程结束（成功、失败、取消）或没有触发时连同「◆ 调度」标签一起变灰：青色只留给正在发生的事。编辑模式下连线不变。

注释框的画布操作（编辑模式）：
- **改标题**：双击框外的标题胶囊，或选中注释框后按 F2，原地改标题（`AnnotationTitleEditor`：样子和胶囊一样，Enter / 失焦确认，Esc 取消，清空等于不改）。
- **浮动工具条**（`CanvasToolbar.tsx`）：放在画布坐标里，按缩放比例反向缩放，屏幕上始终是原来的大小；按钮和底部工具条是同一种 `ToolButton`。
  - 选中注释框时，工具条接在标题胶囊后面：颜色（色块加下拉，点开是 `AnnotationColorPicker`）、排列成员（宫格 / 横向 / 纵向）、删除注释框（节点不动）。有子流程成员、或节点成员少于两个时没有排列。
  - 多选节点时，工具条贴在它们上方居中：新建注释框（Ctrl+G）和排列。节点落在注释框里、在子流程区域里时让到框的标题上方，不挡标题。
  - 拖动节点的过程中不显示工具条。
- **拖进 / 拖出**（`annotation-drop.ts`）：
  - 抓着的卡片中心落进哪个框（取最里面的），松手就加入它。拖动中那个框的底板亮一档、外面一圈中性的虚线，卡片下面的提示写着「松手加入「…」」。
  - 按住 Alt 拖动是从原来的框里拖出：框不跟着走，提示写「松手移出「…」」；拖出最后一个成员时写明注释框会一起删除。
  - 加入、移出和这次拖动合成一步撤销。

整理和查找：
- **删除节点之后**（Delete、Backspace、节点菜单、检查器的删除按钮；多选时是整组）：通知「已删除节点 X」（多个写「已删除 N 个节点」），按钮「撤销」就是撤销栈里的这一步，点了节点回来；之后又有修改（包括撤销、重做）时通知自动收起，「撤销」不会撤掉别的修改（`editor/undo-notice.ts`，整理布局之后的通知用同一个）。
- **整理布局之后**：通知问「保留整理后的布局，还是还原到整理之前？」，「还原」撤销这次整理，「保留」只关掉通知。整理之后又有修改（包括撤销、重做）时通知自动收起，「还原」不会撤掉别的修改。
- **按旧的卡片尺寸排的场景**（卡片从 208 宽改成 256 宽之前，整理布局的列宽是 252）：打开画布时有卡片叠在一起，通知「这个场景里有节点叠在一起」，「拉开」把所有节点的横坐标乘 300 / 252（`@sfly/orchestration` 的 `widenedPosition`），纵向和作者排的相对位置不变，是一步撤销、保存后才生效；不重新排，手排的布局不会没了。有了别的修改时通知自动收起。
- **大纲**（`editor/OutlinePanel.tsx`，工具条按钮或 O 键开关）：画布左侧的浮动面板，和右侧的检查器一样，底边让开小地图；它常压在节点上，底色不透明。
  - 不在注释框里的节点排在最前，每个注释框一组，可以收起；节点按画布上的阅读顺序（先上后下，同一行从左到右），一个节点在几个框里就在几组里出现。
  - 搜索按节点标题、节点 ID 和注释框标题；命中注释框标题时整组都留下。
  - 点节点：选中并定位到它；点注释框的标题：定位到框（放不下时缩小），编辑模式下同时选中它。定位和适配视图都避开大纲和检查器。
- **小地图**画出注释框：每个注释框一块它颜色的 `canvas-annotation-line` 底，排在节点下面（`MinimapAnnotations.tsx`）。

### 2.4 配色规则

- **白色是每屏唯一的主操作**：`<Button variant="primary">` 每屏最多一个（如「新建场景」）；其余按钮用默认（中性）或 `ghost`。Logo 与头像的白底不是操作。全新环境的控制台（「开始使用」）里，白色按钮跟着第一个没完成的步骤走：复制安装命令、新建场景、运行场景；发布节点包那一步在命令行里完成，没有白色按钮，只有开发文档「发布」的链接。
- **青色只用于执行中、键盘焦点环、调度连线**。不要用青色表示选中、链接或强调。
- **行内链接**（夹在一句话里的链接）：文字用 `fg-1`（比周围的 `fg-2`、`fg-3` 亮两档），一条 `fg-3` 的下划线，悬停时下划线变 `fg-1`；样式只写一处，`lib/inline-link.ts` 的 `INLINE_LINK`（容器里直接的 `<a>` 子元素用同一套的 `INLINE_LINK_CHILDREN`，`DialogDescription` 用它），不靠继承周围的文字色：周围是红字（出错说明）、灰字（辅助说明）时链接照样认得出来。中文的层级不靠 500，想让它更醒目改这一处（用 `fg-2` 的下划线，或 600）。按钮样子的链接（`Button`、`DocPageLink look="button"`）、表格里主链接的悬停下划线不是行内链接，不用它。**例外**：`monitor/QueueWaitNote` 里等宽字体的 Agent 名称和运行编号（排队中的节点在等什么）下划线用 `border-strong`、悬停 `fg-2`，不用 `INLINE_LINK` 的 `fg-3` / `fg-1`：它们是标识符，等宽的字体已经让它们和周围的字区分开，一句话里同时有几个标识符时不用再叠亮的下划线（这是有意留下的第三种下划线，改成共享样式前先看这一句）。
- **执行中的区段是淡底加描边，不是实心青色**：时间线段、链路进度段、场景缩略图节点、平台图表里的节点耗时条按状态表画（`STATUS.running.area`：`signal-fill` 底加 1px `signal-line` 描边），与成功、失败等色块同一量级。实心 `signal` 只给状态形状、时间线段尾的脉冲头和焦点环。
- **选中是中性高亮**：`selected-bg` 底 + 左侧 2px 白色短条（工具类 `selected-row`），画布上是 `BaseNode` 的两圈 box-shadow（卡片外先垫 3px 画布底色，再画 2px `selected` 描边，卡片自己的描边——执行中的青色、失败的红色——不变，和青色的键盘焦点环、执行中的描边分得开；青色的键盘焦点环再往外一圈，`outline-offset` 9px，键盘只会把焦点放在刚选中的节点上），强制颜色下 box-shadow 没有了，换成隔开一圈（`outline-offset` 3px）的 3px `Highlight` 轮廓，画在卡片外面（选中且键盘聚焦时轮廓换成焦点环，没有信息丢失：键盘只会把焦点放在刚选中的节点上）；`selected-ring` 只给注释框的选中光晕（`selected` 描边外一圈 4px，注释框是画布上一整块彩色的底，和节点卡片的两圈描边分开）、注释框成员的描边和框选矩形的底色；相关连线灰色虚线流动。文字选区是中性的 `selection-bg`。日志按时刻定位到的那一行同样用 `selected-row`（不用青色），没有正好对应的行时插入的「这一刻」是一行文字加一条中性细线（`border-strong`）。从控制台点读数进入概览时，属于被定位的节点的关注项同样中性高亮（读数用 `selected-row`，图表卡片的描边换成 `selected`），都带 `aria-current="location"`。
- 绿色 = 成功，红色 = 失败，**琥珀色只有三个意思：等待中（停止子流程节点等被停止的子流程结束）、警告、安装中**。关注项的异常（「需要注意」，四种原因里也包括来源节点失败）算警告，用琥珀三角加原因（`AnomalyNote`）；来源节点本身的状态形状不变，失败仍是红色菱形。排队中（在等 Agent 的槽位）是中性灰；点选日志行时时间轴上的定位线、被点选的日志行、节点的 `always` 标签这类不是警告的东西也不用琥珀（用中性的 `selected`）。
- 状态文字与图标用 `-fg`：`text-warn-fg`、`text-signal-fg`、`text-danger-fg`；不带 `-fg` 的 `text-warn` / `text-signal` / `text-danger` 只写在状态表（`components/status.tsx`）里，别处要状态形状的颜色时取 `STATUS[kind].tone`（`design-rules.test.ts` 检查）。
- **没有信号就不着色**：数值为 0 的计数（控制台页头的「失败 0」）、全零的趋势线用中性色。必填的星号（`*`）用中性 `fg-2`，红色只给错误。保存状态里只有需要处理的才带点（保存被拦截红、未保存琥珀），「已保存」是纯文字。
- **已停止**用中性灰实心小方块（画布卡片灰色描边、进度条与时间线灰色带描边的矮段），与已取消、已跳过区分：停止是场景的正常流程，不用警示色。
- **紫色只用于子流程区域**（`canvas-subflow*`），语义层没有紫色。
- **注释框的颜色是唯一不表示状态的彩色**（ADR 0025）：场景作者选的分类色，只画成注释框的底板、描边、标题胶囊和备注卡片，不用在节点卡片、连线和状态标记上。色板是灰（默认）、蓝、绿、黄、橙、粉，没有青、红、紫；六种颜色亮度相同、色度比状态色低，`design-rules.test.ts` 检查文字对比度和三层明暗。
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
| `text-base` | 14 / 20 | 区块与弹窗标题、空状态标题、命令面板输入、概览失败区域里的失败原因 |
| `text-lg` | 16 / 24 | 页面标题；关注项读数、图表卡片和运行监控数值卡里的最新值（等宽加粗）；概览失败区域里的失败节点名（加粗） |
| `text-2xl` | 22 / 28 | 运行的已运行时长（控制台运行块的右上角），全站唯一的大字号 |

  字号 token 用 rem（默认根字号 16px 下就是上表的像素值）：用户调大浏览器默认字号时文字与间距一起放大。不在 `html` 上设字号。

  原型里的非整档字号归并：12.5 → 13（正文、菜单、面包屑）、11.5 → 12（徽标、提示、字段说明）、10 → 11；15（弹窗标题）→ 14。
- 圆角只有 `rounded-sm` 4、`rounded-md` 6、`rounded-lg` 8、`rounded-xl` 12（另有 `rounded-full`），画布上的注释框和节点卡片是 `rounded-2xl` 20。小于 12px 的指示元素（进度段）用 2px。组件里不写色值、不用其他圆角任意值（`src/styles/design-rules.test.ts` 检查）。
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
| `Command` / `CommandDialog` | 命令面板（cmdk + Dialog，点遮罩随时关闭）；结果列表的无障碍名称是「结果」。**列表下面还有内容时底边渐隐**（`CommandList` 的 `data-more-below`，由 `lib/scroll-more` 的 `trackMoreBelow` 随滚动和内容变化加减，滚到底或放得下时没有）：滚动位置切在一行中间时那一行渐隐、提示还能往下滚，不再像被提示栏盖住；方向键选中的项滚到渐隐区上面（`scroll-pb-9`），滚到底最后一项完整露出 |
| `Tooltip` | 悬浮提示（根部已有 `TooltipProvider`，延迟 400ms）；在相邻触发器之间移动时新提示直接出现、旧提示直接消失（`data-instant` 不做过渡） |
| `Truncate` | 单行截断，见 6.5 |
| `Table` 系列 | 表头 12px 三级文字（不加粗），吸在最近的滚动区顶端（列表页是外壳的主区域），行进入视野时让开表头的高度；行悬停 3% 白；`data-state="selected"` 是 `selected-row`（与节点包列表、版本历史的选中项一致）。`scroll`：默认 `"none"`（不包滚动容器，表头才吸得住）；可能比容器宽的内容表格（文档里的表）传 `"x"`。列宽见 6.5。手写 `<table>` 由 lint 拦下（`biome-plugins/no-raw-table.grit`，只有 `components/ui` 例外） |
| `Kbd`、`Skeleton`、`Separator`、`Toaster` | 按键、骨架、分隔线、通知容器（右下角，见 6.3） |

### 应用组件 `components/`

| 组件 | 说明 |
|---|---|
| `app-shell/AppShell` | 外壳：侧边栏（导航来自 `navigation.ts`，可折叠，状态存 localStorage；项右侧平时是计数，悬停或键盘聚焦时在同一位置换成跳转快捷键 `Keys`，折叠后不显示）、顶栏（面包屑来自路由 `staticData.crumb`、Ctrl K 搜索入口、昵称） |
| `app-shell/overlays` | 全局浮层：命令面板、快捷键面板、昵称弹窗、运行抽屉、通知；`useOverlays().open("shortcuts")`、`useOverlays().open("run-scenario")`（只列「运行场景」一组的命令面板，控制台的「运行场景」按钮用它）、`useOverlays().runScenario(场景)` |
| `app-shell/CommandPalette` | 「当前页面」「跳转」「场景」「运行」（最近的运行）「运行场景」（打开运行抽屉）「命令」六组。「当前页面」是当前页面已绑定、并在注册表里带 `palette` 的快捷键（取消运行、保存……），名称与按键取自注册表，页面状态变了（运行结束、没有失败节点）就自动出现或消失，为空时整组不渲染；其余命令加在 `commands` 里。`scope="run-scenario"` 时只列「运行场景」一组，在里面按 Ctrl K 切成完整的命令面板 |
| `page`：`Page`、`PageHeader`、`Panel`、`SectionHeading`、`Keys`、`CodeBlock` | 页面版式；`PageHeader` 固定一个控件高（有没有右侧按钮标题都在同一位置），标题 h1 可以被程序聚焦（焦点去向的兜底，见 §7）；`Panel` 用 `overflow: clip` 裁圆角，不是滚动容器（里面的表头才能吸顶）；`Keys keys="Ctrl+K"` 显示按键；`CodeBlock` 带复制 |
| `doc-page-link`：`DocPageLink` | 指向开发文档某一页的链接，界面里去开发文档都用它：`page` 是 `DOC_PAGE` 里的 slug，链接文字缺省是页名；`look` 是 `inline`（正文里的行内链接，缺省，样式是 2.4 的 `INLINE_LINK`）或 `button`（ghost 小按钮，同 `PanelLink`：控制台「开始使用」的标题行和步骤） |
| `#/dashboard/DashboardPanel`：`DashboardPanel` | 控制台的面板：标题行（标题、计数、右侧操作）加内容，以标题作区域名称；「开始使用」和实况墙的最近结束、Agent、场景共用 |
| `#/docs/Markdown` | 用户文档（ADR 0013）的 Markdown 渲染：代码块用 `CodeBlock`（```prompt 代码块是给人读、复制给 AI 编程助手的提示词，自动换行、正文字体；其余代码块不换行），表格用 `ui/table`，`<slug>.md` 链接换成文档页 |
| `status`：`STATUS`、`StatusPill`、`StatusDot`、`runStatusView`、`nodeStatusView`、`alignPulses` | 状态语法，见 6.1；运行 / 链 / 节点状态的种类与文字只从 `runStatusView`（含「取消中」）与 `nodeStatusView` 取，颜色、形状、动效只从 `STATUS` 取，不另写映射表。节点状态在各处的显示规则（种类、画布运行状态、时间线、是否算已完成）集中在 `src/lib/node-status.ts` 的 `NODE_STATUS` 一张表里，新增节点状态只改这张表 |
| `slot-cell`：`SlotCell`、`IdleSlots`、`idleSlotCount`、`taskChainLabel`、`slotLabel` | 槽位格：Agent 上一个被占用的槽位（带文字的容器，圆角 8px），写节点（`NodeName`）、场景、运行编号、所在链（主链或子流程名）、尝试号、节点类型和已执行时长；描边与文字色取自 `STATUS` 的执行中（只取描边，底色用 `raised`），状态形状是 `StatusDot`，还在准备（`dispatched`、没有开始时间）的任务时长处写「准备中」。放在 `<ul>` 里，每个槽位格是 `<li>`，可访问名称是「节点 …，场景 …」，调用方在底部追加内容（`children`）时用 `summary` 把要点补进名称。连续的空闲槽用 `IdleSlots` 合并成一行矮条（空闲是能接新任务的 Agent 上没被占用的槽位，`agent-status` 的 `acceptsTasks`：在线、已准备好环境、版本与控制面一致；离线、准备环境中、版本不一致或更新中的 Agent 不画矮条，见 `AgentRack` 一行），网格设 `items-start`，矮条不随旁边的格子拉伸。系统里没有槽位身份，格子不写「槽 1」这样的编号。Agent 管理页的机架（`#/agents/AgentRack`）通过 `TaskSlot` 用它；控制台的 Agent 列用紧凑形式（`compact`，`IdleSlots` 同样传 `compact`）：一行写节点、场景、子流程名和已执行时长，圆角 6px，不写运行编号、尝试号和节点类型（运行块里有），也不放关注项的数值和正在做的动作（关注项只在左栏出现：运行块的读数，和最近结束里失败的运行的最终值；正在做只在 Agent 管理页的槽位格和画布卡片上） |
| `#/agents/AgentRack`：`AgentRack`；`#/agents/PreparingBadge`：`PreparingBadge`；`#/agents/agent-status`：`agentStatusView`、`updateStatus`、`acceptsTasks` | 一台 Agent 的机架面板（`Panel`，名称是 Agent 名称）：头部一行是状态（`agentStatusView`，控制台 Agent 列的名称行用同一个）、名称、版本、系统、对外地址、最后在线，右侧是被引用的场景数和「立即更新」，更新、时钟偏差、能力不可调用、节点包安装失败这些告警跟在状态后面，放不下时头部换行；主体是 `SlotCell` 网格（`auto-fill`，最窄 300px）和排队的任务（写排队了多久、多久后排队超时，`queueTiming`）；接不了新任务的 Agent（`acceptsTasks` 为 false：离线、准备环境中、版本不一致或更新中，和控制面派发的条件一致）槽位不算空闲：不画空闲矮条、不写「N / M 占用」，还占着槽位的任务照常列出，一个都没有时槽位一栏整个不画；准备环境中写「准备环境中 · 2m 10s」（`PreparingBadge`，控制台 Agent 列的名称行也用它）；底部是节点包与能力的小字 |
| `#/agents/TaskSlot`：`TaskSlot` | Agent 管理页的槽位格：`SlotCell` 加两样东西。**正在做**：一行（`sunk` 底，嵌在 `raised` 底的格子里），动作写「正在」加名称，右侧是已持续多久（`components/elapsed` 的 `Elapsed`，画布卡片上同一行也用它）；画布卡片上站点灯已经是执行中的形状，那一行不再画形状，格子放得下就写出来；没有动作时只写进度的说明，不写「正在」、没有时长；不在执行中的任务（准备中）没有这一行。取法只有 `actions/current-activity.ts` 的 `currentActivity`（和画布节点卡片同一条规则）。**关注项**：来源是这个任务的前两项（`focus/focus-preview.ts` 的 `focusPreview`，按读数的顺序取前两项：控制面已经把有异常的排在最前，这里不再排；画布节点卡片用同一个函数），每项一行，用 `#/focus/FocusRows` 的 `slot` 放法（画布节点卡片是同一个组件的 `card` 放法）——有异常的行首是 `AnomalyMark`，名称（`Truncate`）、最新值（`FocusValue`，12px、不加粗；图表有多个序列时先写序列名；图表在节点包版本里不存在时值的位置写「这个版本的节点没有图表 X」，不显示数值）、右侧是多久前（`readingWhen`，只有「2s 前」用等宽，最终值、没有值的原因是中文说明，不用等宽）或异常的原因（`warn-fg`，`anomalyText`）；多出的写「还有 N 个关注项」（`FOCUS.moreItems`）。场景没设关注项时是这个节点的主指标（名称前写「主指标」），右侧写「场景没有设置关注项」（`FOCUS.noneSet`，有异常时写异常的原因）；关注项读不到时写「无法加载关注项」。可访问名称在「节点 …，场景 …」后接「正在做 X」和「N 项需要注意：名称 原因；…」（有几项异常写几项，不只是显示出来的两项）。读数（`GET /runs/:id/focus?points=0`）由页面按运行读好再分给各个槽位（`agents/use-slot-focus.ts`），同一个运行的几个槽位只读一次；读数按「来源是这个任务」分（一个子流程在一次运行里最多一个实例，节点只有一个来源任务）；内容怎么算在 `agents/slot-content.ts`（纯函数，有单测）。控制台的 Agent 列（紧凑形式）不显示这两样 |
| `note-icon`：`NoteIcon` | 备注图标：悬停或键盘聚焦时在提示里显示备注全文（保留换行；长备注不超出视口，在提示里滚动：鼠标用滚轮，键盘用 PageUp / PageDown / Home / End）。页面上它是按钮，可以 Tab 到，名称「备注」、描述是全文；画布上节点卡片不在 Tab 顺序里，图标放在卡片里时传 `host`（卡片的选择器）和 `textId`：图标本身不可聚焦、对读屏隐藏，键盘用户靠卡片的键盘焦点看到提示，读屏用户在卡片的描述里读到备注。大小按所在文字的字号（em），不随画布缩放的提示固定 12px；节点卡片、运行监控页的图表组标题都用它，不另写一套 |
| `chain-progress`：`ChainBar`、`ChainBars` | 各链进度条：每个节点一段竖向短段（运行记录、运行抽屉；每段的颜色、描边与高低取自 `STATUS[kind].area`）；「2/3」这样的计数用 `chainProgressText`，进度条、线路的计数和读屏名称都用它；有被跳过的节点时（失败之后不再执行的节点）单独计数，不算已完成：运行记录的卡片和运行抽屉用 `ChainProgressCount`（「2/3 · 跳过 1」），线路里叠成两行，读屏名称接上「，跳过 1」（`chainProgressName`） |
| `run-lines`：`RunLines`、`RunLineThumb`、`foldStations`、`layoutLines` | 线路：一个运行的每条链画成一条线，节点是站（`StatusDot`，状态只从 `STATUS` 取），站名写在点下面，右边是「已完成数 / 节点数」，有被跳过的节点时下面一行单独写「跳过 N」（被跳过的节点没有执行，不算已完成，`chain-progress` 的 `chainSkippedText`）；进入执行中节点的那一段是 `signal-line`，其余是 `border-strong`；子流程从触发它的异步任务节点那一列分出，分支竖线是调度连线的青色虚线（`signal-line` 虚线）。所有行共用一套列（CSS subgrid），同一条链分出的几条子流程列靠右的排在前面，分支竖线不会穿过别的线。超过 7 个节点的链按 `foldStations` 折叠：只画当前站（进行中的节点，没有时是第一个待执行的节点）前面最后一站、当前站和之后两站，其余折成「已完成 N 个」「已跳过 N 个」「已取消 N 个」「还有 N 个」（点是这一段最后一个节点的状态；已跳过、已取消不折进「已完成」），失败的节点总是画出来。站名的几列（每列最宽 14rem，宽度不够时收窄到 0，和以前一样截断站名；列数多（子流程从靠后的列分出）时线路也不会伸出运行块）用上整行的余量，放不下的站名截断在末尾、悬停看全名，右边的计数在最后一列（auto）里始终有位置（`dashboard.spec.ts` 守着）。链名那一列默认取这块里最长链名的宽度（最宽 10rem）；控制台上下排着几个运行块时，各块传同一个 `labelWidth`（`labelColumnWidth`：按这些块里（只算画成运行块的，收起成一行的运行不算）最长的链名估一个宽度，是估算，估少了链名末尾省略、悬停看全名），线路才从同一个横坐标开始，不因为「主链」和「子流程 监控」错开（`dashboard.spec.ts` 守着）。`RunLineThumb` 是一条链的缩略（只有点和线，折起来的一段是一截虚线），读屏读作「主链 5/10」。控制台的运行块与紧凑行、运行监控的概览用它 |
| `#/dashboard/*`：`RunningRuns`、`RunBlock`、`CompactRunRow`、`EndedPanel`、`AgentsPanel`、`ScenariosPanel`、`PanelLink`；`wall-rules` 的 `wallLayout`、`readoutCells`、`readoutPlan`、`agentColumn` | 控制台的实况墙：左栏是正在运行的运行块（场景、版本、运行编号、触发人与开始时间，右上角 22px 的已运行时长；线路；读数区；进行中的节点那一行；打开运行监控、在画布中打开、取消运行）和最近结束，右栏是 Agent 列（槽位格的紧凑形式，数据是 Agent 列表接口，与 Agent 管理页共用查询缓存）和场景列。**读数区**：场景设了关注项时是一排关注项读数（`FocusReadoutStrip`，数据是 `GET /runs/:id/focus?points=0`），标题行写「关注项 N · M 项需要注意」（`#/focus/FocusTally`，琥珀色，没有异常时不写；画布概况的关注项标题同一个写法）和「调整关注项」；按读数区的实际宽度放 3 或 4 格读数（`readoutCells`，另有「还有 N 个关注项」那一格，读数和它每格至少 140px：1440 的窗口里 4 格，1280 的窗口里 3 格；宽度用 `lib/use-element-width` 量运行块的内容宽度，不看窗口宽度），有异常的总在可见的格子里（比格数多时全部显示，`readoutPlan` 同时给出排几列），其余写「还有 N 个关注项 · 打开概览」（`FOCUS.moreItems`）；点一格进入运行监控概览并定位到它所在的节点（`view=overview&node=`，概览里属于这个节点的关注项标出位置：`aria-current="location"` 加中性高亮，第一项滚进视野），点「还有 N 个关注项」进入概览。没设关注项时是执行中节点的主指标，排法、点按和「N 项需要注意」都和关注项一样（同用 `readoutPlan`），最后一格写「还有 N 个主指标 · 打开概览」（`FOCUS.morePrimary`），标题行写「场景没有设置关注项 · 设置关注项」（`FOCUS.noneSet`）。没有可显示的读数时保留标题行和入口，写原因（`MESSAGE.noPrimaryMetric`、`MESSAGE.noRunningNodes`、`FOCUS.noneInRun`）；读取失败写「无法加载关注项」（同 Agent 槽位格）。最近结束里失败的运行在错误信息下面带关注项的最终值（场景现在的关注项，最多 4 项：3 项一行，4 项两行两列；只读，不可点）。数量多时按 `wall-rules`：3 个以上运行时进行中的节点和读数只放前 2 项（有异常的加上前两项），6 个以上运行时运行块换成一行一个的紧凑行（整行是展开按钮，展开后焦点在「收起」上，收起后回到这一行；紧凑行不取读数），Agent 超过 5 台时只列忙碌、接不了新任务（`acceptsTasks`）、不是「在线」状态的，其余合并成「N 台空闲」。右栏两列都有加载骨架和错误状态；没有 Agent 时写「还没有 Agent 连接」和去 Agent 管理页的链接，没有可列的场景（还没新建，或都已归档）写「没有场景」 |
| `sparkline`：`Sparkline` | 迷你趋势（主指标） |
| `elapsed`：`Elapsed` | 已持续多久（`lib/format` 的 `formatElapsed`：一分钟以内只写整秒，`2s`、`2m 10s`），按控制面时间每秒刷新，只这一小块重新渲染：节点卡片和 Agent 槽位格上的「正在做」、动作表里进行中的耗时都用它。每秒刷新的时长（运行块的已运行、进行中的节点、准备环境中、排队了多久、关注项的「多久前」）一律用 `formatElapsed`；`formatDuration`（`12.3s`）只给定值的耗时（动作耗时、运行结束后的耗时） |
| `#/focus/FocusReadout`：`FocusReadout`、`FocusReadoutStrip` | 关注项读数：一个关注项（没设关注项时是执行中节点的主指标）的一格读数，从上到下三行——来源节点的状态形状（`StatusDot`）和名称（最多两行）、最新值和单位（`FocusValue`：等宽 16px 加粗，累计值就是当前累计，平台不算速率；图表有多个序列时先写最近更新的那条的名字）、「来源节点 · 多久前」（来源节点写成「显示名称（节点 ID）」，没有显示名称时只写节点 ID；有值时来源节点成功、已停止或已取消写「最终值」；没有值时写原因：来源节点还没有开始执行（待执行、排队中、准备中、已跳过，以及没开始就失败、已取消、已停止的）写这个状态没有执行的原因（`NODE_STATUS` 的 `notRun`，如「还没有开始执行」「已跳过，没有执行」），已经开始但还没有点写「还没有数据」，尝试已经结束仍没有点写「这次尝试没有上报数据」；运行已经结束、来源节点一直待执行（没轮到它，或子流程没有触发）写「这次运行没有执行」，可访问名称里的状态写「未执行」（`NOT_RUN_IN_ENDED_RUN`，和画布运行状态同一个词；调用方传 `runEnded`，画布节点卡片的行（`FocusRows`）和检查器的图表也传）（这几句由 `lib/copy.ts` 的 `noDataLabel` 给出，运行监控详情的图表工作区用同一个函数）。有没有值只在 `focus-format.ts` 的 `readingState` 判断，脚注、可访问名称和图表卡片的空状态共用）；图表在节点包版本里不存在时写「这个版本的节点没有图表 X」（`FOCUS.chartMissing`，句子来自 `@sfly/schema` 的 `focusChartMissing`；场景设置的「关注项」页也用它），不显示数值，脚注只写来源节点。**读数之间只用 1px 分隔，不套卡片**：`FocusReadoutStrip` 默认按宽度自动排成几列（每格至少 11rem），调用方给 `columns` 时是这么多等宽的列（控制台按运行块的宽度放 3 或 4 格），`trailing` 是排在最后、和读数一样占一格的内容（「还有 N 个关注项 · 打开概览」）；换行后每一行的分隔线也一样；外框由调用方的 `className` 决定。整格可点时用 `render` 换成按钮或链接，悬停是 3% 白（与表格行一致），可访问名称写明名称、最新值、来源节点和状态，以及多久前、最终值或没有值的原因（「母单量 1.3M 单，来自 load（执行中），2s 前」）。「多久前」按读数的 `generated_at`（控制面时间）算，不随浏览器时钟跳动。**有异常时**（异常只由控制面判断，见契约 `FocusAnomalyKind`）第三行换成琥珀三角和原因（`AnomalyNote`），可访问名称最后写「需要注意：原因」；没有新数据时最新值退成 `fg-2`（`FocusValue` 自己按控制面给的 `stale_since` 判断，和报哪一种异常无关，读数、图表卡片、槽位格和画布检查器的图表都用它，画布卡片的行用同一个判断）。概览、画布运行状态检查器的概况（全部关注项，每格是按钮，点了选中所在的节点）、控制台的运行块和最近结束的失败行用它；只放得下几项的地方（节点卡片、Agent 槽位格、控制台的运行块）取哪几项用 `#/focus/focus-preview` 的 `focusPreview(items, limit)`（读数由控制面排好，有异常的在最前，前端不再排）；去场景设置「关注项」页的入口是 `#/focus/FocusSettingsLink`（概览和运行块共用）；数据一律来自 `#/focus/use-run-focus` 的 `useRunFocus`（`GET /runs/:id/focus`），不另拼指标查询 |
| `#/focus/FocusTally`：`FocusTally` | 关注项标题后面的项数和「· N 项需要注意」（`focus-preview` 的 `countAttention` 数有异常的项，含没显示出来的；`FOCUS.attentionCount`，琥珀色，没有异常时不写）：控制台运行块的读数区和画布概况的关注项共用，主指标时不写项数。卡片和槽位格可访问名称里的「N 项需要注意：原因」由 `focus-format` 的 `attentionSummary` 拼 |
| `#/focus/FocusSettingsLink`：`FocusSettingsLink` | 去场景设置「关注项」页的链接（画布路由的 `?settings=focus`，眼睛图标加文字）：设了关注项是「调整关注项」，没设是「设置关注项」（`FOCUS.settingsLink`）；运行监控概览和控制台运行块的读数区标题行右侧共用 |
| `#/focus/FocusChart`：`FocusChart`；`#/focus/FocusPlot`：`FocusPlot` | 概览里图表类关注项（折线、面积、柱状）的卡片：状态形状和名称、最新值（`FocusValue`）、「来源节点 · 多久前」、按容器的实际尺寸画的图（`FocusPlot`：绘图区和图例，画布运行状态检查器里的图表也用它，高度由调用方给）（SVG 用测量到的像素宽度，文字不被拉伸；**纵轴从 0 起**，不把正常的小波动画成大起大落，上限包含每个桶的最大值；横轴是来源节点这次尝试的开始到结束，还没结束就到读数生成的时刻）、多个序列时的图例（线色与线型沿用 `MetricChart` 的 `seriesColor`、`seriesDash`；超过 10 个序列时只画平均值最高的 10 条并写明还有几条；挑好以后保持不变，读数刷新、平均值的排名变了也不换，只在出现新序列时重新挑，与详情的图表同一个 `pickShown`）和「在详情里查看 <节点>」（`Button variant="link"`，同一页里切到详情，写「查看」）。文字格式在 `focus-format.ts`（值和序列名的写法来自 `@sfly/schema` 的 `focus-reading.ts`），几何在 `focus-chart.ts`（纯函数，有单测）。有异常时「来源节点 · 多久前」一行换成 `AnomalyNote`（原因后面接「 · 来源节点」）；**无新数据**（控制面给了 `stale_since`，和这一项报哪一种异常无关：先有 WARN 再不上报时原因写 WARN，图照样画斜线）时曲线停在最后一个点，之后到现在画斜线（`border-strong` 的 45° 细线，`focus-chart.ts` 的 `plotChart` 给出这一段），斜线旁用 `warn-fg` 写「已 2m 10s 无新数据」，图的可访问名称后面加「曲线停在最后一个点」。这段斜线只在图表的绘图区里表示没有新数据，不是状态色块，和 6.1 里排队中的灰色斜纹（进度段、时间线）不在同一种元素上 |
| `canvas/CardFocus`：`FocusBadge`、`cardFocusLabel` | 画布运行状态下节点卡片上的关注项（场景设了关注项时）：`FocusBadge` 是卡片上边线外左侧的眼睛图标和个数（和右侧的标签同一个样子），卡片的可访问名称接上「N 个关注项，M 项需要注意：原因」（`cardFocusLabel`：卡片上的三角旁边放不下原因，原因写在名称里，悬停一行也能看到；图表在节点包版本里不存在的项再接上「这个版本的节点没有图表 X」，卡片上这一行没有数值）。节点开始执行以后，两行字下面列出前两项（`#/focus/focus-preview` 的 `focusPreview`，按控制面排好的顺序：有异常的在前，带 `AnomalyMark`），用 `#/focus/FocusRows` 的 `card` 放法画（`aria-hidden`，用图表自己的标题（「CPU」）而不是场景起的名字，图表不存在时值的位置写原因），多出的写「还有 N 个关注项」；来源节点成功、已停止或已取消后控制面不再判断异常，只剩最终值。卡片按内容长高，子流程区域、注释框和跟随执行按量出来的高度框。**场景没设关注项时**，执行中节点的主指标有异常（读数里这个节点那一项，`focus-preview.ts` 的 `nodePrimaryItem`，判断只在控制面）：主指标槽里数值前画 `AnomalyMark`，卡片的可访问名称接上「1 项需要注意：主指标 level 原因」（`cardFocusLabel` 的 `primary`，写法和槽位格一致），没有眼睛图标和个数；没有异常时卡片不变 |
| `#/focus/FocusRows`：`FocusRows` | 紧凑的关注项行：只放得下前几项的地方（画布节点卡片、Agent 槽位格）共用，取哪几项用 `focusPreview`。每项一行：有异常的行首是 `AnomalyMark`，名称、最新值（`FocusValue`，没有新数据时退成 `fg-2`）；图表在节点包版本里不存在时值的位置写「这个版本的节点没有图表 X」（`FOCUS.chartMissing`），不显示数值，卡片和槽位格写法一致；最后一行是「还有 N 个关注项」。`variant` 是两种放法：`card`（只给眼睛看，容器 `aria-hidden`，名称是图表标题，文字直接截断、悬停一行看完整的读数，数值靠右，字号跟画布的语义缩放）和 `slot`（读屏要读，名称是关注项的名称、主指标前写「主指标」（`focusItemTitle`），文字用 `Truncate`，右侧是脚注：异常的原因，没有异常时是多久前，主指标写「场景没有设置关注项」）。容器的样式、`aria-*`、`data-testid` 由调用方给。别处不再另写关注项的行 |
| `#/focus/AnomalyNote`：`AnomalyMark`、`AnomalyNote` | 关注项的异常：`AnomalyMark` 是琥珀实心三角（状态表的 `warn`，不另写颜色），只是形状，旁边必须有写明原因的文字，或者原因写在所在元素的可访问名称里；`AnomalyNote` 是三角加原因（`warn-fg`，12px），原因的短句由 `focus-format.ts` 的 `anomalyText` 给出（「1 条 WARN · 10:58:41」「已 2m 10s 无新数据」「来源节点失败」「重试（第 2 次尝试）· 10:41:02」，文字在 `lib/copy.ts` 的 `FOCUS`）。异常同时用形状和文字表达，色觉缺陷和强制颜色模式下也分得出；读数、图表卡片、「需要注意」（`#/monitor/Attention`）都用它们；别处显示关注项的异常时也用这两个，不另画三角 |
| `#/actions/InspectorActions`：`CurrentActions`、`ActionArea` | 画布运行状态检查器里的「正在做」和「动作」区，数据来自 `useActionSummary`（`GET /tasks/:id/actions/summary`，节点执行中每 `ACTIONS_POLL_MS` 重新读取，结束后再读一次）。显示最近一次开始执行的尝试的动作（重试的新尝试还在排队、准备时，上一次的动作和失败还在），节点重试过时「动作」标题旁写这是第几次尝试。**「正在做」**：只在尝试执行中画；正在进行的动作按层级缩进（最多 3 层，更深的画在第 3 层；缩进读屏读不出来，子动作的名称前有一句只给读屏的「子动作：」），写名称、字段（`key=value`，放不下截断，悬停看全文）和已持续多久（`elapsed` 的 `Elapsed`）；列满 50 个时（`running_complete` 为 false）写「列满 N 个，可能还有没列出的」（N 取列表的个数）。**「动作」区**：每种名称的总数和失败数（一张 `Table`，名称按第一次出现的先后排，计数变化时行不重排；名称里动作和标记在一起）；上限说明列出每个只计数的名称和它从几点起只计数；「失败的动作除外」只对只超过每种名称上限（`name_limit`）的名称说（失败的动作仍有明细，直到合计满）：全是这种名称时写在开头那一句里，同时有因合计满而只计数（`total_limit`）的名称时写在 `name_limit` 的名称后面，全是 `total_limit` 时不写；合计满了时再说「满了以后开始的动作都只计数（失败的也一样）」和第一个因此没有明细的动作是几点开始的（那个时刻不是明细的终点：更早开始的动作结束时仍可能补上明细，失败的动作在合计满以前会补，所以不说「从那个时刻起都没有明细」），并说明控制面另外丢弃的明细要到运行监控详情的「动作」页签里看（`NODE_ACTIONS.controlPlaneDropped`，写成「超过上限时」，没有丢弃过时也是实话；摘要只写有没有丢弃过，`control_plane_capped` 为 true、SDK 没超限时也显示上限说明），并指向开发文档「开发节点（SDK 参考）」的「数量上限」；最近的失败（接口给的最近 5 个，标题旁写一共多少个，多于 5 个时下面用 `moreLabel()` 写还有几个）原因单独一行、不截断，放不下就折行（`wrap-anywhere`，4096 个字符也不撑破检查器）。「最近 20 个」不放在检查器里（每秒 200 单时只覆盖约 0.1 秒，一直在滚）。没有动作记录的节点这两块都不画；摘要里写进度的说明的条件和卡片一致：尝试执行中、没有正在做的动作。检查器底部有动作记录的节点多一个「打开动作明细」（`ACTION.openActionDetails`：去另一个页面，按 §9 写「打开」），用 `runMonitorLink` 带上 `tab=actions` 打开运行监控详情的「动作」页签 |
| `#/monitor/ViewTabs`：`ViewTabs` | 运行监控页头的「概览 / 详情」标签页：`role="tablist"`，只有选中的标签在 Tab 顺序里，左右方向键切换并立即显示、Home / End 到第一个 / 最后一个（`monitor-view.ts` 的 `nextView`），对应的面板是 `role="tabpanel"`，名称取自当前的标签页。外观沿用分段选择（`raised-2` 底加一圈 `border-strong` 内描边，不用青色；强制颜色下 `aria-selected="true"` 换成 `Highlight` 描边）：它放在页头里，用 `Tabs` 的下划线样式会和页头的底边打架；切换整个页面的两个视图用它，同一块内容换一种看法用 `Segmented` |
| `#/monitor/FailureArea`：`FailureArea` | 运行监控概览首屏的失败区域（PRODUCT 第一条）：运行里已有节点最终失败时（失败的运行，或运行还在进行）出现在链路上面，写出**第一个失败的节点**（GLOSSARY，`allRunFailures` 的第一项）：标题（`FAILURE_AREA.title`：「运行失败」「有节点失败，运行还在进行」「有节点失败」）和失败时间，节点名（「显示名称（节点 ID）」，完整显示、可折行，子流程里的节点后面写子流程实例）和第几次尝试，失败原因的一行（`errorHeadline`，`text-base`，放不下折行、最多 4 行（`line-clamp-4`），更长的在末尾省略；一行摘要几乎总是一行，一个几千字的单行才会被收起，不让它把链路挤出首屏），一步直达它的尝试和日志的两个按钮（写法同「需要注意」：「在详情里查看 X 的尝试」「在详情里查看 X 的日志」，中性按钮：白色主操作留给「再次运行」），「展开全文」展开错误信息的全文（含堆栈）和被收起的原因（展开后按钮写「收起全文」，和时间线的开关一样，读屏不读成「展开全文，已展开」；字体加载完字宽变了会重新判断原因有没有被收起；等宽、限高滚动；没有堆栈等更多内容、原因一行也没被收起时不画）；还有别的节点失败时在下面按失败的先后列出（最多 3 个，点一下去它的尝试，其余写「还有 N 个」）。**为什么是首屏最突出的内容**：位置在最上面；是概览里唯一铺着色底（`danger-soft`）加描边（`danger-line`）的块；节点名 `text-lg` 加粗，和关注项读数的最新值同属最大一档，比各区块的标题（`text-base`）都大，原因 `text-base`；状态同时用形状（标题前的八边形、节点前的失败菱形）和文字「失败」表达，强制颜色模式下色底没有了，描边、形状和文字仍在。数据只来自运行视图（`run-model` 的 `allRunFailures`），不另读接口。区域是 `section`，名称取自它的标题（`aria-labelledby`）；展开按钮只在展开时才有 `aria-controls`；运行还在进行时第一个失败的节点出现，运行状态没有变、顶栏的状态播报不会读它，所以概览里一直挂着一个礼貌的播报区域（`FailureAnnouncer`），失败出现时读一句。概览里顶栏不写失败摘要（失败区域已经写了，同一屏上同一件事只说一次）；顶栏的失败摘要只在详情里没有横幅时出现，它只用别的内容占完之后剩下的宽度（最窄 96px），先于预设名、场景名与耗时让位。失败原因下面一行写「出错位置：…」（`error.location`，有值才写，`ERROR_LOCATION_LABEL`），完整显示、可折行 |
| `#/monitor/QueueWaitNote`：`QueueWaitNote`、`queue-wait.ts` 的 `queueWaitParts`、`queueWaitText` | 排队中的节点在等什么（运行视图里排队中的尝试的 `queue_wait`，控制面按读取这一刻的派发条件判断，不由页面推算）：「等 agent-a（不在线，已离线 2m 10s）· 排队 3m 05s · 6m 55s 后超时」。Agent 名称是去 Agent 管理页那台 Agent 的链接（`#agent-<名称>`，机架面板有这个锚点）；括号里是这台 Agent 现在的情况（不在线、准备环境中、版本与控制面不一致、槽位占满、正在派发，文字在 `QUEUE_WAIT`）；后面的「排队 …」「… 后超时」「即将超时」与 Agent 管理页排队行同一份（`agents/queue-timing.ts`）；槽位占满时后面接「占着槽位的任务：…」（最多 3 个，其余写「还有 N 个」；每个写成「场景名（运行 5e2d1c7a）的 节点」，运行编号链到那次运行的运行监控；别的项目的任务只写「另有别的项目的任务 N 个」）。时间用页面的控制面时间（`useTimeAxis` 的 `now`），不看浏览器时钟。用在：概览「进行中」里排队中的节点（这一项单独占一行）、控制台运行块「进行中」里排队中的节点（同样单独占一行，数据是 `GET /dashboard` 的 `active_nodes[]` 里排队中的节点多出来的 `queue_wait` 和 `queued_at`，和概览是同一句话）、没设关注项且没有节点在 Agent 上执行时主指标一栏（`WaitingNodes`，只写「节点都在排队，还没有开始执行：」加排队的节点名，在等什么「进行中」那一行已经写了，不再重复；不写「没有执行中的节点」）、详情「尝试」页签里排队中的尝试卡片。排队是中性灰，Agent 不在线也不用警示色（琥珀只有三个意思，见 2.4）。运行视图在尝试排队期间每 `STATUS_POLL_MS` 重新读取（`live-run.ts` 的 `hasQueuedAttempt`）：Agent 上下线、槽位占用和释放不让运行本身变化，事件流不推送。命令行写同样的话（`sdk/python/src/sfly/cli/run_view.py` 的 `queue_wait_text`，用词由 `sdk/python/tests/test_cli_run_view.py` 检查） |
| `canvas/CanvasDock`：`ToolButton` | 画布底部工具条（一个 Tab 停靠点）与它的图标按钮：按钮的提示从注册表取名称和按键。运行状态下工具条里多一个「跟随执行」按钮（`F`，准星图标）：打开时镜头框住所有执行中的节点（子流程里的连同子流程区域），框在没被顶栏、检查器、工具条占住的可见区域正中，缩放夹在 0.6 到 1，只移动镜头、不改选中的节点；执行前沿（执行中的节点）变化后停留 2 秒才平移（`FOLLOW_DWELL_MS`），平移的时长与「减少动效」同视口动画（见 §11）。拖动画布、缩放（滚轮或工具条的缩放按钮）、用方向键把选中移到视野外的节点时关闭，并在画布里的读屏实时区域（`<output aria-live="polite">`）播报「按 F 恢复」；运行结束后自动关闭、按钮禁用。按下用中性样式（`aria-pressed`，强制颜色下是系统高亮色轮廓），不用青色。第一次默认打开，之后记住这个浏览器里上次的选择（`lib/follow-execution`，localStorage `sfly.canvas.follow`），但只有按钮和 F 的切换算选择：拖动、缩放、键盘选到视野外这类停止只在当前页面有效（`editor/run-state/use-run-motion.ts` 的 `paused`，`FollowExecution.onPause`），刷新后回到上次用按钮或 F 选的状态；运行结束的自动关闭同样不算选择 |
| `ResizeHandle`、`PanelWidthHandle` | 区块边缘的拖动条：拖动调整高度或宽度，可聚焦，方向键每次 16px，双击或 Enter 恢复默认；`role="separator"`，`aria-valuemin` / `aria-valuemax` / `aria-valuenow` 是量出来的值（默认大小也有值），操作说明放在 `aria-describedby` 里，不只写在 `title`。`PanelWidthHandle` 是右侧面板（检查器、运行抽屉）左边缘的调宽条：宽度存 localStorage，所有场景共用，下限是面板的默认宽度（检查器 372px、运行抽屉 460px），上限是视口宽度的 60%；检查器的上限还要给画布留出小地图、工具条与间距（`INSPECTOR_CANVAS_RESERVE`），取两者里小的，拖到最宽也不会让工具条压住小地图；面板用 `usePanelWidth(min)` 取宽度（`lib/panel-width`） |
| `data-table`：`DataTable`、`dataColumns` | 数据表格：行与表头模型用 TanStack Table，外观沿用 `ui/table`；列表页的表格都用它；行的属性（点击、样式、`data-*` 属性）由 `rowProps` 给出 |
| `#/monitor/ActionTracks`：`ActionTracks`、`ActionLegend` | 运行监控时间线上有动作的节点下面的两条轨道和它们的图例，见 6.1「动作轨道」；数据只从 `monitor/use-action-tracks.ts` 读，排版是 `monitor/action-tracks.ts` 的纯函数（画出来的元素只和像素宽度有关，不随明细条数增长） |
| `#/actions/ActionTable`：`ActionTable` | 运行监控「动作」页签的表格（一个任务最多 10 万条明细）：行由 `actions/action-table.ts` 整理成「正在做」「最近 20 个」「更早的明细」三组，画成一张虚拟滚动的 `Table`：每组一个 `TableBody`，组名是 `scope="rowgroup"` 的表头，上下用占位行撑出高度，表头吸顶，列宽固定（见 6.5）。结果一列按状态语法：成功不着色，失败是红色菱形加完整的原因（换行），进行中是执行中的形状，标记是小旗；只计数的一段是一整行浅斜纹。离开顶部以后，推送来的行插在上面时视口里的行不动；滚到底部附近读更早的一页。开始一列按 `timeKind` 显示 Agent 时间或控制面时间（ADR 0018，默认控制面时间，存在 localStorage 的 `sfly.actions.time`，和日志的互不影响），显示 Agent 时间时表头第二行写时钟偏差（`attemptClockNote`，和「尝试」页签的说明同一份），时间线不跟着切；每行的开始时间是按钮，点它日志跳到那一刻（`onLocate`，始终是控制面时间）；开始时间的按钮合起来只有一个 Tab 停靠点（漫游焦点，同日志列表；没渲染时停靠点退回视口里的第一行），方向键、PageUp / PageDown、Home、End 在行间移动，只计数的行里的按钮照常可以 Tab；焦点所在的行被卸掉（滚出渲染范围、结束后换了组）时焦点落到页面上，Tab 再进来落在停靠点。三组标题后面的说明由 `groupNotes()` 给：「最近 20 个」在 SDK 超出上限（摘要的 `capped`）或读到控制面丢弃的段时写「超过上限后也一直更新」；只看失败时第三组写失败的动作有没有明细（合计满了没有；没满有，更早的页没读完或读到控制面丢弃的段时加「控制面丢弃的除外」）。只计数的一行里有「只看失败」；只看失败时，这一段里失败的个数不知道（个数包括成功的），写明这个名称一共失败多少个，没有失败过的名称这一行不出现 |
| `#/actions/ActionToolbar`：`ActionToolbar` | 运行监控「动作」页签的工具条和一行总数：按名称筛选的 `NativeSelect`、「只看失败」开关（`aria-pressed`）、表格里的时间 `Segmented`；下面一行总数，每种名称的个数和「失败 N」是同一份筛选条件的按钮（`aria-pressed`），名称很多时这一块限高、自己滚动。筛选条件由底部面板持有（切到日志再回来还在），换条件重新读明细时工具条不换掉、焦点留在刚操作的控件上，表格显示上一批行（变淡），点按钮之后在实时区域（`<output>`）播报「筛选后 N 个动作」（在点的那一刻算一次，不随摘要的更新重读）。筛选后没有行时写「没有符合条件的动作。」加「清除筛选」，点它以后焦点回到名称下拉 |
| `list-navigation`：`useListNavigation`、`focusFirstListItem` | 列表页的行导航，见 §7 |
| `feedback/states`：`EmptyState`、`TableSkeleton`、`RackSkeleton`、`ErrorState`、`QueryView` | 空 / 加载 / 错误；`QueryView` 把查询的四种状态接上 |
| `feedback/notify` | `notify.success / info / warning / error`，见 6.3 |
| `feedback/banner`：`Banner` | 页内横幅（`danger` / `warn` / `info`），见 6.3 |
| `feedback/clipboard`：`writeClipboard` | 复制：先用 Clipboard API，内网 http 下没有它或被拒绝时改用浏览器的复制命令；两条路都失败才提示「复制失败」。在点击处理函数里同步调用 |
| `focus-recovery`：`useFocusRecovery` | 焦点所在的元素被移走时的去向，见 §7；根路由挂载一次 |
| `shortcuts`：`useShortcut`、`ShortcutsDialog` | 见 §7 |
| `#/editor/inspector/ReferenceEditor`：`ReferenceEditor`、`InsertReferenceButton` | 可以写引用的文本输入框（CodeMirror 6 内核，只引入 `@codemirror/state`、`view`、`commands`）：输入 `$` 或点「插入引用」弹出补全，引用高亮成一块、整块删除，1 到 8 行自动增高；外观与 `Input` 一致。能写引用的字段都用它，不另写一套；`choices` 传 `null` 时是不能写引用的多行输入框（入口参数的默认值）。`$` 触发的补全不预选，方向键或鼠标选中后 `Enter` / `Tab` 才插入 |
| `#/editor/inspector/ReferencePicker`：`ReferencePicker`、`ReferenceChip` | 非字符串参数（数字、布尔、枚举、JSON）：「插入引用」按钮选一个引用作为整个值；值是整值引用时用引用标签代替类型控件，点 × 回到类型控件。没有「常量 / 引用」切换，显示什么由值决定。「运行状态」类型（`sfly.RunState`）的输入没有可选的值，只能接 `${{ run.state }}`：没接时是一个整行的「接入运行状态」按钮（`RunStateConnect`，点一下填上），接入后是引用标签。补全分三组，顺序是「入口参数」「运行状态」「前序节点」；包节点的补全里才有「运行状态」组（`run.state`） |
| `#/editor/inspector/ZoomEditor`：`ZoomEditor`、`ReferenceActions` | 字符串、JSON 字段的「放大编辑」：`Dialog` 里放大的 `ReferenceEditor`（等宽、补全、高亮）；修改直接走字段的 `onChange`，没有「保存 / 放弃」。能写引用的文本字段右侧的「插入引用」+「放大编辑」两个按钮用 `ReferenceActions`，不另写 |

## 6. 各状态的样式

### 6.1 状态语法（`components/status.tsx` 的 `STATUS`）

状态的颜色、形状、动效都在 `STATUS: Record<StatusKind, StatusLook>` 一张表里：`tone`（状态形状、描边、色块的颜色）、`text`（状态文字的颜色）、`mark`（8px 的状态形状）、`area`（有面积的色块：`tall` 满高还是矮一档、HTML 的 `box` 类、SVG 的 `svg` 类）、`pulse`（能否脉冲）、`canvas`（画布上的样子：站点灯的 `lamp` 是要盯的 `watch`、走完了的 `passed` 还是还没轮到的 `ahead`，要盯的状态另有灯圈和进度线用的 `line`、卡片描边和进入它的连线用的 `stroke`；`watch` 和 `area.tall` 是同一组，`design-rules.test.ts` 检查）。`StatusDot`、`StatusPill`、`ChainBar`、`RunLines`、`ScenarioThumbnail`、`SlotCell`、画布的 `NodeCard` 和 `FlowEdge` 只读这张表；其他要画状态的地方（时间线区段、小地图、趋势柱）也从这里取，不另写颜色。

| kind | 用于 | 状态形状（8px） | 文字 | 面积色块 |
|---|---|---|---|---|
| `ok` | 成功、在线 | 绿色实心圆点 | `ok` | 矮；`ok-fill` |
| `running` | 执行中、准备中、发送中 | 青色圆点加外圈 | `signal-fg` | **满高**；`signal-fill` 底 + `signal-line` 描边 |
| `failed` | 失败 | 红色实心菱形 | `danger-fg` | **满高**；实心 `danger-fill` |
| `warn` | 等待中（停止子流程节点等被停止的子流程结束）、警告（含关注项的异常）、安装中 | 琥珀实心三角 | `warn-fg` | **满高**；`warn-fill` 底 + `warn-line` 描边 |
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

**时间线区段**（`monitor/Timeline`）按同一套规则画，段的种类对应状态：完成 → `ok`、执行中 → `running`、失败的尝试 → `failed`、停止子流程节点的等待 → `warn`、排队等待 Agent → `queued`、已取消 → `cancelled`、已停止 → `stopped`，用 `STATUS[kind].area.box` 与 `tall`：

- 节点行里的区段 12px 高；矮段在其中垂直居中 6px（用 `clip-path: inset()` 或内层元素只改可见高度，点击与悬停的热区保持满高）。
- 完成是矮的 `ok-fill`；失败的尝试是满高实心红；两者相邻时在任何色觉下都靠高度分开。
- 执行中满高，段尾加一个真实元素的脉冲头（实心 `signal`，`pulse-ring`），是监控页唯一按节点脉冲的地方。
- 已取消是矮的空心虚线框（不再是斜纹）；排队是矮的灰色斜纹；等待是满高的琥珀底加描边，三者形状互不相同。
- 图例按同样的形状画。时间线上画区段和动作的区域与图例色块加 `data-viz`（见 6.2）。

**动作轨道**（`monitor/ActionTracks`，排版在 `monitor/action-tracks.ts`）：有动作的节点下面两行，「动作」（最外层）和「└ 子动作」，行高和节点行一样，标签 12px 三级文字，随链收起。轨道是一张图：`role="img"`，可访问名称概括画了什么（正在做的、从几点起只计数、几个失败的、少见的子动作、几个标记），以「逐个查看见下方动作表」结尾；悬停提示写名称、开始、耗时和结果。

- 够长、一条条画出来的动作：进行中的按 `STATUS.running.area`（`signal-fill` 底加 `signal-line` 描边，和执行中的区段一样，不脉冲：段尾的脉冲头仍是每个执行中节点唯一的一处），失败的按 `STATUS.failed.area`，已结束的中性 `border-strong`。动作条都是 14px 高（描边里面放得下 12px 的名称），不按状态分高低：状态色块靠高低分开的是失败的红和成功的绿，这里已结束的是暗灰不是绿，失败的红比它亮得多，各种色觉下都分得开；够宽时在条里写名称（12px）。
- 分不开的画成密度带：中性 `border-strong` 分三档不透明度，越密越实，不用状态色。
- 只计数的段是浅斜纹（和「动作」页签里只计数的那一行是同一个意思）：`border-strong` 的 1px 45° 细线加 `border-soft` 描边，和排队段 135° 的灰色斜纹方向相反，也不在同一种行上（排队段在节点行里）；`FocusChart` 里没有新数据的斜线只在图表的绘图区里。
- 密度带上要认出来的：失败的动作是比带高的红色竖线（取 `STATUS.failed.tone`），少见的子动作是白色竖线（`fg-1`），标记是小旗（`FlagIcon`，`fg-1`，和「动作」页签里标记的小旗一样）。白色竖线和小旗用的是文字色 `fg-1`，只表示「少见」和「标记」，不是选中（节点行左侧的白色短条）也不是主操作。
- 图例：有动作的节点时在区段的图例后面加「动作」「只计数」「失败的动作」「少见的动作」「标记」；窗口窄于 2xl（1536px）时一行放不下两套，只留动作轨道的这几项。
- 范围里的节点（选中的）是 `selected-row`。打开页面、换范围时时间线滚到它，版面变高以后再对准一次，用户自己滚动时间线以后不再跟着跳。

**时间轴的跨度**（`monitor/timeline-model.ts`）：运行中的轴不随「现在」每秒伸缩。跨度只取一级一级的固定值（10 秒起，到一天，相邻两级相差 25% 到 50%），取已用时长加 20% 余量后向上的那一级；「现在」线越过轴的 1 / 1.2 才扩到下一级，两次扩轴之间区段与刻度纹丝不动，只有「现在」线向右推进，扩轴时一次到位。已结束的运行按实际时长定轴，末端留 8% 的空白，短运行也铺满轨道。

### 6.2 强制颜色与高对比度

- **强制颜色模式**（Windows 高对比度）：浏览器换掉作者的颜色、去掉 `box-shadow` 与渐变。状态形状是 currentColor 画的 SVG，不用处理。`app.css` 的 components 层集中补其余的：`aria-current="page"`、`aria-current="location"`（被定位的关注项）、`aria-pressed="true"`、`aria-selected="true"`、`data-state="selected"`、`selected-row` 换成 2px `Highlight` 内描边（画布节点卡片是例外：选中靠外圈的 box-shadow，强制颜色下换成隔开 3px 的 3px `Highlight` 外轮廓，不画在卡片里面，见 2.4）；数据图形（链路进度、线路、缩略图、时间线的区段与动作轨道、图例）加 `data-viz`，保留作者颜色并垫一块 `bg` 底（`forced-color-adjust: none` 只给这些颜色本身就是信息的地方）。开关用系统颜色画（`switch.tsx`）；输入框的焦点由 `focus:outline-hidden` 的透明轮廓在强制颜色下显示出来。新组件不要只靠底色或阴影表达状态。
- **更高对比度**（`prefers-contrast: more`）：`tokens.css` 末尾的加强档，见 §2。

### 6.3 空、加载、错误、禁用

- **空**：`EmptyState`——图标方块、14px 标题、说明（最宽 40em，居中）、下一步操作（按钮或 `CodeBlock` 命令示例），放在 `Panel` 里。
- **加载**：`TableSkeleton`（按表格列数画骨架，`role=status` 名称「加载中」）；不是表格的页面用与内容同形的骨架，Agent 管理页是 `RackSkeleton`（每台 Agent 一个面板：头部一行加一排槽位格）；首次加载才显示，后台刷新不闪；出现前先等 200ms，加载在 200ms 内完成时不闪骨架。
- **错误**：`ErrorState`——红色描边块，标题「无法加载 …」、原因、一行错误详情（`GET /api/agents → 503 code`）、「重试」与「复制错误详情」（含 details）。已有数据时后台刷新失败不替换页面。查询默认失败后再重试 2 次（间隔 1 秒），4xx 不重试（`src/router.tsx`）。
- **禁用**：40% 不透明、`cursor-not-allowed`，不换颜色。
- **没有内容可画就不画空框**：运行已经结束、场景没设关注项时，运行监控概览里原来的「执行中节点的主指标」一栏没有读数了（主指标是执行中节点的）：标题改成「关注项」，下面一句说明（`FOCUS.endedNoneSet`：为什么没有、设置关注项之后这里会显示最终值），「设置关注项」入口还在；不画写着「没有执行中的节点」的虚线空框。
- **通知**：见下面的「通知与横幅」。

**通知与横幅**。两者分工按信息要不要留在原处、要不要立刻注意：

| | 通知（`notify`） | 页内横幅（`Banner`） | 弹窗里的错误（`FormAlert`） |
|---|---|---|---|
| 用于 | 刚做完的操作的回执：已保存、已复制、已归档（带「撤销」） | 页面状态里需要立刻注意的事：运行失败、连接断开、数据可能过期 | 弹窗里的提交被服务端拒绝（重名、地址无效） |
| 位置 | 右下角（不盖住全屏页顶栏中间的运行状态与失败摘要） | 它影响的区域顶部，跟着页面滚动 | 弹窗里、提交按钮上方 |
| 消失 | 成功 / 信息 2.6 秒，警告 5.2 秒；失败的、带操作的（「撤销」）不自动消失，有关闭按钮 | 状态解除时由页面移除，不自己计时；`onDismiss` 只是收起 | 下次提交时清掉 |
| 读屏 | 通知区域「通知（Alt+T 跳到这里）」；Alt+T 把焦点移进去，焦点所在的通知消失（点了「撤销」、到时间）时焦点立刻回到按 Alt+T 之前的元素，不会几秒后被抢回（`Toaster` 的 `useReleaseFocusWithToast`，sonner 自己只在通知区域整个卸载时才还） | `announce` 时读一次（失败用 alert）；页面已有状态播报（运行监控的 `<output>`）时不要再开 | `role="alert"` |

- 通知里的信息在别处也要看得到：「撤销」在「已归档」里也能做，运行结果在监控页顶栏一直显示。列表里的移除是例外：就地移除的列表（可排序的列表，§7）把「撤销」放在列表上方原处，不进通知，因为键盘用户要能直接回到它。
- **secret 参数的值太多的运行**（`RunView.secrets_oversize`，#657）：这次运行里日志、动作、输入输出、错误信息整段显示为掩码，所以原因要在看得到这些内容的地方写明：运行抽屉的摘要里是运行通知下面的一句话（`role="note"`），运行监控页是顶栏下面一条 `warn` 横幅（概览和详情都有，在 `<main>` 外面，不占详情里时间线、图表工作区的高度计算；这是整个运行的状态，不能收起）；两处同一句话（`MESSAGE.secretsOversize`），用词是 secret 参数（和日志里的那行说明、用户文档一致）。
- **运行失败不发通知**：运行监控页的详情视图在时间线上方显示页内横幅「运行失败」（一行高：`Banner` 的 `inline`，标题和失败摘要排在一行，摘要放不下时截断，悬停看全文；带「查看失败节点」，可以收起，收起后失败摘要回到顶栏）；概览视图没有横幅，首屏最上面是失败区域（`#/monitor/FailureArea`，见组件清单：运行失败，或者运行还在进行但已有节点失败时都有），顶栏这时不写失败摘要（同一屏上同一件事只说一次）；顶栏的失败摘要只出现在看不到失败区域和横幅的地方：详情里没有横幅时（运行还没结束、已有节点最终失败，或者收起了横幅），点它打开失败节点的「尝试」页签；成功与取消才在页面上看着结束时发一次回执通知。
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
- **窄的名称列里显示名称优先**：运行监控时间线的名称列只有一二百像素，`NodeName` 传 `priority="name"`：名称和「（节点 ID）」一行放得下才一起显示，放不下时「（节点 ID）」整个收起（不留半截 ID、不留空括号），名称占满整行、还放不下才截断在末尾（带 `always` 标签、右边多占一块的行在 1280 宽的窗口里就是这样）；节点类型也是整个显示或整个收起（放得下才显示，不留半个字、几像素的残片），只用名称之后剩下的宽度。实现是一行高、裁掉溢出的 `flex-wrap`：放不下的 ID 换到看不见的第二行；元素标 `data-truncate-wrap`，`Truncate` 的提示也把它算作被截断，悬停整行时给出全文。默认（`priority="id"`）相反，节点 ID 总是完整的，截断显示名称。两种写法的全文都在悬停提示和读屏名称里。
- **线路的站名各取自己的宽度**（`run-lines.tsx`）：站名那几列是 `minmax(0, auto)`，每站最宽 18rem（`max-w-72`），放不下时先均分、短站名让出的宽度给长站名；长节点 ID 的站名（常常正好是失败的那个节点）不再和短站名平分同样的宽度。真的比 18rem 还长、或者窗口窄到各站加起来放不下时才截断在末尾，悬停看全名。
- **底部「尝试」卡片的名称也是显示名称优先**：卡片只有 380px 起，头部一行放着名称、尝试号、状态和 Agent · 时间 · 耗时，`NodeName priority="name"`，放不下时先收起节点 ID。
- **图表卡片头部右侧的尝试选择器**宽 168px（`w-42`），放得下「第 2 次尝试（最新）」整句；各组右侧两栏的位置固定，所以所有组都是这个宽度。
- **运行监控概览的「其他警告与错误」**：节点名那一列取这些行里最长的节点名的宽度（最宽 20rem，一个 `grid` 加 `grid-cols-subgrid`，各行对齐），失败区域已经写了的那条错误（失败的那次尝试自己的 ERROR 日志）不再列一遍：正文是失败原因全文里的一段的，和执行器在堆栈之前写的一行「出错位置：<位置>」（它不在失败原因的全文里，失败区域把同一个位置写在失败原因下面；`monitor/Attention.tsx` 的 `inFailureArea`）。
- **时间线名称列**（`--label-w`）：`clamp(260px, 22cqi, 440px)`，1280 宽时 282px：带 `always` 标签、重试次数、耗时的清理行也放得下 4～5 个字的显示名称。
- **虚拟滚动的表格**（动作表）列宽固定（`table-fixed` 加 `<colgroup>`）：只渲染视口附近的行时，自动列宽会随滚动跳动。
- **列表表格的列宽**（`TableHead` / `TableCell` 的 `width`，DataTable 写在列的 `meta.width`）：编号、状态、进度、版本、触发人、时间、耗时、操作这类列用 `"fit"`（按内容收紧、不折行）；场景名、说明、错误信息这类列用 `"grow"`（吃掉剩下的宽度，里面用 `Truncate`），每张表只有一列 `"grow"`。宽屏上余量都给 `"grow"` 列，数值列聚在一起，不平摊到每一列。

### 6.6 浮层体系

浮层继续用 Base UI（Dialog、Popover、Menu、Tooltip）、cmdk、sonner，不迁移到原生 `<dialog>`、`popover`、CSS anchor positioning、`interestfor`（2026-11 设计评审的评估结论）：

- Base UI 已经做到原生 `<dialog>` 给的东西：页面其余部分对读屏不可见、焦点锁定、Esc 关闭、焦点归还（还能用 `finalFocus` 指定菜单项已经不在时的去处），菜单靠近视口边缘会翻转；`popover` 的声明式开关用不上（开关状态在 React 里）；anchor positioning 达不到碰撞翻转；`interestfor`、`closedby`、`focusgroup` 的浏览器支持还不够。改用原生要重写受控打开、`finalFocus`、退场动画，收益小于成本。
- 原生的几条行为在组件层吸收：表单弹窗输入过后不能点外面关闭（对应 `closedby="none"`，见 `Dialog` 的 `pointerDismiss`）；带操作的通知不自动消失；通知区域与命令列表用中文名称；进出场用 Base UI 的 `data-starting-style` / `data-ending-style` 加 CSS 过渡（作用同 `@starting-style`，退场等过渡结束再卸载，可以中途反向），不用关键帧。
- 以后真的改用原生 `<dialog>` / `popover` 的组件，再按原生方案加 `overlay` 与 `transition-behavior: allow-discrete`。

### 6.7 运行监控详情的竖直分配（窗口矮的时候）

详情从上到下是：顶栏（52px）、失败横幅（只有失败的运行，一行高，43px）、时间线、图表工作区、底部面板。窗口矮（1280×800）时各区域按下面的规则分高度，不是谁都要最大：

- **时间线主体最高占视口的 30%**（`clamp(150px, 30dvh, 420px)`，加上 40px 的标题行；行不多时按内容的高度，行多了在里面滚动，选中和执行中的节点自动滚进可视范围）。**窗口矮的时候才再受剩下的高度限制**：主体最高是详情的可用高度（窗口减顶栏、失败横幅）减去时间线的标题行、图表预留的高度（300px）和底部面板的下限（190px）之后剩下的（`monitor/detail-layout.ts` 的 `timelineBodyMax`，最少 120px）。1280×800 带失败横幅时剩下 175px（比 30% 的 240px 小，主体是 175px）；1440×900 剩下 275px，比 30% 的 270px 大，这条限制不起作用，时间线和以前一样（这个运行的 8 行放得下，主体按内容的高度）。窗口越高越不起作用：高的窗口里时间线不让，矮的窗口里才让，让出的高度给图表和底部面板。用户拖动调高时最高到 420px 或视口的 62%（取小的）。
- **图表工作区预留 300px**（`CHARTS_RESERVED_HEIGHT`）：够放下工具栏、第一个图表组的标题和节点摘要，再加一张 136px 高的图表的 120px 以上，能看清曲线。内容不够 300px 时只留内容的高度，不留空白（`ChartWorkspace` 量内容的高度，报告给 `DetailView`）。窗口矮到连 300px 也放不下时，图表最后让到 48px（工具栏），滚动查看。
- **底部面板先让**：默认高度是（窗口减顶栏）的 28%，限制在 190–320px（下限 `PANEL_FLOOR`：1280×800 下「动作」页签的表头和第一行要在面板里露出来）；最高是容器的高度减去图表预留的高度，所以窗口越矮它越矮，最矮是标签行（37px）。1280×800 带失败横幅时它是 190px（够看几行日志、尝试和动作表的第一行）；比这更矮的窗口里它会低于 190px，一直让到标签行。时间线是让出来的那个：图表（300px）和面板（190px）的位置定了，剩下的才给时间线。用户自己拖高面板时只留图表工具栏的高度（48px）：拖是明确的选择（要看日志、动作表），预留的 300px 只管默认的版面。
- **失败横幅一行高**（`Banner` 的 `inline`）：标题和失败摘要排在一行，摘要放不下时截断在末尾、悬停看全文，省出 16px 给图表。

实测（`e2e/monitor-narrow.spec.ts`，失败的运行、两个节点上报了指标）：

| 视口 | 顶栏 | 横幅 | 时间线 | 图表区 | 底部面板 | 第一张图表露出 |
|---|---|---|---|---|---|---|
| 1440×900 | 52 | 43 | 282 | 300 | 223 | 130 / 136 |
| 1280×800 | 52 | 43 | 215 | 300 | 190 | 130 / 136 |

改这套规则之前，1280×800 里图表区只有约 200px（第一张图表的绘图区在工作区的可视范围之外，要滚动）。

## 7. 键盘、焦点与快捷键

- 焦点环统一是 2px 青色外框（`:focus-visible`，在 `components` 层，第三方库的样式去不掉它），组件不要用 `outline-none` 去掉它（输入框改用青色描边 + 光晕，并用 `focus:outline-hidden` 给强制颜色模式留轮廓）。所有元素平时的 `outline-color` 就是焦点色（base 层），所以带 `transition-colors` 的元素聚焦时焦点环也是即时出现、不会先灰后青。
- 画布节点卡片的焦点环 `outline-offset` 是 9px：在选中描边（3px 画布底色加 2px `selected` 描边）的外面，读作「框在卡片外面」，与执行中节点的青色描边、选中描边都区分开。
- 编排画布只有一个 Tab 停靠点：画布区域。进入后方向键沿链选中节点，焦点跟着移到节点卡片上；Esc 取消选中、焦点回到画布区域。节点卡片与连线都不进 Tab 顺序（React Flow 的 `nodesFocusable` / `edgesFocusable` 关闭）。顶栏控件在 DOM 里排在画布之前，工具条与检查器在画布之后。底部的画布工具条同样只有一个 Tab 停靠点：← → 在按钮之间移动，禁用的按钮不参与。选中注释框或几个节点时出现的浮动工具条也各是一个 Tab 停靠点（在画布区域之后、底部工具条之前），← → 在按钮之间移动；注释框的标题胶囊不进 Tab 顺序，键盘用 F2 改标题、Ctrl+G 新建、Ctrl+Shift+G 删除，颜色在检查器里改。
- 弹窗与抽屉用 `Dialog` / `Sheet`：锁定焦点、Esc 关闭、关闭后焦点回到原处；自己写的浮层也必须满足，并加端到端测试。
- **可排序的列表**（场景设置的「关注项」页是参照实现）：拖动手柄只服务鼠标（`aria-hidden`，不进 Tab 顺序）；键盘和读屏靠每行的「上移」「下移」按钮，到头的按钮用 `aria-disabled` 而不是 `disabled`（禁用的按钮不能聚焦，连按到头时焦点会掉出列表），焦点跟着被移动的那一项走，实时区域（`<output class="sr-only">`）播报「X 移到第 N 位，共 M 项」。移除后在列表上方原处给「撤销」，焦点移到它上面；撤销只管刚做的那一次移除。
- **焦点所在的元素被移走时**（归档、恢复、删除了它所在的列表项，空状态被列表替换），焦点不留在 body 上（`useFocusRecovery`，根路由挂载，不用逐页接）：它自己带着 `data-focus-successor`（CSS 选择器，会话页的「停止」指向输入框）就交给选中的元素（**必须是能获得焦点的元素**：输入框、按钮、链接，或带 `tabindex` 的；选不到、或聚焦不上，退回下面的规则）；它在列表项（`data-list-item`）里就交给下一项的主链接，没有下一项交给上一项；列表空了、或它不在列表项里，交给页面标题（`PageHeader` 的 h1）。弹窗、菜单关闭时焦点先回到打开它的元素，那个元素随后被移走也照这个规则处理。只管外壳页的主区域，全屏页（画布、运行监控）自己管焦点；用户自己点空白处让焦点离开时不处理。新增内容（登记了第一个机器人）后要把焦点放到新的那一项时，页面自己聚焦它。
- **快捷键注册表** `src/lib/shortcuts.ts` 的 `SHORTCUTS` 是唯一来源：快捷键面板（?）从它生成，页面用 `useShortcut(id, handler, enabled)` 绑定（`enabled` 为 false 时不绑定，键不被拦截）。新增快捷键先登记（分组「全局 / 助手 / 编排画布 / 运行监控 / 列表页」、名称、按键、是否允许在输入框或弹窗中触发），再绑定；没有绑定的不要登记。**只在某个控件里生效的键登记成只展示**（`displayOnly`，助手页和会话页输入框里的 Ctrl/⌘+Enter）：快捷键面板照常列出，但不进全局匹配、不用 `useShortcut` 绑定，由控件自己的 `onKeyDown` 用 `isShortcut(id, event)` 判断（输入法选字时的按键不算：`isComposing || keyCode === 229`，Safari 在组字结束的那次按键上 `isComposing` 已经是 false）；焦点在页面别处时它什么也不做。写法：`Ctrl+K`（同时按）、`G D`（1 秒内依次按）；Ctrl 同时匹配 ⌘；默认焦点在输入框里或有弹窗打开时不触发。**删东西的键登记 `canvasOnly`**（删除节点和连线的 Delete、Backspace，删除注释框的 Ctrl+Shift+G）：焦点在检查器、大纲这类面板（`aside`）里、页头、弹出的菜单里也不触发，只在焦点在画布区域里（节点卡片、画布空白处、画布工具条）或页面上没有焦点时才生效，判断是 `lib/focus` 的 `inCanvasArea`（点完画布工具条的按钮接着按 Delete 照常删除选中的节点）；不要用 React Flow 的 `deleteKeyCode`，它挂在 window 上，不看焦点（在检查器里点一下不是输入框的地方再按 Backspace，节点就被删了，#461）。撤销、重做、复制、粘贴、创建副本等不丢东西、本来就能撤销的键不限焦点。
- **快捷键面板里名称相同的登记合成一行**（`shortcutRows`）：一个键一条登记（删除节点的 Delete 和 Backspace），面板里名称写一次，按键用「或」连起来；同一个分组里不会有两行同名。合成的行比别的行宽出一截（名称加两个键），**占两列**（`col-span-2`，表格 `grid-flow-dense` 让后面的行补上放不下时留出的空位）：占一列的话每一列都要按它的宽度排，面板在 1440×900 里撑到铺满窗口（1400px，原来跟着内容是 1274px）、1280×800 里也一样（`shortcuts-panel-rows.spec.ts`）。
- 不同页面分组（助手、编排画布、运行监控、列表页）可以登记同一个键（画布与监控页的 `E`、`R`，画布与列表页的 `/`），因为它们属于互斥的路由：按键只匹配当前已绑定处理函数的那一个。「全局」的键不能与任何分组重复，同一分组内也不能重复（`shortcuts.test.ts` 检查）。
- **列表页行导航**（分组「列表页」）：场景列表（卡片与表格视图）、运行记录（进行中的卡片与历史表格）、节点包列表是「列表页」。`J` / `K` 把真实的键盘焦点移到下一项 / 上一项的主链接上（Enter 走链接本来的行为，不循环；焦点不在任何一项里时 J 去第一项、K 去最后一项），`/` 聚焦并选中搜索框的文字，搜索框里按 ↓ 进入第一项。实现基于 DOM、不保存状态：每项容器写 `data-list-item`、主链接写 `data-list-primary`，页面调用一次 `useListNavigation()`；搜索框用 `useSearchInput`（返回 `ref` 与 `onKeyDown`，`/` 与 ↓ 在里面接好）。焦点环就是全局的键盘焦点环；所在的行或卡片另加与悬停相同的中性强调（表格行 `has-[:focus-visible]:bg-fg-1/3`，卡片 `has-[:focus-visible]:border-border-strong`），只写在带 `data-list-item` 的行上，`selected` 样式留给真正的选中。Agent 页与飞书机器人页没有可打开的目标，不接入；导航键不是命令，不进命令面板。
- **快捷键面板的版面**：名称不折行（`whitespace-nowrap`，最宽的一行放得下），宽度跟着内容走（至少 740px）；窗口宽到 1100px 起排四列、1300px 起排五列：1440×900 里五列整个面板放得下、不用滚（四列还差 43px，「助手」一组加进来之后），1280×800 排四列、还要滚 119px，更窄的窗口排三列、面板里的内容自己滚。**滚动区下面还有内容时底边渐隐**（`lib/scroll-more` 的 `trackMoreBelow` 随滚动加减 `data-more-below`，`MORE_BELOW_FADE` 是配套的样式）：刚打开时就看得出还能往下滚，一行不会被底边从文字中间生硬地切开；滚到底、或放得下时没有。
- 登记时带 `palette: true`，这个快捷键在页面绑定期间同时是命令面板「当前页面」分组里的一条命令（名称、按键取自注册表，`PAGE_COMMAND_ICON` 给每个配图标，少一个编译不过）；`useShortcut` 的 `enabled` 同时决定键是否拦截、命令是否出现。`canvas-save` 一直绑定（无改动时 Ctrl S 说明「没有未保存的修改」，不让浏览器弹出另存为）。
- 界面上显示的按键也从注册表取，不写死：按钮提示用 `ToolButton shortcut="<id>"`、菜单项用 `ContextMenuItem shortcut="<id>"`、单独显示用 `<Keys shortcut="<id>" />`，写在文字里用 `shortcutText(id)`。`Kbd` 只接受注册表给出的按键文字（`KeyLabel`），写死的按键过不了类型检查。只说明怎么操作眼前控件、不算快捷键的按键（命令面板底部的「↑ ↓ 选择」）用 `KeyHint`，可用的键限定在 `OperationKey` 里。

## 8. HTTP 契约与数据获取

约定的完整说明在 `packages/schema/src/http/contract.ts` 顶部，要点：

- 每个接口在 `@sfly/schema` 的 `http/<领域>.ts` 中用 `endpoint({ method, path, summary, effect, resource, client, key, params?, query?, body?, response })` 定义；数据 schema 用名词（`AgentView`），接口表用 `<领域>Api`（`agentsApi.list`）。SSE 用 `stream({ path, summary, effect, resource, client, params?, query?, events })`，字节流下载用 `download({ path, summary, effect, resource, client, params?, contentType })`。
- `summary`（一句话说明）、`effect`（`read` 只读 / `write` 有副作用）、`resource`（`{ kind, target }`：作用在哪类资源上、用请求的哪个字段定位到具体的那一个）每个接口都必填，写法见 `contract.ts` 顶部的约定 10；新接口照同领域已有的接口写，`checkRouteDeclarations` 检查，`effect: "read"` 的接口要真的不写库（`read-only-routes.test.ts` 核对）。写接口再按需写两个可选的标记：`creates: <类别>`（新建的是哪类资源；有它时 `resource` 定位到的资源只被读，写落在新建出来的资源上）和 `removes: true`（让资源或它的一部分不再可用：删除、归档）。三种新建各一例：新建场景 `POST /orchestrations` 没有定位到已有资源，`resource: { kind: "scenario", target: "collection" }`，不写 `creates`；复制场景 `POST /orchestrations/:id/copy` 定位到来源场景后新建同类，`resource: { kind: "scenario", target: { params: "id" } }, creates: "scenario"`；触发运行 `POST /orchestrations/:id/runs` 定位到场景后新建别类，`… creates: "run"`。新建的东西只是上级资源的一部分（场景的新版本、运行预设，任务的产物）时不写 `creates`：改的是上级资源本身。GET 一定是只读，DELETE 一定写 `removes: true`，非 GET 的只读接口要登记在 `NON_GET_READS`；`{ params }` 用路径里的第一个参数；接口的路径前缀和 `resource.kind` 要对上 `http/declarations.ts` 的 `PATH_KINDS`（新接口的路径前缀不在表里就在表里加一项并写理由，写成 `system` 要说明为什么它是平台自身的）；这些都由 `checkRouteDeclarations` 检查。
- `client` 写明接口是否进入 API 客户端（`@sfly/client`，ADR 0022）：开放给自建页面的为 true，给 Agent、安装脚本、控制台自己用的和上传接口为 false。`pnpm gen` 从契约生成 API 客户端的类型和路由表。
- 控制面的**每个** HTTP 路由都在契约里：`httpApis`（`http/index.ts`）按领域列出全部接口表，`httpContract` 由它展开；控制面启动时 `guardHttpContract` 检查注册的路由与它一一对应，多一个少一个都启动失败。
- 响应 schema 用 `z.object`，不写 transform / default / coerce（生产环境前端不解析响应）；请求部分可以用。字段 snake_case，时间用 `Timestamp`。
- 控制面用 `contractRoute(app, agentsApi.list, handler)`（`apps/server/src/http/contract-route.ts`）注册，SSE 用 `contractStream`（只能发送契约里声明的事件），下载用 `contractDownload`：请求不符合契约返回 400 `invalid_request`（需要更具体的错误码时在契约里写 `requestError`，例如保存版本的 `base_version_required` / `invalid_document`），handler 的返回值受响应类型约束；控制面测试用 `xxxApi.yyy.response.parse(body)` 校验实际响应。
- 前端：`useQuery(apiQuery(agentsApi.list))`、`callApi(packagesApi.version, { params })`、`openEventSource(logsApi.runEvents, { params }, handlers)`（SSE，返回关闭函数；运行的实时状态用 `monitor/live-run.ts` 的共享连接，不要再开一条）、`apiUrl(logsApi.download, { params })`（下载链接）。没有手写的接口函数和类型。query key 一律由 `queryKey()` 生成（`[...key, { params?, query? }]`），失效按领域前缀：`invalidateQueries({ queryKey: domainKey(packagesApi.list) })`。开发环境下响应不符合契约时抛出 `contract_violation`，页面显示为错误状态。
- 定时重新查询的间隔与搜索防抖只用 `src/lib/polling.ts` 的命名常量（`LIVE_POLL_MS` 等），不在组件里写数字；列表页的搜索框用 `useSearchInput`（`src/lib/use-search-input.ts`：本地输入、防抖后写进地址，地址变化时同步回搜索框）。
- 浏览器经 `/api` 前缀访问（docs/ARCHITECTURE.md §7），契约里的 `path` 不含前缀。
- 指标接口在 `http/metrics.ts` 的 `metricsApi`（摘要、目录、序列、平台自带图表）；实时增量是运行事件流上的 `metrics` 事件（`MetricIncrement`）。
- 一次运行的关注项读数在 `http/run-focus.ts` 的 `runFocusApi.focus`（`GET /runs/:id/focus?points=N`）：最新值、最终值（`final`）都在控制面算好，页面只显示；异常的判断也只在控制面做（`anomaly` 字段由控制面按 `focus-anomaly.ts` 填，有异常的项排在最前），页面不自己判断。前端只用 `useRunFocus`（运行中每 `LIVE_POLL_MS` 读一次）；一页里要读好几个运行时用 `useQueries` 配它的查询 `runFocusQuery`（Agent 管理页的槽位格：一个运行只读一次、`points=0`，再分给它的各个槽位），key 和缓存与 `useRunFocus` 相同。Agent 列表（`running_tasks` 带 `current_action` 和 `progress`）没有推送，Agent 管理页每 `STATUS_POLL_MS` 重新读一次，槽位格里的关注项也跟着这个节奏读。
- 控制台的 `GET /dashboard` 里排队中的节点也带 `queue_wait`（`DashboardActiveNode`，`http/dashboard.ts`；同一份判断，`dashboard/queued-waits.ts` 的 `withQueueWaits` 用 `agentWaits` 读取这一刻的状态，没有排队中的节点时一条查询都不多），另带 `queued_at`；运行列表的 `active_nodes`（`RunListActiveNode`）不变。
- 排队中的尝试在运行视图里带 `queue_wait`（`http/runs.ts` 的 `QueueWaitView`）：等哪台 Agent、`state`（offline、preparing、version_mismatch、slots_full、dispatching）、最后在线 / 开始准备的时间、排队超时的时间、占着槽位的任务（`SlotHolderView`，写明是哪次运行，只列读者所在项目里的；别的项目的任务只有个数 `other_project_holders`）和读取这一刻的控制面时间 `now`；Agent 的状态在控制面内存里，运行读取本身不需要它，所以只有输出给客户端的路由才填（`getRunView` 的 `queueWaits` 参数），其余内部读取一律是 `null`。页面和命令行都不自己判断「为什么没派发」。
- 一个任务的动作摘要在 `http/actions.ts` 的 `actionsApi.summary`（`GET /tasks/:id/actions/summary`）：正在做的、每种名称的总数和失败数、最近的失败都在控制面准备好，页面只显示。前端只用 `use-task-actions.ts` 的 `useActionSummary`（缓存只有一份：「动作」页签连着推送时由推送更新；没连着、任务还在执行时按调用方给的间隔重新读，结束时再读一次——画布检查器每 `ACTIONS_POLL_MS`，不为它另开推送）。

## 9. 文案

界面只用中文，不引入 i18n 框架；多处共用的文字集中在 `src/lib/copy.ts`：

- `TERM`：术语（与 `GLOSSARY.md` 一致，「编排」只作动词）；`chainLabel()`：链实例名称（主链 / 子流程 X），手上只有子流程名称（主链为 null）时用 `namedChainLabel()`。
- `PAGE`：导航与页面名（侧边栏、面包屑、页面标题、命令面板）；`FOCUS`：关注项共用的句子；`INSPECTOR_PAGE`：检查器的页名（页签、页面标题，以及「先在场景设置的「关注项」页移除一项」这类指路的提示：都引用它，改名不会漏）。
- `RUN_STATUS_LABEL`、`CANCELLING_LABEL`：运行状态文字（控制台页头的计数「运行中」「成功」「失败」也取自它，「取消」按规格写原文，不是状态词「已取消」）；节点状态文字在 `src/lib/node-status.ts` 的 `NODE_STATUS`（显示时都用 `components/status` 的 `runStatusView` / `nodeStatusView`）。
- `ACTION`：通用操作（运行、取消运行、强制终止、重试、清除筛选、展开、收起……）；`MESSAGE`：通用的加载 / 错误 / 空状态文字（含「加载中」（行内的加载提示也只写它，不写「正在加载…」）「无法加载X」（`loadFailed(X)`，X 以字母或数字开头时前面隔一个空格：「无法加载 Agent」）「还没有数据」「这次尝试没有上报数据」，`noMatch(X)`：筛选之后什么都没有的「没有符合条件的X」，日志、运行、动作共用）。
- 运行监控、运行抽屉与关注项读数用的：`MONITOR_VIEW_LABEL`（概览 / 详情两个视图的名称）、`FINAL_VALUE_LABEL`（最终值）、`FOCUS` 里异常的文字（`attention`「需要注意」，`attentionCount`「3 项需要注意」（控制台运行块读数区的标题旁、画布节点卡片和 Agent 槽位格），`moreItems`「还有 2 个关注项」（`moreLabel` 加上「关注项」，只放得下前几项时），`noneSet`「场景没有设置关注项」（概览和控制台运行块读数区的标题旁、Agent 槽位格里的主指标），`settingsLink()`「设置关注项」「调整关注项」（去场景设置「关注项」页的入口），`logReason`（「1 条 WARN · 10:58:41」「3 条 WARN / ERROR · 10:58:41」：条数是这次尝试的 WARN / ERROR 合计，只有一条时才写它的级别，时间是最近一条的）、`staleFor`、`sourceFailed`、`retryReason` 四种原因的短句，`logDetail`、`staleDetail`、`noDataDetail`、`failedDetail`、`retryDetail`「需要注意」每行写清哪个节点、为什么，`dataUpdated`「数据更新于 HH:MM:SS」，`invalidNote`「（含 N 项已失效的）」：失效的关注项和「无新数据」（`stale`）是两回事，`viewLogLine`、`viewNodeLogs`、`viewNodeAttempts`「需要注意」每行右侧的直达按钮：「在详情里查看 WARN 那一行」「在详情里查看 probe 的日志」「在详情里查看 verify 的尝试」，`otherAlertsRest`「最近 20 条，其余在详情的日志里查看」）、`LOG_LEVEL_LABEL`（日志级别的写法 DEBUG / INFO / WARN / ERROR，日志列表、级别筛选、运行抽屉和异常原因共用）与 `LOG_ALERT_LEVELS`（「WARN / ERROR」）、`MESSAGE.logsExpired`（日志已过保留期）、`chainCountLabel()`（「N 条链 · N 个节点」）、`LIST_LABEL`（列表的可访问名称：图例、各链进度、运行抽屉、控制台运行块和概览链路里进行中的节点）；`MESSAGE.noRunningNodes`（没有执行中的节点）、`MESSAGE.noActiveNodes`（没有进行中的节点）。运行抽屉、控制台的运行块和概览的链路都列排队中、准备中、执行中、等待中的节点，标题和列表名用 `ACTIVE_LABEL`（进行中），不用任何一个节点状态名；那一行的写法只有 `components/active-node` 的 `activeDetail`（还没开始执行的写状态；不在 Agent 上的停止子流程节点也只写状态）。「进行中」在运行记录页指运行（进行中的卡片），在运行抽屉和控制台指节点，在运行监控「动作」页签的结果里指还没结束的动作，几处不在同一屏。
- `NODE_ACTIONS`：动作与标记（GLOSSARY「动作」「标记」）共用的文字：`doing`（「正在做」：画布卡片和读屏的「正在做 X」、检查器的「正在做」、「动作」页签的第一组）；`runningIncomplete()`（「列满 N 个，可能还有没列出的」：正在做的动作列满了，检查器和「动作」页签共用）；`results`（动作的结果：进行中、成功、失败、未结束、标记），是动作自己的一组状态文字，不是运行状态，不引用 `RUN_STATUS_LABEL`，「进行中」引用 `ACTIVE_LABEL`；`countOnly`（「只计数」：「动作」页签只计数的那一行、时间线上动作轨道的浅斜纹和图例）；`countOnlyNoDetail`（「只计数、没有明细」：「动作」页签只计数那一行的主句和检查器的上限说明共用同一个标点）。`doingNow`（「正在」：可见处的短写，Agent 槽位格和运行监控概览执行中那一行写「正在 X」；读屏仍读 `doing` 的「正在做 X」；画布卡片用执行中的形状代替这两个字，不引用它）。「动作」页签的文字在 `ACTION_PAGE`（工具条、三组的名称、表头里的 Agent 时间、只计数的一行里的起止、原因和失败的个数、读屏播报、跳到日志），列名（耗时用 `DURATION_LABEL`）写在 `ActionTable` 里；时间切换的名称各管各的，日志页签写「日志时间」，「动作」页签写「表格里的时间」（`ACTION_PAGE.timeKind`），两份选择互不影响；检查器的计数表表头和上限说明写在 `InspectorActions` 里，只在那里出现。术语「动作」是 `TERM.action`；`attemptLabel()`（「第 2 次尝试」：尝试序号只有这一种写法，运行监控的尝试页签、范围、失败摘要、时间线，画布检查器，槽位格、控制台和概览里进行中的节点，关注项的重试原因都用它；日志合并视图的来源列只有 140px，写「名称 #N」，是唯一的例外）；`PROGRESS_LABEL`（节点上报的「进度」，图表工作区、时间线、运行抽屉、画布检查器共用；运行记录表里的「进度」是各链进度，不是它）；`DOC_PAGE["sdk-reference"]` 是开发文档「开发节点（SDK 参考）」的页名。和 `ACTION`（界面上的通用操作）不是一回事。
- 指向运行监控「详情」视图的写法：`MONITOR_DETAIL_LABEL`（「运行监控详情」：运行监控页之外的地方，如画布检查器，用它指路）、`openInLabel()`（「在运行监控详情里打开 fetch」：去另一个页面里看这个节点的按钮或链接）、`viewInLabel()`（「在详情里查看 fetch」「在日志里查看 10:00:01」：同一页里切到另一个视图或页签去看某样东西，概览的图表卡片、「需要注意」的按钮和「动作」页签里开始时间的按钮用它）、`hiddenSeriesLabel`（图例里放不下的序列，「还有 N 条序列」和 `moreLabel` 同一个说法：概览是页内切到详情，写「在详情里查看」；检查器要去另一个页面，写「打开运行监控详情」）与 `ZOOM_IN_DETAIL_LABEL`（「要缩放，打开运行监控详情」）。
- 「打开 X」是去另一个页面（「打开运行监控」「打开失败节点」：控制台的失败行进入运行监控并选中失败节点；「在画布中打开」「打开运行记录」），「查看 X」是在当前页面里展开或切换（运行监控页横幅的「查看失败节点」，概览里「在详情里查看…」）；同一个意思不换着说。
- 时长、数量与 Agent 状态：`ELAPSED_LABEL`（已运行）、`DURATION_LABEL`（耗时）、`moreLabel()`（「还有 N 个」：列表或线路只画出一部分时）、`AGENT_STATUS_LABEL`（在线、离线；Agent 的完整状态用 `#/agents/agent-status` 的 `agentStatusView`）、`slotUsageLabel()`、`queuedLabel()`（「2 / 8 占用」「排队 1」；`QUEUED_LABEL` 是「排队」这个词，控制台页头的计数和排队任务的一行时间说明也用它）、`RUNNING_PRIMARY_LABEL`（「执行中节点的主指标」）。
- `DOC_PAGE`：界面里引用的开发文档页，slug → 页名（与 `docs/guide/pages.json` 的标题一致，有单测检查）；链接用 `DocPageLink`。
- 只写一句错误的地方（运行监控的页头、「需要注意」和图表工作区的节点信息、关注项的失败原因、画布检查器、控制台「最近结束」里失败的运行、飞书运行通知的卡片）取失败原因的一行：`@sfly/schema` 的 `errorHeadline()`，之后的行是堆栈，不显示。它取错误信息里第一行有内容的文字，去掉行首的异常模块路径（`sfly_std.assert_.AssertionFailed: x` 取 `AssertionFailed: x`）；第一行以冒号结尾、下一行紧接着有内容时把下一行接上（断言失败的「1 条断言中 1 条不通过：」后面接「第 1 条：…」）。完整的错误信息原样保留，在尝试页签里显示。节点自己出错时，错误里的 `location`（节点代码里出错的那一行，「模块.函数 第 N 行」）写在失败原因下面一行，标签用 `@sfly/schema` 的 `ERROR_LOCATION_LABEL`（「出错位置」，`copy.ts` 重新导出）：只在看一个节点的详细处写——画布检查器的错误框、运行监控图表工作区的节点摘要和尝试页签、概览的失败区域（写在失败原因下面一行），以及飞书运行通知的卡片（它只写第一个失败的节点，失败原因下一行就是出错位置，docs/SEMANTICS.md §6 第 5 条）；上面其余只写一句的地方不写，没有位置时（`null`）不多出一行。命令行摘要有同样规则的一份实现（`sdk/python/src/sfly/cli/error_headline.py`），两边共用用例表 `testdata/error-headline-cases.json`：改规则要同时改两份实现和这份用例表。

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
