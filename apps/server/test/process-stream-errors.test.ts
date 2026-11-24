// 控制面作为真实的进程（`src/main.ts`，和 `pnpm start` 一样）：一次普通的读请求不能让它退出，重复的停止信号不能让它退出码变成 1。
// 1. 下载日志时日志文件读不了（权限、被清理到一半）：源文件流的错误没有人接，控制面以退出码 1 退出（#647）。
//    这里用「日志文件被换成了同名的目录」造读不了的文件：`stat` 能过、打开能过、读时 EISDIR，和权限、清理到一半一样，
//    是读的时候才出错，而且不依赖测试是不是以 root 运行。
// 2. 收到停止信号时关闭被调用两次，第二次的拒绝没有人接；重复的信号只记一句，关闭只做一次。
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logsApi } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { type SourceServer, startSourceServer } from "./support/source-server.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

describe("真实的控制面进程", () => {
	let database: TestDatabase | undefined;
	let dataDir: string | undefined;
	let server: SourceServer | undefined;
	let agent: FakeAgent | undefined;

	afterEach(async () => {
		await agent?.disconnect();
		await server?.stop();
		await database?.drop();
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
		database = dataDir = server = agent = undefined;
	});

	const start = async () => {
		database = await createTestDatabase();
		dataDir = await mkdtemp(join(tmpdir(), "sfly-proc-"));
		server = await startSourceServer({ databaseUrl: database.url, dataDir });
		return server;
	};

	/** 进程的输出，失败时附在断言信息里。 */
	const outputOf = (s: SourceServer) => `进程的输出：\n${s.output.join("\n")}`;

	it("下载日志时日志文件读不了：这一次请求以错误结束，控制面进程不退出，之后的请求照常", async () => {
		const cp = await start();
		const api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		agent.logs(task, [
			[1, "第一行"],
			[2, "第二行"],
		]);
		await eventually(async () => {
			const page = await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1000`)).json();
			expect(logsApi.page.response.parse(page).last_seq).toBe(2);
		});
		// 日志正常时能下载。
		const ok = await cp.fetch(`/tasks/${task.taskId}/logs/download`);
		expect(ok.status).toBe(200);
		expect((await ok.text()).split("\n").filter(Boolean)).toHaveLength(2);

		// 日志文件被换成了同名的目录：读的时候出错。
		const file = join(dataDir as string, "logs", runId, `${task.taskId}.jsonl`);
		await rm(file);
		await mkdir(file);

		const res = await cp
			.fetch(`/tasks/${task.taskId}/logs/download`)
			.catch((error: unknown) => error as Error);
		// 进程还活着（先看这一条：退出时下面的断言信息里有退出码和进程的输出）。
		expect(
			cp.exit,
			`控制面进程在一次下载之后退出了：${JSON.stringify(cp.exit)}\n${outputOf(cp)}`,
		).toBe(undefined);
		// 这一次请求以明确的错误结束：响应还没开始发送，是 500 internal_error，不是断开的连接。
		expect(res).toBeInstanceOf(Response);
		expect((res as Response).status).toBe(500);
		expect(await (res as Response).json()).toMatchObject({ error: { code: "internal_error" } });
		// 错误记在了控制面的日志里（读不了的是哪个文件）。
		expect(cp.output.join("\n")).toContain("EISDIR");
		// 别的请求不受影响。
		const health = await cp.fetch("/health");
		expect(health.status).toBe(200);
		expect((await cp.fetch("/orchestrations")).status).toBe(200);
		// 再下载一次：同样是一次失败的请求，进程还在。
		expect((await cp.fetch(`/tasks/${task.taskId}/logs/download`)).status).toBe(500);
		expect(cp.exit).toBeUndefined();
	}, 120_000);

	it("按运行下载日志时日志文件读不了：同样是这一次请求的错误，进程不退出", async () => {
		const cp = await start();
		const api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		agent.logs(task, [[1, "第一行"]]);
		await eventually(async () => {
			const page = await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1000`)).json();
			expect(logsApi.page.response.parse(page).last_seq).toBe(1);
		});
		const file = join(dataDir as string, "logs", runId, `${task.taskId}.jsonl`);
		await rm(file);
		await mkdir(file);
		const res = await cp
			.fetch(`/runs/${runId}/logs/download`)
			.catch((error: unknown) => error as Error);
		expect(
			cp.exit,
			`控制面进程在一次下载之后退出了：${JSON.stringify(cp.exit)}\n${outputOf(cp)}`,
		).toBe(undefined);
		// 读文件出错发生在响应开始发送之前（读第一批时）：500；已经开始发送的，连接被断开、日志里有一条。
		if (res instanceof Response) expect(res.status).toBe(500);
		expect((await cp.fetch("/health")).status).toBe(200);
	}, 120_000);

	it("收到几个停止信号（SIGINT、SIGTERM、SIGTERM）：只关闭一次，退出码是 0，没有未处理的拒绝", async () => {
		const cp = await start();
		for (const signal of ["SIGINT", "SIGTERM", "SIGTERM"] as const) cp.child.kill(signal);
		const exit = await cp.exited();
		const output = outputOf(cp);
		expect(exit, output).toEqual({ code: 0, signal: null });
		// 只有一句「正在关闭」（关闭只做一次）；后到的信号如果进程还没退出，各记一句「已经在关闭」（逻辑在 `shutdown.test.ts`，
		// 这里的先后取决于进程多快退出，只看有没有多余的关闭）。
		expect(
			cp.output.filter((line) => line.includes("正在关闭")),
			output,
		).toHaveLength(1);
		// 没有未处理的拒绝、没有关两次的错误。
		expect(output).not.toMatch(/unhandled|未处理|ERR_|Called end|Error:/i);
	}, 120_000);

	it("关闭卡住（有一个请求一直没发完）：SIGTERM 之后再按两次 SIGINT 只各记一句，进程在关闭开始 10 秒之后记一句、以退出码 1 退出，不是一直不退出也不是 0", async () => {
		const cp = await start();
		// 一个一直没发完的请求：请求头发完、声明了 1000 字节的请求体、只发了一个字节。HTTP 服务器关闭时要等进行中的请求做完，关闭卡住。
		const url = new URL(cp.httpUrl);
		const socket = connect({ host: url.hostname, port: Number(url.port) });
		socket.on("error", () => {});
		await once(socket, "connect");
		socket.write(
			"POST /orchestrations HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{",
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		try {
			const startedAt = Date.now();
			cp.child.kill("SIGTERM");
			await new Promise((resolve) => setTimeout(resolve, 1000));
			cp.child.kill("SIGINT");
			cp.child.kill("SIGINT");
			// 关闭卡住：几秒之后进程还在。
			await new Promise((resolve) => setTimeout(resolve, 3000));
			expect(cp.exit, `关闭还没有到上限，进程不该退出：\n${outputOf(cp)}`).toBeUndefined();
			const exit = await cp.exited(20_000);
			const elapsed = Date.now() - startedAt;
			const output = outputOf(cp);
			expect(exit, output).toEqual({ code: 1, signal: null });
			// 从关闭开始算 10 秒（SHUTDOWN_TIMEOUT_MS）：不早于 9.5 秒，也没有拖得很久。
			expect(elapsed, output).toBeGreaterThanOrEqual(9_500);
			expect(elapsed, output).toBeLessThan(16_000);
			expect(
				cp.output.filter((line) => line.includes("正在关闭")),
				output,
			).toHaveLength(1);
			expect(
				cp.output.filter((line) => line.includes("已经在关闭，忽略 SIGINT")),
				output,
			).toHaveLength(2);
			expect(
				cp.output.filter((line) => line.includes("关闭 10 秒还没有完成")),
				output,
			).toHaveLength(1);
		} finally {
			socket.destroy();
		}
	}, 60_000);
});
