import { z } from "zod";
import { download, endpoint } from "./contract.js";

/**
 * Agent 二进制下载与一键安装脚本的契约（ADR 0011；约定见 ./contract.ts）。控制面带着与自己同版本的
 * x86_64 / aarch64 Agent，测试机用 `curl -fsSL <控制面>/install.sh | sh -s -- --name <名称>` 安装。
 */

/** Agent 的 CPU 架构（`uname -m` 的写法）。 */
export const AgentArch = z.enum(["x86_64", "aarch64"]);

/** 一个可下载的 Agent 二进制（musl 静态链接）。 */
export const AgentBinaryView = z.object({
	arch: AgentArch,
	version: z.string(),
	sha256: z.string(),
	/** 对 Agent 可见的完整下载地址。 */
	url: z.string(),
});

export const agentBinariesApi = {
	/** 控制面提供的 Agent 二进制，以及安装脚本的完整地址（Agents 页的接入命令用它）。 */
	list: endpoint({
		method: "GET",
		path: "/agent/binaries",
		raw: true,
		key: ["agent-binaries", "list"],
		response: z.object({
			/** 控制面版本（也是这里的 Agent 版本）。 */
			version: z.string(),
			install_script_url: z.string(),
			binaries: z.array(AgentBinaryView),
		}),
	}),
	/** 下载一个 Agent 二进制；版本或架构不存在时 404。 */
	binary: download({
		path: "/agent/binaries/:version/:arch",
		raw: true,
		params: z.object({ version: z.string(), arch: z.string() }),
		contentType: "application/octet-stream",
	}),
	/** 一键安装脚本：填好了控制面的 HTTP 地址、gRPC 地址、版本号和各架构 Agent 的 sha256。 */
	installScript: download({
		path: "/install.sh",
		raw: true,
		contentType: "text/plain; charset=utf-8",
	}),
};

export type AgentArch = z.infer<typeof AgentArch>;
export type AgentBinaryView = z.infer<typeof AgentBinaryView>;
