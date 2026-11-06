/** 控制面配置的镜像（ADR 0012）：在 Welcome 里下发给 Agent，install.sh --dev、sfly init 也用；未配置时 undefined。 */
export interface Mirrors {
	/** PyPI 镜像（简单索引地址）。 */
	pypi?: string;
	/** GitHub Release 镜像。 */
	githubRelease?: string;
}

/**
 * 控制面对外公开的配置：Agent 和开发机看到的地址、版本号和镜像。Agent 下载与 install.sh、SDK wheel 与 sfly 简单索引、
 * 用户文档的占位符都从这里取值。地址在监听之后才确定，所以是函数。
 */
export interface PublicConfig {
	/** HTTP API 对 Agent 和开发机可见的地址（不带末尾的 /）。 */
	httpUrl: () => string;
	/** Agent gRPC 网关对 Agent 可见的地址（install.sh 写进 agent.env）。 */
	grpcUrl: () => string;
	/** 控制面版本号（Agent、SDK 与控制面同版本，ADR 0010）。 */
	version: string;
	mirrors: Mirrors;
}
