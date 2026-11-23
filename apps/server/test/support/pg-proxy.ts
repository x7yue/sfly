import { createServer, type Server, Socket } from "node:net";

/** 在哪个位置、怎样让连接断开。 */
export type SabotageAction =
	/** 匹配的那条语句不转发给数据库，直接断开这条连接（语句没有执行；在事务里的话数据库回滚）。 */
	| "drop"
	/** 匹配之后标记这条连接，它的下一条 COMMIT 不转发，直接断开（提交时断开，数据库回滚）。 */
	| "commit-before"
	/**
	 * 匹配之后标记这条连接，它的下一条 COMMIT 照常转发、数据库提交了，但回给客户端的结果丢掉、断开
	 * （提交成功了，客户端只看到连接断了：结局不明）。
	 */
	| "commit-after";

interface Arm {
	match: RegExp;
	action: SabotageAction;
	label: string;
}

/** 触发过的一次破坏：匹配的语句（前 160 个字符）和动作。 */
export interface Fired {
	label: string;
	action: SabotageAction;
	stage: "match" | "commit";
	sql: string;
}

/**
 * PostgreSQL 前面的一个 TCP 转发：控制面连它，它转给真正的数据库。两种用法：
 * - `outage()` 把现有的连接全部掐断并且不再接受新连接（连接被拒绝，和数据库重启时一样），`recover()` 在同一个端口上重新
 *   接受连接。模拟「数据库整体不可用一小段时间再恢复」，不用去重启容器里的数据库。
 * - `arm(语句的正则, 动作)`：解析客户端发往数据库的消息（简单查询 `Q`、扩展协议的 `Parse` `P`），客户端**发出**匹配的
 *   那条语句的那一刻按动作断开**这一条**连接（{@link SabotageAction}）。比从数据库一侧 `pg_terminate_backend` 准：能断在
 *   `BEGIN` 上、断在 COMMIT 上、断在 COMMIT 之后；每次都是同一个位置。一次性：触发一次就解除。
 */
export class PgProxy {
	readonly #sockets = new Set<Socket>();
	#server: Server | undefined;
	#port = 0;
	#arms: Arm[] = [];
	readonly fired: Fired[] = [];

	private constructor(private readonly target: { host: string; port: number }) {}

	static async start(targetUrl: string): Promise<PgProxy> {
		const target = new URL(targetUrl);
		const proxy = new PgProxy({ host: target.hostname, port: Number(target.port) });
		await proxy.#listen(0);
		return proxy;
	}

	/** 把 `url`（连到真正的数据库）换成连到这个转发的地址。 */
	urlFor(url: string): string {
		const rewritten = new URL(url);
		rewritten.hostname = "127.0.0.1";
		rewritten.port = String(this.#port);
		return rewritten.toString();
	}

	/** 一次性：客户端下一次发出匹配 `match` 的语句时，按 `action` 断开这条连接。 */
	arm(match: RegExp, action: SabotageAction, label: string = match.source): void {
		this.#arms.push({ match, action, label });
	}

	/** 还有几个没触发的。 */
	get armed(): number {
		return this.#arms.length;
	}

	#listen(port: number): Promise<void> {
		const server = createServer((client) => {
			const upstream = new Socket();
			this.#sockets.add(client);
			this.#sockets.add(upstream);
			upstream.connect(this.target.port, this.target.host);
			let buffer = Buffer.alloc(0);
			let started = false;
			let marked: Arm | undefined;
			let dropServerReplies = false;
			let dead = false;
			const kill = () => {
				dead = true;
				client.destroy();
				upstream.destroy();
			};
			upstream.on("data", (data: Buffer) => {
				if (dead) return;
				if (dropServerReplies) {
					kill();
					return;
				}
				client.write(data);
			});
			client.on("data", (data: Buffer) => {
				if (dead) return;
				buffer = Buffer.concat([buffer, data]);
				for (;;) {
					if (!started) {
						// 启动消息（没有类型字节）：4 字节长度开头；SSL 请求也是。
						if (buffer.length < 4) return;
						const length = buffer.readInt32BE(0);
						if (buffer.length < length) return;
						const frame = buffer.subarray(0, length);
						buffer = buffer.subarray(length);
						const sslRequest = length === 8 && frame.readInt32BE(4) === 80877103;
						if (!sslRequest) started = true;
						upstream.write(frame);
						continue;
					}
					if (buffer.length < 5) return;
					const length = buffer.readInt32BE(1);
					if (buffer.length < 1 + length) return;
					const frame = buffer.subarray(0, 1 + length);
					buffer = buffer.subarray(1 + length);
					const type = String.fromCharCode(frame[0] ?? 0);
					let sql: string | undefined;
					if (type === "Q") sql = frame.subarray(5, frame.length - 1).toString("utf8");
					else if (type === "P") {
						const body = frame.subarray(5);
						const nameEnd = body.indexOf(0);
						const queryEnd = body.indexOf(0, nameEnd + 1);
						sql = body.subarray(nameEnd + 1, queryEnd).toString("utf8");
					}
					if (sql !== undefined) {
						if (marked && /^\s*commit\b/i.test(sql)) {
							const arm = marked;
							marked = undefined;
							this.fired.push({ label: arm.label, action: arm.action, stage: "commit", sql });
							if (arm.action === "commit-before") {
								kill();
								return;
							}
							dropServerReplies = true;
							upstream.write(frame);
							continue;
						}
						if (marked && /^\s*rollback\b/i.test(sql)) marked = undefined;
						const text = sql;
						const index = this.#arms.findIndex((a) => a.match.test(text));
						const arm = index >= 0 ? this.#arms.splice(index, 1)[0] : undefined;
						if (arm) {
							this.fired.push({
								label: arm.label,
								action: arm.action,
								stage: "match",
								sql: text.slice(0, 160),
							});
							if (arm.action === "drop") {
								kill();
								return;
							}
							marked = arm;
						}
					}
					upstream.write(frame);
				}
			});
			for (const socket of [client, upstream]) {
				socket.on("error", () => socket.destroy());
				socket.on("close", () => {
					this.#sockets.delete(socket);
					(socket === client ? upstream : client).destroy();
				});
			}
		});
		this.#server = server;
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				this.#port = (server.address() as { port: number }).port;
				resolve();
			});
		});
	}

	/** 数据库不可用：掐断所有连接，不再接受新的。 */
	async outage(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** 数据库恢复：在原来的端口上重新接受连接。 */
	recover(): Promise<void> {
		return this.#listen(this.#port);
	}

	close(): Promise<void> {
		return this.outage();
	}
}
