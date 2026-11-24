// `ArtifactStore` 每个任务一条队列的几个性质（#588）：直接用 `ArtifactStore` 和能自己控制「什么时候发数据、什么时候发完」
// 的请求体（`PassThrough`），不经 HTTP。每条守的是互斥里一处具体的写法，换掉它这条就红：
// - 队列的条目用完就删（不删：每个上传过产物的任务在 Map 里留一个条目，长期运行的控制面上只增不减）；
// - 队列按任务分（全局一把锁：一个任务的上传卡着，别的任务的上传也被拖住）；
// - 任务状态是轮到时才查（到达时查：任务在排队期间成功或失败结束了，排着的那一份还是被收下）；
// - 空闲计时从轮到这一份时才开始（从到达时开始：排在后面的一份还没轮到就超时了）。
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore, type SaveOutcome } from "../src/artifacts/artifact-store.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { ApiClient } from "./support/api-client.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const LIMIT = 1000;
const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一份已经发完的请求体。 */
const complete = (size: number): PassThrough => {
	const body = new PassThrough();
	body.end(Buffer.alloc(size, 1));
	return body;
};

describe("ArtifactStore 的队列", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;
	let database: Database;
	let tasks: AssignedTask[];

	beforeEach(async () => {
		cp = await startTestControlPlane({ artifactLimitBytes: LIMIT });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 2 });
		const api = new ApiClient(cp);
		const scenario = await api.orchestrationWith(DOC);
		await api.triggerOk(scenario);
		await api.triggerOk(scenario);
		tasks = [await agent.nextAssign(), await agent.nextAssign()];
		database = openDatabase(cp.database.url, () => {});
	}, 60_000);
	afterEach(async () => {
		await database.close();
		await agent.disconnect();
		await cp.close();
	});

	const storeWith = (uploadIdleMs?: number) =>
		new ArtifactStore({
			db: database.db,
			clock: cp.clock,
			dataDir: cp.dataDir,
			limitBytes: LIMIT,
			...(uploadIdleMs === undefined ? {} : { uploadIdleMs }),
		});
	const [first, second] = [0, 1] as const;

	describe("队列的条目用完就删", () => {
		it("成功、被拒绝（413）、任务不存在（404）、请求体中途出错之后，排队的任务数都回到 0", async () => {
			const store = storeWith();
			const taskId = (i: 0 | 1) => (tasks[i] as AssignedTask).taskId;

			const ok = store.save(taskId(first), "ok.bin", complete(400));
			const tooLarge = store.save(taskId(first), "big.bin", complete(900));
			const missing = store.save("00000000-0000-4000-8000-000000000000", "x.bin", complete(1));
			expect(store.pendingTasks).toBeGreaterThanOrEqual(1);
			const broken = new PassThrough();
			const failing = store.save(taskId(second), "broken.bin", broken);
			broken.on("error", () => {}); // 还没轮到它读：先挂一个，不然这次 destroy 是没人接的 error 事件
			broken.write(Buffer.alloc(10, 1));
			broken.destroy(new Error("连接断了"));

			const outcomes = await Promise.all([ok, tooLarge, missing, failing.catch(() => "出错")]);

			expect((outcomes[0] as SaveOutcome).ok).toBe(true);
			expect(outcomes[1]).toMatchObject({ ok: false, status: 413 });
			expect(outcomes[2]).toMatchObject({ ok: false, status: 404 });
			expect(outcomes[3]).toBe("出错");
			expect(store.pendingTasks).toBe(0);
		}, 60_000);

		it("数据库出错（保存时抛出）之后也回到 0", async () => {
			const store = storeWith();
			const broken = openDatabase(cp.database.url, () => {});
			await broken.close(); // 连接池已经关了：查询任务时抛出
			const brokenStore = new ArtifactStore({
				db: broken.db,
				clock: cp.clock,
				dataDir: cp.dataDir,
				limitBytes: LIMIT,
			});

			await expect(
				brokenStore.save((tasks[first] as AssignedTask).taskId, "x.bin", complete(1)),
			).rejects.toThrow();

			expect(brokenStore.pendingTasks).toBe(0);
			expect(store.pendingTasks).toBe(0);
		}, 60_000);
	});

	describe("请求体只能是字节流（#665）", () => {
		// 上传的路由只按原始字节收请求体；存储自己也不接受字符串块：按字符数记的大小和写进磁盘的字节数不一致，守不住上限。
		it("有字符串块：抛出，不记账，队列的条目照样删掉，同一个任务的下一份照常存", async () => {
			const store = storeWith();
			const taskId = (tasks[first] as AssignedTask).taskId;

			await expect(store.save(taskId, "text.txt", Readable.from(["中文"]))).rejects.toThrow(
				"byte stream",
			);
			expect(store.pendingTasks).toBe(0);
			const next = await store.save(taskId, "ok.bin", complete(100));

			expect(next.ok).toBe(true);
			const listed = (await (await cp.fetch(`/tasks/${taskId}/artifacts`)).json()) as {
				artifacts: Array<{ name: string; size: number }>;
			};
			expect(listed.artifacts.map((a) => [a.name, a.size])).toEqual([["ok.bin", 100]]);
		});
	});

	it("队列按任务分：一个任务的上传卡着，另一个任务的上传不受影响", async () => {
		const store = storeWith();
		const stuck = new PassThrough();
		stuck.write(Buffer.alloc(10, 1)); // 发了一点就不再发，也不结束
		const holding = store.save((tasks[first] as AssignedTask).taskId, "stuck.bin", stuck);
		await sleep(200);

		// 另一个任务：马上就能做完（卡住的那一份没有放开，所以不是排在它后面）。
		const other = await Promise.race([
			store.save((tasks[second] as AssignedTask).taskId, "other.bin", complete(100)),
			sleep(3_000).then(() => "被拖住了" as const),
		]);

		expect(other).not.toBe("被拖住了");
		expect((other as SaveOutcome).ok).toBe(true);
		// 同一个任务的下一份是排在卡住的那份后面的。
		const queued = store.save((tasks[first] as AssignedTask).taskId, "queued.bin", complete(100));
		const queuedDone = await Promise.race([queued, sleep(500).then(() => "还在排着" as const)]);
		expect(queuedDone).toBe("还在排着");
		stuck.end();
		expect((await holding).ok).toBe(true);
		expect((await queued).ok).toBe(true);
		expect(store.pendingTasks).toBe(0);
	}, 60_000);

	describe("任务状态是轮到时才查", () => {
		const hold = async (store: ArtifactStore) => {
			const body = new PassThrough();
			body.write(Buffer.alloc(10, 1));
			const holding = store.save((tasks[first] as AssignedTask).taskId, "holding.bin", body);
			await sleep(200);
			return { body, holding };
		};
		const setStatus = (status: string) =>
			database.pool.query("update tasks set status = $1 where id = $2", [
				status,
				(tasks[first] as AssignedTask).taskId,
			]);

		it("排队期间任务成功结束：排着的那一份得到 409（和任务结束之后才到的上传一样），不存", async () => {
			const store = storeWith();
			const { body, holding } = await hold(store);
			const queued = store.save((tasks[first] as AssignedTask).taskId, "late.bin", complete(100));
			await sleep(100);
			await setStatus("success");

			body.end();

			expect((await holding).ok).toBe(true); // 轮到它的时候任务还在跑
			expect(await queued).toMatchObject({ ok: false, status: 409, code: "task_not_running" });
		}, 60_000);

		it("排队期间任务失败结束：同样 409", async () => {
			const store = storeWith();
			const { body, holding } = await hold(store);
			const queued = store.save((tasks[first] as AssignedTask).taskId, "late.bin", complete(100));
			await sleep(100);
			await setStatus("failed");

			body.end();

			await holding;
			expect(await queued).toMatchObject({ ok: false, status: 409 });
		}, 60_000);

		it("排队期间任务被取消（已经开始执行）：仍然收下，和改动之前一致（强制取消之后 Agent 才上传产物）", async () => {
			const store = storeWith();
			const { body, holding } = await hold(store);
			const queued = store.save((tasks[first] as AssignedTask).taskId, "late.bin", complete(100));
			await sleep(100);
			await database.pool.query(
				"update tasks set status = 'cancelled', started_at = now() where id = $1",
				[(tasks[first] as AssignedTask).taskId],
			);

			body.end();

			await holding;
			expect((await queued).ok).toBe(true);
		}, 60_000);
	});

	describe("空闲超时", () => {
		it("卡住的上传：到时限之后 408、不留临时文件、放开队列；排在后面的那一份从轮到它才开始计时", async () => {
			const store = storeWith(400);
			const taskId = (tasks[first] as AssignedTask).taskId;
			const stuck = new PassThrough();
			stuck.write(Buffer.alloc(10, 1));
			const startedAt = Date.now();
			const holding = store.save(taskId, "stuck.bin", stuck);
			// 排在后面的那一份：它的数据在卡住的那一份超时（400 毫秒）之后才开始来，在它自己的 400 毫秒时限里。
			// 要是它的计时从到达时就开始，这时（到达后 500 毫秒）早已超时。
			const late = new PassThrough();
			const queued = store.save(taskId, "late.bin", late);
			await sleep(500);
			late.write(Buffer.alloc(50, 2));
			late.end();

			const [stuckOutcome, queuedOutcome] = await Promise.all([holding, queued]);

			expect(stuckOutcome).toMatchObject({ ok: false, status: 408, code: "upload_idle_timeout" });
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
			expect(queuedOutcome.ok).toBe(true);
			expect(store.pendingTasks).toBe(0);
		}, 60_000);

		it("一直在慢慢发数据（每次间隔小于时限，总时长超过时限）：不被误杀", async () => {
			const store = storeWith(300);
			const body = new PassThrough();
			const result = store.save((tasks[first] as AssignedTask).taskId, "steady.bin", body);
			for (let i = 0; i < 8; i++) {
				body.write(Buffer.alloc(20, 1));
				await sleep(120);
			}
			body.end();

			expect((await result).ok).toBe(true);
		}, 60_000);
	});
});
