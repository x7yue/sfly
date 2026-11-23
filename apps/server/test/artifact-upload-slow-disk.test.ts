// 写盘慢的时候，空闲超时不把写盘的时间算进去（#588 的审查留下的，#665 补）：空闲计时只在等客户端发数据时开着；
// 请求体早就发完、服务端自己写得慢（磁盘慢、背压让读请求体的一方要等写完才读下一块）时，不能算成「客户端 100 毫秒没发数据」。
// 把 node:fs 的 createWriteStream 换成每写一块都慢、highWaterMark 为 1 的流（每写一块都有背压）。
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** 每次写要多久（毫秒）；0 是不变慢。 */
const slow = vi.hoisted(() => ({ writeMs: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const { Writable: SlowWritable } = await import("node:stream");
	const createWriteStream = (path: string, options?: unknown) => {
		const real = actual.createWriteStream(path, options as never);
		if (slow.writeMs === 0 || !String(path).includes(".upload-")) return real;
		return new SlowWritable({
			highWaterMark: 1,
			write(chunk, _encoding, callback) {
				setTimeout(() => real.write(chunk, (error) => callback(error ?? null)), slow.writeMs);
			},
			final(callback) {
				real.end(() => callback());
			},
			destroy(error, callback) {
				real.destroy();
				callback(error);
			},
		});
	};
	return { ...actual, default: { ...actual, createWriteStream }, createWriteStream };
});

const { ArtifactStore } = await import("../src/artifacts/artifact-store.js");
const { openDatabase } = await import("../src/db/database.js");
const { ApiClient } = await import("./support/api-client.js");
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

describe("写盘慢：空闲超时不算写盘的时间", () => {
	let cp: Awaited<ReturnType<typeof startTestControlPlane>>;
	let agent: Awaited<ReturnType<typeof FakeAgent.connect>>;
	let database: ReturnType<typeof openDatabase>;
	let taskId: string;

	beforeAll(async () => {
		cp = await startTestControlPlane({ artifactLimitBytes: 100_000 });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
		const api = new ApiClient(cp);
		await api.triggerOk(await api.orchestrationWith(DOC));
		taskId = (await agent.nextAssign()).taskId;
		database = openDatabase(cp.database.url, () => {});
	}, 60_000);
	afterAll(async () => {
		slow.writeMs = 0;
		await database?.close();
		await agent?.disconnect();
		await cp?.close();
	});

	it("每块写 150 毫秒、空闲时限 100 毫秒、8 块（请求体早就发完了）：照常存下，不超时", async () => {
		const store = new ArtifactStore({
			db: database.db,
			clock: cp.clock,
			dataDir: cp.dataDir,
			limitBytes: 100_000,
			uploadIdleMs: 100,
		});
		// objectMode 的 Readable.from：一块一块给（不会把缓冲里的几块拼成一块）。
		const body = Readable.from(Array.from({ length: 8 }, (_, i) => Buffer.alloc(100, i + 1)));
		slow.writeMs = 150;
		const started = Date.now();

		const outcome = await store.save(taskId, "slow-disk.bin", body);

		slow.writeMs = 0;
		// 写盘一共花了 8 × 150 毫秒：每块都比空闲时限长，但客户端一直没有停过。
		expect(Date.now() - started).toBeGreaterThan(800);
		expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
		if (outcome.ok) expect(outcome.artifact.size).toBe(800);
	}, 30_000);

	it("写盘慢的同时客户端真的不发数据了：照样按空闲时限 408", async () => {
		const store = new ArtifactStore({
			db: database.db,
			clock: cp.clock,
			dataDir: cp.dataDir,
			limitBytes: 100_000,
			uploadIdleMs: 300,
		});
		// 发了一块就不再发、也不结束。
		const body = new Readable({ read() {} });
		body.push(Buffer.alloc(100, 1));
		slow.writeMs = 50;

		const outcome = await store.save(taskId, "slow-stalled.bin", body);

		slow.writeMs = 0;
		body.destroy();
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.status).toBe(408);
	}, 30_000);
});
