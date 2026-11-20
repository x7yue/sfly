import { InvalidReferenceError, nodeNameWithId, resolveInputs } from "@sfly/orchestration";
import type { ChainPlan, RunPlan } from "../engine/chain.js";

/** 一条链和触发时就能知道的它的入口参数。 */
export interface KnownParams {
	chain: ChainPlan;
	/** 知道值的参数（不知道的不在里面，引用它们的值解析不出来，跳过）。 */
	params: Record<string, unknown>;
	/** 这条链上的值取自哪里（写进问题的说明）。 */
	source: string;
}

/**
 * 触发时就能知道入口参数的链：主链的入口参数是触发时给的；子流程的入口参数是调度它的异步任务节点按参数映射传入的，
 * 映射的值是常量或只引用了那条链的入口参数时就知道（没有映射的取默认值），引用了前面节点的输出的不知道。
 * 一个子流程被几个异步任务节点调度时各算一次；子流程（间接）调度自己时只算到第一次。
 */
export function knownParams(plan: RunPlan, params: Record<string, unknown>): KnownParams[] {
	const found: KnownParams[] = [];
	const visit = (known: KnownParams, path: ReadonlySet<string>) => {
		found.push(known);
		for (const node of known.chain.nodes) {
			if (node.kind !== "async") continue;
			const subflow = plan.chains.get(plan.dispatch.get(node.id) ?? "");
			if (!subflow || path.has(subflow.entry.id)) continue;
			const passed: Record<string, unknown> = {};
			for (const decl of subflow.entry.params) {
				const value = Object.hasOwn(node.params, decl.name)
					? resolved(node.params[decl.name], known.params)
					: (decl.default ?? null);
				if (value !== undefined) passed[decl.name] = value;
			}
			visit(
				{
					chain: subflow,
					params: passed,
					source: `取自子流程的参数，由异步任务节点 ${nodeNameWithId(node)} 传入`,
				},
				new Set([...path, subflow.entry.id]),
			);
		}
	};
	visit({ chain: plan.main, params, source: "取自入口参数" }, new Set([plan.main.entry.id]));
	return found;
}

/** 只用入口参数 `params` 解析一个值；引用了前面节点的输出、或不知道值的参数时为 undefined。 */
export function resolved(value: unknown, params: Record<string, unknown>): unknown {
	try {
		return resolveInputs({ value }, { params, earlierOutputs: new Map() }).value;
	} catch (error) {
		if (error instanceof InvalidReferenceError) return undefined;
		throw error;
	}
}
