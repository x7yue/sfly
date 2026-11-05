import { OrchestrationDocument, orchestrationsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database.js";
import { checkDocument } from "../orchestrations/document-checks.js";
import { listOrchestrationSummaries } from "../orchestrations/orchestration-list.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PackageRepository } from "../packages/package-repository.js";
import { isUuid } from "../util/uuid.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";
import { requireNickname } from "./nickname.js";

const SaveVersionBody = z.object({
	document: OrchestrationDocument,
	/** 编辑起点的版本号（新编排的第一个版本为 0）。必填；不是最新版本时返回 409。 */
	base_version: z.number().int().nonnegative(),
});

const notFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "orchestration not found");

/**
 * 场景（编排）与场景版本：新建、改名称和说明、归档与恢复、复制、场景列表（契约见 @sfly/schema 的
 * orchestrationsApi）；保存（追加）版本、查询版本。版本不可修改，场景不物理删除。
 */
export function registerOrchestrationRoutes(
	app: FastifyInstance,
	{
		db,
		orchestrations,
		packages,
	}: { db: Db; orchestrations: OrchestrationStore; packages: PackageRepository },
): void {
	contractRoute(app, orchestrationsApi.create, async ({ body }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		return reply.code(201).send(await orchestrations.create(body.name, body.description));
	});

	contractRoute(app, orchestrationsApi.list, ({ query }) => listOrchestrationSummaries(db, query));

	app.get<{ Params: { id: string } }>("/orchestrations/:id/head", async (request, reply) => {
		const head = isUuid(request.params.id)
			? await orchestrations.head(request.params.id)
			: undefined;
		if (!head) return notFound(reply);
		return head;
	});

	contractRoute(app, orchestrationsApi.copy, async ({ params, body }, reply, raw) => {
		const author = requireNickname(raw, reply);
		if (!author) return reply;
		const copied = isUuid(params.id)
			? await orchestrations.copy(params.id, body.name, author)
			: undefined;
		if (!copied) return notFound(reply);
		return reply.code(201).send(copied);
	});

	contractRoute(app, orchestrationsApi.get, async ({ params }, reply) => {
		const found = isUuid(params.id) ? await orchestrations.get(params.id) : undefined;
		return found ?? notFound(reply);
	});

	contractRoute(app, orchestrationsApi.update, async ({ params, body }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		const updated = isUuid(params.id) ? await orchestrations.update(params.id, body) : undefined;
		return updated ?? notFound(reply);
	});

	contractRoute(app, orchestrationsApi.archive, async ({ params }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		if (!isUuid(params.id)) return notFound(reply);
		const result = await orchestrations.archive(params.id);
		if (result.kind === "not_found") return notFound(reply);
		if (result.kind === "running") {
			return sendError(
				reply,
				409,
				"run_in_progress",
				`场景还有 ${result.count} 个运行中的运行，结束或取消后才能归档`,
				{ running: result.count },
			);
		}
		return result.orchestration;
	});

	contractRoute(app, orchestrationsApi.unarchive, async ({ params }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		const restored = isUuid(params.id) ? await orchestrations.unarchive(params.id) : undefined;
		return restored ?? notFound(reply);
	});

	app.post<{ Params: { id: string } }>("/orchestrations/:id/versions", async (request, reply) => {
		const author = requireNickname(request, reply);
		if (!author) return reply;
		const raw = request.body;
		if (raw === null || typeof raw !== "object" || !Object.hasOwn(raw, "base_version")) {
			return sendError(
				reply,
				400,
				"base_version_required",
				"base_version is required (use 0 for the first version)",
			);
		}
		const body = SaveVersionBody.safeParse(raw);
		if (!body.success) {
			return sendError(
				reply,
				400,
				"invalid_document",
				"document does not match the orchestration schema",
				z.treeifyError(body.error),
			);
		}
		const result = isUuid(request.params.id)
			? await orchestrations.saveVersion(
					request.params.id,
					body.data.document,
					author,
					body.data.base_version,
				)
			: ({ kind: "not_found" } as const);
		if (result.kind === "not_found")
			return sendError(reply, 404, "not_found", "orchestration not found");
		if (result.kind === "conflict") {
			return sendError(
				reply,
				409,
				"version_conflict",
				result.head
					? `version ${result.head.number} was saved by ${result.head.author} after version ${body.data.base_version}`
					: `orchestration has no version ${body.data.base_version}`,
				{ base_version: body.data.base_version, head: result.head },
			);
		}
		const saved = result.version;
		// 结构、包版本锁定和引用的问题只产生警告，不阻止保存（docs/SEMANTICS.md §1.2、§2.4）。
		return reply
			.code(201)
			.send({ ...saved, warnings: await checkDocument(saved.document, packages) });
	});

	app.get<{ Params: { id: string } }>("/orchestrations/:id/versions", async (request, reply) => {
		const versions = isUuid(request.params.id)
			? await orchestrations.listVersions(request.params.id)
			: undefined;
		if (!versions) return sendError(reply, 404, "not_found", "orchestration not found");
		return { versions };
	});

	// 恢复历史版本 = 用旧内容追加一个新版本（docs/ARCHITECTURE.md §6.4）。
	app.post<{ Params: { id: string; number: string } }>(
		"/orchestrations/:id/versions/:number/restore",
		async (request, reply) => {
			const author = requireNickname(request, reply);
			if (!author) return reply;
			const number = Number(request.params.number);
			const restored =
				isUuid(request.params.id) && Number.isInteger(number)
					? await orchestrations.restoreVersion(request.params.id, number, author)
					: undefined;
			if (!restored) return sendError(reply, 404, "not_found", "orchestration version not found");
			return reply
				.code(201)
				.send({ ...restored, warnings: await checkDocument(restored.document, packages) });
		},
	);

	app.get<{ Params: { id: string; number: string } }>(
		"/orchestrations/:id/versions/:number",
		async (request, reply) => {
			const number = Number(request.params.number);
			const found =
				isUuid(request.params.id) && Number.isInteger(number)
					? await orchestrations.getVersion(request.params.id, number)
					: undefined;
			if (!found) return sendError(reply, 404, "not_found", "orchestration version not found");
			return found;
		},
	);
}
