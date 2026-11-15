import { MAIN_CHAIN_LABEL, SUBFLOW_LABEL } from "@sfly/orchestration";
import type { CountOnlySpan, RunNotificationState, RunStatus } from "@sfly/schema";
import type { ActionGroupName, ActionOutcome } from "#/actions/action-table";

/**
 * 界面文案（故事 79：文案集中管理，不引入 i18n 框架；规则见 docs/DESIGN-SYSTEM.md「文案」一节）。
 *
 * 这里放多处共用的文字：术语（GLOSSARY.md）、状态文字、导航与页面名、通用操作、通用的加载 / 错误 / 空状态。
 * 页面一次性的说明文字留在组件里；新的共用文字先加到这里再引用，不要在组件里另写一份。
 */

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
	displayName: "显示名称",
	note: "备注",
	annotation: "注释框",
	focusItem: "关注项",
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

/** 关注项（GLOSSARY「关注项」）：节点检查器的名额、场景设置的「关注项」页和图表列表共用的文字。 */
export const FOCUS = {
	/** 名额里注明其中有几项已经失效（失效的项也占名额）。 */
	staleNote: (stale: number) => `（含 ${stale} 项已失效的）`,
	/** 关注项失效的一种原因：节点包的这个版本没有声明这张图表（规格 #344 的写法，别处写这句都引用它）。 */
	chartMissing: (chart: string) => `这个版本的节点没有图表 ${chart}`,
	/** 关注项不属于场景版本：节点检查器的图表列表和「关注项」页都要说明这一点。 */
	notVersioned: `${TERM.focusItem}属于${INSPECTOR_PAGE.sceneSettings}，不属于场景版本：改动立即生效，不产生新版本。`,
} as const;

const DOING = "正在做";

/**
 * 动作与标记（GLOSSARY「动作」「标记」，规格 #345）：运行监控「动作」页，以及画布、检查器、概览里写动作的地方共用的文字。
 * 和 `ACTION`（界面上的通用操作）不是一回事。
 */
export const NODE_ACTIONS = {
	/** 此刻在做的事：「动作」页的第一组、读屏读到的「正在做 X」。 */
	doing: DOING,
	/** 「动作」页签的可访问名称，`count` 是写好的个数（标记不算）。 */
	tabLabel: (count: string) => `${TERM.action}，共 ${count} 个`,
	groups: {
		running: DOING,
		recent: "最近 20 个",
		earlier: "更早的明细",
	} satisfies Record<ActionGroupName, string>,
	/** 「正在做」列满 50 个（`running_complete` 为 false）时写在组名后面。 */
	runningIncomplete: "列满 50 个，可能还有没列出的",
	/** 超过上限、有动作只计数时写在「最近 20 个」后面。 */
	recentWhenCapped: "超过上限后也一直更新",
	columns: { start: "开始", name: "名称", fields: "字段", duration: "耗时", result: "结果" },
	results: {
		running: "进行中",
		success: "成功",
		failed: "失败",
		unfinished: "未结束",
		mark: TERM.mark,
	} satisfies Record<ActionOutcome["status"] | "mark", string>,
	/** 只计数的段为什么没有明细（`CountOnlySpan.reason`）。 */
	countOnlyReason: {
		name_limit: "每种名称最多记录 5 万个，失败的动作仍有明细",
		total_limit: "全部名称合计最多记录 10 万个",
		control_plane: "控制面收到的明细超过上限，超出的已丢弃",
	} satisfies Record<CountOnlySpan["reason"], string>,
	/** 只计数的一段：「09:19:12 至今的 1,234,794 个「下单」只计数，没有明细（…）」，时间和个数已经写好。 */
	countOnly: (span: {
		from: string;
		until: string | null;
		count: string;
		name: string;
		reason: CountOnlySpan["reason"];
	}): string =>
		`${span.from} 至${span.until === null ? "今" : ` ${span.until} `}的 ${span.count} 个「${span.name}」只计数，没有明细（${NODE_ACTIONS.countOnlyReason[span.reason]}）`,
	/** 节点没有记录过动作和标记（规格 #345：标准节点这一轮不记录动作）。 */
	none: (node: string, running: boolean) => `${node} ${running ? "还没有" : "没有"}记录动作`,
	noneHint: "标准节点这一轮不记录动作；节点的代码用 ctx.action 记录动作、ctx.mark 记录标记。",
	pickNode: "在时间线上选中一个节点，查看它的动作。",
	loading: "正在加载动作…",
	loadFailed: "读取动作失败：",
	expired: "这次运行的动作明细已超过保留期，已被清理。",
	loadOlder: "向下滚动或点击加载更早的明细",
	loadingOlder: "正在加载更早的明细…",
	caption: (node: string) => `${node} 的动作，按开始时间从新到旧`,
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

/** 已请求取消、还在等待任务结束与清理的运行（故事 70：不显示成「运行中」）。 */
export const CANCELLING_LABEL = "取消中";
/** 清理期间再次取消，正在强制终止。 */
export const FORCE_CANCELLING_LABEL = "强制终止中";

/** 通用操作（按钮、菜单项、命令）。 */
export const ACTION = {
	run: "运行",
	trigger: "触发运行",
	rerun: "再次运行",
	cancelRun: "取消运行",
	forceCancel: "强制终止",
	keepRunning: "继续运行",
	openRun: "打开运行详情",
	viewRuns: "查看运行记录",
	edit: "编排",
	newScenario: "新建场景",
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
} as const;

/** AI 编程助手的显示名，键是请求头 `x-sfly-client` 里 `agent/<名称>` 的名称（用 Map，避免 `constructor` 这类名称取到对象自带的属性）。 */
const ASSISTANT_NAME = new Map([
	["claude-code", "Claude Code"],
	["codex", "Codex"],
]);

/** 「经 Claude Code」：操作经哪个 AI 编程助手发起。不认识的名称原样显示。只是标注，不是鉴权（ADR 0004）。 */
export const viaLabel = (via: string) => `经 ${ASSISTANT_NAME.get(via) ?? via}`;

/** 「预设：压测 A 集群」：运行详情、运行记录里这个运行用的运行预设（触发时记下的名称）。 */
export const presetLabel = (name: string) => `预设：${name}`;

/** 失效的运行预设（GLOSSARY）的状态词：运行抽屉的选择框、管理对话框的列表、「再次运行」的提示里都写它。 */
export const PRESET_INVALID_LABEL = "已失效";

/** 通用的加载 / 错误 / 空状态文字。 */
export const MESSAGE = {
	loading: "加载中",
	loadFailed: (what: string) => `无法加载${what}`,
	neverRun: "从未运行",
	noLogs: "还没有日志。",
	/** 监控页日志页签：任务或运行还没有结束，暂时没有日志。 */
	logOutputPending: "还没有日志输出。",
	/** 监控页日志页签：单个任务的日志写满上限后，控制面丢掉之后的输出。 */
	logTruncated: "日志超过单个任务的大小上限，之后的输出已被截断。",
	archived: "已归档",
	copyFailed: "复制失败",
	clipboardDenied: "浏览器不允许访问剪贴板",
} as const;

/**
 * 链和子流程的显示名称：画布、检查器、运行视图和运行通知的卡片共用（@sfly/orchestration 的 chain-label）。
 * `chainLabel` 是「主链」或「子流程 <名称>」，给出实例 ID 时带上实例短 ID；`subflowLabel` 是子流程的显示名称，
 * 没有名称字段的旧版本显示节点 ID，填了空名称时显示「未命名子流程」。
 */
export { chainLabel, subflowLabel } from "@sfly/orchestration";
