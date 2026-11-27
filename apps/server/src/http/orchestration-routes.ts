import { isEmptyDiff } from "@sfly/orchestration";
import { orchestrationsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db/database.js";
import { listOrchestrationSummaries } from "../orchestrations/orchestration-list.js";
import type {
	CheckVersionResult,
	OrchestrationStore,
	SaveVersionResult,
} from "../orchestrations/orchestration-store.js";
import { type PreparedEdits, prepareEdits } from "../orchestrations/scenario-edits.js";
import { describeSecretDefaultProblem } from "../orchestrations/secret-defaults.js";
import { versionCheck, versionDiff, versionWarnings } from "../orchestrations/version-check.js";
import { DEFAULT_PROJECT, pathProject } from "../projects/project-id.js";
import { isUuid } from "../util/uuid.js";
import { actorOf } from "./actor.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

const notFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "orchestration not found");

/**
 * 场景与场景版本：新建、改名称、说明、运行通知设置和关注项、归档与恢复、复制、场景列表（契约见 @sfly/schema 的
 * orchestrationsApi）；保存（追加）版本、查询版本。版本不可修改，场景不物理删除。
 * 列表和新建的项目从路径取（`/projects/:project/orchestrations`，#488）；按 ID 定位的从场景得出。
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

	contractRoute(app, orchestrationsApi.create, async ({ params, body }, reply) => {
		return reply
			.code(201)
			.send(await orchestrations.create(pathProject(params), body.name, body.description));
	});

	contractRoute(app, orchestrationsApi.list, ({ params, query }) =>
		listOrchestrationSummaries(db, pathProject(params), query),
	);

	contractRoute(app, orchestrationsApi.head, async ({ params }, reply) => {
		const head = isUuid(params.id) ? await orchestrations.head(params.id) : undefined;
		return head ?? notFound(reply);
	});

	contractRoute(app, orchestrationsApi.copy, async ({ params, body }, reply, raw) => {
		const actor = actorOf(raw);
		const copied = isUuid(params.id)
			? await orchestrations.copy(params.id, body.name, actor)
			: undefined;
		if (!copied) return notFound(reply);
		// 第 1 版是源场景最新版本的原样复制，不过保存时的检查：问题（升级前存下的超限的超时、排队超时……）在警告里带出来。
		const first =
			copied.head_version > 0 ? await orchestrations.getVersion(copied.id, 1) : undefined;
		const project = (await orchestrations.projectOf(copied.id)) ?? DEFAULT_PROJECT;
		const warnings = first
			? await versionWarnings(db, project, copied.id, first.document, undefined)
			: [];
		return reply.code(201).send({ ...copied, warnings });
	});

	contractRoute(app, orchestrationsApi.get, async ({ params }, reply) => {
		const found = isUuid(params.id) ? await orchestrations.get(params.id) : undefined;
		return found ?? notFound(reply);
	});

	// 关注项不合格时的错误码见契约的 update（focus_items_limit / focus_item_duplicate / focus_item_unknown_chart）。
	contractRoute(app, orchestrationsApi.update, async ({ params, body }, reply, raw) => {
		const actor = actorOf(raw);
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

	contractRoute(app, orchestrationsApi.archive, async ({ params }, reply) => {
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

	contractRoute(app, orchestrationsApi.unarchive, async ({ params }, reply) => {
		const restored = isUuid(params.id) ? await orchestrations.unarchive(params.id) : undefined;
		return restored ?? notFound(reply);
	});

	// 缺 base_version、文档不合法时的错误码见契约的 requestError（base_version_required / invalid_document）。
	contractRoute(app, orchestrationsApi.saveVersion, async ({ params, body }, reply, raw) => {
		const actor = actorOf(raw);
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
		const project = (await orchestrations.projectOf(params.id)) ?? DEFAULT_PROJECT;
		const warnings = await versionWarnings(db, project, params.id, saved.document, result.previous);
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

	// 局部编辑（#470）：操作作用在最新版本上，之后和整份文档保存、检查走同一条路。错误码见契约的 edit。
	const rejectEdits = (
		reply: FastifyReply,
		prepared: Exclude<PreparedEdits, { kind: "edited" }>,
		baseVersion: number | undefined,
	): FastifyReply => {
		switch (prepared.kind) {
			case "invalid_operation":
				return sendError(
					reply,
					400,
					"invalid_operation",
					prepared.problem.message,
					prepared.problem,
				);
			case "invalid_document":
				return sendError(reply, 400, "invalid_document", prepared.message, prepared.issues);
			default:
				return rejectVersion(reply, prepared, baseVersion);
		}
	};
	const editsOf = (id: string, operations: Parameters<typeof prepareEdits>[3], base?: number) =>
		isUuid(id)
			? prepareEdits(db, orchestrations, id, operations, base)
			: Promise.resolve({ kind: "not_found" } as const);

	contractRoute(app, orchestrationsApi.edit, async ({ params, body }, reply, raw) => {
		const actor = actorOf(raw);
		const prepared = await editsOf(params.id, body.operations, body.base_version);
		if (prepared.kind !== "edited") return rejectEdits(reply, prepared, body.base_version);
		// 结果和最新版本相同：不存出新版本，返回当前版本（检查走和保存同一段代码，警告和差异与保存时一样）。
		if (prepared.base > 0) {
			const checked = await orchestrations.checkVersion(
				params.id,
				prepared.document,
				prepared.base,
			);
			if (checked.kind !== "checked") return rejectVersion(reply, checked, prepared.base);
			if (isEmptyDiff(checked.check.diff)) {
				const current = await orchestrations.getVersion(params.id, prepared.base);
				if (current) return { ...current, ...checked.check, unchanged: true as const };
			}
		}
		const result = await orchestrations.saveVersion(
			params.id,
			prepared.document,
			actor,
			prepared.base,
		);
		if (result.kind !== "saved") return rejectVersion(reply, result, prepared.base);
		const saved = result.version;
		reply.code(201);
		const check = await versionCheck(
			db,
			(await orchestrations.projectOf(params.id)) ?? DEFAULT_PROJECT,
			params.id,
			saved.document,
			result.previous,
			prepared.before,
		);
		return { ...saved, ...check };
	});

	contractRoute(app, orchestrationsApi.checkEdits, async ({ params, body }, reply) => {
		const prepared = await editsOf(params.id, body.operations, body.base_version);
		if (prepared.kind !== "edited") return rejectEdits(reply, prepared, body.base_version);
		const result = await orchestrations.checkVersion(params.id, prepared.document, prepared.base);
		if (result.kind !== "checked") return rejectVersion(reply, result, prepared.base);
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
		const actor = actorOf(raw);
		const number = Number(params.number);
		const restored =
			isUuid(params.id) && Number.isInteger(number)
				? await orchestrations.restoreVersion(params.id, number, actor)
				: undefined;
		if (!restored) return versionNotFound(reply);
		const { version, previous } = restored;
		const project = (await orchestrations.projectOf(params.id)) ?? DEFAULT_PROJECT;
		const warnings = await versionWarnings(db, project, params.id, version.document, previous);
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
