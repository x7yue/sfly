import { type MetricIncrement, runsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { AgentHub } from "../agents/agent-hub.js";
import { agentWaits } from "../agents/queue-wait.js";
import type { Db } from "../db/database.js";
import type { Engine } from "../engine/engine.js";
import type { ProgressEvent } from "../logs/task-logs.js";
import { referencedAgentStatus } from "../orchestrations/orchestration-list.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import type { PresetStore } from "../presets/preset-store.js";
import { entryParams } from "../presets/preset-validity.js";
import { DEFAULT_PROJECT } from "../projects/project-id.js";
import { type Preflight, preflightWarnings } from "../runs/preflight.js";
import { rawScenario } from "../runs/raw-scenario.js";
import { listRuns } from "../runs/run-list.js";
import { getRunView, readTaskIo } from "../runs/run-read.js";
import { secretLeafWarnings } from "../runs/secret-leaf-warnings.js";
import { secretSizePreflight } from "../runs/secret-size-preflight.js";
import type { Sse } from "../sse/sse.js";
import type { Topics } from "../sse/topics.js";
import { isUuid } from "../util/uuid.js";
import { requireActor } from "./actor.js";
import { contractRoute, contractStream } from "./contract-route.js";
import { sendError } from "./errors.js";

/** 运行（契约见 @sfly/schema 的 runsApi）：触发前预检、手动触发场景的最新版本、运行列表、查询运行状态。 */
export function registerRunRoutes(
	app: FastifyInstance,
	deps: {
		db: Db;
		hub: AgentHub;
		engine: Engine;
		orchestrations: OrchestrationStore;
		presets: PresetStore;
		preflight: Preflight;
		sse: Sse;
		/** 任务进度（#10），在运行的 SSE 上以 `progress` 事件推送。 */
		progress: Topics<ProgressEvent>;
		/** 指标增量（#31），在运行的 SSE 上以 `metrics` 事件推送。 */
		metrics: Topics<MetricIncrement>;
	},
): void {
	/** 输出给客户端的运行视图：排队中的尝试带上它在等什么（Agent 此刻的状态来自注册表）。 */
	const viewOf = (runId: string) =>
		getRunView(deps.db, runId, (names, project) => agentWaits(deps.db, deps.hub, names, project));

	// 一次尝试的输入和输出的全文（运行视图里大的只给大小，在这里取）：访问检查按任务所在的项目，和任务的日志、产物是同一套。
	contractRoute(app, runsApi.taskIo, async ({ params }, reply) => {
		return (
			(await readTaskIo(deps.db, params.id)) ?? sendError(reply, 404, "not_found", "task not found")
		);
	});

	// 触发表单和预检结果：最新版本号、入口参数声明、不能触发的原因（空表示可以触发）、锁定的包版本与引用的 Agent，
	// 以及场景的运行预设（对照这次检查用的最新版本）。
	contractRoute(app, runsApi.preflight, async ({ params }, reply) => {
		const head = isUuid(params.id) ? await deps.orchestrations.head(params.id) : undefined;
		if (!head) return sendError(reply, 404, "not_found", "orchestration not found");
		const orchestration = await deps.orchestrations.get(params.id);
		// 包和 Agent 都按场景所在的项目找：别的项目的当作不存在（预检响应里的 `agents` 也只有本项目的）。
		const project = (await deps.orchestrations.projectOf(params.id)) ?? DEFAULT_PROJECT;
		const declarations = entryParams(head.document);
		const presets = await deps.presets.viewsFor(params.id, declarations);
		if (orchestration?.archived_at) {
			return {
				version: head.number,
				params: [],
				problems: [{ code: "archived", message: "场景已归档，恢复后才能运行" }],
				warnings: [],
				packages: {},
				agents: [],
				presets,
			};
		}
		if (head.number === 0) {
			return {
				version: 0,
				params: [],
				problems: [{ code: "no_version", message: "场景还没有保存过版本" }],
				warnings: [],
				packages: {},
				agents: [],
				presets,
			};
		}
		// 默认值和运行预设的原始值，一次预检只读一次，传给要看它们的几项检查。
		const raw = await rawScenario(deps.db, params.id);
		const secretSize = raw ? await secretSizePreflight(raw) : { problems: [], warnings: [] };
		return {
			version: head.number,
			params: declarations,
			problems: [
				...(await deps.preflight(
					deps.db,
					project,
					head.document,
					await deps.orchestrations.versionSession(params.id, head.number),
				)),
				...secretSize.problems,
			],
			warnings: [
				...preflightWarnings(head.document),
				...(raw ? secretLeafWarnings(raw) : []),
				...secretSize.warnings,
			],
			packages: head.document.packages,
			agents: (await referencedAgentStatus(deps.db, project, head.document)).map((agent) => ({
				...agent,
				preparing_since: deps.hub.preparingSince(agent.name)?.toISOString() ?? null,
			})),
			presets,
		};
	});

	contractRoute(app, runsApi.listForOrchestration, async ({ params }, reply) => {
		const found = isUuid(params.id) ? await deps.orchestrations.get(params.id) : undefined;
		if (!found) return sendError(reply, 404, "not_found", "orchestration not found");
		return { runs: await listRuns(deps.db, found.id) };
	});

	contractRoute(app, runsApi.trigger, async ({ params, body }, reply, request) => {
		const actor = requireActor(request, reply);
		if (!actor) return reply;
		if (!isUuid(params.id)) return sendError(reply, 404, "not_found", "orchestration not found");
		const outcome = await deps.engine.trigger(params.id, body, actor);
		if (!outcome.ok) {
			return sendError(reply, outcome.status, outcome.code, outcome.message, outcome.details);
		}
		const run = await viewOf(outcome.runId);
		return reply.code(201).send(run);
	});

	// 运行状态的实时推送：连上时先发一条完整的运行视图，之后运行或任何节点的状态变化时再发一条（事件 run）；
	// 任务进度更新时发 progress 事件（ProgressEvent，只含这一个任务的最新进度）；
	// 执行中的任务新上报的指标点发 metrics 事件（MetricIncrement，每个任务每秒最多一条），断线期间错过的点
	// 用序列查询（GET /runs/:id/metrics/series）补齐。
	contractStream(app, deps.sse, runsApi.events, async ({ params }, open, reply, request) => {
		const runId = params.id;
		if (!isUuid(runId) || !(await viewOf(runId))) {
			return sendError(reply, 404, "not_found", "run not found");
		}
		open((stream) => {
			// 每条流同时只查询一次；查询期间又有变化时，查完再查一次（合并成最新状态）。
			let querying = false;
			let again = false;
			const push = async () => {
				if (querying) {
					again = true;
					return;
				}
				querying = true;
				try {
					do {
						again = false;
						const view = await viewOf(runId);
						if (view) stream.send("run", view);
					} while (again && !stream.closed);
				} catch (error) {
					request.log.error(error);
				} finally {
					querying = false;
				}
			};
			const unsubscribe = deps.engine.runChanges.subscribe(runId, () => void push());
			const unsubscribeProgress = deps.progress.subscribe(runId, (event) =>
				stream.send("progress", event),
			);
			const unsubscribeMetrics = deps.metrics.subscribe(runId, (event) =>
				stream.send("metrics", event),
			);
			void push();
			return () => {
				unsubscribe();
				unsubscribeProgress();
				unsubscribeMetrics();
			};
		});
		return undefined;
	});

	// 取消整个运行（#12）；运行还没结束时再次调用即强制取消。返回取消后的运行视图。
	contractRoute(app, runsApi.cancel, async ({ params }, reply, request) => {
		const actor = requireActor(request, reply);
		if (!actor) return reply;
		if (!isUuid(params.id)) return sendError(reply, 404, "not_found", "run not found");
		const outcome = await deps.engine.cancel(params.id, actor);
		if (!outcome.ok) return sendError(reply, outcome.status, outcome.code, outcome.message);
		return (await viewOf(params.id)) ?? sendError(reply, 404, "not_found", "run not found");
	});

	contractRoute(app, runsApi.get, async ({ params }, reply) => {
		const run = isUuid(params.id) ? await viewOf(params.id) : undefined;
		return run ?? sendError(reply, 404, "not_found", "run not found");
	});
}
