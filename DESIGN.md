---
name: sfly
description: 内网测试编排平台的深色桌面工具界面：炭灰分层、状态语法严格、青色只给「执行中」。
colors:
  sunk: "#161616"
  bg: "#1a1a1a"
  surface: "#1f1f1f"
  raised: "#262626"
  raised-2: "#2e2e2e"
  track: "#3a3a3a"
  border: "#333333"
  border-soft: "#2b2b2b"
  border-strong: "#444444"
  border-control: "#707070"
  fg-1: "#ececec"
  fg-2: "#a8a8a8"
  fg-3: "#969696"
  primary: "#f2f2f2"
  primary-foreground: "#141414"
  signal: "#2cc4f0"
  signal-fg: "#7fdcf7"
  selected: "#d4d4d4"
  ok: "#5bd69a"
  warn: "#f0a83a"
  warn-fg: "#f3c27a"
  danger: "#ef5350"
  danger-fg: "#ff8f8c"
  pending: "#8e8e8e"
  cancelled: "#9a9a9a"
  stopped: "#a8a8a8"
  skipped: "#7a7a7a"
  subflow: "#b4a3f8"
  subflow-fg: "#dcd3fd"
  chart-1: "#d4d4d4"
  chart-2: "#8aa4c0"
  chart-3: "#9a9a9a"
  chart-4: "#6f8fae"
typography:
  page-title:
    fontFamily: "IBM Plex Sans, PingFang SC, Noto Sans CJK SC, Microsoft YaHei UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  section-title:
    fontFamily: "IBM Plex Sans, PingFang SC, Noto Sans CJK SC, Microsoft YaHei UI, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
  body:
    fontFamily: "IBM Plex Sans, PingFang SC, Noto Sans CJK SC, Microsoft YaHei UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  caption:
    fontFamily: "IBM Plex Sans, PingFang SC, Noto Sans CJK SC, Microsoft YaHei UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
  label:
    fontFamily: "IBM Plex Sans, PingFang SC, Noto Sans CJK SC, Microsoft YaHei UI, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "16px"
  stat:
    fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, PingFang SC, Noto Sans CJK SC, Microsoft YaHei UI, monospace"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "28px"
  mono:
    fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, PingFang SC, Noto Sans CJK SC, Microsoft YaHei UI, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  indicator: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
spacing:
  control: "30px"
  control-sm: "26px"
  topbar: "48px"
  sidebar: "208px"
  sidebar-collapsed: "56px"
components:
  button-default:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg-1}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 12px"
  button-default-hover:
    backgroundColor: "{colors.raised-2}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 12px"
  button-ghost:
    textColor: "{colors.fg-2}"
    rounded: "{rounded.md}"
    height: "30px"
  button-ghost-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg-1}"
  button-danger-solid:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "30px"
  button-danger-solid-hover:
    backgroundColor: "{colors.danger-fg}"
  input:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.fg-1}"
    borderColor: "{colors.border-control}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 10px"
  switch-on:
    backgroundColor: "{colors.selected}"
    thumbColor: "{colors.primary-foreground}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  node-card:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg-1}"
    rounded: "{rounded.lg}"
  badge:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg-2}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "20px"
---

# Design System: sfly

> 规格与实现细节（三层 token、CSS layer、组件 API、快捷键注册表、HTTP 契约）以 `docs/DESIGN-SYSTEM.md` 为准；本文件是给设计与生成用的视觉摘要，两者冲突时以 `docs/DESIGN-SYSTEM.md` 和 `apps/web/src/styles/tokens.css` 为准。

## Overview

**Creative North Star: "夜班控制室"**

sfly 的界面是一间深夜值守的控制室：整面炭灰、没有色偏，屏幕安静到只剩下正在发生的事。唯一会亮的是青色——它只属于「执行中」、键盘焦点和调度连线；成功、失败、等待各有固定的颜色与形状，异常因此一眼可见。工程师可以开着它盯几个小时的浸泡测试而不疲劳，回来排查失败时也能立刻找到红色的那一段。

密度接近 IDE：30px 控件、13px 正文、等宽数字，一屏放下时间线、图表和日志。层级靠表面的明度台阶（sunk → bg → surface → raised → raised-2）和 1px 描边建立，而不是阴影和装饰。每屏只有一个白色实心按钮，那就是这一屏的主操作。

组件手感是**紧凑、克制，像工具**：效率优先，装饰为零，颜色只用来说明状态。

**Key Characteristics:**
- 只做深色，炭灰无色偏的五级表面台阶
- 青色是稀缺信号：执行中、焦点环、调度连线，别无他用
- 严格的状态语法：颜色 + 形状共同编码，每种状态一个形状（圆点 / 点加外圈 / 菱形 / 三角 / 空心圈 / 半实心圈 / 斜杠圈 / 虚线圈 / 方块），不看颜色、不看动画也能分辨
- IDE 级密度，数字一律等宽
- 节点卡片是贯穿全产品的基本单元（画布、运行画布、版本对比、缩略图）

## Colors

中性炭灰承载一切，彩色只出现在状态上。

### Primary
- **控制台白** (`primary`)：每屏唯一的主操作按钮（如「新建场景」「触发运行」），以及选中项左侧 2px 短条。白色就是「下一步做这个」。

### Secondary
- **执行中青** (`signal`，文字用 `signal-fg`)：执行中的状态标记（点加外圈）、画布描边、进入执行中节点的连线、调度连线、键盘焦点环。执行中的时间线段、链路进度段、场景缩略图节点这类有面积的色块用淡底 `signal-fill` 加 1px `signal-line` 描边，只有时间线段尾的脉冲头是实心青色。
- **子流程紫** (`subflow`，文字用 `subflow-fg`)：只用于画布上子流程区域的描边、标题与淡底；语义层没有紫色。

### Tertiary（状态色）
- **成功绿** (`ok`)、**失败红** (`danger`，深底上的文字用 `danger-fg`)、**等待琥珀** (`warn`，文字用 `warn-fg`)：节点与运行状态、日志 WARN / ERROR、校验警告。各自带 `-soft`（带文字的淡底，≈ 1.15:1）、`-line`（描边，在面板上 ≥ 3:1）与 `-fill`（进度段、缩略图、时间线这类面积色块，每种状态固定一档）。状态文字一律用 `-fg` 变体，不带 `-fg` 的只给标记、描边与色块。
- **琥珀只有三个意思**：等待中（定时 / Sleep 节点）、警告、安装中。排队中是「轮到了，在等 Agent 的槽位」，不是要人处理的等待，用中性灰。
- **灰阶状态**：待执行 (`pending`，空心圈)、排队中（灰，半实心圈）、已跳过 (`skipped`，斜杠圈)、已取消 (`cancelled`，虚线圈)、已停止 (`stopped`，实心方块)——停止是正常流程，不用警示色。

### Neutral
- **凹陷** (`sunk`)：输入框、代码块、日志区。
- **页面** (`bg`) / **面板** (`surface`) / **抬起** (`raised`) / **悬停与选中** (`raised-2`)：从低到高的表面台阶。
- **槽** (`track`)：进度条、槽位条的空槽。
- **描边** (`border`、`border-soft`、`border-strong`)：面板与分隔线 / 面板内分隔 / 浮层，有意安静；表单控件（输入框、下拉、勾选框、开关、分段）的边界单独用 `border-control`，在所在表面上 ≥ 3:1。
- **文字三级** (`fg-1` 正文、`fg-2` 次要、`fg-3` 辅助)：三级在 bg 到 raised-2 的所有表面上都 ≥ 4.5:1。
- **图表线** (`chart-1` … `chart-4`)：中性灰与灰蓝，按序使用；图表线不用状态色。

### Named Rules
**The Scarce Cyan Rule.** 青色只表示执行中、键盘焦点、调度连线。不用青色表示选中、链接、强调或品牌；实心青色只给状态点、脉冲头和焦点环，长时间运行里面积最大的执行中色块不能是饱和青。
**The One White Rule.** 每屏最多一个 `primary` 白色按钮；其余按钮是中性或 ghost。
**The Status-Only Color Rule.** 彩色只在表达状态时出现；数值为 0 的统计、指标曲线、装饰都不着色。

## Typography

**Body Font:** IBM Plex Sans（400 / 500 / 600），中文回退到写明的系统黑体（苹方、Noto Sans CJK、微软雅黑 UI）
**Mono Font:** JetBrains Mono，用于数值、ID、版本号、命令、日志；中文同样回退到黑体（不交给系统挑「等宽中文」，Windows 上那是新宋体），关闭编程连字（`>=`、`!=`、`->` 照原样显示）

**Character:** Plex 的工程气质配 JetBrains Mono 的等宽数字，像带刻度的仪器面板；没有展示字体，标题靠字重和小步长字号区分。

### Hierarchy
- **Stat** (600, 22px, 28px, 等宽)：控制台统计数字，全站唯一的大字号。
- **Page title** (600, 16px, 24px)：页面标题。
- **Section title** (600, 14px, 20px)：区块、弹窗、空状态标题。
- **Body** (400, 13px, 20px)：正文、按钮、输入框、菜单项（body 默认）。
- **Caption** (400, 12px, 18px)：表头、说明、字段说明、次要信息、表格里的等宽数据；中文的最小字号。
- **Label** (500, 11px, 16px)：最小字号，只给数字、拉丁字母与 kbd（计数、刻度、ID、按键）；有中文就用 12px。

### Named Rules
**The Fixed Scale Rule.** 只有 11 / 12 / 13 / 14 / 16 / 22 六档字号，不写任意值（实现用 rem，上面是默认根字号下的像素值）。
**The CJK Weight Rule.** 中文的层级不靠 500：微软雅黑只有 400 与 700，500 在 Windows 上和正文一样。要比旁边醒目，用颜色台阶（`fg-1` 对 `fg-2` / `fg-3`）或 600。
**The Tabular Rule.** 所有数字等宽（body 已设 `tabular-nums`）；ID、版本、耗时、命令用等宽字体。

## Layout

桌面专用，最小宽度 1280（运行监控页窄到 1024 仍可用，顶栏按钮收成图标）。外壳是左侧栏（208px，可折叠到 56px）+ 48px 顶栏 + 内容区；编排画布与运行监控是全屏页，不带侧栏，控件悬浮在画布之上或分成顶栏 / 时间线 / 图表 / 底部面板四段纵向布局。列表页用 `Page` / `PageHeader` / `Panel` 版式：内容区铺满侧栏右侧的宽度，两侧固定 32px 边距，不设最大宽度（大屏上不留大块空白；文档正文自己限制阅读宽度 820px），面板之间 10–14px 间距，面板内 12–14px 内边距。信息密度高：一行能放下的就不折行，次要信息靠 `fg-3` 与 12px 退后而不是隐藏。

## Elevation & Depth

整体是平的：深度主要来自表面明度台阶和 1px 描边。阴影只给真正浮在上面的东西，并且都带偏移和模糊（`shadow-float` 给画布悬浮控件组与浮动工具条，`shadow-pop` 给弹窗与菜单，`shadow-inset-top` 给可滚动区域顶部）。

### Named Rules
**The Tonal Depth Rule.** 页面上的层级用 sunk → bg → surface → raised → raised-2 表达；阴影只属于浮层。
**The No-Glow Rule.** 不用零偏移的彩色发光；执行中的脉冲是唯一的光晕动画。一屏内每个执行中对象只在一处脉冲（它的前沿：时间线的段尾、运行的状态标签），状态点默认静止。输入框聚焦时的 3px `signal-soft` 光晕是唯一的静态例外，只给可输入的控件。

## Shapes

小而一致的圆角：控件 6px，面板与节点卡片 8px，大容器 12px；小于 12px 的指示元素（槽位格、进度段）用 2px。描边一律 1px；选中用中性 `selected` 描边加淡 ring，已取消用虚线描边。

## Components

### Buttons
- **Shape:** 6px 圆角，默认高 30px（小号 26px）。
- **Default:** `raised` 底、`border` 描边、`fg-1` 文字，悬停变 `raised-2`。
- **Primary:** 白底黑字，每屏一个。
- **Ghost:** 透明底、`fg-2` 文字，用于工具条与次要操作。
- **Danger / Danger-solid:** 只在确认弹窗等危险操作处。`danger-solid` 和白色主按钮一样是实心底配深色字（5.3:1），悬停换成更亮的 `danger-fg` 底。
- **Pressed:** 每个状态看起来都不同：中性按钮按下比静止深一档（`surface`），ghost 按下 `raised-2`，白色与红色按钮按下回到底色以下一档；不用缩放。
- **Focus / Disabled:** 全局 2px 青色焦点环（即时出现，不随颜色过渡）；禁用 40% 不透明、不换色。

### Inputs / Fields
- **Style:** `sunk` 底、`border-control` 描边（≥ 3:1）、6px 圆角、30px 高。
- **Focus:** 青色描边 + 光晕（No-Glow 规则的明确例外）；强制颜色模式下另有系统颜色的轮廓。
- **Checkbox / Switch:** 勾选、打开都是中性高亮（`selected` 底、深色对勾或圆点），不用绿色——「必填 = 是」不是「成功」。
- **Error:** 红色描边，字段下方 12px `danger-fg` 说明。

### Cards / Containers
- **Panel:** `surface` 底、`border-soft` 描边、8px 圆角，无阴影；小节标题右侧延伸一条分隔线。

### Navigation
- 侧栏项 34px 高、8px 圆角、`fg-2` 文字；悬停 `raised`；当前页 `selected-bg` 底 + 左侧 2px 白色短条 + `fg-1` 文字（强制颜色模式下换成系统高亮描边）。快捷键以 kbd 显示在项右侧（依次按的写「G 然后 D」）。

### Status Pill / Dot（签名组件）
颜色 + 形状共同编码运行与节点状态，每种状态一个 8px 形状：成功绿实心圆点、执行中青色圆点加外圈、失败红实心菱形、等待琥珀实心三角、待执行灰空心圈、排队中灰半实心圈、已跳过灰斜杠圈、已取消灰虚线圈、已停止灰实心方块。形状用 currentColor 画，红绿色觉缺陷、强制颜色模式、减少动效下都能分辨。状态点默认静止，只在执行中对象的前沿脉冲一处。有面积的状态色块（进度段、缩略图节点、时间线区段）同样按状态表画：执行中、失败、等待满高，其余矮一档。颜色、形状与文字只从统一的状态表（`components/status.tsx` 的 `STATUS`）取。

### Node Card（签名组件）
`raised` 底、8px 圆角的节点卡片：头部是种类图标（lucide 线性图标，缩小视图时也保留）、节点 ID、种类名（标题已说明种类时省略）和状态位（只在有警告或运行状态时出现），中间是标题，底部是 `sunk` 摘要槽（配置摘要或主指标迷你趋势；还没有配置时用辅助文字、非等宽）。运行状态叠加在描边上（执行中青、失败红、已取消虚线、已停止灰）；已完成与已跳过的节点「下沉」到画布底色，待执行、已取消、已停止的标题换成次要文字色——退后的状态都不用不透明度，文字对比度不降。版本对比里被删除的节点是红色虚线描边加删除线标题。

## Do's and Don'ts

### Do:
- **Do** 用表面台阶和 1px 描边建立层级，阴影只给浮层。
- **Do** 让状态同时用颜色和形状表达，并使用统一的状态组件。
- **Do** 把数字、ID、耗时、版本写成等宽。
- **Do** 在高风险对话框里写清后果，dismiss 按钮用「继续运行」这类动作名。
- **Do** 保证 `fg-3` 及以上的文字在所在表面上 ≥ 4.5:1，不在文字上再叠不透明度。

### Don't:
- **Don't** 用青色表示选中、链接或强调。
- **Don't** 在一屏放第二个白色实心按钮。
- **Don't** 给图表线、零值统计或装饰着状态色。
- **Don't** 写规定以外的字号、圆角或色值（组件里不写色值）。
- **Don't** 用 11px 写中文（11px 只给数字、拉丁字母与 kbd）。
- **Don't** 让状态只靠颜色或只靠动画表达。
- **Don't** 做浅色主题或移动端布局（产品约束：只做深色、只支持桌面）。
