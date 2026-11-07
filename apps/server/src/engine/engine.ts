import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	InvalidReferenceError,
	inputProblems,
	NODE_DEFAULTS,
	type ResolveScope,
	resolveInputs,
} from "@sfly/orchestration";
import {
	type AgentMessage,
	AgentUpdateState,
	InstallState,
	ErrorKind as ProtoErrorKind,
	TaskStatus as ProtoTaskStatus,
	ServerMessageSchema,
	TaskAction,
	type TaskResult,
} from "@sfly/proto";
import {
	ACTIVE_STATUSES,
	type OrchestrationDocument,
	type OrchestrationNode,
	type PackageMetadata,
} from "@sfly/schema";
import { and, asc, count, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
	type AgentConnection,
	type AgentHub,
	devPackageInfo,
	type RunningTaskView,
} from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	type AgentUpdateInfo,
	agents,
	chainInstances,
	type ErrorKind,
	nodePackages,
	ON_AGENT,
	orchestrations,
	orchestrationVersions,
	runs,
	tasks,
} from "../db/schema.js";
import {
	type AgentSessionHandler,
	type RunningTaskRef,
	runningTaskRef,
} from "../gateway/agent-gateway.js";
import type { Mirrors } from "../public-config.js";
import type { Preflight } from "../runs/preflight.js";
import { Topics } from "../sse/topics.js";
import type { Mutex } from "../util/mutex.js";
import { isUuid } from "../util/uuid.js";
import {
	type AsyncTaskNode,
	agentFor,
	type ChainPlan,
	type PackageNode,
	planRun,
	type RunPlan,
	type StopSubflowNode,
} from "./chain.js";
import { hasFinalFailure, isAlways, shouldRetry } from "./failures.js";
import { chainInstanceId, taskId } from "./ids.js";
import {
	DEFAULT_LEASE_MS,
	expireTasks,
	extendForRecovery,
	MissedHeartbeats,
	queueTimedOut,
	renewHeld,
} from "./leases.js";
import { fillParams } from "./params.js";
import {
	type CancelOrder,
	type ChainDriver,
	type ChainRow,
	firstAttempt,
	type Located,
	type RunRow,
	type Step,
	type TaskRow,
	type Tx,
} from "./step.js";
import { isWaitNode, startWait, wakeTimers } from "./waits.js";

/** 包节点默认超时：1 小时（docs/SEMANTICS.md §3.3）。 */
export const DEFAULT_TIMEOUT_SECONDS = NODE_DEFAULTS.timeout;

export { DEFAULT_LEASE_MS } from "./leases.js";

/** 开发版本（docs/SEMANTICS.md §7）。 */
const DEV_VERSION = "dev";

/** 节点进入 queued 后最多排队多久（§3.3 queue_timeout，默认 10 分钟）。 */
const queueTimeoutMs = (node: PackageNode) =>
	(node.queue_timeout ?? NODE_DEFAULTS.queue_timeout) * 1000;

export type TriggerOutcome =
	| { ok: true; runId: string }
	| { ok: false; status: 400 | 404 | 409; code: string; message: string; details?: unknown };

export type CancelOutcome =
	| { ok: true; force: boolean }
	| { ok: false; status: 404 | 409; code: string; message: string };

export type UpdateNowOutcome =
	| { ok: true; terminated: RunningTaskView[] }
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

const UPDATE_STATES: Partial<Record<AgentUpdateState, AgentUpdateInfo["state"]>> = {
	[AgentUpdateState.NONE]: "none",
	[AgentUpdateState.DOWNLOADING]: "downloading",
	[AgentUpdateState.WAITING_FOR_TASKS]: "waiting_for_tasks",
	[AgentUpdateState.REPLACING]: "replacing",
	[AgentUpdateState.FAILED]: "failed",
	[AgentUpdateState.MANUAL_UPGRADE_REQUIRED]: "manual_upgrade_required",
};

/** 任务由 Agent 负责（派发阶段或执行阶段）。 */
const onAgent = (task: TaskRow) => (ON_AGENT as readonly string[]).includes(task.status);

/** 运行是否已被取消；强制取消时 always 节点也不再执行（§3.4）。 */
const cancelling = (run: RunRow) => run.cancelRequestedAt !== null;
const forced = (run: RunRow) => run.cancelForcedAt !== null;
/** 运行取消后这个节点还能不能执行：普通取消时只有 always 节点照常执行。 */
const cancelledFor = (run: RunRow, node: OrchestrationNode | undefined) =>
	cancelling(run) && (forced(run) || !node || !isAlways(node));

/** 链实例是否已被停止子流程节点停止（§4.1）；always 节点照常执行。 */
const stoppedFor = (chain: ChainRow, node: OrchestrationNode | undefined) =>
	chain.stopTaskId !== null && (!node || !isAlways(node));

/**
 * 停止子流程节点的输出（§4.1 第 5 条）：子流程的最终结果 success | failed，未触发时为 null。
 * 运行被取消时子流程以 cancelled 结束，它没有成功完成，输出 failed。
 */
const stopOutputs = (status: ChainRow["status"] | null) => ({
	status: status === null ? null : status === "success" ? "success" : "failed",
});

/** 链实例 root 和它直接或间接触发的子流程实例（chains 是同一次运行的全部链实例），按深度排列。 */
function subtree(chains: ChainRow[], root: ChainRow): ChainRow[] {
	const out = [root];
	for (let i = 0; i < out.length; i++) {
		const parent = out[i];
		out.push(...chains.filter((c) => c.parentChainInstanceId === parent?.id));
	}
	return out;
}

/** 链实例和它的各级上级链实例（chains 是同一次运行的全部链实例）。 */
function ancestry(chains: ChainRow[], chain: ChainRow): ChainRow[] {
	const out: ChainRow[] = [];
	for (let c: ChainRow | undefined = chain; c; ) {
		const current: ChainRow = c;
		out.push(current);
		c = chains.find((p) => p.id === current.parentChainInstanceId);
	}
	return out;
}

/**
 * 引擎：PostgreSQL 之上的链状态机（docs/SEMANTICS.md §3）。
 *
 * 每个事件（触发、任务结果、Agent 上线）在进程内互斥锁下处理，状态迁移在一个数据库事务里完成，
 * 提交后再向 Agent 推送派发消息。支持全部节点种类：入口节点、子流程入口节点、异步任务节点
 * （子流程实例在同一个事务里创建，#spawn）、定时 / Sleep 节点（持久化定时器，waits.ts）和包节点。
 * 租约、排队超时与重启恢复在 leases.ts；辅助模块经 {@link ChainDriver} 回到引擎推进链，仍在同一把锁、同一个事务里。
 */
export class Engine implements AgentSessionHandler {
	#documents = new Map<string, OrchestrationDocument>();
	/** 场景版本 ID → 执行计划。 */
	#plans = new Map<string, RunPlan>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			mutex: Mutex;
			hub: AgentHub;
			/** 节点包归档的下载地址（Agent 通过 HTTP 下载）。 */
			packageArchiveUrl: (name: string, version: string) => string;
			/** 任务产物的上传地址（#18，Agent 任务结束后通过 HTTP 上传）。 */
			artifactUploadUrl: (taskId: string) => string;
			/** 触发前的预检（src/runs/preflight.ts）。 */
			preflight: Preflight;
			/** 运行中任务的租约（毫秒），默认 DEFAULT_LEASE_MS。 */
			leaseMs?: number;
			/** 与 Agent 版本一致的 SDK 运行时 wheel（Welcome 里告诉 Agent，#1 评审）；没有时为 undefined。 */
			sdkWheel?: (agentVersion: string) => { url: string; sha256: string } | undefined;
			/** 控制面配置的镜像，原样在 Welcome 里下发（ADR 0012）；未配置的为空。 */
			mirrors?: Mirrors;
			/** 目标版本（控制面版本）、给定架构的 Agent 二进制（Welcome 里告诉 Agent，ADR 0014）；没有时为 undefined。 */
			agentBinary?: (arch: string) => Promise<{ url: string; sha256: string } | undefined>;
		},
	) {}

	get leaseMs(): number {
		return this.deps.leaseMs ?? DEFAULT_LEASE_MS;
	}

	#leaseFrom(now: Date): Date {
		return new Date(now.getTime() + this.leaseMs);
	}

	/** 运行状态变化的通知（主题 = 运行 ID），在状态变更的事务提交之后发布。 */
	readonly runChanges = new Topics<string>();

	/** 上一次心跳没有上报的任务（leases.ts 的 renewHeld）。 */
	readonly #heartbeats = new MissedHeartbeats();

	/** 给辅助模块（waits.ts、leases.ts）用的链推进操作。 */
	readonly #driver: ChainDriver = {
		event: (handle) => this.#event(handle),
		locate: (tx, task) => this.#locate(tx, task),
		advance: (step, run, chain, index) => this.#advance(step, run, chain, index),
		failTask: (step, task, kind, message) => this.#failTask(step, task, kind, message),
	};

	/** 手动触发场景的最新版本。 */
	trigger(
		orchestrationId: string,
		provided: Record<string, unknown>,
		triggeredBy: string,
	): Promise<TriggerOutcome> {
		return this.#event(async (step) => {
			const [orchestration] = await step.tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, orchestrationId))
				// 与归档（OrchestrationStore.archive 加排他锁后检查运行中的运行）互斥。
				.for("share");
			if (!orchestration) {
				return { ok: false, status: 404, code: "not_found", message: "orchestration not found" };
			}
			if (orchestration.archivedAt) {
				return {
					ok: false,
					status: 409,
					code: "archived",
					message: "orchestration is archived; restore it before triggering",
				};
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
			const plan = planRun(version.document);
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
			const filled = fillParams(plan.main.entry.params, provided);
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
			this.#plans.set(version.id, plan);
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
					chainId: plan.main.entry.id,
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

	/**
	 * 立即更新（ADR 0014）：版本不一致、正在更新（下载中或等待任务结束）的在线 Agent 手上的任务立即以 agent_lost 失败（按重试配置在它这里重新排队，
	 * 等它以一致的版本重新连上再派发），事务提交后通知 Agent（UpdateNow）。Agent 按取消流程终止这些任务后照常上报结果，
	 * 控制面已不再等这些尝试，只回 Ack。
	 */
	updateNow(agentName: string): Promise<UpdateNowOutcome> {
		return this.#event(async (step) => {
			const conn = this.deps.hub.connection(agentName);
			if (!conn) {
				const [known] = await step.tx
					.select({ name: agents.name })
					.from(agents)
					.where(eq(agents.name, agentName));
				return known
					? {
							ok: false,
							status: 409,
							code: "agent_offline",
							message: `agent ${agentName} is offline`,
						}
					: { ok: false, status: 404, code: "not_found", message: "agent not found" };
			}
			if (!this.deps.hub.versionMismatch(conn.info)) {
				return {
					ok: false,
					status: 409,
					code: "version_matches",
					message: `agent ${agentName} already runs the control plane version ${this.deps.hub.version}`,
				};
			}
			const update = conn.info.update;
			if (update?.state === "manual_upgrade_required") {
				return {
					ok: false,
					status: 409,
					code: "manual_upgrade_required",
					message: `agent ${agentName} cannot update itself: ${update.reason}`,
				};
			}
			// 只有确实在更新流程中（下载中、等待任务结束）的 Agent 收到指令后会替换自己；更新失败、正在替换，
			// 或还没有自更新能力的旧 Agent（不上报更新状态）终止任务没有意义。
			if (update?.state !== "downloading" && update?.state !== "waiting_for_tasks") {
				return {
					ok: false,
					status: 409,
					code: "not_updating",
					message: `agent ${agentName} is not updating itself (update state: ${update?.state ?? "none"})`,
				};
			}
			const held = await step.tx
				.select({ task: tasks, orchestrationId: runs.orchestrationId })
				.from(tasks)
				.innerJoin(runs, eq(runs.id, tasks.runId))
				.where(and(eq(tasks.agentName, agentName), inArray(tasks.status, ON_AGENT)))
				.orderBy(asc(tasks.seq))
				.for("update", { of: tasks });
			const terminated = held.map(({ task, orchestrationId }) => ({
				task_id: task.id,
				run_id: task.runId,
				orchestration_id: orchestrationId,
				node_id: task.nodeId,
				attempt: task.attempt,
				status: task.status as RunningTaskView["status"],
				started_at: task.startedAt?.toISOString() ?? null,
			}));
			for (const { task } of held) {
				await this.#failTask(step, task, "agent_lost", "Agent 立即更新，终止了这个任务");
			}
			// 与派发消息一样在事务提交后发出。
			step.assigns.push({
				conn,
				message: create(ServerMessageSchema, { body: { case: "updateNow", value: {} } }),
			});
			return { ok: true, terminated };
		});
	}

	/** 取消一个链实例上正在排队 / 运行的任务；任务立即结束时从它后面继续推进链。 */
	async #cancelChain(step: Step, run: RunRow, chain: ChainRow): Promise<void> {
		const plan = await this.#plan(step.tx, run, chain);
		const active = await step.tx
			.select()
			.from(tasks)
			.where(and(eq(tasks.chainInstanceId, chain.id), inArray(tasks.status, ACTIVE_STATUSES)))
			.orderBy(asc(tasks.seq))
			.for("update");
		let resumeAt: number | undefined;
		for (const task of active) {
			const index = plan.nodes.findIndex((n) => n.id === task.nodeId);
			if (!cancelledFor(run, plan.nodes[index])) continue;
			if (onAgent(task) && task.agentName) {
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

	/**
	 * Agent 握手完成（#15）：逐个处置它在 Hello 中上报的任务——控制面仍在等这次尝试（running 且派给它）就继续并续约，
	 * 否则放弃；控制面认为在它上面运行、但 Hello 里没有的任务立即以 agent_lost 失败。
	 * 然后推送 Welcome、重发取消指令、派发排队中的任务。
	 */
	onOnline(conn: AgentConnection, held: RunningTaskRef[]): Promise<void> {
		return this.deps.mutex.run(async () => {
			const dispositions = await this.#step(async (step) => {
				const running = await step.tx
					.select()
					.from(tasks)
					.where(and(eq(tasks.agentName, conn.name), inArray(tasks.status, ON_AGENT)))
					.orderBy(asc(tasks.seq))
					.for("update");
				const kept = (t: RunningTaskRef) =>
					running.some((r) => r.id === t.taskId && r.attempt === t.attempt);
				const out = held.map((t) => ({
					taskId: t.taskId,
					attempt: t.attempt,
					action: kept(t) ? TaskAction.CONTINUE : TaskAction.ABANDON,
				}));
				this.#heartbeats.reset(conn.name);
				await renewHeld(this.#driver, step, conn.name, running, held, {
					lease: this.#leaseFrom(step.now),
					missing: "重新连接时没有上报这个任务",
				});
				// TaskStarted 可能随断开的连接丢失：Hello 里标记已启动的任务补记为 running。
				for (const t of held) if (t.started) await this.#started(step, conn.name, t);
				return out;
			});
			const sdk = this.deps.sdkWheel?.(conn.info.agent_version);
			const binary = await this.deps.agentBinary?.(conn.info.arch);
			conn.welcome(
				create(ServerMessageSchema, {
					body: {
						case: "welcome",
						value: {
							dispositions,
							heartbeatIntervalMs: Math.min(Math.round(this.leaseMs / 3), 0xffff_ffff),
							sdkWheelUrl: sdk?.url ?? "",
							sdkWheelSha256: sdk?.sha256 ?? "",
							pypiMirror: this.deps.mirrors?.pypi ?? "",
							githubReleaseMirror: this.deps.mirrors?.githubRelease ?? "",
							targetAgentVersion: this.deps.hub.version,
							agentBinaryUrl: binary?.url ?? "",
							agentBinarySha256: binary?.sha256 ?? "",
						},
					},
				}),
			);
			await this.#resendCancels(conn);
			await this.#dispatch(conn.name);
		});
	}

	/**
	 * Agent 重新连上时，对它上面仍在运行、但所属运行已被取消或所在子流程已被停止的任务重发取消指令（断线期间可能没收到）。
	 */
	async #resendCancels(conn: AgentConnection): Promise<void> {
		const rows = await this.deps.db
			.select({ task: tasks, run: runs, chain: chainInstances })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.innerJoin(chainInstances, eq(chainInstances.id, tasks.chainInstanceId))
			.where(
				and(
					eq(tasks.agentName, conn.name),
					inArray(tasks.status, ON_AGENT),
					or(isNotNull(runs.cancelRequestedAt), isNotNull(chainInstances.stopTaskId)),
				),
			);
		for (const { task, run, chain } of rows) {
			const plan = await this.deps.db.transaction((tx) => this.#plan(tx, run, chain));
			const node = plan.nodes.find((n) => n.id === task.nodeId);
			const cancelled = cancelledFor(run, node);
			if (!cancelled && !stoppedFor(chain, node)) continue;
			this.#sendCancel({
				agentName: conn.name,
				taskId: task.id,
				attempt: task.attempt,
				force: cancelled && forced(run),
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
		} else if (message.body.case === "started") {
			const started = message.body.value;
			await this.#event((step) => this.#started(step, conn.name, started));
		} else if (message.body.case === "heartbeat") {
			const { runningTasks, update } = message.body.value;
			const held = runningTasks.map(runningTaskRef);
			await this.#event((step) => this.#heartbeat(step, conn.name, held));
			// 不带更新状态的心跳（旧版本 Agent）不改变已保存的状态。
			const state = update && UPDATE_STATES[update.state];
			if (update && state) {
				await this.deps.hub.recordUpdate(conn, {
					state,
					remaining_tasks: update.remainingTasks,
					reason: update.reason,
				});
			}
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
		return this.deps.mutex.run(() => this.#step(handle));
	}

	/** 同 #event，但调用方已持有锁。 */
	async #step<T>(handle: (step: Step) => Promise<T>): Promise<T> {
		const step: Omit<Step, "tx"> = {
			now: this.deps.clock.now(),
			touchedAgents: new Set(),
			touchedRuns: new Set(),
			cancels: [],
			assigns: [],
		};
		const result = await this.deps.db.transaction((tx) => handle({ ...step, tx }));
		this.#publish(step.touchedRuns);
		for (const order of step.cancels) this.#sendCancel(order);
		for (const { conn, message } of step.assigns) conn.send(message);
		// 派发、失败等迁移可能让 Agent 有了新的排队任务或空出槽位。
		for (const agent of step.touchedAgents) await this.#dispatch(agent);
		return result;
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

	/** 运行的执行计划；场景版本不可变，计划可以缓存。 */
	async #runPlan(tx: Tx, run: RunRow): Promise<RunPlan> {
		const cached = this.#plans.get(run.orchestrationVersionId);
		if (cached) return cached;
		const plan = planRun(await this.#document(tx, run.orchestrationVersionId));
		if ("errors" in plan)
			throw new Error(`run ${run.id}: invalid orchestration: ${plan.errors.join("; ")}`);
		this.#plans.set(run.orchestrationVersionId, plan);
		return plan;
	}

	/** 链实例（主链或某个子流程的实例）的执行计划。 */
	async #plan(tx: Tx, run: RunRow, chain: ChainRow): Promise<ChainPlan> {
		const plan = (await this.#runPlan(tx, run)).chains.get(chain.chainId);
		if (!plan) throw new Error(`run ${run.id}: chain ${chain.chainId} not in plan`);
		return plan;
	}

	/** 任务所在的运行、链实例，以及节点在链上的位置。 */
	async #locate(tx: Tx, task: TaskRow): Promise<Located> {
		const [row] = await tx
			.select({ run: runs, chain: chainInstances })
			.from(chainInstances)
			.innerJoin(runs, eq(runs.id, chainInstances.runId))
			.where(eq(chainInstances.id, task.chainInstanceId));
		if (!row) throw new Error(`chain instance ${task.chainInstanceId} not found`);
		const plan = await this.#plan(tx, row.run, row.chain);
		const index = plan.nodes.findIndex((n) => n.id === task.nodeId);
		const node = plan.nodes[index];
		if (!node) throw new Error(`task ${task.id}: node ${task.nodeId} not in plan`);
		return { ...row, plan, index, node };
	}

	/**
	 * 从链上第 index 个节点开始推进：内置节点立即完成，遇到包节点就排队等待派发。
	 * 链上已有节点最终失败时，普通节点标记为 skipped，always 节点照常执行（§3.2）。
	 * 链实例已被停止时，普通节点标记为 stopped（§4.1）。
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
			const base = firstAttempt(run, chain, node.id, step.now);
			if (cancelledFor(run, node)) {
				await step.tx
					.insert(tasks)
					.values({ ...base, status: "cancelled", endedAt: step.now })
					.onConflictDoNothing();
				continue;
			}
			if (stoppedFor(chain, node)) {
				await step.tx
					.insert(tasks)
					.values({ ...base, status: "stopped", endedAt: step.now })
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
			if (node.kind === "stop_subflow") {
				// 子流程还没完全结束时停在这里，由 #settleStops 在它结束后继续。
				if (!(await this.#stopSubflow(step, run, chain, node))) return;
				continue;
			}
			if (node.kind === "async") {
				// 失败时 #failTask 已经推进了这条链的剩余部分。
				if (!(await this.#spawn(step, run, chain, plan, i, node))) return;
				continue;
			}
			if (isWaitNode(node)) {
				// 没到唤醒时间（或配置无效、已由 #failTask 推进）时停在这里。
				const scope = await this.#scope(step.tx, chain, plan, i);
				if (!(await startWait(this.#driver, step, run, chain, node, scope))) return;
				continue;
			}
			if (node.kind === "package") {
				const agentName = agentFor(document, node);
				await step.tx
					.insert(tasks)
					.values({
						...base,
						agentName,
						status: "queued",
						queueExpiresAt: new Date(step.now.getTime() + queueTimeoutMs(node)),
					})
					.onConflictDoNothing();
				step.touchedAgents.add(agentName);
				return;
			}
			// 入口节点 / 子流程入口节点：链实例创建时立即完成。
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

	/**
	 * 异步任务节点（§4）：按参数映射创建一个子流程实例后立即成功，输出子流程实例 ID。
	 * 子流程实例 ID 由运行、父链实例、异步任务节点确定性生成，重放不会重复创建。
	 * 映射里的引用无效、或映射的值不符合子流程入口的参数声明时，以 config_error 失败并返回 false。
	 */
	async #spawn(
		step: Step,
		run: RunRow,
		chain: ChainRow,
		plan: ChainPlan,
		index: number,
		node: AsyncTaskNode,
	): Promise<boolean> {
		const runPlan = await this.#runPlan(step.tx, run);
		const subflow = runPlan.chains.get(runPlan.dispatch.get(node.id) ?? "");
		if (!subflow) throw new Error(`run ${run.id}: async node ${node.id} has no subflow`);
		const base = { ...firstAttempt(run, chain, node.id, step.now), startedAt: step.now };

		let problem: string | undefined;
		let params: Record<string, unknown> = {};
		try {
			const mapped = resolveInputs(node.params, await this.#scope(step.tx, chain, plan, index));
			const filled = fillParams(subflow.entry.params, mapped);
			if ("errors" in filled) problem = `subflow ${subflow.entry.id}: ${filled.errors.join("; ")}`;
			else params = filled.params;
		} catch (error) {
			if (!(error instanceof InvalidReferenceError)) throw error;
			problem = error.message;
		}
		if (problem !== undefined) {
			const [task] = await step.tx
				.insert(tasks)
				.values({ ...base, status: "running" })
				.onConflictDoNothing()
				.returning();
			if (task) await this.#failTask(step, task, "config_error", problem);
			return false;
		}

		const childId = chainInstanceId(run.id, chain.id, node.id);
		const [child] = await step.tx
			.insert(chainInstances)
			.values({
				id: childId,
				runId: run.id,
				chainId: subflow.entry.id,
				parentChainInstanceId: chain.id,
				asyncNodeId: node.id,
				depth: chain.depth + 1,
				params,
				status: "running",
				startedAt: step.now,
			})
			.onConflictDoNothing()
			.returning();
		await step.tx
			.insert(tasks)
			.values({
				...base,
				status: "success",
				inputs: params,
				outputs: { chain_instance_id: childId },
				endedAt: step.now,
			})
			.onConflictDoNothing();
		if (child) await this.#advance(step, run, child, 0);
		return true;
	}

	/**
	 * 停止子流程节点（§4.1）：目标子流程实例（每次运行每个子流程最多一个实例，按子流程入口 ID 确定）
	 * 不存在或已结束时立即成功并返回 true；否则停止它和它直接或间接触发、仍在进行的子流程实例
	 * （chain_instances.stop_task_id 记下这个节点的任务，#stopChain 终止其中的任务），节点进入 waiting 并返回 false，
	 * 等这些子流程完全结束后由 #settleStops 完成。已经被另一个停止子流程节点停止的实例不再重复停止，同样等它们结束；
	 * 运行已被取消时（always 节点）也只等它们结束。
	 * 停止在同一个事务里可能直接让子流程结束（没有需要等 Agent 上报的任务、也没有 always 节点），这时也立即成功。
	 */
	async #stopSubflow(
		step: Step,
		run: RunRow,
		chain: ChainRow,
		node: StopSubflowNode,
	): Promise<boolean> {
		const base = {
			...firstAttempt(run, chain, node.id, step.now),
			startedAt: step.now,
			inputs: { subflow: node.subflow },
		};
		const chains = await step.tx
			.select()
			.from(chainInstances)
			.where(eq(chainInstances.runId, run.id))
			.orderBy(asc(chainInstances.depth), asc(chainInstances.startedAt))
			.for("update");
		const target = chains.find((c) => c.chainId === node.subflow);
		if (!target || target.status !== "running") {
			await step.tx
				.insert(tasks)
				.values({
					...base,
					status: "success",
					outputs: stopOutputs(target?.status ?? null),
					endedAt: step.now,
				})
				.onConflictDoNothing();
			return true;
		}
		// 停止期间先记为 running：子流程在同一个事务里结束时 #settleStops 不会抢先推进这条链。
		const [task] = await step.tx
			.insert(tasks)
			.values({ ...base, status: "running" })
			.onConflictDoNothing()
			.returning();
		if (!task) return false;
		// 运行已被取消时不再停止（§4.1 第 6 条）：子流程按取消的规则结束，这里只等它们结束。
		const pending = cancelling(run)
			? []
			: subtree(chains, target).filter((c) => c.status === "running" && c.stopTaskId === null);
		// 先把要停止的实例都记下来，再逐个终止任务：推进其中一个时，其他实例已经处在停止状态。
		const stopped = pending.length
			? await step.tx
					.update(chainInstances)
					.set({ stopTaskId: task.id, stopRequestedAt: step.now })
					.where(
						inArray(
							chainInstances.id,
							pending.map((c) => c.id),
						),
					)
					.returning()
			: [];
		for (const c of pending) {
			const row = stopped.find((r) => r.id === c.id);
			if (row) await this.#stopChain(step, run, row);
		}
		const status = await this.#stopResult(step.tx, run, node.subflow);
		if (status === undefined) {
			await step.tx.update(tasks).set({ status: "waiting" }).where(eq(tasks.id, task.id));
			return false;
		}
		await step.tx
			.update(tasks)
			.set({ status: "success", outputs: stopOutputs(status), endedAt: step.now })
			.where(eq(tasks.id, task.id));
		return true;
	}

	/**
	 * 停止一个链实例（§4.1 第 3 条）：正在运行的普通任务按取消的方式通知 Agent（优雅取消），等 Agent 上报结果后记为 stopped
	 * （#failTask）；排队中、等待中的普通任务立即 stopped，从它后面继续推进（未开始的普通节点记为 stopped，always 节点照常执行）。
	 */
	async #stopChain(step: Step, run: RunRow, chain: ChainRow): Promise<void> {
		const plan = await this.#plan(step.tx, run, chain);
		const active = await step.tx
			.select()
			.from(tasks)
			.where(and(eq(tasks.chainInstanceId, chain.id), inArray(tasks.status, ACTIVE_STATUSES)))
			.orderBy(asc(tasks.seq))
			.for("update");
		let resumeAt: number | undefined;
		for (const task of active) {
			const index = plan.nodes.findIndex((n) => n.id === task.nodeId);
			if (!stoppedFor(chain, plan.nodes[index])) continue;
			if (onAgent(task) && task.agentName) {
				step.cancels.push({
					agentName: task.agentName,
					taskId: task.id,
					attempt: task.attempt,
					force: false,
				});
				continue;
			}
			await step.tx
				.update(tasks)
				.set({ status: "stopped", endedAt: step.now })
				.where(eq(tasks.id, task.id));
			if (task.agentName) step.touchedAgents.add(task.agentName);
			resumeAt = Math.max(resumeAt ?? 0, index + 1);
		}
		if (resumeAt !== undefined) await this.#advance(step, run, chain, resumeAt);
	}

	/**
	 * 停止子流程节点等待的子流程（子流程入口 ID 为 subflow 的实例和它的各级下级实例）是否都已结束：
	 * 都结束时返回该子流程的最终状态，否则 undefined。
	 */
	async #stopResult(
		tx: Tx,
		run: RunRow,
		subflow: string | undefined,
	): Promise<ChainRow["status"] | undefined> {
		const chains = await tx.select().from(chainInstances).where(eq(chainInstances.runId, run.id));
		const target = chains.find((c) => c.chainId === subflow);
		if (!target) throw new Error(`run ${run.id}: stopped subflow ${subflow} has no instance`);
		if (subtree(chains, target).some((c) => c.status === "running")) return undefined;
		return target.status;
	}

	/**
	 * 链实例结束后：等待它或它的某个上级子流程结束的停止子流程节点，在等待的子流程都已结束时成功，所在的链继续推进。
	 */
	async #settleStops(step: Step, run: RunRow, ended: ChainRow): Promise<void> {
		const chains = await step.tx
			.select()
			.from(chainInstances)
			.where(eq(chainInstances.runId, run.id));
		const subflows = ancestry(chains, ended).map((c) => c.chainId);
		const waiting = await step.tx
			.select()
			.from(tasks)
			.where(
				and(
					eq(tasks.runId, run.id),
					eq(tasks.status, "waiting"),
					inArray(sql<string>`${tasks.inputs} ->> 'subflow'`, subflows),
				),
			)
			.orderBy(asc(tasks.seq))
			.for("update");
		for (const task of waiting) {
			const located = await this.#locate(step.tx, task);
			if (located.node.kind !== "stop_subflow") continue;
			const status = await this.#stopResult(step.tx, run, located.node.subflow);
			if (status === undefined) continue;
			await step.tx
				.update(tasks)
				.set({ status: "success", outputs: stopOutputs(status), endedAt: step.now })
				.where(eq(tasks.id, task.id));
			await this.#advance(step, located.run, located.chain, located.index + 1);
		}
	}

	/**
	 * 链上第 index 个节点解析引用时的作用域（包节点派发、异步任务节点、等待节点共用）：
	 * 本链的入口参数和前面已成功节点的输出。always 节点前面的节点可能失败或被跳过，
	 * 引用缺失的输出得到 null（§2.4）。
	 */
	async #scope(tx: Tx, chain: ChainRow, plan: ChainPlan, index: number): Promise<ResolveScope> {
		const earlierIds = plan.nodes.slice(0, index).map((n) => n.id);
		const done = earlierIds.length
			? await tx
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
		const node = plan.nodes[index];
		const missingAsNull = node !== undefined && isAlways(node);
		if (missingAsNull) {
			for (const id of earlierIds) if (!earlierOutputs.has(id)) earlierOutputs.set(id, {});
		}
		return { params: chain.params, earlierOutputs, missingAsNull };
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
		const [ended] = await step.tx
			.update(chainInstances)
			.set({ status, endedAt: step.now })
			.where(eq(chainInstances.id, chain.id))
			.returning();
		// 等这个子流程结束的停止子流程节点可能可以完成了（它所在的链还没结束，运行也就没结束）。
		if (ended) await this.#settleStops(step, run, ended);
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
		const { run, chain, index, node } = await this.#locate(step.tx, task);
		step.touchedRuns.add(run.id);
		if (cancelledFor(run, node)) {
			await step.tx
				.update(tasks)
				.set({ ...extra, status: "cancelled", errorMessage: message, endedAt: step.now })
				.where(eq(tasks.id, task.id));
			await this.#advance(step, run, chain, index + 1);
			return;
		}
		// 链实例已被停止：Agent 上报的取消（以及其他未成功的结果）记为 stopped、不再重试（§4.1）。
		if (stoppedFor(chain, node)) {
			await step.tx
				.update(tasks)
				.set({ ...extra, status: "stopped", errorMessage: message, endedAt: step.now })
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
		if (task.agentName && shouldRetry(node, kind, task.attempt)) {
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
					queueExpiresAt:
						node.kind === "package" ? new Date(step.now.getTime() + queueTimeoutMs(node)) : null,
				})
				.onConflictDoNothing();
			step.touchedAgents.add(task.agentName);
			return;
		}
		await this.#advance(step, run, chain, index + 1);
	}

	/** 处理任务结果；按 task_id + attempt 幂等：只接受当前正在运行、且派发给该 Agent 的那次尝试。 */
	async #applyResult(step: Step, agentName: string, result: TaskResult): Promise<void> {
		if (!isUuid(result.taskId)) return;
		const [task] = await step.tx
			.select()
			.from(tasks)
			.where(eq(tasks.id, result.taskId))
			.for("update");
		if (
			!task ||
			task.attempt !== result.attempt ||
			!onAgent(task) ||
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
		const { run, chain, index } = await this.#locate(step.tx, task);
		await this.#advance(step, run, chain, index + 1);
	}

	/**
	 * TaskStarted（#1 评审）：执行器子进程已经启动，任务从派发阶段进入 running；
	 * 耗时从这里开始（Agent 也从这时开始计算超时）。只接受派发给该 Agent 的当前尝试。
	 */
	async #started(step: Step, agentName: string, ref: { taskId: string; attempt: number }) {
		if (!isUuid(ref.taskId)) return;
		const [task] = await step.tx
			.update(tasks)
			.set({ status: "running", startedAt: step.now, leaseExpiresAt: this.#leaseFrom(step.now) })
			.where(
				and(
					eq(tasks.id, ref.taskId),
					eq(tasks.attempt, ref.attempt),
					eq(tasks.agentName, agentName),
					eq(tasks.status, "dispatched"),
				),
			)
			.returning({ runId: tasks.runId });
		if (task) step.touchedRuns.add(task.runId);
	}

	/**
	 * Agent 心跳（#15，#1 评审）：只为 Agent 上报的手上任务续约；控制面认为派发给它、
	 * 但连续两次心跳都没有上报的任务以 agent_lost 失败（第一次可能是心跳与派发消息在路上交错）。
	 */
	async #heartbeat(step: Step, agentName: string, held: RunningTaskRef[]): Promise<void> {
		const mine = await step.tx
			.select()
			.from(tasks)
			.where(and(eq(tasks.agentName, agentName), inArray(tasks.status, ON_AGENT)))
			.orderBy(asc(tasks.seq))
			.for("update");
		await renewHeld(this.#driver, step, agentName, mine, held, {
			lease: this.#leaseFrom(step.now),
			missing: "连续两次心跳都没有上报这个任务",
			suspects: this.#heartbeats,
		});
		for (const t of held) {
			if (t.started) await this.#started(step, agentName, t);
		}
	}

	/**
	 * 把排队中的任务派发给在线的 Agent，直到槽位用满。调用方需持有锁。
	 * 版本与控制面不一致的 Agent 不派新任务（ADR 0014），任务留在队列里，等它更新后重新连上再派。
	 */
	async #dispatch(agentName: string): Promise<void> {
		const conn = this.deps.hub.connection(agentName);
		if (!conn || this.deps.hub.versionMismatch(conn.info)) return;
		await this.#step(async (step) => {
			const [running] = await step.tx
				.select({ n: count() })
				.from(tasks)
				.where(and(eq(tasks.agentName, agentName), inArray(tasks.status, ON_AGENT)));
			let free = conn.info.slots - (running?.n ?? 0);
			if (free <= 0) return;
			const queued = await step.tx
				.select()
				.from(tasks)
				.where(and(eq(tasks.agentName, agentName), eq(tasks.status, "queued")))
				.orderBy(asc(tasks.queuedAt), asc(tasks.seq))
				.for("update");
			for (const task of queued) {
				if (free <= 0) break;
				// 周期扫描还没来得及处理的排队超时任务不再派发。
				if (task.queueExpiresAt && task.queueExpiresAt <= step.now) {
					await queueTimedOut(this.#driver, step, task);
					continue;
				}
				const message = await this.#prepareAssign(step, conn, task);
				if (!message) continue;
				step.assigns.push({ conn, message });
				free--;
			}
		});
	}

	/**
	 * 解析输入、按节点类型的输入 schema 校验，并把任务标记为 dispatched；
	 * 引用无效或输入校验失败时任务以 config_error 失败（不重试）并返回 undefined。
	 */
	async #prepareAssign(step: Step, conn: AgentConnection, task: TaskRow) {
		const { run, chain, plan, index, node } = await this.#locate(step.tx, task);
		if (node.kind !== "package") throw new Error(`task ${task.id} is not a package node`);
		const document = await this.#document(step.tx, run.orchestrationVersionId);

		let inputs: Record<string, unknown>;
		try {
			inputs = resolveInputs(node.inputs, await this.#scope(step.tx, chain, plan, index));
		} catch (error) {
			if (!(error instanceof InvalidReferenceError)) throw error;
			await this.#failTask(step, task, "config_error", error.message);
			return undefined;
		}

		const packageVersion = document.packages[node.package] ?? "";
		// 包版本没有安装在 Agent 上时，Agent 按这里的地址下载并校验 sha256；控制面没有该版本时留空。
		const [archive] = await step.tx
			.select({ sha256: nodePackages.sha256, metadata: nodePackages.metadata })
			.from(nodePackages)
			.where(and(eq(nodePackages.name, node.package), eq(nodePackages.version, packageVersion)));
		// 开发版本的元信息由加载它的 Agent 上报；不知道节点类型时不校验（Agent 会以 env_error 失败）。
		const metadata =
			archive?.metadata ??
			(packageVersion === DEV_VERSION
				? (conn.info.dev_packages?.find((p) => p.name === node.package)?.metadata as
						| PackageMetadata
						| null
						| undefined)
				: undefined);
		const type = metadata?.nodes?.find((n) => n.name === node.node);
		const problems = type ? inputProblems(type.inputs, inputs, { allowNull: isAlways(node) }) : [];
		if (problems.length > 0) {
			await step.tx.update(tasks).set({ inputs }).where(eq(tasks.id, task.id));
			await this.#failTask(step, task, "config_error", problems.join("; "));
			return undefined;
		}

		// 派发阶段（下载、安装、启动）：Agent 上报 TaskStarted 后才记为 running（#started）。
		await step.tx
			.update(tasks)
			.set({ status: "dispatched", inputs, leaseExpiresAt: this.#leaseFrom(step.now) })
			.where(eq(tasks.id, task.id));
		step.touchedRuns.add(run.id);
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
					artifactUploadUrl: this.deps.artifactUploadUrl(task.id),
				},
			},
		});
	}

	/** 周期扫描：唤醒到期的定时 / Sleep 节点（waits.ts），返回唤醒的任务数。 */
	wakeTimers(): Promise<number> {
		return wakeTimers(this.#driver, this.deps.db, this.deps.clock.now());
	}

	/** 控制面启动时顺延租约和排队超时，给 Agent 重连的时间（leases.ts）。 */
	recover(): Promise<void> {
		const grace = this.#leaseFrom(this.deps.clock.now());
		return this.deps.mutex.run(() => extendForRecovery(this.deps.db, grace));
	}

	/** 周期扫描：租约过期（agent_lost）与排队超时（env_error），返回失败的任务数（leases.ts）。 */
	expireTasks(): Promise<number> {
		return expireTasks(this.#driver, this.deps.db, this.deps.clock.now());
	}
}
