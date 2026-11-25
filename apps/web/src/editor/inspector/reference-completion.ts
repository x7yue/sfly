// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import {
	type NodeTypeLookup,
	nodeNameWithId,
	nodeTypeLookup,
	type PackageCatalog,
	REFERENCE,
	type ReferenceOption,
	referenceOptions,
	referenceScope,
	schemaDescription,
	WHOLE_REFERENCE,
} from "@sfly/orchestration";
import type { StoredOrchestrationDocument } from "@sfly/schema";
import { TERM } from "#/lib/copy";

/**
 * 引用补全的纯逻辑（检查器的 ReferenceEditor、ReferencePicker 使用，单测覆盖）：可引用的值与来源说明、
 * 何时弹出补全、按「入口参数」「运行状态」「前序节点」分组与过滤、键盘选择。
 */

/** 一个引用补全项，带上来源说明（类型、所属节点）；输出还带节点包写的说明（`Doc`），没写就没有。 */
export interface ReferenceChoice extends ReferenceOption {
	detail: string;
	description?: string | undefined;
}

/** 运行状态（`${{ run.state }}`，ADR 0031）一项的来源说明与说明：值是一个对象，来自这次运行，只能整值引用。 */
const RUN_STATE_DETAIL = "object · 这次运行";
const RUN_STATE_DESCRIPTION =
	"这次运行此刻的状态：各节点的状态、尝试次数、失败原因等。只能整值引用，不能夹在文字里。";

/**
 * 节点 id 可以引用的值（本链的入口参数、运行状态、前序节点的输出），带上来源说明：
 * 参数的类型（secret 参数标出），运行状态的类型与来源，输出的类型与所属节点（写成「显示名称（节点 ID）」）。
 */
export function referenceChoices(
	doc: StoredOrchestrationDocument,
	id: string,
	catalog: PackageCatalog | NodeTypeLookup,
): ReferenceChoice[] {
	const typeOf = nodeTypeLookup(doc, catalog);
	const scope = referenceScope(doc, id);
	const params = new Map((scope.start?.params ?? []).map((p) => [p.name, p]));
	const choiceOf = (o: ReferenceOption): ReferenceChoice => {
		switch (o.kind) {
			case "param": {
				const p = params.get(o.key);
				return { ...o, detail: `${p?.type ?? ""}${p?.secret ? ` · ${TERM.secret}` : ""}` };
			}
			case "run_state":
				return { ...o, detail: RUN_STATE_DETAIL, description: RUN_STATE_DESCRIPTION };
			case "output": {
				const source = doc.nodes.find((n) => n.id === o.node_id);
				const schema =
					source?.kind === "package" ? typeOf(source)?.outputs.properties[o.key] : undefined;
				const type = typeof schema?.type === "string" ? `${schema.type} · ` : "";
				return {
					...o,
					detail: `${type}${source ? nodeNameWithId(source) : o.node_id}`,
					description: schemaDescription(schema),
				};
			}
		}
	};
	return referenceOptions(doc, id, catalog).map(choiceOf);
}

/** 补全的触发位置：start 是选中后要被替换的起点，query 是已经输入的表达式。 */
export interface CompletionTrigger {
	start: number;
	query: string;
}

/**
 * 补全的分组：每种引用一组，键的顺序就是显示和键盘选择的顺序（与 `referenceOptions` 里选项的顺序一致）。
 * 类型是 `Record<kind, …>`：新增一种引用而这里没写，编译不过。
 */
export const COMPLETION_GROUPS: Record<ReferenceChoice["kind"], string> = {
	param: "入口参数",
	run_state: "运行状态",
	output: "前序节点",
};

/** 按表达式子串（不区分大小写）过滤，按 `COMPLETION_GROUPS` 分组；ordered 是键盘上下选择的顺序。 */
export function completionGroups(choices: readonly ReferenceChoice[], query: string) {
	const q = query.toLowerCase();
	const matches = choices.filter((c) => c.expression.toLowerCase().includes(q));
	const groups = Object.entries(COMPLETION_GROUPS).map(([kind, title]) => ({
		title,
		choices: matches.filter((c) => c.kind === kind),
	}));
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
