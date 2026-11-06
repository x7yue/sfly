import { createReadStream } from "node:fs";
import { agentBinariesApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type AgentBinaries, agentBinaryUrl } from "../agent-binaries/agent-binaries.js";
import { renderInstallScript } from "../agent-binaries/install-script.js";
import { attachment } from "./content-disposition.js";
import { contractDownload, contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * Agent 二进制下载与一键安装脚本（ADR 0011；契约见 @sfly/schema 的 agentBinariesApi）。
 * 测试机用 curl 访问根路径：
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/agent/binaries` | `{ version, install_script_url, binaries: [{ arch, version, sha256, url }] }` |
 * | GET | `/agent/binaries/:version/:arch` | 下载 Agent 二进制 |
 * | GET | `/install.sh` | 安装脚本，填好了控制面地址、版本号和 sha256 |
 */
export function registerAgentBinaryRoutes(
	app: FastifyInstance,
	deps: {
		binaries: AgentBinaries;
		installScript: string;
		version: string;
		publicHttpUrl: () => string;
		publicGrpcUrl: () => string;
		mirrors: { pypi?: string; githubRelease?: string };
	},
): void {
	contractRoute(app, agentBinariesApi.list, async () => {
		const base = deps.publicHttpUrl();
		return {
			version: deps.version,
			install_script_url: `${base}/install.sh`,
			binaries: (await deps.binaries.list()).map((b) => ({
				arch: b.arch,
				version: b.version,
				sha256: b.sha256,
				url: agentBinaryUrl(base, b),
			})),
		};
	});

	contractDownload(app, agentBinariesApi.binary, async ({ params: { version, arch } }, reply) => {
		const binary = await deps.binaries.find(version, arch);
		if (!binary) return sendError(reply, 404, "not_found", `没有 ${arch} 架构的 Agent ${version}`);
		return reply
			.header("content-type", agentBinariesApi.binary.contentType)
			.header("content-disposition", attachment("sfly-agent"))
			.send(createReadStream(binary.file));
	});

	contractDownload(app, agentBinariesApi.installScript, async (_request, reply) => {
		const binaries = await deps.binaries.list();
		const sha256 = (arch: string) => binaries.find((b) => b.arch === arch)?.sha256 ?? "";
		return reply
			.header("content-type", agentBinariesApi.installScript.contentType)
			.header("cache-control", "no-cache")
			.send(
				renderInstallScript(deps.installScript, {
					SFLY_URL: deps.publicHttpUrl(),
					SFLY_GRPC_URL: deps.publicGrpcUrl(),
					SFLY_VERSION: deps.version,
					SHA256_X86_64: sha256("x86_64"),
					SHA256_AARCH64: sha256("aarch64"),
					PYPI_MIRROR: deps.mirrors.pypi ?? "",
					GITHUB_RELEASE_MIRROR: deps.mirrors.githubRelease ?? "",
				}),
			);
	});
}
