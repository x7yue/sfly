import { createConnection, createServer, type Socket } from "node:net";

export interface TcpProxy {
	url: string;
	/** 事件流（`/events`）连接里，已经收到控制面数据的连接累计数：命令行已经连上了事件流。 */
	readonly streamsOpened: number;
	/** 切断所有已经建立的连接（模拟网络中断）；新连接照常转发，除非正在 block()。 */
	dropConnections(): void;
	/** 之后的新连接一建立就被关闭（模拟控制面暂时连不上），直到 unblock()。 */
	block(): void;
	unblock(): void;
	close(): Promise<void>;
}

/**
 * 在 TCP 层转发到 target 的代理，支持流式响应（SSE），并能随时切断连接：
 * 测试里用来模拟命令行和控制面之间的网络中断。
 */
export async function startTcpProxy(target: string): Promise<TcpProxy> {
	const { hostname, port } = new URL(target);
	const sockets = new Set<Socket>();
	let blocked = false;
	let streamsOpened = 0;

	const server = createServer((client) => {
		if (blocked) {
			client.destroy();
			return;
		}
		const upstream = createConnection({ host: hostname, port: Number(port) });
		sockets.add(client).add(upstream);
		let isStream = false;
		let counted = false;
		const release = () => {
			client.destroy();
			upstream.destroy();
			sockets.delete(client);
			sockets.delete(upstream);
		};
		client.on("data", (chunk: Buffer) => {
			if (!isStream && /^GET \S+\/events[ ?]/.test(chunk.toString("latin1"))) isStream = true;
			upstream.write(chunk);
		});
		upstream.on("data", (chunk: Buffer) => {
			if (isStream && !counted) {
				counted = true;
				streamsOpened++;
			}
			client.write(chunk);
		});
		client.on("close", release).on("error", release);
		upstream.on("close", release).on("error", release);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("proxy has no address");

	return {
		url: `http://127.0.0.1:${address.port}`,
		get streamsOpened() {
			return streamsOpened;
		},
		dropConnections() {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
		},
		block() {
			blocked = true;
		},
		unblock() {
			blocked = false;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}
