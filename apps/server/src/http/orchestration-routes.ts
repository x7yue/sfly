import { structureWarnings } from "@sfly/orchestration";
import { OrchestrationDocument } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import { isUuid, sendError } from "./errors.js";
import { nicknameOf } from "./nickname.js";

const CreateBody = z.strictObject({ name: z.string().trim().min(1) });
const CopyBody = CreateBody;
const SaveVersionBody = z.object({
	document: OrchestrationDocument,
	/** 编辑起点的版本号（0 = 还没有版本）。不是最新版本时返回 409。画布总是携带；省略时不做冲突检查。 */
	base_version: z.number().int().nonnegative().optional(),
});

/** 编排与编排版本：新建编排、保存（追加）版本、查询。版本不可修改。 */
export function registerOrchestrationRoutes(
	app: FastifyInstance,
	{ orchestrations }: { orchestrations: OrchestrationStore },
): void {
	app.post("/orchestrations", async (request, reply) => {
		const body = CreateBody.safeParse(request.body);
		if (!body.success) {
			return sendError(
				reply,
				400,
				"invalid_request",
				"name is required",
				z.treeifyError(body.error),
			);
		}
		return reply.code(201).send(await orchestrations.create(body.data.name));
	});

	app.get("/orchestrations", async () => ({ orchestrations: await orchestrations.list() }));

	app.get<{ Params: { id: string } }>("/orchestrations/:id/head", async (request, reply) => {
		const head = isUuid(request.params.id)
			? await orchestrations.head(request.params.id)
			: undefined;
		if (!head) return sendError(reply, 404, "not_found", "orchestration not found");
		return head;
	});

	app.post<{ Params: { id: string } }>("/orchestrations/:id/copy", async (request, reply) => {
		const author = nicknameOf(request);
		if (!author)
			return sendError(reply, 400, "nickname_required", "x-sfly-nickname header is required");
		const body = CopyBody.safeParse(request.body);
		if (!body.success) {
			return sendError(
				reply,
				400,
				"invalid_request",
				"name is required",
				z.treeifyError(body.error),
			);
		}
		const copied = isUuid(request.params.id)
			? await orchestrations.copy(request.params.id, body.data.name, author)
			: undefined;
		if (!copied) return sendError(reply, 404, "not_found", "orchestration not found");
		return reply.code(201).send(copied);
	});

	app.get<{ Params: { id: string } }>("/orchestrations/:id", async (request, reply) => {
		const found = isUuid(request.params.id)
			? await orchestrations.get(request.params.id)
			: undefined;
		if (!found) return sendError(reply, 404, "not_found", "orchestration not found");
		return found;
	});

	app.post<{ Params: { id: string } }>("/orchestrations/:id/versions", async (request, reply) => {
		const author = nicknameOf(request);
		if (!author)
			return sendError(reply, 400, "nickname_required", "x-sfly-nickname header is required");
		const body = SaveVersionBody.safeParse(request.body);
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
		// 结构问题只产生警告，不阻止保存（docs/SEMANTICS.md §1.2）。
		return reply.code(201).send({ ...saved, warnings: structureWarnings(saved.document) });
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
			const author = nicknameOf(request);
			if (!author)
				return sendError(reply, 400, "nickname_required", "x-sfly-nickname header is required");
			const number = Number(request.params.number);
			const restored =
				isUuid(request.params.id) && Number.isInteger(number)
					? await orchestrations.restoreVersion(request.params.id, number, author)
					: undefined;
			if (!restored) return sendError(reply, 404, "not_found", "orchestration version not found");
			return reply.code(201).send({ ...restored, warnings: structureWarnings(restored.document) });
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
