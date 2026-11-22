// 登录限速（ADR 0029「认证的几处细节」）：按「用户 + 来源地址」限速，连续失败有退避；
// 同一个地址上失败得太多（不管试的是哪些用户名）整个地址也限速，不然一个地址对每个用户各试几次密码、永远碰不到按用户的限制。
// 只记在内存里（控制面是单进程）：重启清零，不是账号锁定，被限速的只是这个来源要等一会儿。
import type { Clock } from "../clock.js";
import { throttleAddress } from "./source-address.js";

export interface LoginThrottleOptions {
	/** 一个（用户、地址）组合前几次失败不限制，默认 5。 */
	freeAttempts?: number;
	/** 超过之后第一次失败要等的毫秒数，之后每多一次翻倍，默认 2 秒。 */
	baseDelayMs?: number;
	/** 要等的时间的上限，默认 15 分钟。 */
	maxDelayMs?: number;
	/** 多久没有失败就忘掉，默认 1 小时。 */
	resetAfterMs?: number;
	/** 一个地址上（不管用户名）前几次失败不限制，默认 30。 */
	addressFreeAttempts?: number;
	/** 最多记多少个（用户、地址）和地址，默认 10000；超出时先丢过期的，再丢最早的。 */
	maxEntries?: number;
}

interface Entry {
	failures: number;
	lastFailureAt: number;
}

export class LoginThrottle {
	readonly #entries = new Map<string, Entry>();
	readonly #options: Required<LoginThrottleOptions>;

	constructor(
		private readonly clock: Clock,
		options: LoginThrottleOptions = {},
	) {
		this.#options = {
			freeAttempts: options.freeAttempts ?? 5,
			baseDelayMs: options.baseDelayMs ?? 2000,
			maxDelayMs: options.maxDelayMs ?? 15 * 60_000,
			resetAfterMs: options.resetAfterMs ?? 3_600_000,
			addressFreeAttempts: options.addressFreeAttempts ?? 30,
			maxEntries: options.maxEntries ?? 10_000,
		};
	}

	/** 记着多少项（测试用）。 */
	get size(): number {
		return this.#entries.size;
	}

	/** 这个用户从这个地址再试，还要等多少毫秒；0 表示可以试。查询本身没有副作用。 */
	retryAfterMs(user: string, address: string): number {
		const now = this.clock.now().getTime();
		return Math.max(
			this.#wait(this.#userKey(user, address), this.#options.freeAttempts, now),
			this.#wait(this.#addressKey(address), this.#options.addressFreeAttempts, now),
		);
	}

	/** 记一次失败（用户不存在、密码不对、账号停用都算）。 */
	failure(user: string, address: string): void {
		const now = this.clock.now().getTime();
		this.#bump(this.#userKey(user, address), now);
		this.#bump(this.#addressKey(address), now);
	}

	/** 登录成功：这个（用户、地址）清零；地址整体的计数不清（别人的失败不该因为你登录成功而消失）。 */
	success(user: string, address: string): void {
		this.#entries.delete(this.#userKey(user, address));
	}

	/**
	 * 开始一次验证之前先占位（检查和占位在同一步里做完，中间没有 await）：还在限速就返回要等多久，不占位，调用方不要去验证；
	 * 否则把这次尝试当作一次失败记下，再去验证。验证是异步的，一次要算几百毫秒：失败等算完才记的话，并发的几十次请求
	 * 都在「还没有一次失败」的时候通过了检查，限速形同虚设（审查实测：同一个登录名并发 40 次错密码，40 次都放行）。
	 * 占了位的尝试之后三种结果：密码不对——什么也不用做，占位就是这次失败；对——{@link confirm}，清零；
	 * 没有真的去验证（算不过来被拒绝了）——{@link cancel}，把占位还回去。
	 */
	acquire(user: string, address: string): { ok: true } | { ok: false; retryAfterMs: number } {
		const wait = this.retryAfterMs(user, address);
		if (wait > 0) return { ok: false, retryAfterMs: wait };
		this.failure(user, address);
		return { ok: true };
	}

	/** 占了位的尝试验证通过：这个（用户、地址）清零，地址整体的计数还回这次占的一份（它不是失败）。 */
	confirm(user: string, address: string): void {
		this.success(user, address);
		this.#release(this.#addressKey(address));
	}

	/** 占了位的尝试没有去验证（没算哈希就被拒绝了）：不算失败，两处占的位都还回去。 */
	cancel(user: string, address: string): void {
		this.#release(this.#userKey(user, address));
		this.#release(this.#addressKey(address));
	}

	/** 还回一份占位：次数减一，没有了就忘掉；最后一次失败的时间不变。 */
	#release(key: string): void {
		const entry = this.#entries.get(key);
		if (entry === undefined) return;
		if (entry.failures <= 1) this.#entries.delete(key);
		else this.#entries.set(key, { ...entry, failures: entry.failures - 1 });
	}

	// 键里的来源地址是归一后的（./source-address.ts）：去掉端口，IPv6 按 /64 归在一起。
	#userKey(user: string, address: string): string {
		return `u|${throttleAddress(address)}|${user.toLowerCase()}`;
	}

	#addressKey(address: string): string {
		return `a|${throttleAddress(address)}`;
	}

	#wait(key: string, free: number, now: number): number {
		const entry = this.#entries.get(key);
		if (entry === undefined) return 0;
		if (now - entry.lastFailureAt > this.#options.resetAfterMs) {
			this.#entries.delete(key);
			return 0;
		}
		const over = entry.failures - free;
		if (over <= 0) return 0;
		const delay = Math.min(this.#options.baseDelayMs * 2 ** (over - 1), this.#options.maxDelayMs);
		return Math.max(0, entry.lastFailureAt + delay - now);
	}

	#bump(key: string, now: number): void {
		const entry = this.#entries.get(key);
		const expired = entry !== undefined && now - entry.lastFailureAt > this.#options.resetAfterMs;
		const failures = entry === undefined || expired ? 1 : entry.failures + 1;
		// 先删再放：Map 按插入顺序，最早失败的排在最前面，满了丢它。
		this.#entries.delete(key);
		this.#entries.set(key, { failures, lastFailureAt: now });
		this.#trim(now);
	}

	#trim(now: number): void {
		const { maxEntries, resetAfterMs } = this.#options;
		if (this.#entries.size <= maxEntries) return;
		for (const [key, entry] of this.#entries) {
			if (now - entry.lastFailureAt > resetAfterMs) this.#entries.delete(key);
		}
		for (const key of this.#entries.keys()) {
			if (this.#entries.size <= maxEntries) break;
			this.#entries.delete(key);
		}
	}
}
