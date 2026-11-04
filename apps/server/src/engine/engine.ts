import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { NODE_DEFAULTS } from "@sfly/orchestration";
import {
	type AgentMessage,
	InstallState,
	ErrorKind as ProtoErrorKind,
	TaskStatus as ProtoTaskStatus,
	ServerMessageSchema,
	type TaskResult,
} from "@sfly/proto";
import type { OrchestrationDocument, OrchestrationNode } from "@sfly/schema";
import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import { type AgentConnection, type AgentHub, devPackageInfo } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	chainInstances,
	type ErrorKind,
	nodePackages,
	orchestrations,
	orchestrationVersions,
	runs,
	tasks,
} from "../db/schema.js";
import type { AgentSessionHandler } from "../gateway/agent-gateway.js";
import type { Preflight } from "../runs/preflight.js";
import { Topics } from "../sse/topics.js";
import type { Mutex } from "../util/mutex.js";
import { agentFor, type ChainPlan, planMainChain } from "./chain.js";
import { hasFinalFailure, isAlways, shouldRetry } from "./failures.js";
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
	| { ok: false; status: 400 | 404; code: string; message: string; details?: unknown };

export type CancelOutcome =
	| { ok: true; force: boolean }
	| { ok: false; status: 404 | 409; code: string; message: string };

const ERROR_KINDS: Record<ProtoErrorKind, ErrorKind> = {
	[ProtoErrorKind.UNSPECIFIED]: "node_error",
	[ProtoErrorKind.NODE_ERROR]: "node_error",
	[ProtoErrorKind.TIMEOUT]: "timeout",
	[ProtoErrorKind.AGENT_LOST]: "agent_lost",
	[ProtoErrorKind.ENV_ERROR]: "env_error",
	[ProtoErrorKind.CONFIG_ERROR]: "config_error",
};

const INSTALL_STATES: Partial<Record<InstallState, "installing" | "installed" | "failed">> = {
	[InstallState.INSTALLING]: "installing",
	[InstallState.INSTALLED]: "installed",
	[InstallState.FAILED]: "failed",
};

/** 一次状态迁移的上下文：同一事务里推进链，并记下需要重新尝试派发的 Agent。 */
interface Step {
	tx: Tx;
	now: Date;
	touchedAgents: Set<string>;
	/** 状态有变化的运行；提交后通知订阅者（SSE）。 */
	touchedRuns: Set<string>;
	/** 提交后发给 Agent 的取消指令（#12）。 */
	cancels: CancelOrder[];
}

interface CancelOrder {
	agentName: string;
	taskId: string;
	attempt: number;
	force: boolean;
}

/** 运行是否已被取消；强制取消时 always 节点也不再执行（§3.4）。 */
const cancelling = (run: RunRow) => run.cancelRequestedAt !== null;
const forced = (run: RunRow) => run.cancelForcedAt !== null;
/** 运行取消后这个节点还能不能执行：普通取消时只有 always 节点照常执行。 */
const cancelledFor = (run: RunRow, node: OrchestrationNode | undefined) =>
	cancelling(run) && (forced(run) || !node || !isAlways(node));

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
			/** 节点包归档的下载地址（Agent 通过 HTTP 下载）。 */
			packageArchiveUrl: (name: string, version: string) => string;
			/** 触发前的预检（src/runs/preflight.ts）。 */
			preflight: Preflight;
		},
	) {}

	/** 运行状态变化的通知（主题 = 运行 ID），在状态变更的事务提交之后发布。 */
	readonly runChanges = new Topics<string>();

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
			const problems = await this.deps.preflight(version.document);
			const plan = planMainChain(version.document);
			if (problems.length > 0 || "errors" in plan) {
				const details =
					problems.length > 0 || !("errors" in plan)
						? problems
						: plan.errors.map((message) => ({ code: "not_supported", message }));
				return {
					ok: false,
					status: 400,
					code: "invalid_orchestration",
					message: details.map((p) => p.message).join("; "),
					details,
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

	/**
	 * 取消整个运行（§3.4），作用于运行的所有链实例。第一次：正在运行的普通任务收到优雅取消、
	 * 等 Agent 上报结果；排队中的普通任务和未开始的普通节点立即 cancelled；always 节点照常执行。
	 * 运行还没结束时再次取消即强制取消：所有任务（含 always）立即 cancelled 并通知 Agent 杀掉进程树。
	 */
	cancel(runId: string, requestedBy: string): Promise<CancelOutcome> {
		return this.#event(async (step) => {
			const [run] = await step.tx.select().from(runs).where(eq(runs.id, runId)).for("update");
			if (!run) return { ok: false, status: 404, code: "not_found", message: "run not found" };
			if (run.status !== "running") {
				return {
					ok: false,
					status: 409,
					code: "run_not_running",
					message: `run is already ${run.status}`,
				};
			}
			const force = cancelling(run);
			const [updated] = await step.tx
				.update(runs)
				.set(
					force
						? { cancelForcedAt: step.now }
						: { cancelRequestedAt: step.now, cancelRequestedBy: requestedBy },
				)
				.where(eq(runs.id, runId))
				.returning();
			step.touchedRuns.add(runId);
			const chains = await step.tx
				.select()
				.from(chainInstances)
				.where(and(eq(chainInstances.runId, runId), eq(chainInstances.status, "running")))
				.orderBy(asc(chainInstances.depth), asc(chainInstances.startedAt));
			for (const chain of chains) await this.#cancelChain(step, updated as RunRow, chain);
			return { ok: true, force };
		});
	}

	/** 取消一个链实例上正在排队 / 运行的任务；任务立即结束时从它后面继续推进链。 */
	async #cancelChain(step: Step, run: RunRow, chain: ChainRow): Promise<void> {
		const plan = await this.#plan(step.tx, run, chain);
		const active = await step.tx
			.select()
			.from(tasks)
			.where(and(eq(tasks.chainInstanceId, chain.id), inArray(tasks.status, ["queued", "running"])))
			.orderBy(asc(tasks.seq))
			.for("update");
		let resumeAt: number | undefined;
		for (const task of active) {
			const index = plan.nodes.findIndex((n) => n.id === task.nodeId);
			if (!cancelledFor(run, plan.nodes[index])) continue;
			if (task.status === "running" && task.agentName) {
				const force = forced(run);
				step.cancels.push({
					agentName: task.agentName,
					taskId: task.id,
					attempt: task.attempt,
					force,
				});
				// 优雅取消：等 Agent 终止进程树后上报结果，再执行后面的 always 节点。
				if (!force) continue;
			}
			await step.tx
				.update(tasks)
				.set({ status: "cancelled", endedAt: step.now })
				.where(eq(tasks.id, task.id));
			if (task.agentName) step.touchedAgents.add(task.agentName);
			resumeAt = Math.max(resumeAt ?? 0, index + 1);
		}
		if (resumeAt !== undefined) await this.#advance(step, run, chain, resumeAt);
	}

	onOnline(conn: AgentConnection): Promise<void> {
		return this.deps.mutex.run(async () => {
			await this.#resendCancels(conn);
			await this.#dispatch(conn.name);
		});
	}

	/** Agent 重新连上时，对它上面仍在运行、但所属运行已被取消的任务重发取消指令（断线期间可能没收到）。 */
	async #resendCancels(conn: AgentConnection): Promise<void> {
		const rows = await this.deps.db
			.select({ task: tasks, run: runs, chain: chainInstances })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.innerJoin(chainInstances, eq(chainInstances.id, tasks.chainInstanceId))
			.where(
				and(
					eq(tasks.agentName, conn.name),
					eq(tasks.status, "running"),
					isNotNull(runs.cancelRequestedAt),
				),
			);
		for (const { task, run, chain } of rows) {
			const plan = await this.deps.db.transaction((tx) => this.#plan(tx, run, chain));
			if (
				!cancelledFor(
					run,
					plan.nodes.find((n) => n.id === task.nodeId),
				)
			)
				continue;
			this.#sendCancel({
				agentName: conn.name,
				taskId: task.id,
				attempt: task.attempt,
				force: forced(run),
			});
		}
	}

	#sendCancel(order: CancelOrder): void {
		this.deps.hub.connection(order.agentName)?.send(
			create(ServerMessageSchema, {
				body: {
					case: "cancel",
					value: { taskId: order.taskId, attempt: order.attempt, force: order.force },
				},
			}),
		);
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
		} else if (message.body.case === "install") {
			const status = message.body.value;
			const state = INSTALL_STATES[status.state];
			if (!state) return;
			await this.deps.hub.recordInstall(
				conn,
				{ package: status.package, version: status.version, state, task_id: status.taskId },
				status.installedPackages.map((p) => ({ name: p.name, version: p.version })),
				status.devPackages.map(devPackageInfo),
			);
		}
	}

	/** 在锁内开一个事务处理事件，提交后对涉及的 Agent 尝试派发。 */
	#event<T>(handle: (step: Step) => Promise<T>): Promise<T> {
		return this.deps.mutex.run(async () => {
			const touchedAgents = new Set<string>();
			const touchedRuns = new Set<string>();
			const cancels: CancelOrder[] = [];
			const result = await this.deps.db.transaction((tx) =>
				handle({ tx, now: this.deps.clock.now(), touchedAgents, touchedRuns, cancels }),
			);
			this.#publish(touchedRuns);
			for (const order of cancels) this.#sendCancel(order);
			for (const agent of touchedAgents) await this.#dispatch(agent);
			return result;
		});
	}

	#publish(runIds: Iterable<string>): void {
		for (const runId of runIds) this.runChanges.publish(runId, runId);
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

	/**
	 * 从链上第 index 个节点开始推进：内置节点立即完成，遇到包节点就排队等待派发。
	 * 链上已有节点最终失败时，普通节点标记为 skipped，always 节点照常执行（§3.2）。
	 * 运行已被取消时，普通节点标记为 cancelled（强制取消时 always 节点也是），链以 cancelled 结束（§3.4）。
	 */
	async #advance(step: Step, run: RunRow, chain: ChainRow, index: number): Promise<void> {
		const plan = await this.#plan(step.tx, run, chain);
		const document = await this.#document(step.tx, run.orchestrationVersionId);
		step.touchedRuns.add(run.id);
		const failed = await this.#chainFailed(step.tx, chain);
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
			if (cancelledFor(run, node)) {
				await step.tx
					.insert(tasks)
					.values({ ...base, status: "cancelled", endedAt: step.now })
					.onConflictDoNothing();
				continue;
			}
			if (failed && !isAlways(node)) {
				await step.tx
					.insert(tasks)
					.values({ ...base, status: "skipped", endedAt: step.now })
					.onConflictDoNothing();
				continue;
			}
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
		await this.#finishChain(
			step,
			run,
			chain,
			cancelling(run) ? "cancelled" : failed ? "failed" : "success",
		);
	}

	/** 链上是否已有节点最终失败（含 always 节点）。 */
	async #chainFailed(tx: Tx, chain: ChainRow): Promise<boolean> {
		const rows = await tx
			.select({ nodeId: tasks.nodeId, attempt: tasks.attempt, status: tasks.status })
			.from(tasks)
			.where(eq(tasks.chainInstanceId, chain.id));
		return hasFinalFailure(rows);
	}

	/**
	 * 链结束；运行的所有链都结束后运行才结束：被取消的运行为 cancelled，否则任一条链失败则运行失败（§6.4）。
	 */
	async #finishChain(
		step: Step,
		run: RunRow,
		chain: ChainRow,
		status: "success" | "failed" | "cancelled",
	): Promise<void> {
		step.touchedRuns.add(run.id);
		await step.tx
			.update(chainInstances)
			.set({ status, endedAt: step.now })
			.where(eq(chainInstances.id, chain.id));
		const chains = await step.tx
			.select({ status: chainInstances.status })
			.from(chainInstances)
			.where(eq(chainInstances.runId, run.id));
		if (chains.some((c) => c.status === "running")) return;
		const runStatus = cancelling(run)
			? "cancelled"
			: chains.some((c) => c.status === "failed")
				? "failed"
				: "success";
		await step.tx
			.update(runs)
			.set({ status: runStatus, endedAt: step.now })
			.where(eq(runs.id, run.id));
	}

	/**
	 * 任务失败：可重试的错误且还有重试次数时，在同一个 Agent 上排队下一次尝试（attempt + 1）；
	 * 否则节点最终失败，链继续往后推进（普通节点跳过、always 节点照常执行）。
	 * 运行已被取消时（普通节点，或强制取消时的任何节点），任务记为 cancelled、不再重试（§3.4）。
	 */
	async #failTask(
		step: Step,
		task: TaskRow,
		kind: ErrorKind,
		message: string,
		extra: Partial<TaskRow> = {},
	): Promise<void> {
		const { run, chain } = await this.#context(step.tx, task);
		step.touchedRuns.add(run.id);
		const plan = await this.#plan(step.tx, run, chain);
		const index = plan.nodes.findIndex((n) => n.id === task.nodeId);
		const node = plan.nodes[index];
		if (cancelledFor(run, node)) {
			await step.tx
				.update(tasks)
				.set({ ...extra, status: "cancelled", errorMessage: message, endedAt: step.now })
				.where(eq(tasks.id, task.id));
			await this.#advance(step, run, chain, index + 1);
			return;
		}
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
		if (node && task.agentName && shouldRetry(node, kind, task.attempt)) {
			const attempt = task.attempt + 1;
			await step.tx
				.insert(tasks)
				.values({
					id: taskId(chain.id, task.nodeId, attempt),
					runId: run.id,
					chainInstanceId: chain.id,
					nodeId: task.nodeId,
					attempt,
					agentName: task.agentName,
					status: "queued",
					queuedAt: step.now,
				})
				.onConflictDoNothing();
			step.touchedAgents.add(task.agentName);
			return;
		}
		await this.#advance(step, run, chain, index + 1);
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
		const touchedRuns = new Set<string>();
		const touchedAgents = new Set<string>();
		const cancels: CancelOrder[] = [];
		const assigns = await this.deps.db.transaction(async (tx) => {
			const step: Step = { tx, now: this.deps.clock.now(), touchedAgents, touchedRuns, cancels };
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
		this.#publish(touchedRuns);
		for (const order of cancels) this.#sendCancel(order);
		for (const assign of assigns) conn.send(assign);
		// 派发时失败（config_error）的任务会推进链，可能排队了新的（always）任务。
		for (const agent of touchedAgents) await this.#dispatch(agent);
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
		// always 节点：前面失败或被跳过的节点没有输出，引用缺失的输出得到 null（§2.4）。
		const missingAsNull = isAlways(node);
		if (missingAsNull) {
			for (const id of earlierIds) if (!earlierOutputs.has(id)) earlierOutputs.set(id, {});
		}

		let inputs: Record<string, unknown>;
		try {
			inputs = resolveInputs(node.inputs, {
				params: chain.params,
				earlierOutputs,
				missingAsNull,
			});
		} catch (error) {
			if (!(error instanceof InvalidReferenceError)) throw error;
			await this.#failTask(step, task, "config_error", error.message);
			return undefined;
		}

		await step.tx
			.update(tasks)
			.set({ status: "running", inputs, startedAt: step.now })
			.where(eq(tasks.id, task.id));
		step.touchedRuns.add(run.id);
		const packageVersion = document.packages[node.package] ?? "";
		// 包版本没有安装在 Agent 上时，Agent 按这里的地址下载并校验 sha256；控制面没有该版本时留空。
		const [archive] = await step.tx
			.select({ sha256: nodePackages.sha256 })
			.from(nodePackages)
			.where(and(eq(nodePackages.name, node.package), eq(nodePackages.version, packageVersion)));
		return create(ServerMessageSchema, {
			body: {
				case: "assign",
				value: {
					taskId: task.id,
					attempt: task.attempt,
					package: node.package,
					packageVersion,
					node: node.node,
					inputsJson: JSON.stringify(inputs),
					timeoutSeconds: node.timeout ?? DEFAULT_TIMEOUT_SECONDS,
					runId: run.id,
					nodeId: node.id,
					packageSha256: archive?.sha256 ?? "",
					packageUrl: archive ? this.deps.packageArchiveUrl(node.package, packageVersion) : "",
				},
			},
		});
	}
}
