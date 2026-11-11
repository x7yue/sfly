// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import {
	nodeTypeOf,
	type PackageCatalog,
	REFERENCE,
	type ReferenceOption,
	referenceOptions,
	referenceScope,
	WHOLE_REFERENCE,
} from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";

/**
 * 引用补全的纯逻辑（检查器的 ReferenceEditor、ReferencePicker 使用，单测覆盖）：可引用的值与来源说明、
 * 何时弹出补全、按「入口参数」「前序节点」分组与过滤、键盘选择。
 */

/** 一个引用补全项，带上来源说明（类型、所属节点）。 */
export interface ReferenceChoice extends ReferenceOption {
	detail: string;
}

/**
 * 节点 id 可以引用的值（本链的入口参数、前序节点的输出），带上来源说明：
 * 参数的类型（敏感参数标出），输出的类型与所属节点。
 */
export function referenceChoices(
	doc: OrchestrationDocument,
	id: string,
	catalog: PackageCatalog,
): ReferenceChoice[] {
	const scope = referenceScope(doc, id);
	const params = new Map((scope.start?.params ?? []).map((p) => [p.name, p]));
	return referenceOptions(doc, id, catalog).map((o): ReferenceChoice => {
		if (o.kind === "param") {
			const p = params.get(o.key);
			return { ...o, detail: `${p?.type ?? ""}${p?.secret ? " · 敏感" : ""}` };
		}
		const source = doc.nodes.find((n) => n.id === o.node_id);
		const schema =
			source?.kind === "package"
				? nodeTypeOf(doc, source, catalog)?.outputs.properties[o.key]
				: undefined;
		const type = typeof schema?.type === "string" ? `${schema.type} · ` : "";
		return { ...o, detail: `${type}${o.node_id}` };
	});
}

/** 补全的触发位置：start 是选中后要被替换的起点，query 是已经输入的表达式。 */
export interface CompletionTrigger {
	start: number;
	query: string;
}

export const COMPLETION_GROUPS = ["入口参数", "前序节点"] as const;

/** 按表达式子串（不区分大小写）过滤，分成「入口参数」「前序节点」两组；ordered 是键盘上下选择的顺序。 */
export function completionGroups(choices: readonly ReferenceChoice[], query: string) {
	const q = query.toLowerCase();
	const matches = choices.filter((c) => c.expression.toLowerCase().includes(q));
	const groups = [
		{ title: COMPLETION_GROUPS[0], choices: matches.filter((c) => c.kind === "param") },
		{ title: COMPLETION_GROUPS[1], choices: matches.filter((c) => c.kind === "output") },
	];
	return { groups, ordered: groups.flatMap((g) => g.choices) };
}

/**
 * 补全刚打开时的选中项（-1 表示没有）。输入 `$` 触发的补全不预选：`$HOME` 这样的 shell 写法也可能匹配到候选，
 * 这时按 Enter / Tab 不应该插入引用；用方向键或鼠标选中之后才插入。「插入引用」按钮触发的（manual）预选第一项。
 */
export const initialActive = (trigger: { manual: boolean }): number => (trigger.manual ? 0 : -1);

/** 方向键移动选中项（delta 为 1 或 -1），首尾循环；还没有选中项时向下到第一项，向上到最后一项。 */
export function moveActive(active: number, delta: 1 | -1, count: number): number {
	if (active < 0) return delta === 1 ? 0 : count - 1;
	return (active + delta + count) % count;
}

/** 整个值恰好是一个引用时的表达式（与派发时的解析用同一条规则）。 */
export const wholeReference = (value: unknown): string | undefined =>
	typeof value === "string" ? WHOLE_REFERENCE.exec(value)?.[1] : undefined;

/** 合并后的输入框里的补全触发位置；braced 表示已经写了 `${`（否则只有一个 `$`）。 */
export interface InlineTrigger extends CompletionTrigger {
	braced: boolean;
}

/** 光标前面的 `$`、`${`、`${{`，以及紧跟着已经输入的部分表达式。 */
const INLINE_TRIGGER = /\$(\{(?:\{\s*)?)?([\w.-]*)$/;

/**
 * 合并后的输入框（ReferenceEditor）何时弹出补全：光标前面刚输入 `$`（或 `${`、`${{`）、引用还没闭合。
 * before 是光标之前的文本；start 是选中后要被替换的起点。
 */
export function inlineTrigger(before: string): InlineTrigger | null {
	const m = INLINE_TRIGGER.exec(before);
	if (!m) return null;
	return { start: m.index, query: m[2] ?? "", braced: m[1] !== undefined };
}

/** 文本里每个引用 `${{ … }}` 的范围。 */
export function referenceRanges(text: string): { from: number; to: number }[] {
	return [...text.matchAll(REFERENCE)].map((m) => ({
		from: m.index,
		to: m.index + m[0].length,
	}));
}
