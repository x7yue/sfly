import { NODE_DEFAULTS, NODE_KIND_LABEL } from "@sfly/orchestration";
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
import type { DocNode } from "./flow";

/**
 * 节点种类的名称与图标。图标出现在节点卡片头部（语义缩放时也保留，缩小后仍能分辨种类）和添加节点菜单里，
 * 取代原型里需要记忆的两字母代号。
 */
export const KIND_META: Record<DocNode["kind"], { label: string; icon: LucideIcon }> = {
	entry: { label: NODE_KIND_LABEL.entry, icon: PlayIcon },
	package: { label: NODE_KIND_LABEL.package, icon: BoxIcon },
	timer: { label: NODE_KIND_LABEL.timer, icon: AlarmClockIcon },
	sleep: { label: NODE_KIND_LABEL.sleep, icon: HourglassIcon },
	async: { label: NODE_KIND_LABEL.async, icon: SplitIcon },
	subflow_entry: { label: NODE_KIND_LABEL.subflow_entry, icon: CornerDownRightIcon },
	stop_subflow: { label: NODE_KIND_LABEL.stop_subflow, icon: CircleStopIcon },
	feishu_notify: { label: NODE_KIND_LABEL.feishu_notify, icon: BellRingIcon },
};

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
