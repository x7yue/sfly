import { MAIN_CHAIN_LABEL, SUBFLOW_LABEL } from "@sfly/orchestration";
import {
	type ActionResult,
	type CountOnlyPeriod,
	focusChartMissing,
	type LogLineView,
	type NodeStatus,
	type RunNotificationState,
	type RunStatus,
} from "@sfly/schema";
import { NODE_STATUS, notRunNote } from "#/lib/node-status";

/**
 * 界面文案（故事 79：文案集中管理，不引入 i18n 框架；规则见 docs/DESIGN-SYSTEM.md「文案」一节）。
 *
 * 这里放多处共用的文字：术语（GLOSSARY.md）、状态文字、导航与页面名、通用操作、通用的加载 / 错误 / 空状态。
 * 页面一次性的说明文字留在组件里；新的共用文字先加到这里再引用，不要在组件里另写一份。
 */

/** 「还没有数据」：`MESSAGE.noData`，关注项的原因句里也用它（FOCUS 写在 MESSAGE 前面）。 */
const MESSAGE_NO_DATA = "还没有数据";

/** 「没有符合条件的X」：筛选之后什么都没有（日志、运行、动作的空状态共用这一个说法）；`MESSAGE.noMatch` 是它。 */
const MESSAGE_NO_MATCH = (what: string) => `没有符合条件的${what}`;

/** 术语（与 GLOSSARY.md 一致；「编排」只作动词）。 */
export const TERM = {
	scenario: "场景",
	version: "版本",
	run: "运行",
	node: "节点",
	mainChain: MAIN_CHAIN_LABEL,
	subflow: SUBFLOW_LABEL,
	attempt: "尝试",
	agent: "Agent",
	feishuBot: "飞书机器人",
	runNotification: "运行通知",
	runPreset: "运行预设",
	nodePackage: "节点包",
	metric: "指标",
	chart: "图表",
	primaryMetric: "主指标",
	focusItem: "关注项",
	displayName: "显示名称",
	note: "备注",
	annotation: "注释框",
	lastEdited: "最后修改",
	action: "动作",
	mark: "标记",
} as const;

/**
 * 检查器的页名：页签、页面标题和别处指路的提示（「先在场景设置的「关注项」页移除一项」）引用同一份，改名不会漏。
 * 「场景设置」是不选节点时的检查器，也是版本对比里场景级设置、飞书机器人引用里「运行通知（场景设置）」的名字。
 */
export const INSPECTOR_PAGE = {
	sceneSettings: "场景设置",
	overview: "概况",
	focus: TERM.focusItem,
	params: "参数",
	exec: "执行",
	doc: "说明",
	docWithMetrics: "说明与指标",
} as const;

/** 节点用 `ctx.progress` 上报的进度：监控的图表工作区、时间线、运行抽屉、画布检查器共用（运行记录表里「进度」是各链进度，不是它）。 */
export const PROGRESS_LABEL = "进度";

/** 「第 2 次尝试」：节点重试时指明是哪一次（运行监控的尝试页签、画布检查器的动作区共用）。 */
export const attemptLabel = (attempt: number) => `第 ${attempt} 次${TERM.attempt}`;

/** 日志级别的写法：日志列表、级别筛选、运行抽屉的最新日志和关注项的异常原因共用。 */
export const LOG_LEVEL_LABEL: Record<LogLineView["level"], string> = {
	debug: "DEBUG",
	info: "INFO",
	warn: "WARN",
	error: "ERROR",
};
/** WARN 和 ERROR 合起来的写法：关注项的 WARN / ERROR 统计。 */
export const LOG_ALERT_LEVELS = `${LOG_LEVEL_LABEL.warn} / ${LOG_LEVEL_LABEL.error}`;

/** 无新数据时「需要注意」里的推测：有点和没有点两种说法共用。 */
const STALE_HINT = "可能是节点卡住了，或者 Agent 的指标上报中断了。";

/** 关注项（GLOSSARY「关注项」）：节点检查器的名额、场景设置的「关注项」页和图表列表共用的文字。 */
export const FOCUS = {
	/** 名额里注明其中有几项已经失效（失效的项也占名额）。 */
	staleNote: (stale: number) => `（含 ${stale} 项已失效的）`,
	/** 关注项失效的一种原因：节点包的这个版本没有声明这张图表。句子来自 `@sfly/schema` 的 `focusChartMissing`。 */
	chartMissing: focusChartMissing,
	/** 关注项不属于场景版本：节点检查器的图表列表和「关注项」页都要说明这一点。 */
	notVersioned: `${TERM.focusItem}属于${INSPECTOR_PAGE.sceneSettings}，不属于场景版本：改动立即生效，不产生新版本。`,
	/** 有异常的关注项的统称：概览里列出它们的那一段的标题，读数和图表的可访问名称里异常原因的前缀。 */
	attention: "需要注意",
	/** 「3 个关注项」：画布节点卡片的可访问名称。 */
	itemCount: (count: number) => `${count} 个${TERM.focusItem}`,
	/** 「1 项需要注意」：画布节点卡片和 Agent 槽位格的可访问名称、画布检查器里关注项的标题旁。 */
	attentionCount: (count: number): string => `${count} 项${FOCUS.attention}`,
	/** 只放得下前几项时，其余的个数（`moreLabel` 加上「关注项」）：画布节点卡片和 Agent 槽位格的最后一行。 */
	moreItems: (count: number): string => `${moreLabel(count)}${TERM.focusItem}`,
	/** 场景没有设置关注项，显示的是执行中节点的主指标：概览的标题旁和 Agent 槽位格里的主指标共用这一句。 */
	noneSet: `场景没有设置${TERM.focusItem}`,
	/** 概览里最后一段的标题：这次运行里没有进入「需要注意」的 WARN / ERROR。 */
	otherAlerts: "其他警告与错误",
	/** 上面那一段没有内容时的说明。 */
	noOtherAlerts: "没有其他警告与错误",
	/** 有异常的关注项排在最前：概览的副标题和场景设置的「关注项」页共用这一句。 */
	anomalyFirst: "有异常的项排在最前",
	/**
	 * 异常原因的短句（规格 #344 的四种异常）：读数的脚注、图表卡片和别处的关注项读数都用这几句，
	 * 由 `focus-format.ts` 的 `anomalyText` 按一项的 `anomaly` 选出。
	 */
	logReason: (level: string, clock: string) => `${level} · ${clock}`,
	staleFor: (ago: string) => `已 ${ago} 无新数据`,
	sourceFailed: "来源节点失败",
	retryReason: (attempt: number, clock: string) => `重试（${TERM.attempt} ${attempt}）· ${clock}`,
	/**
	 * 「需要注意」里每一行的原因，写清是哪个节点、为什么（与上面四种短句一一对应）。只用于执行中的节点的是无新数据的两句
	 * （控制面只对开始执行了的节点判断无新数据）：有点时写最后一个点多久前和采样间隔（点不够两个时没有采样间隔），
	 * 一个点都没有时写开始执行了多久。
	 */
	logDetail: (node: string, level: string, clock: string, message: string, count: number) =>
		`${node} 的 ${level}（${clock}）：${message}${count > 1 ? ` · 这次${TERM.attempt}共有 ${count} 条 ${LOG_ALERT_LEVELS}` : ""}`,
	staleDetail: (node: string, ago: string, every: string | null) =>
		`${node} 仍在执行，但最后一个点在 ${ago} 前${every === null ? "" : `，采样间隔 ${every}`}。${STALE_HINT}`,
	noDataDetail: (node: string, ago: string) =>
		`${node} 已经执行了 ${ago}，${MESSAGE_NO_DATA}。${STALE_HINT}`,
	failedDetail: (node: string, message: string) => `${node} 失败${message ? `：${message}` : "。"}`,
	retryDetail: (node: string, clock: string, attempt: number, message: string) =>
		`${node} 在 ${clock} 开始重试（${TERM.attempt} ${attempt}）${message ? `，上一次${TERM.attempt}失败：${message}` : "。"}`,
	/** 运行监控页头：概览的关注项读数是什么时候生成的（控制面时间）。 */
	dataUpdated: (clock: string) => `数据更新于 ${clock}`,
} as const;

/** 注释框各字段的名称：检查器的字段错误和版本对比共用。 */
export const ANNOTATION_FIELD_LABEL: Readonly<Record<string, string>> = {
	title: "标题",
	note: TERM.note,
	nodes: "成员节点",
	subflows: "成员子流程",
};

/** 导航与页面名（侧边栏、面包屑、命令面板、快捷键面板）。 */
export const PAGE = {
	dashboard: "控制台",
	scenarios: "场景编排",
	archivedScenarios: "已归档的场景",
	runs: "运行记录",
	agents: "Agent 管理",
	packages: "节点包管理",
	feishuBots: "飞书机器人",
	editor: "编排画布",
	monitor: "运行监控",
	versions: "版本历史",
	docs: "开发文档",
} as const;

/** 开发文档里被界面引用的页名（控制面 docs/guide/pages.json 里的标题）。 */
export const DOC_PAGE = {
	quickstart: "快速开始",
	publish: "发布",
	sdkReference: "开发节点（SDK 参考）",
} as const;

/** 运行与链实例的状态。 */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
	running: "运行中",
	success: "成功",
	failed: "失败",
	cancelled: "已取消",
};

/**
 * 飞书消息的投递结果（GLOSSARY「投递」）：机器人管理页的「最近投递」和运行详情里的运行通知都用这两个词，
 * 失败写「投递失败」，不用「发送失败」。
 */
export const DELIVERY = {
	delivered: "已送达",
	failed: "投递失败",
} as const;

/** 运行通知的状态文字（运行详情里的一行）。 */
export const RUN_NOTIFICATION_STATUS_LABEL: Record<RunNotificationState["status"], string> = {
	queued: "排队中",
	delivered: DELIVERY.delivered,
	failed: DELIVERY.failed,
	discarded: "已丢弃",
	not_sent: "未发送",
};

/** 登记飞书机器人的说明里两处页面共用的句子：空状态和登记弹窗各自接上自己要补充的话。 */
export const FEISHU_BOT_SETUP = {
	add: "在飞书群里添加「自定义机器人」，把它的 Webhook 地址登记到这里。",
	noSignature: "sfly 不支持签名校验，机器人的安全设置请用关键词或 IP 白名单。",
} as const;

/** Agent 的连接状态：Agent 管理页、控制台、场景列表和检查器的 Agent 选择都写这两个词。 */
export const AGENT_STATUS_LABEL = { online: "在线", offline: "离线" } as const;

/** 已请求取消、还在等待任务结束与清理的运行（故事 70：不显示成「运行中」）。 */
export const CANCELLING_LABEL = "取消中";
/** 清理期间再次取消，正在强制终止。 */
export const FORCE_CANCELLING_LABEL = "强制终止中";

/** 通用操作（按钮、菜单项、命令）。 */
export const ACTION = {
	run: "运行",
	runScenario: "运行场景",
	trigger: "触发运行",
	rerun: "再次运行",
	cancelRun: "取消运行",
	forceCancel: "强制终止",
	keepRunning: "继续运行",
	openRun: "打开运行监控",
	openActionDetails: `打开${TERM.action}明细`,
	viewInCanvas: "在画布中查看",
	viewRuns: "查看运行记录",
	edit: "编排",
	newScenario: "新建场景",
	publishPackage: "发布节点包",
	close: "关闭",
	back: "返回",
	retry: "重试",
	clearFilters: "清除筛选",
	copyErrorDetails: "复制错误详情",
	insertReference: "插入引用",
	addAnnotation: `添加${TERM.annotation}`,
	undo: "撤销",
	focus: "关注",
	moveUp: "上移",
	moveDown: "下移",
	resizeInspector: "调整检查器宽度",
	expand: "展开",
	collapse: "收起",
	/** 编排画布运行状态的「跟随执行」：工具条按钮、快捷键面板和读屏播报都用这个名字。 */
	followExecution: "跟随执行",
} as const;

/** AI 编程助手的显示名，键是请求头 `x-sfly-client` 里 `agent/<名称>` 的名称（用 Map，避免 `constructor` 这类名称取到对象自带的属性）。 */
const ASSISTANT_NAME = new Map([
	["claude-code", "Claude Code"],
	["codex", "Codex"],
]);

/** 「经 Claude Code」：操作经哪个 AI 编程助手发起。不认识的名称原样显示。只是标注，不是鉴权（ADR 0004）。 */
export const viaLabel = (via: string) => `经 ${ASSISTANT_NAME.get(via) ?? via}`;

/** 「已新建场景「巡检」」：新建弹窗成功后的提示，控制台「开始使用」里做完的那一步也写这一句。 */
export const scenarioCreatedLabel = (name: string) => `已新建场景「${name}」`;

/** 「预设：压测 A 集群」：运行监控页顶栏、运行记录里这个运行用的运行预设（触发时记下的名称）。 */
export const presetLabel = (name: string) => `预设：${name}`;

/** 失效的运行预设（GLOSSARY）的状态词：运行抽屉的选择框、管理对话框的列表、「再次运行」的提示里都写它。 */
export const PRESET_INVALID_LABEL = "已失效";

/** 运行监控页两个视图的名称：页头的标签页，和概览里「在详情里打开」「在详情里查看」的说法共用。 */
export const MONITOR_VIEW_LABEL = { overview: "概览", detail: "详情" } as const;

/** 「运行监控详情」：运行监控页之外的地方（画布运行状态的检查器）指向运行监控的「详情」视图时这样写。 */
export const MONITOR_DETAIL_LABEL = `${PAGE.monitor}${MONITOR_VIEW_LABEL.detail}`;

/**
 * 图例里放不下的序列：概览里是同一页切到「详情」视图，写「在详情里查看」；
 * 检查器在运行监控之外，要去另一个页面，写「打开运行监控详情」。
 */
export const hiddenSeriesLabel = {
	inView: (count: number) => `另有 ${count} 条序列在${MONITOR_VIEW_LABEL.detail}里查看`,
	openPage: (count: number) => `另有 ${count} 条序列，打开${MONITOR_DETAIL_LABEL}`,
};

/** 检查器的图表列表里说明图表不能缩放，要缩放得去运行监控的详情。 */
export const ZOOM_IN_DETAIL_LABEL = `要缩放，打开${MONITOR_DETAIL_LABEL}`;

/** 「在详情里打开 fetch」「在运行监控详情里打开 fetch」：跳到某个视图里的这个节点的按钮或链接。 */
export const openInLabel = (place: string, node: string) => `在${place}里打开 ${node}`;

/** 关注项读数里来源节点成功、已停止或已取消后的「最终值」：读数的脚注和可访问名称共用。 */
export const FINAL_VALUE_LABEL = "最终值";

/** 「2 条链 · 7 个节点」：运行监控的链路时间线和概览的链路共用。 */
export const chainCountLabel = (chains: number, nodes: number) =>
	`${chains} 条链 · ${nodes} 个节点`;

/** 运行开始到现在的时长（运行中）和开始到结束的时长（已结束）：控制台、运行监控页顶栏、运行记录的卡片共用。 */
export const ELAPSED_LABEL = "已运行";
export const DURATION_LABEL = "耗时";

/** 「2 / 8 占用」「排队 1」：一台 Agent 的槽位占用和排队的任务数（Agent 管理页的机架、控制台的 Agent 列）。 */
export const slotUsageLabel = (used: number, slots: number) => `${used} / ${slots} 占用`;
export const queuedLabel = (count: number) => `排队 ${count}`;

/** 「还有 3 个」：列表或线路只画出前面一部分时，其余的个数（控制台的线路和进行中的节点、运行记录的卡片）。 */
export const moreLabel = (count: number) => `还有 ${count} 个`;

/**
 * 「进行中」：还没结束的统称，不等于任何一个状态名。运行抽屉的摘要里是还没结束、正在推进的节点（排队中、准备中、
 * 执行中、等待中）合起来的名称：抽屉里排队中、等待中的节点也在这个列表里，标题不能写成其中一个状态。控制台运行块
 * 的那一行同理。运行监控「动作」页的结果里是还没结束的动作（`NODE_ACTIONS.results.running`）。
 */
export const ACTIVE_LABEL = "进行中";

/**
 * 动作与标记（GLOSSARY「动作」「标记」，规格 #345）：画布、检查器、概览、运行监控里写动作的地方共用的文字。
 * 和 `ACTION`（界面上的通用操作）不是一回事。
 */
export const NODE_ACTIONS = {
	/** 此刻在做的事：画布卡片和读屏的「正在做 X」，检查器的「正在做」，「动作」页的第一组。 */
	doing: "正在做",
	/** 版面放得下时写在动作名称前的「正在」（Agent 槽位格、概览执行中那一行）；画布卡片只有 208px 宽，用执行中的形状代替它。 */
	doingNow: "正在",
	/** 正在做的动作列满了：接口只给前 50 个，可能还有没列出的（检查器的「正在做」、「动作」页的第一组共用）。 */
	runningIncomplete: (listed: number) => `列满 ${listed} 个，可能还有没列出的`,
	/**
	 * 动作的结果和标记：动作自己的一组状态文字，不是运行状态（`RUN_STATUS_LABEL`）。还没结束的写「进行中」。
	 */
	results: {
		running: ACTIVE_LABEL,
		success: "成功",
		failed: "失败",
		unfinished: "未结束",
		mark: TERM.mark,
	} satisfies Record<ActionResult | "running" | "mark", string>,
	/** 超出上限、只记个数没有明细：「动作」页里只计数的那一行、时间线上的斜线和图例。 */
	countOnly: "只计数",
} as const;

/** 失败的动作在只计数的段里怎么处理：只计数的原因和只看失败时第三组的说明共用这两句。 */
const FAILED_KEPT = "失败的动作仍有明细";
const FAILED_DROPPED = "合计满 10 万个以后，失败的动作也没有明细";

/**
 * 运行监控「动作」页的文字（规格 #345，#358）：工具条、三组的名称、表头里的 Agent 时间、只计数的一行、读屏播报。
 * 和 `NODE_ACTIONS` 分开：这些文字只在「动作」页出现，列名（名称、字段、耗时、结果）写在 `ActionTable` 里。
 */
export const ACTION_PAGE = {
	/** 工具条的可访问名称。 */
	toolbar: `筛选${TERM.action}`,
	byName: "按名称筛选",
	allNames: "全部名称",
	failedOnly: `只看${NODE_ACTIONS.results.failed}`,
	/** 每种名称的个数按钮那一组的可访问名称。 */
	nameCounts: "各名称的个数",
	failedCount: (count: string) => `${NODE_ACTIONS.results.failed} ${count}`,
	/** 表格里的时间显示哪一种（Agent 时间或控制面时间）。 */
	timeKind: "表格里的时间",
	/** 一行总数；有标记时接上「、N 个标记」。 */
	total: (actions: string, marks: string | null) =>
		`共 ${actions} 个${TERM.action}${marks === null ? "" : `、${marks} 个${TERM.mark}`}`,
	/** 读屏播报：筛选之后有多少个。名称的个数里可能有标记，不能说成都是动作（`mixed`）。 */
	result: (count: string, mixed: boolean) =>
		`筛选后 ${count} 个${mixed ? `${TERM.action}和${TERM.mark}` : TERM.action}`,
	cleared: "已清除筛选",
	none: `${MESSAGE_NO_MATCH(TERM.action)}。`,
	/** 表头：开始一列显示的是 Agent 时间时，写明和控制面时间差多少（ADR 0018）。 */
	startAgentTime: "开始（Agent 时间）",
	clockOffset: (note: string) => `时钟偏差：${note}`,
	/** 开始时间那一格的按钮：日志跳到那一刻。 */
	jumpToLog: (time: string) => `在日志里跳到 ${time}`,
	/** 三组的名称：只看失败时，第三组读到的都是失败的动作。 */
	groups: {
		running: NODE_ACTIONS.doing,
		recent: "最近 20 个",
		earlier: "更早的明细",
		earlierFailed: "更早的失败",
	},
	/** 只看失败时第三组的说明：合计满了以后失败的动作也没有明细，没满时都有明细。 */
	earlierFailedNote: (totalFull: boolean) => (totalFull ? FAILED_DROPPED : FAILED_KEPT),
	/** 只计数的段为什么没有明细；名称上限的段在合计也满了以后，失败的动作同样没有明细（`totalFull`）。 */
	countOnlyReason: (reason: CountOnlyPeriod["reason"], totalFull: boolean) => {
		switch (reason) {
			case "name_limit":
				return `每种名称最多记录 5 万个${totalFull ? `；${FAILED_DROPPED}` : `，${FAILED_KEPT}`}`;
			case "total_limit":
				return "全部名称合计最多记录 10 万个";
			case "control_plane":
				return "控制面收到的明细超过上限，超出的已丢弃";
		}
	},
	/** 只计数的一行的开头：控制面时间写起止（`until` 为 null 是至今），Agent 时间只有起点，没有结束的 Agent 时间。 */
	countOnlySpan: (from: string, until: string | null, agent: boolean) =>
		agent ? `${from} 起` : `${from} 至${until === null ? "今" : ` ${until} `}`,
	/** 只计数的一行：只看失败时，这一段里失败的个数不知道；`total` 是这个名称一共失败了多少个（已加千分位）。 */
	failedUnknown: (name: string, total: string | null) =>
		`其中有多少个${NODE_ACTIONS.results.failed}不知道${total === null ? "" : `（「${name}」一共${NODE_ACTIONS.results.failed} ${total} 个）`}`,
} as const;

/** 「执行中节点的主指标」：场景没设关注项时读数区的标题，运行监控的概览和控制台的运行块共用。 */
export const RUNNING_PRIMARY_LABEL = `${NODE_STATUS.running.label}节点的${TERM.primaryMetric}`;

/** 列表的可访问名称：同名的列表在不同页面里共用一个说法。 */
export const LIST_LABEL = {
	legend: "图例",
	chainProgress: "各链进度",
	/** 运行监控的概览里，执行中的节点的列表；列表前的标题只写 `NODE_STATUS.running.label`。 */
	runningNodes: `${NODE_STATUS.running.label}的${TERM.node}`,
	/**
	 * 运行抽屉的摘要、控制台的运行块里，还没结束、正在推进的节点（排队中、准备中、执行中、等待中）的列表，每个节点带自己的状态标签。
	 * 说法不等于任何一个节点状态名；概览只列执行中的节点，用 `runningNodes`。
	 */
	activeNodes: `${ACTIVE_LABEL}的${TERM.node}`,
} as const;

/** 通用的加载 / 错误 / 空状态文字。 */
export const MESSAGE = {
	loading: "加载中",
	loadFailed: (what: string) => `无法加载${what}`,
	noMatch: MESSAGE_NO_MATCH,
	noData: MESSAGE_NO_DATA,
	/** 尝试已经结束，一个点都没有上报。 */
	noDataEnded: "这次尝试没有上报数据",
	/** 没有节点处于执行中：运行监控的概览。 */
	noRunningNodes: `没有${NODE_STATUS.running.label}的${TERM.node}。`,
	/** 概览没设关注项、有节点在执行中，但它们都没有声明主指标，没有读数可显示。 */
	noPrimaryMetric: `${NODE_STATUS.running.label}的${TERM.node}都没有声明${TERM.primaryMetric}。`,
	/** 运行中但没有进行中的节点：运行抽屉的摘要。 */
	noActiveNodes: `没有${ACTIVE_LABEL}的${TERM.node}。`,
	/** 运行监控的详情（图表工作区）和概览：运行的指标已过保留期。 */
	metricsExpired: "这次运行的指标数据已超过保留期，已被清理。",
	/** 运行监控的日志页签和概览的「其他警告与错误」：运行的日志已过保留期。 */
	logsExpired: "这次运行的日志已超过保留期，已被清理。",
	neverRun: "从未运行",
	/** 列表页的空状态标题；控制台「开始使用」每一步右侧的状态写同一句，在哪里都读到同一个说法。 */
	noAgents: "还没有 Agent 连接",
	noPackages: "还没有发布节点包",
	noScenarios: "还没有场景",
	noRuns: "没有运行记录",
	noLogs: "还没有日志。",
	/** 监控页日志页签：任务或运行还没有结束，暂时没有日志。 */
	logOutputPending: "还没有日志输出。",
	/** 监控页日志页签：单个任务的日志写满上限后，控制面丢掉之后的输出。 */
	logTruncated: "日志超过单个任务的大小上限，之后的输出已被截断。",
	archived: "已归档",
	copied: "已复制到剪贴板",
	copyFailed: "复制失败",
	clipboardDenied: "浏览器不允许访问剪贴板",
} as const;

/**
 * 一次尝试没有数据时写什么：还没有开始执行写节点这个状态没有执行的原因（`NODE_STATUS` 的 `notRun`），已经开始还没有点写
 * 「还没有数据」，已经结束仍没有点写「这次尝试没有上报数据」。运行监控的概览（关注项读数）和详情（图表工作区）共用。
 */
export function noDataLabel(
	attempt: { started_at: string | null; ended_at: string | null },
	status: NodeStatus,
): string {
	if (attempt.started_at === null) return notRunNote(status);
	return attempt.ended_at === null ? MESSAGE.noData : MESSAGE.noDataEnded;
}

/**
 * 链和子流程的显示名称：画布、检查器、运行视图和运行通知的卡片共用（@sfly/orchestration 的 chain-label）。
 * `chainLabel` 是「主链」或「子流程 <名称>」，给出实例 ID 时带上实例短 ID（只有子流程名称时用 `namedChainLabel`）；`subflowLabel` 是子流程的显示名称，
 * 没有名称字段的旧版本显示节点 ID，填了空名称时显示「未命名子流程」。
 */
export { chainLabel, namedChainLabel, subflowLabel } from "@sfly/orchestration";
