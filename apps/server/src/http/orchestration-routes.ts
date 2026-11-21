import { orchestrationsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db/database.js";
import { listOrchestrationSummaries } from "../orchestrations/orchestration-list.js";
import type {
	CheckVersionResult,
	OrchestrationStore,
	SaveVersionResult,
} from "../orchestrations/orchestration-store.js";
import { describeSecretDefaultProblem } from "../orchestrations/secret-defaults.js";
import { versionDiff, versionWarnings } from "../orchestrations/version-check.js";
import { DEFAULT_PROJECT } from "../projects/project-id.js";
import { isUuid } from "../util/uuid.js";
import { requireActor } from "./actor.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";
import { requireNickname } from "./nickname.js";

const notFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "orchestration not found");

/**
 * 场景与场景版本：新建、改名称、说明、运行通知设置和关注项、归档与恢复、复制、场景列表（契约见 @sfly/schema 的
 * orchestrationsApi）；保存（追加）版本、查询版本。版本不可修改，场景不物理删除。
 * 列表和新建的路径还不带项目（#488）：都在默认项目里。
 */
export function registerOrchestrationRoutes(
	app: FastifyInstance,
	{ db, orchestrations }: { db: Db; orchestrations: OrchestrationStore },
): void {
	/**
	 * 保存和检查共有的拒绝：编辑起点过期（409）、secret 参数默认值的占位符沿用不了（400）。检查和保存走同一段，
	 * 同一份请求体得到同样的错误。带 `strict` 保存时新带进来了警告：400 `strict_warnings`，details 是检查的结果。
	 */
	const rejectVersion = (
		reply: FastifyReply,
		result: Exclude<SaveVersionResult | CheckVersionResult, { kind: "checked" | "saved" }>,
		baseVersion: number | undefined,
	): FastifyReply => {
		if (result.kind === "not_found") return notFound(reply);
		if (result.kind === "strict_rejected") {
			const count = result.check.warnings.filter((w) => !w.existing).length;
			return sendError(
				reply,
				400,
				"strict_warnings",
				`这次改动新带进来了 ${count} 条警告，strict 时不保存`,
				result.check,
			);
		}
		if (result.kind === "conflict") {
			return sendError(
				reply,
				409,
				"version_conflict",
				result.head
					? `version ${result.head.number} was saved by ${result.head.author} after version ${baseVersion}`
					: `orchestration has no version ${baseVersion}`,
				{ base_version: baseVersion, head: result.head },
			);
		}
		return sendError(
			reply,
			400,
			"secret_default_placeholder",
			result.problems.map(describeSecretDefaultProblem).join("；"),
			result.problems,
		);
	};

	contractRoute(app, orchestrationsApi.create, async ({ body }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		return reply
			.code(201)
			.send(await orchestrations.create(DEFAULT_PROJECT, body.name, body.description));
	});

	contractRoute(app, orchestrationsApi.list, ({ query }) =>
		listOrchestrationSummaries(db, DEFAULT_PROJECT, query),
	);

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

	// 关注项不合格时的错误码见契约的 update（focus_items_limit / focus_item_duplicate / focus_item_unknown_chart）。
	contractRoute(app, orchestrationsApi.update, async ({ params, body }, reply, raw) => {
		const actor = requireActor(raw, reply);
		if (!actor) return reply;
		const result = isUuid(params.id)
			? await orchestrations.update(params.id, body, actor)
			: ({ kind: "not_found" } as const);
		if (result.kind === "not_found") return notFound(reply);
		if (result.kind === "rejected") {
			const { code, message, details } = result.rejection;
			return sendError(reply, 400, code, message, details);
		}
		return result.orchestration;
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
			? await orchestrations.saveVersion(params.id, body.document, actor, body.base_version, {
					strict: body.strict === true,
				})
			: ({ kind: "not_found" } as const);
		if (result.kind !== "saved") return rejectVersion(reply, result, body.base_version);
		const saved = result.version;
		// 结构、包版本锁定和引用的问题，以及会让运行预设失效的改动，只产生警告，不阻止保存
		// （docs/SEMANTICS.md §1.2、§2.4、§6）。先设状态码再返回响应：响应在类型上受契约约束。
		reply.code(201);
		const warnings = await versionWarnings(db, params.id, saved.document, result.previous);
		return { ...saved, warnings };
	});

	// 检查 = 保存的同一段校验，不追加版本（#424）。错误码与保存相同，见契约的 check。
	contractRoute(app, orchestrationsApi.check, async ({ params, body }, reply) => {
		const result = isUuid(params.id)
			? await orchestrations.checkVersion(params.id, body.document, body.base_version)
			: ({ kind: "not_found" } as const);
		if (result.kind !== "checked") return rejectVersion(reply, result, body.base_version);
		return result.check;
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
		const { version, previous } = restored;
		const warnings = await versionWarnings(db, params.id, version.document, previous);
		return reply.code(201).send({ ...version, warnings });
	});

	contractRoute(app, orchestrationsApi.version, async ({ params }, reply) => {
		const number = Number(params.number);
		const found =
			isUuid(params.id) && Number.isInteger(number)
				? await orchestrations.getVersion(params.id, number)
				: undefined;
		return found ?? versionNotFound(reply);
	});

	// 对比两个版本（#424）：a、b 都要是存在的版本，否则 404（和读一个版本一样，不是整数也是 404）。
	contractRoute(app, orchestrationsApi.versionDiff, async ({ params }, reply) => {
		const [a, b] = [Number(params.a), Number(params.b)];
		if (!isUuid(params.id) || !Number.isInteger(a) || !Number.isInteger(b)) {
			return versionNotFound(reply);
		}
		const before = await orchestrations.getVersion(params.id, a);
		const after = before && (await orchestrations.getVersion(params.id, b));
		if (!before || !after) return versionNotFound(reply);
		return { diff: versionDiff(before.document, after.document) };
	});
}
