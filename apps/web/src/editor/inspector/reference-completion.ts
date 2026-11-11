// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import {
	nodeTypeOf,
	type PackageCatalog,
	REFERENCE,
	type ReferenceOption,
	referenceOptions,
	referenceScope,
} from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";

/**
 * 引用补全的纯逻辑（检查器的 ReferenceTextInput 使用，单测覆盖）：可引用的值与来源说明、
 * 何时弹出补全、按「入口参数」「前序节点」分组与过滤、选中后写回的文本。
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

/** 光标前面一个还没闭合的 `${{`（以及已经输入的部分表达式）。 */
const OPEN_REFERENCE = /\$\{\{\s*([\w.-]*)$/;

/** 补全的触发位置：start 是选中后要被替换的起点，query 是已经输入的表达式。 */
export interface CompletionTrigger {
	start: number;
	query: string;
}

/**
 * 是否弹出补全：引用模式（whole）下整个输入就是表达式，总是弹出；
 * 常量文本里光标前面是 `${{` 开头、还没闭合的引用时弹出。
 */
export function completionTrigger(
	raw: string,
	caret: number,
	whole: boolean,
): CompletionTrigger | null {
	if (whole) return { start: 0, query: raw };
	const m = OPEN_REFERENCE.exec(raw.slice(0, caret));
	return m ? { start: caret - m[0].length, query: m[1] ?? "" } : null;
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
 * 选中一个补全项后的值与光标：引用模式下整个值换成 `${{ 表达式 }}`；
 * 常量文本里把触发位置到光标之间替换成引用，光标停在引用之后。
 */
export function applyCompletion(
	value: string,
	trigger: CompletionTrigger | null,
	caret: number,
	choice: Pick<ReferenceChoice, "text">,
	whole: boolean,
): { value: string; caret: number } {
	if (whole) return { value: choice.text, caret: choice.text.length };
	const start = trigger?.start ?? caret;
	return {
		value: value.slice(0, start) + choice.text + value.slice(caret),
		caret: start + choice.text.length,
	};
}

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
