import { publicAddress } from "./userinfo.js";

/**
 * 控制面配置的镜像（ADR 0012）：在 Welcome 里下发给 Agent，install.sh --dev、sfly init 也用；未配置时 undefined。
 * 配置的地址可以带用户名和密码；Welcome 里原样下发（那里是不是经过认证见 docs/guide/install-agent.md「带用户名和密码的私有索引」：
 * 过渡期没配共享令牌时，连得上 Agent 网关、又知道旧方式登记的名字的连接也拿得到），不用登录就能读的地方用 {@link publicMirrors} 的结果。
 */
export interface Mirrors {
	/** PyPI 镜像（简单索引地址）。 */
	pypi?: string;
	/** GitHub Release 镜像。 */
	githubRelease?: string;
}

/**
 * 镜像地址去掉用户名和密码，给不用登录就能读的地方（`/install.sh`、`/sdk/project-settings`，#755）：按单个地址去，去完解析一遍
 * 还有用户名或密码的不公开（{@link publicAddress}），记在 `withheld` 里：调用方打一条警告（只写是哪个镜像，不写地址），
 * 公开的地方当它没配。没带凭据的地址原样（包括 `file://` 和绝对路径）。
 */
export function publicMirrors(mirrors: Mirrors): {
	mirrors: Mirrors;
	withheld: Array<keyof Mirrors>;
} {
	const shown: Mirrors = {};
	const withheld: Array<keyof Mirrors> = [];
	for (const key of ["pypi", "githubRelease"] as const) {
		const address = mirrors[key];
		if (address === undefined) continue;
		const safe = publicAddress(address);
		if (safe === undefined) withheld.push(key);
		else shown[key] = safe;
	}
	return { mirrors: shown, withheld };
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
	/** 公开的镜像地址：已经去掉用户名和密码（{@link publicMirrors}）；不用登录就能读的地方只能用它，不能用配置的原值。 */
	mirrors: Mirrors;
}
