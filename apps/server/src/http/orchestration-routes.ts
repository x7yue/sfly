import { OrchestrationDocument } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import { isUuid, sendError } from "./errors.js";
import { nicknameOf } from "./nickname.js";

const CreateBody = z.strictObject({ name: z.string().trim().min(1) });
const SaveVersionBody = z.object({ document: OrchestrationDocument });

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
		return reply.code(201).send(saved);
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
