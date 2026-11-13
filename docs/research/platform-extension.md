# 平台怎么扩展：自定义页面、插件，还是开放 API

调研日期：2026-11-13。DeepSeek Harness 的源码结论固定在提交 `e8f7b93`（2026-11-11），文中它的路径都相对于仓库根目录。决策记录见 ADR 0022。

背景：sfly 是通用的测试编排平台，界面以编排画布为中心。在更专注的业务场景里，场景搭好之后很少再改，日常工作是换参数触发、看各环境的运行状况，平台自带的页面不贴合这种用法。问题是：平台应该怎样让用户得到自己的看板和触发页面。

## 1. 摘要与结论

**结论：开放平台现有的 HTTP API，提供一个 TypeScript 的 API 客户端，用户自己写、自己托管页面。不做进程内插件。**

- 业界很少靠「让用户写页面插件」解决这类需求。允许用户的前端代码进入平台页面的做法成本最高，事后后悔的例子也最多（§3）。
- DeepSeek Harness（下称 dsh）是「一切皆插件」做得最彻底的例子，但它的前提是单人本机、没有数据库事务、没有多用户；sfly 计划中的登录、项目隔离和现有的事务模型，在它那里都没有答案。它自己也保留了事实上的特权内核，并且一直在收紧（§4）。
- 开放 API 加客户端，用最小的改动覆盖「看板、按参数触发、看运行状况」。它需要的基础（契约、客户端、跨域）以后做插件也用得上（§5）。
- 出现 §6 列出的三种需求之一时，再重新考虑插件；那时可以从 §7 的设计要点出发。

## 2. 问题与 sfly 现状

调研时（0.3.0）的事实：

- **没有场景自己的页面**：画布是每个场景唯一的页面，某个场景最近的运行只能到运行记录里按场景筛选。
- **触发表单**：入口参数只有名称、类型（string、number、boolean、json）、默认值、是否必填、是否敏感，没有说明和可选项；没有参数预设，只有「再次运行」会带上一次的参数。
- **指标只能按单次运行查询**，没有跨运行的查询；默认保留 30 天。
- **没有任何界面扩展机制**；控制面没有开跨域，别的来源的页面调不通接口。
- **HTTP 接口已经有唯一的契约**（ADR 0007）：63 个路由全部用 zod 定义，控制台和 `sfly` 命令行都按它工作；控制台的请求层和事件流封装合计不到 300 行。
- **范围外的相关项**：`PRODUCT.md` 明确不做「测试环境」概念、自定义指标面板、Cron / Webhook / 周期触发；ADR 0004 不做登录。

## 3. 业界做法

调研了 Rundeck、Jenkins、GitHub Actions、Prefect 3、Dagster、Airflow 3、Kestra、Windmill、n8n、Backstage、Grafana、Argo CD / Argo Workflows、Home Assistant、Node-RED Dashboard、AWX、Temporal。按从轻到重归成 9 种做法：

| # | 做法 | 代表 | 成本 | 常见问题 |
|---|---|---|---|---|
| 1 | 运行预设：同一个定义保存多套参数 | Prefect（一个流程配多个部署）、AWX 作业模板、n8n 预填链接 | 低 | 预设增多后和参数声明脱节 |
| 2 | 按参数声明生成表单 | Airflow Params、Prefect、GitHub Actions、Backstage Scaffolder | 低–中 | 静态选项过时 |
| 3 | 动态 / 级联选项 | Rundeck 远程选项、Jenkins Active Choices、Kestra | 中 | 超时、循环依赖、脚本注入；Airflow 明确不支持 |
| 4 | 运行自己输出摘要 | GitHub Job Summary、Prefect Artifacts、Dagster 元数据、Temporal | 低 | 只覆盖单次运行 |
| 5 | 声明式看板：固定组件库 | Kestra Dashboards、Jenkins Dashboard View、Grafana、GitHub Deployments | 中 | 组件库不够用 |
| 6 | 平台按定义自动生成页面 | Home Assistant 的 strategy | 中 | — |
| 7 | 低代码搭建器 | Kestra Apps、Windmill、Retool | 高 | Windmill 已把低代码编辑器标为 legacy |
| 8 | 前端代码插件，嵌进平台页面 | Airflow `react_apps`（实验性）、Argo CD 扩展、Grafana 插件、Backstage、Rundeck UI 插件 | 最高 | 见下 |
| 9 | iframe 或外部工具调 API | Airflow `external_views`、Argo Links、Retool | 中–高 | 自己处理鉴权，界面重复建设 |

各家文档里能看到的教训，集中在第 8 档：

- **平台前端换框架，插件全部失效**：Grafana 在 v12 移除 Angular 插件；Node-RED Dashboard 1（AngularJS）2024 年停止维护；Jenkins Blue Ocean 不再更新；Airflow 3 把 Flask / FAB 视图标为被取代；Backstage 的字段扩展要迁到新的前端系统。
- **浏览器里隔离不了第三方代码**：Grafana 的前端沙箱已弃用，计划在 13.4 移除；Airflow 文档写明不为插件的 FastAPI 应用做鉴权。
- **表单里的自定义 HTML 和脚本被收回**：Airflow 3.0 出于安全移除了 `custom_html_form` 和 `description_html`；n8n 的自定义 HTML 字段禁止 `<script>`。
- **插件和宿主的 DOM 耦合**：Jenkins Active Choices 依赖 Jenkins 界面的 DOM，REST、定时和 Pipeline 触发的构建里不完全可用。

另一个可参照的做法是 MCP Apps（2026-01-26 的规范）和 Windmill 的沙箱应用：页面放在带 `sandbox` 的 iframe 里，只通过 postMessage 调用受限接口，页面碰不到宿主的 DOM 和存储。

## 4. DeepSeek Harness 源码调研

dsh 是在本机运行的 AI agent 框架，口号是「Everything is a Plugin」，公开预览，README 写明会有破坏兼容的变更。它的底座是 Cordis 框架。调研分五路读源码，只读不运行。

### 4.1 Cordis 内核

- **规模**：核心约 1800 行代码（`vendor/cordis`），MIT，同一份代码在 Node 和浏览器都能运行。配置加载、YAML 补丁、热更新是另外约 2000 行，核心不依赖它们。
- **有价值的两点**：插件声明依赖哪些服务，依赖齐了才启动、依赖消失就卸载（`vendor/cordis/src/fiber.ts`、`reflect.ts`）；插件注册的事件监听、服务、子插件都是可撤销的副作用，卸载时逆序撤销。
- **成熟度**：上游只发布过候选版本（4.0.0-rc.x）。dsh 把源码拷进仓库自己维护，`vendor/README.md` 记录了二十多处本地修改，包括卸载重入的加固。
- **没有故障隔离**：没有超时、沙箱、重试。同步事件里监听器抛错直接冒泡给发事件的一方；监听器不返回，发事件的一方就一直等。
- **隔离域是结构性的**：`isolate` 隔离的是插件树的子树，不是请求或租户，表达不了「按项目启用」。
- **难调试的地方**：上下文和服务都包在 Proxy 里，每次读取服务都生成新的代理对象，错误堆栈被改写。

### 4.2 服务端的组装

- **组装方式**：profile 是有序的组合包列表，组合包用 YAML 补丁往配置树里插入或覆盖条目；`web` 形态约 200 个顶层条目。同 id 后写者胜，整块配置被替换。
- **HTTP**：没有中心路由契约，每个插件自己注册路径，重复注册直接抛错（`packages/host/webserver`）。
- **浏览器远程调用**：服务方法加装饰器，构建时分析 TypeScript 类型生成描述和编解码（Typert）。合计约 2.1 万行，仍然需要中心维护的花名册和事件白名单。
- **身份**：内建只有 `owner` 一种主体，所有通过认证的浏览器共用一个 owner 连接。没有用户表、角色、项目。
- **存储**：每个域是带 zod 校验的键值表，全量读进内存；没有跨域事务，没有按插件的数据库迁移。
- **触发**：定时是进程内的一个定时器；Webhook 是实验性的，没有去重、重试和持久队列。两者都调用和界面相同的公开命令。
- **一个小功能的触点**：消息反馈（3 个远程方法）要建 2 个包、改约 8 处登记。

### 4.3 前端插件体系

- **规模**：`packages/client` 约 18.7 万行，91 个包带浏览器部分。
- **加载**：插件的浏览器代码打成惰性的 CommonJS 工厂表，由宿主合并成批量脚本注入页面。React、Cordis、UI 基础库等 11 个模块由外壳提供唯一一份，其余依赖各自内联；跨插件的值导入在构建时报错。装载器、启动内核和热更新约 4000 行实现加 5000 行测试，必要部分估计只有约 300 行。
- **插槽**：114 个类型化的插槽。拥有渲染位置的组件声明插槽，其他插件往里注册组件；每个条目各有错误边界。
- **没有路由**：页面注册进一个按键切换的插槽，切换写内存状态，页面没有地址，不能深链。
- **约束靠规则文档**：组件不能拿到框架上下文、不能自己订阅、属性里不传 React 节点等，一部分由类型和构建检查，一部分只靠评审，仓库里有存量违规。
- **版本**：插槽和基础组件没有独立的 API 版本；13 个预发布版本里有 147 篇迁移指南。
- **第三方门槛**：构建预设没有发布，仓库外的 UI 插件要手写装载代码，并且不能导入 dsh 的客户端包。

### 4.4 核心有多开放

- **主循环理论上可替换，实际只有一个实现**：`ctx.agents.setFactory()` 全仓库只有一处非测试调用。
- **真正被大量使用的是固定的决策点**：进入步骤前、请求出错后、工具执行前后等。审批、重试、超时都是挂在这些点上的普通插件。
- **保护不变量的做法**：
  - 决策带类型，由内核校验后自己执行。
  - 只能拒绝的守卫：返回类型里没有「允许」，监听器的顺序无法复活被禁止的操作。
  - 进入决策前冻结请求的身份和参数，插件不能改写。
  - 不靠顺序的检查点：反对者通过发命令表达。
  - 插件的数据视图是对已提交事件的纯函数折叠，由框架驱动。
- **钩子没有超时**：慢的监听器会卡住那一个会话。
- **按会话隔离能力的机制**：文档自己写明「不是沙箱或权限边界」，进程级的表会泄漏。
- **开放的代价**：卸载时同级清理函数并发执行，持久化可能丢掉清理期间的事件，这是一个未修复的最高优先级提案；事务式的热重载做了又撤销。

### 4.5 维护成本与教训

- **四次事故复盘，两次半出在插件架构本身**：
  - 多写一个默认导出，加载器丢掉了依赖声明，178 个测试全绿但产品一启动就崩（`docs/postmortem/0001`）。
  - 配置里的表达式没被求值，文件系统工具被静默禁用（`0002`）。
  - 页面只有经宿主注入才存在，单独启动的开发服务器成了陷阱（`0003`）。
- **工具成本**：49 个校验脚本和 17 个生成脚本，约 2 万行；374 个包；最小的插件 20 个文件；测试代码多于源码。
- **事实上的内核**：启动内核和共享模块集合是封闭的；页面根节点只有外壳能渲染；改主循环必须更新架构文档；会话格式由中心统一管理；启动代码里硬编码了必需组件名单。
- **一直在收紧**：移除跨插件导入、冻结插件入口的导出、否决运行时的事件类型注册、提案把源码热替换缩减为只支持配置热更新。
- **安全模型**：插件是进程内全信任代码，没有权限声明；`SAFETY.md` 的控制只有「审查插件」。
- **值得借鉴的工程纪律**：每个插件必须有经真实加载路径启动的测试和卸载测试；规则写成「规则、判定条件、正反例」；能机械检查的规则接进校验；事故复盘链接到规则；扩展点目录由代码生成；面向 AI 编程助手的 skill 和 `llms.txt`。

### 4.6 小结

dsh 靠两个前提抵消插件架构的代价：单人本机（插件出问题只影响装它的人）和海量生态。sfly 是内网共享的单进程控制面，引擎在一把锁和一个数据库事务里推进运行，派发协议有 TLA+ 模型验证，计划做多用户和项目隔离。dsh 的框架不能搬；能搬的是 §4.4 的决策点设计和 §4.5 的工程纪律。

## 5. 候选方案比较

| | 进程内插件 | 平台托管用户页面 | 开放 API 加客户端，用户自己托管 |
|---|---|---|---|
| 自定义看板、按参数触发的页面 | 能 | 能 | 能 |
| 外部系统触发运行 | 能 | 能，由用户的服务调接口 | 能，由用户的服务调接口 |
| 在平台已有页面里加内容 | 能 | 不能 | 不能 |
| 在控制面执行的节点 | 能 | 不能 | 不能 |
| 审批、资源锁、配额、自动选 Agent | 能 | 不能 | 不能 |
| 核心改动 | 重新组装控制面、改引擎状态机、改前端结构 | 托管、发布命令、导航 | 抽出客户端、开跨域 |
| 对外承诺 | 插件接口、事件、插槽、数据表 | HTTP 契约 | HTTP 契约 |
| 故障影响 | 可能拖垮控制面或所有人的页面 | 只影响页面自己 | 只影响页面自己 |
| 界面一致性 | 可以用共享组件库约束 | 无法强制 | 无法强制 |

进程内插件的几种形态（全盘照搬 dsh、小内核加封闭引擎、只开少量扩展点、进程外插件）都评估过，细节见 §7。

## 6. 决定

采用最右一列，规则见 ADR 0022。出现下面任何一种需求时重新考虑插件：

1. 要在平台已有的页面里加内容，例如在运行详情里显示关联的缺陷。
2. 要在控制面执行的节点，例如创建 Jira 缺陷。
3. 要审批、资源锁、配额这类干预引擎的能力。

这一阶段明确不补的接口缺口：事件推送和对外的 Webhook、跨运行的指标查询、运行列表的时间范围和翻页、运行预设、入口参数的说明和可选项。自建页面和控制台一样，靠轮询加单次运行的事件流刷新。

## 7. 如果以后做插件：留给那时的设计要点

这一节记录讨论中已经推演过、但没有采用的插件方案，供以后参考，不是现行设计。

- **内核**：自己写一个只保留核心概念的小内核，每个模块声明依赖的服务，按依赖启动、逆序逐个关闭；必需模块没起来就拒绝启动。不用 Proxy，不用 YAML 配置树，不做运行时热插拔。
- **引擎保持封闭**，一次开出一套固定的决策点（触发前、派发前、任务失败后、运行结束前）：先冻结任务的身份和入参，在锁和事务之外询问插件，有超时；插件只返回决策，由引擎校验后提交；另设只能拒绝的守卫。
- **事件**：随引擎的事务写进发件箱表，提交后投递，至少送达一次，插件自己保证幂等。
- **插件提供的节点**：场景文档只新增一种通用的插件节点；引擎把它交给插件在事务外执行，结果像 Agent 的任务结果一样回来。派发协议的 TLA+ 模型要跟着扩展。
- **启用分三层**：安装是全局的（代码只有一份）；对共享数据起作用的行为按项目启用；个人层只管显示、个人账号连接和个人通知。启用做成数据，由平台按项目过滤，不靠装卸插件。
- **插件拿不到数据库连接**，只拿到按用户和项目限定的服务、密钥引用和插件自己的存储。
- **前端**：保留现有路由，插件页面挂在一条通配路由下；用 import map 共享唯一一份 React 和 UI 库；少量具名插槽，每个条目各有错误边界；要加载哪些插件由按用户和项目算出的清单决定。
- **先后顺序**：先定用户和项目的模型，插件接口从第一版起就带上它们。
- **验收场景**：Jira 插件的六项需求（按项目配置凭据、控制面节点、订阅运行事件、界面插槽、入站 Webhook、插件自己的数据）基本就是插件接口的最小集合。
- **改造量的参照**：飞书通知这一个功能横跨控制面、前端、契约、场景文档逻辑、Agent 协议和 Python SDK 六层，共 60 多个文件。

## 来源

业界做法（官方文档）：

- Rundeck：<https://docs.rundeck.com/docs/manual/jobs/job-options.html>、<https://docs.rundeck.com/docs/developer/ui-plugins.html>
- Jenkins：<https://plugins.jenkins.io/uno-choice/>、<https://plugins.jenkins.io/dashboard-view/>、<https://plugins.jenkins.io/blueocean/>
- GitHub Actions：<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>
- Prefect 3：<https://docs.prefect.io/v3/concepts/deployments>、<https://docs.prefect.io/v3/advanced/form-building>
- Dagster：<https://dagster.io/docs/guides/operate/webserver>
- Airflow 3：<https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/params.html>、<https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/plugins.html>
- Kestra：<https://kestra.io/docs/workflow-components/inputs>、<https://kestra.io/docs/enterprise/apps>、<https://kestra.io/docs/ui/dashboard>
- Windmill：<https://www.windmill.dev/docs/core_concepts/auto_generated_uis>、<https://www.windmill.dev/docs/apps/app_editor>
- n8n：<https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.formtrigger/>
- Backstage：<https://backstage.io/docs/features/software-templates/writing-templates>、<https://backstage.io/docs/features/software-templates/writing-custom-field-extensions>
- Grafana：<https://grafana.com/developers/scenes>、<https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-frontend-sandbox/>
- Argo CD：<https://argo-cd.readthedocs.io/en/stable/developer-guide/extensions/ui-extensions/>
- Home Assistant：<https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/>、<https://developers.home-assistant.io/docs/frontend/custom-ui/custom-strategy/>
- Node-RED Dashboard：<https://dashboard.flowfuse.com/contributing/widgets/third-party.html>、<https://flows.nodered.org/node/node-red-dashboard>
- AWX：<https://docs.ansible.com/projects/awx/en/24.6.1/userguide/job_templates.html>
- Temporal：<https://docs.temporal.io/develop/python/platform/enriching-ui>
- MCP Apps：<https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>

DeepSeek Harness（<https://github.com/deepseek-ai/deepseek-harness>，提交 `e8f7b93`）：

- 架构与扩展点：`docs/architecture.md`、`docs/capability-seams.md`、`docs/subsystems/`、`docs/api-gateway.md`
- Cordis：`vendor/cordis/src/`、`vendor/README.md`、`docs/cordis-primer.md`
- 前端：`docs/subsystems/web-client.md`、`client-modules.md`、`slots.md`、`docs/defensive-patterns/client-components.md`、`packages/client/`
- 教训：`docs/postmortem/`、`AGENTS.md`、`packages/AGENTS.md`、`SAFETY.md`、`.agents/notes/`

没有从一手来源核实的内容：Rundeck 是否有按环境的总览页；Prefect 和 Dagster 是否有界面插件机制（没有找到）；Kestra 看板数据源的开源范围。
