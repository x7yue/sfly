import { createServer, type Server, Socket } from "node:net";

/**
 * PostgreSQL 前面的一个 TCP 转发：控制面连它，它转给真正的数据库。`outage()` 把现有的连接全部掐断并且不再接受新连接
 * （连接被拒绝，和数据库重启时一样），`recover()` 在同一个端口上重新接受连接。测试用它模拟「数据库整体不可用一小段时间
 * 再恢复」，不用去重启容器里的数据库。
 */
export class PgProxy {
	readonly #sockets = new Set<Socket>();
	#server: Server | undefined;
	#port = 0;

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

	#listen(port: number): Promise<void> {
		const server = createServer((client) => {
			const upstream = new Socket();
			this.#sockets.add(client);
			this.#sockets.add(upstream);
			upstream.connect(this.target.port, this.target.host);
			client.pipe(upstream);
			upstream.pipe(client);
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
