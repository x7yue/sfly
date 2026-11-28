import { sessionBuildsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import { PackageError, type PackageRepository } from "../packages/package-repository.js";
import type { SessionStore } from "../sessions/session-store.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";
import { MAX_ARCHIVE_BYTES } from "./packages-routes.js";

const sessionNotFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "session not found");

/**
 * 会话构建（契约见 @sfly/schema 的 sessionBuildsApi，#795）：登记在会话下、列出会话的会话构建。
 * 访问检查在进处理函数之前已经按会话所在的项目判断过，会话令牌只能访问自己的会话。会话构建属于会话所在的项目，
 * 和正式版本存在同一张表里（`node_packages.session_id`），派发、下载、安装走同一条路。
 */
export function registerSessionBuildRoutes(
	app: FastifyInstance,
	{ packages, sessions }: { packages: PackageRepository; sessions: SessionStore },
): void {
	app.register(async (scope) => {
		scope.addContentTypeParser(
			"application/octet-stream",
			{ parseAs: "buffer", bodyLimit: MAX_ARCHIVE_BYTES },
			(_req, body, done) => done(null, body),
		);

		contractRoute(scope, sessionBuildsApi.register, async ({ params }, reply, req) => {
			const session = await sessions.find(params.id);
			if (!session) return sessionNotFound(reply);
			if (!(req.body instanceof Buffer)) {
				return sendError(
					reply,
					415,
					"unsupported_media_type",
					"请求体必须是 application/octet-stream 的节点包归档",
				);
			}
			const { access } = req;
			const publisher = access && {
				name: access.name,
				userId: access.userId,
				token: access.tokenName,
			};
			try {
				const registered = await packages.publish(
					session.projectId,
					new Uint8Array(req.body),
					publisher ?? null,
					{ id: session.id },
				);
				reply.code(201);
				return {
					name: registered.name,
					version: registered.version,
					sha256: registered.sha256,
					size: registered.size,
					registered_at: registered.published_at,
				};
			} catch (error) {
				if (error instanceof PackageError) {
					return sendError(
						reply,
						error.kind === "invalid_package" ? 400 : 409,
						error.kind,
						error.message,
					);
				}
				throw error;
			}
		});
	});

	contractRoute(app, sessionBuildsApi.list, async ({ params }, reply) => {
		const session = await sessions.find(params.id);
		if (!session) return sessionNotFound(reply);
		return { builds: await packages.sessionBuilds(session.id) };
	});
}
