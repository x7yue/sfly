import { type OrchestrationVersionView, orchestrationsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db/database.js";
import { checkDocument } from "../orchestrations/document-checks.js";
import { listOrchestrationSummaries } from "../orchestrations/orchestration-list.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PackageRepository } from "../packages/package-repository.js";
import { presetInvalidatedWarnings } from "../presets/preset-invalidation.js";
import { isUuid } from "../util/uuid.js";
import { requireActor } from "./actor.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";
import { requireNickname } from "./nickname.js";

const notFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "orchestration not found");

/**
 * 场景与场景版本：新建、改名称和说明、归档与恢复、复制、场景列表（契约见 @sfly/schema 的
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
	/** 保存或恢复出新版本时返回的警告：文档的静态检查，加上会让运行预设失效的改动。 */
	const saveWarnings = async (saved: OrchestrationVersionView) => [
		...(await checkDocument(saved.document, { db, packages })),
		...(await presetInvalidatedWarnings(db, saved.orchestration_id, saved.number)),
	];

	contractRoute(app, orchestrationsApi.create, async ({ body }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		return reply.code(201).send(await orchestrations.create(body.name, body.description));
	});

	contractRoute(app, orchestrationsApi.list, ({ query }) => listOrchestrationSummaries(db, query));

	contractRoute(app, orchestrationsApi.head, async ({ params }, reply) => {
		const head = isUuid(params.id) ? await orchestrations.head(params.id) : undefined;
		return head ?? notFound(reply);
	});

	contractRoute(app, orchestrationsApi.copy, async ({ params, body }, reply, raw) => {
		const actor = requireActor(raw, reply);
		if (!actor) return reply;
		const copied = isUuid(params.id)
			? await orchestrations.copy(params.id, body.name, actor)
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

	// 缺 base_version、文档不合法时的错误码见契约的 requestError（base_version_required / invalid_document）。
	contractRoute(app, orchestrationsApi.saveVersion, async ({ params, body }, reply, raw) => {
		const actor = requireActor(raw, reply);
		if (!actor) return reply;
		const result = isUuid(params.id)
			? await orchestrations.saveVersion(params.id, body.document, actor, body.base_version)
			: ({ kind: "not_found" } as const);
		if (result.kind === "not_found") return notFound(reply);
		if (result.kind === "conflict") {
			return sendError(
				reply,
				409,
				"version_conflict",
				result.head
					? `version ${result.head.number} was saved by ${result.head.author} after version ${body.base_version}`
					: `orchestration has no version ${body.base_version}`,
				{ base_version: body.base_version, head: result.head },
			);
		}
		const saved = result.version;
		// 结构、包版本锁定和引用的问题，以及会让运行预设失效的改动，只产生警告，不阻止保存
		// （docs/SEMANTICS.md §1.2、§2.4、§6）。先设状态码再返回响应：响应在类型上受契约约束。
		reply.code(201);
		return { ...saved, warnings: await saveWarnings(saved) };
	});

	contractRoute(app, orchestrationsApi.versions, async ({ params }, reply) => {
		const versions = isUuid(params.id) ? await orchestrations.listVersions(params.id) : undefined;
		return versions ? { versions } : notFound(reply);
	});

	const versionNotFound = (reply: FastifyReply) =>
		sendError(reply, 404, "not_found", "orchestration version not found");

	// 恢复历史版本 = 用旧内容追加一个新版本（docs/ARCHITECTURE.md §6.4）。
	contractRoute(app, orchestrationsApi.restoreVersion, async ({ params }, reply, raw) => {
		const actor = requireActor(raw, reply);
		if (!actor) return reply;
		const number = Number(params.number);
		const restored =
			isUuid(params.id) && Number.isInteger(number)
				? await orchestrations.restoreVersion(params.id, number, actor)
				: undefined;
		if (!restored) return versionNotFound(reply);
		return reply.code(201).send({ ...restored, warnings: await saveWarnings(restored) });
	});

	contractRoute(app, orchestrationsApi.version, async ({ params }, reply) => {
		const number = Number(params.number);
		const found =
			isUuid(params.id) && Number.isInteger(number)
				? await orchestrations.getVersion(params.id, number)
				: undefined;
		return found ?? versionNotFound(reply);
	});
}
