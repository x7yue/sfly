import { NODE_DEFAULTS, NODE_KIND_LABEL } from "@sfly/orchestration";
import { REMOVED_NODE_KIND_NAMES, type RemovedNodeKind, removedKindLabel } from "@sfly/schema";
import {
	BanIcon,
	BoxIcon,
	CircleStopIcon,
	CornerDownRightIcon,
	type LucideIcon,
	PlayIcon,
	SplitIcon,
} from "lucide-react";
import type { DocNode } from "./flow";

/**
 * 节点种类的名称与图标。图标出现在节点卡片头部（语义缩放时也保留，缩小后仍能分辨种类）和添加节点菜单里，
 * 取代原型里需要记忆的两字母代号。
 */
const KIND_ICONS = {
	entry: PlayIcon,
	package: BoxIcon,
	async: SplitIcon,
	subflow_entry: CornerDownRightIcon,
	stop_subflow: CircleStopIcon,
} as const;

/** 已移除种类的节点（ADR 0028）：名称是「已移除的节点类型」加它当时的种类名，图标统一用禁止符号。 */
const REMOVED_KIND_META = Object.fromEntries(
	REMOVED_NODE_KIND_NAMES.map((kind) => [kind, { label: removedKindLabel(kind), icon: BanIcon }]),
) as Record<RemovedNodeKind, { label: string; icon: LucideIcon }>;

export const KIND_META: Record<DocNode["kind"], { label: string; icon: LucideIcon }> = {
	...REMOVED_KIND_META,
	entry: { label: NODE_KIND_LABEL.entry, icon: KIND_ICONS.entry },
	package: { label: NODE_KIND_LABEL.package, icon: KIND_ICONS.package },
	async: { label: NODE_KIND_LABEL.async, icon: KIND_ICONS.async },
	subflow_entry: { label: NODE_KIND_LABEL.subflow_entry, icon: KIND_ICONS.subflow_entry },
	stop_subflow: { label: NODE_KIND_LABEL.stop_subflow, icon: KIND_ICONS.stop_subflow },
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
		case "stop_subflow":
			return node.subflow ? value(`子流程入口 ${node.subflow}`) : empty("未选择子流程");
		case "package": {
			const [first] = Object.entries(node.inputs);
			return first
				? value(`${first[0]} ${summarizeValue(first[1])}`)
				: value(`${node.package}/${node.node}`);
		}
		default:
			// 已移除种类的节点（ADR 0028）：不能运行，检查器里写着怎么替换。
			return empty("不再支持，删除后才能保存");
	}
}

/**
 * 卡片上的节点 ID 拆成两段（DESIGN-SYSTEM「标识符保留结尾」）：开头那段放不下时截断，结尾那段始终显示，
 * 省略号因此落在中间。结尾按 `_` `-` `.` 分段保留整段，不把单词从中间切开：最后一段（`_monitor`）；
 * 最后一段很短（`_1`、`_v2`）时再带上前一段（`_subflow_1`、`_atx_v2`），这样 `stop_subflow_1` 和
 * `stop_subflow_2`、`order_monitor` 和 `resource_monitor` 截断后仍分得开。没有分隔符的 ID 保留结尾 6 个字符。
 * 全文在卡片的读屏名称和悬停提示里。
 */
export function idParts(id: string): { head: string; tail: string } {
	// 开头只剩一两个字时不拆：省略号本身就占一个字宽，截掉一两个字省不出地方，开头那段的最小宽度还会撑出空隙
	// （「cleanup」显示成「c leanup」）。
	const cut = (at: number) =>
		at <= 2 ? { head: "", tail: id } : { head: id.slice(0, at), tail: id.slice(at) };
	const seps = [...id.matchAll(/[_.-]/g)].map((m) => m.index).filter((i) => i > 0);
	if (seps.length === 0) return id.length > 6 ? cut(id.length - 6) : { head: "", tail: id };
	const last = seps.at(-1) ?? 0;
	const before = seps.at(-2);
	if (id.length - last <= 3 && before !== undefined && id.length - before <= 12) return cut(before);
	return cut(last);
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
