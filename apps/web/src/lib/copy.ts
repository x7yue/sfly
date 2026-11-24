import { type ArrangeMode, MAIN_CHAIN_LABEL, SUBFLOW_LABEL } from "@sfly/orchestration";
import {
	ACTION_LIMITS,
	type ActionResult,
	type AnnotationColor,
	type ChartView,
	type CountOnlyPeriod,
	focusChartMissing,
	type LogLineView,
	type NodeStatus,
	type RunNotificationState,
	type RunStatus,
	SCOPE_LABELS,
	type Scope,
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

/** 图表类型：节点包管理页「声明的图表」、场景设置「关注项」页每一项的类型共用。 */
export const CHART_TYPE_LABEL = {
	line: "折线",
	area: "面积",
	bar: "柱状",
	stat: "数值卡",
} as const satisfies Record<ChartView["type"], string>;

/** 节点用 `ctx.progress` 上报的进度：监控的图表工作区、时间线、运行抽屉、画布检查器共用（运行记录表里「进度」是各链进度，不是它）。 */
export const PROGRESS_LABEL = "进度";

/**
 * 节点失败时出错的位置（`error.location`，「模块.函数 第 N 行」）的标签，定义在 `@sfly/schema`（运行通知的卡片也用它）：
 * 画布检查器、运行监控的节点信息和概览的失败区域里，写在失败原因下面。一行摘要的地方（页头、「需要注意」、关注项、控制台「最近结束」）不写。
 */
export { ERROR_LOCATION_LABEL } from "@sfly/schema";

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
	/** 名额里注明其中有几项已经失效（失效的项也占名额）。「失效」不是「无新数据」（`stale`）。 */
	invalidNote: (invalid: number) => `（含 ${invalid} 项已失效的）`,
	/** 关注项失效的一种原因：节点包的这个版本没有声明这张图表。句子来自 `@sfly/schema` 的 `focusChartMissing`。 */
	chartMissing: focusChartMissing,
	/** 关注项不属于场景版本：节点检查器的图表列表和「关注项」页都要说明这一点。 */
	notVersioned: `${TERM.focusItem}属于${INSPECTOR_PAGE.sceneSettings}，不属于场景版本：改动立即生效，不产生新版本。`,
	/** 有异常的关注项的统称：概览里列出它们的那一段的标题，读数和图表的可访问名称里异常原因的前缀。 */
	attention: "需要注意",
	/** 「3 个关注项」：画布节点卡片的可访问名称。 */
	itemCount: (count: number) => `${count} 个${TERM.focusItem}`,
	/** 「1 项需要注意」：控制台运行块的读数区标题旁、画布节点卡片和 Agent 槽位格的可访问名称、画布检查器里关注项的标题旁。 */
	attentionCount: (count: number): string => `${count} 项${FOCUS.attention}`,
	/** 只放得下前几项时，其余的个数（`moreLabel` 加上「关注项」）：控制台运行块读数区的最后一格、画布节点卡片和 Agent 槽位格的最后一行。 */
	moreItems: (count: number): string => `${moreLabel(count)}${TERM.focusItem}`,
	/** 场景没设关注项时，控制台运行块读数区的最后一格：放不下的是主指标，不是关注项。 */
	morePrimary: (count: number): string => `${moreLabel(count)}${TERM.primaryMetric}`,
	/** 场景设了关注项，但它们所在的节点都不在这次运行的版本里：概览和控制台运行块的读数区共用。 */
	noneInRun: `这次运行里没有可显示的${TERM.focusItem}：场景设置的${TERM.focusItem}所在的节点不在这次运行的版本里。`,
	/** 场景没有设置关注项，显示的是执行中节点的主指标：概览的标题旁、控制台运行块的读数区标题旁和 Agent 槽位格里的主指标共用这一句。 */
	noneSet: `场景没有设置${TERM.focusItem}`,
	/** 运行已经结束、场景没设关注项：概览里这一栏只写这一句（主指标是执行中节点的，结束后不会再有读数）。 */
	endedNoneSet: `运行结束后不再显示执行中节点的${TERM.primaryMetric}。设置${TERM.focusItem}后，这里会显示它们的最终值。`,
	/** 「关注项」页每一项名称输入框的可访问名称：「名称（子单接口（fetch2） · errors）」，写明是哪个节点的哪张图表。 */
	nameField: (node: string, chart: string) => `名称（${node} · ${chart}）`,
	/**
	 * 去场景设置的「关注项」页的入口：设了关注项是「调整关注项」，没设是「设置关注项」；读数读取失败、不知道设没设时
	 * （`null`）只说去哪里。
	 */
	settingsLink: (configured: boolean | null): string =>
		configured === null
			? `打开${INSPECTOR_PAGE.sceneSettings}的「${INSPECTOR_PAGE.focus}」页`
			: `${configured ? "调整" : "设置"}${TERM.focusItem}`,
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
	/**
	 * 「1 条 WARN · 10:58:41」：`count` 是这次尝试的 WARN 和 ERROR 合计，`level` 只是最近一条的级别，所以多于一条时
	 * 写「3 条 WARN / ERROR」，不把合计都说成最近一条的级别。时间是最近一条的。
	 */
	logReason: (count: number, level: string, clock: string) =>
		`${count} 条 ${count === 1 ? level : LOG_ALERT_LEVELS} · ${clock}`,
	staleFor: (ago: string) => `已 ${ago} 无新数据`,
	sourceFailed: "来源节点失败",
	retryReason: (attempt: number, clock: string) => `重试（${attemptLabel(attempt)}）· ${clock}`,
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
		`${node} 在 ${clock} 开始重试（${attemptLabel(attempt)}）${message ? `，上一次${TERM.attempt}失败：${message}` : "。"}`,
	/**
	 * 概览「需要注意」每行右侧直达按钮的文字：同一页里切到「详情」去看（`viewInLabel`）：WARN / ERROR 看那一行日志，
	 * 没有新数据看那个节点的日志，失败和重试看它的尝试。
	 */
	viewLogLine: (level: string) => viewInLabel(MONITOR_VIEW_LABEL.detail, `${level} 那一行`),
	viewNodeLogs: (node: string) => viewInLabel(MONITOR_VIEW_LABEL.detail, `${node} 的日志`),
	viewNodeAttempts: (node: string) =>
		viewInLabel(MONITOR_VIEW_LABEL.detail, `${node} 的${TERM.attempt}`),
	/** 概览最后一段列不下的 WARN / ERROR：其余在「详情」的日志里。 */
	otherAlertsRest: (shown: number) =>
		`最近 ${shown} 条，其余在${MONITOR_VIEW_LABEL.detail}的日志里查看`,
	/** 运行监控页头：概览的关注项读数是什么时候生成的（控制面时间）。 */
	dataUpdated: (clock: string) => `数据更新于 ${clock}`,
} as const;

/**
 * 运行监控概览里的失败区域：第一个失败的节点、第几次尝试和失败原因（`errorHeadline`，最多 4 行，更长的收起），一步去它的尝试和日志；
 * 运行还没结束、已有节点失败时也有。直达按钮的写法和「需要注意」里的相同（{@link FOCUS}）。
 */
export const FAILURE_AREA = {
	/** 标题按运行的状态：失败的运行；还在进行的运行里已有节点失败；取消的运行里也有节点失败。 */
	title: {
		failed: "运行失败",
		running: `有${TERM.node}失败，${TERM.run}还在进行`,
		ended: `有${TERM.node}失败`,
	},
	failedAt: (clock: string) => `${clock} 失败`,
	/** 展开错误信息全文（含堆栈，失败原因那一行太长被收起时也是它）的按钮：展开后写「收起全文」（和时间线的开关一样，读屏不读成「展开全文，已展开」）。 */
	fullMessage: (expanded: boolean) => `${expanded ? ACTION.collapse : ACTION.expand}全文`,
	/** 另有几个节点也失败了：节点名在后面列出。 */
	others: (count: number) => `另有 ${count} 个${TERM.node}也失败了`,
	viewAttempts: (node: string) => FOCUS.viewNodeAttempts(node),
	viewLogs: (node: string) => FOCUS.viewNodeLogs(node),
} as const;

/** 注释框各字段的名称：检查器的字段错误和版本对比共用。 */
export const ANNOTATION_FIELD_LABEL: Readonly<Record<string, string>> = {
	title: "标题",
	note: TERM.note,
	color: "颜色",
	nodes: "成员节点",
	subflows: "成员子流程",
};

/** 注释框颜色的名称：颜色选择器色块下面的字、版本对比里的写法（ADR 0025）。 */
export const ANNOTATION_COLOR_LABEL: Record<AnnotationColor, string> = {
	gray: "灰",
	blue: "蓝",
	green: "绿",
	yellow: "黄",
	orange: "橙",
	pink: "粉",
};

/** 排列所选节点的三种方式：多选的浮动工具条和多选的节点菜单共用。 */
export const ARRANGE_LABEL: Record<ArrangeMode, string> = {
	grid: "宫格排列",
	row: "横向排列",
	column: "纵向排列",
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
	tokens: "令牌",
	projectTokens: "项目令牌",
	editor: "编排画布",
	monitor: "运行监控",
	versions: "版本历史",
	docs: "开发文档",
	assistant: "助手",
	session: "会话",
} as const;

/**
 * 助手页和会话页（#542，GLOSSARY「助手」「会话」「一轮」「工作台」「助手服务」）。页面只认平台的会话事件，
 * 文字里不出现底层的名字。
 */
export const SESSION = {
	/** 助手页顶部的就绪一行：就绪时写工作台在线；不就绪时逐条写缺什么（原因来自就绪状态的 `problems`）。 */
	ready: (workbench: string | null) =>
		workbench === null ? "可以用" : `可以用 · 工作台 ${workbench} 在线`,
	notReady: "现在不能用：",
	workbenchOffline: (workbench: string) => `工作台 ${workbench} 不在线`,
	input: {
		label: "要做什么？",
		placeholder: "要做什么？例如：给 http_check 加一个超时参数",
		start: "开始",
		starting: "正在开始…",
	},
	list: {
		heading: "会话",
		label: "会话列表",
		empty: "在上面说一句话，助手就会开始。",
		emptyTitle: "还没有会话",
		loadFailed: "无法加载会话",
		title: "会话",
		author: "发起人",
		status: "状态",
		activity: "最近活动",
		/** 会话多于接口一次给的个数（`truncated`）时，列表上面的一句提示。 */
		truncated: (limit: number) => `只显示了最近活动的 ${limit} 个会话`,
		/** 排队中的会话（和停止途中说了话、排在这一轮后面的在做的会话）在状态后面写排第几。 */
		queuePosition: (position: number) => `排在第 ${position} 位`,
	},
	status: {
		idle: "空闲",
		running: "在做",
		queued: "排队中",
		ended: "已结束",
	},
	/** 新建会话失败。 */
	createFailed: "无法开始会话",
	/** 会话页。 */
	page: {
		loadFailed: "无法加载这个会话",
		timeline: "会话的时间线",
		loadOlder: "加载更早的",
		loadingOlder: "正在加载…",
		loadOlderFailed: "无法加载更早的内容",
		stop: "停止",
		stopTitle: "停止这一轮",
		/** 排队中点「停止」是移出队列。 */
		stopQueuedTitle: "移出队列：这句话不会交给助手",
		stopping: "正在停止…",
		/** 停止途中说了话、排在这一轮后面时，停止按钮的字：再点一次是撤掉那句话。 */
		cancelBehind: "撤掉排着的话",
		cancelBehindTitle: "撤掉排在这一轮后面的话，不开始新的一轮",
		stopFailed: "无法停止这一轮",
		thinking: "思考中",
		sendLabel: "接着说",
		sendPlaceholder: "接着说",
		send: "发送",
		sending: "正在发送…",
		/** 在做时输入框发出去的是插话。 */
		steerLabel: "插话",
		steerPlaceholder: "插话：助手在当前这一步做完后会看到",
		sendSteer: "发送插话",
		steerHint: "插话在当前这一步做完后送到；要马上停下用停止",
		/** 排队中：排在第几位、在等谁（会话的标题和发起人是别人写的文字）。 */
		queuedBefore: (position: number) => `排在第 ${position} 位：`,
		queuedWaitingFor: (author: string) => `（${author}）正在做`,
		queuedNobody: "等助手空出来",
		queuedOpen: "打开它",
		/** 停止途中说了话：这句话排在这一轮后面。 */
		behind: (position: number | null) =>
			position === null
				? "这一轮正在停止，你说的话排在它后面；再点一次停止，撤掉它"
				: `这一轮正在停止，你说的话排在第 ${position} 位；再点一次停止，撤掉它`,
		sendFailed: "无法发送",
		turnRunning: "助手正在做这一轮；要改方向先停止",
		sessionQueued: "这个会话在排队，等它开始之后再说，或者先停止",
		sessionEnded: "这个会话已经结束或者正在结束，不能再说话",
		ended: "这个会话已经结束，不能再说话",
		ending: "正在结束这个会话…",
		/** 会话被删了（新建会话等第一轮结局期间点了停止，没有被碰过的会话会被删掉）：回到列表。 */
		gone: "这个会话已经没有了",
		end: "结束会话",
		endTitle: "结束这个会话：之后不能再说话",
		endDialogTitle: "结束这个会话？",
		endDialogBody:
			"在做的一轮会停下，排着的话会撤掉；结束之后不能再说话。工作区、提交、场景版本和运行都留着，不删除任何东西。",
		endCancel: "取消",
		endConfirm: "结束会话",
		ending2: "正在结束…",
		endFailed: "无法结束会话",
	},
	/** 时间线上的话的标记。 */
	message: {
		steer: "插话",
		behind: "排在这一轮后面",
		cancelled: "已撤掉",
		waiting: "等待送达",
		delivered: "已送到",
		dropped: "没有送到",
	},
	/** 会话已结束的一行：「会话已结束（<谁>）」，谁是别人写的昵称，夹在两段文案中间。 */
	sessionEnded: { prefix: "会话已结束（", suffix: "）" },
	tool: {
		read: "读",
		write: "写",
		edit: "改",
		command: "$",
		unknown: "工具",
		running: "在做",
		/** 一轮已经有了结局、这个调用却一直没有结果（被停止、到了上限、中断）。 */
		abandoned: "已中止",
		failed: "出错",
		exitCode: (code: number) => `退出码 ${code}`,
		duration: (text: string) => `用时 ${text}`,
		truncated: "输出太长，只显示了头尾",
		noOutput: "（没有输出）",
		expand: "展开",
		collapse: "收起",
	},
	turnEnd: {
		completed: "这一轮完成",
		steps: (n: number) => `${n} 步`,
		duration: (text: string) => `用时 ${text}`,
		stopped: "已停止",
		limit: (what: string) => `到了上限：${what}`,
		modelCalls: (n: number | undefined) => (n === undefined ? "模型调用次数" : `${n} 次模型调用`),
		limitDuration: (text: string) => `用时 ${text}`,
		interrupted: (reason: string) => `中断：${reason}`,
		modelUnavailable: (reason: string) => `模型不可用：${reason}`,
		failed: (reason: string) => `出错：${reason}`,
	},
} as const;

/**
 * 令牌页（ADR 0029「凭据」，术语见 GLOSSARY「令牌」）。范围的中文名在契约里（`SCOPE_LABELS`），这里是每个范围一句话的说明：
 * 签发时让人知道勾了它能做什么，写法和 ADR 0029 的范围表一致。
 */
export const TOKEN_SCOPE_HELP = {
	read: "查看项目里的一切",
	run: "触发、取消运行",
	edit: "编辑场景、版本和场景设置",
	session_build: "登记会话构建",
	publish: "发布节点包的正式版本",
	manage: "管理成员、令牌、Agent 和飞书机器人",
} as const satisfies Record<Scope, string>;

export const TOKEN_STATE_LABEL = {
	active: "有效",
	expired: "已过期",
	revoked: "已吊销",
} as const;

/** 签发令牌时的有效期选项：天数（null 是不过期）和文字。控制台默认 90 天：长期有效的令牌要人明确选。 */
export const TOKEN_EXPIRY_OPTIONS = [
	{ value: "30", days: 30, label: "30 天" },
	{ value: "90", days: 90, label: "90 天" },
	{ value: "365", days: 365, label: "1 年" },
	{ value: "never", days: null, label: "不过期" },
] as const;
export const TOKEN_DEFAULT_EXPIRY = "90";

/** 列表里范围的写法：「读、运行、编辑」。 */
export const scopesText = (scopes: readonly string[]): string =>
	scopes.map((scope) => SCOPE_LABELS[scope as Scope] ?? scope).join("、");

/** 开发文档里被界面引用的页：slug → 页名（docs/guide/pages.json 里的标题，有单测对着它检查）。 */
export const DOC_PAGE = {
	quickstart: "快速开始",
	"install-agent": "安装 Agent",
	publish: "发布",
	"sdk-reference": "开发节点（SDK 参考）",
	"feishu-notify": "飞书通知",
} as const;
export type DocPage = keyof typeof DOC_PAGE;

/** 运行与链实例的状态。 */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
	running: "运行中",
	success: "成功",
	failed: "失败",
	cancelled: "已取消",
};

/**
 * 飞书消息的投递结果（GLOSSARY「投递」）：机器人管理页的「最近投递」和运行抽屉里的运行通知都用这两个词，
 * 失败写「投递失败」，不用「发送失败」。
 */
export const DELIVERY = {
	delivered: "已送达",
	failed: "投递失败",
} as const;

/** 运行通知的状态文字（运行抽屉里的一行）。 */
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
	openInCanvas: "在画布中打开",
	openRuns: "打开运行记录",
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

/** 运行监控页两个视图的名称：页头的标签页，和概览里「在详情里查看」的说法共用。 */
export const MONITOR_VIEW_LABEL = { overview: "概览", detail: "详情" } as const;

/** 「运行监控详情」：运行监控页之外的地方（画布运行状态的检查器）指向运行监控的「详情」视图时这样写。 */
export const MONITOR_DETAIL_LABEL = `${PAGE.monitor}${MONITOR_VIEW_LABEL.detail}`;

/**
 * 图例里放不下的序列（「还有 N 条序列」，和 {@link moreLabel} 同一个说法）：概览里是同一页切到「详情」视图，写「在详情里查看」；
 * 检查器在运行监控之外，要去另一个页面，写「打开运行监控详情」。
 */
export const hiddenSeriesLabel = {
	inView: (count: number) => `还有 ${count} 条序列在${MONITOR_VIEW_LABEL.detail}里查看`,
	openPage: (count: number) => `还有 ${count} 条序列，打开${MONITOR_DETAIL_LABEL}`,
};

/** 检查器的图表列表里说明图表不能缩放，要缩放得去运行监控的详情。 */
export const ZOOM_IN_DETAIL_LABEL = `要缩放，打开${MONITOR_DETAIL_LABEL}`;

/** 「在运行监控详情里打开 fetch」：去另一个页面里看这个节点的按钮或链接（同一页里切视图用 {@link viewInLabel}）。 */
export const openInLabel = (place: string, node: string) => `在${place}里打开 ${node}`;

/** 「在详情里查看 fetch」「在日志里查看 10:00:01」：同一页里切到另一个视图或页签去看某样东西（去另一个页面用 {@link openInLabel}）。 */
export const viewInLabel = (place: string, what: string) => `在${place}里查看 ${what}`;

/** 关注项读数里来源节点成功、已停止或已取消后的「最终值」：读数的脚注和可访问名称共用。 */
export const FINAL_VALUE_LABEL = "最终值";

/** 「2 条链 · 7 个节点」：运行监控的链路时间线和概览的链路共用。 */
export const chainCountLabel = (chains: number, nodes: number) =>
	`${chains} 条链 · ${nodes} 个节点`;

/** 运行开始到现在的时长（运行中）和开始到结束的时长（已结束）：控制台、运行监控页顶栏、运行记录的卡片共用。 */
export const ELAPSED_LABEL = "已运行";
export const DURATION_LABEL = "耗时";

/**
 * 「2 / 8 占用」「排队 1」：一台 Agent 的槽位占用和排队的任务数（Agent 管理页的机架、控制台的 Agent 列）。
 * `QUEUED_LABEL` 是「排队」这个词本身：控制台页头的计数（数字另着色）和排队任务的一行时间说明也用它。
 */
export const slotUsageLabel = (used: number, slots: number) => `${used} / ${slots} 占用`;
export const QUEUED_LABEL = "排队";
export const queuedLabel = (count: number) => `${QUEUED_LABEL} ${count}`;

/**
 * 排队中的节点在等什么（运行视图里排队中的尝试的 `queue_wait`）：「等 agent-a（不在线，已离线 2m 10s）· 排队 3m 05s · 6m 55s 后超时」。
 * 括号里是这台 Agent 现在的情况；槽位占满时再列出占着槽位的任务。后面的「排队 …」「… 后超时」「即将超时」是
 * Agent 管理页排队行的写法（`agents/queue-timing.ts`）。命令行写同样的话（`sfly run show`、`sfly run start --wait`，
 * 用词由 `sdk/python/tests/test_cli_run_view.py` 检查）。
 */
export const QUEUE_WAIT = {
	waitingFor: "等",
	offline: (since: string | null) => (since === null ? "不在线" : `不在线，已离线 ${since}`),
	preparing: (since: string | null) => (since === null ? "准备环境中" : `准备环境中 ${since}`),
	versionMismatch: "版本与控制面不一致，不派新任务",
	slotsFull: (slots: number) => `槽位占满，${slots} / ${slots}`,
	dispatching: "正在派发",
	holders: "占着槽位的任务",
	/** 占着槽位的任务写明是哪次运行：「准备环境场景（运行 5e2d1c7a）的 准备环境（a）」，同一场景触发两次互相抢槽位时分得开。 */
	holderRun: (shortId: string) => `运行 ${shortId}`,
	/** 同一台 Agent 上别的项目的任务占着槽位：只有个数，看不到别的项目的场景和运行。 */
	otherProjects: (count: number, afterOwn: boolean) =>
		`${afterOwn ? "另有" : ""}别的项目的任务 ${count} 个`,
	/**
	 * 没设关注项、没有节点在 Agent 上执行、排队的节点还在等：概览的主指标一栏不写「没有执行中的节点」，写它们都在排队。
	 * 在等什么上面「进行中」那一行已经写了，这里不再写一遍（同一屏上同一件事只说一次）。
	 */
	allQueued: "节点都在排队，还没有开始执行：",
} as const;

/**
 * 线路里当前站之前折起来的一段：都算完成的写「已完成 3 个」，不算完成的（取消的运行里已取消的节点、失败之后被跳过的节点）
 * 写它们的状态，「已取消 4 个」「已跳过 6 个」。之后的一段是 {@link moreLabel}。
 */
export const FOLDED_LABEL = {
	done: (count: number) => `已完成 ${count} 个`,
	ended: (status: string, count: number) => `${status} ${count} 个`,
} as const;

/**
 * 「跳过 2」：一条链上被跳过的节点单独计数，接在「已完成数 / 节点数」后面（线路的计数、各链进度条的读屏名称）：
 * 被跳过的节点没有执行，不算进已完成。
 */
export const skippedCountLabel = (count: number) => `跳过 ${count}`;

/** 「还有 3 个」：列表或线路只画出前面一部分时，其余的个数（控制台的线路和进行中的节点、运行记录的卡片）。 */
export const moreLabel = (count: number) => `还有 ${count} 个`;

/**
 * 「进行中」：还没结束的统称，不等于任何一个状态名。运行抽屉的摘要里是还没结束、正在推进的节点（排队中、准备中、
 * 执行中、等待中）合起来的名称：抽屉里排队中、等待中的节点也在这个列表里，标题不能写成其中一个状态。控制台运行块
 * 和运行监控概览的链路里那一行同理。运行监控「动作」页签的结果里是还没结束的动作（`NODE_ACTIONS.results.running`）。
 */
export const ACTIVE_LABEL = "进行中";

const COUNT_ONLY = "只计数";

/**
 * 动作与标记（GLOSSARY「动作」「标记」，规格 #345）：画布、检查器、概览、运行监控里写动作的地方共用的文字。
 * 和 `ACTION`（界面上的通用操作）不是一回事。
 */
export const NODE_ACTIONS = {
	/** 此刻在做的事：画布卡片和读屏的「正在做 X」，检查器的「正在做」，「动作」页签的第一组。 */
	doing: "正在做",
	/** 版面放得下时写在动作名称前的「正在」（Agent 槽位格、概览执行中那一行）；画布卡片只有 208px 宽，用执行中的形状代替它。 */
	doingNow: "正在",
	/** 正在做的动作列满了：接口只给前 50 个，可能还有没列出的（检查器的「正在做」、「动作」页签的第一组共用）。 */
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
	/** 超出上限、只记个数没有明细：「动作」页签里只计数的那一行、时间线上的斜纹和图例。 */
	countOnly: COUNT_ONLY,
	/** 「只计数、没有明细」：「动作」页签里只计数的那一行和检查器的上限说明用同一个标点。 */
	countOnlyNoDetail: `${COUNT_ONLY}、没有明细`,
	/**
	 * 检查器的上限说明末尾：摘要里只写控制面有没有另外丢弃过明细（`control_plane_capped`，只有它为 true 时也显示上限说明），
	 * 丢弃了哪些名称要到「动作」页签的只计数的行里看（`ACTION_PAGE.countOnlyReason` 的 `control_plane`）。写成「超过上限时」，
	 * 没有丢弃过时同样是实话。
	 */
	controlPlaneDropped: `控制面收到的明细超过上限时，超出的会丢弃；丢弃了哪些名称，到${MONITOR_DETAIL_LABEL}的「动作」页签里看。`,
} as const;

/** 动作的数量上限写成「10 万」这样（都是整万）。 */
const tenThousands = (count: number) => `${count / 10_000} 万`;

/** 失败的动作在只计数的段里怎么处理：只计数的原因和只看失败时第三组的说明共用这几句。 */
const FAILED_KEPT = "失败的动作仍有明细";
const FAILED_DROPPED = `合计满 ${tenThousands(ACTION_LIMITS.total)}个以后，失败的动作也没有明细`;
/** 控制面丢弃的明细里，失败的动作也没有（开始时还不知道会不会失败）。 */
const FAILED_KEPT_EXCEPT_DROPPED = `${FAILED_KEPT}，控制面丢弃的除外`;

/**
 * 运行监控「动作」页签的文字（规格 #345，#358）：工具条、三组的名称、表头里的 Agent 时间、只计数的一行、读屏播报。
 * 和 `NODE_ACTIONS` 分开：这些文字只在「动作」页签出现，列名（名称、字段、结果）写在 `ActionTable` 里。
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
	/** 开始时间那一格的按钮：切到「日志」页签，定位到那一刻。 */
	jumpToLog: (time: string) => viewInLabel("日志", time),
	/** 三组的名称：只看失败时，第三组读到的都是失败的动作。 */
	groups: {
		running: NODE_ACTIONS.doing,
		recent: `最近 ${ACTION_LIMITS.recent} 个`,
		earlier: "更早的明细",
		earlierFailed: "更早的失败",
	},
	/**
	 * 只看失败时第三组的说明：合计满了以后失败的动作也没有明细；没满时有明细，控制面丢弃的除外。
	 * `controlPlane`：已经读到控制面丢弃的段，或者更早的页还没读完、不知道有没有；确定没有时不写「除外」。
	 * 合计满了的那句不管有没有控制面丢弃都是实话，所以不分。
	 */
	earlierFailedNote: (totalFull: boolean, controlPlane: boolean) =>
		totalFull ? FAILED_DROPPED : controlPlane ? FAILED_KEPT_EXCEPT_DROPPED : FAILED_KEPT,
	/** 「最近 20 个」那一组的说明：摘要里的最近 20 个不受明细上限影响（SDK 的、控制面的都一样）。 */
	recentKeepsUpdating: "超过上限后也一直更新",
	/** 只计数的段为什么没有明细；名称上限的段在合计也满了以后，失败的动作同样没有明细（`totalFull`）。 */
	countOnlyReason: (reason: CountOnlyPeriod["reason"], totalFull: boolean) => {
		switch (reason) {
			case "name_limit":
				return `每种名称最多记录 ${tenThousands(ACTION_LIMITS.perName)}个${totalFull ? `；${FAILED_DROPPED}` : `，${FAILED_KEPT}`}`;
			case "total_limit":
				return `全部名称合计最多记录 ${tenThousands(ACTION_LIMITS.total)}个`;
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
	/**
	 * 运行抽屉的摘要、控制台的运行块和运行监控概览的链路里，还没结束、正在推进的节点（排队中、准备中、执行中、等待中）的列表，
	 * 每个节点带自己的状态。说法不等于任何一个节点状态名。
	 */
	activeNodes: `${ACTIVE_LABEL}的${TERM.node}`,
} as const;

/** 通用的加载 / 错误 / 空状态文字。 */
export const MESSAGE = {
	loading: "加载中",
	/** 「无法加载日志」「无法加载 Agent 列表」：名称以字母或数字开头时和前面的汉字隔一个空格。 */
	loadFailed: (what: string) => `无法加载${/^[A-Za-z0-9]/.test(what) ? " " : ""}${what}`,
	noMatch: MESSAGE_NO_MATCH,
	noData: MESSAGE_NO_DATA,
	/** 运行监控详情的图表：缩放到的时间段里没有点。 */
	noDataInRange: "所选时间段内无数据",
	/** 尝试已经结束，一个点都没有上报。 */
	noDataEnded: "这次尝试没有上报数据",
	/** 没有节点处于执行中：运行监控的概览。 */
	noRunningNodes: `没有${NODE_STATUS.running.label}的${TERM.node}。`,
	/** 概览没设关注项、有节点在执行中，但它们都没有声明主指标，没有读数可显示。 */
	noPrimaryMetric: `${NODE_STATUS.running.label}的${TERM.node}都没有声明${TERM.primaryMetric}。`,
	/** 运行中但没有进行中的节点：运行抽屉的摘要。 */
	noActiveNodes: `没有${ACTIVE_LABEL}的${TERM.node}。`,
	/** secret 参数的值太多的运行（`RunView.secrets_oversize`）：为什么这次运行里看到的内容全是掩码（#657）。运行抽屉的摘要和运行监控页都写它。不含任何值。 */
	secretsOversize:
		"这次运行的 secret 参数的值太多或太长，控制面认不出每一处出现，这次运行里日志、动作、输入输出、错误信息的内容整段显示为 ******。缩短或减少 secret 参数的值之后重新运行。",
	/** 运行监控的详情（图表工作区）和概览：运行的指标已过保留期。 */
	metricsExpired: "这次运行的指标数据已超过保留期，已被清理。",
	/** 运行监控的日志页签和概览的「其他警告与错误」：运行的日志已过保留期。 */
	logsExpired: "这次运行的日志已超过保留期，已被清理。",
	neverRun: "从未运行",
	/** 列表页的空状态标题；控制台「开始使用」每一步右侧的状态写同一句，在哪里都读到同一个说法。 */
	noAgents: "还没有 Agent 连接",
	noPackages: "还没有发布节点包",
	noScenarios: "还没有场景",
	/** 控制台的场景列没有可列的场景：还没有新建过，或者都已归档（列表不含归档的）。两种情况下这句都是实话。 */
	noScenariosListed: `没有${TERM.scenario}`,
	/** 控制台的 Agent 列没有 Agent 时，去 Agent 管理页的链接：那里的空状态写着安装命令。 */
	agentInstallLink: `打开 ${PAGE.agents}查看安装命令`,
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
 * 运行已经结束、节点一直是待执行（没有轮到它，或者所在的子流程没有触发）：它不会再执行了，不能再写「待执行」
 * 「还没有开始执行」。状态写 `label`（和画布运行状态的「未执行」同一个词），没有数据的原因写 `note`。
 */
export const NOT_RUN_IN_ENDED_RUN = {
	label: "未执行",
	note: "这次运行没有执行",
	/** 画布运行状态的检查器：选中的节点所在的子流程没有触发，运行中写「还没有」，运行结束后不再说「还」。 */
	subflowNote: (runEnded: boolean) =>
		`这个节点所在的子流程在这次运行里${runEnded ? "" : "还"}没有触发，没有运行记录。`,
} as const;

/**
 * 一次尝试没有数据时写什么：还没有开始执行写节点这个状态没有执行的原因（`NODE_STATUS` 的 `notRun`；运行已经结束
 * 还是待执行的写 {@link NOT_RUN_IN_ENDED_RUN}），已经开始还没有点写「还没有数据」，已经结束仍没有点写
 * 「这次尝试没有上报数据」。运行监控的概览（关注项读数）和详情（图表工作区）共用。
 */
export function noDataLabel(
	attempt: { started_at: string | null; ended_at: string | null },
	status: NodeStatus,
	runEnded = false,
): string {
	if (attempt.started_at === null) {
		return runEnded && status === "pending" ? NOT_RUN_IN_ENDED_RUN.note : notRunNote(status);
	}
	return attempt.ended_at === null ? MESSAGE.noData : MESSAGE.noDataEnded;
}

/** 关注项来源节点的状态文字：运行已经结束、节点还是待执行时写「未执行」（{@link NOT_RUN_IN_ENDED_RUN}）。 */
export const focusSourceStatus = (status: NodeStatus, runEnded: boolean): string =>
	runEnded && status === "pending" ? NOT_RUN_IN_ENDED_RUN.label : NODE_STATUS[status].label;

/**
 * 链和子流程的显示名称：画布、检查器、运行视图和运行通知的卡片共用（@sfly/orchestration 的 chain-label）。
 * `chainLabel` 是「主链」或「子流程 <名称>」，给出实例 ID 时带上实例短 ID（只有子流程名称时用 `namedChainLabel`）；`subflowLabel` 是子流程的显示名称，
 * 没有名称字段的旧版本显示节点 ID，填了空名称时显示「未命名子流程」。
 */
export { chainLabel, namedChainLabel, subflowLabel } from "@sfly/orchestration";
