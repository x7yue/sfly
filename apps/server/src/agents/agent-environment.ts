import type { AgentInfo } from "../db/schema.js";
import type { Mirrors } from "../public-config.js";

/**
 * Welcome 里让 Agent 的环境和控制面一致的部分：目标 Agent 版本（ADR 0014）、与 Agent 版本一致的 SDK 运行时 wheel、
 * 配置的镜像（ADR 0012）、目标版本在这个架构上的 Agent 二进制。没有的项为空串（控制面没有这个版本的 wheel、
 * 这个架构的二进制，没有配置镜像），Agent 按空串处理。它只取决于控制面的配置和 Agent 上报的版本、架构，和调度无关。
 */
export interface AgentEnvironment {
	sdkWheelUrl: string;
	sdkWheelSha256: string;
	pypiMirror: string;
	githubReleaseMirror: string;
	targetAgentVersion: string;
	agentBinaryUrl: string;
	agentBinarySha256: string;
}

/** 给 Agent 在 Hello 里上报的版本和架构，回答它的环境部分。 */
export type AgentEnvironmentFor = (
	agent: Pick<AgentInfo, "agent_version" | "arch">,
) => Promise<AgentEnvironment>;

export function createAgentEnvironment(sources: {
	/** 控制面版本，即 Agent 的目标版本。 */
	version: string;
	/** 与 Agent 版本一致的 SDK 运行时 wheel（#1 评审）；没有时为 undefined。 */
	sdkWheel: (agentVersion: string) => { url: string; sha256: string } | undefined;
	/** 控制面配置的镜像，原样下发；未配置的为空。 */
	mirrors: Mirrors;
	/** 目标版本、给定架构的 Agent 二进制；没有时为 undefined。 */
	agentBinary: (arch: string) => Promise<{ url: string; sha256: string } | undefined>;
}): AgentEnvironmentFor {
	return async ({ agent_version, arch }) => {
		const sdk = sources.sdkWheel(agent_version);
		const binary = await sources.agentBinary(arch);
		return {
			sdkWheelUrl: sdk?.url ?? "",
			sdkWheelSha256: sdk?.sha256 ?? "",
			pypiMirror: sources.mirrors.pypi ?? "",
			githubReleaseMirror: sources.mirrors.githubRelease ?? "",
			targetAgentVersion: sources.version,
			agentBinaryUrl: binary?.url ?? "",
			agentBinarySha256: binary?.sha256 ?? "",
		};
	};
}
