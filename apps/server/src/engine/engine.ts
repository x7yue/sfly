import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	effectiveQueueTimeout,
	InvalidReferenceError,
	nodeAgentNotRegistered,
	nodeNameWithId,
	queueTimeoutProblem,
	type ResolveScope,
	referencesRunState,
	resolveInputs,
} from "@sfly/orchestration";
import {
	type AgentMessage,
	ErrorKind as ProtoErrorKind,
	TaskStatus as ProtoTaskStatus,
	ServerMessageSchema,
	TaskAction,
	type TaskResult,
} from "@sfly/proto";
import {
	ACTIVE_STATUSES,
	isRemovedNodeKind,
	type RunningTaskView,
	type RunState,
	type StoredNode,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { and, asc, count, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Actor } from "../actor.js";
import type { ClockOffset } from "../agents/agent-clock.js";
import type { AgentEnvironmentFor } from "../agents/agent-environment.js";
import type { AgentConnection, AgentHub } from "../agents/agent-hub.js";
import { loadAgentTasks } from "../agents/agent-tasks.js";
import { connectionBlock, freeSlots } from "../agents/dispatch-gate.js";
import { agentsInProject } from "../agents/project-agents.js";
import { mintTaskCredential } from "../agents/task-credentials.js";
import type { Clock } from "../clock.js";
import type { Db, Tx } from "../db/database.js";
import {
	agents,
	chainInstances,
	type ErrorKind,
	ON_AGENT,
	orchestrationVersions,
	runs,
	tasks,
} from "../db/schema.js";
import {
	type EngineNotifications,
	noPendingNotifications,
} from "../feishu/engine-notifications.js";
import {
	type AgentSessionHandler,
	type RunningTaskRef,
	runningTaskRef,
} from "../gateway/agent-gateway.js";
import type { ProjectId } from "../projects/project-id.js";
import { RunStateError, runStateForDispatch, type SelfNode } from "../runs/run-state-source.js";
import type {
	TriggerAdmission,
	TriggerRejection,
	TriggerRequest,
} from "../runs/trigger-admission.js";
import type { SessionStore } from "../sessions/session-store.js";
import { Topics } from "../sse/topics.js";
import type { Mutex } from "../util/mutex.js";
import { isUuid } from "../util/uuid.js";
import type { AssignContent, AssignContentOf } from "./assign-content.js";
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
import { failForeignAgentTasks } from "./foreign-agent-tasks.js";
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
import { failRemovedWaits, removedNodeFailure } from "./removed-nodes.js";
import {
	type CancelOrder,
	type ChainDriver,
	type ChainRow,
	firstAttempt,
	type Located,
	type RunRow,
	type Step,
	type TaskRow,
} from "./step.js";
import { platformTimeoutHint } from "./timeout-hint.js";
import type { WriteMasking } from "./write-masking.js";

export { DEFAULT_LEASE_MS } from "./leases.js";

/**
 * 节点进入 queued 后最多排队多久（docs/SEMANTICS.md §3.3 queue_timeout，默认 10 分钟）。
 * 场景里写的值不合格时（升级前保存的版本里可能有，#559）用默认值：调用方先用 {@link queueTimeoutProblem} 拦下，
 * 这里保证算出的截止时间永远是有效的时间，不会因为一个写错的数字抛出 Invalid time value。
 */
const queueTimeoutMs = (node: PackageNode) => effectiveQueueTimeout(node) * 1000;

export type TriggerOutcome = { ok: true; runId: string } | TriggerRejection;

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

/** 任务由 Agent 负责（派发阶段或执行阶段）。 */
/** 任务行上「结束时的时钟偏差」两列的值；没有偏差（旧版本 Agent、不是 Agent 上报的结束）时不写这两列。 */
const endClockOffset = (offset: ClockOffset | undefined) =>
	offset ? { endClockOffsetMs: offset.offsetMs, endClockOffsetMeasuredAt: offset.measuredAt } : {};

const onAgent = (task: TaskRow) => (ON_AGENT as readonly string[]).includes(task.status);

/**
 * 错误最里层原因的说明。查询出错时外层（drizzle）的说明带着整条 SQL 和参数（可能是 1 MB 的输出），
 * 最里层才是数据库给的原因。
 */
function rootMessage(error: unknown): string {
	let cause = error;
	while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 是不是数据库报的错（pg 的 DatabaseError，drizzle 会再包一层，原因在 `cause` 里）：带 5 位的 SQLSTATE `code`。
 * 事务里的语句出了这种错，整个事务就中止了，再写什么都会失败。
 */
function isDatabaseError(error: unknown): boolean {
	for (let e: unknown = error; e instanceof Error; e = e.cause) {
		if (/^[0-9A-Z]{5}$/.test(String((e as { code?: unknown }).code ?? ""))) return true;
	}
	return false;
}

/** 运行是否已被取消；强制取消时 always 节点也不再执行（docs/SEMANTICS.md §3.4）。 */
const cancelling = (run: RunRow) => run.cancelRequestedAt !== null;
const forced = (run: RunRow) => run.cancelForcedAt !== null;
/** 运行取消后这个节点还能不能执行：普通取消时只有 always 节点照常执行。 */
const cancelledFor = (run: RunRow, node: StoredNode | undefined) =>
	cancelling(run) && (forced(run) || !node || !isAlways(node));

/** 链实例是否已被停止子流程节点停止（docs/SEMANTICS.md §4.1）；always 节点照常执行。 */
const stoppedFor = (chain: ChainRow, node: StoredNode | undefined) =>
	chain.stopTaskId !== null && (!node || !isAlways(node));

/**
 * 停止子流程节点的输出（docs/SEMANTICS.md §4.1 第 5 条）：子流程的最终结果 success | failed，未触发时为 null。
 * 运行被取消时子流程以 cancelled 结束，它没有成功完成，输出 failed。
 */
const stopOutputs = (status: ChainRow["status"] | null) => ({
	status: status === null ? null : status === "success" ? "success" : "failed",
});

/** 停止子流程节点的任务成功完成：status 是目标子流程的最终状态（未触发时为 null）。 */
const succeedStop = (step: Step, taskId: string, status: ChainRow["status"] | null) =>
	step.tx
		.update(tasks)
		.set({ status: "success", outputs: stopOutputs(status), endedAt: step.now })
		.where(eq(tasks.id, taskId));

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
 * （子流程实例在同一个事务里创建，#spawn）、停止子流程节点和包节点。已移除种类的节点（ADR 0028）不再执行。
 * 租约、排队超时与重启恢复在 leases.ts；辅助模块经 {@link ChainDriver} 回到引擎推进链，仍在同一把锁、同一个事务里。
 */
export class Engine implements AgentSessionHandler {
	#documents = new Map<string, StoredOrchestrationDocument>();
	/** 场景版本 ID → 执行计划。 */
	#plans = new Map<string, RunPlan>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			mutex: Mutex;
			hub: AgentHub;
			/** 派发内容：这次尝试派什么（src/engine/assign-content.ts）。 */
			assignContent: AssignContentOf;
			/** 触发准入：场景现在能不能触发、用什么参数触发（src/runs/trigger-admission.ts）。 */
			admitTrigger: TriggerAdmission;
			/** 运行通知：在 step 的事务里入队，提交后唤醒投递（src/feishu/engine-notifications.ts）。 */
			notifications: EngineNotifications;
			/** 会话：会话令牌触发的运行，在同一个事务里给会话写一条平台记录（#547）。 */
			sessions: SessionStore;
			/** 运行中任务的租约（毫秒），默认 DEFAULT_LEASE_MS。 */
			leaseMs?: number;
			/** Welcome 里和调度无关的部分：目标版本、SDK wheel、镜像、Agent 二进制（src/agents/agent-environment.ts）。 */
			agentEnvironment: AgentEnvironmentFor;
			/** 写入时打码（write-masking.ts）。 */
			masking: WriteMasking;
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

	/** 给辅助模块（leases.ts、removed-nodes.ts）用的链推进操作。 */
	readonly #driver: ChainDriver = {
		event: (handle) => this.#event(handle),
		locate: (tx, task) => this.#locate(tx, task),
		advance: (step, run, chain, index) => this.#advance(step, run, chain, index),
		failTask: (step, task, kind, message) => this.#failTask(step, task, kind, message),
	};

	/**
	 * 手动触发场景的最新版本。能不能触发、用什么参数触发（含运行预设）由触发准入回答
	 * （src/runs/trigger-admission.ts，在这个事务里读）；可以时在同一个事务里创建运行和主链实例并开始推进。
	 */
	trigger(orchestrationId: string, request: TriggerRequest, actor: Actor): Promise<TriggerOutcome> {
		return this.#event(async (step) => {
			// 会话令牌的触发：事务里等行锁有上限（超时回滚、HTTP 503），不让没想到的等待变成永远卡住。
			if (actor.sessionId !== null) await this.deps.sessions.limitWriteLockWait(step.tx);
			const admitted = await this.deps.admitTrigger(step.tx, orchestrationId, request);
			if (!admitted.ok) return admitted;
			const { projectId, version, plan, params, runPreset } = admitted;
			this.#documents.set(version.id, version.document);
			this.#plans.set(version.id, plan);
			const runId = randomUUID();
			const mainId = chainInstanceId(runId);
			const masked = this.deps.masking.firstVault({
				document: version.document,
				plan,
				chainInstanceId: mainId,
				params,
			});
			const [run] = await step.tx
				.insert(runs)
				.values({
					id: runId,
					orchestrationId,
					orchestrationVersionId: version.id,
					// 运行的项目和它的场景一致（触发准入读场景时一起取出，ADR 0029）。
					projectId,
					triggeredBy: actor.nickname,
					triggeredByUserId: actor.userId,
					triggeredVia: actor.via,
					triggeredToken: actor.token,
					// 经哪个会话触发：依据是请求带的会话令牌（访问检查给出），不是模型在对话里怎么说。
					sessionId: actor.sessionId,
					params: masked.params,
					...runPreset,
					status: "running",
					startedAt: step.now,
					maskedOnWrite: true,
					secretsOversize: masked.oversize,
				})
				.returning();
			await this.deps.masking.saveVault(step, runId, masked.vault);
			const [chain] = await step.tx
				.insert(chainInstances)
				.values({
					id: mainId,
					runId,
					chainId: plan.main.entry.id,
					depth: 0,
					params: masked.params,
					status: "running",
					startedAt: step.now,
				})
				.returning();
			await this.#advance(step, run as RunRow, chain as ChainRow, 0);
			if (actor.sessionId !== null) {
				// 会话令牌触发的：同一个事务里给会话写一条平台记录（成果栏只读这些记录），提交之后再推送。慢的都做完了（引擎的锁、
				// 场景的锁、运行的写入和推进）：记录是事务的最后一件事（会话那一行的锁是最后拿的一把），事务里不等任何进程里的锁。
				const { sessionId } = actor;
				const event = await this.deps.sessions.recordPlatform(step.tx, sessionId, {
					kind: "run",
					run_id: runId,
					scenario_name: admitted.scenarioName,
				});
				step.afterCommit.push(() => this.deps.sessions.announce(sessionId, event));
			}
			return { ok: true, runId };
		});
	}

	/**
	 * 取消整个运行（docs/SEMANTICS.md §3.4），作用于运行的所有链实例。第一次：正在运行的普通任务收到优雅取消、
	 * 等 Agent 上报结果；排队中的普通任务和未开始的普通节点立即 cancelled；always 节点照常执行。
	 * 运行还没结束时再次取消即强制取消：所有任务（含 always）立即 cancelled 并通知 Agent 杀掉进程树。
	 */
	cancel(runId: string, actor: Actor): Promise<CancelOutcome> {
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
						: {
								cancelRequestedAt: step.now,
								cancelRequestedBy: actor.nickname,
								cancelRequestedByUserId: actor.userId,
								cancelRequestedVia: actor.via,
								cancelRequestedToken: actor.token,
							},
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
	updateNow(project: ProjectId, agentName: string): Promise<UpdateNowOutcome> {
		return this.#event(async (step) => {
			// 先确认 Agent 在这个项目里：别的项目的 Agent 和不存在一样（ADR 0029），不论它在不在线。
			const [known] = await step.tx
				.select({ name: agents.name })
				.from(agents)
				.where(and(eq(agents.projectId, project), eq(agents.name, agentName)));
			if (!known) return { ok: false, status: 404, code: "not_found", message: "agent not found" };
			const conn = this.deps.hub.connection(agentName);
			if (!conn) {
				return {
					ok: false,
					status: 409,
					code: "agent_offline",
					message: `agent ${agentName} is offline`,
				};
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
				.select()
				.from(tasks)
				.where(and(eq(tasks.agentName, agentName), inArray(tasks.status, ON_AGENT)))
				.orderBy(asc(tasks.seq))
				.for("update");
			// 返回给调用方的是锁住的这些任务，在失败之前取（失败后状态就变了）；
			// 它们随即以 agent_lost 结束，不再有正在做的动作。
			const terminated = (
				await loadAgentTasks(
					step.tx,
					inArray(
						tasks.id,
						held.map((task) => task.id),
					),
				)
			).running.map((t) => ({ ...t.view, current_action: null }));
			for (const task of held) {
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
	 * 然后推送 Welcome、重发取消指令。Agent 接着准备环境，准备好（Welcome 之后的第一次心跳）才派发排队中的任务（#219）。
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
			const environment = await this.deps.agentEnvironment(conn.info);
			conn.welcome(
				create(ServerMessageSchema, {
					body: {
						case: "welcome",
						value: {
							dispositions,
							heartbeatIntervalMs: Math.min(Math.round(this.leaseMs / 3), 0xffff_ffff),
							...environment,
						},
					},
				}),
				this.deps.clock.now(),
			);
			await this.#resendCancels(conn);
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
			const offset = conn.clock.offsetAt(result);
			try {
				await this.#event((step) => this.#applyResult(step, conn.name, result, offset));
			} catch (error) {
				// 结果写不进数据库（例如数据库拒绝其中的内容）：这次尝试以 node_error 结束（#207）。否则 Agent 收不到 Ack，
				// 重连后重发同一条结果，任务一直停在运行中。连这一步也失败时（数据库不可用）照常抛出，由 Agent 重连后重发。
				await this.#event((step) =>
					this.#rejectResult(
						step,
						conn.name,
						result,
						`控制面无法保存任务结果：${rootMessage(error)}`,
						offset,
					),
				);
			}
			conn.send(
				create(ServerMessageSchema, {
					body: { case: "ack", value: { taskId: result.taskId, attempt: result.attempt } },
				}),
			);
		} else if (message.body.case === "started") {
			const started = message.body.value;
			const offset = conn.clock.offsetAt(started);
			await this.#event((step) => this.#started(step, conn.name, started, offset));
		} else if (message.body.case === "heartbeat") {
			const { runningTasks, update } = message.body.value;
			const held = runningTasks.map(runningTaskRef);
			await this.#event(async (step) => {
				await this.#heartbeat(step, conn.name, held);
				// Welcome 之后的第一次心跳：Agent 已准备好环境，提交后立即派发排队中的任务（#219）。
				if (conn.heartbeat()) step.touchedAgents.add(conn.name);
			});
			// 不带更新状态的心跳（旧版本 Agent）不改变已保存的状态。
			if (update) await this.deps.hub.recordUpdate(conn, update);
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
			notifications: noPendingNotifications(),
			afterCommit: [],
		};
		const result = await this.deps.db.transaction((tx) => handle({ ...step, tx }));
		this.#publish(step.touchedRuns);
		// 提交之后的收尾（推送会话里的平台记录：交给会话的链、不等它；推送失败只记日志，后面的取消、派发照做）。
		for (const after of step.afterCommit) after();
		for (const order of step.cancels) this.#sendCancel(order);
		for (const { conn, message } of step.assigns) conn.send(message);
		await this.deps.notifications.committed(step.notifications);
		// 派发、失败等迁移可能让 Agent 有了新的排队任务或空出槽位。
		for (const agent of step.touchedAgents) await this.#dispatch(agent);
		return result;
	}

	#publish(runIds: Iterable<string>): void {
		for (const runId of runIds) this.runChanges.publish(runId, runId);
	}

	async #document(tx: Tx, versionId: string): Promise<StoredOrchestrationDocument> {
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
		// 升级前开始、还没跑完的运行绑定的版本里可以有已移除种类的节点（ADR 0028）：照常排出计划，
		// 走到它时在 #advance 里按配置错误失败；触发和预检不收这样的场景。
		const plan = planRun(await this.#document(tx, run.orchestrationVersionId), {
			allowRemoved: true,
		});
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
	 * 链上已有节点最终失败时，普通节点标记为 skipped，always 节点照常执行（docs/SEMANTICS.md §3.2）。
	 * 链实例已被停止时，普通节点标记为 stopped（docs/SEMANTICS.md §4.1）。
	 * 运行已被取消时，普通节点标记为 cancelled（强制取消时 always 节点也是），链以 cancelled 结束（docs/SEMANTICS.md §3.4）。
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
			if (isRemovedNodeKind(node.kind)) {
				// 引擎不再执行已移除种类的节点（ADR 0028）；只有升级前开始、还没跑完的运行会走到这里：
				// 节点按配置错误失败（不重试），这条链后面的节点照常按失败的规则推进。
				const [task] = await step.tx
					.insert(tasks)
					.values({ ...base, status: "running", startedAt: step.now })
					.onConflictDoNothing()
					.returning();
				if (task) {
					await this.#failTask(
						step,
						task,
						"config_error",
						removedNodeFailure({ ...node, kind: node.kind }),
					);
				}
				return;
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
			if (node.kind === "package") {
				// 场景里写的排队超时不合格（升级前保存的版本里可能有，保存和触发前的预检已经拦了，#559）：算不出有效的排队
				// 截止时间，这个节点按配置错误失败（不重试），这条链后面的节点照常按失败的规则推进。
				const queueProblem = queueTimeoutProblem(nodeNameWithId(node), node.queue_timeout);
				if (queueProblem) {
					const [task] = await step.tx
						.insert(tasks)
						.values({ ...base, status: "running", startedAt: step.now })
						.onConflictDoNothing()
						.returning();
					if (task) await this.#failTask(step, task, "config_error", queueProblem);
					return;
				}
				const agentName = agentFor(document, node);
				// 派发到的 Agent 必须注册在这次运行所在的项目里：别的项目的 Agent 和没有注册过一样，任务不入队，
				// 按配置错误失败（不重试），说明和预检的「还没有注册过」是同一句。预检拦在前面，走到这里的是预检之后
				// 才变了的（例如 Agent 被删除）。
				if ((await agentsInProject(step.tx, run.projectId, [agentName])).length === 0) {
					const [task] = await step.tx
						.insert(tasks)
						.values({ ...base, status: "running", startedAt: step.now })
						.onConflictDoNothing()
						.returning();
					if (task) {
						await this.#failTask(
							step,
							task,
							"config_error",
							nodeAgentNotRegistered(nodeNameWithId(node), agentName),
						);
					}
					return;
				}
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
	 * 异步任务节点（docs/SEMANTICS.md §4）：按参数映射创建一个子流程实例后立即成功，输出子流程实例 ID。
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
			const mapped = resolveInputs(node.params, await this.#scope(step, run, chain, plan, index));
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
		params = await this.deps.masking.chainParams(step, run, {
			document: await this.#document(step.tx, run.orchestrationVersionId),
			chainId: subflow.entry.id,
			chainInstanceId: childId,
			declarations: subflow.entry.params,
			params,
		});
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
	 * 停止子流程节点（docs/SEMANTICS.md §4.1）：目标子流程实例（每次运行每个子流程最多一个实例，按子流程入口 ID 确定）
	 * 不存在、或它和它的各级下级实例都已结束时立即成功并返回 true；否则停止其中仍在进行的子流程实例
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
		// 未触发、或目标和它的各级下级都已结束时立即成功（docs/SEMANTICS.md §4.1 第 2 条）；目标结束但下级还在运行时仍要停止下级。
		const ended = !target || subtree(chains, target).every((c) => c.status !== "running");
		// 停止期间先记为 running：子流程在同一个事务里结束时 #settleStops 不会抢先推进这条链。
		const [task] = await step.tx
			.insert(tasks)
			.values({ ...base, status: "running" })
			.onConflictDoNothing()
			.returning();
		if (ended) {
			if (task) await succeedStop(step, task.id, target?.status ?? null);
			return true;
		}
		if (!task) return false;
		// 运行已被取消时不再停止（docs/SEMANTICS.md §4.1 第 6 条）：子流程按取消的规则结束，这里只等它们结束。
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
		await succeedStop(step, task.id, status);
		return true;
	}

	/**
	 * 停止一个链实例（docs/SEMANTICS.md §4.1 第 3 条）：正在运行的普通任务按取消的方式通知 Agent（优雅取消），等 Agent 上报结果后记为 stopped
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
			await succeedStop(step, task.id, status);
			await this.#advance(step, located.run, located.chain, located.index + 1);
		}
	}

	/**
	 * 链上第 index 个节点解析引用时的作用域（包节点派发、异步任务节点共用）：
	 * 本链的入口参数和前面已成功节点的输出。always 节点前面的节点可能失败或被跳过，
	 * 引用缺失的输出得到 null（docs/SEMANTICS.md §2.4）。
	 */
	async #scope(
		step: Step,
		run: RunRow,
		chain: ChainRow,
		plan: ChainPlan,
		index: number,
	): Promise<ResolveScope> {
		const earlierIds = plan.nodes.slice(0, index).map((n) => n.id);
		const done = earlierIds.length
			? await step.tx
					.select({ id: tasks.id, nodeId: tasks.nodeId, outputs: tasks.outputs })
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
		const taskIds = new Map(done.map((d) => [d.nodeId, d.id]));
		const scope = { params: chain.params, earlierOutputs, missingAsNull };
		return this.deps.masking.rawScope(step, run, chain.id, scope, taskIds);
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
	 * 链结束；运行的所有链都结束后运行才结束：被取消的运行为 cancelled，否则任一条链失败则运行失败（docs/SEMANTICS.md §6 第 4 条）。
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
		// 只有第一次把运行记为结束的事务发运行通知：同一个运行不会发两张卡片。
		const [finished] = await step.tx
			.update(runs)
			.set({ status: runStatus, endedAt: step.now })
			.where(and(eq(runs.id, run.id), eq(runs.status, "running")))
			.returning({ id: runs.id });
		if (!finished) return;
		// 运行通知和运行的最终状态在同一个事务里（#232）。
		await this.deps.notifications.runFinished(step, { run, status: runStatus });
	}

	/**
	 * 任务失败：可重试的错误且还有重试次数时，在同一个 Agent 上排队下一次尝试（attempt + 1）；
	 * 否则节点最终失败，链继续往后推进（普通节点跳过、always 节点照常执行）。
	 * 运行已被取消时（普通节点，或强制取消时的任何节点），任务记为 cancelled、不再重试（docs/SEMANTICS.md §3.4）。
	 * 所在的链已被停止时，Agent 上报的取消结果（cancelled）和 Agent 失联（agent_lost，任务本来就要被终止）记为 stopped；
	 * 节点自己报的失败（node_error、timeout……）仍是失败，但不再重试（docs/SEMANTICS.md §4.1）。
	 */
	async #failTask(
		step: Step,
		task: TaskRow,
		kind: ErrorKind,
		message: string,
		{
			cancelled = false,
			endOffset,
			location,
		}: { cancelled?: boolean; endOffset?: ClockOffset; location?: string } = {},
	): Promise<void> {
		const ended = { endedAt: step.now, ...endClockOffset(endOffset) };
		const { run, chain, index, node } = await this.#locate(step.tx, task);
		message = await this.deps.masking.text(step, run, message);
		location = await this.deps.masking.text(step, run, location);
		step.touchedRuns.add(run.id);
		if (cancelledFor(run, node)) {
			await step.tx
				.update(tasks)
				.set({ status: "cancelled", errorMessage: message, ...ended })
				.where(eq(tasks.id, task.id));
			await this.#advance(step, run, chain, index + 1);
			return;
		}
		const stopped = stoppedFor(chain, node);
		if (stopped && (cancelled || kind === "agent_lost")) {
			await step.tx
				.update(tasks)
				.set({ status: "stopped", errorMessage: message, ...ended })
				.where(eq(tasks.id, task.id));
			await this.#advance(step, run, chain, index + 1);
			return;
		}
		await step.tx
			.update(tasks)
			.set({
				status: "failed",
				errorKind: kind,
				errorMessage: message,
				errorLocation: location || null,
				...ended,
			})
			.where(eq(tasks.id, task.id));
		// 已被停止的链不再派发新的尝试：这次失败就是节点的最终结果（docs/SEMANTICS.md §4.1 第 4 条），后面的普通节点记为 stopped。
		// 排队超时不合格的节点（升级前保存的版本里可能有）第一次尝试就没有排上队，走不到这里；防御性地不为它重试。
		if (
			!stopped &&
			task.agentName &&
			shouldRetry(node, kind, task.attempt) &&
			(node.kind !== "package" ||
				queueTimeoutProblem(nodeNameWithId(node), node.queue_timeout) === undefined)
		) {
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

	/**
	 * 处理任务结果；按 task_id + attempt 幂等：只接受当前正在运行、且派发给该 Agent 的那次尝试。
	 * `endOffset` 是结果里的时钟读数算出的结束时的时钟偏差（#175）；结束时间仍是处理这条结果的时刻。
	 */
	async #applyResult(
		step: Step,
		agentName: string,
		result: TaskResult,
		endOffset?: ClockOffset,
	): Promise<void> {
		const task = await this.#resultTask(step, agentName, result);
		if (!task) return;

		if (result.status !== ProtoTaskStatus.SUCCESS) {
			const kind = ERROR_KINDS[result.error?.kind ?? ProtoErrorKind.UNSPECIFIED] ?? "node_error";
			const message = result.error?.message ?? "";
			await this.#failTask(
				step,
				task,
				kind,
				kind === "timeout" ? await this.#withTimeoutHint(step, task, message) : message,
				{
					cancelled: result.status === ProtoTaskStatus.CANCELLED,
					endOffset,
					location: result.error?.location,
				},
			);
			return;
		}
		let outputs: unknown;
		try {
			outputs = result.outputsJson === "" ? {} : JSON.parse(result.outputsJson);
		} catch {
			outputs = undefined;
		}
		if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
			await this.#failTask(step, task, "node_error", "task outputs must be a JSON object", {
				endOffset,
			});
			return;
		}
		const { run, chain, index } = await this.#locate(step.tx, task);
		await step.tx
			.update(tasks)
			.set({
				status: "success",
				outputs: await this.deps.masking.outputs(
					step,
					run,
					task.id,
					outputs as Record<string, unknown>,
				),
				endedAt: step.now,
				...endClockOffset(endOffset),
			})
			.where(eq(tasks.id, task.id));
		await this.#advance(step, run, chain, index + 1);
	}

	/** 超时失败的错误信息：用的是平台默认的超时时，Agent 报的原文后面另起一行补一句怎么办（timeout-hint.ts）。 */
	async #withTimeoutHint(step: Step, task: TaskRow, message: string): Promise<string> {
		const { run, node } = await this.#locate(step.tx, task);
		if (node.kind !== "package") return message;
		const document = await this.#document(step.tx, run.orchestrationVersionId);
		const hint = await platformTimeoutHint(
			step.tx,
			run.projectId,
			document,
			node.id,
			task.agentName,
		);
		return hint ? `${message}\n${hint}` : message;
	}

	/**
	 * 结果对应的任务：只接受当前正在运行、且派发给该 Agent 的那次尝试（锁住这一行），否则为 undefined。
	 */
	async #resultTask(
		step: Step,
		agentName: string,
		result: TaskResult,
	): Promise<TaskRow | undefined> {
		if (!isUuid(result.taskId)) return undefined;
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
			return undefined;
		}
		step.touchedAgents.add(agentName);
		return task;
	}

	/** 结果写不进数据库时（{@link Engine.onMessage}）：这次尝试以 node_error 失败，错误信息写明原因。 */
	async #rejectResult(
		step: Step,
		agentName: string,
		result: TaskResult,
		message: string,
		endOffset?: ClockOffset,
	): Promise<void> {
		const task = await this.#resultTask(step, agentName, result);
		if (!task) return;
		await this.#failTask(step, task, "node_error", message, {
			cancelled: result.status === ProtoTaskStatus.CANCELLED,
			endOffset,
		});
	}

	/**
	 * TaskStarted（#1 评审）：执行器子进程已经启动，任务从派发阶段进入 running；
	 * 耗时从这里开始（Agent 也从这时开始计算超时）。只接受派发给该 Agent 的当前尝试。
	 * `startOffset` 是 TaskStarted 里的时钟读数算出的开始时的时钟偏差（#175）；由 Hello / 心跳补记开始时没有。
	 */
	async #started(
		step: Step,
		agentName: string,
		ref: { taskId: string; attempt: number },
		startOffset?: ClockOffset,
	) {
		if (!isUuid(ref.taskId)) return;
		const [task] = await step.tx
			.update(tasks)
			.set({
				status: "running",
				startedAt: step.now,
				leaseExpiresAt: this.#leaseFrom(step.now),
				startClockOffsetMs: startOffset?.offsetMs ?? null,
				startClockOffsetMeasuredAt: startOffset?.measuredAt ?? null,
			})
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
	 * 把排队中的任务派发给已准备好环境的 Agent，直到槽位用满。调用方需持有锁。
	 * 准备环境期间（Welcome 之后、第一次心跳之前）不派发，任务留在队列里、不计租约（#219）。
	 * 版本与控制面不一致的 Agent 不派新任务（ADR 0014），任务留在队列里，等它更新后重新连上再派。
	 */
	async #dispatch(agentName: string): Promise<void> {
		const conn = this.deps.hub.connection(agentName);
		// 能不能派发由 agents/dispatch-gate.ts 判断（页面上「排队中的任务在等什么」用的是同一段判断）。
		if (!conn || connectionBlock(conn, this.deps.hub.versionMismatch(conn.info)) !== null) return;
		await this.#step(async (step) => {
			const [running] = await step.tx
				.select({ n: count() })
				.from(tasks)
				.where(and(eq(tasks.agentName, agentName), inArray(tasks.status, ON_AGENT)));
			let free = freeSlots(conn.info.slots, running?.n ?? 0);
			if (free <= 0) return;
			const queued = await step.tx
				.select()
				.from(tasks)
				.where(and(eq(tasks.agentName, agentName), eq(tasks.status, "queued")))
				.orderBy(asc(tasks.queuedAt), asc(tasks.seq))
				.for("update");
			if (queued.length === 0) return;
			for (const task of queued) {
				if (free <= 0) break;
				// 周期扫描还没来得及处理的排队超时任务不再派发。
				if (task.queueExpiresAt && task.queueExpiresAt <= step.now) {
					// 派发只发给已准备好的连接，所以这里一定不是在准备环境。
					await queueTimedOut(this.#driver, step, task, "unavailable");
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
	 * 把任务标记为 dispatched（派发即设租约）并返回要发给 Agent 的派发消息。派发什么由派发内容回答
	 * （assign-content.ts）；它说不能派发、或者准备它的过程中出错时，任务以 config_error 或 env_error 失败（不重试），
	 * 返回 undefined：一个任务准备不好不能卡住这台 Agent 上排在它后面的任务（见 {@link Engine.#assignContent}）。
	 */
	async #prepareAssign(step: Step, conn: AgentConnection, task: TaskRow) {
		const { run, chain, plan, index, node } = await this.#locate(step.tx, task);
		if (node.kind !== "package") throw new Error(`task ${task.id} is not a package node`);
		// 任务只派发给连接在这次运行所在的项目里的 Agent：别的项目的 Agent 和没有注册过一样，任务按配置错误失败
		// （不重试），说明和入队时、预检时的一样。入队时已经核对过；这里是升级前已经入队的，和入队之后 Agent
		// 才换了项目的。Agent 的项目从凭据得出（#492），所以**以连接的项目为准**，不是库里登记记录的项目：
		// 连接的项目和登记一致由 `AgentHub.attach` 在锁里保证，这里是派发前的最后一道核对。
		if (conn.project !== run.projectId) {
			await this.#failTask(
				step,
				task,
				"config_error",
				nodeAgentNotRegistered(nodeNameWithId(node), conn.name),
			);
			return undefined;
		}
		const document = await this.#document(step.tx, run.orchestrationVersionId);
		const content = await this.#assignContent(step, conn, task, {
			run,
			chain,
			plan,
			index,
			node,
			packageVersion: document.packages[node.package] ?? "",
		});
		if (!content.ok) {
			if (content.inputs) {
				const inputs = await this.deps.masking.record(step, run, content.inputs);
				await step.tx.update(tasks).set({ inputs }).where(eq(tasks.id, task.id));
			}
			await this.#failTask(step, task, content.kind, content.message);
			return undefined;
		}

		// 派发阶段（下载、安装、启动）：Agent 上报 TaskStarted 后才记为 running（#started）。
		await step.tx
			.update(tasks)
			.set({
				status: "dispatched",
				inputs: await this.deps.masking.record(step, run, content.inputs),
				referencedFeishuBots: content.referencedFeishuBots,
				leaseExpiresAt: this.#leaseFrom(step.now),
			})
			.where(eq(tasks.id, task.id));
		step.touchedRuns.add(run.id);
		// 任务凭据：只在这次尝试有效，SDK 下载产物用（ADR 0029「凭据」）；和「派发中」的状态在同一个事务里。
		const taskToken = await mintTaskCredential(
			step.tx,
			{ id: task.id, projectId: run.projectId },
			conn.credentialId,
			step.now,
		);
		return create(ServerMessageSchema, {
			body: { case: "assign", value: { ...content.assign, taskToken } },
		});
	}

	/**
	 * 回答这个任务的派发内容：本链的作用域、`${{ run.state }}`（ADR 0031：只在这个节点的输入里引用它时才读运行状态，
	 * 读取和把这次尝试记为「准备中」在同一个事务里，没有引用它的节点的派发没有多出任何查询）、派发内容（assign-content.ts）。
	 *
	 * 准备这个任务的内容时出错，不能让整个派发的事务回滚：回滚之后这台 Agent 上排在它后面的任务全部派发不出去，
	 * 每次扫描又从它开始重来。所以出错就让这个任务以 config_error 失败（不重试），错误信息写明原因，同一个事务里别的任务照常派发：
	 * - 读运行状态：在保存点里读，数据库报错也只回滚到这里（事务不会中止），转成 {@link RunStateError}；
	 * - 其余的 JS 错误（解析、序列化、元信息不合法……）：按「准备派发内容时出错：原因」失败；
	 * - 没有保存点保护时数据库报错（事务已经中止，再写什么都会失败）原样抛出，不是这个任务的问题，和以前一样。
	 */
	async #assignContent(
		step: Step,
		conn: AgentConnection,
		task: TaskRow,
		at: {
			run: RunRow;
			chain: ChainRow;
			plan: ChainPlan;
			index: number;
			node: PackageNode;
			packageVersion: string;
		},
	): Promise<AssignContent> {
		try {
			const scope = await this.#scope(step, at.run, at.chain, at.plan, at.index);
			if (referencesRunState(at.node.inputs)) {
				scope.runState = await this.#runState(step.tx, at.run.id, {
					chain_instance_id: at.chain.id,
					node_id: at.node.id,
				});
			}
			return await this.deps.assignContent(step.tx, {
				task,
				project: at.run.projectId,
				node: at.node,
				packageVersion: at.packageVersion,
				scope,
				target: conn,
			});
		} catch (error) {
			if (error instanceof RunStateError) {
				return { ok: false, kind: "config_error", message: error.message };
			}
			if (isDatabaseError(error)) throw error;
			return {
				ok: false,
				kind: "config_error",
				message: `准备派发内容时出错：${rootMessage(error)}`,
			};
		}
	}

	/** 读这次运行此刻的状态：在保存点里读，出错（含数据库报错）时只回滚到保存点，转成 {@link RunStateError}。 */
	async #runState(tx: Tx, runId: string, self: SelfNode): Promise<RunState> {
		try {
			return await tx.transaction((savepoint) => runStateForDispatch(savepoint, runId, self));
		} catch (error) {
			if (error instanceof RunStateError) throw error;
			throw new RunStateError(
				`解析 \${{ run.state }} 失败：读取这次运行的状态时出错：${rootMessage(error)}`,
			);
		}
	}

	/**
	 * 控制面启动时顺延租约和排队超时，给 Agent 重连的时间（leases.ts）；升级前正在等待、
	 * 节点已被移除的任务按配置错误失败（removed-nodes.ts）。
	 */
	async recover(
		onError?: (error: unknown, task: { id: string; runId: string }) => void,
	): Promise<void> {
		const grace = this.#leaseFrom(this.deps.clock.now());
		await this.deps.mutex.run(() => extendForRecovery(this.deps.db, grace));
		await failRemovedWaits(this.#driver, this.deps.db, onError);
		await failForeignAgentTasks(this.#driver, this.deps.db, onError);
	}

	/** 周期扫描：租约过期（agent_lost）与排队超时（env_error），返回失败的任务数（leases.ts）。 */
	expireTasks(): Promise<number> {
		return expireTasks(
			this.#driver,
			this.deps.db,
			this.deps.clock.now(),
			(agentName) => this.deps.hub.preparingSince(agentName) !== undefined,
		);
	}
}
