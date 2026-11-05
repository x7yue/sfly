import { type EndpointResponse, orchestrationsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkDocument } from "../orchestrations/document-checks.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PackageRepository } from "../packages/package-repository.js";
import { isUuid } from "../util/uuid.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";
import { requireNickname } from "./nickname.js";

const CreateBody = z.strictObject({ name: z.string().trim().min(1) });
const CopyBody = CreateBody;
/** 编辑起点的版本号（新编排的第一个版本为 0）必填；不是最新版本时返回 409。 */
const SaveVersionBody = orchestrationsApi.saveVersion.body;

/** 编排与编排版本：新建编排、保存（追加）版本、查询。版本不可修改。 */
export function registerOrchestrationRoutes(
	app: FastifyInstance,
	{ orchestrations, packages }: { orchestrations: OrchestrationStore; packages: PackageRepository },
): void {
	app.post("/orchestrations", async (request, reply) => {
		if (!requireNickname(request, reply)) return reply;
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

	contractRoute(app, orchestrationsApi.head, async ({ params }, reply) => {
		const head = isUuid(params.id) ? await orchestrations.head(params.id) : undefined;
		return head ?? sendError(reply, 404, "not_found", "orchestration not found");
	});

	app.post<{ Params: { id: string } }>("/orchestrations/:id/copy", async (request, reply) => {
		const author = requireNickname(request, reply);
		if (!author) return reply;
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

	contractRoute(app, orchestrationsApi.get, async ({ params }, reply) => {
		const found = isUuid(params.id) ? await orchestrations.get(params.id) : undefined;
		return found ?? sendError(reply, 404, "not_found", "orchestration not found");
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
		const response = { ...saved, warnings: await checkDocument(saved.document, packages) };
		// 响应在类型上受契约约束（orchestrationsApi.saveVersion）。
		return reply
			.code(201)
			.send(response satisfies EndpointResponse<typeof orchestrationsApi.saveVersion>);
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
