import {
	agentInputs,
	agentNotRegistered,
	InvalidReferenceError,
	nodeTypeOf,
	referencedAgents,
	referencesIn,
	resolveInputs,
} from "@sfly/orchestration";
import type { OrchestrationDocument, PackageMetadata } from "@sfly/schema";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { agents } from "../db/schema.js";
import { agentFor, planRun, type RunPlan } from "../engine/chain.js";
import { checkDocument, packageCatalogFor } from "../orchestrations/document-checks.js";
import type { PackageRepository } from "../packages/package-repository.js";
import { controlPlaneAgentProblem, referencedAgentProblem } from "../packages/requires-agent.js";
import { controlPlaneSdkProblem } from "../packages/requires-sdk.js";

/**
 * 不能触发的一个原因；code 与保存时的警告一致（含「Agent」类型的输入选的 Agent 没有注册过的
 * `agent_input_not_registered`），另有 `agent_not_registered`、`not_supported`、`sdk_version_unsatisfied`、
 * `agent_version_unsatisfied`。
 */
export interface PreflightProblem {
	code: string;
	message: string;
	node_id?: string;
}

export type Preflight = (doc: OrchestrationDocument) => Promise<PreflightProblem[]>;

/**
 * 触发前的预检（docs/SEMANTICS.md §6）：结构、包版本锁定、引用、输入的静态检查全部通过
 * （「Agent」类型的输入的常量是已注册的 Agent），包节点派发到的 Agent 都已注册（不要求在线），
 * 且控制面版本满足节点包需要的 SDK 版本（#79），节点所在的 Agent 和「Agent」类型的输入引用的 Agent 满足
 * 节点包需要的 Agent 版本（ADR 0019，见 requires-agent.ts）。
 * 返回全部不能触发的原因，空数组表示可以触发。未保存的草稿只存在于浏览器，由画布在触发前检查。
 *
 * 比较的是控制面版本 `version` 而不是 Agent 记录里的版本：只给与控制面版本一致的 Agent 派任务（ADR 0014），
 * 记录里版本不同的 Agent 会先自更新到这个版本，所以 Agent 执行任务时的 SDK 版本就是控制面版本；提示也如实这样写。
 */
export function createPreflight(deps: {
	db: Db;
	packages: PackageRepository;
	version: string;
}): Preflight {
	return async (doc) => {
		const problems: PreflightProblem[] = (await checkDocument(doc, deps)).map((w) => ({
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

		for (const nodeId of wanted.keys()) {
			const node = doc.nodes.find((n) => n.id === nodeId);
			if (node?.kind !== "package") continue;
			const version = doc.packages[node.package];
			const published = version && (await deps.packages.getVersion(node.package, version));
			if (!published) continue;
			const message = controlPlaneSdkProblem(
				published.metadata,
				{ name: node.package, version: published.version },
				deps.version,
			);
			if (message) {
				problems.push({
					code: "sdk_version_unsatisfied",
					message: `节点 ${nodeId}：${message}`,
					node_id: nodeId,
				});
			}
			const pkg = { name: node.package, version: published.version };
			const own = controlPlaneAgentProblem(
				published.metadata,
				pkg,
				wanted.get(nodeId) ?? "",
				deps.version,
			);
			if (own) problems.push(agentVersionProblem(nodeId, own));
			// 「Agent」类型的输入的常量；引用入口参数的在触发时按实际值检查（createParamsCheck）。
			const type = published.metadata.nodes.find((n) => n.name === node.node);
			if (!type || published.metadata.requires_agent === undefined) continue;
			const constants = referencedAgents(type.inputs, node.inputs).filter(
				(r) => referencesIn(r.agent).length === 0,
			);
			const versions = await agentVersions(
				deps.db,
				constants.map((r) => r.agent),
			);
			for (const { input, agent } of constants) {
				const version = versions.get(agent);
				const message =
					version !== undefined &&
					referencedAgentProblem(published.metadata, pkg, input, { name: agent, version });
				if (message) problems.push(agentVersionProblem(nodeId, message));
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

function agentVersionProblem(nodeId: string, message: string): PreflightProblem {
	return {
		code: "agent_version_unsatisfied",
		message: `节点 ${nodeId}：${message}`,
		node_id: nodeId,
	};
}

/** 已注册的 Agent 最近一次上报的版本（没有注册过的不在里面）。 */
async function agentVersions(db: Db, names: string[]): Promise<Map<string, string>> {
	if (names.length === 0) return new Map();
	const rows = await db
		.select({ name: agents.name, info: agents.info })
		.from(agents)
		.where(inArray(agents.name, [...new Set(names)]));
	return new Map(rows.map((r) => [r.name, r.info.agent_version]));
}

/** 触发时按入口参数的实际值做的检查（{@link createParamsCheck}）。 */
export type ParamsCheck = (
	doc: OrchestrationDocument,
	plan: RunPlan,
	params: Record<string, unknown>,
) => Promise<PreflightProblem[]>;

/**
 * 触发时按入口参数的实际值检查：主链上「Agent」类型的输入引用入口参数时，取到的 Agent 必须已注册（不要求在线），
 * 版本满足节点包需要的 Agent 版本（`requires_agent`）。
 * 引用了前面节点输出的值要到派发时才知道，这里跳过；子流程的参数在调度它时才传入，也在派发时检查。
 */
export function createParamsCheck(deps: { db: Db; packages: PackageRepository }): ParamsCheck {
	return async (doc, plan, params) => {
		const wanted: {
			nodeId: string;
			input: string;
			agent: string;
			pkg: { name: string; version: string };
			metadata: Pick<PackageMetadata, "requires_agent">;
		}[] = [];
		const catalog = await packageCatalogFor(doc, deps.packages);
		for (const node of plan.main.nodes) {
			if (node.kind !== "package") continue;
			const type = nodeTypeOf(doc, node, catalog);
			if (!type) continue;
			const version = doc.packages[node.package] ?? "";
			const metadata = (await deps.packages.getVersion(node.package, version))?.metadata ?? {};
			const pkg = { name: node.package, version };
			for (const input of agentInputs(type.inputs)) {
				const value = node.inputs[input];
				if (typeof value !== "string" || referencesIn(value).length === 0) continue;
				let agent: unknown;
				try {
					agent = resolveInputs({ value }, { params, earlierOutputs: new Map() }).value;
				} catch (error) {
					if (error instanceof InvalidReferenceError) continue;
					throw error;
				}
				if (typeof agent === "string" && agent !== "")
					wanted.push({ nodeId: node.id, input, agent, pkg, metadata });
			}
		}
		if (wanted.length === 0) return [];
		const versions = await agentVersions(
			deps.db,
			wanted.map((w) => w.agent),
		);
		return wanted.flatMap((w): PreflightProblem[] => {
			const version = versions.get(w.agent);
			if (version === undefined) {
				return [
					{
						code: "agent_input_not_registered",
						message: `${agentNotRegistered(w.nodeId, w.input, w.agent)}（取自入口参数）`,
						node_id: w.nodeId,
					},
				];
			}
			const message = referencedAgentProblem(w.metadata, w.pkg, w.input, {
				name: w.agent,
				version,
			});
			return message ? [agentVersionProblem(w.nodeId, `${message}（取自入口参数）`)] : [];
		});
	};
}
