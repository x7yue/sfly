import { OrchestrationDocument } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkDocument } from "../orchestrations/document-checks.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PackageRepository } from "../packages/package-repository.js";
import { isUuid, sendError } from "./errors.js";
import { nicknameOf } from "./nickname.js";

const CreateBody = z.strictObject({ name: z.string().trim().min(1) });
const CopyBody = CreateBody;
const SaveVersionBody = z.object({ document: OrchestrationDocument });

/** 编排与编排版本：新建编排、保存（追加）版本、查询。版本不可修改。 */
export function registerOrchestrationRoutes(
	app: FastifyInstance,
	{ orchestrations, packages }: { orchestrations: OrchestrationStore; packages: PackageRepository },
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
		const saved = isUuid(request.params.id)
			? await orchestrations.saveVersion(request.params.id, body.data.document, author)
			: undefined;
		if (!saved) return sendError(reply, 404, "not_found", "orchestration not found");
		// 结构、包版本锁定和引用的问题只产生警告，不阻止保存（docs/SEMANTICS.md §1.2、§2.4）。
		return reply
			.code(201)
			.send({ ...saved, warnings: await checkDocument(saved.document, packages) });
	});

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
