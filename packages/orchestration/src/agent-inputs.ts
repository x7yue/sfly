import type { NodeTypeMetadata, OrchestrationDocument } from "@sfly/schema";
import { inputsOfType, isInputOfType, namesInInputs } from "./input-types.js";
import { nodeNameWithId } from "./node-display.js";
import { nodeTypeOf, type PackageCatalog, referencesIn } from "./references.js";

/**
 * 「Agent」类型的输入（ADR 0019）：节点开发者用 `sfly.AgentName` 标注的参数，表示节点会访问这台 Agent。
 * 值是 Agent 名称字符串，可以是常量，也可以引用入口参数。`sfly build` 在输入 schema 里标记它：
 * `{"type": "string", "x-sfly-type": "agent"}`，可选参数（`AgentName | None`）是 anyOf 里的一项。
 *
 * - 静态检查（保存时警告，触发时阻断）：常量必须是已注册的 Agent（{@link agentInputWarnings}）；
 * - 引用入口参数的，触发时按实际值检查；派发时按解析后的值检查，并把这些 Agent 的地址随任务下发（控制面）。
 */

type Io = NodeTypeMetadata["inputs"];
type JsonSchema = Record<string, unknown>;

/** 输入 schema 里标记「Agent」类型的值（`x-sfly-type`，与 sdk/python/src/sfly/cli/scan.py 一致）。 */
export const AGENT_INPUT_TYPE = "agent";

/** 这个输入是不是「Agent」类型（`AgentName`，或 `AgentName | None`）。 */
export const isAgentInput = (schema: JsonSchema): boolean =>
	isInputOfType(schema, AGENT_INPUT_TYPE);

/** 节点类型里「Agent」类型的输入名（按参数顺序）。 */
export const agentInputs = (io: Io): string[] => inputsOfType(io, AGENT_INPUT_TYPE);

/** 已解析的输入里，「Agent」类型的输入引用的 Agent：每个值不为空的字符串一项（null、其他类型留给类型检查）。 */
export function referencedAgents(
	io: Io,
	inputs: Record<string, unknown>,
): { input: string; agent: string }[] {
	return namesInInputs(io, inputs, AGENT_INPUT_TYPE).map(({ input, name }) => ({
		input,
		agent: name,
	}));
}

export interface AgentInputWarning {
	code: "agent_input_not_registered";
	message: string;
	node_id: string;
	input: string;
}

/**
 * 「Agent」类型的输入选的 Agent 没有注册过时的说明（静态检查、触发和派发时共用）。
 * `node` 是节点的名字：节点 ID，静态检查写成「显示名称（节点 ID）」（{@link nodeNameWithId}）。
 */
export function agentNotRegistered(node: string, input: string, agent: string): string {
	return `节点 ${node} 的输入 ${input} 选择的 Agent ${agent} 还没有注册过`;
}

/**
 * 「Agent」类型的输入的静态检查：常量必须是已注册的 Agent（`agents`，不要求在线）。
 * 含引用的值在触发、派发时才知道；节点类型未知时跳过（包版本检查会指出）。
 */
export function agentInputWarnings(
	doc: OrchestrationDocument,
	catalog: PackageCatalog,
	agents: ReadonlySet<string>,
): AgentInputWarning[] {
	const warnings: AgentInputWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "package") continue;
		const type = nodeTypeOf(doc, node, catalog);
		if (!type) continue;
		for (const { input, agent } of referencedAgents(type.inputs, node.inputs)) {
			if (referencesIn(agent).length > 0 || agents.has(agent)) continue;
			warnings.push({
				code: "agent_input_not_registered",
				message: agentNotRegistered(nodeNameWithId(node), input, agent),
				node_id: node.id,
				input,
			});
		}
	}
	return warnings;
}
