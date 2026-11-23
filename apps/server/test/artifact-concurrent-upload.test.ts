// 同一个任务并发上传产物（#588）：并发上传时存下来的合计不超过上限；每一份单独都放得下、合在一起超限时，超出的那一份得到和
// 顺序上传时同样的拒绝；中途断开的上传不占额度、也不占着别人的位置；卡住的上传（连着、不发数据）在空闲超时之后以明确的
// 错误结束、放开队列。
// 上传的请求体分两次发（先发一半、隔一会儿再发另一半），让并发的几份在时间上重叠。
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
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

interface PutResult {
	status: number;
	body: string;
}

/**
 * 慢慢上传：先发一半请求体，`gapMs` 毫秒之后再发另一半。`declare` 为真时带 Content-Length，否则分块传输（没有声明长度）。
 * 控制面可能在读完请求体之前就回了响应（声明的长度放不下时），之后再写的那一半可能写不出去：收到响应之后的错误不算。
 */
function slowPut(
	url: string,
	size: number,
	options: { declare: boolean; gapMs: number },
): Promise<PutResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const req = httpRequest(
			url,
			{
				method: "PUT",
				headers: {
					"content-type": "application/octet-stream",
					...(options.declare
						? { "content-length": String(size) }
						: { "transfer-encoding": "chunked" }),
				},
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("error", () => {});
				res.on("end", () => {
					settled = true;
					resolve({ status: res.statusCode ?? 0, body });
				});
			},
		);
		req.on("error", (error) => {
			if (!settled) reject(error);
		});
		const half = Math.floor(size / 2);
		req.write(Buffer.alloc(half, 1));
		setTimeout(() => req.end(Buffer.alloc(size - half, 2)), options.gapMs);
	});
}

describe("同一个任务并发上传产物", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;

	afterEach(async () => {
		await agent?.disconnect();
		await cp.close();
	});

	const setup = async (
		options: { artifactUploadIdleMs?: number } = {},
	): Promise<{ task: AssignedTask; runId: string }> => {
		cp = await startTestControlPlane({ artifactLimitBytes: LIMIT, ...options });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		return { task: await agent.nextAssign(), runId };
	};
	const urlOf = (task: AssignedTask, name: string) => `${task.artifactUploadUrl}${name}`;
	const stored = async (task: AssignedTask) => {
		const res = await cp.fetch(`/tasks/${task.taskId}/artifacts`);
		expect(res.status).toBe(200);
		const { artifacts } = (await res.json()) as {
			artifacts: Array<{ name: string; size: number }>;
		};
		return artifacts;
	};

	describe.each([
		["声明了长度（Content-Length）", true],
		["分块传输（没有声明长度）", false],
	])("请求体%s", (_, declare) => {
		it.each([
			// [并发的份数, 每份的字节数]：每一份单独放得下，合在一起超限。
			[3, 400],
			[8, 200],
			[2, 600],
		])(
			"%i 份、每份 %i 字节同时上传：存下来的合计不超过上限，超出的那几份被拒绝",
			async (count, size) => {
				const { task } = await setup();
				const fits = Math.floor(LIMIT / size);

				const results = await Promise.all(
					Array.from({ length: count }, (_, i) =>
						slowPut(urlOf(task, `f${i}.bin`), size, { declare, gapMs: 300 }),
					),
				);

				const created = results.filter((r) => r.status === 201);
				const rejected = results.filter((r) => r.status === 413);
				expect(created).toHaveLength(fits);
				expect(rejected).toHaveLength(count - fits);
				// 和顺序上传时同样的拒绝：错误码、还剩多少都对得上（被拒绝的那一份看到的是已经存下来的合计）。
				for (const r of rejected) {
					const { error } = JSON.parse(r.body) as { error: { code: string; message: string } };
					expect(error.code).toBe("artifact_too_large");
					expect(error.message).toContain(`已上传 ${fits * size} 字节`);
					expect(error.message).toContain(`上限 ${LIMIT} 字节`);
				}
				const artifacts = await stored(task);
				expect(artifacts).toHaveLength(fits);
				expect(artifacts.reduce((sum, a) => sum + a.size, 0)).toBe(fits * size);
				expect(artifacts.reduce((sum, a) => sum + a.size, 0)).toBeLessThanOrEqual(LIMIT);
			},
			60_000,
		);
	});

	it("同名文件并发覆盖：合计按覆盖之后算，最后存下来的是其中一份完整的内容", async () => {
		const { task } = await setup();

		const results = await Promise.all(
			[400, 500, 600].map((size) =>
				slowPut(urlOf(task, "same.bin"), size, { declare: true, gapMs: 200 }),
			),
		);

		expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
		const artifacts = await stored(task);
		expect(artifacts).toHaveLength(1);
		expect([400, 500, 600]).toContain(artifacts[0]?.size);
		// 库里记的大小和校验和要对得上磁盘上的内容：没有串行时会出现库里记的是一份、磁盘上留下的是另一份（见过 850 对 1050）。
		const downloaded = Buffer.from(
			await (await cp.fetch(`/tasks/${task.taskId}/artifacts/same.bin`)).arrayBuffer(),
		);
		const listed = (await (await cp.fetch(`/tasks/${task.taskId}/artifacts`)).json()) as {
			artifacts: Array<{ size: number; sha256: string }>;
		};
		expect(downloaded.length).toBe(listed.artifacts[0]?.size);
		expect(createHash("sha256").update(downloaded).digest("hex")).toBe(listed.artifacts[0]?.sha256);
	}, 60_000);

	// 写入之后的记账（INSERT 产物那一行）也在互斥里：让记账慢 0.3 秒，下一份的合计查询要是不等它，会看到还没记上的合计。
	// 把记账挪到互斥外面（写完文件就放开队列），这条会变红：3 份各 400 字节全部成功、合计 1200 超过上限。
	it("记账慢的时候也不超限：并发 3 份各 400 字节，两份成功、一份被拒绝，合计 800", async () => {
		const { task } = await setup();
		const admin = new pg.Client({ connectionString: cp.database.url });
		await admin.connect();
		try {
			await admin.query(
				`create function slow_artifact_insert() returns trigger language plpgsql as $$
					begin perform pg_sleep(0.3); return new; end $$;
				 create trigger slow_artifact_insert before insert on artifacts
					for each row execute function slow_artifact_insert();`,
			);
			const results = await Promise.all(
				[0, 1, 2].map((i) => slowPut(urlOf(task, `f${i}.bin`), 400, { declare: true, gapMs: 100 })),
			);

			expect(results.map((r) => r.status).sort()).toEqual([201, 201, 413]);
			const artifacts = await stored(task);
			expect(artifacts.reduce((sum, a) => sum + a.size, 0)).toBe(800);
		} finally {
			await admin.end();
		}
	}, 60_000);

	// Content-Type 是 text/plain 时 Fastify 自带的文本解析器已经把请求体读成了字符串（不是流）：`ArtifactStore.save` 收到的是一个字符串。
	// e2e 里用 `fetch(url, { method: "PUT", body: "<html>…" })` 上传就是这样（undici 给字符串请求体加 text/plain）。
	it("请求体被解析成字符串（Content-Type: text/plain）也能存", async () => {
		const { task } = await setup();

		const res = await cp.fetch(`/tasks/${task.taskId}/artifacts/report.html`, {
			method: "PUT",
			body: "<html>report</html>",
		});

		expect(res.status).toBe(201);
		const downloaded = await (await cp.fetch(`/tasks/${task.taskId}/artifacts/report.html`)).text();
		expect(downloaded).toBe("<html>report</html>");
	}, 60_000);

	it("中途断开的上传不占额度，也不占着别人的位置：断开之后同一个任务的下一份照常存", async () => {
		const { task } = await setup();
		// 声明 800 字节，只发 600 就断开。
		await new Promise<void>((resolve) => {
			const req = httpRequest(urlOf(task, "dropped.bin"), {
				method: "PUT",
				headers: { "content-type": "application/octet-stream", "content-length": "800" },
			});
			req.on("error", () => {});
			req.write(Buffer.alloc(600, 1), () => {
				setTimeout(() => {
					req.destroy();
					resolve();
				}, 200);
			});
		});

		// 断开的那份没有记账：1000 字节的上限还剩 1000，下一份 900 字节照常存。
		const next = await slowPut(urlOf(task, "next.bin"), 900, { declare: true, gapMs: 50 });

		expect(next.status).toBe(201);
		expect((await stored(task)).map((a) => [a.name, a.size])).toEqual([["next.bin", 900]]);
	}, 60_000);
});

describe("卡住的上传（连着、不发数据）", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;

	afterEach(async () => {
		await agent?.disconnect();
		await cp.close();
	});

	const setup = async (idleMs: number) => {
		cp = await startTestControlPlane({ artifactLimitBytes: LIMIT, artifactUploadIdleMs: idleMs });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		return { task: await agent.nextAssign(), runId };
	};

	/** 声明 1000 字节、只发 `sent` 字节就不再发，连接一直开着；返回响应（或连接被关掉的错误）。 */
	const stall = (url: string, sent: number) =>
		new Promise<{ status: number; body: string } | { error: string }>((resolve) => {
			const req = httpRequest(url, {
				method: "PUT",
				headers: { "content-type": "application/octet-stream", "content-length": "1000" },
			});
			req.on("response", (res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
				res.on("error", () => {});
			});
			req.on("error", (error) => resolve({ error: error.message }));
			req.write(Buffer.alloc(sent, 1));
		});
	/** 隔 `everyMs` 毫秒发一小块，一共 `chunks` 块，每块 `size` 字节，一直在发数据；分块传输。 */
	const trickle = (url: string, options: { chunks: number; size: number; everyMs: number }) =>
		new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				url,
				{
					method: "PUT",
					headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode ?? 0));
				},
			);
			req.on("error", reject);
			let sent = 0;
			const next = () => {
				if (sent === options.chunks) return void req.end();
				sent++;
				req.write(Buffer.alloc(options.size, 3), () => setTimeout(next, options.everyMs));
			};
			next();
		});
	const tmpFiles = async (runId: string, taskId: string) =>
		(await readdir(join(cp.dataDir, "artifacts", runId, taskId))).filter((n) =>
			n.startsWith(".upload-"),
		);

	it("发了一部分就不再发数据：到空闲时限之后它得到明确的错误（408，不存、不留临时文件），同一个任务排着的那一份随即被处理", async () => {
		const { task, runId } = await setup(600);
		const stalled = stall(`${task.artifactUploadUrl}stuck.bin`, 100);
		await new Promise((resolve) => setTimeout(resolve, 150));

		// 排在卡住的那一份后面的：卡住的那一份超时结束之后马上轮到它。
		const queuedAt = Date.now();
		const next = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				`${task.artifactUploadUrl}next.bin`,
				{ method: "PUT", headers: { "content-length": "300" } },
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode ?? 0));
				},
			);
			req.on("error", reject);
			req.end(Buffer.alloc(300, 2));
		});
		const waited = Date.now() - queuedAt;

		expect(next).toBe(201);
		// 它是等了卡住的那一份超时才被处理的（不是一开始就在处理）：至少等了大半个空闲时限。
		expect(waited).toBeGreaterThanOrEqual(300);
		expect(waited).toBeLessThan(5_000);
		const outcome = await stalled;
		expect("status" in outcome ? outcome.status : "连接被关掉").toBe(408);
		if ("status" in outcome) {
			expect(JSON.parse(outcome.body).error.code).toBe("upload_idle_timeout");
		}
		expect(await tmpFiles(runId, task.taskId)).toEqual([]);
		const listed = (await (await cp.fetch(`/tasks/${task.taskId}/artifacts`)).json()) as {
			artifacts: Array<{ name: string }>;
		};
		expect(listed.artifacts.map((a) => a.name)).toEqual(["next.bin"]);
	}, 60_000);

	// 408 之后客户端还在往连接里写（它以为还在上传）：控制面回了响应就关掉连接，不留着一条没有读完请求体的连接
	// （keep-alive 的连接上，下一个请求会被读成这份没读完的请求体的后半截）。
	it("408 之后连接被关掉：响应带 connection: close，服务端随即关闭这条连接", async () => {
		const { task } = await setup(300);

		const outcome = await new Promise<{
			status: number;
			connection: string | undefined;
			closed: boolean;
		}>((resolve, reject) => {
			const req = httpRequest(`${task.artifactUploadUrl}stuck-close.bin`, {
				method: "PUT",
				agent: false,
				headers: { "content-type": "application/octet-stream", "content-length": "1000" },
			});
			req.on("response", (res) => {
				res.resume();
				const socket = res.socket;
				const report = (closed: boolean) =>
					resolve({
						status: res.statusCode ?? 0,
						connection: res.headers.connection,
						closed,
					});
				// 响应收完之后最多再等 3 秒，看服务端有没有关掉这条连接（keep-alive 的连接默认还会留 5 秒）。
				const timer = setTimeout(() => report(false), 3_000);
				socket.once("close", () => {
					clearTimeout(timer);
					report(true);
				});
				if (socket.destroyed) {
					clearTimeout(timer);
					report(true);
				}
			});
			req.on("error", reject);
			req.write(Buffer.alloc(100, 1));
		});

		expect(outcome.status).toBe(408);
		expect(outcome.connection).toBe("close");
		expect(outcome.closed).toBe(true);
	}, 60_000);

	it("一直在慢慢发数据的上传（总时长远超空闲时限）不被误杀", async () => {
		const { task } = await setup(600);

		// 每 200 毫秒发一块，共 10 块，2 秒多：每次间隔都小于空闲时限，总时长是它的三倍多。
		const status = await trickle(`${task.artifactUploadUrl}slow.bin`, {
			chunks: 10,
			size: 50,
			everyMs: 200,
		});

		expect(status).toBe(201);
		const listed = (await (await cp.fetch(`/tasks/${task.taskId}/artifacts`)).json()) as {
			artifacts: Array<{ name: string; size: number }>;
		};
		expect(listed.artifacts).toEqual([expect.objectContaining({ name: "slow.bin", size: 500 })]);
	}, 60_000);
});
