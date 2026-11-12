import { MAIN_CHAIN_LABEL, SUBFLOW_LABEL } from "@sfly/orchestration";
import type { RunNotificationState, RunStatus } from "@sfly/schema";

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
	nodePackage: "节点包",
	metric: "指标",
	chart: "图表",
	primaryMetric: "主指标",
} as const;

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
	resizeInspector: "调整检查器宽度",
} as const;

/** 通用的加载 / 错误 / 空状态文字。 */
export const MESSAGE = {
	loading: "加载中",
	loadFailed: (what: string) => `无法加载${what}`,
	neverRun: "从未运行",
	noLogs: "还没有日志。",
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
