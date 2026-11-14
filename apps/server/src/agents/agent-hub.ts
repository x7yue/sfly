import type { ServerMessage } from "@sfly/proto";
import type { AgentEndpointView, ClockOffsetView } from "@sfly/schema";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	type AgentInfo,
	type AgentStatus,
	type AgentUpdateInfo,
	agents,
	type CapabilityInfo,
	type DevPackageInfo,
	type InstalledPackage,
	type InstallProgress,
	ON_AGENT,
	runs,
	tasks,
} from "../db/schema.js";
import { devMetadataWithDefaultCharts } from "../packages/default-charts.js";
import type { AsyncQueue } from "../util/async-queue.js";
import type { Mutex } from "../util/mutex.js";
import {
	type AgentClockReading,
	ConnectionClock,
	clockOffsetView,
	measureClockOffset,
} from "./agent-clock.js";
import { agentEndpoint } from "./agent-endpoint.js";

/** proto 的 DevPackage 转成存储形式：metadata_json 解析为对象（不是 JSON 对象时为 null）。 */
export function devPackageInfo(p: { name: string; source: string; metadataJson: string }) {
	let metadata: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = JSON.parse(p.metadataJson);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			metadata = parsed as Record<string, unknown>;
		}
	} catch {
		// 保持 null
	}
	return { name: p.name, source: p.source, metadata } satisfies DevPackageInfo;
}

/** 每个 Agent 默认的并发槽位数（docs/SEMANTICS.md 默认值）。 */
export const DEFAULT_SLOTS = 4;

/**
 * 连接的阶段（#219）：
 * - registered：已注册，还没推送 Welcome（#15：Welcome 带着对重连前任务的处置，之前不能向它派发或取消）；
 * - preparing：已推送 Welcome，Agent 在准备环境（since 是推送 Welcome 的控制面时间），可以发取消等指令，不派发；
 * - ready：Welcome 之后收到了第一次心跳，Agent 已准备好环境，开始派发。
 */
type ConnectionPhase =
	| { readonly name: "registered" }
	| { readonly name: "preparing"; readonly since: Date }
	| { readonly name: "ready" };

/** 一个已完成握手的 Agent 连接。 */
export class AgentConnection {
	constructor(
		readonly name: string,
		public info: AgentInfo,
		readonly outbox: AsyncQueue<ServerMessage>,
		/** 这次连接的「单调时钟读数 → 控制面时间」对应关系（ADR 0018）：日志、进度、指标、任务事件共用。 */
		readonly clock: ConnectionClock,
	) {}

	#phase: ConnectionPhase = { name: "registered" };

	/** 已推送 Welcome：可以发取消等指令。 */
	get welcomed(): boolean {
		return this.#phase.name !== "registered";
	}

	/** Agent 已准备好环境：可以派发。 */
	get ready(): boolean {
		return this.#phase.name === "ready";
	}

	/** Agent 开始准备环境的控制面时间（推送 Welcome 的时刻）；还没推送 Welcome 或已准备好时为 undefined。 */
	get preparingSince(): Date | undefined {
		return this.#phase.name === "preparing" ? this.#phase.since : undefined;
	}

	/** 推送 Welcome（控制面时间 `at`），Agent 开始准备环境。 */
	welcome(message: ServerMessage, at: Date): void {
		this.send(message);
		this.#phase = { name: "preparing", since: at };
	}

	/** Agent 发来心跳：Welcome 之后的第一次表示它已准备好环境。返回这次是否刚刚准备好。 */
	heartbeat(): boolean {
		if (this.#phase.name !== "preparing") return false;
		this.#phase = { name: "ready" };
		return true;
	}

	/** 推送一条消息；连接已关闭时返回 false。 */
	send(message: ServerMessage): boolean {
		return this.outbox.push(message);
	}

	/** 结束出站流（控制面主动关闭连接）。 */
	close(): void {
		this.outbox.end();
	}

	get closed(): boolean {
		return this.outbox.ended;
	}
}

/** 还没上报过更新状态时的取值。 */
const NO_UPDATE: AgentUpdateInfo = { state: "none", remaining_tasks: 0, reason: "" };

export interface AgentView {
	name: string;
	status: AgentStatus;
	/** 注册信息（安装状态、开发版本、更新状态、能力与地址另有字段）。 */
	info: Omit<
		AgentInfo,
		"install" | "dev_packages" | "update" | "capabilities" | "peer" | "source_address"
	> & {
		installed_packages: InstalledPackage[];
	};
	last_seen_at: string;
	/** 在线 Agent 正在准备环境时，这次连接发出 Welcome 的控制面时间；已准备好或离线时为 null。 */
	preparing_since: string | null;
	/** 最近一次测得的时钟偏差；未知（旧版本 Agent）时为 null。 */
	clock_offset: ClockOffsetView | null;
	/** Agent 共享 venv 中已安装的节点包（Agent 在 Hello 中上报）。 */
	installed_packages: { name: string; version: string }[];
	/** 最近一次上报的节点包安装状态；本次连接还没有安装过时为 null。 */
	install: InstallProgress | null;
	/** 以开发模式（sfly dev）加载在这个 Agent 上的节点包；画布据此提供 dev 版本。 */
	dev_packages: DevPackageInfo[];
	/** 派发给这个 Agent、还没结束的任务（派发阶段和执行阶段），按派发顺序排列。 */
	running_tasks: RunningTaskView[];
	/** Agent 版本与控制面版本不一致（ADR 0014）：不给它派新任务。 */
	version_mismatch: boolean;
	/** 最近一次 Heartbeat 上报的更新状态。 */
	update: AgentUpdateInfo;
	/** 支持的 Agent 能力及版本（ADR 0019）。 */
	capabilities: CapabilityInfo[];
	/** 其它 Agent 连接这台 Agent 用的地址（ADR 0019）。 */
	endpoint: AgentEndpointView;
}

export interface RunningTaskView {
	task_id: string;
	run_id: string;
	orchestration_id: string;
	node_id: string;
	attempt: number;
	/** dispatched：下载、安装、启动中；running：执行器已启动。 */
	status: "dispatched" | "running";
	/** 执行器启动的时间；派发阶段为 null。 */
	started_at: string | null;
}

/**
 * Agent 注册表：按名称维护当前连接（同名重新连接时替换旧连接），
 * 并把注册信息、在线状态写入 agents 表。
 */
export class AgentHub {
	#connections = new Map<string, AgentConnection>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			mutex: Mutex;
			/** 控制面版本，即 Agent 的目标版本（ADR 0014）。 */
			version: string;
		},
	) {}

	/** 控制面版本，即 Agent 的目标版本。 */
	get version(): string {
		return this.deps.version;
	}

	/**
	 * Agent 版本与控制面不一致（高于或低于都算，ADR 0014）：照常接受连接、续约和结果，但不派新任务。
	 * 调度判断「能不能派给它」只看这里。
	 */
	versionMismatch(info: Pick<AgentInfo, "agent_version">): boolean {
		return info.agent_version !== this.deps.version;
	}

	/** 当前在线（已推送 Welcome，含准备环境中）的连接。 */
	connection(name: string): AgentConnection | undefined {
		const conn = this.#connections.get(name);
		return conn && !conn.closed && conn.welcomed ? conn : undefined;
	}

	/** 在线 Agent 开始准备环境的控制面时间（这次连接推送 Welcome 的时刻）；已准备好或离线时为 undefined。 */
	preparingSince(name: string): Date | undefined {
		return this.connection(name)?.preparingSince;
	}

	/** 现在的控制面时间：网关在收到消息时取它，作为这条消息的收到时刻。 */
	now(): Date {
		return this.deps.clock.now();
	}

	/**
	 * 注册一个新连接：替换同名旧连接，记录为在线。`helloClock` 是 Hello 里的时钟读数（旧版本 Agent 没有），
	 * `receivedAt` 是收到 Hello 的控制面时间：据此建立这次连接的折算关系并测一次时钟偏差；
	 * 没有读数时时钟偏差记为未知。
	 */
	attach(
		name: string,
		info: AgentInfo,
		outbox: AsyncQueue<ServerMessage>,
		helloClock?: AgentClockReading,
		receivedAt: Date = this.deps.clock.now(),
	): Promise<AgentConnection> {
		return this.deps.mutex.run(async () => {
			const clock = new ConnectionClock(this.deps.clock, helloClock, receivedAt);
			const conn = new AgentConnection(name, info, outbox, clock);
			const old = this.#connections.get(name);
			this.#connections.set(name, conn);
			old?.close();
			const now = this.deps.clock.now();
			const offset = helloClock && measureClockOffset(helloClock, receivedAt);
			const clockOffset = {
				clockOffsetMs: offset?.offsetMs ?? null,
				clockOffsetMeasuredAt: offset?.measuredAt ?? null,
			};
			await this.deps.db
				.insert(agents)
				.values({
					name,
					info,
					status: "online",
					registeredAt: now,
					lastSeenAt: now,
					...clockOffset,
				})
				.onConflictDoUpdate({
					target: agents.name,
					set: { info, status: "online", lastSeenAt: now, ...clockOffset },
				});
			return conn;
		});
	}

	/**
	 * Heartbeat 带来的时钟读数：更新保存的时钟偏差（偏差值和测量时刻）。这次连接的折算关系不变。
	 * 旧连接的上报忽略。
	 */
	recordClock(conn: AgentConnection, reading: AgentClockReading, receivedAt: Date): Promise<void> {
		return this.deps.mutex.run(async () => {
			if (this.#connections.get(conn.name) !== conn) return;
			const offset = measureClockOffset(reading, receivedAt);
			await this.deps.db
				.update(agents)
				.set({ clockOffsetMs: offset.offsetMs, clockOffsetMeasuredAt: offset.measuredAt })
				.where(eq(agents.name, conn.name));
		});
	}

	/** Agent 上报安装状态（InstallStatus）：更新安装进度和已安装的节点包列表。旧连接的上报忽略。 */
	recordInstall(
		conn: AgentConnection,
		install: InstallProgress,
		installed: InstalledPackage[],
		devPackages: DevPackageInfo[],
	): Promise<void> {
		return this.deps.mutex.run(async () => {
			if (this.#connections.get(conn.name) !== conn) return;
			conn.info = {
				...conn.info,
				installed_packages: installed,
				install,
				dev_packages: devPackages,
			};
			await this.deps.db
				.update(agents)
				.set({ info: conn.info, lastSeenAt: this.deps.clock.now() })
				.where(eq(agents.name, conn.name));
		});
	}

	/** Agent 在 Heartbeat 中上报更新状态（ADR 0014）：只在变化时写库。旧连接的上报忽略。 */
	recordUpdate(conn: AgentConnection, update: AgentUpdateInfo): Promise<void> {
		return this.deps.mutex.run(async () => {
			if (this.#connections.get(conn.name) !== conn) return;
			const old = conn.info.update ?? NO_UPDATE;
			if (
				old.state === update.state &&
				old.remaining_tasks === update.remaining_tasks &&
				old.reason === update.reason
			)
				return;
			conn.info = { ...conn.info, update };
			await this.deps.db
				.update(agents)
				.set({ info: conn.info, lastSeenAt: this.deps.clock.now() })
				.where(eq(agents.name, conn.name));
		});
	}

	/** 连接结束：如果它仍是该名称的当前连接，记录为离线。 */
	detach(conn: AgentConnection): Promise<void> {
		return this.deps.mutex.run(async () => {
			conn.close();
			if (this.#connections.get(conn.name) !== conn) return;
			this.#connections.delete(conn.name);
			await this.deps.db
				.update(agents)
				.set({ status: "offline", lastSeenAt: this.deps.clock.now() })
				.where(eq(agents.name, conn.name));
		});
	}

	async list(): Promise<AgentView[]> {
		const rows = await this.deps.db.select().from(agents).orderBy(asc(agents.name));
		const running = await this.deps.db
			.select({
				agent: tasks.agentName,
				taskId: tasks.id,
				runId: tasks.runId,
				orchestrationId: runs.orchestrationId,
				nodeId: tasks.nodeId,
				attempt: tasks.attempt,
				status: tasks.status,
				startedAt: tasks.startedAt,
			})
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.where(and(inArray(tasks.status, ON_AGENT), isNotNull(tasks.agentName)))
			.orderBy(asc(tasks.seq));
		return rows.map(
			({
				info: { install, dev_packages, update, capabilities, peer, source_address, ...info },
				...row
			}) => ({
				name: row.name,
				status: row.status,
				// 早于 #5 注册的记录没有 installed_packages。
				info: { ...info, installed_packages: info.installed_packages ?? [] },
				last_seen_at: row.lastSeenAt.toISOString(),
				preparing_since: this.preparingSince(row.name)?.toISOString() ?? null,
				clock_offset: clockOffsetView(row.clockOffsetMs, row.clockOffsetMeasuredAt),
				installed_packages: info.installed_packages ?? [],
				install: install ?? null,
				dev_packages: (dev_packages ?? []).map((p) => ({
					...p,
					metadata: devMetadataWithDefaultCharts(p.metadata),
				})),
				running_tasks: running
					.filter((t) => t.agent === row.name)
					.map((t) => ({
						task_id: t.taskId,
						run_id: t.runId,
						orchestration_id: t.orchestrationId,
						node_id: t.nodeId,
						attempt: t.attempt,
						status: t.status as RunningTaskView["status"],
						started_at: t.startedAt?.toISOString() ?? null,
					})),
				version_mismatch: this.versionMismatch(info),
				update: update ?? NO_UPDATE,
				capabilities: capabilities ?? [],
				endpoint: agentEndpoint({ peer, source_address }),
			}),
		);
	}

	/** 控制面启动时：库里残留的在线状态来自上一个进程，一律改为离线，等 Agent 重新连接。 */
	async markAllOffline(): Promise<void> {
		await this.deps.db.update(agents).set({ status: "offline" }).where(eq(agents.status, "online"));
	}

	/** 控制面关闭时结束所有连接。 */
	closeAll(): void {
		for (const conn of this.#connections.values()) conn.close();
		this.#connections.clear();
	}
}
