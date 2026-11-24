// 下载日志时日志文件变了：响应不能照常 200、看起来下完了（#669）。走真实的文件、真实的 HTTP 响应。
//
// 以前（审查 #647 时在真实的控制面进程上造出来的）：
// 1. 按运行下载时某个任务的日志文件中途被删除：只有已经读到的那一批，正常结束（每一批都重新打开文件，文件不存在被当成空页）；
// 2. 任务日志在读的过程中被截短：正常结束，只有截短前的内容；
// 3. 任务日志在请求之前就被删除：200 加空正文。
// 现在：
// - 响应开始之前认出来的（有行写入过的任务，文件不见了或者比数据库记的短）：410 `expired`；从没有日志的任务（没有行写入过）下载是空的；
// - 读的过程中认出来的（响应已经开始）：连接被断开（客户端看得出没下完）；还开着的文件被删除不受影响，照常读完。
//
// 「读的过程中」靠两个钩子做出确定的次序（不靠碰运气的时序）：任务日志的下载在 `createReadStream` 被调用的那一刻（路由已经 stat 过、
// 文件还没打开）截短文件，或者在文件打开之后删除它；按运行下载在第二次打开这个文件时（第一批已经发出去、第二批要读）删除或截短它。
// 文件都是真的，动文件的也是真的 `unlink`、`truncate`。
import { appendFileSync, truncateSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** 两个钩子：谁在什么时候动日志文件；用完（触发一次）就清掉。 */
const hooks = vi.hoisted(() => ({
	/** 任务日志下载：`createReadStream` 打开这个路径时，打开之前（`before`）或打开之后（`afterOpen`）做的事。 */
	read: undefined as { path: string; before?: () => void; afterOpen?: () => void } | undefined,
	/** 按运行下载：第 `at` 次（从 1 数）打开这个文件之前做的事。 */
	open: undefined as { path: string; count: number; at: number; act: () => void } | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const createReadStream = (...args: Parameters<typeof actual.createReadStream>) => {
		const hook = hooks.read;
		if (!hook || String(args[0]) !== hook.path) return actual.createReadStream(...args);
		hooks.read = undefined;
		hook.before?.();
		const stream = actual.createReadStream(...args);
		if (hook.afterOpen) stream.once("open", hook.afterOpen);
		return stream;
	};
	return { ...actual, default: { ...actual, createReadStream }, createReadStream };
});

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

const { logsApi } = await import("@sfly/schema");
const { ApiClient } = await import("./support/api-client.js");
const { eventually } = await import("./support/eventually.js");
const { FakeAgent } = await import("./support/fake-agent.js");
const { publishPackage } = await import("./support/package-archive.js");
const { startTestControlPlane } = await import("./support/test-control-plane.js");

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

/** 一次下载看到的：状态码、头、读到的正文、响应是不是完整结束了（分块的响应有结尾的那一块）。 */
interface Downloaded {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
	complete: boolean;
}

describe("下载日志时日志文件变了", () => {
	let cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	let agent: Awaited<ReturnType<typeof FakeAgent.connect>>;
	let api: InstanceType<typeof ApiClient>;
	let scenario: string;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		// 每个 newTask 占一个槽位、任务一直不结束（日志文件要留着）：槽位要比整个文件里造的任务总数多，不然最后几个用例等不到 assign。
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 64 });
		api = new ApiClient(cp);
		scenario = await api.orchestrationWith(DOC);
	}, 60_000);
	afterAll(async () => {
		hooks.read = undefined;
		hooks.open = undefined;
		await agent?.disconnect();
		await cp?.close();
	});
	afterEach(() => {
		hooks.read = undefined;
		hooks.open = undefined;
	});

	/** 一个运行里的一个任务：`lines` 行日志（0 是从没有日志）写进文件、数据库也记了。 */
	const newTask = async (lines: number) => {
		const runId = await api.triggerOk(scenario);
		const task = await agent.nextAssign();
		if (lines > 0) {
			agent.logs(
				task,
				Array.from({ length: lines }, (_, i): [number, string] => [i + 1, `第 ${i + 1} 行`]),
			);
			await eventually(async () => {
				const page = await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1`)).json();
				expect(logsApi.page.response.parse(page).last_seq).toBe(lines);
			}, 30_000);
		}
		return { runId, task, file: join(cp.dataDir, "logs", runId, `${task.taskId}.jsonl`) };
	};

	const download = (path: string) =>
		new Promise<Downloaded>((resolve, reject) => {
			httpRequest(`${cp.httpUrl}${path}`, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("error", () => {});
				res.on("close", () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
						complete: res.complete,
					}),
				);
			})
				.on("error", reject)
				.end();
		});
	const rows = (body: string) =>
		body
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { seq: number; text: string });

	/** 追加到文件里的一行（不更新数据库：进程在追加文件之后、更新库之前退出时就是这样）。 */
	const extraLine = (seq: number) =>
		`${JSON.stringify({ seq, time: new Date().toISOString(), agent_time: null, source: "stdout", level: "info", text: `追加的第 ${seq} 行` })}\n`;
	/** 410 的错误：`details` 写明是哪几个任务、各是什么情况（#716 的审查）。 */
	const goneError = (res: Downloaded) =>
		JSON.parse(res.body).error as {
			code: string;
			message: string;
			details: {
				tasks: Array<{ task_id: string; node_id: string; attempt: number; reason: string }>;
				total: number;
			};
		};

	/** 文件前 `count` 行（含换行）的字节数。 */
	const bytesOfLines = async (file: string, count: number) => {
		const bytes = await readFile(file);
		let end = 0;
		for (let i = 0; i < count; i++) end = bytes.indexOf(0x0a, end) + 1;
		return end;
	};

	describe("任务日志（GET /tasks/:id/logs/download）", () => {
		const url = (taskId: string) => `/tasks/${taskId}/logs/download`;

		it("没有改动：200，每一行都在、完整结束（对照）", async () => {
			const { task } = await newTask(5);

			const res = await download(url(task.taskId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(true);
			expect(rows(res.body).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
		}, 60_000);

		it("请求之前文件被删除（保留期清理删到一半，运行还没有标记）：410 expired，不是 200 加空正文", async () => {
			const { task, file } = await newTask(5);
			unlinkSync(file);

			const res = await download(url(task.taskId));

			expect(res.status).toBe(410);
			expect(JSON.parse(res.body)).toMatchObject({ error: { code: "expired" } });
			// 说明写明文件不见了或变短了和各种来路（掉电、分开恢复也会让文件比库记的短）；`details` 写明是哪个任务、什么情况。
			const error = goneError(res);
			expect(error.message).toContain("missing or shorter");
			expect(error.message).toContain("lost power");
			expect(error.message).toContain("restored");
			expect(error.message).not.toContain("removed after retention");
			expect(error.details).toEqual({
				tasks: [{ task_id: task.taskId, node_id: "a", attempt: 1, reason: "missing" }],
				total: 1,
			});
			// 不是「下载一个文件」：没有文件名的头。
			expect(res.headers["content-disposition"]).toBeUndefined();
			expect((await cp.fetch("/health")).status).toBe(200);
		}, 60_000);

		it("请求之前文件被截短：410 expired（比数据库记的短），不是 200 加缺了一截的正文", async () => {
			const { task, file } = await newTask(5);
			truncateSync(file, await bytesOfLines(file, 2));

			const res = await download(url(task.taskId));

			expect(res.status).toBe(410);
			expect(JSON.parse(res.body)).toMatchObject({ error: { code: "expired" } });
			expect(goneError(res).message).toContain("shorter");
			expect(goneError(res).details.tasks).toEqual([
				{ task_id: task.taskId, node_id: "a", attempt: 1, reason: "short" },
			]);
		}, 60_000);

		it("文件比数据库记的长（追加了文件、还没更新库就退出，或者任务正在写）不是问题：200，完整结束，长出来的一行也读到（#716 的审查）", async () => {
			const { task, file } = await newTask(5);
			appendFileSync(file, extraLine(6));

			const res = await download(url(task.taskId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(true);
			expect(rows(res.body).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		}, 60_000);

		it("从没有日志的任务（没有行写入过、没有文件）：下载是空的，200（不是 410）", async () => {
			const { task } = await newTask(0);

			const res = await download(url(task.taskId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(true);
			expect(res.body).toBe("");
		}, 60_000);

		it("日志文件被换成同名的目录（读不了）：不是「日志没了」的 410，也不是成功的下载：读文件出错（500 或连接断开，#647），控制面不退出", async () => {
			const { task, file } = await newTask(5);
			await rm(file);
			await mkdir(file);

			const res = await download(url(task.taskId)).catch(() => undefined);

			expect(res?.status === 410).toBe(false);
			// 把目录当成「没有文件」回 200 空正文、完整结束，不行：要么 500、要么连接断开。
			expect(res?.status === 200 && res.complete).toBe(false);
			expect((await cp.fetch("/health")).status).toBe(200);
		}, 60_000);

		it("检查通过之后、打开文件之前文件被删除：410（不是响应还没开始就出错的 500）", async () => {
			const { task, file } = await newTask(5);
			hooks.read = { path: file, before: () => unlinkSync(file) };

			const res = await download(url(task.taskId));

			expect(res.status).toBe(410);
			expect(goneError(res).details.tasks).toEqual([
				{ task_id: task.taskId, node_id: "a", attempt: 1, reason: "missing" },
			]);
		}, 60_000);

		it("读的过程中文件被截短（stat 之后、打开之前）：响应已经开始，连接被断开，不是正常结束", async () => {
			const { task, file } = await newTask(5);
			// 留下前两行：读到的是完整的两行，然后文件到头了，比请求开始时少了三行。
			const keep = await bytesOfLines(file, 2);
			hooks.read = { path: file, before: () => truncateSync(file, keep) };

			const res = await download(url(task.taskId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(false);
			// 已经发出去的只会是前两行（的一部分），不会是别的。
			expect(rows(res.body).map((row) => row.seq).length).toBeLessThanOrEqual(2);
		}, 60_000);

		it("读的过程中文件被删除（文件已经打开）：照常读完，每一行都在", async () => {
			// 打开着的文件被删除，读到的还是那份内容：不丢东西，不需要断开。
			const { task, file } = await newTask(5);
			hooks.read = { path: file, afterOpen: () => unlinkSync(file) };

			const res = await download(url(task.taskId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(true);
			expect(rows(res.body).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
		}, 60_000);
	});

	describe("按运行下载（GET /runs/:id/logs/download）", () => {
		const url = (runId: string) => `/runs/${runId}/logs/download`;
		/** 比一批（1000 行）多：第一批发出去之后还有第二批、第三批要读。 */
		const MANY = 3500;

		it("没有改动：200，所有行都在、完整结束（对照，也证明钩子本身不影响下载）", async () => {
			const { runId, file } = await newTask(MANY);
			hooks.open = { path: file, count: 0, at: 99, act: () => {} };

			const res = await download(url(runId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(true);
			expect(rows(res.body)).toHaveLength(MANY);
			// 钩子数到了：这个文件被打开了不止一次（一批一批读，每批重新打开）。
			expect(hooks.open?.count).toBeGreaterThanOrEqual(3);
		}, 90_000);

		it("请求之前某个任务的日志文件被删除：410 expired，不是只有别的任务的行、也不是 200 加空正文", async () => {
			const { runId, task, file } = await newTask(5);
			unlinkSync(file);

			const res = await download(url(runId));

			expect(res.status).toBe(410);
			expect(JSON.parse(res.body)).toMatchObject({ error: { code: "expired" } });
			const error = goneError(res);
			expect(error.message).toContain("at least one task of this run is missing or shorter");
			expect(error.message).toContain("lost power");
			expect(error.message).not.toContain("removed after retention");
			expect(error.details).toEqual({
				tasks: [{ task_id: task.taskId, node_id: "a", attempt: 1, reason: "missing" }],
				total: 1,
			});
			expect(res.headers["content-disposition"]).toBeUndefined();
		}, 60_000);

		it("请求之前某个任务的日志文件被截短：410 expired，details 写明是哪个任务、变短了", async () => {
			const { runId, task, file } = await newTask(5);
			truncateSync(file, await bytesOfLines(file, 2));

			const res = await download(url(runId));

			expect(res.status).toBe(410);
			expect(JSON.parse(res.body)).toMatchObject({ error: { code: "expired" } });
			expect(goneError(res).details.tasks).toEqual([
				{ task_id: task.taskId, node_id: "a", attempt: 1, reason: "short" },
			]);
		}, 60_000);

		it("文件比数据库记的长不是问题：200，完整结束（#716 的审查）", async () => {
			const { runId, file } = await newTask(5);
			appendFileSync(file, extraLine(6));

			const res = await download(url(runId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(true);
			expect(rows(res.body).length).toBeGreaterThanOrEqual(5);
		}, 60_000);

		it("检查通过之后、读第一批的时候文件被删除：410（不是响应还没开始就出错的 500）", async () => {
			const { runId, task, file } = await newTask(5);
			// 路由的检查用 stat；第一批读文件时（第一次打开它）文件没了。
			hooks.open = { path: file, count: 0, at: 1, act: () => unlinkSync(file) };

			const res = await download(url(runId));

			expect(res.status).toBe(410);
			expect(goneError(res).details.tasks).toEqual([
				{ task_id: task.taskId, node_id: "a", attempt: 1, reason: "short" },
			]);
		}, 60_000);

		it("某个任务的日志文件被换成同名的目录（读不了）：不是 410，也不是成功的下载：读文件出错（500 或连接断开），控制面不退出", async () => {
			const { runId, file } = await newTask(5);
			await rm(file);
			await mkdir(file);

			const res = await download(url(runId)).catch(() => undefined);

			expect(res?.status === 410).toBe(false);
			// 把目录当成「没有日志文件」回 200 空正文、完整结束，不行。
			expect(res?.status === 200 && res.complete).toBe(false);
			expect((await cp.fetch("/health")).status).toBe(200);
		}, 60_000);

		it("运行里的任务从没有日志：下载是空的，200（不是 410）", async () => {
			const { runId } = await newTask(0);

			const res = await download(url(runId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(true);
			expect(res.body).toBe("");
		}, 60_000);

		it("下载进行中（第一批已经发出去）文件被删除：连接被断开，不是只有 1000 行、正常结束（issue 的第 1 种）", async () => {
			const { runId, file } = await newTask(MANY);
			hooks.open = { path: file, count: 0, at: 2, act: () => unlinkSync(file) };

			const res = await download(url(runId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(false);
			// 已经发出去的是完整的一批，之后没有了。
			expect(rows(res.body).length).toBeLessThan(MANY);
		}, 90_000);

		it("下载进行中文件被截短：连接被断开，不是读到截短之前的内容就正常结束（issue 的第 2 种）", async () => {
			const { runId, file } = await newTask(MANY);
			const keep = await bytesOfLines(file, 1500);
			hooks.open = { path: file, count: 0, at: 2, act: () => truncateSync(file, keep) };

			const res = await download(url(runId));

			expect(res.status).toBe(200);
			expect(res.complete).toBe(false);
			expect(rows(res.body).length).toBeLessThan(MANY);
		}, 90_000);
	});

	describe("控制面重启之后（日志文件的状态从数据库和文件里读，不是内存里的）", () => {
		it("任务日志和按运行下载：文件被删除或截短 410，没有改动的任务、运行照常", async () => {
			const gone = await newTask(5);
			const cut = await newTask(5);
			const intact = await newTask(4);
			const longer = await newTask(3);
			// 追加了文件、库里没记：重启之后从数据库和文件里读，也不是问题。
			appendFileSync(longer.file, extraLine(4));
			await agent.disconnect();
			await cp.restart();
			unlinkSync(gone.file);
			truncateSync(cut.file, await bytesOfLines(cut.file, 2));

			const taskGone = await cp.fetch(`/tasks/${gone.task.taskId}/logs/download`);
			const taskIntact = await cp.fetch(`/tasks/${intact.task.taskId}/logs/download`);
			const runGone = await cp.fetch(`/runs/${gone.runId}/logs/download`);
			const runIntact = await cp.fetch(`/runs/${intact.runId}/logs/download`);

			expect(taskGone.status).toBe(410);
			expect(runGone.status).toBe(410);
			expect((await cp.fetch(`/tasks/${cut.task.taskId}/logs/download`)).status).toBe(410);
			expect((await cp.fetch(`/runs/${cut.runId}/logs/download`)).status).toBe(410);
			expect(taskIntact.status).toBe(200);
			expect(rows(await taskIntact.text())).toHaveLength(4);
			expect(runIntact.status).toBe(200);
			expect(rows(await runIntact.text())).toHaveLength(4);
			const taskLonger = await cp.fetch(`/tasks/${longer.task.taskId}/logs/download`);
			const runLonger = await cp.fetch(`/runs/${longer.runId}/logs/download`);
			expect(taskLonger.status).toBe(200);
			expect(rows(await taskLonger.text())).toHaveLength(4);
			expect(runLonger.status).toBe(200);
			expect(rows(await runLonger.text()).length).toBeGreaterThanOrEqual(3);
		}, 90_000);
	});
});

describe("已经过了保留期的运行：下载的说明还是「保留期清理」，不是「日志文件不见了」（#716 的审查）", () => {
	const DAY = 24 * 60 * 60 * 1000;
	let cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	let agent: Awaited<ReturnType<typeof FakeAgent.connect>>;

	beforeAll(async () => {
		cp = await startTestControlPlane({ leaseMs: 400 * DAY, retentionDays: 7 });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
	}, 60_000);
	afterAll(async () => {
		await agent?.disconnect();
		await cp?.close();
	});

	it("两种下载都是 410 expired，说明是「removed after retention」，没有 details", async () => {
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		agent.logs(task, [[1, "hello"]]);
		await eventually(async () => {
			const page = await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1`)).json();
			expect(logsApi.page.response.parse(page).last_seq).toBe(1);
		});
		await agent.succeed(task, { text: "ok" });
		(cp.clock as unknown as { advance(ms: number): void }).advance(8 * DAY);
		await eventually(async () => {
			const page = (await (await cp.fetch(`/tasks/${task.taskId}/logs`)).json()) as { expired: boolean };
			expect(page.expired).toBe(true);
		}, 30_000);

		for (const path of [`/runs/${runId}/logs/download`, `/tasks/${task.taskId}/logs/download`]) {
			const res = await cp.fetch(path);
			const body = (await res.json()) as {
				error: { code: string; message: string; details?: unknown };
			};
			expect(res.status, path).toBe(410);
			expect(body.error.code, path).toBe("expired");
			expect(body.error.message, path).toBe("logs of this run were removed after retention");
			expect(body.error.details, path).toBeUndefined();
		}
	}, 90_000);
});
