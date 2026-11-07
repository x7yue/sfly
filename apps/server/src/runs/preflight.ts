import type { OrchestrationDocument } from "@sfly/schema";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { agents } from "../db/schema.js";
import { agentFor, planRun } from "../engine/chain.js";
import { checkDocument } from "../orchestrations/document-checks.js";
import type { PackageRepository } from "../packages/package-repository.js";
import { sdkRequirementProblem } from "../packages/requires-sdk.js";

/**
 * 不能触发的一个原因；code 与保存时的警告一致，另有 `agent_not_registered`、`not_supported`、
 * `sdk_version_unsatisfied`。
 */
export interface PreflightProblem {
	code: string;
	message: string;
	node_id?: string;
}

export type Preflight = (doc: OrchestrationDocument) => Promise<PreflightProblem[]>;

/**
 * 触发前的预检（docs/SEMANTICS.md §6）：结构、包版本锁定、引用校验全部通过，
 * 包节点派发到的 Agent 都已注册（不要求在线），且 Agent 满足节点包需要的 SDK 版本（#79）。
 * 返回全部不能触发的原因，空数组表示可以触发。未保存的草稿只存在于浏览器，由画布在触发前检查。
 *
 * 只给与控制面版本一致的 Agent 派任务（ADR 0014），所以 Agent 执行任务时的版本就是控制面版本 `version`；
 * 记录里版本不同的 Agent 会先自更新到这个版本。
 */
export function createPreflight(deps: {
	db: Db;
	packages: PackageRepository;
	version: string;
}): Preflight {
	return async (doc) => {
		const problems: PreflightProblem[] = (await checkDocument(doc, deps.packages)).map((w) => ({
			code: w.code,
			message: w.message,
			...(w.node_id ? { node_id: w.node_id } : {}),
		}));

		const wanted = new Map<string, string>();
		for (const node of doc.nodes) {
			if (node.kind !== "package") continue;
			const agent = agentFor(doc, node);
			if (agent) wanted.set(node.id, agent);
		}
		const names = [...new Set(wanted.values())];
		const registered = new Set(
			names.length
				? (
						await deps.db
							.select({ name: agents.name })
							.from(agents)
							.where(inArray(agents.name, names))
					).map((r) => r.name)
				: [],
		);
		for (const [nodeId, agent] of wanted) {
			if (registered.has(agent)) continue;
			problems.push({
				code: "agent_not_registered",
				message: `节点 ${nodeId} 派发到的 Agent ${agent} 还没有注册过`,
				node_id: nodeId,
			});
		}

		for (const [nodeId, agent] of wanted) {
			const node = doc.nodes.find((n) => n.id === nodeId);
			if (node?.kind !== "package") continue;
			const version = doc.packages[node.package];
			const published = version && (await deps.packages.getVersion(node.package, version));
			if (!published) continue;
			const message = sdkRequirementProblem(
				published.metadata,
				{ name: node.package, version: published.version },
				{ name: agent, version: deps.version },
			);
			if (message) {
				problems.push({
					code: "sdk_version_unsatisfied",
					message: `节点 ${nodeId}：${message}`,
					node_id: nodeId,
				});
			}
		}

		// 执行计划的检查（单链、节点种类受支持、调度目标等）。
		if (problems.length === 0) {
			const plan = planRun(doc);
			if ("errors" in plan) {
				for (const message of plan.errors) problems.push({ code: "not_supported", message });
			}
		}
		return problems;
	};
}
