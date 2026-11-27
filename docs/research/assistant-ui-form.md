# 助手在控制台里放成什么样：独立页面、侧栏还是悬浮窗

调研日期：2026-11-27。起因：维护者看了会话页的截图后问，助手的页面是不是内部定稿就开干的；维护者用过、看过的内部网站里，AI 助手多是悬浮窗一类，shadcn/ui 也有现成的方案。核对的结果是：底层（pi 怎么嵌、跑在哪）有两路调研、两份立场稿和评测集对照实验（#442、ADR 0027）；「独立页面」来自 #442 第 8 条的产品定位，**但没有和侧栏、悬浮窗比较过，没看过同类产品和 shadcn 生态的 AI 组件，设计也没有人看过**（#550 的设计评审是模型做的）。这份文档补上这一块，结论由维护者拍板。

**结论（建议）：保留独立页面作主界面，加「就地侧栏」作第二种外框（方案二）。** 长任务、自己干活的助手，同类产品没有一家把悬浮窗当主界面：它们以会话列表加会话页为主，再在对象页（失败的流水线、告警、issue）上放就地入口，用侧栏或面板发起和看进度，要看全过程时交接到全页。随手问答一类在开发平台和云控制台里几乎都是右上角图标打开的右侧面板（右下角悬浮按钮只在通用 SaaS 里见到），而且只要助手能长时间干活，也都另有会话列表和全页。sfly 的会话接口和事件不用动；方案二只动前端，不影响 #551 和 #553 的进行。shadcn 官方今年出了 Base UI 版的聊天和代理组件，但会话页不整套换，以后借个别部件。

怎么核实的：

- 同类产品：两路调研各看了 12 个、13 个产品，只用官方文档、官方博客和更新日志、官方仓库，每条带链接，查不到的写明（§2）。关键的几条（GitHub 的浮层面板、issue 页的会话侧栏）我另外打开原文核对过。
- shadcn 生态：用 Context7 和官方仓库（`gh api` 读源码、取官方注册表的 JSON、npm 官方元数据）逐个核对依赖和 import（§3）；shadcn 官方 2026-10 的更新日志我打开原文核对过。
- 现在的界面：**没有起真实环境**。`verify-sfly` 只能在 Linux 上跑，A3 团队正在这台 16 GB 的机器上跑重型测试，所以用的是 `dev`（74d5a16b，#762）上 e2e 的视觉基线图（`apps/web/e2e/__screenshots__/visual.spec.ts/` 下的 `session-*.png`、`assistant-list-queue.png`）。
- 三种布局的对比原型：`docs/prototype/assistant-forms.html`（单文件、不联网，用完即弃），用的是 e2e 固定事件里那段虚构的「接口巡检」会话（`apps/web/e2e/session-timeline-support.ts`），在 1440 和 1280 宽下都看过。

## 1. 现状和几条跟形态有关的事实

**现在的样子**（视觉基线，1440×900）：导航第二项「助手」；助手页是就绪状态一行、「要做什么？」输入框和「开始」、本项目的会话表（会话、发起人、状态、最近活动）。会话页是三栏：外壳的导航（约 208px）、时间线（约 800px）、右侧的成果栏（18rem）。时间线里一行一个工具调用（`$ uv run pytest -q tests/test_http_check.py` 加「并行 · 出错 · 退出码 1 · 2.9s」正好一行），编辑展开是差异，平台记录有左竖线和「平台记录」标签，运行下面将来内嵌运行卡片（#551）。

**「独立页面」从哪来**：#442 第 8 条「项目首页是会话列表加提要求的输入框。会话页是对话，旁边是平台生成的成果清单和待批准的操作。失败的运行页上可以『让助手排查这次失败』，场景页上可以『让助手改这个场景』」；ADR 0027「页面」一节「导航加『助手』，会话列表加输入框，加会话页；首页换成会话列表放在骨架验收之后（#553）」。也就是说，就地入口从一开始就在计划里，只是没做（#551、#553 都写明不做）。

下面几条是我在代码里核对过的，决定了哪种形态容易、哪种难：

1. **会话接口和界面形态无关。** 契约里只有七个：列出、新建、读（带往前翻页）、事件流、发话、停止、结束（`packages/schema/src/http/sessions.ts`）。新建的请求体只有第一句话（`CreateSessionBody = { text }`，`packages/schema/src/sessions.ts`）。所以「从失败的运行发起」在前端预填第一句话（带运行号）就能做，助手自己用 `sfly run show`、`sfly run logs` 读；侧栏、悬浮窗、独立页面用的是同一组接口和同一份事件。
2. **运行监控和编排画布是全屏页，不在外壳里**（`apps/web/src/routes/runs/$id.tsx`、`apps/web/src/routes/orchestrations/$id.tsx`；`docs/DESIGN-SYSTEM.md` §1「全屏页……不进 `_shell`」）。#442 计划的两个就地入口恰好都在这两页上：挂在外壳里的侧栏到不了那里，侧栏要能挂在全屏页上。
3. **控制面是 HTTP/1.1**（`apps/server/src/http/api.ts`），浏览器对同一来源大约只给 6 条连接，`apps/web/src/lib/sse.ts` 开头写明「一个页面尽量只开必要的流」。会话页开一条会话的事件流；运行监控按需开运行状态、日志、动作明细的事件流。侧栏只在打开时连会话的事件流、收起就断开，才不会和运行监控抢连接。
4. **控制台只支持桌面，最小宽度 1280；运行监控窄到 1024 仍可用**（`docs/DESIGN-SYSTEM.md` 开头）。1280 宽时，一条 420px 的侧栏推开运行监控之后，运行监控剩约 860px，在它能用的范围里。
5. **一轮动辄十几分钟、几十到几百个工具行。** #553 的「一句话之后的十分钟」；#550 量过 500 个工具行的首屏和滚动（`apps/web/e2e/session-long-measure.spec.ts`）。时间线在 1440 宽时约 800px，工具行、差异、提交的文件列表都按这个宽度排。
6. **同一个项目同一时刻只跑一轮**（GLOSSARY「排队」）。不管放在哪里，助手的每一句话都可能排在别人十几分钟的一轮后面，而且每一轮都占工作台、留一次提交。「随手问一句」在现在的后端上就是一次排队的一轮，见 §4 方案三。
7. **外壳的导航项本来就能显示计数**（`apps/web/src/components/app-shell/AppShell.tsx`，Agent 在线数）。「助手 · 1 在做」可以照这个做。
8. **#770（#551，在审）**加了会话页的窄窗口布局（成果栏收到时间线下面）和内嵌的运行卡片（只用运行监控共用的那份订阅）。侧栏可以直接用这两样。

## 2. 同类产品怎么放 AI 助手

分两类看：长任务、自己干活的（一个任务十几分钟、有工具调用和成果）；随手问答、就地帮忙的。表里每一行的官方来源列在文末「附：来源」。

### 2.1 长任务、自己干活的助手（12 个）

| 产品 | 入口 | 形态 | 长任务怎么呈现 | 离开页面后怎么看 |
|---|---|---|---|---|
| GitHub Copilot 编码代理 | 全站顶栏的 Agents 按钮、仓库的 Agents 标签、issue 指派、聊天里 `/task` | 浮层面板（官方原话「lightweight overlay」，发起和看状态，「without navigating away」）→「View all tasks」进全屏页；仓库 Agents 标签左列表右详情；issue 和 Projects 上点会话在**侧栏**里看进度、追加指令 | 会话日志：相似工具调用分组折叠、输出内联预览、差异一键展开；运行中可以插话、停止 | 会话列表、完成后请求 PR 评审的通知、issue 头部的会话标记 |
| OpenAI Codex（云任务） | ChatGPT 侧边栏、IDE、Slack、手机 | 独立页面（任务列表 → 任务详情） | 终端日志和测试输出作证据，加差异和 PR | 跨设备的任务列表；通知查不到 |
| Google Jules | 独立网页、issue 打 `jules` 标签 | 独立页面：活动流加右侧差异面板 | 先出计划，人离开会自动批准；实时活动流 | 浏览器通知（计划就绪、完成、失败）。官方更新日志写 2026-12-31 停服 |
| Claude Code 网页版 | claude.ai/code、手机、命令行 | 独立页面：左会话栏、中对话、右侧可隐藏的成果栏（Changes 卡片） | 差异、行内评论、建 PR | 会话侧栏、手机；云会话的通知查不到 |
| Devin | 网页（Slack 是主入口）、Jira、Linear | 独立应用；2026-11 把「自动弹开的工作区标签」改成对话右侧默认收起的成果栏 | 单一活动流，可搜索、过滤、按任务筛选 | 按 Working / Ready / Blocked / Inactive 分组的会话栏、通知收件箱、推送 |
| Cursor 云端代理 | cursor.com/agents、桌面版、`@cursor` | 网页独立页；桌面版的面板只是列表入口 | 对话流；PR 附截图、视频、日志 | 多端共用一份列表、推送 |
| Datadog Bits Investigation | 监控状态页和事件侧板上的「Investigate with Bits」、告警自动触发 | 独立调查页，结论摘要写回监控页 | 进行中看步骤，完成后看假设树 | 结论贴回原告警的 Slack、工单、On-Call |
| Grafana Assistant Investigations | 全页 Workspace、侧栏里切到调查模式、告警自动触发、事件页面板 | **侧栏加全页 Workspace，同一会话来回搬**：Workspace 是「a full-page Assistant experience……instead of the narrow sidebar」「designed for longer conversations」；侧栏里的对话可「Open in Workspace」，助手替你打开别的页面时对话回到侧栏继续 | 报告、假设、证据来源三个视图；运行中 `/ask` 不打断、排队、立即转向 | 列表分打开中 / Working / Done，行尾图标标出「在问你、等批准、失败」，加未读点；事件页面板显示状态和摘要 |
| GitLab Duo Agent Platform | issue 上「Implement」、失败流水线上「Fix pipeline with Duo」、侧栏聊天 | 右侧 Duo 侧栏（聊天加个人会话列表）加项目的 AI > Sessions 页 | 会话日志（全部或精简）；人工检查点批准、拒绝、修改 | 侧栏「Needs a decision」标签、待办、邮件；MR 上的系统备注带会话链接 |
| Sentry Seer Autofix | issue 详情页、按项目自动触发 | **issue 页里的面板**，没有单独的会话列表（查不到） | 实时思考流 → 根因 → 方案 → 代码 → PR | 进度变成 issue 的状态（已诊断、已提修复），Issues Inbox 按它分组 |
| n8n Assistant（原 AI Workflow Builder） | 随处可开；编辑器里的 AI 按钮、节点报错的「Ask AI」**交接**成新线程，带上当前工作流和失败的执行 | 从编辑器里的侧面板演变成助手自己的视图：线程栏、对话、成果面板（可与画布并排） | 构建 → 执行 → 修错循环，实时进度 | 线程行上转圈；通知查不到 |
| Replit Agent | 编辑器主栏、任务看板 | 助手就是工作区的主栏，加 Drafts / Active / Ready / Done 看板 | 在隔离副本里构建，审阅后再应用 | 看板、推送 |

规律（每条后面是支持它的产品）：

1. **长任务的完整过程放在独立页面或全页视图里，不放在悬浮窗里。** GitHub、Codex、Jules、Claude Code、Devin、Cursor、Datadog、Grafana、GitLab、Replit。反例是 Sentry（issue 页里的面板）：任务属于一个对象时，过程可以就放在那个对象的页面上。
2. **面板、侧栏、浮层只负责「发起、看状态、跳转」，同一个会话能交接到全页。** GitHub、Grafana、GitLab、Cursor、n8n。
3. **独立页面收敛成「左会话列表、中对话或活动流、右成果栏（可收起）」。** Claude Code、Devin、Grafana、Jules、n8n、GitHub、Replit。sfly 现在的会话页已经是这个样子（会话列表在单独的助手页上）。
4. **工具调用流要降噪**：分组折叠、过滤，或者分「过程」和「结论」两种视图。GitHub、Devin、Datadog、Grafana、Jules。
5. **离开后靠「按状态分组的列表、单独突出『需要你』、通知」找回。** Devin、Grafana、GitLab、Replit、Jules、Cursor、GitHub。
6. **成果和状态写回它所属的对象，对象页上露出入口。** GitHub、GitLab、Sentry、Datadog、Grafana、Jules。反例是 Codex、Claude Code、Cursor，它们的对象就是仓库和 PR。

### 2.2 随手问答、就地帮忙的助手（13 个）

| 产品 | 入口 | 形态 | 上下文 | 历史 | 长任务在哪 |
|---|---|---|---|---|---|
| GitLab Duo Chat | 右侧常驻的 Duo 侧栏、快捷键 `d`；失败作业上「Troubleshoot」，失败流水线上「Fix pipeline with Duo」 | 右侧侧栏，可调宽；没有全页聊天 | 自动带当前页的标题和地址；可按地址、编号引用别的对象 | 换页面还是同一个对话，有历史 | 对话里显示进度和「View Agent Session」；侧栏会话列表分「Needs a decision」「All」；AI > Sessions 页 |
| GitHub Copilot Chat | 顶栏图标；失败的 Actions 上「Explain error」和「Fix with Copilot」 | 页内面板，可一键转全页（immersive） | 自动附上当前的 PR、issue | 最多 100 个对话、消息留 28 天 | 页内面板里**起不了**代理，要去全页、首页或 Agents 标签；「Fix with Copilot」直接起代理会话 |
| Grafana Assistant | 右上角图标；面板菜单里的「Explain」「Troubleshoot」 | 侧栏、浮动面板、置顶小窗、全页 Workspace 四种，同一个对话在它们之间搬 | 页面上下文、选中的面板、`@` | Workspace 左栏，按 Working / Done / 等你 分组 | 调查在 Workspace 里 |
| Supabase | `Cmd+I`；SQL 报错时「Debug with Assistant」、策略和函数上「Edit with Assistant」 | 常驻侧栏：超宽屏推开内容并排，中等屏盖在内容上，手机是底部 sheet（源码）；可最大化或「Open in Explorer」转全页 | 所在页面；按钮自动带上出错的 SQL 和错误 | 按项目分多个对话，存在浏览器本地 | 基本没有后台长任务 |
| Datadog Bits | 顶栏「Ask Bits」、`Cmd/Ctrl+I`；各处「Investigate」 | 侧栏或全页；自主调查是独立页面 | 自动限定到点击的对象 | 服务端保存，有列表 | 完全自主的调查在独立页面和列表 |
| AWS 控制台助手（原 Amazon Q） | 导航栏图标；错误提示上「Diagnose」 | 侧面板，可拖宽、可全屏 | Region；Diagnose 自动带错误、地址、IAM 角色 | 最多 80 个对话，换页面保留 | 调查是另一个产品（CloudWatch investigations）的独立页面 |
| n8n | 节点报错上「Ask AI Assistant」、画布上的 AI 按钮 | **从编辑器侧栏迁到了独立的全页 `/assistant`**；编辑器里的按钮交接过去 | 当前工作流和这次执行作为附件带过去 | 服务端，有历史页 | 在助手页的对话里，有后台任务面板 |
| Databricks Genie Code | 右上角图标；单元格里 `Cmd+I`；报错上「Diagnose Error」 | 面板（多个对话是标签页，切走后在后台继续跑）；Maximize 转全页 | 正在写的代码、表的元数据、`@` | 换页面保持，有历史 | 全页左栏同时列对话和定时任务 |
| Azure Copilot | 页头图标 | 侧面板，可全屏 | 用「Add」选资源 | 有列表；同一对话 24 小时后不能续 | 查不到 |
| Cloudflare Agent Lee | 右上角「Ask AI」 | 聊天面板，布局查不到 | 读账户数据，不读当前页 | 存一年 | 在对话里逐条批准 |
| Postman | 右侧栏的 AI 标签；「Debug with AI」 | 右侧栏 | 当前标签页 | 有 | 云端长任务进「Home > Agent Tasks」，可「Watch Live」 |
| Google Cloud Gemini Cloud Assist（低置信：文档打不开，只有搜索摘录） | 工具栏按钮 | 面板 | 查不到 | 查不到 | 聊天里出「Create investigation」，转到独立详情页 |
| Notion（通用 SaaS，对照） | 右下角悬浮按钮 | 侧栏和悬浮窗可切换 | 当前页面、选中的块 | 有 | — |

规律：

1. **全局入口是「右上角图标（常配 `Cmd/Ctrl+I`）→ 右侧面板」，换页面当前对话不丢。** GitLab、GitHub、Grafana、Supabase、Datadog、AWS、Databricks、Azure、Cloudflare、Postman。**右下角的悬浮按钮只在通用 SaaS（Notion）里看到**；这次看的开发平台和云控制台里，查得到布局的都是右侧面板。
2. **面板能一键升成全页，搬过去的是同一个对话。** 官方写明了分工：Databricks 是已有对象上随手问用面板，「starting work from scratch or running multiple tasks in parallel」用全页；Grafana 的 Workspace「designed for longer conversations and side-by-side analysis」。GitHub、Supabase、AWS、Azure、Datadog 也有全页或全屏。反例：GitLab 只有侧栏；**n8n 反方向**，全页是主体，编辑器里只留交接按钮（但在「边改边试」的地方又把预览聊天停靠回编辑器旁，原话「without losing your place」）。
3. **对象上的「问 AI」按钮 = 新开一个对话，自动带上这个对象，常常连提示语也预填。** Supabase、Databricks、n8n、Grafana、Datadog、Postman。GitLab、GitHub、Datadog、AWS 还分两档：「解释、排查」在面板里聊，「修复、去干活」起一个代理会话、进任务列表。
4. **上下文默认是当前页面或对象，并且给人看见；要更多时用 `@` 或「Add」补。** 反例：Cloudflare 不读当前页。
5. **历史多存在服务端；面板里是弹层或标签页，全页里是常驻的左栏。** 反例：Supabase 存在浏览器本地。
6. **只要助手能长时间自己干活，长任务就有面板之外的「会话列表加详情页」，面板只负责发起、显示进度、给链接。** GitLab、GitHub、Grafana、Databricks、Datadog、Postman；AWS 和 Google 把调查做成另一个产品的独立页面。需要人决定时多家主动通知（GitLab 发待办和邮件，Grafana 发 Slack，n8n 发浏览器通知）。

推开还是盖住：只有 Supabase（源码：超宽屏推开、中等屏盖住）和 Notion 有一手依据，其余查不到。

### 2.3 放到一起看

- 维护者印象里的「悬浮窗」，在开发平台和云控制台里实际是**右上角图标打开的右侧面板**，用来「围绕眼前这个对象随手问」；右下角悬浮按钮只在通用 SaaS 里见到。
- 只要助手要长时间自己干活，**每一家都另有会话列表和全页详情**，面板只发起、看进度、跳转（两路调研的规律各自独立得出这一条）。sfly 的助手一轮十几分钟、写代码、触发运行，属于这一类：现在的会话列表和会话页就是这个「全页」，不该去掉。
- 缺的是另一半：**对象页上的入口**（失败的流水线、报错、告警上「排查这次」「修这个」）和**跨页面的侧栏**。GitHub、GitLab、Grafana、Supabase、Databricks 两样都有；n8n 只有前一样（按钮交接到全页）。
- 和 sfly 最像的编排类产品 n8n 走的是「全页为主、编辑器里放交接按钮」；云控制台和可观测平台走的是「侧栏随手用、全页看长的」。两条路都**保留全页**。

## 3. shadcn 生态里的 AI 对话、助手组件

### 3.1 有哪些、和本仓库搭不搭

和预期不同的一条：**shadcn/ui 官方今年出了自己的聊天和代理界面组件，Base UI 版齐全。** 2026-06 加了 Message Scroller、Message、Bubble、Marker、Attachment（滚动逻辑在零依赖的新包 `@shadcn/react`）；2026-10-14 加了 Trace（代理做的每一步一行，有 running、error、pending）和 Code Block（代码、终端输出、日志、差异），以及 shadcn 自己的「AI Elements」：21 个模式，复制进仓库用、不装包，原文「AI Elements replaces AI SDK Elements, and we are going to deprecate AI SDK Elements」「Trace and Code Block are available for Base UI, React Aria and Radix across all eight styles」（[更新日志](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/changelog/2026-10-ai-elements.mdx)、[聊天组件](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/changelog/2026-06-chat-components.mdx)）。

本仓库的约束：shadcn 的 `base-nova` 风格、Base UI 原语、组件代码归仓库维护（ADR 0008）；内网可能完全离线，运行时不能去 CDN 取任何东西；会话事件是平台自己的类型，页面不认任何模型 SDK 的消息格式；#762 定下的不可信文字规矩（不渲染原始 HTML 和图片、链接只认 http(s) 并写出主机名、文字节点都经不可信文字组件、深嵌套和括号过多退回纯文字、逐字出现时节流解析）。

| 库 | 提供的部件 | 容器（侧栏、悬浮、全页） | Radix 还是 Base UI | 主要依赖 | 离线 | 消息格式 | 不可信文字规矩 | 结论 |
|---|---|---|---|---|---|---|---|---|
| shadcn/ui 官方（Message Scroller、Message、Bubble、Marker、Trace、Code Block、AI Elements 模式） | 消息行、用户的话的外框、步骤行（可展开、可嵌套）、代码和差异、滚动跟随、分隔 | 只有全页的滚动区；侧栏、悬浮用通用的 Sheet、Popover 自己组 | **Base UI 版齐全**（逐个取了 `base-nova` 注册表的 JSON 看 import，没有 Radix） | `@shadcn/react`（零依赖）、`cn`、`shiki`（高亮，可选） | 能（shiki 本地懒加载） | **不绑**（原文 Trace「does not read tool parts」） | 组件只渲染传进去的东西，能套 `UntrustedText`；Markdown 官方推荐 Streamdown（见下一行） | 以后借个别部件 |
| Vercel AI Elements（将被上一行取代） | 最全：消息、工具、推理、任务、终端、输入框…… | 全页 | 按 Radix 写（`asChild`、`data-[state]`），在 base-nova 项目里装上就类型错、行为错（官方仓库 issue [#383](https://github.com/vercel/ai-elements/issues/383)、[#498](https://github.com/vercel/ai-elements/issues/498)，Base UI 版 PR [#450](https://github.com/vercel/ai-elements/pull/450) 没合） | `ai`（类型）、`streamdown` 加 shiki、katex、mermaid 插件、`use-stick-to-bottom`、`motion` | 能 | 绑 AI SDK 的 `UIMessage`、`ToolUIPart` | Streamdown 默认渲染 HTML（经 sanitize）、默认渲染任意地址的图片、链接全放行；深嵌套查不到防护 | 不用 |
| assistant-ui | 全套对话：Thread、工具卡、推理、输入框 | **悬浮（AssistantModal）、侧栏（AssistantSidebar）、全页都有** | 注册表组件有 base-nova 版，但 npm 包 `@assistant-ui/react` 运行时依赖 `radix-ui`（Slot、Popover、DropdownMenu） | 自家 core、store，`zustand`、`zod`、`react-markdown` | 能（不配它的云服务时，推断） | 绑它自己的消息格式：只有用户、助手、系统三种角色；插话是浏览器里先存、这一轮结束才送 | HTML 当文字：能；图片默认任意来源加载、链接：要改；深嵌套查不到防护 | 不用包；侧栏、悬浮容器的写法可参考 |
| prompt-kit | 消息、Markdown、输入框、工具、步骤 | 全页 | 按 Radix 写（`new-york` 风格），在 base-nova 下同 AI Elements 的问题 | react-markdown、marked、shiki、use-stick-to-bottom | 能 | 不绑 | 默认渲染图片；代码块用 `dangerouslySetInnerHTML`；深嵌套无防护 | 不用；「切块后每块缓存」的做法可参考 |
| 其它 | Kibo UI 的 AI 组件 2025-08 已删除、并入 AI Elements；simple-ai 是 Base UI 但绑 AI SDK 和 Streamdown；shadcn-chat 作者声明停更；CopilotKit（不是 shadcn，有侧栏和悬浮）绑它自己的服务和协议，按 Radix 写，安装时有统计上报 | | | | | | | 不用 |

### 3.2 换过去得到什么、丢掉什么

得到的：和 shadcn 生态一致的消息行、步骤行、分隔、代码块外观；代码块、命令输出、差异的语法高亮（shiki 进包）；Message Scroller 更全的滚动行为（新一轮锚到视口上方、打开旧会话停在最后一个锚点、选中文字或用键盘也算「人在动」、往前加载不跳、离屏的行少渲染）；Streamdown、prompt-kit 那种「切块后每块缓存」的逐字解析，比我们整条重解析省；现成的悬浮和侧栏容器（只有 assistant-ui 有）。

丢掉的或要重做的：

- **平台记录**：所有库都只有用户、助手（、系统）几种角色，装不下「平台确认做过的事」这一类，而这是 #550 定稿时最在意的一点（#442 第 6 条：助手说的不作数）。
- **插话、排在这一轮后面、已撤掉和送达的状态**：只有 assistant-ui 有排队，而且是浏览器里先存着、这一轮结束才送，和我们「控制面说了算，刷新、换标签页、换人看到的都一样」正好相反。
- **工具调用的「已中止」「并行」、实时输出停在底部、上翻不拽**：要补状态、重新核对。
- **不可信文字规矩**：没有一家默认满足；换渲染器等于把 #762 的规矩和 `AssistantMarkdown.test.ts`、`AssistantMarkdown.structure.test.ts` 两份测试搬过去重做，深嵌套的三道检查也要原样搬。
- **长会话的性能数字**要重新量。
- **滚动跟随的做法冲突**：Message Scroller 用 `ResizeObserver` 跟内容变高，我们是刻意不用它（人在底部时展开一个靠上的行会被拉到底，`docs/ARCHITECTURE.md` §7.2「会话页」）；它默认把内容区设成 `role="log"`、新增的行都读出来，我们只在一轮结束、排到了、插话没送到、会话被结束时播报一句。
- **输入框的几种状态**（插话、排队中、有话排在后面、正在结束）都没有。

### 3.3 判断

会话页**不整套换**，形态的决定和组件库的决定是两件事、互不依赖。以后可以借的（复制进仓库、用 base-nova 版）：Code Block 和它的高亮钩子（shiki 切出的每段文字还要再套一次 `UntrustedText`）、Trace 和 Marker 当步骤行和分隔的样式骨架（自己补「已中止」「并行」）、Message Scroller 拿来和 `use-timeline-scroll.ts` 比一比（先验证上面两点冲突）。Markdown 继续用 `AssistantMarkdown`，不换 Streamdown：它的默认值和我们的规矩正好相反。做侧栏不需要新库：仓库已有 Base UI 的 Sheet、Popover。

没核实的：各库打包后的实际体积（只看了 npm 的解包大小和依赖列表）；Message Scroller 在深嵌套、超长内容和「展开靠上的行」时的表现；`@assistant-ui/react` 只用 base-nova 组件时 Radix 的 Popover、DropdownMenu 能不能被摇掉；shadcn 的 chatbot 模板没细看。

## 4. 对 sfly 的三个方案

三个方案都**不动后端**：会话接口、事件、助手服务、控制面一行不改（§1 第 1 条）。差别全在前端。

### 方案一：维持独立页面，就地入口跳到会话页

就是现在的样子，加三样便宜的：

- 导航「助手」后面写「N 在做」「N 在排队」（照 Agent 在线数的做法），离开会话页也知道有没有在做。
- #442 第 8 条的两个就地入口做成**跳转**：运行监控上失败的运行「让助手排查这次失败」、场景页和画布上「让助手改这个场景」，跳到助手页、输入框里预填一句带运行号或场景名的话，人确认后点「开始」。这是 n8n 现在的做法（§2.2：编辑器里的按钮交接到助手的全页、带上当前工作流和失败的执行）。
- 运行页、版本历史上的「经 会话」照旧链到会话页。

- **适合**：人主要坐在会话页前，一轮一轮地看助手干活；从别的页面发起时，换一次页面可以接受。
- **和 #442 冲突吗**：不冲突，就地入口也有了。
- **改什么、多大**：外壳的导航计数一处；三个入口按钮；助手页的输入框接受一句预填的话（从地址参数读）；几条 e2e。两三百行，一个 PR。
- **对 #551、#553**：没有影响。
- **缺点**：从失败的运行到助手要换页面，正在看的日志和图表离开视野，看完助手的结论要再跳回来；同类产品里，云控制台和可观测平台在这个场景上多用侧栏（§2.2 规律 1、3）。

### 方案二（推荐）：独立页面加就地侧栏

方案一的全部，再加一种外框：同一个会话可以在页面右侧的侧栏里打开（推开内容，不盖住），内容是会话页的窄版（时间线、输入框，成果收在一个页签里），顶上「在会话页打开」交接到全页。入口：

- 运行监控上，失败或取消的运行多一个「让助手排查这次失败」：在侧栏里新建会话，输入框里预填一句带运行号的话，人看过、改过再点「开始」（不一点就发：这句话会记成这个人说的，而且一发出就占这个项目的一轮）。
- 场景页、编排画布上「让助手改这个场景」，同样预填。
- 运行、版本历史上的「经 会话」点开是侧栏，不再离开当前页面；要看全过程从侧栏交接到会话页。
- 可选的全局入口：顶栏一个图标加快捷键，在任何页面打开侧栏，里面是最近的会话和「要做什么？」（§2.2 规律 1 的做法）。要想清楚的一点：每一句话都是一轮，可能排在别人的一轮后面（§1 第 6 条），所以侧栏里同样要写排第几、在等谁。
- 侧栏打开时才连会话的事件流，收起就断开；没打开时靠方案一的导航计数知道有没有在做。

**适合**：人在运行监控、画布上干活，顺手让助手查一次失败、改一个场景，回头在原地看结果；长的、要盯十几分钟的一轮仍去会话页。这就是 GitHub（浮层面板、全屏页、issue 上的侧栏）、Grafana（侧栏和全页 Workspace 之间搬同一个对话）、GitLab（失败流水线上的按钮、侧栏、Sessions 页）、Supabase 和 Databricks（报错上的按钮打开侧栏、新开对话，面板可以升成全页）的做法。方案一的三样都是它的子集：先做方案一，再加侧栏，不浪费。

**和 #442 冲突吗**：不冲突，就是 #442 第 8 条里那两个还没做的就地入口，加上「会话可以在侧栏里打开」这一种外框。

**改什么**（全是前端）：

- 把会话页里的头部、输入框、停止和结束这几块从 `apps/web/src/sessions/SessionPage.tsx`（520 行）拆出来，页面和侧栏两种外框共用；时间线（`SessionTimeline`、`use-session-timeline.ts`）、成果栏、#770 的窄窗口布局和运行卡片原样用。
- 一个侧栏容器（仓库已有 Base UI 的 Sheet；要做成推开内容的停靠式而不是遮罩），挂在外壳**和**两个全屏页（运行监控、编排画布）上；打开哪个会话记在页面之外的状态里，换页面不丢。
- 入口：运行监控的顶栏（`apps/web/src/monitor/MonitorTopBar.tsx`）、场景页和画布各一个按钮；「经 会话」（`apps/web/src/components/via-tag.tsx`）改成打开侧栏。
- 窄宽度下逐个看一遍工具行、差异、提交、平台记录的折行（原型里 400px 宽时长命令已经截断）。
- e2e：从失败的运行发起、侧栏和会话页之间交接、侧栏收起后事件流断开；视觉基线两三张。文档：`docs/ARCHITECTURE.md` §7.2、`docs/DESIGN-SYSTEM.md` 加侧栏的宽度和推开规则。

**多大**：一张规格 issue、一两个 PR，前端约一千行上下（含测试，包括方案一那几样）。不用新依赖。

**对 #551、#553**：#770 照常合入，它的窄窗口布局和运行卡片正好是侧栏要的；#553 的验收照常做（它本来就写明不做从运行页、场景页发起会话），侧栏在验收之后或并行做都行。唯一要留意的是先合 #770 再动 `SessionPage.tsx`，免得和 A3 冲突。

**缺点**：多一种外框要维护（同一份时间线在两种宽度下都要像样）；侧栏推开运行监控之后，1280 宽时运行监控只剩约 860px。

### 方案三：全部改成侧栏或悬浮窗

去掉导航「助手」、助手页和会话页，所有页面右下角一个悬浮按钮，点开是悬浮窗（或停靠的侧栏），会话列表、时间线、成果都在里面。

- **适合**：助手是「随手问一句、就地帮一下」的辅助功能，一次几十秒、不需要盯。
- **和 #442 冲突吗**：**冲突**。第 8 条把助手定为平台的主要用法、项目首页是会话列表；#553 第 5 步「验收通过后首页换成会话列表」没有了着落。
- **和后端的语义也对不上**：同一个项目同一时刻只跑一轮（§1 第 6 条），悬浮窗里随手问的一句会排在别人十几分钟的一轮后面，还要占工作台、留一次提交。要真正的「随手问答」，得另做一条不排队、不碰工作台的只读通道，那是后端的新设计，不在这次的范围里。
- **改什么、多大**：删 `/sessions`、`/sessions/:id` 两个路由和导航项；把列表、时间线、成果、输入框全部塞进约 400×620 的窗口；所有「经 会话」的链接换成打开悬浮窗；`assistant.spec.ts`、`assistant-live.spec.ts`、`session-timeline.spec.ts`、`session-results.spec.ts` 和会话的七八张视觉基线重写；文档同步。改动远比方案二大，而且 #550、#551 定稿的宽版时间线和成果栏大半作废。
- **对 #551、#553**：#770 的成果栏和会话列表要重做；#553 要等新界面做完才能验收，首页的决定要改。
- **缺点**：十几分钟的一轮、几百个工具行和差异挤在 400px 宽里；悬浮窗盖住页面内容（原型里盖住了运行监控的日志尾部和图表）；同类产品里没有长任务这样放的（§2.1 规律 1）。

### 对比

| | 方案一 独立页面，就地入口跳过去 | 方案二 独立页面加就地侧栏 | 方案三 只有侧栏或悬浮窗 |
|---|---|---|---|
| 长任务（十几分钟、几百个工具行） | 会话页，宽 | 会话页，宽；侧栏看个大概 | 挤在 400px 里 |
| 从失败的运行、场景发起 | 跳到助手页，预填一句 | 原地打开侧栏，不离开日志和图表 | 原地 |
| 离开后看进度 | 导航计数、会话列表 | 同左，加侧栏 | 悬浮按钮上的状态 |
| 和 #442 第 8 条 | 一致 | 一致 | 冲突（首页是会话列表） |
| 后端 | 不动 | 不动 | 不动（要真随手问答得另做） |
| 前端改动 | 两三百行，一个 PR | 约一千行，一两个 PR（含方案一） | 重写会话的前端和测试 |
| 对 #551（#770） | 无 | 无，复用它的窄布局和运行卡片 | 成果栏、列表要重做 |
| 对 #553 | 无 | 无 | 要等新界面，首页的决定要改 |
| 同类产品 | n8n；Codex、Jules、Claude Code 网页版（没有对象页） | GitHub、Grafana、GitLab、Supabase、Databricks | 长任务里没有；开发平台的随手问答也是右侧面板加全页，右下角悬浮按钮只在 Notion 见到 |

## 5. 推荐

**方案二**，分两步：

1. 现在不停 A3：#770 照常合入，#553 照常验收（它验的是「一句话之后的十分钟」，在哪种外框里看都一样）。
2. #553 通过之后，开一张规格 issue：先做方案一的三样（导航计数、就地入口、预填），再做侧栏（宽度和推开规则、和会话页之间的交接、事件流只在打开时连、要不要全局入口）。只想先做小的，停在方案一也是完整的。

理由：

- **证据**：长任务这一类，12 个产品里 10 个以独立页面或全页为主，有面板或侧栏的都只让它做发起、看状态、跳转（§2.1 规律 1、2）；随手问答这一类，开发平台和云控制台几乎都是右侧面板，只要能长时间干活就另有会话列表和全页（§2.2 规律 1、6）。两路调研各自得出「面板发起和看进度、全页看全过程」。sfly 的助手一轮十几分钟、要盯工具调用和成果，主界面应当是全页；维护者说的侧栏、悬浮窗，正好补在对象页的入口和跨页面看进度上。
- **定位**：#442 第 8 条本来就同时要了会话页和就地入口，方案二是把它做全，不是推翻。
- **代价**：不动后端，不停 A3，不作废 #550、#551 的定稿；侧栏复用 #770 的窄布局。
- **可以回头**：先做侧栏，用一段时间后真的发现大家只在侧栏里用，再把会话页降级也不晚；反过来，先砍掉会话页再加回来要贵得多。

## 6. 要维护者定的

1. 三个方案选哪个（我推荐方案二）。
2. 选方案二的话：侧栏推开内容还是盖在上面（我建议推开：运行监控的日志和图表要一直看得见；1280 宽时运行监控剩约 860px）；从运行页发起时第一句话是预填让人确认，还是一点就发（我建议预填确认）。
3. 首页换成会话列表（#553 第 5 步）维持不变吗。
4. shadcn 官方的新组件（Trace、Code Block、Message Scroller）要不要另开一张任务评估借用；我的建议是放在侧栏之后，不和形态的决定绑在一起。
5. 真人设计评审：#550 的设计评审是模型做的。选定方案后，建议维护者或另一位真人用 `docs/prototype/assistant-forms.html` 和 #553 验收时的截图看一次。

需要改 ADR 的地方写成建议，不在这里改：ADR 0027「页面」一节加一句「会话也可以在页面右侧的侧栏里打开，入口在运行监控、场景页和『经 会话』；看全过程交接到会话页」；#442 第 8 条不用改正文，在 issue 里记一条「形态的调研见本文」即可（由维护者决定）。

## 附：来源

长任务、自己干活的助手（§2.1）：

- GitHub：[agents panel 发布（lightweight overlay、View all tasks）](https://github.blog/news-insights/product-news/agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github/)、[仓库 Agents 标签](https://github.blog/changelog/2026-01-26-introducing-the-agents-tab-in-your-repository/)、[issue 和 Projects 上的会话侧栏](https://github.blog/changelog/2026-04-23-view-and-manage-agent-sessions-from-issues-and-projects/)、[mission control](https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/)、[在 github.com 上用编码代理](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)、[管理和跟踪](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)、[GA](https://github.blog/changelog/2025-09-25-copilot-coding-agent-is-now-generally-available/)
- OpenAI Codex：[发布](https://openai.com/index/introducing-codex/)、[升级](https://openai.com/index/introducing-upgrades-to-codex/)、[GA](https://openai.com/index/codex-now-generally-available/)、[产品页](https://openai.com/codex/)（developers.openai.com 和 help.openai.com 的现行文档打不开，任务详情页的布局和通知方式查不到）
- Jules：[文档](https://jules.google/docs/)、[任务和仓库](https://jules.google/docs/tasks-repos/)、[运行任务](https://jules.google/docs/running-tasks/)、[看代码](https://jules.google/docs/code/)、[审计划](https://jules.google/docs/review-plan/)、[更新日志](https://jules.google/docs/changelog/)
- Claude Code 网页版：[快速上手](https://code.claude.com/docs/en/web-quickstart)、[网页版](https://code.claude.com/docs/en/claude-code-on-the-web)
- Devin：[更新日志](https://docs.devin.ai/release-notes/overview)、[会话工具](https://docs.devin.ai/work-with-devin/devin-session-tools)
- Cursor：[云端代理](https://cursor.com/docs/cloud-agent)、[Agents Window](https://cursor.com/docs/agent/agents-window)、[手机](https://cursor.com/docs/cloud-agent/mobile)
- Datadog：[调查](https://docs.datadoghq.com/bits_ai/bits_ai_sre/investigate_issues/)、[配置和回写](https://docs.datadoghq.com/bits_ai/bits_investigation/configure.md)、[博客](https://www.datadoghq.com/blog/bits-ai-sre/)
- Grafana：[Investigation](https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/platform/investigation/)、[Workspace](https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/platform/workspace/)、[GA](https://grafana.com/whats-new/2026-07-29-assistant-investigations-is-now-generally-available-in-grafana-cloud/)、[IRM 里的调查](https://grafana.com/whats-new/2026-10-15-investigate-alerts-and-incidents-with-grafana-assistant-in-irm/)
- GitLab：[Sessions](https://docs.gitlab.com/user/duo_agent_platform/sessions/)、[Fix pipeline](https://docs.gitlab.com/ci/pipelines/fix_pipeline/)、[Developer Flow](https://docs.gitlab.com/user/project/merge_requests/developer/)、[Flows](https://docs.gitlab.com/user/duo_agent_platform/flows/)
- Sentry：[Autofix](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/)、[Issues Inbox](https://docs.sentry.io/product/issues/inbox/)、[GA](https://blog.sentry.io/seer-sentrys-ai-debugger-is-generally-available/)
- n8n：[AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder)、[n8n Assistant](https://docs.n8n.io/build/ways-of-building-workflows/n8n-assistant)、[发布说明](https://docs.n8n.io/changelog/release-notes)、[博客](https://blog.n8n.io/introducing-n8n-assistant/)
- Replit：[并行构建](https://docs.replit.com/learn/build-in-parallel)、[任务看板](https://docs.replit.com/features/agent/task-board)

随手问答、就地帮忙的助手（§2.2）：

- GitLab：[Agentic Chat](https://docs.gitlab.com/user/gitlab_duo_chat/agentic_chat/)、[排查失败的作业](https://docs.gitlab.com/user/gitlab_duo_chat/examples/#troubleshoot-failed-cicd-jobs-with-root-cause-analysis)、[Sessions](https://docs.gitlab.com/user/duo_agent_platform/sessions/)
- GitHub：[在 github.com 上问 Copilot](https://docs.github.com/en/copilot/using-github-copilot/copilot-chat/asking-github-copilot-questions-in-github)、[就地提问](https://github.blog/changelog/2026-05-18-ask-questions-in-context-with-copilot-on-web/)、[失败的 Actions 一键修](https://github.blog/changelog/2026-05-18-one-click-fixes-for-failing-actions-with-copilot-cloud-agent/)、[问失败的作业](https://github.blog/changelog/2025-01-15-copilot-users-can-ask-about-a-failed-actions-job-ga/)
- Grafana：[上手](https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/get-started/grafana-cloud/)、[Workspace](https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/platform/workspace/)、[弹出窗口](https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/platform/pop-out/)、[SDK `openAssistant`](https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/reference/typescript-sdk/)
- Supabase：[AI Assistant v2](https://supabase.com/blog/supabase-ai-assistant-v2)、[侧栏布局源码](https://github.com/supabase/supabase/blob/master/apps/studio/components/layouts/ProjectLayout/LayoutSidebar/index.tsx)、[「Debug with Assistant」源码](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/SQLEditor/useSqlEditorAi.ts)、[面板头部（最大化、Open in Explorer）源码](https://github.com/supabase/supabase/blob/master/apps/studio/components/ui/AIAssistantPanel/AIAssistantHeader.tsx)
- Datadog：[Bits Chat](https://docs.datadoghq.com/bits_ai/bits_chat/usage/)、[博客](https://www.datadoghq.com/blog/introducing-bits-chat/)、[Database Investigator](https://docs.datadoghq.com/database_monitoring/database_investigator/)
- AWS：[控制台助手](https://docs.aws.amazon.com/assistant/latest/userguide/what-is.html)、[使用](https://docs.aws.amazon.com/assistant/latest/userguide/using-assistant.html)、[Diagnose](https://docs.aws.amazon.com/assistant/latest/userguide/diagnose-errors.html)、[CloudWatch investigations](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Investigations-Ephemeral.html)
- n8n：[发布说明（2.28 交接、2.36 停靠预览）](https://docs.n8n.io/changelog/release-notes/)、[助手的路由源码](https://github.com/n8n-io/n8n/blob/master/packages/frontend/editor-ui/src/features/ai/instanceAi/module.descriptor.ts)、[旧版助手的博客](https://blog.n8n.io/iterations-hallucinations-and-lessons-learned-rebuilding-our-ai-assistant-on-n8n/)
- Databricks：[Genie Code 的界面](https://docs.databricks.com/aws/en/genie-code/navigate-genie-code)、[笔记本里的代码帮助](https://docs.databricks.com/aws/en/notebooks/code-assistant)、[2026-08 全页 GA](https://docs.databricks.com/aws/en/release-notes/product/2026/august)
- Azure：[Copilot 能力](https://learn.microsoft.com/en-us/azure/copilot/capabilities)
- Cloudflare：[Agent Lee](https://developers.cloudflare.com/agent-lee/)、[博客](https://blog.cloudflare.com/introducing-agent-lee)
- Postman：[Agent Mode](https://learning.postman.com/docs/use/agent-mode/overview/)、[云端 Agent Mode](https://learning.postman.com/docs/use/agent-mode-cloud/overview/)
- Google Cloud（只有搜索摘录）：[聊天面板](https://docs.cloud.google.com/cloud-assist/chat-panel)、[调查](https://docs.cloud.google.com/cloud-assist/investigations)
- Notion：[Notion Agent](https://www.notion.com/help/notion-agent)

shadcn 生态（§3）：[shadcn 2026-10 Trace、Code Block、AI Elements](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/changelog/2026-10-ai-elements.mdx)、[2026-06 聊天组件](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/changelog/2026-06-chat-components.mdx)、[2026-07 Base UI 成为默认](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/changelog/2026-07-base-ui-default.mdx)、[Message Scroller](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/components/base/message-scroller.mdx)、[Tool 模式](https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/ai-elements/base/tool.mdx)、[注册表按 style 解析依赖](https://github.com/shadcn-ui/ui/blob/main/packages/registry/src/registry/resolver.ts)；[Vercel AI Elements 源码](https://github.com/vercel/ai-elements/tree/main/packages/elements/src)、[Streamdown 的安全设置](https://github.com/vercel/streamdown/blob/main/apps/website/content/docs/security.mdx)；[assistant-ui 注册表](https://github.com/assistant-ui/assistant-ui/blob/main/apps/registry/src/registry.ts)、[`@assistant-ui/react` 的依赖](https://registry.npmjs.org/@assistant-ui/react/latest)；[prompt-kit 的 components.json](https://github.com/ibelick/prompt-kit/blob/main/components.json)。
