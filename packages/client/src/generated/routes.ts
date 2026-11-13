// 由 HTTP 契约（packages/schema/src/http）生成，不要手改：pnpm gen。

import type { Download, Endpoint, RouteTable, Stream } from "../route.js";
import type {
	AgentView,
	ArtifactView,
	DashboardView,
	FeishuBotScenario,
	FeishuBotView,
	ListOrchestrationsQuery,
	LogChunk,
	LogPage,
	LogPageQuery,
	MetricIncrement,
	MetricSeries,
	MetricSeriesQuery,
	NodeName,
	NodeTypeView,
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
	PreflightProblem,
	ProgressEvent,
	ReferencedAgent,
	RunListItem,
	RunListQuery,
	RunLogChunk,
	RunLogNodesParam,
	RunLogPage,
	RunLogPageQuery,
	RunLogScopeQuery,
	RunMetricCatalog,
	RunMetricSummary,
	RunSummary,
	RunView,
	Timestamp,
	VersionSummaryView,
} from "./types.js";

export interface Api {
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
					id: string;
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
		 * `GET /feishu-bots/:name/references`
		 *
		 * 引用这个机器人的场景（删除之前列出，删除不受它影响）：最新场景版本里的飞书通知节点、
		 * 「飞书机器人」类型的输入的常量值，以及场景设置里的运行通知，按场景名排序；已归档的场景不列。
		 * 机器人不存在 404 `not_found`。
		 */
		references: Endpoint<
			{
				params: {
					name: string;
				};
			},
			{
				scenarios: FeishuBotScenario[];
			}
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
		 * （从分页的 last_seq 接上，浏览器重连时按 Last-Event-ID 续传）。
		 */
		events: Stream<
			{
				params: {
					id: string;
				};
				query?: {
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
		 * - `logs`：一批新行；事件 ID 是推送到的位置（不透明），浏览器原生 EventSource 断线重连时经 `Last-Event-ID`
		 *   带回，控制面只补发之后的行，不重复也不遗漏。
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
					after?: string;
					nodes?: RunLogNodesParam;
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
				archived_count: number;
			}
		>;
		/**
		 * `GET /orchestrations/:id`
		 *
		 * 单个场景（名称、说明、最新版本号、归档时间）。
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
		 * 编辑起点：最新版本的内容。
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
				versions: VersionSummaryView[];
			}
		>;
		/**
		 * `GET /orchestrations/:id/versions/:number`
		 *
		 * 某个版本的完整内容（版本不可变）。
		 */
		version: Endpoint<
			{
				params: {
					id: string;
					number: string;
				};
			},
			OrchestrationVersionView
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
					name: PackageName;
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
					name: PackageName;
					version: string;
					node: NodeName;
				};
			},
			NodeTypeView
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
		 * `GET /orchestrations/:id/preflight`
		 *
		 * 触发前预检：最新版本号、入口参数声明、不能触发的原因（空表示可以触发），
		 * 以及触发表单的检查清单要列出的锁定包版本与引用的 Agent（不在线不阻止触发，任务会排队）。
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
				params: ParamDeclView[];
				problems: PreflightProblem[];
				/** 最新版本锁定的节点包版本（包名 → 版本）；没有版本时为空。 */
				packages: Record<string, string>;
				/** 最新版本引用的 Agent 与在线状态，默认 Agent 在前；没有版本时为空。 */
				agents: ReferencedAgent[];
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
	system: {
		/**
		 * `GET /health`
		 *
		 * 健康检查：数据库不可用时返回 503，响应体形状相同（status 与 database 为 unavailable）。
		 */
		health: Endpoint<
			{},
			{
				status: "ok" | "unavailable";
				database: "ok" | "unavailable";
				time: Timestamp;
			}
		>;
	};
}

export const routes = {
	agents: {
		list: { method: "GET", path: "/agents", kind: "endpoint" },
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
		references: { method: "GET", path: "/feishu-bots/:name/references", kind: "endpoint" },
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
		versions: { method: "GET", path: "/orchestrations/:id/versions", kind: "endpoint" },
		version: { method: "GET", path: "/orchestrations/:id/versions/:number", kind: "endpoint" },
	},
	packages: {
		list: { method: "GET", path: "/packages", kind: "endpoint" },
		get: { method: "GET", path: "/packages/:name", kind: "endpoint" },
		version: { method: "GET", path: "/packages/:name/versions/:version", kind: "endpoint" },
		nodeType: { method: "GET", path: "/packages/:name/versions/:version/nodes/:node", kind: "endpoint" },
	},
	runs: {
		list: { method: "GET", path: "/runs", kind: "endpoint" },
		preflight: { method: "GET", path: "/orchestrations/:id/preflight", kind: "endpoint" },
		listForOrchestration: { method: "GET", path: "/orchestrations/:id/runs", kind: "endpoint" },
		get: { method: "GET", path: "/runs/:id", kind: "endpoint" },
		events: { method: "GET", path: "/runs/:id/events", kind: "stream" },
	},
	system: {
		health: { method: "GET", path: "/health", kind: "endpoint" },
	},
} as const satisfies RouteTable<Api>;
