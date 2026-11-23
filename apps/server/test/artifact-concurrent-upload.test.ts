// 同一个任务并发上传产物（#588）：并发上传时存下来的合计不超过上限；每一份单独都放得下、合在一起超限时，超出的那一份得到和
// 顺序上传时同样的拒绝；中途断开的上传不占额度、也不占着别人的位置。
// 上传的请求体分两次发（先发一半、隔一会儿再发另一半），让并发的几份在时间上重叠。
import { request as httpRequest } from "node:http";
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

	const setup = async (): Promise<{ task: AssignedTask }> => {
		cp = await startTestControlPlane({ artifactLimitBytes: LIMIT });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const api = new ApiClient(cp);
		await api.triggerOk(await api.orchestrationWith(DOC));
		return { task: await agent.nextAssign() };
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
