import { createServer } from "node:net";

/** 一个此刻没有人监听的本机端口（连接会被拒绝）。不用 1 这样的小端口：fetch 把它们当成「不能访问的端口」，报 bad port，不去连。 */
export async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
