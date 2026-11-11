import type { PackageMetadata } from "@sfly/schema";
import { satisfiesSdk } from "./requires-sdk.js";

/**
 * 节点包声明的最低 Agent 版本（`requires_agent`，ADR 0019）：用到 Agent 能力的节点包声明它，格式与比较规则同
 * `requires_sdk`（{@link satisfiesSdk}）。对两种 Agent 检查，阻断时写明是哪台、需要哪个版本：
 *
 * - 节点所在的 Agent：触发前比较控制面版本（只给与控制面同版本的 Agent 派任务，ADR 0014，它会先自更新到控制面的版本），
 *   派发前比较它连接时上报的版本；
 * - 节点通过「Agent」类型的输入引用的 Agent：比较它最近一次注册时上报的版本（它不执行这个任务，不会因此自更新）。
 *
 * 没有声明的节点包不检查。
 */

type Metadata = Pick<PackageMetadata, "requires_agent">;
type Package = { name: string; version: string };

function unsatisfied(metadata: Metadata, version: string): string | undefined {
	const requirement = metadata.requires_agent;
	if (requirement === undefined || satisfiesSdk(version, requirement)) return undefined;
	return requirement;
}

/** 触发前：节点所在的 Agent 会先自更新到控制面的版本，所以比较控制面版本；不满足时要升级的是控制面。 */
export function controlPlaneAgentProblem(
	metadata: Metadata,
	pkg: Package,
	agent: string,
	controlPlaneVersion: string,
): string | undefined {
	const requirement = unsatisfied(metadata, controlPlaneVersion);
	if (requirement === undefined) return undefined;
	return `节点包 ${pkg.name}@${pkg.version} 需要 Agent ${requirement}，节点所在的 Agent ${agent} 会先自更新到控制面的版本 ${controlPlaneVersion}：请升级控制面`;
}

/** 派发前：节点所在的 Agent 连接时上报的版本。 */
export function agentRequirementProblem(
	metadata: Metadata,
	pkg: Package,
	agent: { name: string; version: string },
): string | undefined {
	const requirement = unsatisfied(metadata, agent.version);
	if (requirement === undefined) return undefined;
	return `节点包 ${pkg.name}@${pkg.version} 需要 Agent ${requirement}，节点所在的 Agent ${agent.name} 的版本是 ${agent.version}：请升级 Agent ${agent.name}`;
}

/** 节点通过「Agent」类型的输入 `input` 引用的 Agent（最近一次注册时上报的版本）。 */
export function referencedAgentProblem(
	metadata: Metadata,
	pkg: Package,
	input: string,
	agent: { name: string; version: string },
): string | undefined {
	const requirement = unsatisfied(metadata, agent.version);
	if (requirement === undefined) return undefined;
	return `节点包 ${pkg.name}@${pkg.version} 需要 Agent ${requirement}，参数 ${input} 选的 Agent ${agent.name} 的版本是 ${agent.version}：请升级 Agent ${agent.name}`;
}
