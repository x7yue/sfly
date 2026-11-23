// 由 HTTP 契约（packages/schema/src/http）生成，不要手改：pnpm gen。

import type { Download, Endpoint, RouteTable, Stream } from "../route.js";
import type {
	ActionChunk,
	ActionPage,
	ActionPageQuery,
	ActionSummaryView,
	AgentView,
	ArtifactView,
	AssistantDeltaEvent,
	CheckedWarningView,
	CommitFile,
	CopiedOrchestrationView,
	CreateSessionBody,
	DashboardView,
	DocumentDiffView,
	EditOperations,
	ErrorClass,
	FeishuBotName,
	FeishuBotScenario,
	FeishuBotView,
	FeishuTestResult,
	FeishuWebhookUrl,
	FocusItemInput,
	ListOrchestrationsQuery,
	LogChunk,
	LogPage,
	LogPageQuery,
	MetricIncrement,
	MetricSeries,
	MetricSeriesQuery,
	NodeName,
	NodeTypeView,
	NoticeKind,
	OrchestrationDocument,
	OrchestrationHeadView,
	OrchestrationSummary,
	OrchestrationVersionView,
	OrchestrationView,
	PackageName,
	PackageSummary,
	PackageVersionView,
	ParamDeclView,
	PlatformMetrics,
	PlatformMetricsQuery,
	PreflightAgent,
	PreflightProblem,
	PresetChanges,
	PresetDescription,
	PresetName,
	PresetParamInput,
	PresetView,
	ProgressEvent,
	RunFocus,
	RunFocusQuery,
	RunListItem,
	RunListQuery,
	RunLogChunk,
	RunLogNodesParam,
	RunLogPage,
	RunLogPageQuery,
	RunLogScopeQuery,
	RunMetricCatalog,
	RunMetricSummary,
	RunNotificationChanges,
	RunReport,
	RunSummary,
	RunView,
	RunningTaskView,
	SavedVersionView,
	SendMessageBody,
	SendMessageResult,
	SessionDetailQuery,
	SessionDetailResponse,
	SessionEventsQuery,
	SessionListResponse,
	SessionTool,
	SessionView,
	SnapshotEvent,
	SteerQueueEvent,
	StoredOrchestrationDocument,
	ThinkingEvent,
	Timestamp,
	TokenUsage,
	ToolOutputEvent,
	TurnLimit,
	TurnOutcome,
	TurnQueuedEvent,
	VersionCheckView,
	VersionSummaryView,
} from "./types.js";

export interface Api {
	actions: {
		/**
		 * `GET /tasks/:id/actions/summary`
		 *
		 * 一个任务（一次尝试）的动作摘要；没有记录过动作的任务返回各项为空的摘要，任务不存在时 404。
		 */
		summary: Endpoint<
			{
				params: {
					id: string;
				};
			},
			ActionSummaryView
		>;
		/**
		 * `GET /tasks/:id/actions`
		 *
		 * 一个任务（一次尝试）的明细，按开始时间从新到旧分页，可以按名称、只看失败筛选；返回落在这一页范围里的只计数的段。
		 * 任务不存在时 404，游标不是之前返回的 `before` 时 400。
		 */
		page: Endpoint<
			{
				params: {
					id: string;
				};
				query?: ActionPageQuery;
			},
			ActionPage
		>;
		/**
		 * `GET /tasks/:id/actions/events`
		 *
		 * 摘要和明细的实时推送（SSE）。`after` 用分页返回的 `rev`；断线重连时按 `Last-Event-ID` 请求头接上
		 * （与 `after` 取较大者，API 客户端的订阅自动带上），不重复也不遗漏。
		 *
		 * - `summary`：连上时先发一份，之后每存下一份新的摘要发一份；任务结束时再发一份（正在做的动作为空）。
		 * - `actions`：`after` 之后写入或结束的明细，之后每写入一批推送一批；任务结束时推送记为未结束的那些。
		 *
		 * 事件 ID 是推送到的修订号。运行已过保留期时只发摘要。任务不存在时 404。
		 */
		events: Stream<
			{
				params: {
					id: string;
				};
				query?: {
					/** 已经读到的修订号（明细分页响应里的 `rev`）：只推送它之后的写入。 */
					after?: number;
				};
			},
			{
				summary: ActionSummaryView;
				actions: ActionChunk;
			}
		>;
	};
	agents: {
		/**
		 * `GET /agents`
		 *
		 * 全部注册过的 Agent，按名称排序。
		 */
		list: Endpoint<
			{},
			{
				agents: AgentView[];
				/** 控制面版本，也就是 Agent 的目标版本。 */
				control_plane_version: string;
			}
		>;
		/**
		 * `POST /agents/:name/update-now`
		 *
		 * 立即更新（ADR 0014）：让正在更新（下载中或等待任务结束）的在线 Agent 不再等手上的任务跑完。这些任务立即以 agent_lost 失败、按重试配置重新排队
		 * （Agent 更新后重新连上再派发），Agent 按取消流程终止它们后立即替换自己。返回被终止的任务。
		 * Agent 不存在 404 `not_found`；不在线 409 `agent_offline`；版本一致 409 `version_matches`；
		 * 上报了需要手动升级 409 `manual_upgrade_required`（它不会自更新，终止任务没有意义）；
		 * 不在更新流程中（更新失败、正在替换、没有上报更新状态的旧 Agent）409 `not_updating`。
		 */
		updateNow: Endpoint<
			{
				params: {
					/** Agent 名称。 */
					name: string;
				};
			},
			{
				/** 被终止的任务：它们以 agent_lost 失败，按重试配置重新排队。 */
				terminated_tasks: RunningTaskView[];
			}
		>;
	};
	artifacts: {
		/**
		 * `GET /tasks/:id/artifacts`
		 *
		 * 一个任务的产物；运行已超过保留期被清理时 expired 为 true、列表为空。
		 */
		list: Endpoint<
			{
				params: {
					id: string;
				};
			},
			{
				task_id: string;
				artifacts: ArtifactView[];
				/** 已过保留期：数据已被清理。 */
				expired: boolean;
			}
		>;
		/**
		 * `GET /tasks/:id/artifacts/*`
		 *
		 * 下载一个产物（attachment）；运行已过保留期被清理时 410 `expired`。
		 */
		download: Download<
			{
				params: {
					/** 任务 id。 */
					id: string;
					/** 产物的名称（上传时的路径，可以带 `/` 分隔的目录）。 */
					"*": string;
				};
			}
		>;
	};
	dashboard: {
		/**
		 * `GET /dashboard`
		 *
		 * 控制台统计（最近 24 小时）。
		 */
		get: Endpoint<
			{},
			DashboardView
		>;
	};
	feishuBots: {
		/**
		 * `GET /feishu-bots`
		 *
		 * 全部飞书机器人，按名称排序。
		 */
		list: Endpoint<
			{},
			{
				bots: FeishuBotView[];
			}
		>;
		/**
		 * `POST /feishu-bots`
		 *
		 * 登记一个飞书机器人（201，需要昵称请求头）。名称已被占用 409 `name_taken`。
		 */
		create: Endpoint<
			{
				body: {
					/** 机器人名称：全局唯一，创建后不能改。 */
					name: FeishuBotName;
					/** 飞书自定义机器人的 Webhook 地址（相当于一个凭据，响应里是打码的）。 */
					webhook_url: FeishuWebhookUrl;
				};
			},
			FeishuBotView
		>;
		/**
		 * `PATCH /feishu-bots/:name`
		 *
		 * 替换 Webhook 地址（需要昵称请求头）。名称创建后不能修改：请求里带 `name` 返回 400 `name_immutable`。
		 * 机器人不存在 404 `not_found`。
		 */
		replaceWebhook: Endpoint<
			{
				params: {
					/** 机器人名称（登记时起的，创建后不能改）。 */
					name: string;
				};
				body: {
					/** 新的 Webhook 地址（相当于一个凭据，响应里是打码的）。 */
					webhook_url: FeishuWebhookUrl;
				};
			},
			FeishuBotView
		>;
		/**
		 * `GET /feishu-bots/:name/references`
		 *
		 * 引用这个机器人的场景（删除之前列出，删除不受它影响）：最新场景版本里「飞书机器人」类型的输入的常量值，
		 * 以及场景设置里的运行通知，按场景名排序；已归档的场景不列。
		 * 机器人不存在 404 `not_found`。
		 */
		references: Endpoint<
			{
				params: {
					/** 机器人名称（登记时起的，创建后不能改）。 */
					name: string;
				};
			},
			{
				/** 引用这个机器人的场景（最新版本里的飞书通知节点、「飞书机器人」类型的输入，以及运行通知设置），按场景名排序。 */
				scenarios: FeishuBotScenario[];
			}
		>;
		/**
		 * `DELETE /feishu-bots/:name`
		 *
		 * 删除（204，需要昵称请求头）。机器人不存在 404 `not_found`。
		 */
		remove: Endpoint<
			{
				params: {
					/** 机器人名称（登记时起的，创建后不能改）。 */
					name: string;
				};
			},
			void
		>;
		/**
		 * `POST /feishu-bots/:name/test`
		 *
		 * 发送测试消息：不经过发送队列，直接同步向 Webhook 地址发一条固定文本（单次超时 10 秒），
		 * 把飞书的结果翻译成中文返回。机器人不存在 404 `not_found`。
		 */
		test: Endpoint<
			{
				params: {
					/** 机器人名称（登记时起的，创建后不能改）。 */
					name: string;
				};
			},
			FeishuTestResult
		>;
	};
	logs: {
		/**
		 * `GET /tasks/:id/logs`
		 *
		 * 按字节偏移分页读取一个任务的日志（服务端按级别、来源筛选）。
		 */
		page: Endpoint<
			{
				params: {
					id: string;
				};
				query?: LogPageQuery;
			},
			LogPage
		>;
		/**
		 * `GET /tasks/:id/logs/events`
		 *
		 * 日志的实时推送（SSE）：事件 `logs` 是新写入的一批行，`after_seq` 是已经读到的最大序号
		 * （从分页的 last_seq 接上，断线重连时按 `Last-Event-ID` 请求头续传）。
		 */
		events: Stream<
			{
				params: {
					id: string;
				};
				query?: {
					/** 已经读到的最大序号（分页响应的 `last_seq`）：只推送它之后写入的行。 */
					after_seq?: string;
				};
			},
			{
				logs: LogChunk;
			}
		>;
		/**
		 * `GET /tasks/:id/logs/download`
		 *
		 * 下载原始日志（JSONL，只含请求时已写入的内容）；运行已过保留期时 410 `expired`。
		 */
		download: Download<
			{
				params: {
					id: string;
				};
			}
		>;
		/**
		 * `GET /runs/:id/logs`
		 *
		 * 一次运行全部任务的日志合并分页读取（最新一页，或用游标往前翻、往后接续）；运行不存在时 404。
		 */
		runPage: Endpoint<
			{
				params: {
					id: string;
				};
				query?: RunLogPageQuery;
			},
			RunLogPage
		>;
		/**
		 * `GET /runs/:id/logs/download`
		 *
		 * 下载一次运行（范围内）合并后的日志：JSONL，每行是 `RunLogDownloadRow`，顺序与合并视图相同，
		 * 只含请求时已写入的内容，不受级别筛选影响；运行已过保留期时 410 `expired`，运行不存在时 404。
		 */
		runDownload: Download<
			{
				params: {
					id: string;
				};
				query?: RunLogScopeQuery;
			}
		>;
		/**
		 * `GET /runs/:id/logs/events`
		 *
		 * 按运行的实时推送（SSE，#225）：范围（`nodes`）内全部任务新写入的行，包括订阅之后才开始的任务和尝试，
		 * 只推送 `level` 里的级别；范围和级别要与读历史时相同。`after` 用最新一页的 `live_after`。
		 *
		 * - `logs`：一批新行；事件 ID 是推送到的位置（不透明），断线重连时经 `Last-Event-ID` 请求头带回
		 *   （API 客户端的订阅自动带上），控制面只补发之后的行，不重复也不遗漏。
		 * - `reload`：要补发的行太多（超过浏览器保留的 5000 行），不逐行补发：从最新一页重新读，再用新的 `live_after` 连接。
		 *
		 * 运行不存在时 404，`after` 不是 `live_after` 或事件 ID 时 400。
		 */
		runEvents: Stream<
			{
				params: {
					id: string;
				};
				query?: {
					/** 实时流的起点：最新一页的 `live_after`，断线重连时是上一个事件的 ID。 */
					after?: string;
					/** 只看这些节点的日志，写法 `链路实例 ID:节点 ID,节点 ID;…`；不给是全部节点，给空字符串是没有节点。 */
					nodes?: RunLogNodesParam;
					/** 只要这些级别的日志，逗号分隔（例如 `warn,error`）；不给是全部级别。 */
					level?: string;
				};
			},
			{
				logs: RunLogChunk;
				reload: Record<string, never>;
			}
		>;
	};
	metrics: {
		/**
		 * `GET /runs/:id/metrics/summary`
		 *
		 * 运行的指标摘要：每个有指标数据的任务（每次尝试）每个指标的点数、最小、最大、平均、最新值、首尾时间，
		 * 以及截断标记。只包含已经写库的点（当前段约每 10 秒写一次，任务结束时立即写入）。
		 */
		summary: Endpoint<
			{
				params: {
					id: string;
				};
			},
			RunMetricSummary
		>;
		/**
		 * `GET /runs/:id/metrics`
		 *
		 * 运行的指标目录：每个包节点的指标声明、图表定义（含默认图表）、主指标，以及每次尝试的摘要和截断标记。
		 */
		catalog: Endpoint<
			{
				params: {
					id: string;
				};
			},
			RunMetricCatalog
		>;
		/**
		 * `GET /runs/:id/metrics/series`
		 *
		 * 一个节点（默认最新一次尝试）的指标按目标点数降采样，含尚未写库的点。节点不存在时 404。
		 * 实时增量在运行事件流上（`metrics` 事件，`MetricIncrement`）。
		 */
		series: Endpoint<
			{
				params: {
					id: string;
				};
				query: MetricSeriesQuery;
			},
			MetricSeries
		>;
		/**
		 * `GET /runs/:id/metrics/platform`
		 *
		 * 平台自带图表，由任务记录推导。
		 */
		platform: Endpoint<
			{
				params: {
					id: string;
				};
				query?: PlatformMetricsQuery;
			},
			PlatformMetrics
		>;
	};
	orchestrations: {
		/**
		 * `GET /orchestrations`
		 *
		 * 场景列表，按新建时间从新到旧；archived_count 是已归档场景的总数（不受其他筛选影响）。
		 */
		list: Endpoint<
			{
				query?: ListOrchestrationsQuery;
			},
			{
				orchestrations: OrchestrationSummary[];
				/** 已归档场景的总数（不受其他筛选影响）。 */
				archived_count: number;
			}
		>;
		/**
		 * `GET /orchestrations/:id`
		 *
		 * 单个场景（名称、说明、最新版本号、归档时间、运行通知设置、关注项）。
		 */
		get: Endpoint<
			{
				params: {
					id: string;
				};
			},
			OrchestrationView
		>;
		/**
		 * `GET /orchestrations/:id/head`
		 *
		 * 编辑起点：最新版本的内容（secret 参数的默认值是占位符，见文件开头）。
		 */
		head: Endpoint<
			{
				params: {
					id: string;
				};
			},
			OrchestrationHeadView
		>;
		/**
		 * `POST /orchestrations/:id/versions`
		 *
		 * 保存（追加）一个版本，返回 201。需要昵称请求头。base_version 是编辑起点的版本号，
		 * 不是最新版本时返回 409 `version_conflict`（details 见 VersionConflictDetails）。
		 * 请求体不符合契约时用更具体的错误码：缺 base_version 返回 400 `base_version_required`，
		 * 其余（文档不合法、base_version 不是非负整数）返回 400 `invalid_document`；文档里有已移除种类的节点（ADR 0028）时，
		 * 错误信息写明哪些节点、怎么替换。
		 *
		 * **secret 参数的默认值是占位符 `******` 时**（读出来的文档原样存回去，命令行的 pull 再 push、画布保存都是这样），
		 * 按「沿用上一个版本的值」处理：新版本里是 base_version（也就是当时的最新版本）里同名参数（按入口节点 ID 加参数名对应）
		 * 的默认值，原值不会出现在响应里。沿用不了时返回 400 `secret_default_placeholder`，什么都不保存，
		 * details 是 SecretDefaultProblem 的列表（新场景的第一个版本、参数改了名或新增的参数、类型变了、参数从 secret 改成了普通参数）。
		 * 先检查 base_version：编辑起点过期时照常返回 409。想换默认值就给新的值，想去掉就删掉 `default`。
		 * 所以 secret 参数的默认值写不成 `******` 本身；普通参数的默认值可以是任何字符串，包括 `******`。
		 *
		 * 响应里的 `warnings` 只提示，不阻止保存。除了文档本身的静态检查，原来可用、对照新版本会失效的运行预设
		 * （GLOSSARY「失效的运行预设」）各有一条，`code` 是 `preset_invalidated`，没有 `node_id`，`message` 写明预设名和原因；
		 * 原来就已失效的预设不重复警告。另有 `secret_param_default`：secret 参数写了默认值（版本不可修改，默认值会一直留在这个版本里，
		 * 建议改用运行预设或触发时再给出），`node_id` 是入口节点。
		 */
		saveVersion: Endpoint<
			{
				params: {
					id: string;
				};
				body: {
					/** 场景文档：入口、节点、连线、锁定的节点包版本等（格式见 sfly-platform skill 和 orchestration-document 的 JSON Schema）。 */
					document: OrchestrationDocument;
					/** 编辑起点的版本号（0 是还没有版本）；不是最新版本时 409 `version_conflict`。 */
					base_version: number;
					/**
					 * true：这次改动新带进来了警告（改动之前就有的不算，见 CheckedWarningView）时不保存，返回 400 `strict_warnings`，
					 * details 是 VersionCheckView（和检查的响应一样）。在保存的同一个事务里判断。不写时和以前一样，警告不阻止保存。
					 */
					strict?: boolean;
				};
			},
			SavedVersionView
		>;
		/**
		 * `POST /orchestrations/:id/check`
		 *
		 * 检查一份场景文档，不保存（#424）：返回的错误和警告与用同样的请求体保存时完全一样（同一段校验），
		 * 外加保存之后相对最新版本会改变什么（`diff`）。不产生版本，什么都不写。
		 *
		 * - 错误和保存相同：文档不合法 400 `invalid_document`；secret 参数默认值的占位符沿用不了 400 `secret_default_placeholder`；
		 *   给了 `base_version` 而它不是最新版本时 409 `version_conflict`。没有给 `base_version` 时对照最新版本检查，不报冲突。
		 * - 200 时 `warnings` 和保存的响应里的 `warnings` 相同（静态检查、会失效的运行预设、secret 参数写了默认值），
		 *   每条多一个 `existing`：改动之前就有（见 CheckedWarningView）。
		 * - `diff` 是最新版本（还没有版本时是初始文档）到「保存之后的文档」（占位符换回原值、补好坐标）的差异。
		 *
		 * 用 POST 是因为请求体是一整份文档；它是只读的，不需要昵称请求头。
		 */
		check: Endpoint<
			{
				params: {
					id: string;
				};
				body: {
					/** 要检查的场景文档，和保存时一样。 */
					document: OrchestrationDocument;
					/** 编辑起点的版本号；给了且不是最新版本时 409 `version_conflict`，不给时对照最新版本。 */
					base_version?: number;
				};
			},
			VersionCheckView
		>;
		/**
		 * `GET /orchestrations/:id/versions/:a/diff/:b`
		 *
		 * 对比一个场景的两个版本（#424）：从版本 a 到版本 b 的差异，结构见 DocumentDiffView。a、b 可以相同（空差异），
		 * 也可以 a 比 b 新（差异反过来）。版本不存在或不是整数时 404。
		 */
		versionDiff: Endpoint<
			{
				params: {
					/** 场景 id。 */
					id: string;
					/** 对比的起点版本号。 */
					a: string;
					/** 对比的终点版本号。 */
					b: string;
				};
			},
			{
				diff: DocumentDiffView;
			}
		>;
		/**
		 * `POST /orchestrations/:id/edits`
		 *
		 * 对场景做一组局部编辑（#470），存成一个新版本，返回 201：和保存相同的响应，再加上这组操作造成的差异（`diff`，相对 base_version）。
		 * 需要昵称请求头。操作见
		 */
		edit: Endpoint<
			{
				params: {
					id: string;
				};
				body: {
					/** 编辑起点的版本号；不是最新版本时 409 `version_conflict`。 */
					base_version: number;
					/** 按顺序作用的操作，1 到 EDIT_OPERATIONS_MAX 个。 */
					operations: EditOperations;
				};
			},
			{
				id: string;
				orchestration_id: string;
				number: number;
				/** 保存这个版本的人的昵称。 */
				author: string;
				author_via: string | null;
				created_at: Timestamp;
				document: StoredOrchestrationDocument;
				/** 和保存时相同的警告，每条带 `existing`：改动之前（base_version 里）就有（见 CheckedWarningView）。 */
				warnings: CheckedWarningView[];
				/** 这组操作造成的差异：从 base_version 到新版本。 */
				diff: DocumentDiffView;
				/** true：这组操作没有改动，没有存出新版本，返回的是当前版本（状态码 200）；存出了新版本时没有这个字段。 */
				unchanged?: true;
			}
		>;
		/**
		 * `POST /orchestrations/:id/edits/check`
		 *
		 * 检查一组局部编辑，不保存（#470）：和 edit 走同一段代码，返回同样的错误；200 时是 VersionCheckView：
		 * `warnings` 和真正保存时一样（每条带 `existing`），`diff` 是这组操作会造成的差异。不产生版本，什么都不写，不需要昵称请求头。
		 * 没有给 base_version 时对照最新版本，不报冲突。
		 */
		checkEdits: Endpoint<
			{
				params: {
					id: string;
				};
				body: {
					/** 编辑起点的版本号；给了且不是最新版本时 409 `version_conflict`，不给时对照最新版本。 */
					base_version?: number;
					/** 按顺序作用的操作，1 到 EDIT_OPERATIONS_MAX 个。 */
					operations: EditOperations;
				};
			},
			VersionCheckView
		>;
		/**
		 * `GET /orchestrations/:id/versions`
		 *
		 * 版本历史：按版本号从新到旧列出版本号、作者和时间。
		 */
		versions: Endpoint<
			{
				params: {
					id: string;
				};
			},
			{
				/** 全部版本（不含文档），按版本号从新到旧。 */
				versions: VersionSummaryView[];
			}
		>;
		/**
		 * `GET /orchestrations/:id/versions/:number`
		 *
		 * 某个版本的完整内容（版本不可变；secret 参数的默认值是占位符，见文件开头）。
		 */
		version: Endpoint<
			{
				params: {
					/** 场景 id。 */
					id: string;
					/** 版本号，从 1 开始。 */
					number: string;
				};
			},
			OrchestrationVersionView
		>;
		/**
		 * `POST /orchestrations/:id/versions/:number/restore`
		 *
		 * 恢复历史版本：用它的内容追加一个新版本（不改写历史），返回 201 与保存相同的响应。需要昵称请求头。
		 * 恢复不检查编辑起点：恢复后其他人基于旧版本的保存会得到 409。
		 * 恢复也不过保存时的检查：升级前保存的版本里超限的超时、排队超时照样恢复（#576），响应的 `warnings` 里每个这样的字段一条
		 * （`timeout_out_of_range`、`queue_timeout_out_of_range`）；要保存任何改动之前先把它们改成合格的值。
		 */
		restoreVersion: Endpoint<
			{
				params: {
					/** 场景 id。 */
					id: string;
					/** 版本号，从 1 开始。 */
					number: string;
				};
			},
			SavedVersionView
		>;
		/**
		 * `POST /orchestrations`
		 *
		 * 新建场景（自带入口节点：还没有版本时编辑起点是只含入口节点的初始文档）。
		 */
		create: Endpoint<
			{
				body: {
					/** 场景名称。 */
					name: string;
					/** 场景说明（可以是空的）。 */
					description?: string;
				};
			},
			OrchestrationView
		>;
		/**
		 * `PATCH /orchestrations/:id`
		 *
		 * 修改名称、说明、运行通知设置和关注项；不产生新的场景版本，立即生效。
		 *
		 * `focus_items` 是整份替换：给了就用它代替现在的列表（空数组即清空），按列表顺序保存；同时修改时后写的生效，
		 * 不做乐观锁。不合格时返回 400，列表不变：
		 *
		 * - `focus_items_limit`：超过 `FOCUS_ITEMS_MAX` 项。已经失效的项也算在内。
		 * - `focus_item_duplicate`：同一个 `(node_id, chart)` 出现了不止一次。
		 * - `focus_item_unknown_chart`：新加入的项引用了最新版本里没有的节点，或者这个节点锁定的节点包版本没有这张图表。
		 *   已经在列表里、后来失效的项允许原样保留（排序、改名都可以）；移除之后再加回去算新加入的。例外是撤销：
		 *   写回上一次修改之前的列表（界面上的「撤销」就是这样做的）算撤销，整份不再检查，所以移除一个已经失效的项之后
		 *   也能撤销回去。撤销之后没有可以再撤销的列表。
		 *
		 * 控制面比较新旧列表，记下最后一次修改（响应里的 `focus_edit`）；写入和现在一样的列表不算修改。
		 */
		update: Endpoint<
			{
				params: {
					id: string;
				};
				body: {
					/** 新名称。 */
					name?: string;
					/** 新说明。 */
					description?: string;
					/** 运行通知设置，只写要改的项。 */
					run_notification?: RunNotificationChanges;
					/** 关注项：整份替换（空数组即清空）。 */
					focus_items?: FocusItemInput[];
				};
			},
			OrchestrationView
		>;
		/**
		 * `POST /orchestrations/:id/copy`
		 *
		 * 复制场景并取新名字：说明、运行通知设置、运行预设（包括 secret 的值）和关注项（包括已经失效的）一起复制，
		 * 源场景最新版本的内容作为第 1 版。有关注项时，副本的关注项最后修改记为复制的人，说明写「复制自「源场景名」」。
		 * 联调副本也走这个接口。第 1 版是原样复制，不过保存时的检查（升级前保存的版本里超限的超时、排队超时照样复制，#576），
		 * 响应的 `warnings` 是第 1 版的警告，和保存、恢复版本的响应同一套。
		 */
		copy: Endpoint<
			{
				params: {
					id: string;
				};
				body: {
					name: string;
				};
			},
			CopiedOrchestrationView
		>;
		/**
		 * `POST /orchestrations/:id/archive`
		 *
		 * 归档；有运行中的运行时返回 409 run_in_progress。
		 */
		archive: Endpoint<
			{
				params: {
					id: string;
				};
			},
			OrchestrationView
		>;
		/**
		 * `POST /orchestrations/:id/unarchive`
		 *
		 * 恢复已归档的场景。
		 */
		unarchive: Endpoint<
			{
				params: {
					id: string;
				};
			},
			OrchestrationView
		>;
	};
	packages: {
		/**
		 * `GET /packages`
		 *
		 * 包列表（含各版本与节点类型摘要），按包名排序。
		 */
		list: Endpoint<
			{},
			{
				packages: PackageSummary[];
			}
		>;
		/**
		 * `GET /packages/:name`
		 *
		 * 单个包的版本列表。
		 */
		get: Endpoint<
			{
				params: {
					/** 节点包名。 */
					name: PackageName;
				};
			},
			PackageSummary
		>;
		/**
		 * `GET /packages/:name/versions/:version`
		 *
		 * 版本详情（含完整元信息）。
		 */
		version: Endpoint<
			{
				params: {
					/** 节点包名。 */
					name: PackageName;
					/** 版本号。 */
					version: string;
				};
			},
			PackageVersionView
		>;
		/**
		 * `GET /packages/:name/versions/:version/nodes/:node`
		 *
		 * 某个版本里的一个节点类型。
		 */
		nodeType: Endpoint<
			{
				params: {
					/** 节点包名。 */
					name: PackageName;
					/** 版本号。 */
					version: string;
					/** 节点类型名。 */
					node: NodeName;
				};
			},
			NodeTypeView
		>;
	};
	presets: {
		/**
		 * `GET /orchestrations/:id/presets`
		 *
		 * 场景的运行预设，按名称排序。每个预设的 `status` 和 `problems` 对照场景最新版本入口节点的参数声明：
		 * 预设参数已不存在或保存的值不符合现在的类型时是失效的运行预设。场景不存在时 404 `not_found`。
		 */
		list: Endpoint<
			{
				params: {
					id: string;
				};
			},
			{
				presets: PresetView[];
			}
		>;
		/**
		 * `POST /orchestrations/:id/presets`
		 *
		 * 新建运行预设（201，需要昵称请求头，昵称记为最后修改人）。`params` 是预设参数的完整清单，
		 * 对照最新版本检查：参数已声明、值符合类型（不做类型转换，`json` 接受任何值）、字符串不为空，
		 * 至少一个参数，不能重复；secret 参数也能设为预设参数，值明文保存，所有响应里只返回打码后的值。
		 * 不通过时 400 `invalid_preset`，details 是 zod 格式的问题清单（`path` 指出字段，`message` 写明原因）；
		 * 入口节点没有声明参数（包括场景还没有版本）时同样是 `invalid_preset`；新建时没有原值可沿用，用 `keep` 也是 `invalid_preset`。
		 * 名称在场景内已被占用时 409 `preset_name_taken`。场景不存在时 404 `not_found`。
		 */
		create: Endpoint<
			{
				params: {
					id: string;
				};
				body: {
					name: PresetName;
					description?: PresetDescription;
					params: PresetParamInput[];
				};
			},
			PresetView
		>;
		/**
		 * `PATCH /orchestrations/:id/presets/:presetId`
		 *
		 * 修改运行预设（需要昵称请求头，昵称和时间记为最后修改人）：立即生效，不产生新的场景版本；
		 * 两个人同时改时后保存的覆盖先保存的，不做冲突检测。请求体见 `PresetChanges`：没有 `params` 时只改名称和说明；
		 * 给了 `params` 时 400 `invalid_preset` 的规则同新建；其中 secret 参数不重新输入时写 `{name, keep: true}` 沿用原值，
		 * `keep` 用在非 secret 参数上，或者这个预设里原来没有值的参数上，同样是 `invalid_preset`。
		 * 请求体不符合要求（含没有任何要修改的字段）同样是 400 `invalid_preset`。
		 * 新名称被场景里别的预设占用时 409 `preset_name_taken`。预设不存在或不属于这个场景时 404 `preset_not_found`。
		 * 场景归档期间也能修改。
		 */
		update: Endpoint<
			{
				params: {
					/** 场景 id。 */
					id: string;
					/** 运行预设的 id。 */
					presetId: string;
				};
				body: PresetChanges;
			},
			PresetView
		>;
		/**
		 * `POST /orchestrations/:id/presets/:presetId/copy`
		 *
		 * 复制运行预设（201，需要昵称请求头）：在控制面复制，说明和预设参数（包括 secret 的值）不变，新的 ID，
		 * 请求体里是新名称（规则同新建），最后修改人记为复制的人。新名称已被占用时 409 `preset_name_taken`，
		 * 预设不存在或不属于这个场景时 404 `preset_not_found`。场景归档期间也能复制。
		 */
		copy: Endpoint<
			{
				params: {
					/** 场景 id。 */
					id: string;
					/** 运行预设的 id。 */
					presetId: string;
				};
				body: {
					name: PresetName;
				};
			},
			PresetView
		>;
		/**
		 * `DELETE /orchestrations/:id/presets/:presetId`
		 *
		 * 删除运行预设（204，需要昵称请求头）。已有运行上记下的预设 ID、名称和预设参数的名单不受影响。
		 * 预设不存在或不属于这个场景时 404 `preset_not_found`。场景归档期间也能删除。
		 */
		remove: Endpoint<
			{
				params: {
					/** 场景 id。 */
					id: string;
					/** 运行预设的 id。 */
					presetId: string;
				};
			},
			void
		>;
	};
	runs: {
		/**
		 * `GET /runs`
		 *
		 * 所有场景的运行，按开始时间从新到旧（最多 limit 条）。counts 是按场景、关键字筛选后
		 * （不按状态）各状态的运行数，用于状态筛选上的计数。
		 */
		list: Endpoint<
			{
				query?: RunListQuery;
			},
			{
				runs: RunListItem[];
				counts: {
					running: number;
					success: number;
					failed: number;
					cancelled: number;
				};
			}
		>;
		/**
		 * `GET /runs/:id/focus`
		 *
		 * 一次运行的全部关注项：只返回节点在这次运行的版本里的那些项，取节点最新一次尝试的任务，图表的定义取这次运行
		 * 锁定的节点包版本（那个版本里没有这张图表时 `unavailable` 为 `chart_missing`）。节点在这次运行绑定的版本里、
		 * 但还没有开始（包括所在的子流程还没触发）时照样返回，`source.started_at` 为 null，没有数据。场景没设关注项时 `mode` 是
		 * `primary`，返回准备中、执行中节点的主指标。每一项带上异常（`anomaly`，规则见 `FocusAnomalyKind`），
		 * 有异常的排在前面。运行不存在时 404。
		 */
		focus: Endpoint<
			{
				params: {
					id: string;
				};
				query?: RunFocusQuery;
			},
			RunFocus
		>;
		/**
		 * `GET /runs/:id/summary`
		 *
		 * 一次运行的摘要：状态、耗时、最终失败的节点、每个失败的任务的错误（类型、失败原因一行、完整信息）和日志尾部、
		 * 失败的动作、有异常的关注项。判断一次运行「成功且结果对」先读它。读取走运行的统一读取（`readRuns`），
		 * 错误信息、参数里保密参数的值都已打码。运行不存在时 404。
		 */
		summary: Endpoint<
			{
				params: {
					/** 运行 id。 */
					id: string;
				};
			},
			RunReport
		>;
		/**
		 * `GET /orchestrations/:id/preflight`
		 *
		 * 触发前预检：最新版本号、入口参数声明、不能触发的原因（空表示可以触发）、
		 * 不阻断触发但值得留意的警告，
		 * 以及触发表单的检查清单要列出的锁定包版本与引用的 Agent（不在线、在准备环境都不阻止触发，任务会排队），
		 * 和场景的运行预设。
		 */
		preflight: Endpoint<
			{
				params: {
					id: string;
				};
			},
			{
				/** 0 表示还没有版本。 */
				version: number;
				/** 入口参数的声明（名称、类型、默认值、是否必填），触发表单按它生成。 */
				params: ParamDeclView[];
				/** 不能触发的原因；空数组表示可以触发。 */
				problems: PreflightProblem[];
				/** 不阻断触发、但值得留意的配置（例如异步任务节点没有给子流程的参数传值，而子流程里有节点用到了它）；没有版本、已归档时为空。 */
				warnings: PreflightProblem[];
				/** 最新版本锁定的节点包版本（包名 → 版本）；没有版本时为空。 */
				packages: Record<string, string>;
				/** 最新版本引用的 Agent、在线状态与是否在准备环境，默认 Agent 在前；没有版本时为空。 */
				agents: PreflightAgent[];
				/** 场景的运行预设，按名称排序（与 presetsApi.list 相同），`status` 对照这次检查用的最新版本。 */
				presets: PresetView[];
			}
		>;
		/**
		 * `GET /orchestrations/:id/runs`
		 *
		 * 一个场景的运行，按开始时间从新到旧（最多 200 条）。
		 */
		listForOrchestration: Endpoint<
			{
				params: {
					id: string;
				};
			},
			{
				runs: RunSummary[];
			}
		>;
		/**
		 * `POST /orchestrations/:id/runs`
		 *
		 * 触发场景的最新版本（201）。预检不通过时 400 `invalid_orchestration`（details 是原因列表），
		 * 参数不对时 400 `invalid_params`。
		 *
		 * 带上 `preset`（运行预设的 ID）时，预设参数取预设保存的值，`params` 只需要给其余的参数；预设在触发的事务里读取，
		 * 之后修改预设不影响这次运行。`params` 里给 secret 预设参数传了任何值（即使和预设相同，以免调用方猜测原值），或给其他预设参数传了不同的值
		 * （按 JSON 深比较）时 400 `preset_param_locked`（details 是 `{ param, preset }`：参数名和预设名），其他预设参数传相同的值照常触发。预设不存在或不属于这个场景时 404 `preset_not_found`；预设已失效（对照最新版本，见 PresetView 的 `status`）
		 * 时 409 `preset_invalid`（details 是问题清单，每项 `{ param, reason }`），不产生运行。
		 */
		trigger: Endpoint<
			{
				params: {
					id: string;
				};
				body?: {
					params?: Record<string, unknown>;
					/** 运行预设的 ID；不给就是不用预设。 */
					preset?: string;
				};
			},
			RunView
		>;
		/**
		 * `GET /runs/:id`
		 *
		 * 运行视图；实时更新见 `runs.events`。
		 */
		get: Endpoint<
			{
				params: {
					id: string;
				};
			},
			RunView
		>;
		/**
		 * `POST /runs/:id/cancel`
		 *
		 * 取消整个运行（所有链）；清理期间再次调用即强制取消。返回取消后的运行视图；
		 * 已结束时 409 `run_not_running`。
		 */
		cancel: Endpoint<
			{
				params: {
					id: string;
				};
			},
			RunView
		>;
		/**
		 * `GET /runs/:id/events`
		 *
		 * 运行的实时推送（SSE）：连上时和运行或任何节点的状态变化时推送完整的运行视图（`run`），
		 * 任务进度更新时推送 `progress`（只含这一个任务的最新进度），执行中的任务新上报的指标点推送 `metrics`
		 * （每个任务每秒最多一条；断线期间错过的点用指标序列查询补齐）。
		 */
		events: Stream<
			{
				params: {
					id: string;
				};
			},
			{
				run: RunView;
				progress: ProgressEvent;
				metrics: MetricIncrement;
			}
		>;
	};
	sessions: {
		/**
		 * `GET /projects/:project/sessions`
		 *
		 * 项目里的会话（最近活动在前），以及助手此刻能不能用。
		 */
		list: Endpoint<
			{
				params: {
					project: string;
				};
			},
			SessionListResponse
		>;
		/**
		 * `POST /projects/:project/sessions`
		 *
		 * 新建一个会话，`text` 是它的第一句话，作为第一轮：写 `user_message` 和 `turn_started`，把这一轮交给助手服务。
		 * 返回 201 和新会话。助手没有配置时 503 `assistant_not_configured`；这个项目里已有别的会话在做（或在排队）时，新会话
		 * 排队（`status` 是 `queued`，`queue_position` 是排第几，`waiting_for` 是在等谁），这句话照常写 `user_message`，
		 * 轮到它时才交给助手服务；助手服务连不上 503 `assistant_unavailable`，不留下会话。
		 */
		create: Endpoint<
			{
				params: {
					project: string;
				};
				body: CreateSessionBody;
			},
			SessionView
		>;
		/**
		 * `GET /sessions/:id`
		 *
		 * 一个会话和它最近的持久事件（至多一页，序号升序）；`before`（序号）往前翻页，`has_more` 为 true 表示更早的还有。
		 */
		get: Endpoint<
			{
				params: {
					id: string;
				};
				query?: SessionDetailQuery;
			},
			SessionDetailResponse
		>;
		/**
		 * `GET /sessions/:id/events`
		 *
		 * 实时推送一个会话的事件（SSE）：先按 `after` 和 `Last-Event-ID` 里较大的一个从库里补发，再接实时。
		 * 事件名是事件的 `type`，data 是事件（`SessionEvent`）：持久的事件以会话内序号 `seq` 作事件 ID，
		 * 不持久的（文字增量、工具输出、思考、排队状态、快照）没有 ID，不推进续传的位置。
		 */
		events: Stream<
			{
				params: {
					id: string;
				};
				query?: SessionEventsQuery;
			},
			{
				user_message: {
					type: "user_message";
					message_id: string;
					text: string;
					steer: boolean;
					author: string;
					author_user_id: string | null;
					seq: number;
					at: Timestamp;
				};
				turn_started: {
					type: "turn_started";
					turn: number;
					seq: number;
					at: Timestamp;
				};
				turn_queued: TurnQueuedEvent;
				thinking: ThinkingEvent;
				assistant_delta: AssistantDeltaEvent;
				assistant_message: {
					type: "assistant_message";
					text: string;
					usage: TokenUsage;
					seq: number;
					at: Timestamp;
				};
				tool_call: {
					type: "tool_call";
					call_id: string;
					tool: SessionTool;
					title: string;
					seq: number;
					at: Timestamp;
				};
				tool_output: ToolOutputEvent;
				tool_result: {
					type: "tool_result";
					call_id: string;
					is_error: boolean;
					text: string;
					truncated: boolean;
					exit_code?: number;
					diff?: string;
					duration_ms: number;
					seq: number;
					at: Timestamp;
				};
				steer_queue: SteerQueueEvent;
				notice: {
					kind: NoticeKind;
					type: "notice";
					/** 给人看的一句话。 */
					message: string;
					/** 第几次重试（从 1 起）；只有 `retry`。 */
					attempt?: number;
					/** 最多重试几次；只有 `retry`。 */
					max_attempts?: number;
					/** 多久（毫秒）之后重试；只有 `retry`。 */
					retry_delay_ms?: number;
					/** 重试的原因按什么分；#548 起有值。 */
					error_class?: ErrorClass;
					/**
					 * 没有送到的那句话（`user_message.message_id`）：`steer_dropped`（插话没有送到模型）和 `queue_cancelled`（排队中的话因停止没有交给助手）
					 * **必须带**，其余种类不能带。页面据此把这一行和那句话对上，不靠 `message` 里引用的文字；同一句话可能有两条 `steer_dropped`
					 * （控制面写了「没有确认送到」、助手服务之后又确认没送到），按它认，显示一次。#544 起。
					 */
					message_id?: string;
					seq: number;
					at: Timestamp;
				};
				turn_end: {
					type: "turn_end";
					turn: number;
					outcome: TurnOutcome;
					reason: string;
					steps?: number;
					model_calls?: number;
					duration_ms: number;
					usage?: TokenUsage;
					limit_kind?: TurnLimit;
					error_class?: ErrorClass;
					seq: number;
					at: Timestamp;
				};
				platform: {
					type: "platform";
					kind: "commit";
					turn: number;
					hash: string;
					files: CommitFile[];
					diff: string;
					truncated: boolean;
					seq: number;
					at: Timestamp;
				} | {
					type: "platform";
					kind: "scenario_version";
					turn: number;
					scenario_id: string;
					name: string;
					version: number;
					seq: number;
					at: Timestamp;
				} | {
					type: "platform";
					kind: "run";
					turn: number;
					run_id: string;
					scenario_name: string;
					seq: number;
					at: Timestamp;
				};
				session_ended: {
					type: "session_ended";
					by: string;
					seq: number;
					at: Timestamp;
				};
				snapshot: SnapshotEvent;
			}
		>;
		/**
		 * `POST /sessions/:id/messages`
		 *
		 * 对会话说一句话，返回这句话的 `user_message` 的序号：空闲时开始新的一轮（这个项目里别的会话在做时，这个会话排队，
		 * 这句话轮到它时才交给助手服务）；**在做时是插话**（`user_message` 的 `steer` 为 true，交给助手服务的 `steer`，在当前这一步
		 * 的工具调用做完之后、下一次调用模型之前送到；响应类型不变）；排队中 409 `session_queued`；已结束 409 `session_ended`。
		 */
		message: Endpoint<
			{
				params: {
					id: string;
				};
				body: SendMessageBody;
			},
			SendMessageResult
		>;
		/**
		 * `POST /sessions/:id/stop`
		 *
		 * 停止会话正在做的这一轮（把中止发给助手服务，这一轮的 `turn_end` 由助手服务的事件带回来）；排队中的会话移出队列、
		 * 回到空闲（给排队时说的那句话补一条 `queue_cancelled` 的提示）；空闲和已结束时什么也不做。
		 */
		stop: Endpoint<
			{
				params: {
					id: string;
				};
			},
			SessionView
		>;
		/**
		 * `POST /sessions/:id/end`
		 *
		 * 结束会话：在做的一轮先停止，排队的移出队列，把 `end` 发给助手服务（它结束这个会话的进程），会话变成已结束并写
		 * `session_ended`。之后发话 409 `session_ended`。工作区、提交、场景版本、运行都留着，不删除任何东西。
		 * 已经结束的会话再调用无害（返回会话，不再写事件）。助手没有配置时 503 `assistant_not_configured`。
		 */
		end: Endpoint<
			{
				params: {
					id: string;
				};
			},
			SessionView
		>;
	};
	system: {
		/**
		 * `GET /health`
		 *
		 * 健康检查：数据库不可用时返回 503，响应体形状相同（status 与 database 为 unavailable）。
		 */
		health: Endpoint<
			{},
			{
				/** 控制面整体：`ok` 或 `unavailable`（数据库不可用时返回 503，响应体形状相同）。 */
				status: "ok" | "unavailable";
				/** 数据库连得上吗。 */
				database: "ok" | "unavailable";
				/** 控制面的当前时间（控制面时间）。 */
				time: Timestamp;
			}
		>;
	};
}

export const routes = {
	actions: {
		summary: { method: "GET", path: "/tasks/:id/actions/summary", kind: "endpoint" },
		page: { method: "GET", path: "/tasks/:id/actions", kind: "endpoint" },
		events: { method: "GET", path: "/tasks/:id/actions/events", kind: "stream" },
	},
	agents: {
		list: { method: "GET", path: "/agents", kind: "endpoint" },
		updateNow: { method: "POST", path: "/agents/:name/update-now", kind: "endpoint" },
	},
	artifacts: {
		list: { method: "GET", path: "/tasks/:id/artifacts", kind: "endpoint" },
		download: { method: "GET", path: "/tasks/:id/artifacts/*", kind: "download" },
	},
	dashboard: {
		get: { method: "GET", path: "/dashboard", kind: "endpoint" },
	},
	feishuBots: {
		list: { method: "GET", path: "/feishu-bots", kind: "endpoint" },
		create: { method: "POST", path: "/feishu-bots", kind: "endpoint" },
		replaceWebhook: { method: "PATCH", path: "/feishu-bots/:name", kind: "endpoint" },
		references: { method: "GET", path: "/feishu-bots/:name/references", kind: "endpoint" },
		remove: { method: "DELETE", path: "/feishu-bots/:name", kind: "endpoint" },
		test: { method: "POST", path: "/feishu-bots/:name/test", kind: "endpoint" },
	},
	logs: {
		page: { method: "GET", path: "/tasks/:id/logs", kind: "endpoint" },
		events: { method: "GET", path: "/tasks/:id/logs/events", kind: "stream" },
		download: { method: "GET", path: "/tasks/:id/logs/download", kind: "download" },
		runPage: { method: "GET", path: "/runs/:id/logs", kind: "endpoint" },
		runDownload: { method: "GET", path: "/runs/:id/logs/download", kind: "download" },
		runEvents: { method: "GET", path: "/runs/:id/logs/events", kind: "stream" },
	},
	metrics: {
		summary: { method: "GET", path: "/runs/:id/metrics/summary", kind: "endpoint" },
		catalog: { method: "GET", path: "/runs/:id/metrics", kind: "endpoint" },
		series: { method: "GET", path: "/runs/:id/metrics/series", kind: "endpoint" },
		platform: { method: "GET", path: "/runs/:id/metrics/platform", kind: "endpoint" },
	},
	orchestrations: {
		list: { method: "GET", path: "/orchestrations", kind: "endpoint" },
		get: { method: "GET", path: "/orchestrations/:id", kind: "endpoint" },
		head: { method: "GET", path: "/orchestrations/:id/head", kind: "endpoint" },
		saveVersion: { method: "POST", path: "/orchestrations/:id/versions", kind: "endpoint" },
		check: { method: "POST", path: "/orchestrations/:id/check", kind: "endpoint" },
		versionDiff: { method: "GET", path: "/orchestrations/:id/versions/:a/diff/:b", kind: "endpoint" },
		edit: { method: "POST", path: "/orchestrations/:id/edits", kind: "endpoint" },
		checkEdits: { method: "POST", path: "/orchestrations/:id/edits/check", kind: "endpoint" },
		versions: { method: "GET", path: "/orchestrations/:id/versions", kind: "endpoint" },
		version: { method: "GET", path: "/orchestrations/:id/versions/:number", kind: "endpoint" },
		restoreVersion: { method: "POST", path: "/orchestrations/:id/versions/:number/restore", kind: "endpoint" },
		create: { method: "POST", path: "/orchestrations", kind: "endpoint" },
		update: { method: "PATCH", path: "/orchestrations/:id", kind: "endpoint" },
		copy: { method: "POST", path: "/orchestrations/:id/copy", kind: "endpoint" },
		archive: { method: "POST", path: "/orchestrations/:id/archive", kind: "endpoint" },
		unarchive: { method: "POST", path: "/orchestrations/:id/unarchive", kind: "endpoint" },
	},
	packages: {
		list: { method: "GET", path: "/packages", kind: "endpoint" },
		get: { method: "GET", path: "/packages/:name", kind: "endpoint" },
		version: { method: "GET", path: "/packages/:name/versions/:version", kind: "endpoint" },
		nodeType: { method: "GET", path: "/packages/:name/versions/:version/nodes/:node", kind: "endpoint" },
	},
	presets: {
		list: { method: "GET", path: "/orchestrations/:id/presets", kind: "endpoint" },
		create: { method: "POST", path: "/orchestrations/:id/presets", kind: "endpoint" },
		update: { method: "PATCH", path: "/orchestrations/:id/presets/:presetId", kind: "endpoint" },
		copy: { method: "POST", path: "/orchestrations/:id/presets/:presetId/copy", kind: "endpoint" },
		remove: { method: "DELETE", path: "/orchestrations/:id/presets/:presetId", kind: "endpoint" },
	},
	runs: {
		list: { method: "GET", path: "/runs", kind: "endpoint" },
		focus: { method: "GET", path: "/runs/:id/focus", kind: "endpoint" },
		summary: { method: "GET", path: "/runs/:id/summary", kind: "endpoint" },
		preflight: { method: "GET", path: "/orchestrations/:id/preflight", kind: "endpoint" },
		listForOrchestration: { method: "GET", path: "/orchestrations/:id/runs", kind: "endpoint" },
		trigger: { method: "POST", path: "/orchestrations/:id/runs", kind: "endpoint" },
		get: { method: "GET", path: "/runs/:id", kind: "endpoint" },
		cancel: { method: "POST", path: "/runs/:id/cancel", kind: "endpoint" },
		events: { method: "GET", path: "/runs/:id/events", kind: "stream" },
	},
	sessions: {
		list: { method: "GET", path: "/projects/:project/sessions", kind: "endpoint" },
		create: { method: "POST", path: "/projects/:project/sessions", kind: "endpoint" },
		get: { method: "GET", path: "/sessions/:id", kind: "endpoint" },
		events: { method: "GET", path: "/sessions/:id/events", kind: "stream" },
		message: { method: "POST", path: "/sessions/:id/messages", kind: "endpoint" },
		stop: { method: "POST", path: "/sessions/:id/stop", kind: "endpoint" },
		end: { method: "POST", path: "/sessions/:id/end", kind: "endpoint" },
	},
	system: {
		health: { method: "GET", path: "/health", kind: "endpoint" },
	},
} as const satisfies RouteTable<Api>;
