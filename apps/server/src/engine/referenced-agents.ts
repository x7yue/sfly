import type { MessageInitShape } from "@bufbuild/protobuf";
import { agentNotRegistered, referencedAgents } from "@sfly/orchestration";
import type { ReferencedAgentSchema } from "@sfly/proto";
import type { NodeTypeMetadata } from "@sfly/schema";
import { inArray } from "drizzle-orm";
import { agentEndpoint } from "../agents/agent-endpoint.js";
import { agents } from "../db/schema.js";
import type { Tx } from "./step.js";

export type ReferencedAgentInit = MessageInitShape<typeof ReferencedAgentSchema>;

/**
 * 派发时解析任务通过「Agent」类型的输入引用的 Agent（ADR 0019）：输入已经解析，每台 Agent 一项（按第一次出现的顺序），
 * 地址和端口在这时用 {@link agentEndpoint} 取，所以 Agent 重新注册换了地址后，之后派发的任务用新地址。
 * 不要求在线：连不上时由节点调用能力时按「连不通」失败。没有注册过的 Agent 返回问题（任务以 config_error 失败）。
 */
export async function resolveReferencedAgents(
	tx: Tx,
	nodeId: string,
	io: NodeTypeMetadata["inputs"],
	inputs: Record<string, unknown>,
): Promise<{ agents: ReferencedAgentInit[] } | { problems: string[] }> {
	const wanted = referencedAgents(io, inputs);
	if (wanted.length === 0) return { agents: [] };
	const names = [...new Set(wanted.map((w) => w.agent))];
	const rows = await tx
		.select({ name: agents.name, info: agents.info })
		.from(agents)
		.where(inArray(agents.name, names));
	const infos = new Map(rows.map((r) => [r.name, r.info]));
	const problems = wanted
		.filter((w) => !infos.has(w.agent))
		.map((w) => agentNotRegistered(nodeId, w.input, w.agent));
	if (problems.length > 0) return { problems };
	return {
		agents: names.map((name) => {
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
