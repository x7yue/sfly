import type { AgentInfo } from "../db/schema.js";
import type { Mirrors } from "../public-config.js";

/**
 * Welcome 里让 Agent 的环境和控制面一致的部分：目标 Agent 版本（ADR 0014）、与 Agent 版本一致的 SDK 运行时 wheel、
 * 配置的镜像（ADR 0012）、控制面的包索引（#556）、目标版本在这个架构上的 Agent 二进制。没有的项为空串（控制面没有这个版本的 wheel、
 * 这个架构的二进制，没有配置镜像），Agent 按空串处理。它只取决于控制面的配置和 Agent 上报的版本、架构，和调度无关。
 */
export interface AgentEnvironment {
	sdkWheelUrl: string;
	sdkWheelSha256: string;
	pypiMirror: string;
	githubReleaseMirror: string;
	/** 控制面的包索引（`<对外地址>/simple/`）：Agent 装节点包的依赖时优先用它，平台自己的包（sfly-std）只从这里取。 */
	packageIndexUrl: string;
	targetAgentVersion: string;
	agentBinaryUrl: string;
	agentBinarySha256: string;
}

/**
 * 给 Agent 在 Hello 里上报的版本和架构，回答它的环境部分。`withCredentials` 是这条连接用的是不是 Agent 凭据：
 * 镜像地址里的用户名和密码只下发给带 Agent 凭据的连接（#494）；以旧方式连接的（共享令牌、没有凭据）拿到的是去掉了
 * 用户名和密码的地址，和不用登录就能读的地方（/install.sh）同一份。
 */
export type AgentEnvironmentFor = (
	agent: Pick<AgentInfo, "agent_version" | "arch">,
	connection: { withCredentials: boolean },
) => Promise<AgentEnvironment>;

export function createAgentEnvironment(sources: {
	/** 控制面版本，即 Agent 的目标版本。 */
	version: string;
	/** 与 Agent 版本一致的 SDK 运行时 wheel（#1 评审）；没有时为 undefined。 */
	sdkWheel: (agentVersion: string) => { url: string; sha256: string } | undefined;
	/** 控制面配置的镜像，原样下发给带 Agent 凭据的连接；未配置的为空。 */
	mirrors: Mirrors;
	/** 去掉了用户名和密码的镜像（`publicMirrors`），下发给以旧方式连接的；去不干净的不在里面，当作没配。 */
	publicMirrors: Mirrors;
	/** 控制面的包索引地址（对 Agent 可见，带末尾 `/`）。 */
	packageIndexUrl: () => string;
	/** 目标版本、给定架构的 Agent 二进制；没有时为 undefined。 */
	agentBinary: (arch: string) => Promise<{ url: string; sha256: string } | undefined>;
}): AgentEnvironmentFor {
	return async ({ agent_version, arch }, { withCredentials }) => {
		const sdk = sources.sdkWheel(agent_version);
		const binary = await sources.agentBinary(arch);
		const mirrors = withCredentials ? sources.mirrors : sources.publicMirrors;
		return {
			sdkWheelUrl: sdk?.url ?? "",
			sdkWheelSha256: sdk?.sha256 ?? "",
			pypiMirror: mirrors.pypi ?? "",
			githubReleaseMirror: mirrors.githubRelease ?? "",
			packageIndexUrl: sources.packageIndexUrl(),
			targetAgentVersion: sources.version,
			agentBinaryUrl: binary?.url ?? "",
			agentBinarySha256: binary?.sha256 ?? "",
		};
	};
}
