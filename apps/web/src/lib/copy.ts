import type { NodeStatus, RunStatus } from "@sfly/schema";
import { shortId } from "./format";

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
	mainChain: "主链",
	subflow: "子流程",
	attempt: "尝试",
	agent: "Agent",
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
	editor: "编排画布",
	monitor: "运行监控",
	versions: "版本历史",
} as const;

/** 运行与链实例的状态。 */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
	running: "运行中",
	success: "成功",
	failed: "失败",
	cancelled: "已取消",
};

/** 已请求取消、还在等待任务结束与清理的运行（故事 70：不显示成「运行中」）。 */
export const CANCELLING_LABEL = "取消中";
/** 清理期间再次取消，正在强制终止。 */
export const FORCE_CANCELLING_LABEL = "强制终止中";

/** 节点（最后一次尝试）的状态。 */
export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
	pending: "待执行",
	queued: "排队中",
	// 已派发给 Agent，还在下载、安装节点包或启动执行器。
	dispatched: "准备中",
	running: "执行中",
	waiting: "等待中",
	success: "成功",
	failed: "失败",
	skipped: "已跳过",
	cancelled: "已取消",
};

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
} as const;

/** 通用的加载 / 错误 / 空状态文字。 */
export const MESSAGE = {
	loading: "加载中",
	loadFailed: (what: string) => `无法加载${what}`,
	neverRun: "从未运行",
	noLogs: "还没有日志。",
	archived: "已归档",
} as const;

/**
 * 链实例的名称：「主链」或「子流程 <起点>」；给出实例 ID 时带上实例短 ID（同一子流程有多个实例时区分）。
 */
export function chainLabel(chain: { chain_id: string; subflow: boolean }, instanceId?: string) {
	if (!chain.subflow) return TERM.mainChain;
	const name = `${TERM.subflow} ${chain.chain_id}`;
	return instanceId ? `${name} · ${shortId(instanceId)}` : name;
}
