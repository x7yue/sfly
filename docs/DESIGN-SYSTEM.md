# 前端设计规范

前端（`apps/web`）的设计 token、配色规则、组件清单、各状态的样式，以及写页面时要遵守的约定（HTTP 契约、query key、快捷键、CSS layer）。实现与评审都以本文为依据；信息架构、布局与交互以定稿原型 `docs/prototype/frontend-v2.html` 为准，原型里的演示数据不是规格。相关决定：ADR 0005（E2E 优先）、0006（SPA）、0007（HTTP 契约用 zod）、0008（shadcn/ui + Base UI）。

定位：内网专业工具，只做深色主题、只支持桌面（最小宽度 1280）、界面只用中文。

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
| | `track`、`scrim` | 槽位条与进度条的空槽；弹窗遮罩 |
| 描边 | `border`、`border-soft`、`border-strong` | 控件 / 面板内分隔 / 浮层 |
| 文字 | `fg-1`、`fg-2`、`fg-3` | 正文 / 次要 / 辅助（对 `bg`、`surface`、`raised` 都 ≥ 4.5:1） |
| 主操作 | `primary`、`primary-hover`、`primary-foreground` | 白色按钮 |
| 信号（青） | `signal`、`signal-fg`、`signal-line`、`signal-soft` | 执行中、键盘焦点环（`ring`）、调度连线 |
| 选中 | `selected`、`selected-bg`、`selected-ring` | 中性高亮 |
| 状态 | `ok`、`warn`(`-fg`)、`danger`(`-fg`)，各带 `-soft` / `-line`；`pending`、`skipped`、`cancelled` | 见第 5 节 |
| 日志 | `log-debug`、`log-info`、`log-warn`、`log-error` | INFO 不上色 |
| 图表 | `chart-1` … `chart-4`、`chart-grid` | 多序列线色（中性灰与灰蓝，按序使用）、网格线；状态色只用于节点状态 |
| 阴影 | `shadow-float`、`shadow-pop`、`shadow-inset-top` | 悬浮控件 / 弹窗、菜单 / 可滚动区域顶部的内阴影 |

shadcn 组件用的 `background`、`foreground`、`popover`、`muted`、`accent`、`destructive`、`input`、`ring` 等名称映射到语义层；**注意 shadcn 的 `accent` 是中性悬停色，不是青色**，新代码直接用我们的名字。

### 2.3 画布专用 `--canvas-*`

`canvas-bg`、`canvas-grid`、`canvas-node-bg` / `-border` / `-selected`、`canvas-port`、`canvas-edge` / `-selected` / `-live` / `-dispatch`、`canvas-subflow` / `-fg` / `-line` / `-soft`、`canvas-run-running` / `-failed` / `-cancelled`、`--canvas-run-done-opacity`、`--canvas-minimap-mask`（小地图视口外遮罩）。画布组件（#35 起）只用这一层和语义层。节点几何常量（卡片宽高、端口位置）由 #35 收敛为单一来源。

### 2.4 配色规则

- **白色是每屏唯一的主操作**：`<Button variant="primary">` 每屏最多一个（如「新建场景」）；其余按钮用默认（中性）或 `ghost`。Logo 与头像的白底不是操作。
- **青色只用于执行中、键盘焦点环、调度连线**。不要用青色表示选中、链接或强调。
- **选中是中性高亮**：`raised` / `raised-2` 底 + 左侧 2px 白色短条（`shadow-[inset_2px_0_0_var(--primary)]`），画布上是 `selected` 描边 + `selected-ring`，相关连线灰色虚线流动。
- 绿色 = 成功，红色 = 失败，琥珀色 = 等待与警告（含安装中）。
- **已取消**用中性灰虚线圈，与跳过（淡灰空心圈）、待执行（灰空心圈）区分。
- **紫色只用于子流程区域**（`canvas-subflow*`），语义层没有紫色。
- **日志 INFO 不上色**（`log-info` = 正文色），只有 WARN / ERROR 着色，DEBUG 用辅助文字色。
- 阴影带偏移和模糊，不用零偏移的彩色发光。

## 3. 字体、字号、圆角、尺寸

- 字体随前端打包（`@fontsource`，`src/styles/fonts.css`）：IBM Plex Sans（400/500/600）界面文字，中文回退系统字体；JetBrains Mono 用于数值、ID、版本号、命令（`font-mono`）。不依赖外网。
- 数字一律等宽：`body` 设了 `tabular-nums`。
- 字号只有这几档（`text-*`）：

| 类 | 字号 / 行高 | 用途 |
|---|---|---|
| `text-2xs` | 11 / 16 | 最小字号：徽标、计数、kbd、分组标题 |
| `text-xs` | 12 / 18 | 辅助：表头、说明、次要信息、表格里的等宽数据 |
| `text-sm` | 13 / 20 | 正文（body 默认）、按钮、输入框、菜单项 |
| `text-base` | 14 / 20 | 区块与弹窗标题、空状态标题、命令面板输入 |
| `text-lg` | 16 / 24 | 页面标题 |
| `text-2xl` | 22 / 28 | 统计数字（控制台） |

  原型里的非整档字号归并：12.5 → 13（正文、菜单、面包屑）、11.5 → 11（徽标、提示）或 12（字段说明）、10 → 11；15（弹窗标题）→ 14。
- 圆角只有 `rounded-sm` 4、`rounded-md` 6、`rounded-lg` 8、`rounded-xl` 12（另有 `rounded-full`）。小于 12px 的指示元素（槽位格、进度段）用 2px。组件里不写色值、不用其他圆角任意值（`src/styles/design-rules.test.ts` 检查）。
- 控件高度：按钮 / 输入框 30（`h-7.5`），小号 26（`h-6.5`）；顶栏 48（`--topbar-height`）；侧栏 208 / 折叠 56；kbd 18。
- 系统开启「减少动效」时所有动画与过渡停止（`app.css` base 层）。

## 4. CSS layer

`app.css` 声明 `@layer theme, base, vendor, components, utilities;`，所有样式都在这些层里，后面的层优先，与选择器权重无关：

- `theme`：Tailwind 主题变量与 `tokens.css`；`base`：preflight、字体、元素基础样式；
- `vendor`：第三方样式（xyflow；sonner 运行时注入的样式由 `vite.config.ts` 的插件包进这一层）；
- `components`：确实需要的组件级 CSS（尽量不用）；`utilities`：Tailwind 工具类——组件样式都在这里，所以低层的全局规则覆盖不了组件。

端到端测试会检查页面上没有未分层的样式规则（`e2e/shell.spec.ts`）。不写按页面的全局样式文件（MVP 时期的 `.sf-*` 样式与 `legacy` 层已在 #44 删除）。

## 5. 组件清单

### 基础组件 `components/ui`

| 组件 | 说明 |
|---|---|
| `Button` | `variant`: `default`（中性）/ `primary`（白色主操作）/ `ghost` / `danger` / `danger-solid` / `link`；`size`: `default` 30px / `sm` 26px / `icon` / `icon-sm`（图标按钮必须有 `aria-label`）；禁用 40% 不透明 |
| `Input` | `sunk` 底，聚焦时青色描边 + 光晕（焦点），`aria-invalid` 时红色描边 |
| `Textarea`、`NativeSelect` | 多行输入、原生下拉选择，外观与 `Input` 一致 |
| `Segmented` | 分段选择（筛选、视图切换）：`fieldset` + `aria-pressed` 按钮，当前项中性高亮；只有图标的选项给 `label` |
| `Badge` | `default` / `ok` / `warn` / `danger`；版本号、计数等 |
| `Dialog` | 模态弹窗：锁定焦点、Esc 与点遮罩关闭、关闭后焦点回到打开前的元素；距顶 12vh、宽 520（`className` 覆盖） |
| `Sheet` | 抽屉（右侧 460px），焦点行为同 Dialog |
| `DropdownMenu` | 菜单（Base UI Menu） |
| `Command` / `CommandDialog` | 命令面板（cmdk + Dialog） |
| `Tooltip` | 悬浮提示（根部已有 `TooltipProvider`，延迟 400ms） |
| `Table` 系列 | 表头 12px 三级文字；行悬停 3% 白；`data-state="selected"` 为中性选中 |
| `Kbd`、`Skeleton`、`Separator`、`Toaster` | 按键、骨架、分隔线、通知容器 |

### 应用组件 `components/`

| 组件 | 说明 |
|---|---|
| `app-shell/AppShell` | 外壳：侧边栏（导航来自 `navigation.ts`，可折叠，状态存 localStorage）、顶栏（面包屑来自路由 `staticData.crumb`、Ctrl K 搜索入口、昵称） |
| `app-shell/overlays` | 全局浮层：命令面板、快捷键面板、昵称弹窗、运行抽屉、通知；`useOverlays().open("shortcuts")`、`useOverlays().runScenario(场景)` |
| `app-shell/CommandPalette` | 「跳转」「场景」「运行」（最近的运行）「运行场景」（打开运行抽屉）「命令」五组；新命令加在 `commands` 里 |
| `page`：`Page`、`PageHeader`、`Panel`、`SectionHeading`、`Keys`、`CodeBlock` | 页面版式；`Keys keys="Ctrl+K"` 显示按键；`CodeBlock` 带复制 |
| `status`：`StatusPill`、`StatusDot`、`SlotBar`、`runStatusView`、`nodeStatusView` | 状态与槽位，见下表；运行 / 链 / 节点状态的颜色与文字只从 `runStatusView`（含「取消中」）与 `nodeStatusView` 取，不另写映射表 |
| `chain-progress`：`ChainBar`、`ChainBars` | 各链进度条（`ticks` / `wide` 两种形状，配色只在这里） |
| `sparkline`：`Sparkline` | 迷你趋势（控制台统计卡、主指标） |
| `feedback/states`：`EmptyState`、`TableSkeleton`、`ErrorState`、`QueryView` | 空 / 加载 / 错误；`QueryView` 把查询的四种状态接上 |
| `feedback/notify` | `notify.success / info / warning / error` |
| `shortcuts`：`useShortcut`、`ShortcutsDialog` | 见第 7 节 |

## 6. 各状态的样式

### 6.1 运行与节点状态（`StatusPill kind=…`）

| kind | 样式 | 用于 |
|---|---|---|
| `ok` | 绿色实心点 | 成功、在线 |
| `running` | 青色实心点，脉冲 | 执行中 |
| `failed` | 红色实心点 | 失败 |
| `warn` | 琥珀实心点 | 等待、警告、安装中 |
| `pending` | 灰色空心圈 | 待执行、离线 |
| `skipped` | 淡灰空心圈（70% 不透明） | 已跳过 |
| `cancelled` | 灰色**虚线**圈 | 已取消 |

### 6.2 空、加载、错误、禁用

- **空**：`EmptyState`——图标方块、14px 标题、说明、下一步操作（按钮或 `CodeBlock` 命令示例），放在 `Panel` 里。
- **加载**：`TableSkeleton`（按表格列数画骨架，`role=status` 名称「加载中」）；首次加载才显示，后台刷新不闪。
- **错误**：`ErrorState`——红色描边块，标题「无法加载 …」、原因、一行错误详情（`GET /api/agents → 503 code`）、「重试」与「复制错误详情」（含 details）。已有数据时后台刷新失败不替换页面。查询默认失败后再重试 2 次（间隔 1 秒），4xx 不重试（`src/router.tsx`）。
- **禁用**：40% 不透明、`cursor-not-allowed`，不换颜色。
- **通知**：顶部居中；成功 / 信息 2.6 秒、警告 5.2 秒后消失，失败需要手动关闭。

## 7. 键盘、焦点与快捷键

- 焦点环统一是 2px 青色外框（`:focus-visible`），组件不要用 `outline-none` 去掉它（输入框改用青色描边 + 光晕）。
- 弹窗与抽屉用 `Dialog` / `Sheet`：锁定焦点、Esc 关闭、关闭后焦点回到原处；自己写的浮层也必须满足，并加端到端测试。
- **快捷键注册表** `src/lib/shortcuts.ts` 的 `SHORTCUTS` 是唯一来源：快捷键面板（?）从它生成，页面用 `useShortcut(id, handler)` 绑定。新增快捷键先登记（分组「全局 / 编排画布 / 运行监控」、名称、按键、是否允许在输入框或弹窗中触发），再绑定；没有绑定的不要登记。写法：`Ctrl+K`（同时按）、`G D`（1 秒内依次按）；Ctrl 同时匹配 ⌘；默认焦点在输入框里或有弹窗打开时不触发。

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
- `RUN_STATUS_LABEL`、`NODE_STATUS_LABEL`、`CANCELLING_LABEL`：状态文字（显示时用 `components/status` 的 `runStatusView` / `nodeStatusView`）。
- `ACTION`：通用操作（运行、取消运行、强制终止、重试、清除筛选……）；`MESSAGE`：通用的加载 / 错误 / 空状态文字。

规则：两处及以上用到的文字、状态与术语放在这里，新增时先加到这里再引用，不要在组件里另写一份；只在一个页面出现的说明文字（空状态说明、提示语）留在组件里。

## 10. 新页面检查清单

1. 路由放在 `routes/_shell/`（或全屏页放 `routes/`），写 `staticData: { crumb }`；一级页面同时加到 `navigation.ts` 与快捷键注册表。
2. 数据走契约（先在 `@sfly/schema` 定义接口，再在控制面用 `contractRoute`），查询用 `apiQuery`。
3. 版式用 `Page` / `PageHeader` / `Panel`；列表用 `QueryView` 接上空 / 加载 / 错误。
4. 只用语义层与画布层 token、规定的字号与圆角；状态用 `StatusPill` + `runStatusView` / `nodeStatusView`；共用文案从 `lib/copy.ts` 取；每屏最多一个 `primary` 按钮。
5. 弹窗用 `Dialog` / `Sheet`；操作结果用 `notify`。
6. 端到端测试覆盖用户可见的行为，关键状态加视觉基线（`pnpm test:e2e:docker --update-snapshots`）。
