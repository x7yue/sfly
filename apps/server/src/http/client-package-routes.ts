import { createReadStream } from "node:fs";
import { clientPackageApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type ClientTarball, clientTarballUrl } from "../downloads/client-tarballs.js";
import type { PublicConfig } from "../public-config.js";
import { attachment } from "./content-disposition.js";
import { contractDownload, contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * API 客户端安装包的下载（ADR 0022，用户用包管理器直接装下载地址；契约见 @sfly/schema 的 clientPackageApi）：
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/client` | `{ tarballs: [{ version, filename, sha256, url }] }` |
 * | GET | `/client/:version/:filename` | 下载 tarball |
 */
export function registerClientPackageRoutes(
	app: FastifyInstance,
	{ tarballs, publicConfig }: { tarballs: readonly ClientTarball[]; publicConfig: PublicConfig },
): void {
	contractRoute(app, clientPackageApi.list, async () => ({
		tarballs: tarballs.map((t) => ({
			version: t.version,
			filename: t.filename,
			sha256: t.sha256,
			url: clientTarballUrl(publicConfig.httpUrl(), t),
		})),
	}));

	contractDownload(app, clientPackageApi.download, async ({ params }, reply) => {
		const tarball = tarballs.find(
			(t) => t.version === params.version && t.filename === params.filename,
		);
		if (!tarball) return sendError(reply, 404, "not_found", "API client package not found");
		return reply
			.header("content-type", clientPackageApi.download.contentType)
			.header("content-disposition", attachment(tarball.filename))
			.send(createReadStream(tarball.file));
	});
}
