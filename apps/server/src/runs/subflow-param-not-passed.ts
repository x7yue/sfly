import { nodeNameWithId, PARAM_PATH, referableValues, referencesIn } from "@sfly/orchestration";
import type { StoredNode, StoredOrchestrationDocument } from "@sfly/schema";
import { planRun } from "../engine/chain.js";
import type { PreflightProblem } from "./preflight.js";

/** 用到参数的节点最多列出几个，多出来的写个数。 */
const LISTED_NODES = 3;

/** 节点的输入里有没有引用本链的入口参数 `name`（`${{ params.name }}`，整值或夹在文字里都算）。 */
function usesParam(node: StoredNode, name: string): boolean {
	return referableValues(node).some(([, value]) =>
		referencesIn(value).some((path) => path !== null && PARAM_PATH.exec(path)?.[1] === name),
	);
}

/**
 * 异步任务节点没有给子流程的参数传值，而子流程里有节点用到了它（docs/SEMANTICS.md §6 触发前的预检，警告，不阻断触发）：
 * 没有传值又没有默认值的参数，子流程里取到的是空值（null）；节点因此失败时，从错误里看不出是上一级没有传值，
 * 要跑到那个节点才知道。子流程里没有任何地方引用这个参数时不报。
 * 只看非必填的参数：必填又没有默认值的参数没有传值，是保存时就有的 `subflow_param_missing`，预检会阻断，这里不重复。
 * 子流程自己再触发的下一层子流程也一样检查（异步任务节点把它传给下一层，算用到了它）。
 * 文档的执行计划不成立时（结构问题已经阻断触发）不检查。
 */
export function subflowParamNotPassedWarnings(
	doc: StoredOrchestrationDocument,
): PreflightProblem[] {
	const plan = planRun(doc);
	if ("errors" in plan) return [];
	const warnings: PreflightProblem[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "async") continue;
		const subflow = plan.chains.get(plan.dispatch.get(node.id) ?? "");
		if (!subflow) continue;
		for (const decl of subflow.entry.params) {
			// `default: null` 和没有默认值一样：取到的是 null（fillParams）。
			if (decl.required || (decl.default ?? null) !== null || Object.hasOwn(node.params, decl.name))
				continue;
			const users = subflow.nodes.filter((n) => usesParam(n, decl.name)).map(nodeNameWithId);
			if (users.length === 0) continue;
			const listed =
				users.length > LISTED_NODES
					? `${users.slice(0, LISTED_NODES).join("、")} 等 ${users.length} 个节点`
					: users.join("、");
			warnings.push({
				code: "subflow_param_not_passed",
				message: `节点 ${nodeNameWithId(node)} 没有给子流程 ${nodeNameWithId(subflow.entry)} 的参数 ${decl.name} 传值，子流程里的节点 ${listed} 用到了它，拿到的会是空值（null）：在这个节点的参数映射里给 ${decl.name} 传值，或者在子流程入口节点给它设默认值`,
				node_id: node.id,
			});
		}
	}
	return warnings;
}
