/**
 * 读取器测试用的假口（task-log-reader、run-log-reader、task-action-reader 的假日志都用它们搭）：
 * 「读一页」记下请求，回答可以扣住、可以让下一次失败；「订阅实时」记下连接，可以往还连着的连接推东西。
 */

/** 让出一次事件循环：已经排队的 Promise 回调都跑完（纯 Promise 的链路，不涉及真实的等待）。 */
export const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class FakePages<P, R> {
	/** 收到的请求，按先后。 */
	readonly reads: P[] = [];
	/** 为 true 时，之后的回答先扣住，`release()` 才送出：用来在结果回来之前换读取器、推新的行。 */
	hold = false;
	private readonly pending: (() => void)[] = [];
	private readonly scripted: R[] = [];
	private failure: Error | null = null;

	/** `answerFor` 在收到请求的那一刻算出回答（就像控制面在那一刻读日志文件）。 */
	constructor(private readonly answerFor: (position: P) => R) {}

	read = (position: P): Promise<R> => {
		this.reads.push(position);
		const failure = this.failure;
		this.failure = null;
		const page = failure ? undefined : (this.scripted.shift() ?? this.answerFor(position));
		const answer = () => (failure ? Promise.reject<R>(failure) : Promise.resolve(page as R));
		if (!this.hold) return answer();
		return new Promise<R>((resolve, reject) => {
			this.pending.push(() => answer().then(resolve, reject));
		});
	};

	/** 下一次读取原样回答这一页，不按 `answerFor` 算：构造读取器要应付的、控制面按规则不会给出的页。 */
	replyNext(page: R) {
		this.scripted.push(page);
	}

	/** 下一次读取失败。 */
	failNext(message: string) {
		this.failure = new Error(message);
	}

	/** 送出扣住的回答（之后不再扣），并等回调都跑完。 */
	async release() {
		this.hold = false;
		for (const answer of this.pending.splice(0)) answer();
		await settled();
	}
}

export interface Connection<A, H> {
	/** 连上时给的接续位置。 */
	readonly after: A;
	readonly handlers: H;
	/** 还没断开。 */
	open: boolean;
}

export class FakeLive<A, H> {
	readonly connections: Connection<A, H>[] = [];

	/** 订阅：记下这条连接，返回断开函数。 */
	connect = (after: A, handlers: H): (() => void) => {
		const connection = { after, handlers, open: true };
		this.connections.push(connection);
		return () => {
			connection.open = false;
		};
	};

	/** 往所有还连着的连接推一次。 */
	push(deliver: (handlers: H) => void) {
		for (const connection of this.connections) if (connection.open) deliver(connection.handlers);
	}
}
