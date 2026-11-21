// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { NodeTypeMetadata, StoredOrchestrationDocument } from "@sfly/schema";
import { isInputOfType } from "./input-marker.js";
import { inputsOfType } from "./input-types.js";
import { nodeNameWithId } from "./node-display.js";
import { REFERENCE, RUN_STATE_PATH, WHOLE_REFERENCE } from "./reference-syntax.js";
import { nodeTypeOf, type PackageCatalog, referableValues } from "./references.js";

/**
 * 运行状态的引用 `${{ run.state }}`（docs/SEMANTICS.md §2.7，ADR 0031）：派发时解析成这次运行此刻的状态
 * （`@sfly/schema` 的 `RunState`），接到包节点的一个普通输入上。规则：
 *
 * - 只能整值引用（夹在文字里时运行状态是对象，拼不进字符串），只能写在包节点的输入里；
 *   写在异步任务节点的参数映射里（参数映射在子流程创建时解析并按值复制，子流程里的节点拿到的会是一份过时的状态）、
 *   Sleep 节点的 duration 里都不行；
 * - 节点类型里用 `sfly.RunState` 声明的输入（`sfly build` 在输入 schema 里标记 `x-sfly-type: run_state`，可选参数
 *   `RunState | None` 是 anyOf 里的一项）必须接它：必填的没接、或写了别的值（字面值、别的引用）时警告；
 *   接到不带标记的普通输入（例如 json）上也允许。
 *
 * 违反时保存时警告、触发时阻断（和别的静态检查一样，docs/SEMANTICS.md §2.4）。
 */

type Io = NodeTypeMetadata["inputs"];

/** 输入 schema 里标记「运行状态」类型的值（`x-sfly-type`，与 sdk/python/src/sfly/cli/scan.py 一致）。 */
export const RUN_STATE_INPUT_TYPE = "run_state";

/** 写进输入里的引用。 */
export const RUN_STATE_REFERENCE = "${{ run.state }}";

/** 这个输入是不是「运行状态」类型（`RunState`，或 `RunState | None`）。 */
export const isRunStateInput = (schema: Record<string, unknown>): boolean =>
	isInputOfType(schema, RUN_STATE_INPUT_TYPE);

/** 节点类型里「运行状态」类型的输入名（按参数顺序）。 */
export const runStateInputs = (io: Io): string[] => inputsOfType(io, RUN_STATE_INPUT_TYPE);

const isRunStatePath = (path: string) => RUN_STATE_PATH.test(path);

/** 整个值恰好是 `${{ run.state }}`。 */
export function isWholeRunState(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const whole = WHOLE_REFERENCE.exec(value);
	return whole !== null && !whole[1]?.includes("}}") && isRunStatePath(whole[1] as string);
}

/** 值里（递归进入对象和数组）每一处对 `run.state` 的引用：整值引用，或夹在文字里（`whole` 为 false）。 */
export function runStateUses(value: unknown): { whole: boolean }[] {
	if (typeof value === "string") {
		if (isWholeRunState(value)) return [{ whole: true }];
		return [...value.matchAll(REFERENCE)]
			.filter((m) => isRunStatePath(m[1] as string))
			.map(() => ({ whole: false }));
	}
	if (Array.isArray(value)) return value.flatMap(runStateUses);
	if (value !== null && typeof value === "object") {
		return Object.values(value).flatMap(runStateUses);
	}
	return [];
}

/** 值里有没有引用 `run.state`（引擎只在节点的输入里出现它时才读运行状态）。 */
export const referencesRunState = (value: unknown): boolean => runStateUses(value).length > 0;

export interface RunStateWarning {
	code:
		| "reference_run_state_embedded"
		| "reference_run_state_misplaced"
		| "input_run_state_missing"
		| "input_run_state_value";
	message: string;
	node_id: string;
	/** 警告所指的字段（包节点的输入、异步任务节点的参数、Sleep 节点的 duration）。 */
	input: string;
}

/**
 * `run.state` 的静态检查：引用的位置（只能整值引用、只能写在包节点的输入里），以及「运行状态」类型的输入有没有接对。
 * 节点类型未知（目录里没有这个版本）时不检查类型的部分，包版本检查会指出。
 */
export function runStateWarnings(
	doc: StoredOrchestrationDocument,
	catalog: PackageCatalog,
): RunStateWarning[] {
	const warnings: RunStateWarning[] = [];
	for (const node of doc.nodes) {
		const name = nodeNameWithId(node);
		const typed = new Set<string>();
		if (node.kind === "package") {
			const type = nodeTypeOf(doc, node, catalog);
			const required = new Set(type?.inputs.required ?? []);
			for (const input of type ? runStateInputs(type.inputs) : []) {
				typed.add(input);
				const given = Object.hasOwn(node.inputs, input);
				const value = node.inputs[input];
				if (isWholeRunState(value) || (given && value === null && !required.has(input))) continue;
				if (!given) {
					// 可选的（`RunState | None`）不接是作者允许的；必填的没接才警告。
					if (!required.has(input)) continue;
					warnings.push({
						code: "input_run_state_missing",
						message: `节点 ${name} 的输入 ${input} 要接这次运行的状态，填 ${RUN_STATE_REFERENCE}`,
						node_id: node.id,
						input,
					});
					continue;
				}
				warnings.push({
					code: "input_run_state_value",
					message: `节点 ${name} 的输入 ${input} 要接这次运行的状态，只能写 ${RUN_STATE_REFERENCE}，不能是别的值`,
					node_id: node.id,
					input,
				});
			}
		}
		for (const [input, value] of referableValues(node)) {
			if (typed.has(input)) continue;
			const uses = runStateUses(value);
			if (uses.length === 0) continue;
			if (node.kind !== "package") {
				const where =
					node.kind === "async" ? `节点 ${name} 的参数 ${input}` : `节点 ${name} 的 ${input}`;
				warnings.push({
					code: "reference_run_state_misplaced",
					message:
						`${where} 里不能引用 ${RUN_STATE_REFERENCE}：参数映射在子流程创建时解析并按值复制，子流程里的节点拿到的会是一份过时的状态；` +
						"需要运行状态的节点（子流程里的也一样）在自己的输入里引用它",
					node_id: node.id,
					input,
				});
			} else if (uses.some((u) => !u.whole)) {
				warnings.push({
					code: "reference_run_state_embedded",
					message: `节点 ${name} 的输入 ${input} 把 ${RUN_STATE_REFERENCE} 写在了文字里：运行状态是一个对象，只能整值引用，把这个输入的值整个写成 ${RUN_STATE_REFERENCE}`,
					node_id: node.id,
					input,
				});
			}
		}
	}
	return warnings;
}
