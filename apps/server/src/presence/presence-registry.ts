import type { Clock } from "../clock.js";
import { Topics } from "../sse/topics.js";

/** 一个打开着编辑页面的浏览器标签页。 */
export interface Editor {
	/** 浏览器为每次打开编辑页面生成的随机 ID，用来区分同一昵称的多个标签页。 */
	session_id: string;
	nickname: string;
}

export interface EditorsChanged {
	orchestration_id: string;
	editors: Editor[];
}

interface Entry extends Editor {
	lastSeen: number;
}

/** 没有心跳多久后移除（docs/ARCHITECTURE.md §6：浏览器每 10 秒一次，30 秒无心跳移除）。 */
export const PRESENCE_TTL_MS = 30_000;

/**
 * 在线编辑者：只保存在内存中，不落库（控制面重启后由浏览器的下一次心跳恢复）。
 * 名单变化（有人加入、改昵称、超时移除）时按编排 ID 发布 `EditorsChanged`。
 * 已离开的会话在 TTL 内记住：关闭页面时还在路上的心跳可能晚于离开请求到达，忽略它，
 * 否则会话会在名单里多留 30 秒（浏览器从往返缓存恢复页面时换一个新会话 ID）。
 */
export class PresenceRegistry {
	readonly #clock: Clock;
	readonly #ttlMs: number;
	readonly #byOrchestration = new Map<string, Map<string, Entry>>();
	/** 已离开的会话 ID → 离开时间。 */
	readonly #left = new Map<string, number>();
	readonly #topics = new Topics<EditorsChanged>();

	constructor({ clock, ttlMs = PRESENCE_TTL_MS }: { clock: Clock; ttlMs?: number }) {
		this.#clock = clock;
		this.#ttlMs = ttlMs;
	}

	/** 记录一次心跳，返回当前在线编辑者。 */
	heartbeat(orchestrationId: string, sessionId: string, nickname: string): Editor[] {
		if (this.#left.has(sessionId)) return this.editors(orchestrationId);
		let sessions = this.#byOrchestration.get(orchestrationId);
		if (!sessions) {
			sessions = new Map();
			this.#byOrchestration.set(orchestrationId, sessions);
		}
		const existing = sessions.get(sessionId);
		const lastSeen = this.#clock.now().getTime();
		sessions.set(sessionId, { session_id: sessionId, nickname, lastSeen });
		if (existing?.nickname !== nickname) this.#changed(orchestrationId);
		return this.editors(orchestrationId);
	}

	editors(orchestrationId: string): Editor[] {
		return [...(this.#byOrchestration.get(orchestrationId)?.values() ?? [])].map(
			({ session_id, nickname }) => ({ session_id, nickname }),
		);
	}

	/** 标签页关闭时主动离开：立即移除；不在名单里时什么也不做。 */
	leave(orchestrationId: string, sessionId: string): void {
		this.#left.set(sessionId, this.#clock.now().getTime());
		const sessions = this.#byOrchestration.get(orchestrationId);
		if (!sessions?.delete(sessionId)) return;
		if (sessions.size === 0) this.#byOrchestration.delete(orchestrationId);
		this.#changed(orchestrationId);
	}

	/** 移除超时没有心跳的编辑者；由控制面的周期扫描调用。 */
	sweep(): void {
		const now = this.#clock.now().getTime();
		for (const [sessionId, at] of this.#left) {
			if (now - at >= this.#ttlMs) this.#left.delete(sessionId);
		}
		for (const [orchestrationId, sessions] of this.#byOrchestration) {
			let removed = false;
			for (const [sessionId, entry] of sessions) {
				if (now - entry.lastSeen >= this.#ttlMs) {
					sessions.delete(sessionId);
					removed = true;
				}
			}
			if (sessions.size === 0) this.#byOrchestration.delete(orchestrationId);
			if (removed) this.#changed(orchestrationId);
		}
	}

	subscribe(orchestrationId: string, listener: (event: EditorsChanged) => void): () => void {
		return this.#topics.subscribe(orchestrationId, listener);
	}

	#changed(orchestrationId: string): void {
		this.#topics.publish(orchestrationId, {
			orchestration_id: orchestrationId,
			editors: this.editors(orchestrationId),
		});
	}
}
