// 上传进行中，这个运行被保留期清理（#649 的审查，P13）：文件和产物的行都不能留下。
//
// 上传的最后一步（改名成产物、记账）和保留期清理（删文件、删产物行、标记已清理）都在运行这一行的锁下做：上传 `FOR KEY SHARE`、
// 清理 `FOR UPDATE`，两边不会交错。没有这把锁时：运行目录被清理之后上传才改名，文件落进已经清理过的运行目录、库里多一行，
// 之后没有人再删（清理只扫还没标记的运行）。
// 几个次序靠把 `rename`（上传）和 `rm`（清理）换成会停住的钩子做出来，次序是确定的：
// - 清理拿着锁、`rm` 停住时上传到了：上传等清理提交，之后读到「已清理」，409，不改名也不记账；
// - 上传拿着锁、改名停住时清理来了：清理等上传提交，之后连它存下的文件和行一起删；
// - 改名之后记账失败（数据库里的触发器让插入报错）：已经改名过去的文件删掉，没有行的文件不留。
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** 会停住的钩子：`path` 是要停的路径；到了就调 `reached`，等 `release` 才放行。 */
const hooks = vi.hoisted(() => ({
	/** 上传：临时文件改名时停住。 */
	rename: undefined as { reached: () => void; release: Promise<void> } | undefined,
	/** 保留期清理：删这个路径（运行的产物目录）时停住。 */
	rm: undefined as { path: string; reached: () => void; release: Promise<void> } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const rename = async (from: string, to: string) => {
		const hook = hooks.rename;
		if (hook && String(from).includes(".upload-")) {
			hooks.rename = undefined;
			hook.reached();
			await hook.release;
		}
		return actual.rename(from, to);
	};
	const rm = async (path: string, options?: Parameters<typeof actual.rm>[1]) => {
		const hook = hooks.rm;
		if (hook && String(path) === hook.path) {
			hooks.rm = undefined;
			hook.reached();
			await hook.release;
		}
		return actual.rm(path, options);
	};
	return { ...actual, default: { ...actual, rename, rm }, rename, rm };
});

const { ArtifactStore } = await import("../src/artifacts/artifact-store.js");
const { openDatabase } = await import("../src/db/database.js");
const { Retention } = await import("../src/retention/retention.js");
const { ApiClient } = await import("./support/api-client.js");
const { FakeAgent } = await import("./support/fake-agent.js");
const { publishPackage } = await import("./support/package-archive.js");
const { startTestControlPlane } = await import("./support/test-control-plane.js");

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
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
/** 一个 promise 和让它完成的函数。 */
const latch = () => {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
};

describe("上传进行中运行被保留期清理", () => {
	let cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	let agent: Awaited<ReturnType<typeof FakeAgent.connect>>;
	let database: ReturnType<typeof openDatabase>;
	const runs: Array<{ runId: string; taskId: string }> = [];
	let nextRun = 0;

	beforeAll(async () => {
		// 控制面自己的清理很久才扫一次（保留期 100 年）：这里的清理只由用例自己调。
		cp = await startTestControlPlane({ artifactLimitBytes: LIMIT, retentionDays: 36_500 });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 8 });
		const api = new ApiClient(cp);
		const scenario = await api.orchestrationWith(DOC);
		for (let i = 0; i < 6; i++) {
			const runId = await api.triggerOk(scenario);
			runs.push({ runId, taskId: (await agent.nextAssign()).taskId });
		}
		database = openDatabase(cp.database.url, () => {});
	}, 90_000);
	afterAll(async () => {
		hooks.rename = undefined;
		hooks.rm = undefined;
		await database?.close();
		await agent?.disconnect();
		await cp?.close();
	});
	afterEach(() => {
		hooks.rename = undefined;
		hooks.rm = undefined;
	});

	/** 每条用例用一个自己的运行（清理了就不能再用）。 */
	const freshRun = () => {
		const run = runs[nextRun++];
		if (!run) throw new Error("没有可用的运行了");
		return run;
	};
	const storeWith = () =>
		new ArtifactStore({
			db: database.db,
			clock: cp.clock,
			dataDir: cp.dataDir,
			limitBytes: LIMIT,
		});
	/** 一个按默认保留期（30 天）清理的实例：把运行的结束时间改到很久以前，它就会清理这个运行。 */
	const retention = () => new Retention({ db: database.db, clock: cp.clock, dataDir: cp.dataDir });
	const markDue = (runId: string) =>
		database.pool.query("update runs set ended_at = '2000-01-01' where id = $1", [runId]);
	const rowsOf = async (taskId: string) =>
		(
			await database.pool.query("select count(*)::int as n from artifacts where task_id = $1", [
				taskId,
			])
		).rows[0].n as number;
	const leftovers = async () =>
		(await readdir(cp.dataDir, { recursive: true })).filter((path) =>
			(path.split("/").pop() ?? "").startsWith(".upload-"),
		);
	const settled = <T>(promise: Promise<T>) =>
		Promise.race([promise.then(() => "done" as const), sleep(400).then(() => "pending" as const)]);

	it("上传进行中（请求体还没传完）运行被清理：传完之后 409，运行目录里没有文件，库里没有行，没有临时文件（审查的 P13）", async () => {
		const { runId, taskId } = freshRun();
		const store = storeWith();
		const body = new PassThrough();
		body.write(Buffer.alloc(10, 1));
		const saving = store.save(taskId, "during-purge.bin", body);
		await sleep(200);
		await markDue(runId);

		expect(await retention().sweep()).toBe(1);
		body.end(Buffer.alloc(10, 2));
		const outcome = await saving;

		expect(outcome).toMatchObject({ ok: false, status: 409, code: "task_not_running" });
		expect(await exists(join(cp.dataDir, "artifacts", runId))).toBe(false);
		expect(await rowsOf(taskId)).toBe(0);
		expect(await leftovers()).toEqual([]);
	}, 60_000);

	it("清理拿着锁、正在删文件时，一份已经传完的上传到了：它等清理提交，之后读到「已清理」：409，不改名、不记账", async () => {
		const { runId, taskId } = freshRun();
		const store = storeWith();
		await markDue(runId);
		const reached = latch();
		const release = latch();
		hooks.rm = {
			path: join(cp.dataDir, "artifacts", runId),
			reached: reached.open,
			release: release.opened,
		};
		const sweeping = retention().sweep();
		await reached.opened; // 清理已经在锁里、删产物目录的那一步停住了，还没有提交

		const saving = store.save(
			taskId,
			"late.bin",
			(() => {
				const body = new PassThrough();
				body.end(Buffer.alloc(10, 3));
				return body;
			})(),
		);

		// 上传的前半（写临时文件）做得完，最后一步要等清理提交：这时还没有结果。
		expect(await settled(saving)).toBe("pending");
		expect(await exists(join(cp.dataDir, "artifacts", runId))).toBe(false);
		release.open();
		await sweeping;
		const outcome = await saving;

		expect(outcome).toMatchObject({ ok: false, status: 409, code: "task_not_running" });
		expect(await exists(join(cp.dataDir, "artifacts", runId))).toBe(false);
		expect(await rowsOf(taskId)).toBe(0);
		expect(await leftovers()).toEqual([]);
		const [run] = (await database.pool.query("select purged_at from runs where id = $1", [runId]))
			.rows;
		expect(run.purged_at).not.toBeNull();
	}, 60_000);

	it("上传拿着锁、正在改名时清理来了：清理等上传提交，之后连它存下的文件和行一起删，不留", async () => {
		const { runId, taskId } = freshRun();
		const store = storeWith();
		const reached = latch();
		const release = latch();
		hooks.rename = { reached: reached.open, release: release.opened };
		const body = new PassThrough();
		body.end(Buffer.alloc(10, 4));
		const saving = store.save(taskId, "held.bin", body);
		await reached.opened; // 上传已经在锁里、改名这一步停住了
		await markDue(runId);

		const sweeping = retention().sweep();

		expect(await settled(sweeping)).toBe("pending"); // 清理等上传的锁
		release.open();
		const outcome = await saving;
		expect(await sweeping).toBe(1);

		expect(outcome).toMatchObject({ ok: true, artifact: { name: "held.bin", size: 10 } });
		expect(await exists(join(cp.dataDir, "artifacts", runId))).toBe(false);
		expect(await rowsOf(taskId)).toBe(0);
		expect(await leftovers()).toEqual([]);
	}, 60_000);

	describe("改名之后记账失败", () => {
		const TRIGGER = `
			create or replace function sfly_test_fail_artifact() returns trigger language plpgsql as $$
			begin
				if new.name like 'trigger-fails%' and new.size = 7 then
					raise exception 'boom' using errcode = 'XX001';
				end if;
				return new;
			end $$;
			drop trigger if exists sfly_test_fail_artifact on artifacts;
			create trigger sfly_test_fail_artifact before insert or update on artifacts
				for each row execute function sfly_test_fail_artifact();`;
		beforeAll(async () => {
			await database.pool.query(TRIGGER);
		});
		afterAll(async () => {
			await database.pool.query("drop trigger if exists sfly_test_fail_artifact on artifacts");
		});

		it("第一次上传这个名字：已经改名过去的文件删掉，没有行的文件不留；错误原样抛出，临时文件也没有", async () => {
			const { runId, taskId } = freshRun();
			const store = storeWith();
			const body = new PassThrough();
			body.end(Buffer.alloc(7, 5));

			const outcome = await store.save(taskId, "trigger-fails.bin", body).then(
				(value) => value,
				(error: Error & { code?: string }) => `throws ${error.code ?? error.message}`,
			);

			expect(String(outcome)).toContain("throws");
			expect(await exists(join(cp.dataDir, "artifacts", runId, taskId, "trigger-fails.bin"))).toBe(
				false,
			);
			expect(await rowsOf(taskId)).toBe(0);
			expect(await leftovers()).toEqual([]);
			expect(store.pendingTasks).toBe(0);
		}, 60_000);

		it("覆盖已有的产物时记账失败：不删文件（旧内容已经被换掉，删掉等于什么都没有），行还是旧的", async () => {
			const { runId, taskId } = freshRun();
			const store = storeWith();
			const first = new PassThrough();
			first.end(Buffer.alloc(5, 1));
			expect((await store.save(taskId, "trigger-fails-replace.bin", first)).ok).toBe(true);
			const second = new PassThrough();
			second.end(Buffer.alloc(7, 2));

			const outcome = await store.save(taskId, "trigger-fails-replace.bin", second).then(
				() => "ok",
				() => "throws",
			);

			expect(outcome).toBe("throws");
			expect(
				await exists(join(cp.dataDir, "artifacts", runId, taskId, "trigger-fails-replace.bin")),
			).toBe(true);
			expect(await rowsOf(taskId)).toBe(1);
			expect(await leftovers()).toEqual([]);
		}, 60_000);
	});
});
