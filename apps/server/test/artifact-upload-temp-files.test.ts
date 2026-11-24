// 上传被拒绝或出错之后不留临时文件，启动时清掉上次留下的（#649）。
//
// 以前：上传的临时文件（`.upload-<uuid>`）出错时在写入流真正把文件建出来之前就删了（`createWriteStream` 的 open 是异步的，
// 流被销毁时它可能还在路上），删了个不存在的文件，之后 open 完成、文件才出现：留下一个零字节的临时文件。分块上传第一块就
// 超限时最常见（顺序上传 11 次超限的，留下 11 个）。现在出错时先等写入流关闭、再删。
//
// 「写入流还没建出文件」靠把 `createWriteStream` 的 open 换成慢的（`fs` 选项）做出来：open 要 150 毫秒，请求体的出错在几毫秒之内，
// 删除一定先于 open 完成，不靠碰运气。自然的写法（不换 open、顺序传 11 次超限的）另有一条。
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** `createWriteStream` 的 open 要多久（毫秒）；0 是不变慢。只对上传的临时文件（`.upload-`）起作用。 */
const slowOpen = vi.hoisted(() => ({ ms: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const createWriteStream = (path: string, options?: unknown) => {
		if (slowOpen.ms === 0 || !String(path).includes(".upload-")) {
			return actual.createWriteStream(path, options as never);
		}
		return actual.createWriteStream(path, {
			...(options as object),
			fs: {
				open: (
					file: string,
					flags: string,
					mode: number,
					callback: (error: NodeJS.ErrnoException | null, fd: number) => void,
				) => setTimeout(() => actual.open(file, flags, mode, callback), slowOpen.ms),
				close: actual.close,
				write: actual.write,
				writev: actual.writev,
			},
		} as never);
	};
	return { ...actual, default: { ...actual, createWriteStream }, createWriteStream };
});

const { ArtifactStore } = await import("../src/artifacts/artifact-store.js");
const { openDatabase } = await import("../src/db/database.js");
const { ApiClient } = await import("./support/api-client.js");
const { FakeAgent } = await import("./support/fake-agent.js");
const { publishPackage } = await import("./support/package-archive.js");
const { startTestControlPlane } = await import("./support/test-control-plane.js");

const LIMIT = 1000;
const OPEN_MS = 150;
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
/** 一个真的产物，名字长得像临时文件：它不是临时文件，不能被当成「留下的」，启动时清理也不能动它。 */
const LOOKALIKE = `.upload-${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;

type Setup = {
	cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	agent: Awaited<ReturnType<typeof FakeAgent.connect>>;
	database: ReturnType<typeof openDatabase>;
	taskId: string;
};

describe("上传被拒绝或出错之后不留临时文件", () => {
	let cp: Setup["cp"];
	let agent: Setup["agent"];
	let database: Setup["database"];
	let taskId: string;

	beforeAll(async () => {
		cp = await startTestControlPlane({ artifactLimitBytes: LIMIT });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
		const api = new ApiClient(cp);
		await api.triggerOk(await api.orchestrationWith(DOC));
		taskId = (await agent.nextAssign()).taskId;
		database = openDatabase(cp.database.url, () => {});
	}, 60_000);
	afterAll(async () => {
		slowOpen.ms = 0;
		await database?.close();
		await agent?.disconnect();
		await cp?.close();
	});
	afterEach(() => {
		slowOpen.ms = 0;
	});
	// 每条用例只看自己留下的：先把上一条留下的（它红的时候）清掉。
	beforeEach(async () => {
		for (const path of await leftovers()) await rm(join(cp.dataDir, path), { force: true });
	});

	const storeWith = (uploadIdleMs?: number) =>
		new ArtifactStore({
			db: database.db,
			clock: cp.clock,
			dataDir: cp.dataDir,
			limitBytes: LIMIT,
			...(uploadIdleMs === undefined ? {} : { uploadIdleMs }),
		});

	/** 数据目录里（任何一层）名字以 `.upload-` 开头的文件（不算那个名字长得像临时文件的真产物）。 */
	const leftovers = async () =>
		(await readdir(cp.dataDir, { recursive: true })).filter((path) => {
			const name = path.split("/").pop() ?? "";
			return name.startsWith(".upload-") && name !== LOOKALIKE;
		});

	it("顺序上传 11 次，每次分块、第一块就超限：一个临时文件也不留（不换慢的 open）", async () => {
		const store = storeWith();

		for (let i = 0; i < 11; i++) {
			const outcome = await store.save(taskId, `big-${i}.bin`, Readable.from([Buffer.alloc(2_000)]));
			expect(outcome).toMatchObject({ ok: false, status: 413, code: "artifact_too_large" });
		}
		await sleep(300);

		expect(await leftovers()).toEqual([]);
	}, 60_000);

	describe(`写入流还没把文件建出来（open 要 ${OPEN_MS} 毫秒）时出错`, () => {
		/** 每一种拒绝或出错：怎么做出来、期望的结果（`"throws"` 是请求体自己的错误原样抛出，由路由变成 500 或断开）。 */
		const cases: Array<
			[
				label: string,
				run: (store: InstanceType<typeof ArtifactStore>) => Promise<unknown>,
				expected: { status: number; code: string } | "throws",
				idleMs?: number,
			]
		> = [
			[
				"第一块就超限（分块，没有声明长度）",
				(store) => store.save(taskId, "a.bin", Readable.from([Buffer.alloc(2_000)])),
				{ status: 413, code: "artifact_too_large" },
			],
			[
				"超限发生在第二块",
				(store) =>
					store.save(taskId, "b.bin", Readable.from([Buffer.alloc(600), Buffer.alloc(600)])),
				{ status: 413, code: "artifact_too_large" },
			],
			[
				"请求体中途断开（发了一块，然后出错）",
				(store) => {
					const body = new PassThrough();
					body.write(Buffer.alloc(100, 1));
					setTimeout(() => body.destroy(new Error("aborted")), 20);
					return store.save(taskId, "c.bin", body);
				},
				"throws",
			],
			[
				"一个字节也没发，到了空闲时限",
				(store) => store.save(taskId, "d.bin", new PassThrough()),
				{ status: 408, code: "upload_idle_timeout" },
				30,
			],
			[
				"发了一块之后不再发，到了空闲时限",
				(store) => {
					const body = new PassThrough();
					body.write(Buffer.alloc(10, 1));
					return store.save(taskId, "e.bin", body);
				},
				{ status: 408, code: "upload_idle_timeout" },
				30,
			],
			[
				"请求体不是字节流（字符串块）",
				(store) => store.save(taskId, "f.bin", Readable.from(["not bytes"])),
				"throws",
			],
		];

		it.each(cases)("%s：不留临时文件", async (_label, run, expected, idleMs) => {
			slowOpen.ms = OPEN_MS;
			const store = storeWith(idleMs);

			const outcome = await run(store).then(
				(value) => value,
				(error: unknown) => (expected === "throws" ? "throws" : error),
			);

			if (expected === "throws") expect(outcome).toBe("throws");
			else expect(outcome).toMatchObject({ ok: false, ...expected });
			// 出错时删除临时文件的那一步要等写入流关闭：这里等得比 open 久，文件要是晚一点才建出来就看得到。
			await sleep(OPEN_MS * 3);
			expect(await leftovers()).toEqual([]);
		}, 60_000);

		it("名字和别的产物的目录冲突（400）：请求体收完了，改名那一步出错，也不留", async () => {
			slowOpen.ms = OPEN_MS;
			const store = storeWith();
			expect((await store.save(taskId, "conflict", Readable.from([Buffer.alloc(10)]))).ok).toBe(
				true,
			);

			const outcome = await store.save(
				taskId,
				"conflict/inner.bin",
				Readable.from([Buffer.alloc(10)]),
			);

			expect(outcome).toMatchObject({ ok: false, status: 400, code: "invalid_artifact_name" });
			await sleep(OPEN_MS * 3);
			expect(await leftovers()).toEqual([]);
		}, 60_000);

		it("成功的上传：照常存下，临时文件改名成了产物，不留", async () => {
			slowOpen.ms = OPEN_MS;
			const store = storeWith();

			const outcome = await store.save(taskId, "ok.bin", Readable.from([Buffer.alloc(300, 7)]));

			expect(outcome).toMatchObject({ ok: true, artifact: { name: "ok.bin", size: 300 } });
			await sleep(OPEN_MS * 3);
			expect(await leftovers()).toEqual([]);
		}, 60_000);
	});

	it("任务已经结束（409）：不读请求体，也没有临时文件", async () => {
		slowOpen.ms = OPEN_MS;
		const store = storeWith();
		await database.pool.query("update tasks set status = 'success' where id = $1", [taskId]);
		try {
			const outcome = await store.save(taskId, "late.bin", Readable.from([Buffer.alloc(10)]));

			expect(outcome).toMatchObject({ ok: false, status: 409, code: "task_not_running" });
			await sleep(OPEN_MS * 3);
			expect(await leftovers()).toEqual([]);
		} finally {
			await database.pool.query("update tasks set status = 'running' where id = $1", [taskId]);
		}
	}, 60_000);

	describe("启动时清掉上次留下的临时文件", () => {
		beforeEach(async () => {
			await agent.disconnect();
		});

		it("上次进程被杀留下的临时文件，下一次启动清掉；已存下的产物（包括名字长得像临时文件的）不动", async () => {
			const store = storeWith();
			const lookalike = LOOKALIKE;
			expect((await store.save(taskId, "real.bin", Readable.from([Buffer.alloc(40, 5)]))).ok).toBe(
				true,
			);
			expect(
				(await store.save(taskId, lookalike, Readable.from([Buffer.alloc(30, 6)]))).ok,
			).toBe(true);
			// 上次进程留下的：被杀、断电时来不及删。（放在临时文件现在所在的目录。）
			const dir = join(cp.dataDir, "artifacts", ".uploading");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, ".upload-11111111-1111-4111-8111-111111111111"), "");
			await writeFile(join(dir, ".upload-22222222-2222-4222-8222-222222222222"), "partial bytes");

			await cp.restart();

			expect((await readdir(join(cp.dataDir, "artifacts"))).includes(".uploading")).toBe(false);
			const real = await cp.fetch(`/tasks/${taskId}/artifacts/real.bin`);
			expect(real.status).toBe(200);
			expect((await real.arrayBuffer()).byteLength).toBe(40);
			const same = await cp.fetch(`/tasks/${taskId}/artifacts/${lookalike}`);
			expect(same.status).toBe(200);
			expect((await same.arrayBuffer()).byteLength).toBe(30);
		}, 60_000);

		it("没有临时目录（第一次启动、或者已经清干净了）：启动照常", async () => {
			await cp.restart();

			expect((await cp.fetch(`/tasks/${taskId}/artifacts`)).status).toBe(200);
			expect(await leftovers()).toEqual([]);
		}, 60_000);
	});
});
