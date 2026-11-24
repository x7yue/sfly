// 运行视图里的输入和输出有上界（#633）：以前一次返回这次运行所有任务的输入和输出，个数没有上限（每个本来有 1 MiB 的上限）：
// 几十个任务各有接近上限的输出时，一次响应是几十 MB，控制面读、打码、序列化都是同步做的，别的请求都在等；事件流在每次状态变化时
// 又推一整份。现在：
// - 单个输入、输出超过 16 KiB 的，视图里只给大小（`inputs_omitted_bytes`、`outputs_omitted_bytes`，存着的大小向上取整到 KiB，
//   只在内容被省略时不是 null），内容是 null；刚好 16 KiB 的仍然内联；大小在 SQL 里判，大的内容不从数据库读出来；
// - 整份视图内联的合计不超过 1 MiB（按实际写进响应的字节算，节点层的 `outputs` 那一份也算），按链、节点、尝试的顺序用，
//   某一份放不下它和之后的都只给大小；
// - 全文用 `GET /tasks/:id/io` 取（每一次尝试的），打码和视图走同一条路。
// 真实控制面和数据库，运行是直接写库种出来的（要的是确定的大小，不是真的把它跑起来）。
// 数字都写成字面量（16 KiB、1 MiB）：测试钉死契约的数，不引用实现里的常量。
import { createConnection, createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { getRunView } from "../src/runs/run-read.js";
import { publishPackage } from "./support/package-archive.js";
import { seedRunIo, storedAs, writtenBytes } from "./support/seed-run-io.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const VALUE_LIMIT = 16 * 1024;
const TOTAL_LIMIT = 1024 * 1024;
const KIB = 1024;

interface AttemptJson {
	task_id: string;
	attempt: number;
	inputs: Record<string, unknown> | null;
	inputs_omitted_bytes: number | null;
	outputs: Record<string, unknown> | null;
	outputs_omitted_bytes: number | null;
}
interface NodeJson {
	node_id: string;
	outputs: Record<string, unknown> | null;
	outputs_omitted_bytes: number | null;
	attempts: AttemptJson[];
}
interface RunJson {
	chains: Array<{ nodes: NodeJson[] }>;
}

/** 数据库前面的 TCP 转发，数一数数据库发给客户端的字节数。 */
async function countingProxy(databaseUrl: string) {
	const target = new URL(databaseUrl);
	let received = 0;
	const server: Server = createServer((client) => {
		const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
		client.on("data", (chunk) => upstream.write(chunk));
		upstream.on("data", (chunk: Buffer) => {
			received += chunk.length;
			client.write(chunk);
		});
		client.on("close", () => upstream.destroy()).on("error", () => upstream.destroy());
		upstream.on("close", () => client.destroy()).on("error", () => client.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const url = new URL(databaseUrl);
	url.hostname = "127.0.0.1";
	url.port = String(port);
	return {
		url: url.toString(),
		received: () => received,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("运行视图里的输入和输出：大的只给大小，合计有上界，全文单独取", () => {
	let cp: TestControlPlane;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
	}, 60_000);
	afterAll(async () => {
		await cp?.close();
	});

	const runJson = async (run: string): Promise<{ body: string; view: RunJson }> => {
		const res = await cp.fetch(`/runs/${run}`);
		expect(res.status).toBe(200);
		const body = await res.text();
		return { body, view: JSON.parse(body) as RunJson };
	};
	const nodeOf = (view: RunJson, id: string): NodeJson => {
		const node = view.chains[0]?.nodes.find((n) => n.node_id === id);
		if (!node) throw new Error(`视图里没有节点 ${id}`);
		return node;
	};
	const allNodes = (view: RunJson) => view.chains.flatMap((chain) => chain.nodes);
	/** 视图里所有内联的输入和输出写进响应的字节数合计（尝试的输入、输出，加节点层的输出）。 */
	const inlineBytes = (view: RunJson): number =>
		allNodes(view).reduce(
			(sum, node) =>
				sum +
				writtenBytesOf(node.outputs) +
				node.attempts.reduce((s, a) => s + writtenBytesOf(a.inputs) + writtenBytesOf(a.outputs), 0),
			0,
		);
	const writtenBytesOf = (value: unknown) => (value === null ? 0 : writtenBytes(value));
	const ioOf = async (task: string) => {
		const res = await cp.fetch(`/tasks/${task}/io`);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};

	it("小的输入输出照常内联：尝试和节点层的内容都在，大小字段是 null", async () => {
		const { run } = await seedRunIo(cp, [
			{
				id: "a",
				attempts: [{ inputs: { url: "https://example.test" }, outputs: { status: 200 } }],
			},
		]);

		const { view } = await runJson(run);

		const node = nodeOf(view, "a");
		expect(node.attempts[0]).toMatchObject({
			inputs: { url: "https://example.test" },
			inputs_omitted_bytes: null,
			outputs: { status: 200 },
			outputs_omitted_bytes: null,
		});
		expect(node.outputs).toEqual({ status: 200 });
		expect(node.outputs_omitted_bytes).toBeNull();
	});

	it("没有输入或输出（数据库里是 NULL）：内容是 null，大小字段也是 null（不是「被省略」）", async () => {
		const { run } = await seedRunIo(cp, [{ id: "a", attempts: [{ inputs: null, outputs: null }] }]);

		const { view } = await runJson(run);

		const node = nodeOf(view, "a");
		expect(node.attempts[0]).toMatchObject({
			inputs: null,
			inputs_omitted_bytes: null,
			outputs: null,
			outputs_omitted_bytes: null,
		});
		expect(node.outputs).toBeNull();
		expect(node.outputs_omitted_bytes).toBeNull();
	});

	it("正好 16 KiB（存着的大小）仍然内联；多 1 个字节就只给大小，向上取整到 KiB，节点层跟着最后一次尝试", async () => {
		const exact = storedAs(VALUE_LIMIT);
		const over = storedAs(VALUE_LIMIT + 1);
		const { run } = await seedRunIo(cp, [
			{ id: "exact", attempts: [{ inputs: exact, outputs: exact }] },
			{ id: "over", attempts: [{ inputs: over, outputs: over }] },
		]);

		const { view } = await runJson(run);

		const inline = nodeOf(view, "exact");
		expect(inline.attempts[0]).toMatchObject({
			inputs: exact,
			inputs_omitted_bytes: null,
			outputs: exact,
			outputs_omitted_bytes: null,
		});
		expect(inline.outputs).toEqual(exact);
		expect(inline.outputs_omitted_bytes).toBeNull();
		const omitted = nodeOf(view, "over");
		expect(omitted.attempts[0]).toMatchObject({
			inputs: null,
			inputs_omitted_bytes: 17 * KIB,
			outputs: null,
			outputs_omitted_bytes: 17 * KIB,
		});
		expect(omitted.outputs).toBeNull();
		expect(omitted.outputs_omitted_bytes).toBe(17 * KIB);
	});

	it.each([
		["16385", VALUE_LIMIT + 1, 17 * KIB],
		["17408（正好 17 KiB）", 17 * KIB, 17 * KIB],
		["17409", 17 * KIB + 1, 18 * KIB],
		["20000", 20_000, 20 * KIB],
		["1 MiB", 1024 * 1024, 1024 * KIB],
	])("被省略的大小向上取整到 KiB，不给精确值：存着 %s 字节 → %d", async (_, stored, expected) => {
		const { run } = await seedRunIo(cp, [{ id: "a", attempts: [{ outputs: storedAs(stored) }] }]);

		const { view } = await runJson(run);

		const { outputs_omitted_bytes: omitted } = nodeOf(view, "a").attempts[0] as AttemptJson;
		expect(omitted).toBe(expected);
		expect((omitted as number) % KIB).toBe(0);
	});

	it("大小按字节算，不按字符数：8190 个 2 字节的字符（存着 16392 字节）被省略，8186 个（16384 字节）内联", async () => {
		const big = { text: "é".repeat(8190) };
		const fits = { text: "é".repeat(8186) };
		const { run } = await seedRunIo(cp, [
			{ id: "big", attempts: [{ outputs: big }] },
			{ id: "fits", attempts: [{ outputs: fits }] },
		]);

		const { view } = await runJson(run);

		expect(nodeOf(view, "big").attempts[0]).toMatchObject({
			outputs: null,
			outputs_omitted_bytes: 17 * KIB,
		});
		expect(nodeOf(view, "fits").attempts[0]).toMatchObject({
			outputs: fits,
			outputs_omitted_bytes: null,
		});
	});

	/**
	 * 合计用到正好 1 MiB 的运行：前 31 个节点各一次尝试，输出存着 16384 字节（写进响应 16383 字节，尝试和节点层各一份，
	 * 一个节点 32766 字节，31 个共 1015746）；第 32 个节点的输入 64 字节、输出同样，一共 32830 字节，正好是剩下的。
	 * `lastInput` 是第 32 个节点的输入写进响应的字节数（64 正好用完，65 就差 1 个字节）。
	 */
	const nodesUpTo = (lastInput: number) => {
		const output = storedAs(VALUE_LIMIT);
		const nodes = Array.from({ length: 31 }, (_, i) => ({
			id: `n${String(i + 1).padStart(2, "0")}`,
			attempts: [{ outputs: output }],
		}));
		return [
			...nodes,
			{
				id: "n32",
				// 写进响应的字节数 = 内容 n + 11（`{"text":"` 加 `"}`）。
				attempts: [{ inputs: { text: "x".repeat(lastInput - 11) }, outputs: output }],
			},
			{ id: "n33", attempts: [{ outputs: {} }] },
			{ id: "n34", attempts: [{ outputs: { a: 1 } }] },
		];
	};

	it('合计正好用完（1 MiB）：这一个值仍然内联；用完之后再短的（`{}`、`{"a":1}`）也只给大小', async () => {
		const { run } = await seedRunIo(cp, nodesUpTo(64));

		const { view } = await runJson(run);

		const last = nodeOf(view, "n32");
		expect(last.attempts[0]?.inputs).not.toBeNull();
		expect(last.attempts[0]?.outputs).not.toBeNull();
		expect(last.outputs).not.toBeNull();
		expect(last.outputs_omitted_bytes).toBeNull();
		expect(inlineBytes(view)).toBe(TOTAL_LIMIT);
		for (const id of ["n33", "n34"]) {
			const node = nodeOf(view, id);
			expect(node.attempts[0]?.outputs, id).toBeNull();
			expect(node.attempts[0]?.outputs_omitted_bytes, id).toBe(KIB);
			expect(node.outputs, id).toBeNull();
			expect(node.outputs_omitted_bytes, id).toBe(KIB);
		}
		// 前面的节点都内联着。
		for (const id of ["n01", "n16", "n31"]) {
			expect(nodeOf(view, id).outputs, id).not.toBeNull();
		}
	});

	it("合计差 1 个字节：尝试的输入、输出内联，节点层那一份（也算合计）放不下，只给大小；之后的都只给大小", async () => {
		const { run } = await seedRunIo(cp, nodesUpTo(65));

		const { view } = await runJson(run);

		const last = nodeOf(view, "n32");
		expect(last.attempts[0]?.inputs).not.toBeNull();
		expect(last.attempts[0]?.outputs).not.toBeNull();
		expect(last.attempts[0]?.outputs_omitted_bytes).toBeNull();
		expect(last.outputs).toBeNull();
		expect(last.outputs_omitted_bytes).toBe(VALUE_LIMIT);
		expect(inlineBytes(view)).toBeLessThanOrEqual(TOTAL_LIMIT);
		expect(nodeOf(view, "n33").attempts[0]?.outputs_omitted_bytes).toBe(KIB);
		expect(nodeOf(view, "n34").outputs_omitted_bytes).toBe(KIB);
	});

	it("任务再多响应也有上界：200 个节点各有 16 KiB 的输出，响应体不到 1.5 MiB，内联的合计不超过 1 MiB", async () => {
		const output = storedAs(VALUE_LIMIT);
		const { run } = await seedRunIo(
			cp,
			Array.from({ length: 200 }, (_, i) => ({ id: `n${i + 1}`, attempts: [{ outputs: output }] })),
		);

		const { body, view } = await runJson(run);

		expect(inlineBytes(view)).toBeLessThanOrEqual(TOTAL_LIMIT);
		expect(Buffer.byteLength(body)).toBeLessThan(1.5 * TOTAL_LIMIT);
		// 内联的是前面的，后面的都只给大小。
		expect(nodeOf(view, "n1").outputs).not.toBeNull();
		expect(nodeOf(view, "n200").outputs).toBeNull();
		expect(nodeOf(view, "n200").outputs_omitted_bytes).toBe(VALUE_LIMIT);
	}, 60_000);

	it("大的输入、输出不离开数据库：读运行视图时数据库发给控制面的字节数远小于存着的（60 个任务各存 2 × 100 KB）", async () => {
		const value = storedAs(100_000);
		const { run } = await seedRunIo(
			cp,
			Array.from({ length: 60 }, (_, i) => ({
				id: `n${i + 1}`,
				attempts: [{ inputs: value, outputs: value }],
			})),
		);
		const proxy = await countingProxy(cp.database.url);
		const opened = openDatabase(proxy.url, () => {});
		try {
			await getRunView(opened.db, run); // 预热：连接、类型信息
			const before = proxy.received();

			const view = await getRunView(opened.db, run);

			// 存着 12 MB，读视图时数据库只发来大小和状态那些列（远不到 1 MiB）。
			expect(proxy.received() - before).toBeLessThan(TOTAL_LIMIT);
			expect(view?.chains[0]?.nodes[59]?.attempts[0]?.outputs_omitted_bytes).toBe(98 * KIB);
		} finally {
			await opened.close();
			await proxy.close();
		}
	}, 60_000);

	it("事件流的 run 事件和 GET 是同一份有界的视图", async () => {
		const output = storedAs(VALUE_LIMIT);
		const { run } = await seedRunIo(
			cp,
			Array.from({ length: 100 }, (_, i) => ({ id: `n${i + 1}`, attempts: [{ outputs: output }] })),
		);
		const sse = await SseClient.open(cp, `/runs/${run}/events`);
		try {
			const event = await sse.next<RunJson>("run");

			expect(inlineBytes(event.data)).toBeLessThanOrEqual(TOTAL_LIMIT);
			expect(Buffer.byteLength(JSON.stringify(event.data))).toBeLessThan(1.5 * TOTAL_LIMIT);
			expect(nodeOf(event.data, "n100").outputs_omitted_bytes).toBe(VALUE_LIMIT);
		} finally {
			sse.close();
		}
	}, 60_000);

	it("多次尝试：每一次的输入、输出各自判断；节点层跟着最后一次；每一次的全文都取得到", async () => {
		const first = storedAs(20_000);
		const second = { ok: true };
		const third = storedAs(30_000);
		const { run, tasks } = await seedRunIo(cp, [
			{
				id: "retry",
				attempts: [
					{ inputs: { n: 1 }, outputs: first },
					{ inputs: { n: 2 }, outputs: second },
					{ inputs: storedAs(25_000), outputs: third },
				],
			},
		]);

		const { view } = await runJson(run);

		const node = nodeOf(view, "retry");
		expect(node.attempts.map((a) => a.outputs_omitted_bytes)).toEqual([20 * KIB, null, 30 * KIB]);
		expect(node.attempts.map((a) => a.inputs_omitted_bytes)).toEqual([null, null, 25 * KIB]);
		expect(node.attempts[1]?.outputs).toEqual(second);
		expect(node.outputs).toBeNull();
		expect(node.outputs_omitted_bytes).toBe(30 * KIB);
		const [t1, t2, t3] = tasks.retry as [string, string, string];
		expect(await ioOf(t1)).toEqual({
			status: 200,
			body: { task_id: t1, inputs: { n: 1 }, outputs: first },
		});
		expect(await ioOf(t2)).toEqual({
			status: 200,
			body: { task_id: t2, inputs: { n: 2 }, outputs: second },
		});
		expect(await ioOf(t3)).toEqual({
			status: 200,
			body: { task_id: t3, inputs: storedAs(25_000), outputs: third },
		});
	});

	it("取全文的路由：没有输入输出的任务是 null；不存在的任务、不是 UUID 的 ID 是 404", async () => {
		const { tasks } = await seedRunIo(cp, [
			{ id: "a", attempts: [{ inputs: null, outputs: null }] },
		]);

		expect(await ioOf(tasks.a?.[0] as string)).toEqual({
			status: 200,
			body: { task_id: tasks.a?.[0], inputs: null, outputs: null },
		});
		expect((await ioOf("00000000-0000-4000-8000-00000000dead")).status).toBe(404);
		expect((await ioOf("not-a-uuid")).status).toBe(404);
	});

	const TOKEN = `sfly_pat_${"0123456789abcdef".repeat(3)}`;

	it("打码：内联的内容里的令牌是掩码；被省略的大小是存着的（打码之前）大小向上取整，不随打码变；全文也是打码之后的", async () => {
		// 300 个令牌（每个 57 个字符加一个空格）：存着 17412 个字节（取整 18 KiB）；打码之后每个只剩 6 个掩码字符，
		// 共 2112 个字节（取整 3 KiB）——大小要是从打码之后的内容算出来，就是 3072，不是 18432。
		const text = `${TOKEN} `.repeat(300);
		const small = { text: `a ${TOKEN} b` };
		const { run, tasks } = await seedRunIo(cp, [
			{ id: "big", attempts: [{ outputs: { text } }] },
			{ id: "small", attempts: [{ outputs: small }] },
		]);

		const { body, view } = await runJson(run);

		expect(body).not.toContain(TOKEN);
		expect(nodeOf(view, "small").attempts[0]?.outputs).toEqual({ text: "a ****** b" });
		expect(nodeOf(view, "small").attempts[0]?.outputs_omitted_bytes).toBeNull();
		const omitted = nodeOf(view, "big").attempts[0]?.outputs_omitted_bytes;
		expect(omitted).toBe(18 * KIB);
		const full = await ioOf(tasks.big?.[0] as string);
		const fullText = (full.body.outputs as { text: string }).text;
		expect(fullText).not.toContain(TOKEN);
		expect(fullText).toBe("****** ".repeat(300));
		// 打码之后的内容取整到 KiB 是另一个数：大小字段不是从它算的。
		const maskedKib = Math.ceil(Buffer.byteLength(JSON.stringify({ text: fullText })) / KIB) * KIB;
		expect(maskedKib).toBeLessThan(omitted as number);
	});

	it("入口的 secret 参数的值：内联的输出里是掩码，被省略的全文里也是；被省略的大小同样不随它变", async () => {
		const secret = "hunter2-很长的保密值-0123456789";
		const filler = "y".repeat(17_000);
		const { run, tasks } = await seedRunIo(
			cp,
			[
				{
					id: "small",
					attempts: [{ inputs: { token: secret }, outputs: { echo: `got ${secret}` } }],
				},
				{ id: "big", attempts: [{ outputs: { text: `${filler}${secret}` } }] },
			],
			{ secretParam: { name: "token", value: secret } },
		);

		const { body, view } = await runJson(run);

		expect(body).not.toContain(secret);
		expect(nodeOf(view, "small").attempts[0]).toMatchObject({
			inputs: { token: "******" },
			outputs: { echo: "got ******" },
		});
		expect(nodeOf(view, "big").attempts[0]?.outputs_omitted_bytes).toBe(
			Math.ceil((17_000 + Buffer.byteLength(secret) + 12) / KIB) * KIB,
		);
		const full = await ioOf(tasks.big?.[0] as string);
		expect(JSON.stringify(full.body)).not.toContain(secret);
		expect((full.body.outputs as { text: string }).text).toBe(`${filler}******`);
	});
});
