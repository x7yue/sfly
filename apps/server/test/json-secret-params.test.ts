// 值是对象的 json 类型 secret 参数（#479）：运行视图、列表、事件流、日志、动作里都不出现原值里的任何字符串叶子，
// secret 参数本身（以及整个出现在别处的同一个对象）整个换成掩码；节点收到的输入仍是原值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
// HTTP API + SSE + 假 Agent + 真实 PostgreSQL。叶子都是明显的假值。
import { describe, expect, it } from "vitest";
import { ApiClient, type RunView } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane } from "./support/test-control-plane.js";

const MASK = "******";
const LEAVES = ["test-leaf-one", "test-leaf-two", "test-leaf-three", "test-leaf-four"];
const OPTS = {
	key: "test-leaf-one",
	nested: { deep: "test-leaf-two", list: ["test-leaf-three"] },
	port: 5432,
};
const ARRAY = ["test-leaf-four", ["test-leaf-one"]];

/** entry(opts: json secret) → a → b → x（opts 经参数映射传给子流程）；子流程 sub(o: json，没有声明 secret) → s1。 */
const scenario = (type: "json" = "json") => ({
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "opts", type, secret: true },
				{ name: "list", type, secret: true },
			],
		},
		{
			id: "a",
			kind: "package",
			package: "stub",
			node: "echo",
			inputs: { opts: "${{ params.opts }}" },
		},
		{ id: "b", kind: "package", package: "stub", node: "echo" },
		{ id: "x", kind: "async", params: { o: "${{ params.opts }}" } },
		{ id: "sub", kind: "subflow_entry", name: "inner", params: [{ name: "o", type }] },
		{ id: "s1", kind: "package", package: "stub", node: "echo", inputs: { o: "${{ params.o }}" } },
	],
	edges: [
		{ from: "entry", to: "a", kind: "chain" },
		{ from: "a", to: "b", kind: "chain" },
		{ from: "b", to: "x", kind: "chain" },
		{ from: "x", to: "sub", kind: "dispatch" },
		{ from: "sub", to: "s1", kind: "chain" },
	],
	packages: { stub: "1.0.0" },
});

describe("值是对象或数组的 json 类型 secret 参数", () => {
	it("运行视图、列表、事件流、日志、仪表盘里都没有原值里的叶子；节点收到的输入仍是原值", async () => {
		const cp = await startTestControlPlane();
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		const streams: SseClient[] = [];
		try {
			const api = new ApiClient(cp);
			await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
			const id = await api.orchestrationWith(scenario());
			const runId = await api.triggerOk(id, { opts: OPTS, list: ARRAY });

			// 节点收到的是原值（打码只在读取和写日志的一侧）。
			const a = await agent.nextAssign();
			expect(a.inputs).toEqual({ opts: OPTS });
			const logStream = new Promise<SseClient>((resolve) => {
				void SseClient.open(cp, `/tasks/${a.taskId}/logs/events`).then(resolve);
			});
			streams.push(await logStream);

			// 日志、进度里出现整段 JSON、叶子（包括转义后的写法）。
			agent.logs(a, [
				// 节点收到的对象（键的顺序是库里 jsonb 的顺序）原样写出来：整段换成一个掩码。
				[1, `opts=${JSON.stringify(a.inputs.opts)}`],
				[2, "leaf test-leaf-two and test-leaf-three"],
				[3, `array ${JSON.stringify(ARRAY)}`],
				[4, `escaped ${JSON.stringify("test-leaf-one")}`],
				// 键的顺序不一样的写法（整段对不上）：字符串叶子照样换掉，数字不单独打码。
				[5, `reordered ${JSON.stringify(OPTS)}`],
			]);
			agent.progress(a, 1, 2, "using test-leaf-one");
			await agent.succeed(a, { echoed: OPTS, again: ARRAY, text: "got test-leaf-three" });

			await agent.succeed(await agent.nextAssign());
			const s1 = await agent.nextAssign();
			expect(s1.inputs).toEqual({ o: OPTS });
			await agent.fail(s1, "bad test-leaf-four near test-leaf-two");

			// 日志是异步写入的：等五行都写好。
			await eventually(async () => {
				const page = await api.getJson<{ lines: unknown[] }>(`/tasks/${a.taskId}/logs`);
				expect(page.lines).toHaveLength(5);
			});
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));

			// 运行视图：参数、子流程链实例的参数、输入、输出、错误。
			const run: RunView = await api.run(runId);
			expect(run.params).toEqual({ opts: MASK, list: MASK });
			expect(run.chains[0]?.params).toEqual({ opts: MASK, list: MASK });
			expect(run.chains[1]?.params).toEqual({ o: MASK });
			const [nodeA] = run.chains[0]?.nodes.slice(1) ?? [];
			expect(nodeA?.attempts[0]?.inputs).toEqual({ opts: MASK });
			expect(nodeA?.outputs).toEqual({ echoed: MASK, again: MASK, text: `got ${MASK}` });
			expect(nodeA?.attempts[0]?.progress?.message).toBe(`using ${MASK}`);
			const nodeS1 = run.chains[1]?.nodes.find((n) => n.node_id === "s1");
			expect(nodeS1?.attempts[0]?.inputs).toEqual({ o: MASK });
			expect(nodeS1?.error?.message).toBe(`bad ${MASK} near ${MASK}`);

			// 日志：整段 JSON 换成一个掩码，叶子换成掩码，转义写法也换。
			const lines = (
				await api.getJson<{ lines: Array<{ text: string }> }>(`/tasks/${a.taskId}/logs`)
			).lines;
			expect(lines.map((l) => l.text)).toEqual([
				`opts=${MASK}`,
				`leaf ${MASK} and ${MASK}`,
				`array ${MASK}`,
				`escaped "${MASK}"`,
				`reordered {"key":"${MASK}","nested":{"deep":"${MASK}","list":["${MASK}"]},"port":5432}`,
			]);

			// 每一个会返回这次运行内容的出口：响应的全部文本里没有任何叶子。
			const text = async (path: string) => (await cp.fetch(path)).text();
			const outputs: Array<[string, string]> = [
				["运行视图", await text(`/runs/${runId}`)],
				["运行列表", await text("/runs")],
				["场景的运行", await text(`/orchestrations/${id}/runs`)],
				["运行的日志", await text(`/runs/${runId}/logs`)],
				["任务的日志", await text(`/tasks/${a.taskId}/logs`)],
				["任务日志的下载", await text(`/tasks/${a.taskId}/logs/download`)],
				["运行日志的下载", await text(`/runs/${runId}/logs/download`)],
				["仪表盘", await text("/dashboard")],
				["关注项", await text(`/runs/${runId}/focus?points=0`)],
				["Agent 列表", await text("/agents")],
				["场景预检", await text(`/orchestrations/${id}/preflight`)],
			];
			for (const [what, body] of outputs) {
				for (const leaf of LEAVES) expect(body, `${what}：不能出现 ${leaf}`).not.toContain(leaf);
			}

			// 事件流：运行视图的第一条、任务日志的实时推送。
			const events = await SseClient.open(cp, `/runs/${runId}/events`);
			streams.push(events);
			const first = JSON.stringify((await events.next("run")).data);
			for (const leaf of LEAVES)
				expect(first, `运行的事件流：不能出现 ${leaf}`).not.toContain(leaf);
			expect(first).toContain(MASK);
			const live = JSON.stringify(streams[0]?.received);
			for (const leaf of LEAVES)
				expect(live, `任务日志的事件流：不能出现 ${leaf}`).not.toContain(leaf);

			// 日志文件里也不保存明文。
			const { readdir, readFile } = await import("node:fs/promises");
			const { join } = await import("node:path");
			const entries = await readdir(join(cp.dataDir, "logs"), {
				recursive: true,
				withFileTypes: true,
			});
			const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
			const stored = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
			for (const leaf of LEAVES) expect(stored, `日志文件：不能出现 ${leaf}`).not.toContain(leaf);
		} finally {
			for (const s of streams) s.close();
			await agent.disconnect();
			await cp.close();
		}
	}, 60_000);

	it("字符串、数字、布尔类型的 secret 参数行为不变", async () => {
		const cp = await startTestControlPlane();
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		try {
			const api = new ApiClient(cp);
			await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
			const id = await api.orchestrationWith({
				default_agent: "agent-a",
				nodes: [
					{
						id: "entry",
						kind: "entry",
						params: [
							{ name: "token", type: "string", secret: true },
							{ name: "pin", type: "number", secret: true },
							{ name: "flag", type: "boolean", secret: true },
							{ name: "user", type: "string" },
						],
					},
					{
						id: "a",
						kind: "package",
						package: "stub",
						node: "echo",
						inputs: {
							token: "${{ params.token }}",
							pin: "${{ params.pin }}",
							flag: "${{ params.flag }}",
						},
					},
				],
				edges: [{ from: "entry", to: "a", kind: "chain" }],
				packages: { stub: "1.0.0" },
			});
			const runId = await api.triggerOk(id, {
				token: "test-secret-value",
				pin: 4242,
				flag: true,
				user: "alice",
			});
			const a = await agent.nextAssign();
			expect(a.inputs).toMatchObject({ token: "test-secret-value", pin: 4242, flag: true });
			await agent.succeed(a, {
				text: "got test-secret-value pin 4242",
				list: ["test-secret-value", 4242],
			});
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			const run = await api.run(runId);
			expect(run.params).toEqual({ token: MASK, pin: MASK, flag: MASK, user: "alice" });
			expect(run.chains[0]?.nodes[1]?.outputs).toEqual({
				text: `got ${MASK} pin ${MASK}`,
				list: [MASK, MASK],
			});
		} finally {
			await agent.disconnect();
			await cp.close();
		}
	}, 60_000);
});
