import type { MessageInitShape } from "@bufbuild/protobuf";
import { agentNotRegistered, referencedAgents } from "@sfly/orchestration";
import type { ReferencedAgentSchema } from "@sfly/proto";
import type { NodeTypeMetadata, PackageMetadata } from "@sfly/schema";
import { inArray } from "drizzle-orm";
import { agentEndpoint } from "../agents/agent-endpoint.js";
import type { Db, Tx } from "../db/database.js";
import { type AgentInfo, agents } from "../db/schema.js";
import { referencedAgentProblem } from "../packages/requires-agent.js";
import type { PackageRef } from "../packages/requires-sdk.js";

export type ReferencedAgentInit = MessageInitShape<typeof ReferencedAgentSchema>;

/** 节点包对 Agent 版本的要求（`requires_agent`）和是哪个包。 */
export interface AgentRequirement {
	metadata: Pick<PackageMetadata, "requires_agent">;
	pkg: PackageRef;
}

/** 节点的一个「Agent」类型的输入引用的 Agent。 */
export interface AgentReference {
	nodeId: string;
	/** 问题的说明里节点的写法：「显示名称（节点 ID）」（`nodeNameWithId`）；不给时写节点 ID。 */
	node?: string;
	input: string;
	agent: string;
	/**
	 * 问题的说明里这个 Agent 名称的写法，不给时写 `agent`。值取自 secret 参数时调用方传打了码的写法：
	 * 触发时的错误不回显 secret 参数的值（docs/SEMANTICS.md §2.1）。
	 */
	shown?: string;
	requirement: AgentRequirement;
	/** 值从哪来（例如「取自入口参数」），写在问题的说明后面的括号里。 */
	source?: string;
}

/** 被引用的 Agent 不能用的原因。 */
export interface ReferencedAgentProblem {
	code: "agent_input_not_registered" | "agent_version_unsatisfied";
	message: string;
	node_id: string;
}

/**
 * 「Agent」类型的输入引用的 Agent 必须已注册（不要求在线），版本满足节点包需要的 Agent 版本
 * （`requires_agent`，比较它最近一次注册时上报的版本，requires-agent.ts）。触发前（常量）、触发时（取自入口参数）
 * 和派发时都用这一份检查，所有引用一次查库。返回问题，以及查到的 Agent 记录（派发时据此取地址）。
 */
export async function checkReferencedAgents(
	db: Db | Tx,
	references: readonly AgentReference[],
): Promise<{ problems: ReferencedAgentProblem[]; infos: Map<string, AgentInfo> }> {
	const names = [...new Set(references.map((r) => r.agent))];
	if (names.length === 0) return { problems: [], infos: new Map() };
	const rows = await db
		.select({ name: agents.name, info: agents.info })
		.from(agents)
		.where(inArray(agents.name, names));
	const infos = new Map(rows.map((r) => [r.name, r.info]));
	const problems = references.flatMap(
		({
			nodeId,
			node = nodeId,
			input,
			agent,
			shown = agent,
			requirement,
			source,
		}): ReferencedAgentProblem[] => {
			const from = source === undefined ? "" : `（${source}）`;
			const info = infos.get(agent);
			if (info === undefined) {
				const message = `${agentNotRegistered(node, input, shown)}${from}`;
				return [{ code: "agent_input_not_registered", message, node_id: nodeId }];
			}
			const outdated = referencedAgentProblem(requirement.metadata, requirement.pkg, input, {
				name: shown,
				version: info.agent_version,
			});
			if (outdated === undefined) return [];
			const message = `节点 ${node}：${outdated}${from}`;
			return [{ code: "agent_version_unsatisfied", message, node_id: nodeId }];
		},
	);
	return { problems, infos };
}

/**
 * 派发时解析任务通过「Agent」类型的输入引用的 Agent（ADR 0019）：输入已经解析，每台 Agent 一项（按第一次出现的顺序），
 * 地址和端口在这时用 {@link agentEndpoint} 取，所以 Agent 重新注册换了地址后，之后派发的任务用新地址。
 * 不要求在线：连不上时由节点调用能力时按「连不通」失败。没有注册过的 Agent 让任务以 config_error 失败；
 * 版本不满足节点包需要的 Agent 版本时以 env_error 失败（{@link checkReferencedAgents}）。
 */
export async function resolveReferencedAgents(
	tx: Tx,
	nodeId: string,
	io: NodeTypeMetadata["inputs"],
	inputs: Record<string, unknown>,
	requirement: AgentRequirement,
): Promise<
	{ agents: ReferencedAgentInit[] } | { problems: string[]; kind: "config_error" | "env_error" }
> {
	const wanted = referencedAgents(io, inputs).map((r) => ({ ...r, nodeId, requirement }));
	const { problems, infos } = await checkReferencedAgents(tx, wanted);
	const unregistered = problems.filter((p) => p.code === "agent_input_not_registered");
	if (unregistered.length > 0) {
		return { problems: unregistered.map((p) => p.message), kind: "config_error" };
	}
	if (problems.length > 0) return { problems: problems.map((p) => p.message), kind: "env_error" };
	return {
		agents: [...new Set(wanted.map((w) => w.agent))].map((name) => {
			const endpoint = agentEndpoint(infos.get(name) ?? {});
			return {
				name,
				address: endpoint.address,
				port: endpoint.port ?? 0,
				unavailableReason: endpoint.unavailable_reason ?? "",
			};
		}),
	};
}
