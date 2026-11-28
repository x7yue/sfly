// 下载带上可以核对的结尾信息（#721）：响应头 `x-sfly-log-expect: tasks=<m>; last_seq_sum=<S>`，命令行读完核对。
//
// 「读的过程中认出文件被截短、连接被断开」（#669）要靠传输层传到客户端：反向代理用 HTTP/1.0 连控制面时（不少版本的常见代理默认如此），
// 响应靠关连接结束，断开和正常结束分不出来，代理会把半截的响应当成完整的发给客户端。所以下载本身要不靠这一点也能核对：
// 响应开始之前就知道每个任务应当到的最后一个序号（`log_seq`），头里给的是合计：范围内有日志的任务数 `m`、各任务最后一个序号之和 `S`。
// - 大小固定（几十个字节），和任务个数无关：逐任务列「任务:序号」，几百个任务就几 KB，超过 nginx 默认的 proxy_buffer_size 会回 502。
// - 序号不是一行一个、连续的（Agent 断线排队时丢弃的行在文件里留序号缺口），所以不能合计行数；合计的是最后一个序号。
// - 每一行带自己的序号，下载只读到请求那一刻的快照：读到的每个任务的最大序号不会超过它的 `log_seq`，合计相等当且仅当每个任务的最后一行
//   都读到了。任务下载读到文件此刻的内容（可能还在追加），读到的只会不少于。
// 测试里用一个以 HTTP/1.0 连上游的代理（`net`，把读到连接关闭的内容当完整的响应转出去），命令行走真实的 `sfly` 进程。
import { appendFileSync, truncateSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "./support/temp-dir.js";

/** 按运行下载：第 `at` 次（从 1 数）打开这个文件之前做的事；用完（触发一次）就清掉。 */
const hooks = vi.hoisted(() => ({
	open: undefined as { path: string; count: number; at: number; act: () => void } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const open = (...args: Parameters<typeof actual.open>) => {
		const hook = hooks.open;
		if (hook && String(args[0]) === hook.path) {
			hook.count += 1;
			if (hook.count === hook.at) {
				hooks.open = undefined;
				hook.act();
			}
		}
		return actual.open(...args);
	};
	return { ...actual, default: { ...actual, open }, open };
});

const { LOG_EXPECT_HEADER } = await import("@sfly/schema");
const { ApiClient } = await import("./support/api-client.js");
const { FakeAgent } = await import("./support/fake-agent.js");
const { publishPackage } = await import("./support/package-archive.js");
const { writeRecordedLogs } = await import("./support/recorded-logs.js");
const { sfly } = await import("./support/sfly-cli.js");
const { startTestControlPlane } = await import("./support/test-control-plane.js");

const chain = (ids: string[]) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		...ids.map((id) => ({ id, kind: "package", package: "stub", node: "echo" })),
	],
	edges: ["entry", ...ids].slice(0, -1).map((from, i) => ({ from, to: ids[i], kind: "chain" })),
	packages: { stub: "1.0.0" },
});

/**
 * 一个以 HTTP/1.0 连上游的反向代理（nginx 1.29.7 之前 `proxy_http_version` 的默认值就是 1.0）：向上游发 HTTP/1.0 请求，
 * 读到连接关闭，把读到的当作完整的响应转给客户端（带 `content-length`）。上游中途断开时，半截的响应也这样转出去：客户端看不出来。
 * `strip` 里的响应头不转发（模拟没有这个头的旧控制面）。
 */
async function startHttp10Proxy(upstream: string, strip: string[] = []) {
	const target = new URL(upstream);
	const server = createServer((req, res) => {
		const socket = connect({ host: target.hostname, port: Number(target.port) });
		const forwarded = Object.entries(req.headers as IncomingHttpHeaders)
			.filter(([name]) => !["connection", "host", "keep-alive", "transfer-encoding"].includes(name))
			.map(([name, value]) => `${name}: ${String(value)}`);
		socket.write(
			`${req.method} ${req.url} HTTP/1.0\r\nhost: ${target.host}\r\n${forwarded.join("\r\n")}\r\n\r\n`,
		);
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("error", () => {});
		socket.on("close", () => {
			const raw = Buffer.concat(chunks);
			const split = raw.indexOf("\r\n\r\n");
			if (split < 0) {
				res.writeHead(502).end();
				return;
			}
			const [status, ...lines] = raw.subarray(0, split).toString("utf8").split("\r\n");
			const headers: Record<string, string> = {};
			for (const line of lines) {
				const colon = line.indexOf(":");
				const name = line.slice(0, colon).trim().toLowerCase();
				if (["connection", "content-length", "transfer-encoding", ...strip].includes(name))
					continue;
				headers[name] = line.slice(colon + 1).trim();
			}
			const body = raw.subarray(split + 4);
			headers["content-length"] = String(body.length);
			res.writeHead(Number(status?.split(" ")[1] ?? 502), headers).end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("下载带上可以核对的结尾信息，命令行读完核对（#721）", () => {
	let cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	let agent: Awaited<ReturnType<typeof FakeAgent.connect>>;
	let api: InstanceType<typeof ApiClient>;
	let dir: string;
	let one: string;
	let two: string;
	let many: string;
	const MANY = 25;

	beforeAll(async () => {
		dir = await makeTempDir("sfly-expect-");
		cp = await startTestControlPlane();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 64 });
		api = new ApiClient(cp);
		one = await api.orchestrationWith(chain(["a"]));
		two = await api.orchestrationWith(chain(["a", "b"]));
		many = await api.orchestrationWith(
			chain(Array.from({ length: MANY }, (_, i) => `n${String(i + 1).padStart(2, "0")}`)),
		);
	}, 60_000);
	afterAll(async () => {
		hooks.open = undefined;
		await agent?.disconnect();
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});
	afterEach(() => {
		hooks.open = undefined;
	});

	const fileOf = (runId: string, taskId: string) =>
		join(cp.dataDir, "logs", runId, `${taskId}.jsonl`);
	/** 写这些行（序号可以有缺口），等数据库记下字节数（#790：不能等分页里的 last_seq）。 */
	const write = (task: Parameters<typeof agent.logs>[0], seqs: number[]) =>
		writeRecordedLogs(cp, agent, task, seqs);
	const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
	/** 一个运行里的一个任务（一直不结束）。 */
	const newTask = async (seqs: number[]) => {
		const runId = await api.triggerOk(one);
		const task = await agent.nextAssign();
		await write(task, seqs);
		return { runId, task, file: fileOf(runId, task.taskId) };
	};
	const expectHeader = async (path: string) => {
		const res = await cp.fetch(path);
		const body = await res.text();
		return { status: res.status, header: res.headers.get(LOG_EXPECT_HEADER), body };
	};

	describe("响应头", () => {
		it("按运行下载：范围内有日志的任务数和各任务最后一个序号之和；两个任务 3 行和 4 行 = 7", async () => {
			const runId = await api.triggerOk(two);
			const a = await agent.nextAssign();
			await write(a, range(3));
			await agent.succeed(a, { text: "ok" });
			const b = await agent.nextAssign();
			await write(b, range(4));

			const res = await expectHeader(`/runs/${runId}/logs/download`);

			expect(res.status).toBe(200);
			expect(res.header).toBe("tasks=2; last_seq_sum=7");
		}, 60_000);

		it("序号有缺口（Agent 丢过行）：合计的是最后一个序号，不是行数", async () => {
			const { runId } = await newTask([1, 2, 5]);

			const res = await expectHeader(`/runs/${runId}/logs/download`);

			expect(res.header).toBe("tasks=1; last_seq_sum=5");
			expect(res.body.split("\n").filter(Boolean)).toHaveLength(3);
		}, 60_000);

		it("任务下载：tasks=1 和这个任务最后一个序号；从没有日志的任务是 tasks=0; last_seq_sum=0", async () => {
			const withLogs = await newTask(range(6));
			const quiet = await newTask([]);

			expect((await expectHeader(`/tasks/${withLogs.task.taskId}/logs/download`)).header).toBe(
				"tasks=1; last_seq_sum=6",
			);
			expect((await expectHeader(`/tasks/${quiet.task.taskId}/logs/download`)).header).toBe(
				"tasks=0; last_seq_sum=0",
			);
			expect((await expectHeader(`/runs/${quiet.runId}/logs/download`)).header).toBe(
				"tasks=0; last_seq_sum=0",
			);
		}, 60_000);

		it("范围（nodes）里的任务才算", async () => {
			const runId = await api.triggerOk(two);
			const a = await agent.nextAssign();
			await write(a, range(3));
			await agent.succeed(a, { text: "ok" });
			const b = await agent.nextAssign();
			await write(b, range(4));
			const view = (await (await cp.fetch(`/runs/${runId}`)).json()) as {
				chains: Array<{ id: string }>;
			};
			const chainId = view.chains[0]?.id as string;

			const onlyB = await expectHeader(
				`/runs/${runId}/logs/download?nodes=${encodeURIComponent(`${chainId}:b`)}`,
			);

			expect(onlyB.header).toBe("tasks=1; last_seq_sum=4");
		}, 60_000);

		it("任务很多时头也不变长：25 个任务，头仍是几十个字节", async () => {
			const runId = await api.triggerOk(many);
			for (let i = 0; i < MANY; i++) {
				const task = await agent.nextAssign();
				await write(task, range(2));
				await agent.succeed(task, { text: "ok" });
			}

			const res = await expectHeader(`/runs/${runId}/logs/download`);

			expect(res.header).toBe(`tasks=${MANY}; last_seq_sum=${MANY * 2}`);
			expect(Buffer.byteLength(res.header as string)).toBeLessThan(64);
		}, 180_000);

		it("文件比数据库记的长：头里是数据库记的最后一个序号（下限），不是文件里的", async () => {
			const { runId, task, file } = await newTask(range(3));
			appendFileSync(
				file,
				`${JSON.stringify({ seq: 4, time: new Date().toISOString(), agent_time: null, source: "stdout", level: "info", text: "追加的" })}\n`,
			);

			expect((await expectHeader(`/runs/${runId}/logs/download`)).header).toBe(
				"tasks=1; last_seq_sum=3",
			);
			expect((await expectHeader(`/tasks/${task.taskId}/logs/download`)).header).toBe(
				"tasks=1; last_seq_sum=3",
			);
		}, 60_000);

		it("410（文件不在了）、404 的响应不带这个头", async () => {
			const { runId, task, file } = await newTask(range(3));
			truncateSync(file, 0);

			expect((await expectHeader(`/runs/${runId}/logs/download`)).header).toBeNull();
			expect((await expectHeader(`/tasks/${task.taskId}/logs/download`)).header).toBeNull();
			const missing = await expectHeader(
				"/runs/00000000-0000-4000-8000-000000000000/logs/download",
			);
			expect(missing.status).toBe(404);
			expect(missing.header).toBeNull();
		}, 60_000);
	});

	describe("命令行经 HTTP/1.0 连上游的代理下载（sfly run logs --all）", () => {
		/** 比一批（1000 行）多：第一批发出去之后还有第二批、第三批要读。 */
		const ROWS = 3500;

		// 经代理连的地址不是测试控制面登记的地址，默认凭据带不上：自己给令牌。
		const download = async (server: string, runId: string, target: string) =>
			sfly(["run", "logs", runId, "--all", target, "--server", server, "--nickname", "alice"], {
				env: { SFLY_API_TOKEN: await cp.users.token("alice") },
			});

		it("没有改动：下载完整，文件里每一行都在（对照）", async () => {
			const { runId } = await newTask(range(ROWS));
			const proxy = await startHttp10Proxy(cp.httpUrl);
			try {
				const target = join(dir, "complete.jsonl");

				const result = await download(proxy.url, runId, target);

				expect(result.code, result.stderr).toBe(0);
				expect((await readFile(target, "utf8")).split("\n").filter(Boolean)).toHaveLength(ROWS);
			} finally {
				await proxy.close();
			}
		}, 180_000);

		it("读的过程中文件被截短、控制面断开连接，代理把半截当完整的转出去：命令行靠头认出来，download_incomplete、退出码 2、不留文件", async () => {
			const { runId, file } = await newTask(range(ROWS));
			hooks.open = {
				path: file,
				count: 0,
				at: 2,
				act: () => truncateSync(file, 100),
			};
			const proxy = await startHttp10Proxy(cp.httpUrl);
			try {
				const target = join(dir, "cut.jsonl");

				const result = await download(proxy.url, runId, target);

				// 前提：代理确实把半截的响应当完整的转了出去（直连看得出的断开，这里看不出）。
				expect(hooks.open).toBeUndefined();
				expect(result.code).toBe(2);
				expect(result.stderr).toContain("日志没有下载完");
				// 说明写明是代理没让断开看出来，提示带着原来的路径。
				expect(result.stderr).toContain("代理没有让它看出来");
				expect(result.stderr).toContain(`--all ${target}`);
				await expect(readFile(target)).rejects.toThrow();
			} finally {
				await proxy.close();
			}
		}, 180_000);

		it("没有这个头（旧控制面）：不核对，和以前一样（说明限制：这时 HTTP/1.0 的代理下半截看不出来）", async () => {
			const { runId, file } = await newTask(range(ROWS));
			hooks.open = { path: file, count: 0, at: 2, act: () => truncateSync(file, 100) };
			const proxy = await startHttp10Proxy(cp.httpUrl, [LOG_EXPECT_HEADER]);
			try {
				const target = join(dir, "old.jsonl");

				const result = await download(proxy.url, runId, target);

				expect(result.code, result.stderr).toBe(0);
				expect((await readFile(target, "utf8")).split("\n").filter(Boolean).length).toBeLessThan(
					ROWS,
				);
			} finally {
				await proxy.close();
			}
		}, 180_000);
	});
});
