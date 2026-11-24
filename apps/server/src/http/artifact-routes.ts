import { createReadStream } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { AGENT_MODIFIED_MS_HEADER, artifactsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { recordableAgentTimeMs } from "../agents/agent-clock.js";
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
 * | PUT | `/tasks/:id/artifacts/<name>` | Agent 上传（请求体是文件内容）；配置了注册令牌时需要 `Authorization: Bearer <token>`；`x-sfly-agent-modified-ms` 头是文件在 Agent 上的修改时间，可以不带。201 → 产物 |
 * | GET | `/tasks/:id/artifacts` | `{ task_id, artifacts: [{name, size, sha256, created_at, agent_modified_at, url}], expired }`（契约：artifactsApi.list） |
 * | GET | `/tasks/:id/artifacts/<name>` | 下载（attachment）；运行已过保留期被清理时 410 `expired` |
 *
 * `<name>` 是产物目录内的相对路径，每个路径段单独百分号编码。`url` 是对 Agent 可见的完整下载地址，
 * 与 SDK `ctx.artifacts.save()` 返回、节点写进输出里的引用相同。
 */
/**
 * 上传请求头里的 Agent 修改时间（Unix 毫秒）。它是被测机器上的事实，不拿控制面时间检查范围（ADR 0018），
 * 超出能记录的范围时记成边界值（{@link recordableAgentTimeMs}）；没带（旧版本 Agent）或不是整数时为 null。
 * 上传都照常成功。
 */
function agentModifiedAt(header: string | string[] | undefined): Date | null {
	if (typeof header !== "string" || !/^-?\d+$/.test(header)) return null;
	return new Date(recordableAgentTimeMs(Number(header)));
}

/** 请求声明的请求体长度（Content-Length）；没带或不是整数时为 undefined（分块传输等）。 */
function declaredLength(header: string | string[] | undefined): number | undefined {
	if (typeof header !== "string" || !/^\d+$/.test(header)) return undefined;
	const length = Number(header);
	return Number.isSafeInteger(length) ? length : undefined;
}

export function registerArtifactRoutes(
	app: FastifyInstance,
	deps: { artifacts: ArtifactStore; agentToken?: string; publicHttpUrl: () => string },
): void {
	const view = (a: ArtifactRow) => ({
		name: a.name,
		size: a.size,
		sha256: a.sha256,
		created_at: a.createdAt.toISOString(),
		agent_modified_at: a.agentModifiedAt?.toISOString() ?? null,
		url: artifactUrl(deps.publicHttpUrl(), a.taskId, a.name),
	});
	const authorized = (header: string | undefined) =>
		agentTokenMatches(deps.agentToken, bearerToken(header));

	// 上传在独立的作用域里：请求体不解析，按原始的字节流写到磁盘（不受全局 bodyLimit 限制，大小由 ArtifactStore 控制）。
	// **不管 `Content-Type` 写的是什么**都按字节流收（#665）：框架自带的 `text/plain` 和 JSON 解析器会在到达存储之前把请求体读成字符串
	// 或对象（按字符数记大小、按重新编码后的字节存，非法的 UTF-8 变成替换字符；JSON 是对象或数时回 500，`null` 存成空文件），
	// 所以把它们和别的解析器都去掉，只留这一个「原样交出字节流」的（`removeAllContentTypeParsers`）；钩子再把请求里**带了的**
	// `Content-Type`（不管写的是什么）在解析之前一律改成字节流：写得不成样子的（框架在解析之前就回 415）也一样放行。
	// 两道各有各的用：单独去掉解析器这一道行为不变（钩子已经让所有请求落到 `*`），留着它是把意图写在代码里、钩子以后被改窄时还能兜住；
	// 去掉钩子则写得不成样子的 `Content-Type` 回到 415。`Content-Type` 对上传没有意义，内容是什么就存什么。
	app.register(async (scope) => {
		scope.removeAllContentTypeParsers();
		scope.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
		scope.addHook("onRequest", async (request) => {
			if (request.raw.headers["content-type"] !== undefined) {
				request.raw.headers["content-type"] = "application/octet-stream";
			}
		});
		contractRoute(scope, artifactsApi.upload, async ({ params }, reply, request) => {
			// 带了凭据的请求（Agent 凭据）已经过了访问检查；共享令牌和不带凭据的请求照旧核对共享令牌（#494 之前）。
			if (!request.access && !authorized(request.headers.authorization)) {
				request.raw.resume();
				return sendError(reply, 401, "unauthorized", "invalid agent token");
			}
			const taskId = params.id;
			if (!isUuid(taskId)) {
				request.raw.resume();
				return sendError(reply, 404, "not_found", "task not found");
			}
			const body = (request.body as Readable | undefined) ?? request.raw;
			const outcome = await deps.artifacts.save(
				taskId,
				params["*"],
				body,
				agentModifiedAt(request.headers[AGENT_MODIFIED_MS_HEADER]),
				declaredLength(request.headers["content-length"]),
			);
			if (!outcome.ok) {
				// 按声明的长度在读请求体之前就拒绝的：不把几百 MB 的请求体读完，回了响应就关掉连接。
				if (outcome.unread) reply.header("connection", "close");
				else body.resume();
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
