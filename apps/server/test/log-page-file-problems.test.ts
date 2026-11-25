// 分页读取和实时流在日志文件不在了、变短了的时候说得出来（#721）：页里一个字段、连上实时流时一条事件，不再当成「没有日志」。
//
// #669 让下载在这种情况下回 410（响应开始之前）或断开连接（读的过程中）。分页读取（`GET /tasks/:id/logs`、`GET /runs/:id/logs`）
// 不该改成 410（页面需要拿到这一页才能提示），所以在页里说明：
// - 任务页：`file_problem`：`"missing"`（有行写入过、文件不在）、`"short"`（文件比数据库记的短）、null（没有问题）；
// - 运行页：`file_problems`（范围内有问题的任务，来源 + `problem`，最多 20 个）和 `file_problems_total`；
// - 实时流连上时：有问题就发一条事件（`file_problem` / `file_problems`，内容同页里的字段），之后不再发。
// 判断和下载是同一个函数（`logFileProblem`）：文件比记录的长、从没有日志的任务、已经过了保留期的运行（`expired` 已经说了）都不算。
// 走真实的文件、真实的 HTTP 响应和真实的 SSE。
import { appendFileSync, truncateSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logsApi, runsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane } from "./support/test-control-plane.js";

const DAY = 24 * 3600 * 1000;

const chain = (ids: string[]) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		...ids.map((id) => ({ id, kind: "package", package: "stub", node: "echo" })),
	],
	edges: ["entry", ...ids].slice(0, -1).map((from, i) => ({ from, to: ids[i], kind: "chain" })),
	packages: { stub: "1.0.0" },
});

/** 等一会儿，看这条流收到过什么事件（连着的流会周期性地发控制面时间 `time`，不算）。 */
const eventsAfter = async (stream: SseClient, ms: number) => {
	await new Promise((resolve) => setTimeout(resolve, ms));
	return stream.received.map((e) => e.event).filter((event) => event !== "time");
};

/** 一个运行里最多列出多少个有问题的任务（页里和 410 的 `details` 一样，总数在 `file_problems_total`）。 */
const LIMIT = 20;

describe("分页读取和实时流里的日志文件问题（#721）", () => {
	let cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	let agent: Awaited<ReturnType<typeof FakeAgent.connect>>;
	let api: InstanceType<typeof ApiClient>;
	let one: string;
	let two: string;
	let many: string;
	const MANY = LIMIT + 5;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		// 每个任务占一个槽位、没结束的不释放：槽位要比整个文件里造的任务总数多。
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 64 });
		api = new ApiClient(cp);
		one = await api.orchestrationWith(chain(["a"]));
		two = await api.orchestrationWith(chain(["a", "b"]));
		many = await api.orchestrationWith(
			chain(Array.from({ length: MANY }, (_, i) => `n${String(i + 1).padStart(2, "0")}`)),
		);
	}, 60_000);
	afterAll(async () => {
		await agent?.disconnect();
		await cp?.close();
	});

	const fileOf = (runId: string, taskId: string) =>
		join(cp.dataDir, "logs", runId, `${taskId}.jsonl`);
	/** 写 `count` 行日志（序号从 1 起），等数据库记到。 */
	const write = async (task: Parameters<typeof agent.logs>[0], count: number) => {
		if (count === 0) return;
		agent.logs(
			task,
			Array.from({ length: count }, (_, i): [number, string] => [i + 1, `第 ${i + 1} 行`]),
		);
		await eventually(async () => {
			const page = await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1`)).json();
			expect(logsApi.page.response.parse(page).last_seq).toBe(count);
		}, 30_000);
	};
	/** 一个运行里的一个任务（一直不结束）：`lines` 行（0 是从没有日志）。 */
	const newTask = async (lines: number) => {
		const runId = await api.triggerOk(one);
		const task = await agent.nextAssign();
		await write(task, lines);
		return { runId, task, file: fileOf(runId, task.taskId) };
	};
	/** 两个任务的运行：a 写 `lines` 行、成功，b 写 `lines` 行、不结束。 */
	const newTwoTaskRun = async (lines: number) => {
		const runId = await api.triggerOk(two);
		const a = await agent.nextAssign();
		await write(a, lines);
		await agent.succeed(a, { text: "ok" });
		const b = await agent.nextAssign();
		await write(b, lines);
		return { runId, a, b, aFile: fileOf(runId, a.taskId), bFile: fileOf(runId, b.taskId) };
	};
	/** 文件前 `count` 行（含换行）的字节数。 */
	const bytesOfLines = async (file: string, count: number) => {
		const bytes = await readFile(file);
		let end = 0;
		for (let i = 0; i < count; i++) end = bytes.indexOf(0x0a, end) + 1;
		return end;
	};
	/** 追加到文件里的一行（不更新数据库：进程在追加文件之后、更新库之前退出时就是这样）。 */
	const extraLine = (seq: number) =>
		`${JSON.stringify({ seq, time: new Date().toISOString(), agent_time: null, source: "stdout", level: "info", text: `追加的第 ${seq} 行` })}\n`;

	const taskPage = async (taskId: string, query = "") =>
		logsApi.page.response.parse(await (await cp.fetch(`/tasks/${taskId}/logs${query}`)).json());
	const runPage = async (runId: string, query = "") =>
		logsApi.runPage.response.parse(await (await cp.fetch(`/runs/${runId}/logs${query}`)).json());

	describe("任务页（GET /tasks/:id/logs）", () => {
		it("没有问题：file_problem 是 null（对照）", async () => {
			const { task } = await newTask(5);

			const page = await taskPage(task.taskId);

			expect(page.file_problem).toBeNull();
			expect(page.lines).toHaveLength(5);
		}, 60_000);

		it("文件不见了（有行写入过）：file_problem 是 missing，页还是 200、空的，其余字段照旧", async () => {
			const { task, file } = await newTask(5);
			unlinkSync(file);

			const page = await taskPage(task.taskId);

			expect(page.file_problem).toBe("missing");
			expect(page.lines).toEqual([]);
			// 页的其余部分和以前一样：记的最后一个序号还在、没过保留期。
			expect(page.last_seq).toBe(5);
			expect(page.expired).toBe(false);
		}, 60_000);

		it("文件比数据库记的短：file_problem 是 short，剩下的行照常读到", async () => {
			const { task, file } = await newTask(5);
			truncateSync(file, await bytesOfLines(file, 2));

			const page = await taskPage(task.taskId);

			expect(page.file_problem).toBe("short");
			expect(page.lines.map((l) => l.seq)).toEqual([1, 2]);
		}, 60_000);

		it("截短到 0 字节（文件还在、是空的）：short", async () => {
			const { task, file } = await newTask(5);
			truncateSync(file, 0);

			expect((await taskPage(task.taskId)).file_problem).toBe("short");
		}, 60_000);

		it("文件比数据库记的长（追加了、库还没更新，或者任务正在写）：不是问题，null", async () => {
			const { task, file } = await newTask(5);
			appendFileSync(file, extraLine(6));

			const page = await taskPage(task.taskId);

			expect(page.file_problem).toBeNull();
			expect(page.lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		}, 60_000);

		it("从没有日志的任务（没有行写入过、没有文件）：null", async () => {
			const { task } = await newTask(0);

			const page = await taskPage(task.taskId);

			expect(page.file_problem).toBeNull();
			expect(page.lines).toEqual([]);
		}, 60_000);

		it("带 before / after / at 读的页同样带这个字段", async () => {
			const { task, file } = await newTask(5);
			truncateSync(file, await bytesOfLines(file, 3));

			expect((await taskPage(task.taskId, "?limit=1")).file_problem).toBe("short");
			expect((await taskPage(task.taskId, "?after=0&limit=1")).file_problem).toBe("short");
			expect(
				(await taskPage(task.taskId, `?at=${encodeURIComponent(new Date().toISOString())}`))
					.file_problem,
			).toBe("short");
		}, 60_000);
	});

	describe("运行页（GET /runs/:id/logs）", () => {
		it("没有问题：file_problems 是空的、total 是 0（对照）", async () => {
			const { runId } = await newTwoTaskRun(3);

			const page = await runPage(runId);

			expect(page.file_problems).toEqual([]);
			expect(page.file_problems_total).toBe(0);
			expect(page.lines).toHaveLength(6);
		}, 60_000);

		it("一个任务的文件不见了：列出它（来源 + problem），别的任务的行照常读到", async () => {
			const { runId, a, b, bFile } = await newTwoTaskRun(3);
			unlinkSync(bFile);

			const page = await runPage(runId);

			expect(page.file_problems).toEqual([
				expect.objectContaining({
					task_id: b.taskId,
					node_id: "b",
					attempt: 1,
					subflow: null,
					problem: "missing",
				}),
			]);
			expect(page.file_problems[0]?.chain_instance_id).toEqual(expect.any(String));
			expect(page.file_problems_total).toBe(1);
			expect(new Set(page.lines.map((l) => l.task_id))).toEqual(new Set([a.taskId]));
		}, 60_000);

		it("一个不见了、一个变短了：都列出，按运行里任务的顺序", async () => {
			const { runId, a, b, aFile, bFile } = await newTwoTaskRun(4);
			truncateSync(aFile, await bytesOfLines(aFile, 1));
			unlinkSync(bFile);

			const page = await runPage(runId);

			expect(page.file_problems.map((p) => [p.task_id, p.problem])).toEqual([
				[a.taskId, "short"],
				[b.taskId, "missing"],
			]);
			expect(page.file_problems_total).toBe(2);
		}, 60_000);

		it("文件比记录的长、从没有日志的任务：不算", async () => {
			const { runId, aFile } = await newTwoTaskRun(3);
			appendFileSync(aFile, extraLine(4));
			// 第三个任务从没有日志：另开一个运行，一个任务没有行。
			const quiet = await newTask(0);

			expect((await runPage(runId)).file_problems).toEqual([]);
			expect((await runPage(quiet.runId)).file_problems).toEqual([]);
		}, 60_000);

		it("最多列 20 个，总数在 file_problems_total：任务多、文件都没了时页不会很大", async () => {
			const runId = await api.triggerOk(many);
			const files: string[] = [];
			const tasks: string[] = [];
			for (let i = 0; i < MANY; i++) {
				const task = await agent.nextAssign();
				await write(task, 1);
				await agent.succeed(task, { text: "ok" });
				files.push(fileOf(runId, task.taskId));
				tasks.push(task.taskId);
			}
			for (const file of files) unlinkSync(file);

			const page = await runPage(runId);

			expect(page.file_problems).toHaveLength(LIMIT);
			expect(page.file_problems_total).toBe(MANY);
			// 按运行里任务的顺序：列出的是最前面的 20 个。
			expect(page.file_problems.map((p) => p.task_id)).toEqual(tasks.slice(0, LIMIT));
			expect(new Set(page.file_problems.map((p) => p.problem))).toEqual(new Set(["missing"]));
		}, 180_000);

		it("范围（nodes）里的任务才算：只看 a 时，b 的文件不见了不列出", async () => {
			const { runId, bFile } = await newTwoTaskRun(3);
			unlinkSync(bFile);
			const view = runsApi.get.response.parse(await (await cp.fetch(`/runs/${runId}`)).json());
			const chainId = view.chains[0]?.id as string;

			const onlyA = await runPage(runId, `?nodes=${encodeURIComponent(`${chainId}:a`)}`);
			const onlyB = await runPage(runId, `?nodes=${encodeURIComponent(`${chainId}:b`)}`);

			expect(onlyA.file_problems).toEqual([]);
			expect(onlyA.file_problems_total).toBe(0);
			expect(onlyB.file_problems.map((p) => p.node_id)).toEqual(["b"]);
			expect(onlyB.file_problems_total).toBe(1);
		}, 60_000);

		it("往前翻页、往后接续的页同样带这个字段", async () => {
			const { runId, bFile } = await newTwoTaskRun(4);
			unlinkSync(bFile);

			const latest = await runPage(runId, "?limit=2");
			const older = await runPage(runId, `?limit=2&before=${encodeURIComponent(latest.before)}`);
			const newer = await runPage(runId, `?limit=2&after=${encodeURIComponent(older.after)}`);

			for (const page of [latest, older, newer]) {
				expect(page.file_problems_total).toBe(1);
				expect(page.file_problems.map((p) => p.node_id)).toEqual(["b"]);
			}
		}, 60_000);
	});

	describe("实时流连上时", () => {
		it("任务流：有问题就先发一条 file_problem 事件（再发 logs 的尾部），没有问题就不发", async () => {
			const bad = await newTask(5);
			unlinkSync(bad.file);
			const good = await newTask(5);

			const badStream = await SseClient.open(cp, `/tasks/${bad.task.taskId}/logs/events`);
			const goodStream = await SseClient.open(cp, `/tasks/${good.task.taskId}/logs/events`);
			try {
				const problem = await badStream.next<{ file_problem: string }>("file_problem");
				await badStream.next("logs");
				await goodStream.next("logs");

				expect(problem.data).toEqual({ file_problem: "missing" });
				expect(goodStream.received.map((e) => e.event)).not.toContain("file_problem");
				// 连上时发一次，之后不再发。
				expect(await eventsAfter(badStream, 300)).toEqual(["file_problem", "logs"]);
			} finally {
				badStream.close();
				goodStream.close();
			}
		}, 60_000);

		it("任务流：变短的文件是 short", async () => {
			const { task, file } = await newTask(5);
			truncateSync(file, await bytesOfLines(file, 2));

			const stream = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
			try {
				expect((await stream.next<{ file_problem: string }>("file_problem")).data).toEqual({
					file_problem: "short",
				});
			} finally {
				stream.close();
			}
		}, 60_000);

		it("运行流：有问题就先发一条 file_problems 事件，内容同页里的字段；没有问题就不发", async () => {
			const bad = await newTwoTaskRun(3);
			unlinkSync(bad.bFile);
			const good = await newTwoTaskRun(3);
			const badLive = (await runPage(bad.runId)).live_after;
			const goodLive = (await runPage(good.runId)).live_after;

			const badStream = await SseClient.open(
				cp,
				`/runs/${bad.runId}/logs/events?after=${encodeURIComponent(badLive)}`,
			);
			const goodStream = await SseClient.open(
				cp,
				`/runs/${good.runId}/logs/events?after=${encodeURIComponent(goodLive)}`,
			);
			try {
				const problem = await badStream.next<{
					file_problems: Array<{ task_id: string; problem: string }>;
					file_problems_total: number;
				}>("file_problems");

				expect(problem.data.file_problems_total).toBe(1);
				expect(problem.data.file_problems.map((p) => [p.task_id, p.problem])).toEqual([
					[bad.b.taskId, "missing"],
				]);
				// 没有问题的运行：连上之后没有任何事件（没有新的行）。
				expect(await eventsAfter(goodStream, 500)).toEqual([]);
			} finally {
				badStream.close();
				goodStream.close();
			}
		}, 60_000);
	});

	// 放在最后：重启之后这个文件里的 FakeAgent 就断开了。
	describe("控制面重启之后（状态从数据库和文件里读，不是内存里的）", () => {
		it("任务页和运行页同样认得出文件不见了、变短了；没有问题的照常", async () => {
			const gone = await newTask(5);
			const cut = await newTask(5);
			const intact = await newTask(4);
			unlinkSync(gone.file);
			truncateSync(cut.file, await bytesOfLines(cut.file, 2));
			await agent.disconnect();

			await cp.restart();

			expect((await taskPage(gone.task.taskId)).file_problem).toBe("missing");
			expect((await taskPage(cut.task.taskId)).file_problem).toBe("short");
			expect((await taskPage(intact.task.taskId)).file_problem).toBeNull();
			expect((await runPage(gone.runId)).file_problems.map((p) => p.problem)).toEqual(["missing"]);
			expect((await runPage(cut.runId)).file_problems.map((p) => p.problem)).toEqual(["short"]);
			expect((await runPage(intact.runId)).file_problems).toEqual([]);
		}, 90_000);
	});
});

describe("已经过了保留期的运行（#721）", () => {
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

	it("页里是原来的 expired，不带 file_problem、file_problems（文件本来就被清理了）；实时流不发事件", async () => {
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(chain(["a"])));
		const task = await agent.nextAssign();
		agent.logs(task, [[1, "hello"]]);
		await eventually(async () => {
			const page = await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1`)).json();
			expect(logsApi.page.response.parse(page).last_seq).toBe(1);
		});
		await agent.succeed(task, { text: "ok" });
		(cp.clock as unknown as { advance(ms: number): void }).advance(8 * DAY);
		await eventually(async () => {
			const page = (await (await cp.fetch(`/tasks/${task.taskId}/logs`)).json()) as {
				expired: boolean;
			};
			expect(page.expired).toBe(true);
		}, 30_000);

		const taskPage = logsApi.page.response.parse(
			await (await cp.fetch(`/tasks/${task.taskId}/logs`)).json(),
		);
		const runPage = logsApi.runPage.response.parse(
			await (await cp.fetch(`/runs/${runId}/logs`)).json(),
		);
		expect(taskPage).toMatchObject({ expired: true, file_problem: null });
		expect(runPage).toMatchObject({ expired: true, file_problems: [], file_problems_total: 0 });

		const taskStream = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
		const runStream = await SseClient.open(
			cp,
			`/runs/${runId}/logs/events?after=${encodeURIComponent(runPage.live_after)}`,
		);
		try {
			await taskStream.next("logs");
			expect(taskStream.received.map((e) => e.event)).not.toContain("file_problem");
			expect(await eventsAfter(runStream, 500)).toEqual([]);
		} finally {
			taskStream.close();
			runStream.close();
		}
	}, 90_000);
});
