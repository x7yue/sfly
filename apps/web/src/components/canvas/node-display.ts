import { NODE_DEFAULTS } from "@sfly/orchestration";
import {
	AlarmClockIcon,
	BellRingIcon,
	BoxIcon,
	CircleStopIcon,
	CornerDownRightIcon,
	HourglassIcon,
	type LucideIcon,
	PlayIcon,
	SplitIcon,
} from "lucide-react";
import { subflowLabel } from "#/lib/copy";
import type { CanvasInfo } from "./context";
import type { DocNode } from "./flow";

/**
 * 节点种类的名称与图标。图标出现在节点卡片头部（语义缩放时也保留，缩小后仍能分辨种类）和添加节点菜单里，
 * 取代原型里需要记忆的两字母代号。
 */
export const KIND_META: Record<DocNode["kind"], { label: string; icon: LucideIcon }> = {
	entry: { label: "入口", icon: PlayIcon },
	package: { label: "包节点", icon: BoxIcon },
	timer: { label: "定时", icon: AlarmClockIcon },
	sleep: { label: "Sleep", icon: HourglassIcon },
	async: { label: "异步任务", icon: SplitIcon },
	subflow_entry: { label: "子流程入口", icon: CornerDownRightIcon },
	stop_subflow: { label: "停止子流程", icon: CircleStopIcon },
	feishu_notify: { label: "飞书通知", icon: BellRingIcon },
};

/**
 * 卡片头部 ID 旁的种类名：包节点不显示（标题就是节点类型），标题已经说明种类时也不重复
 * （入口节点标题「入口」、异步任务节点标题「异步任务」）。
 */
export function kindCaption(node: DocNode, title: string): string | undefined {
	if (node.kind === "package") return undefined;
	const { label } = KIND_META[node.kind];
	return title.includes(label) ? undefined : label;
}

/** 文档里子流程入口节点 ID → 显示名称的查找（CanvasInfo.subflowLabelOf）。 */
export function subflowLabels(doc: {
	nodes: readonly { id: string; kind: string; name?: string | undefined }[];
}): (id: string) => string | undefined {
	const labels = new Map(
		doc.nodes.filter((n) => n.kind === "subflow_entry").map((n) => [n.id, subflowLabel(n)]),
	);
	return (id) => labels.get(id);
}

export function nodeTitle(node: DocNode, info: CanvasInfo): string {
	switch (node.kind) {
		case "subflow_entry":
			return subflowLabel(node);
		case "package":
			return info.titleOf(node.package, node.node) ?? node.node;
		case "timer":
			return `等到 ${node.at}`;
		case "sleep":
			return `等待 ${node.duration}`;
		case "stop_subflow":
			// 卡片标题显示要停止的子流程名称（故事 9）；目标不存在时显示节点 ID，由校验面板提示。
			return node.subflow
				? `停止「${info.subflowLabelOf(node.subflow) ?? node.subflow}」`
				: KIND_META.stop_subflow.label;
		default:
			return KIND_META[node.kind].label;
	}
}

const summarizeValue = (value: unknown): string => {
	if (typeof value === "string") {
		const ref = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(value);
		return ref ? `← ${ref[1]}` : `= ${value}`;
	}
	return `= ${JSON.stringify(value)}`;
};

/**
 * 卡片底部摘要槽（编辑模式）：节点最主要的配置。`empty` 表示还没有配置（没有参数、没有映射……），
 * 卡片上用辅助文字显示，与真实的配置值区分开。
 */
export function nodeSlot(node: DocNode): { text: string; empty: boolean } {
	const value = (text: string) => ({ text, empty: false });
	const empty = (text: string) => ({ text, empty: true });
	switch (node.kind) {
		case "entry":
		case "subflow_entry":
			return node.params.length === 0
				? empty("没有参数")
				: value(node.params.map((p) => (p.secret ? `${p.name}*` : p.name)).join(" · "));
		case "async": {
			const keys = Object.keys(node.params);
			return keys.length === 0 ? empty("没有参数映射") : value(`映射 ${keys.join(" · ")}`);
		}
		case "timer":
			return value(`${node.at} · ${node.tz}`);
		case "sleep":
			return value(node.duration);
		case "stop_subflow":
			return node.subflow ? value(`子流程入口 ${node.subflow}`) : empty("未选择子流程");
		case "feishu_notify":
			return node.bot === undefined
				? empty("未选择飞书机器人")
				: value(`机器人 ${summarizeValue(node.bot)}`);
		case "package": {
			const [first] = Object.entries(node.inputs);
			return first
				? value(`${first[0]} ${summarizeValue(first[1])}`)
				: value(`${node.package}/${node.node}`);
		}
	}
}

/** 卡片右上角的标签：always、另选的 Agent、重试次数。 */
export function nodeTags(node: DocNode): string[] {
	const tags: string[] = [];
	if (node.kind === "package") {
		if (node.retries !== undefined && node.retries !== NODE_DEFAULTS.retries) {
			tags.push(`重试 ${node.retries}`);
		}
		if (node.agent) tags.push(node.agent);
	}
	if ("always" in node && node.always) tags.push("always");
	return tags;
}
