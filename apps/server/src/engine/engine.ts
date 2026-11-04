import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { NODE_DEFAULTS } from "@sfly/orchestration";
import {
	type AgentMessage,
	ErrorKind as ProtoErrorKind,
	TaskStatus as ProtoTaskStatus,
	ServerMessageSchema,
	type TaskResult,
} from "@sfly/proto";
import type { OrchestrationDocument } from "@sfly/schema";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { AgentConnection, AgentHub } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	chainInstances,
	type ErrorKind,
	orchestrations,
	orchestrationVersions,
	runs,
	tasks,
} from "../db/schema.js";
import type { AgentSessionHandler } from "../gateway/agent-gateway.js";
import type { Mutex } from "../util/mutex.js";
import { agentFor, type ChainPlan, planMainChain } from "./chain.js";
import { chainInstanceId, taskId } from "./ids.js";
import { fillParams } from "./params.js";
import { InvalidReferenceError, resolveInputs } from "./references.js";

/** 包节点默认超时：1 小时（docs/SEMANTICS.md §3.3）。 */
export const DEFAULT_TIMEOUT_SECONDS = NODE_DEFAULTS.timeout;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RunRow = typeof runs.$inferSelect;
type ChainRow = typeof chainInstances.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export type TriggerOutcome =
	| { ok: true; runId: string }
	| { ok: false; status: 400 | 404; code: string; message: string; details?: string[] };

const ERROR_KINDS: Record<ProtoErrorKind, ErrorKind> = {
	[ProtoErrorKind.UNSPECIFIED]: "node_error",
	[ProtoErrorKind.NODE_ERROR]: "node_error",
	[ProtoErrorKind.TIMEOUT]: "timeout",
	[ProtoErrorKind.AGENT_LOST]: "agent_lost",
	[ProtoErrorKind.ENV_ERROR]: "env_error",
	[ProtoErrorKind.CONFIG_ERROR]: "config_error",
};

/** 一次状态迁移的上下文：同一事务里推进链，并记下需要重新尝试派发的 Agent。 */
interface Step {
	tx: Tx;
	now: Date;
	touchedAgents: Set<string>;
}

/**
 * 引擎：PostgreSQL 之上的链状态机（docs/SEMANTICS.md §3）。
 *
 * 每个事件（触发、任务结果、Agent 上线）在进程内互斥锁下处理，状态迁移在一个数据库事务里完成，
 * 提交后再向 Agent 推送派发消息。当前支持主链上的入口节点和包节点。
 */
export class Engine implements AgentSessionHandler {
	#documents = new Map<string, OrchestrationDocument>();
	#plans = new Map<string, ChainPlan>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			mutex: Mutex;
			hub: AgentHub;
		},
	) {}

	/** 手动触发编排的最新版本。 */
	trigger(
		orchestrationId: string,
		provided: Record<string, unknown>,
		triggeredBy: string,
	): Promise<TriggerOutcome> {
		return this.#event(async (step) => {
			const [orchestration] = await step.tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, orchestrationId));
			if (!orchestration) {
				return { ok: false, status: 404, code: "not_found", message: "orchestration not found" };
			}
			const [version] = await step.tx
				.select()
				.from(orchestrationVersions)
				.where(
					and(
						eq(orchestrationVersions.orchestrationId, orchestrationId),
						eq(orchestrationVersions.number, orchestration.headVersion),
					),
				);
			if (!version) {
				return {
					ok: false,
					status: 400,
					code: "no_version",
					message: "orchestration has no saved version",
				};
			}
			const plan = planMainChain(version.document);
			if ("errors" in plan) {
				return {
					ok: false,
					status: 400,
					code: "invalid_orchestration",
					message: plan.errors.join("; "),
					details: plan.errors,
				};
			}
			const filled = fillParams(plan.entry.params, provided);
			if ("errors" in filled) {
				return {
					ok: false,
					status: 400,
					code: "invalid_params",
					message: filled.errors.join("; "),
					details: filled.errors,
				};
			}

			this.#documents.set(version.id, version.document);
			this.#plans.set(`${version.id}:${plan.entry.id}`, plan);
			const runId = randomUUID();
			const [run] = await step.tx
				.insert(runs)
				.values({
					id: runId,
					orchestrationId,
					orchestrationVersionId: version.id,
					triggeredBy,
					params: filled.params,
					status: "running",
					startedAt: step.now,
				})
				.returning();
			const [chain] = await step.tx
				.insert(chainInstances)
				.values({
					id: chainInstanceId(runId),
					runId,
					chainId: plan.entry.id,
					depth: 0,
					params: filled.params,
					status: "running",
					startedAt: step.now,
				})
				.returning();
			await this.#advance(step, run as RunRow, chain as ChainRow, 0);
			return { ok: true, runId };
		});
	}

	onOnline(conn: AgentConnection): Promise<void> {
		return this.deps.mutex.run(() => this.#dispatch(conn.name));
	}

	async onMessage(conn: AgentConnection, message: AgentMessage): Promise<void> {
		if (message.body.case === "result") {
			const result = message.body.value;
			await this.#event((step) => this.#applyResult(step, conn.name, result));
			conn.send(
				create(ServerMessageSchema, {
					body: { case: "ack", value: { taskId: result.taskId, attempt: result.attempt } },
				}),
			);
		}
	}

	/** 在锁内开一个事务处理事件，提交后对涉及的 Agent 尝试派发。 */
	#event<T>(handle: (step: Step) => Promise<T>): Promise<T> {
		return this.deps.mutex.run(async () => {
			const touchedAgents = new Set<string>();
			const result = await this.deps.db.transaction((tx) =>
				handle({ tx, now: this.deps.clock.now(), touchedAgents }),
			);
			for (const agent of touchedAgents) await this.#dispatch(agent);
			return result;
		});
	}

	async #document(tx: Tx, versionId: string): Promise<OrchestrationDocument> {
		const cached = this.#documents.get(versionId);
		if (cached) return cached;
		const [version] = await tx
			.select({ document: orchestrationVersions.document })
			.from(orchestrationVersions)
			.where(eq(orchestrationVersions.id, versionId));
		if (!version) throw new Error(`orchestration version ${versionId} not found`);
		this.#documents.set(versionId, version.document);
		return version.document;
	}

	/** 链实例的执行计划；编排版本不可变，计划可以缓存。 */
	async #plan(tx: Tx, run: RunRow, chain: ChainRow): Promise<ChainPlan> {
		const key = `${run.orchestrationVersionId}:${chain.chainId}`;
		const cached = this.#plans.get(key);
		if (cached) return cached;
		const plan = planMainChain(await this.#document(tx, run.orchestrationVersionId));
		if ("errors" in plan)
			throw new Error(`run ${run.id}: invalid chain: ${plan.errors.join("; ")}`);
		this.#plans.set(key, plan);
		return plan;
	}

	/** 从链上第 index 个节点开始推进：内置节点立即完成，遇到包节点就排队等待派发。 */
	async #advance(step: Step, run: RunRow, chain: ChainRow, index: number): Promise<void> {
		const plan = await this.#plan(step.tx, run, chain);
		const document = await this.#document(step.tx, run.orchestrationVersionId);
		for (let i = index; i < plan.nodes.length; i++) {
			const node = plan.nodes[i];
			if (!node) break;
			const base = {
				id: taskId(chain.id, node.id, 1),
				runId: run.id,
				chainInstanceId: chain.id,
				nodeId: node.id,
				attempt: 1,
				queuedAt: step.now,
			};
			if (node.kind === "package") {
				const agentName = agentFor(document, node);
				await step.tx
					.insert(tasks)
					.values({ ...base, agentName, status: "queued" })
					.onConflictDoNothing();
				step.touchedAgents.add(agentName);
				return;
			}
			// 入口节点：运行开始时立即完成。
			await step.tx
				.insert(tasks)
				.values({ ...base, status: "success", outputs: {}, startedAt: step.now, endedAt: step.now })
				.onConflictDoNothing();
		}
		await this.#finishChain(step, run, chain, "success");
	}

	async #finishChain(
		step: Step,
		run: RunRow,
		chain: ChainRow,
		status: "success" | "failed",
	): Promise<void> {
		await step.tx
			.update(chainInstances)
			.set({ status, endedAt: step.now })
			.where(eq(chainInstances.id, chain.id));
		// 目前每个运行只有主链：主链结束即运行结束。
		await step.tx.update(runs).set({ status, endedAt: step.now }).where(eq(runs.id, run.id));
	}

	async #failTask(
		step: Step,
		task: TaskRow,
		kind: ErrorKind,
		message: string,
		extra: Partial<TaskRow> = {},
	): Promise<void> {
		await step.tx
			.update(tasks)
			.set({
				...extra,
				status: "failed",
				errorKind: kind,
				errorMessage: message,
				endedAt: step.now,
			})
			.where(eq(tasks.id, task.id));
		const { run, chain } = await this.#context(step.tx, task);
		await this.#finishChain(step, run, chain, "failed");
	}

	async #context(tx: Tx, task: TaskRow): Promise<{ run: RunRow; chain: ChainRow }> {
		const [row] = await tx
			.select({ run: runs, chain: chainInstances })
			.from(chainInstances)
			.innerJoin(runs, eq(runs.id, chainInstances.runId))
			.where(eq(chainInstances.id, task.chainInstanceId));
		if (!row) throw new Error(`chain instance ${task.chainInstanceId} not found`);
		return row;
	}

	/** 处理任务结果；按 task_id + attempt 幂等：只接受当前正在运行、且派发给该 Agent 的那次尝试。 */
	async #applyResult(step: Step, agentName: string, result: TaskResult): Promise<void> {
		if (!/^[0-9a-f-]{36}$/i.test(result.taskId)) return;
		const [task] = await step.tx
			.select()
			.from(tasks)
			.where(eq(tasks.id, result.taskId))
			.for("update");
		if (
			!task ||
			task.attempt !== result.attempt ||
			task.status !== "running" ||
			task.agentName !== agentName
		) {
			return;
		}
		step.touchedAgents.add(agentName);

		if (result.status !== ProtoTaskStatus.SUCCESS) {
			const kind = ERROR_KINDS[result.error?.kind ?? ProtoErrorKind.UNSPECIFIED] ?? "node_error";
			await this.#failTask(step, task, kind, result.error?.message ?? "");
			return;
		}
		let outputs: unknown;
		try {
			outputs = result.outputsJson === "" ? {} : JSON.parse(result.outputsJson);
		} catch {
			outputs = undefined;
		}
		if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
			await this.#failTask(step, task, "node_error", "task outputs must be a JSON object");
			return;
		}
		await step.tx
			.update(tasks)
			.set({ status: "success", outputs: outputs as Record<string, unknown>, endedAt: step.now })
			.where(eq(tasks.id, task.id));
		const { run, chain } = await this.#context(step.tx, task);
		const plan = await this.#plan(step.tx, run, chain);
		const index = plan.nodes.findIndex((n) => n.id === task.nodeId);
		await this.#advance(step, run, chain, index + 1);
	}

	/** 把排队中的任务派发给在线的 Agent，直到槽位用满。调用方需持有锁。 */
	async #dispatch(agentName: string): Promise<void> {
		const conn = this.deps.hub.connection(agentName);
		if (!conn) return;
		const assigns = await this.deps.db.transaction(async (tx) => {
			const step: Step = { tx, now: this.deps.clock.now(), touchedAgents: new Set() };
			const [running] = await tx
				.select({ n: count() })
				.from(tasks)
				.where(and(eq(tasks.agentName, agentName), eq(tasks.status, "running")));
			let free = conn.info.slots - (running?.n ?? 0);
			if (free <= 0) return [];
			const queued = await tx
				.select()
				.from(tasks)
				.where(and(eq(tasks.agentName, agentName), eq(tasks.status, "queued")))
				.orderBy(asc(tasks.queuedAt), asc(tasks.seq))
				.for("update");
			const out: Array<ReturnType<typeof create<typeof ServerMessageSchema>>> = [];
			for (const task of queued) {
				if (free <= 0) break;
				const assign = await this.#prepareAssign(step, task);
				if (!assign) continue;
				out.push(assign);
				free--;
			}
			return out;
		});
		for (const assign of assigns) conn.send(assign);
	}

	/** 解析输入并把任务标记为 running；引用无效时任务以 config_error 失败并返回 undefined。 */
	async #prepareAssign(step: Step, task: TaskRow) {
		const { run, chain } = await this.#context(step.tx, task);
		const plan = await this.#plan(step.tx, run, chain);
		const index = plan.nodes.findIndex((n) => n.id === task.nodeId);
		const node = plan.nodes[index];
		if (!node || node.kind !== "package") throw new Error(`task ${task.id} is not a package node`);
		const document = await this.#document(step.tx, run.orchestrationVersionId);

		const earlierIds = plan.nodes.slice(0, index).map((n) => n.id);
		const done = earlierIds.length
			? await step.tx
					.select({ nodeId: tasks.nodeId, outputs: tasks.outputs })
					.from(tasks)
					.where(
						and(
							eq(tasks.chainInstanceId, chain.id),
							inArray(tasks.nodeId, earlierIds),
							eq(tasks.status, "success"),
						),
					)
			: [];
		const earlierOutputs = new Map(done.map((d) => [d.nodeId, d.outputs ?? {}]));

		let inputs: Record<string, unknown>;
		try {
			inputs = resolveInputs(node.inputs, { params: chain.params, earlierOutputs });
		} catch (error) {
			if (!(error instanceof InvalidReferenceError)) throw error;
			await this.#failTask(step, task, "config_error", error.message);
			return undefined;
		}

		await step.tx
			.update(tasks)
			.set({ status: "running", inputs, startedAt: step.now })
			.where(eq(tasks.id, task.id));
		return create(ServerMessageSchema, {
			body: {
				case: "assign",
				value: {
					taskId: task.id,
					attempt: task.attempt,
					package: node.package,
					packageVersion: document.packages[node.package] ?? "",
					node: node.node,
					inputsJson: JSON.stringify(inputs),
					timeoutSeconds: node.timeout ?? DEFAULT_TIMEOUT_SECONDS,
					runId: run.id,
					nodeId: node.id,
				},
			},
		});
	}
}
