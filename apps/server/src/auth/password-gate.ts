// 密码验证和哈希的并发闸（ADR 0029「认证的几处细节」）：scrypt 走 libuv 的线程池（默认 4 个线程），一次约 0.2 秒、占约 64 MiB。
// 同一个线程池还做文件读写：任务日志的追加写、产物、节点包下载。没有上限时，一阵并发的登录（不用登录就能发）会把线程池占满，
// 文件读写排在它们后面，控制面读写文件慢上几秒到十几秒，内存也跟着涨。
//
// 所以同时算的密码最多 {@link PasswordGateOptions.concurrency} 个（默认 2，给文件读写留下线程），再多的排队，
// 队列也有上限（{@link PasswordGateOptions.maxQueue}）：满了就直接拒绝（{@link PasswordGateBusy}），连哈希都不算。
// 登录、初始化第一个管理员、改密码（验证旧密码和算新密码）、管理员建用户和重置密码都走同一个闸。
//
// 客户端断开之后，它排着的请求不该继续占着队列：调用方把请求的中止信号传进来，断开时这个请求马上退出队列（让出位置，
// 后来的不会因为队列被断开的请求占满而被拒绝），哈希和验证一次都不算。不然发了请求马上断开，几乎没有成本就能让闸一直满着。
// 已经在算的那一个不打断：scrypt 在线程池里算，算到一半没法收回，让它算完。
// 限速（./login-throttle.ts）管的是「同一个人试太多次」，这里管的是「同时在算的太多」：两个一起，登录风暴既不会被放过也不会拖慢别的。

export interface PasswordGateOptions {
	/** 同时最多算几个，默认 2。 */
	concurrency?: number;
	/** 最多排几个等着算的，默认 16；满了再来的直接拒绝。 */
	maxQueue?: number;
	/** 拒绝时建议对方多久之后再试（毫秒），默认 2 秒。 */
	retryAfterMs?: number;
}

/** 在算的和排队的都满了：这一次没有去算，不算失败的尝试（不记限速）。 */
export class PasswordGateBusy extends Error {
	constructor(readonly retryAfterMs: number) {
		super("同时验证密码的请求太多，请稍后再试");
	}
}

/** 客户端已经断开（中止信号）：这一次没有去算，响应也没人收；调用方把占的限速名额还回去。 */
export class PasswordGateAborted extends Error {
	constructor() {
		super("客户端已经断开，没有验证密码");
	}
}

/** 排队的一项：轮到它时 `grant`。 */
interface Waiter {
	grant(): void;
}

export class PasswordGate {
	readonly #concurrency: number;
	readonly #maxQueue: number;
	readonly #retryAfterMs: number;
	readonly #queue: Waiter[] = [];
	#active = 0;

	constructor(options: PasswordGateOptions = {}) {
		this.#concurrency = Math.max(1, options.concurrency ?? 2);
		this.#maxQueue = Math.max(0, options.maxQueue ?? 16);
		this.#retryAfterMs = options.retryAfterMs ?? 2000;
	}

	/** 正在算的个数（测试用）。 */
	get active(): number {
		return this.#active;
	}

	/** 排队等着的个数（测试用）。 */
	get waiting(): number {
		return this.#queue.length;
	}

	/**
	 * 轮到它时运行 `task`（哈希或验证），先到先得；在算的和排队的都满了就抛 {@link PasswordGateBusy}，不运行。
	 * `task` 抛错也释放名额。`signal` 是请求的中止信号（客户端断开）：进来时已经中止，或者排队时中止，
	 * 抛 {@link PasswordGateAborted}、不运行，排队的立刻让出队列里的位置；已经开始运行的不受影响。
	 */
	async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) throw new PasswordGateAborted();
		if (this.#active >= this.#concurrency) {
			if (this.#queue.length >= this.#maxQueue) throw new PasswordGateBusy(this.#retryAfterMs);
			// 轮到我的时候，释放的那一个把名额直接交给我（#active 不减不加）。
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					const index = this.#queue.indexOf(waiter);
					if (index !== -1) this.#queue.splice(index, 1);
					reject(new PasswordGateAborted());
				};
				const waiter: Waiter = {
					grant: () => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					},
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				this.#queue.push(waiter);
			});
		} else {
			this.#active += 1;
		}
		try {
			return await task();
		} finally {
			const next = this.#queue.shift();
			if (next) next.grant();
			else this.#active -= 1;
		}
	}
}
