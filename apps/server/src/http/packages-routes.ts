import { createReadStream } from "node:fs";
import { packagesApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import { packageLocks } from "../orchestrations/usage.js";
import {
	PackageError,
	type PackageRepository,
	type PackageSummary,
} from "../packages/package-repository.js";
import { type ProjectId, pathProject } from "../projects/project-id.js";
import { contractDownload, contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/** 节点包归档上传上限。 */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

const notFound = (reply: FastifyReply, message: string) =>
	sendError(reply, 404, "not_found", message);

/**
 * 节点包 API（契约见 @sfly/schema 的 packagesApi），都在 `/projects/:project` 下，项目从路径里取（#488）：
 *   POST /packages                                         发布（请求体为 .sflypkg 原始字节）
 *   GET  /packages                                         包列表（含各版本、节点类型摘要与锁定数）
 *   GET  /packages/:name                                   单个包的版本列表（同上）
 *   GET  /packages/:name/versions/:version                 版本详情（含完整元信息）
 *   GET  /packages/:name/versions/:version/nodes/:node     节点类型元信息
 *   GET  /packages/:name/versions/:version/archive         下载归档（x-sfly-sha256 头）
 * 读的是这个项目和公共项目里的包；发布到公共项目只有平台管理员能做（访问检查里校验）。
 */
export function registerPackageRoutes(
	app: FastifyInstance,
	{ packages, orchestrations }: { packages: PackageRepository; orchestrations: OrchestrationStore },
): void {
	app.register(async (scope) => {
		scope.addContentTypeParser(
			"application/octet-stream",
			{ parseAs: "buffer", bodyLimit: MAX_ARCHIVE_BYTES },
			(_req, body, done) => done(null, body),
		);

		contractRoute(scope, packagesApi.publish, async ({ params }, reply, req) => {
			// 带了凭据的发布记下发布人；不带凭据的（#494 之前照旧放行）没有。
			const { access } = req;
			const publisher = access && {
				name: access.name,
				userId: access.userId,
				token: access.tokenName,
			};
			if (!(req.body instanceof Buffer)) {
				return sendError(
					reply,
					415,
					"unsupported_media_type",
					"请求体必须是 application/octet-stream 的节点包归档",
				);
			}
			try {
				const published = await packages.publish(
					pathProject(params),
					new Uint8Array(req.body),
					publisher ?? null,
				);
				reply.code(201);
				return published;
			} catch (error) {
				if (error instanceof PackageError) {
					return sendError(reply, error.kind === "conflict" ? 409 : 400, error.kind, error.message);
				}
				throw error;
			}
		});
	});

	// 锁定数随各场景的最新版本变化，查询时现算。
	const withLocks = async (project: ProjectId, summaries: PackageSummary[]) => {
		const locks = packageLocks(await orchestrations.rawHeadDocuments(project));
		return summaries.map((pkg) => ({
			...pkg,
			versions: pkg.versions.map((v) => ({
				...v,
				locked_orchestrations: locks.get(`${pkg.name}@${v.version}`) ?? 0,
			})),
		}));
	};

	contractRoute(app, packagesApi.list, async ({ params }) => {
		const project = pathProject(params);
		return { packages: await withLocks(project, await packages.list(project)) };
	});

	contractRoute(app, packagesApi.get, async ({ params }, reply) => {
		const project = pathProject(params);
		const pkg = await packages.get(project, params.name);
		if (!pkg) return notFound(reply, `节点包 ${params.name} 不存在`);
		const [view] = await withLocks(project, [pkg]);
		return view ?? notFound(reply, `节点包 ${params.name} 不存在`);
	});

	contractRoute(app, packagesApi.version, async ({ params }, reply) => {
		const { name, version } = params;
		const found = await packages.getVersion(pathProject(params), name, version);
		return found ?? notFound(reply, `节点包 ${name}@${version} 不存在`);
	});

	contractRoute(app, packagesApi.nodeType, async ({ params }, reply) => {
		const { name, version, node } = params;
		const found = await packages.getVersion(pathProject(params), name, version);
		const nodeType = found?.metadata.nodes.find((n) => n.name === node);
		return nodeType ?? notFound(reply, `节点类型 ${name}/${node}（${version}）不存在`);
	});

	contractDownload(app, packagesApi.archive, async ({ params }, reply) => {
		const { name, version } = params;
		const stored = await packages.archive(pathProject(params), name, version);
		if (!stored) return notFound(reply, `节点包 ${name}@${version} 不存在`);
		return reply
			.type(packagesApi.archive.contentType)
			.header("x-sfly-sha256", stored.sha256)
			.header("content-disposition", `attachment; filename="${name}-${version}.sflypkg"`)
			.send(createReadStream(stored.path));
	});
}
