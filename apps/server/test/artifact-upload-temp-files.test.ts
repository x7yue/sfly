// 上传被拒绝或出错之后不留临时文件，启动时清掉上次留下的（#649）。
//
// 以前：上传的临时文件（`.upload-<uuid>`）出错时在写入流真正把文件建出来之前就删了（`createWriteStream` 的 open 是异步的，
// 流被销毁时它可能还在路上），删了个不存在的文件，之后 open 完成、文件才出现：留下一个零字节的临时文件。分块上传第一块就
// 超限时最常见（顺序上传 11 次超限的，留下 11 个）。现在出错时先等写入流关闭、再删。
//
// 「写入流还没建出文件」靠把 `createWriteStream` 的 open 换成慢的（`fs` 选项）做出来：open 要 150 毫秒，请求体的出错在几毫秒之内，
// 删除一定先于 open 完成，不靠碰运气。自然的写法（不换 open、顺序传 11 次超限的）另有一条。
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
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

const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
const canConnect = (port: number) =>
	new Promise<boolean>((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});

/**
 * 用 HTTP PUT 传一个产物（分块）；`abortAfterMs` 给了就是发完第一块之后过这么久客户端自己断开（返回 `"aborted"`）。
 */
function put(
	url: string,
	chunks: Buffer[],
	options: { abortAfterMs?: number } = {},
): Promise<{ status: number; body: string } | "aborted"> {
	return new Promise((resolve) => {
		const req = httpRequest(
			url,
			{ method: "PUT", headers: { "transfer-encoding": "chunked" } },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("error", () => {});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", () => resolve("aborted"));
		if (options.abortAfterMs !== undefined) {
			req.write(chunks[0]);
			setTimeout(() => {
				req.destroy();
				resolve("aborted");
			}, options.abortAfterMs);
			return;
		}
		for (const chunk of chunks) req.write(chunk);
		req.end();
	});
}

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
	let taskId2: string;

	beforeAll(async () => {
		cp = await startTestControlPlane({ artifactLimitBytes: LIMIT });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
		const api = new ApiClient(cp);
		const scenario = await api.orchestrationWith(DOC);
		await api.triggerOk(scenario);
		taskId = (await agent.nextAssign()).taskId;
		await api.triggerOk(scenario);
		taskId2 = (await agent.nextAssign()).taskId;
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
			const outcome = await store.save(
				taskId,
				`big-${i}.bin`,
				Readable.from([Buffer.alloc(2_000)]),
			);
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

		it.each(cases)(
			"%s：不留临时文件",
			async (_label, run, expected, idleMs) => {
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
			},
			60_000,
		);

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

	it("上传进行中：临时文件在 artifacts/.uploading/ 里，不在任务的产物目录里；传完改名成产物，临时文件没了", async () => {
		const store = storeWith();
		const body = new PassThrough();
		body.write(Buffer.alloc(10, 1));

		const saving = store.save(taskId, "inflight.bin", body);
		let paths: string[] = [];
		for (let i = 0; i < 150 && paths.length === 0; i++) {
			await sleep(20);
			paths = await leftovers();
		}

		expect(paths.map((path) => path.split("/").slice(0, -1).join("/"))).toEqual([
			"artifacts/.uploading",
		]);
		body.end();
		expect(await saving).toMatchObject({ ok: true, artifact: { name: "inflight.bin", size: 10 } });
		expect(await leftovers()).toEqual([]);
	}, 60_000);

	it("HTTP 客户端中途取消（分块、open 要 150 毫秒）：不留临时文件，同一个任务的下一份照常 201（审查的 P1）", async () => {
		slowOpen.ms = OPEN_MS;
		const url = (name: string) => `${cp.httpUrl}/tasks/${taskId}/artifacts/${name}`;

		const aborted = await put(url("abort.bin"), [Buffer.alloc(100, 1)], { abortAfterMs: 20 });
		await sleep(OPEN_MS * 3);

		expect(aborted).toBe("aborted");
		expect(await leftovers()).toEqual([]);
		expect(await put(url("after-abort.bin"), [Buffer.alloc(10, 2)])).toMatchObject({
			status: 201,
		});
		await sleep(OPEN_MS * 3);
		expect(await leftovers()).toEqual([]);
	}, 60_000);

	it("两个任务同时上传同名产物（分块交错到达）：各自的内容和哈希都对（临时文件名不能固定）", async () => {
		const store = storeWith();
		const body = (byte: number) => {
			const stream = new PassThrough();
			let sent = 0;
			const tick = () => {
				if (sent === 3) return void stream.end();
				sent += 1;
				stream.write(Buffer.alloc(100, byte));
				setTimeout(tick, 30);
			};
			tick();
			return stream;
		};

		const [first, second] = await Promise.all([
			store.save(taskId, "same-name.bin", body(1)),
			store.save(taskId2, "same-name.bin", body(2)),
		]);

		for (const [outcome, byte] of [
			[first, 1],
			[second, 2],
		] as const) {
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) continue;
			const bytes = await readFile(outcome.artifact.file);
			expect(bytes.equals(Buffer.alloc(300, byte))).toBe(true);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(outcome.artifact.sha256);
		}
		expect(await leftovers()).toEqual([]);
	}, 60_000);

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
			expect((await store.save(taskId, lookalike, Readable.from([Buffer.alloc(30, 6)]))).ok).toBe(
				true,
			);
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

		it("临时目录的位置上是个文件（读不了）：启动时照样把这个路径删掉，启动照常，之后的上传成功（不是每次 500）", async () => {
			const place = join(cp.dataDir, "artifacts", ".uploading");
			await rm(place, { recursive: true, force: true });
			await mkdir(join(cp.dataDir, "artifacts"), { recursive: true });
			await writeFile(place, "不是目录");

			await cp.restart();

			expect((await cp.fetch(`/tasks/${taskId}/artifacts`)).status).toBe(200);
			expect(await exists(place)).toBe(false);
			const uploaded = await put(`${cp.httpUrl}/tasks/${taskId}/artifacts/after-file.bin`, [
				Buffer.alloc(10, 2),
			]);
			expect(uploaded).toMatchObject({ status: 201 });
			expect(await leftovers()).toEqual([]);
		}, 60_000);

		it("sweepUploadTemp：这个位置上是个文件时返回 0、把它删掉", async () => {
			const place = join(cp.dataDir, "artifacts", ".uploading");
			await rm(place, { recursive: true, force: true });
			await writeFile(place, "不是目录");

			await expect(storeWith().sweepUploadTemp()).resolves.toBe(0);

			expect(await exists(place)).toBe(false);
		}, 60_000);

		it("清理：临时目录里有指向外面的目录、文件的符号链接，只删链接本身，外面的东西不动（审查的 P9）", async () => {
			const outside = join(cp.dataDir, "..", `outside-${process.pid}-${Date.now()}`);
			await mkdir(join(outside, "sub"), { recursive: true });
			await writeFile(join(outside, "keep.txt"), "keep");
			await writeFile(join(outside, "sub", "deep.txt"), "deep");
			const dir = join(cp.dataDir, "artifacts", ".uploading");
			await mkdir(dir, { recursive: true });
			await symlink(outside, join(dir, ".upload-link-dir"));
			await symlink(join(outside, "keep.txt"), join(dir, ".upload-link-file"));
			try {
				const swept = await storeWith().sweepUploadTemp();

				expect(swept).toBe(2);
				expect(await exists(dir)).toBe(false);
				expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
				expect(await readFile(join(outside, "sub", "deep.txt"), "utf8")).toBe("deep");
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		}, 60_000);

		it("清理在开始监听之前做：清理的那一刻 HTTP 端口还连不上（这时没有上传在做，清理不会碰到正在写的临时文件）（审查的 P10）", async () => {
			const original = ArtifactStore.prototype.sweepUploadTemp;
			const listening: boolean[] = [];
			const port = Number(new URL(cp.httpUrl).port);
			ArtifactStore.prototype.sweepUploadTemp = async function (
				this: InstanceType<typeof ArtifactStore>,
			) {
				listening.push(await canConnect(port));
				return original.call(this);
			};
			try {
				await cp.restart();
			} finally {
				ArtifactStore.prototype.sweepUploadTemp = original;
			}

			expect(listening).toEqual([false]);
		}, 60_000);

		it("控制面关闭时正在进行的上传（open 要 150 毫秒、客户端发了一块就停）：关闭之后不留临时文件，重启后上传照常（审查的 P12）", async () => {
			slowOpen.ms = OPEN_MS;
			const url = (name: string) => `${cp.httpUrl}/tasks/${taskId}/artifacts/${name}`;
			const pending = put(url("during-close.bin"), [Buffer.alloc(10, 1)], { abortAfterMs: 1_500 });
			await sleep(300);

			await cp.restart();
			await pending;

			expect(await leftovers()).toEqual([]);
			slowOpen.ms = 0;
			expect(await put(url("after-close.bin"), [Buffer.alloc(10, 2)])).toMatchObject({
				status: 201,
			});
		}, 90_000);

		it("sweepUploadTemp：目录不存在时返回 0、不抛错；有几个就清掉几个、返回个数，目录也没了", async () => {
			const dir = join(cp.dataDir, "artifacts", ".uploading");
			await rm(dir, { recursive: true, force: true });
			const store = storeWith();

			await expect(store.sweepUploadTemp()).resolves.toBe(0);

			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, ".upload-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "");
			await writeFile(join(dir, ".upload-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "x");
			await expect(store.sweepUploadTemp()).resolves.toBe(2);
			expect((await readdir(join(cp.dataDir, "artifacts"))).includes(".uploading")).toBe(false);
		}, 60_000);

		it("没有临时目录（第一次启动、或者已经清干净了）：启动照常", async () => {
			await cp.restart();

			expect((await cp.fetch(`/tasks/${taskId}/artifacts`)).status).toBe(200);
			expect(await leftovers()).toEqual([]);
		}, 60_000);
	});
});
