import type { ServerMessage } from "@sfly/proto";
import { asc, eq } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { type AgentInfo, type AgentStatus, agents } from "../db/schema.js";
import type { AsyncQueue } from "../util/async-queue.js";
import type { Mutex } from "../util/mutex.js";

/** 每个 Agent 默认的并发槽位数（docs/SEMANTICS.md 默认值）。 */
export const DEFAULT_SLOTS = 4;

/** 一个已完成握手的 Agent 连接。 */
export class AgentConnection {
	constructor(
		readonly name: string,
		readonly info: AgentInfo,
		readonly outbox: AsyncQueue<ServerMessage>,
	) {}

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
	info: AgentInfo;
	last_seen_at: string;
}

/**
 * Agent 注册表：按名称维护当前连接（同名重新连接时替换旧连接），
 * 并把注册信息、在线状态写入 agents 表。
 */
export class AgentHub {
	#connections = new Map<string, AgentConnection>();

	constructor(private readonly deps: { db: Db; clock: Clock; mutex: Mutex }) {}

	/** 当前在线的连接。 */
	connection(name: string): AgentConnection | undefined {
		const conn = this.#connections.get(name);
		return conn && !conn.closed ? conn : undefined;
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
		return rows.map((row) => ({
			name: row.name,
			status: row.status,
			info: row.info,
			last_seen_at: row.lastSeenAt.toISOString(),
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
