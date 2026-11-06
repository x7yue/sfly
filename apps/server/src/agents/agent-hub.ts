import type { ServerMessage } from "@sfly/proto";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	type AgentInfo,
	type AgentStatus,
	agents,
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

/** 一个已完成握手的 Agent 连接。 */
export class AgentConnection {
	constructor(
		readonly name: string,
		public info: AgentInfo,
		readonly outbox: AsyncQueue<ServerMessage>,
	) {}

	/** 已推送 Welcome（#15：Welcome 带着对重连前任务的处置，之前不能向它派发或取消）。 */
	#welcomed = false;

	get welcomed(): boolean {
		return this.#welcomed;
	}

	/** 推送 Welcome，之后连接才可用于派发。 */
	welcome(message: ServerMessage): void {
		this.send(message);
		this.#welcomed = true;
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

export interface AgentView {
	name: string;
	status: AgentStatus;
	/** 注册信息（安装状态与开发版本另有字段）。 */
	info: Omit<AgentInfo, "install" | "dev_packages"> & { installed_packages: InstalledPackage[] };
	last_seen_at: string;
	/** Agent 共享 venv 中已安装的节点包（Agent 在 Hello 中上报）。 */
	installed_packages: { name: string; version: string }[];
	/** 最近一次上报的节点包安装状态；本次连接还没有安装过时为 null。 */
	install: InstallProgress | null;
	/** 以开发模式（sfly dev）加载在这个 Agent 上的节点包；画布据此提供 dev 版本。 */
	dev_packages: DevPackageInfo[];
	/** 派发给这个 Agent、还没结束的任务（派发阶段和执行阶段），按派发顺序排列。 */
	running_tasks: RunningTaskView[];
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

	constructor(private readonly deps: { db: Db; clock: Clock; mutex: Mutex }) {}

	/** 当前在线（已收到 Welcome）的连接。 */
	connection(name: string): AgentConnection | undefined {
		const conn = this.#connections.get(name);
		return conn && !conn.closed && conn.welcomed ? conn : undefined;
	}

	/** 注册一个新连接：替换同名旧连接，记录为在线。 */
	attach(
		name: string,
		info: AgentInfo,
		outbox: AsyncQueue<ServerMessage>,
	): Promise<AgentConnection> {
		return this.deps.mutex.run(async () => {
			const conn = new AgentConnection(name, info, outbox);
			const old = this.#connections.get(name);
			this.#connections.set(name, conn);
			old?.close();
			const now = this.deps.clock.now();
			await this.deps.db
				.insert(agents)
				.values({ name, info, status: "online", registeredAt: now, lastSeenAt: now })
				.onConflictDoUpdate({
					target: agents.name,
					set: { info, status: "online", lastSeenAt: now },
				});
			return conn;
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
		return rows.map(({ info: { install, dev_packages, ...info }, ...row }) => ({
			name: row.name,
			status: row.status,
			// 早于 #5 注册的记录没有 installed_packages。
			info: { ...info, installed_packages: info.installed_packages ?? [] },
			last_seen_at: row.lastSeenAt.toISOString(),
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
		}));
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
