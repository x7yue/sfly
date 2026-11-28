// 保留期清理正在删文件的那几秒，不能把「过了保留期」说成「日志文件不在了」（#734 的审查，探测 P1）。
//
// 清理（`Retention` 的 `#sweep`）在一个事务里先 `FOR UPDATE` 锁住运行的行、再删这个运行的日志目录、最后写 `purged_at` 提交；
// 删大目录要几秒。这期间 `isPurged` 读不到还没提交的 `purged_at`，接着看文件就认成「不见了」：页、实时流、下载都这样说，
// 清理提交之后才变成 `expired`。改成只在认出了文件的问题之后，用 `FOR KEY SHARE` 再读一次（等清理提交）：六条路（两种页、两种流、
// 两种下载）都回 `expired`、没有一条说文件有问题；等待有上界，等不到按「正在清理」回 `expired`；没有问题的请求不多查、不等。
// 走真实的文件、真实的 HTTP、真实的 SSE，清理用另一个数据库连接持着 `FOR UPDATE` 模拟（事务里先锁、再删目录、最后写 `purged_at` 提交）。
import { rmSync } from "node:fs";
import { join } from "node:path";
import { logsApi } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { writeRecordedLogs } from "./support/recorded-logs.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane } from "./support/test-control-plane.js";

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

const PURGED = "logs of this run were removed after retention";

/** 等一会儿，看这条流收到过什么事件（连着的流会周期性地发控制面时间 `time`，不算）。 */
const eventsAfter = async (stream: SseClient, ms: number) => {
	await new Promise((resolve) => setTimeout(resolve, ms));
	return stream.received.map((e) => e.event).filter((event) => event !== "time");
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 另一个数据库连接，模拟保留期清理：事务里锁住运行的行，（测试删目录，）`finish` 写 `purged_at` 提交，`abort` 回滚。 */
async function holdRunLock(databaseUrl: string, runId: string) {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	await client.query("BEGIN");
	await client.query("SELECT purged_at FROM runs WHERE id = $1 FOR UPDATE", [runId]);
	return {
		finish: async () => {
			await client.query("UPDATE runs SET purged_at = now() WHERE id = $1", [runId]);
			await client.query("COMMIT");
			await client.end();
		},
		abort: async () => {
			await client.query("ROLLBACK");
			await client.end();
		},
	};
}

/** 一个请求有没有在这段时间里完成：没有完成说明它在等。 */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
	let done = false;
	void promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	await sleep(ms);
	return done;
}

describe("保留期清理正在删文件时的日志读取（#734）", () => {
	let cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	let agent: Awaited<ReturnType<typeof FakeAgent.connect>>;
	let api: InstanceType<typeof ApiClient>;
	let scenario: string;

	beforeAll(async () => {
		// 等待的上界比用例里持锁的时间长得多：用例里清理总是在上界之前提交。
		cp = await startTestControlPlane({ purgeWaitMs: 20_000 });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 16 });
		api = new ApiClient(cp);
		scenario = await api.orchestrationWith(DOC);
	}, 60_000);
	afterAll(async () => {
		await agent?.disconnect();
		await cp?.close();
	});

	/** 一个运行里的一个任务（一直不结束），写了 `lines` 行日志。 */
	const newRun = async (lines = 3) => {
		const runId = await api.triggerOk(scenario);
		const task = await agent.nextAssign();
		await writeRecordedLogs(cp, agent, task, lines);
		return { runId, task, dir: join(cp.dataDir, "logs", runId) };
	};

	it("清理删着目录、还没提交时：两种页、两种流、两种下载都按保留期清理回答，没有一条说文件有问题", async () => {
		const { runId, task, dir } = await newRun();
		const live = ((await (await cp.fetch(`/runs/${runId}/logs`)).json()) as { live_after: string })
			.live_after;
		const lock = await holdRunLock(cp.database.url, runId);
		rmSync(dir, { recursive: true, force: true });

		// 六条路同时读；认出文件的问题之后它们都要等清理提交，所以现在一条也不会完成。
		const taskPage = cp.fetch(`/tasks/${task.taskId}/logs`).then((r) => r.json());
		const runPage = cp.fetch(`/runs/${runId}/logs`).then((r) => r.json());
		const taskDownload = cp.fetch(`/tasks/${task.taskId}/logs/download`);
		const runDownload = cp.fetch(`/runs/${runId}/logs/download`);
		const taskStream = SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
		const runStream = await SseClient.open(
			cp,
			`/runs/${runId}/logs/events?after=${encodeURIComponent(live)}`,
		);
		try {
			expect(await settledWithin(taskPage, 500)).toBe(false);
			expect(await settledWithin(runPage, 0)).toBe(false);
			expect(await settledWithin(taskDownload, 0)).toBe(false);
			expect(await settledWithin(runDownload, 0)).toBe(false);
			expect(await settledWithin(taskStream, 0)).toBe(false);

			await lock.finish(); // 清理：写 `purged_at`、提交
		} catch (error) {
			await lock.abort().catch(() => {});
			throw error;
		}

		const tPage = logsApi.page.response.parse(await taskPage);
		expect(tPage).toMatchObject({ expired: true, file_problem: null });
		const rPage = logsApi.runPage.response.parse(await runPage);
		expect(rPage).toMatchObject({ expired: true, file_problems: [], file_problems_total: 0 });
		for (const res of [await taskDownload, await runDownload]) {
			const body = (await res.json()) as {
				error: { code: string; message: string; details?: unknown };
			};
			expect(res.status).toBe(410);
			expect(body.error.code).toBe("expired");
			expect(body.error.message).toBe(PURGED);
			expect(body.error.details).toBeUndefined();
		}
		const tStream = await taskStream;
		const runStreamEvents = await eventsAfter(runStream, 800);
		try {
			expect(await eventsAfter(tStream, 300)).not.toContain("file_problem");
			expect(runStreamEvents).not.toContain("file_problems");
		} finally {
			tStream.close();
			runStream.close();
		}
	}, 60_000);

	it("很多请求同时在等清理：同一个运行共用一次核对，只占一个数据库连接，别的请求不受影响（连接池只有 10 个）", async () => {
		const { runId, task, dir } = await newRun();
		const other = await newRun();
		const lock = await holdRunLock(cp.database.url, runId);
		rmSync(dir, { recursive: true, force: true });
		try {
			// 30 个读这个运行日志的请求都认出了文件的问题、都在等；每个各占一个连接的话，连接池（10）早就满了。
			const waiting = Array.from({ length: 30 }, () =>
				cp.fetch(`/tasks/${task.taskId}/logs`).then((r) => r.json()),
			);
			await sleep(600);
			const started = Date.now();

			const page = await (await cp.fetch(`/tasks/${other.task.taskId}/logs`)).json();
			const view = await cp.fetch(`/runs/${other.runId}`);

			expect(Date.now() - started).toBeLessThan(2_000);
			expect(logsApi.page.response.parse(page).file_problem).toBeNull();
			expect(view.status).toBe(200);
			await lock.finish();
			for (const body of await Promise.all(waiting)) {
				expect(logsApi.page.response.parse(body)).toMatchObject({
					expired: true,
					file_problem: null,
				});
			}
		} catch (error) {
			await lock.abort().catch(() => {});
			throw error;
		}
	}, 60_000);

	it("没有问题的请求不等：清理持着运行行的锁时，文件都在的页立刻回来（只有认出问题之后才会去等）", async () => {
		const { runId, task } = await newRun();
		const lock = await holdRunLock(cp.database.url, runId);
		try {
			const started = Date.now();
			const taskPage = logsApi.page.response.parse(
				await (await cp.fetch(`/tasks/${task.taskId}/logs`)).json(),
			);
			const runPage = logsApi.runPage.response.parse(
				await (await cp.fetch(`/runs/${runId}/logs`)).json(),
			);

			expect(Date.now() - started).toBeLessThan(2_000);
			expect(taskPage).toMatchObject({ expired: false, file_problem: null });
			expect(runPage).toMatchObject({ expired: false, file_problems: [] });
		} finally {
			await lock.abort();
		}
	}, 60_000);

	it("清理出错回滚、没有写上 purged_at：文件真的不在了，照常说文件的问题（不是 expired）", async () => {
		const { runId, task, dir } = await newRun();
		const lock = await holdRunLock(cp.database.url, runId);
		rmSync(dir, { recursive: true, force: true });
		const taskPage = cp.fetch(`/tasks/${task.taskId}/logs`).then((r) => r.json());
		expect(await settledWithin(taskPage, 400)).toBe(false);

		await lock.abort(); // 回滚：purged_at 还是空的

		const page = logsApi.page.response.parse(await taskPage);
		expect(page).toMatchObject({ expired: false, file_problem: "missing" });
	}, 60_000);
});

describe("等保留期清理提交的上界（#734）", () => {
	const WAIT_MS = 500;
	let cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	let agent: Awaited<ReturnType<typeof FakeAgent.connect>>;
	let api: InstanceType<typeof ApiClient>;
	let scenario: string;

	beforeAll(async () => {
		cp = await startTestControlPlane({ purgeWaitMs: WAIT_MS });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 16 });
		api = new ApiClient(cp);
		scenario = await api.orchestrationWith(DOC);
	}, 60_000);
	afterAll(async () => {
		await agent?.disconnect();
		await cp?.close();
	});

	it("锁一直不放：认出问题的请求最多等上界，然后按「正在清理」回 expired（六条路都在上界之内回来）", async () => {
		const runId = await api.triggerOk(scenario);
		const task = await agent.nextAssign();
		await writeRecordedLogs(cp, agent, task, 1);
		const live = ((await (await cp.fetch(`/runs/${runId}/logs`)).json()) as { live_after: string })
			.live_after;
		const lock = await holdRunLock(cp.database.url, runId);
		rmSync(join(cp.dataDir, "logs", runId), { recursive: true, force: true });
		try {
			const timed = async <T>(work: Promise<T>) => {
				const started = Date.now();
				const value = await work;
				return { value, ms: Date.now() - started };
			};
			const results = await Promise.all([
				timed(cp.fetch(`/tasks/${task.taskId}/logs`).then((r) => r.json())),
				timed(cp.fetch(`/runs/${runId}/logs`).then((r) => r.json())),
				timed(cp.fetch(`/tasks/${task.taskId}/logs/download`).then((r) => r.json())),
				timed(cp.fetch(`/runs/${runId}/logs/download`).then((r) => r.json())),
			]);
			const [taskPage, runPage, taskDownload, runDownload] = results;

			// 等了上界（没有提早回来）、也没有一直等下去。
			for (const { ms } of results) {
				expect(ms).toBeGreaterThanOrEqual(WAIT_MS - 100);
				expect(ms).toBeLessThan(WAIT_MS + 3_000);
			}
			expect(taskPage.value).toMatchObject({ expired: true, file_problem: null });
			expect(runPage.value).toMatchObject({ expired: true, file_problems: [] });
			for (const { value } of [taskDownload, runDownload]) {
				expect((value as { error: { message: string } }).error.message).toBe(PURGED);
			}
			// 两种流：连上之后不发文件问题的事件（任务流的核对在连上之前，等了上界才连上；运行流的在连上之后）。
			const started = Date.now();
			const taskStream = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
			const runStream = await SseClient.open(
				cp,
				`/runs/${runId}/logs/events?after=${encodeURIComponent(live)}`,
			);
			try {
				expect(Date.now() - started).toBeLessThan(WAIT_MS + 3_000);
				expect(await eventsAfter(runStream, WAIT_MS + 800)).not.toContain("file_problems");
				expect(taskStream.received.map((e) => e.event)).not.toContain("file_problem");
			} finally {
				taskStream.close();
				runStream.close();
			}
		} finally {
			await lock.abort();
		}
	}, 60_000);
});
