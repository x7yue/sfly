import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { PackageError, type PackageRepository } from "../packages/package-repository.js";
import { sendError } from "./errors.js";

/** 节点包归档上传上限。 */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

interface VersionParams {
	name: string;
	version: string;
}

const notFound = (reply: FastifyReply, message: string) =>
	sendError(reply, 404, "not_found", message);

/**
 * 节点包 API：
 *   POST /packages                                         发布（请求体为 .sflypkg 原始字节）
 *   GET  /packages                                         包列表（含各版本与节点类型摘要）
 *   GET  /packages/:name                                   单个包的版本列表
 *   GET  /packages/:name/versions/:version                 版本详情（含完整元信息）
 *   GET  /packages/:name/versions/:version/nodes/:node     节点类型元信息
 *   GET  /packages/:name/versions/:version/archive         下载归档（x-sfly-sha256 头）
 */
export function registerPackageRoutes(app: FastifyInstance, packages: PackageRepository): void {
	app.register(async (scope) => {
		scope.addContentTypeParser(
			"application/octet-stream",
			{ parseAs: "buffer", bodyLimit: MAX_ARCHIVE_BYTES },
			(_req, body, done) => done(null, body),
		);

		scope.post("/packages", async (req, reply) => {
			if (!(req.body instanceof Buffer)) {
				return sendError(
					reply,
					415,
					"unsupported_media_type",
					"请求体必须是 application/octet-stream 的节点包归档",
				);
			}
			try {
				const published = await packages.publish(new Uint8Array(req.body));
				return reply.code(201).send(published);
			} catch (error) {
				if (error instanceof PackageError) {
					return sendError(reply, error.kind === "conflict" ? 409 : 400, error.kind, error.message);
				}
				throw error;
			}
		});
	});

	app.get("/packages", async () => ({ packages: await packages.list() }));

	app.get<{ Params: { name: string } }>("/packages/:name", async (req, reply) => {
		const pkg = await packages.get(req.params.name);
		return pkg ?? notFound(reply, `节点包 ${req.params.name} 不存在`);
	});

	app.get<{ Params: VersionParams }>("/packages/:name/versions/:version", async (req, reply) => {
		const { name, version } = req.params;
		const found = await packages.getVersion(name, version);
		return found ?? notFound(reply, `节点包 ${name}@${version} 不存在`);
	});

	app.get<{ Params: VersionParams & { node: string } }>(
		"/packages/:name/versions/:version/nodes/:node",
		async (req, reply) => {
			const { name, version, node } = req.params;
			const found = await packages.getVersion(name, version);
			const nodeType = found?.metadata.nodes.find((n) => n.name === node);
			return nodeType ?? notFound(reply, `节点类型 ${name}/${node}（${version}）不存在`);
		},
	);

	app.get<{ Params: VersionParams }>(
		"/packages/:name/versions/:version/archive",
		async (req, reply) => {
			const { name, version } = req.params;
			const stored = await packages.archive(name, version);
			if (!stored) return notFound(reply, `节点包 ${name}@${version} 不存在`);
			return reply
				.type("application/octet-stream")
				.header("x-sfly-sha256", stored.sha256)
				.header("content-disposition", `attachment; filename="${name}-${version}.sflypkg"`)
				.send(createReadStream(stored.path));
		},
	);
}
