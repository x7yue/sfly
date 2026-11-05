import { createReadStream } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { artifactsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { agentTokenMatches, bearerToken } from "../agents/agent-token.js";
import { type ArtifactRow, type ArtifactStore, artifactUrl } from "../artifacts/artifact-store.js";
import { isUuid } from "../util/uuid.js";
import { attachment } from "./content-disposition.js";
import { contractDownload, contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * 产物（#18；契约见 @sfly/schema 的 artifactsApi）：
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | PUT | `/tasks/:id/artifacts/<name>` | Agent 上传（请求体是文件内容）；配置了注册令牌时需要 `Authorization: Bearer <token>`。201 → 产物 |
 * | GET | `/tasks/:id/artifacts` | `{ task_id, artifacts: [{name, size, sha256, created_at, url}], expired }`（契约：artifactsApi.list） |
 * | GET | `/tasks/:id/artifacts/<name>` | 下载（attachment）；运行已过保留期被清理时 410 `expired` |
 *
 * `<name>` 是产物目录内的相对路径，每个路径段单独百分号编码。`url` 是对 Agent 可见的完整下载地址，
 * 与 SDK `ctx.artifacts.save()` 返回、节点写进输出里的引用相同。
 */
export function registerArtifactRoutes(
	app: FastifyInstance,
	deps: { artifacts: ArtifactStore; agentToken?: string; publicHttpUrl: () => string },
): void {
	const view = (a: ArtifactRow) => ({
		name: a.name,
		size: a.size,
		sha256: a.sha256,
		created_at: a.createdAt.toISOString(),
		url: artifactUrl(deps.publicHttpUrl(), a.taskId, a.name),
	});
	const authorized = (header: string | undefined) =>
		agentTokenMatches(deps.agentToken, bearerToken(header));

	// 上传在独立的作用域里：请求体不解析，按流写到磁盘（不受全局 bodyLimit 限制，大小由 ArtifactStore 控制）。
	app.register(async (scope) => {
		scope.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
		contractRoute(scope, artifactsApi.upload, async ({ params }, reply, request) => {
			if (!authorized(request.headers.authorization)) {
				request.raw.resume();
				return sendError(reply, 401, "unauthorized", "invalid agent token");
			}
			const taskId = params.id;
			if (!isUuid(taskId)) {
				request.raw.resume();
				return sendError(reply, 404, "not_found", "task not found");
			}
			const body = (request.body as Readable | undefined) ?? request.raw;
			const outcome = await deps.artifacts.save(taskId, params["*"], body);
			if (!outcome.ok) {
				body.resume();
				return sendError(reply, outcome.status, outcome.code, outcome.message);
			}
			reply.code(201);
			return view(outcome.artifact);
		});
	});

	contractRoute(app, artifactsApi.list, async ({ params }, reply) => {
		const found = isUuid(params.id) ? await deps.artifacts.list(params.id) : undefined;
		if (!found) return sendError(reply, 404, "not_found", "task not found");
		return { task_id: params.id, artifacts: found.artifacts.map(view), expired: found.expired };
	});

	contractDownload(app, artifactsApi.download, async ({ params }, reply) => {
		const taskId = params.id;
		const found = isUuid(taskId) ? await deps.artifacts.get(taskId, params["*"]) : undefined;
		if (found === "expired") {
			return sendError(reply, 410, "expired", "artifacts of this run were removed after retention");
		}
		if (!found) return sendError(reply, 404, "not_found", "artifact not found");
		return reply
			.header("content-type", artifactsApi.download.contentType)
			.header("content-length", found.size)
			.header("content-disposition", attachment(posix.basename(found.name)))
			.send(createReadStream(found.file));
	});
}
