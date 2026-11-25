// 对象和数组类型的 secret 参数，以及字符串、数字、布尔类型的 secret 参数（#479）：按 docs/SEMANTICS.md §2.1 的六条规则，
// 运行视图、列表、事件流、日志、动作里不出现它们的值（对象里不少于 4 个字符的叶子按值打码，更短的叶子只在整个对象被原样写出时
// 随整段盖住），secret 参数本身整个换成掩码；节点收到的输入仍是原值；打码不改变没有被打码的值的类型。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
// HTTP API + SSE + 假 Agent + 真实 PostgreSQL。值都是明显的假值。
import { runsApi } from "@sfly/schema";
import { describe, expect, it, vi } from "vitest";
import { ApiClient, type RunView } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { createPresetOk } from "./support/presets.js";
import {
	BEYOND_I64,
	pythonJson,
	pythonNumberText,
	pythonRepr,
	serdeNumberText,
	sortKeysDeep,
	taskFileJson,
} from "./support/secret-forms.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MASK = "******";
const LEAVES = ["test-leaf-one", "test-leaf-two", "test-leaf-three", "test-leaf-four"];
/** 对象里的数字叶子：写出来不少于 4 个字符，按值打码（挑了一个不会碰巧出现在时间戳、ID 里的数）。 */
const NUMBER_LEAF = 8260413;
const OPTS = {
	key: "test-leaf-one",
	nested: { deep: "test-leaf-two", list: ["test-leaf-three"] },
	port: NUMBER_LEAF,
};
const ARRAY = ["test-leaf-four", ["test-leaf-one"]];
/** 任何一个出口的文本里都不能出现的：字符串叶子和数字叶子。 */
const LEAKS = [...LEAVES, String(NUMBER_LEAF)];

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

interface Plane {
	cp: TestControlPlane;
	api: ApiClient;
	agent: FakeAgent;
}

/** 起一个控制面和一个假 Agent（`clock`：动作的时间用），发布 stub 包，跑完之后清理。 */
async function withPlane(
	fn: (plane: Plane) => Promise<void>,
	options: { logger?: boolean } = {},
): Promise<void> {
	const cp = await startTestControlPlane(options);
	const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
	try {
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await fn({ cp, api: new ApiClient(cp), agent });
	} finally {
		await agent.disconnect();
		await cp.close();
	}
}

interface ParamDecl {
	name: string;
	type: "string" | "number" | "boolean" | "json";
	secret?: boolean;
	default?: unknown;
}

/** entry(params) → 节点 a、b、c…（依次相连，每个把入口参数都当输入）。 */
const chainScenario = (params: ParamDecl[], nodes: string[] = ["a"]) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params },
		...nodes.map((id) => ({
			id,
			kind: "package",
			package: "stub",
			node: "echo",
			inputs: Object.fromEntries(params.map((p) => [p.name, `\${{ params.${p.name} }}`])),
		})),
	],
	edges: ["entry", ...nodes].slice(1).map((to, i) => ({
		from: ["entry", ...nodes][i],
		to,
		kind: "chain",
	})),
	packages: { stub: "1.0.0" },
});

/** 等一个任务的日志写够 `count` 行，返回每一行的文字（日志是异步写入的）。 */
async function logTexts(api: ApiClient, taskId: string, count: number): Promise<string[]> {
	let texts: string[] = [];
	await eventually(async () => {
		const page = await api.getJson<{ lines: Array<{ text: string }> }>(`/tasks/${taskId}/logs`);
		texts = page.lines.map((l) => l.text);
		expect(texts).toHaveLength(count);
	});
	return texts;
}

/** 运行视图按契约解析（schema 不认的形状会抛错），返回解析前的 JSON。 */
async function parsedRun(api: ApiClient, runId: string): Promise<RunView> {
	const body = await api.getJson<unknown>(`/runs/${runId}`);
	runsApi.get.response.parse(body);
	return body as RunView;
}

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
				// 节点收到的对象（键按字节序排好，和真实的 Agent 一样）原样写出来：整段换成一个掩码。
				[1, `opts=${JSON.stringify(a.inputs.opts)}`],
				[2, "leaf test-leaf-two and test-leaf-three"],
				[3, `array ${JSON.stringify(ARRAY)}`],
				[4, `escaped ${JSON.stringify("test-leaf-one")}`],
				// 键的顺序既不是节点收到的（排好序的），也不是参数里写的（整段对不上）：字符串叶子照样换掉，不少于 4 个字符的数字叶子也按值打码。
				[5, `reordered ${JSON.stringify({ port: OPTS.port, nested: OPTS.nested, key: OPTS.key })}`],
			]);
			agent.progress(a, 1, 2, "using test-leaf-one");
			await agent.succeed(a, {
				echoed: OPTS,
				again: ARRAY,
				text: "got test-leaf-three",
				port: NUMBER_LEAF,
			});

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
			expect(nodeA?.outputs).toEqual({
				echoed: MASK,
				again: MASK,
				text: `got ${MASK}`,
				port: MASK,
			});
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
				`reordered {"port":${MASK},"nested":{"deep":"${MASK}","list":["${MASK}"]},"key":"${MASK}"}`,
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
				for (const leaf of LEAKS) expect(body, `${what}：不能出现 ${leaf}`).not.toContain(leaf);
			}

			// 事件流：运行视图的第一条、任务日志的实时推送。
			const events = await SseClient.open(cp, `/runs/${runId}/events`);
			streams.push(events);
			const first = JSON.stringify((await events.next("run")).data);
			for (const leaf of LEAKS) expect(first, `运行的事件流：不能出现 ${leaf}`).not.toContain(leaf);
			expect(first).toContain(MASK);
			const live = JSON.stringify(streams[0]?.received);
			for (const leaf of LEAKS)
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
			for (const leaf of LEAKS) expect(stored, `日志文件：不能出现 ${leaf}`).not.toContain(leaf);
		} finally {
			for (const s of streams) s.close();
			await agent.disconnect();
			await cp.close();
		}
	}, 60_000);

	it("字符串、数字、布尔类型的 secret 参数：按值打码，不论多短；字符串另外认 JSON 转义和 \\uXXXX 的写法，数字、布尔和以前一样", async () => {
		await withPlane(async ({ api, agent }) => {
			const id = await api.orchestrationWith(
				chainScenario([
					{ name: "token", type: "string", secret: true },
					{ name: "short", type: "string", secret: true },
					{ name: "quoted", type: "string", secret: true },
					{ name: "zh", type: "string", secret: true },
					{ name: "pin", type: "number", secret: true },
					{ name: "flag", type: "boolean", secret: true },
					{ name: "user", type: "string" },
				]),
			);
			const values = {
				token: "test-secret-value",
				short: "ab",
				quoted: 'test-"quoted"-value',
				zh: "口令一二三",
				pin: 4242,
				flag: true,
				user: "alice",
			};
			const runId = await api.triggerOk(id, values);
			const a = await agent.nextAssign();
			expect(a.inputs).toMatchObject(values);
			const written = { q: values.quoted, zh: values.zh };
			const lines = [
				"token=test-secret-value short=ab",
				// JSON 里引号是转义的；非 ASCII 原样（JSON.stringify）
				`json ${JSON.stringify(written)}`,
				// Python 的 json.dumps 默认：非 ASCII 写成 \uXXXX
				`ascii ${pythonJson(written)}`,
				"user alice pin 4242 flag true",
			];
			agent.logs(
				a,
				lines.map((text, i) => [i + 1, text]),
			);
			await agent.succeed(a, {
				text: "got test-secret-value pin 4242",
				list: ["test-secret-value", 4242],
				short: "x ab y",
				flag: true,
				other: false,
			});
			expect(await logTexts(api, a.taskId, lines.length)).toEqual([
				`token=${MASK} short=${MASK}`,
				`json {"q":"${MASK}","zh":"${MASK}"}`,
				`ascii {"q": "${MASK}", "zh": "${MASK}"}`,
				`user alice pin ${MASK} flag ${MASK}`,
			]);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			const run = await parsedRun(api, runId);
			expect(run.params).toEqual({
				token: MASK,
				short: MASK,
				quoted: MASK,
				zh: MASK,
				pin: MASK,
				flag: MASK,
				user: "alice",
			});
			// 数字、布尔和以前一样：整个等于 secret 值时换成掩码，不相等的布尔不动。
			expect(run.chains[0]?.nodes[1]?.outputs).toEqual({
				text: `got ${MASK} pin ${MASK}`,
				list: [MASK, MASK],
				short: `x ${MASK} y`,
				flag: MASK,
				other: false,
			});
		});
	}, 60_000);

	const CONFIG = {
		env: "prod",
		region: "a",
		user: "admin",
		enabled: "1",
		zh: "好",
		opts: { on: true, k: "x" },
	};

	it("规则 3：短叶子不单独打码，整个对象被原样写出时整段盖住（评审用的那份配置，日志读出来仍然读得懂）", async () => {
		await withPlane(async ({ api, agent }) => {
			const id = await api.orchestrationWith(
				chainScenario([{ name: "cfg", type: "json", secret: true }]),
			);
			const runId = await api.triggerOk(id, { cfg: CONFIG });
			const a = await agent.nextAssign();
			// 节点收到的对象键是排好序的（和真实的 Agent 一样，agent/src/executor.rs 的 serde_json 对象是 BTreeMap）：它原样写出来的就是这个顺序。
			const received = a.inputs.cfg as typeof CONFIG;
			expect(received).toEqual(CONFIG);
			const lines = [
				"loading env=prod region=a user=admin enabled=1",
				// json.dumps(cfg)（默认）、ensure_ascii=False、紧凑的 separators、sort_keys=True：整段都要盖住，
				// 里面短的叶子（`1`、`a`、`好`、`x`）一个都不能留下明文。
				`cfg=${pythonJson(received)}`,
				`cfg=${pythonJson(received, false)}`,
				`cfg=${JSON.stringify(received)}`,
				`cfg=${pythonJson(sortKeysDeep(CONFIG), false)}`,
				`cfg=${pythonRepr(received)}`,
				"region is a and enabled is 1; took 1 s, 1 retry",
			];
			agent.logs(
				a,
				lines.map((text, i) => [i + 1, text]),
			);
			await agent.succeed(a, {
				region: "a",
				count: 1,
				on: true,
				cfg: received,
				text: "env prod",
			});
			expect(await logTexts(api, a.taskId, lines.length)).toEqual([
				`loading env=${MASK} region=a user=${MASK} enabled=1`,
				`cfg=${MASK}`,
				`cfg=${MASK}`,
				`cfg=${MASK}`,
				`cfg=${MASK}`,
				// print(dict)：整段对不上，不少于 4 个字符的叶子各自打码，短的原样。
				`cfg=${pythonRepr(received).replace("prod", MASK).replace("admin", MASK)}`,
				"region is a and enabled is 1; took 1 s, 1 retry",
			]);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			const run = await parsedRun(api, runId);
			expect(run.params).toEqual({ cfg: MASK });
			expect(run.chains[0]?.nodes[1]?.outputs).toEqual({
				region: "a",
				count: 1,
				on: true,
				cfg: MASK,
				text: `env ${MASK}`,
			});
		});
	}, 60_000);

	it("规则 3：对象里不少于 4 个字符的数字叶子按值打码（节点常见的写法下都是），更短的数字不单独打码", async () => {
		await withPlane(async ({ api, agent }) => {
			const id = await api.orchestrationWith(
				chainScenario([{ name: "nums", type: "json", secret: true }]),
			);
			const runId = await api.triggerOk(id, {
				nums: { pin: NUMBER_LEAF, port: 80, host: "db.internal", ratio: 1.5 },
			});
			const a = await agent.nextAssign();
			const received = a.inputs.nums as Record<string, unknown>;
			// 键倒过来：既不是节点收到的顺序（排好序的），也不是参数里写的顺序，整段对不上。
			const reversedKeys = Object.fromEntries(Object.entries(received).reverse());
			const indented = JSON.stringify(received, null, 2).split("\n");
			const lines = [
				`pin=${NUMBER_LEAF} port=80 ratio=1.5`,
				// json.dumps 默认（", "、": " 分隔）：整段盖住
				`nums=${pythonJson(received)}`,
				// 键的顺序变了，整段对不上，叶子各自打码（短的叶子留着）
				`nums=${pythonRepr(reversedKeys)}`,
				`nums=${JSON.stringify(reversedKeys)}`,
				// sort_keys=True：就是节点收到的顺序，整段盖住
				`nums=${pythonJson(sortKeysDeep(received), false)}`,
				// indent=2：一行一个叶子
				...indented,
			];
			agent.logs(
				a,
				lines.map((text, i) => [i + 1, text]),
			);
			await agent.succeed(a, {
				pin: NUMBER_LEAF,
				port: 80,
				ratio: 1.5,
				host: "db.internal",
				summary: pythonJson(received),
			});
			const leafwise = (text: string) =>
				text.replaceAll(String(NUMBER_LEAF), MASK).replaceAll("db.internal", MASK);
			expect(await logTexts(api, a.taskId, lines.length)).toEqual([
				`pin=${MASK} port=80 ratio=1.5`,
				`nums=${MASK}`,
				leafwise(`nums=${pythonRepr(reversedKeys)}`),
				leafwise(`nums=${JSON.stringify(reversedKeys)}`),
				`nums=${MASK}`,
				...indented.map(leafwise),
			]);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			const run = await parsedRun(api, runId);
			expect(run.chains[0]?.nodes[1]?.outputs).toEqual({
				pin: MASK,
				port: 80,
				ratio: 1.5,
				host: MASK,
				summary: MASK,
			});
		});
	}, 60_000);

	it("规则 3：没有内容的容器不打码；节点整个输出就是收到的 secret 对象时输出仍是对象；运行在每个状态下的响应都符合契约", async () => {
		await withPlane(async ({ api, agent }) => {
			const params: ParamDecl[] = [
				{ name: "opts", type: "json", secret: true },
				{ name: "token", type: "string", secret: true },
				...["e1", "e2", "e3", "e4", "e5"].map((name) => ({
					name,
					type: "json" as const,
					secret: true,
				})),
			];
			const id = await api.orchestrationWith(chainScenario(params, ["a", "b", "c", "d"]));
			// 没有任何可打码内容的值：`{}`、`[]`、`[[]]`、只有空串、只有空值。
			const empties = { e1: {}, e2: [], e3: [[]], e4: { k: "" }, e5: { n: null } };
			const triggerParams = { opts: OPTS, token: "test-secret-value", ...empties };
			const everyoneMasked = {
				opts: MASK,
				token: MASK,
				e1: MASK,
				e2: MASK,
				e3: MASK,
				e4: MASK,
				e5: MASK,
			};
			/** 运行视图：按契约解析，里面没有任何叶子，参数是掩码（secret 参数本身读出来是掩码）。 */
			const check = async (runId: string, status: string) => {
				const run = await parsedRun(api, runId);
				expect(run.status).toBe(status);
				expect(run.params).toEqual(everyoneMasked);
				const text = JSON.stringify(run);
				for (const leak of LEAKS) expect(text, `${status}：不能出现 ${leak}`).not.toContain(leak);
				return run;
			};

			// 运行 1：a 的整个输出就是收到的对象；b 的输出里有各种空容器；c 的整个输出是 `{}`；d 失败。
			const runId = await api.triggerOk(id, triggerParams);
			const a = await agent.nextAssign();
			expect(a.inputs).toMatchObject({ opts: OPTS, ...empties });
			await check(runId, "running");
			await agent.succeed(a, a.inputs.opts as Record<string, unknown>);
			const b = await agent.nextAssign();
			await agent.succeed(b, {
				...empties,
				empty: {},
				text: "got test-secret-value and {} and []",
			});
			const c = await agent.nextAssign();
			await agent.succeed(c, {});
			const d = await agent.nextAssign();
			// 整个对象按收到的样子（键按字节序排好）原样写出：整段换成一个掩码。
			await agent.fail(
				d,
				`bad test-leaf-one ${JSON.stringify(a.inputs.opts)} and {}`,
				undefined,
				undefined,
				"load_config 第 3 行 test-leaf-two",
			);
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			const failed = await check(runId, "failed");
			const [, nodeA, nodeB, nodeC, nodeD] = failed.chains[0]?.nodes ?? [];
			// 整个输出等于 secret 对象：输出仍是对象（契约要求），里面的值逐个打码。
			expect(nodeA?.outputs).toEqual({
				key: MASK,
				nested: { deep: MASK, list: [MASK] },
				port: MASK,
			});
			// 空容器不打码：`{}`、`[]` 照常出现，只有真的 secret 值换成掩码。
			expect(nodeB?.outputs).toEqual({
				...empties,
				empty: {},
				text: `got ${MASK} and {} and []`,
			});
			expect(nodeC?.outputs).toEqual({});
			expect(nodeD?.error?.message).toBe(`bad ${MASK} ${MASK} and {}`);
			expect(nodeD?.error?.location).toBe(`load_config 第 3 行 ${MASK}`);

			// 运行 2：全部成功。
			const second = await api.triggerOk(id, triggerParams);
			for (const _ of ["a", "b", "c", "d"]) await agent.succeed(await agent.nextAssign(), {});
			await eventually(async () => expect((await api.run(second)).status).toBe("success"));
			await check(second, "success");

			// 运行 3：取消。
			const third = await api.triggerOk(id, triggerParams);
			const held = await agent.nextAssign();
			await api.cancelOk(third);
			await agent.nextCancel();
			await agent.cancelled(held);
			await eventually(async () => expect((await api.run(third)).status).toBe("cancelled"));
			await check(third, "cancelled");
		});
	}, 90_000);

	it("规则 4：多行的 secret 值（一段 PEM）：整段、每个不少于 4 个字符的行都打码，短的行不单独打码", async () => {
		await withPlane(async ({ api, agent }) => {
			const pem = "-----BEGIN TEST KEY-----\ntest-pem-line-one\nxy\n-----END TEST KEY-----";
			const id = await api.orchestrationWith(
				chainScenario([{ name: "pem", type: "string", secret: true }], ["a", "b"]),
			);
			const runId = await api.triggerOk(id, { pem });
			const a = await agent.nextAssign();
			expect(a.inputs.pem).toBe(pem);
			const lines = [
				"-----BEGIN TEST KEY-----",
				"test-pem-line-one",
				"xy",
				"-----END TEST KEY-----",
				"loaded key test-pem-line-one ok",
			];
			agent.logs(
				a,
				lines.map((text, i) => [i + 1, text]),
			);
			await agent.succeed(a, { text: pem, first: "test-pem-line-one", n: 2 });
			const b = await agent.nextAssign();
			await agent.fail(b, "bad test-pem-line-one xy");
			expect(await logTexts(api, a.taskId, lines.length)).toEqual([
				MASK,
				MASK,
				"xy",
				MASK,
				`loaded key ${MASK} ok`,
			]);
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			const run = await parsedRun(api, runId);
			expect(run.params).toEqual({ pem: MASK });
			const [, nodeA, nodeB] = run.chains[0]?.nodes ?? [];
			expect(nodeA?.outputs).toEqual({ text: MASK, first: MASK, n: 2 });
			expect(nodeB?.error?.message).toBe(`bad ${MASK} xy`);
			expect(JSON.stringify(run)).not.toContain("test-pem-line-one");
		});
	}, 60_000);

	it("规则 6：打码不改变类型：字符串叶子不让写法相同的数字、布尔被换成掩码，映射本身也不会被整个换掉", async () => {
		await withPlane(async ({ api, agent }) => {
			const id = await api.orchestrationWith(
				chainScenario([{ name: "tags", type: "json", secret: true }]),
			);
			const runId = await api.triggerOk(id, {
				tags: { id: "1234", flag: "true", name: "test-leaf-one" },
			});
			const a = await agent.nextAssign();
			agent.logs(a, [[1, "id=1234 flag=true"]]);
			await agent.succeed(a, {
				n: 1234,
				b: true,
				f: false,
				s: "id 1234",
				list: [1234, "1234", true],
			});
			// 日志是文字：叶子 "1234"、"true" 写出来是什么就按什么打码。
			expect(await logTexts(api, a.taskId, 1)).toEqual([`id=${MASK} flag=${MASK}`]);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			const run = await parsedRun(api, runId);
			expect(run.chains[0]?.nodes[1]?.outputs).toEqual({
				n: 1234,
				b: true,
				f: false,
				s: `id ${MASK}`,
				list: [1234, MASK, true],
			});
		});
	}, 60_000);

	it("规则 4、6：动作的名称、字段、失败原因，动作摘要和此刻在做的动作里，对象里的值也打码", async () => {
		await withPlane(async ({ api, agent }) => {
			const T0 = Date.parse("2026-01-01T00:00:00.000Z");
			const id = await api.orchestrationWith(
				chainScenario([{ name: "cfg", type: "json", secret: true }]),
			);
			const runId = await api.triggerOk(id, { cfg: OPTS });
			const a = await agent.nextAssign();
			const dumped = pythonJson(a.inputs.cfg);
			const reason = `bad test-leaf-three ${dumped}`;
			agent.actions(a, [
				agent.actionStart(1, "load test-leaf-one", T0 + 1_000, {
					fields: { path: "/x/test-leaf-two", port: `p ${NUMBER_LEAF}` },
				}),
				agent.actionStart(2, "child", T0 + 2_000, { parent: 1, fields: { cfg: dumped } }),
				agent.actionEnd(2, "failed", T0 + 3_000, { reason, fields: { note: "test-leaf-one" } }),
			]);
			const running = {
				id: 1,
				parent: null,
				depth: 0,
				name: "load test-leaf-one",
				fields: { path: "/x/test-leaf-two" },
				...agent.stamp(T0 + 1_000),
			};
			const end = agent.stamp(T0 + 3_000);
			const child = {
				id: 2,
				parent: 1,
				depth: 1,
				name: "child",
				fields: { cfg: dumped },
				...agent.stamp(T0 + 2_000),
				end_ts: end.ts,
				end_mono: end.mono,
				result: "failed" as const,
				reason,
			};
			agent.actionSummary(a, {
				total: 2,
				reported: 2,
				names: [
					{
						name: "load test-leaf-one",
						total: 1,
						failed: 0,
						reported: 1,
						capped_ts: null,
						capped_mono: null,
					},
					{ name: "child", total: 1, failed: 1, reported: 1, capped_ts: null, capped_mono: null },
				],
				running: [running],
				recent: [child],
				recent_failed: [child],
			});
			await agent.sync();

			// 明细：名称、字段（键和值）、失败原因。
			const page = await api.getJson<{
				actions: Array<{
					id: number;
					name: string;
					fields: Record<string, string>;
					reason?: string | null;
				}>;
			}>(`/tasks/${a.taskId}/actions`);
			const byId = new Map(page.actions.map((d) => [d.id, d]));
			expect(byId.get(1)).toMatchObject({
				name: `load ${MASK}`,
				fields: { path: `/x/${MASK}`, port: `p ${MASK}` },
			});
			expect(byId.get(2)).toMatchObject({
				name: "child",
				fields: { cfg: MASK, note: MASK },
				reason: `bad ${MASK} ${MASK}`,
			});
			// 摘要：名称计数、正在做的、最近结束的、最近失败的。
			const summary = await api.getJson<{
				names: Array<{ name: string }>;
				running: Array<{ name: string; fields: Record<string, string> }>;
				recent: Array<{ fields: Record<string, string>; reason: string | null }>;
				recent_failed: Array<{ reason: string | null }>;
			}>(`/tasks/${a.taskId}/actions/summary`);
			expect(summary.names.map((n) => n.name)).toEqual([`load ${MASK}`, "child"]);
			expect(summary.running[0]).toMatchObject({
				name: `load ${MASK}`,
				fields: { path: `/x/${MASK}` },
			});
			expect(summary.recent[0]).toMatchObject({
				fields: { cfg: MASK },
				reason: `bad ${MASK} ${MASK}`,
			});
			expect(summary.recent_failed[0]?.reason).toBe(`bad ${MASK} ${MASK}`);
			// 运行视图里执行中的任务此刻在做的动作。
			const run = await parsedRun(api, runId);
			expect(run.chains[0]?.nodes[1]?.attempts[0]?.current_action?.name).toBe(`load ${MASK}`);
			for (const [what, body] of [
				["明细", JSON.stringify(page)],
				["摘要", JSON.stringify(summary)],
				["运行视图", JSON.stringify(run)],
			] as const) {
				for (const leak of LEAKS) expect(body, `${what}：不能出现 ${leak}`).not.toContain(leak);
			}
		});
	}, 60_000);

	it("规则 5：预检时，保密的对象里有短于 4 个字符的字符串或数字叶子：给一条警告，写明是哪个参数（入口节点还是子流程入口节点）、有几个，不写出值", async () => {
		await withPlane(async ({ api }) => {
			const main = chainScenario([
				{
					name: "cfg",
					type: "json",
					secret: true,
					default: { env: "test-env-value", region: "a", n: 1, big: 123456, off: false },
				},
				{ name: "fine", type: "json", secret: true, default: { env: "test-env-value" } },
				// 不是对象的保密参数，再短也按值打码，没有警告；没有声明保密的对象参数也没有。
				{ name: "token", type: "string", secret: true, default: "ab" },
				{ name: "plain", type: "json", default: { a: "x" } },
			]);
			// 子流程入口节点上的保密参数同样检查，警告里写「子流程入口节点」，不写成「入口节点」。
			const id = await api.orchestrationWith({
				...main,
				nodes: [
					...main.nodes,
					{ id: "x", kind: "async", params: {} },
					{
						id: "sub",
						kind: "subflow_entry",
						name: "inner",
						params: [
							{
								name: "deep",
								type: "json",
								secret: true,
								default: { k: "v", w: "test-wide-value" },
							},
						],
					},
					{ id: "s1", kind: "package", package: "stub", node: "echo" },
				],
				edges: [
					...main.edges,
					{ from: "a", to: "x", kind: "chain" },
					{ from: "x", to: "sub", kind: "dispatch" },
					{ from: "sub", to: "s1", kind: "chain" },
				],
			});
			await createPresetOk(api, id, {
				name: "预设一",
				params: [
					{ name: "cfg", value: { x: "y", "long-one": "test-leaf-one" } },
					{ name: "fine", value: { env: "test-env-value" } },
				],
			});
			const preflight = runsApi.preflight.response.parse(
				await api.getJson(`/orchestrations/${id}/preflight`),
			);
			const short = preflight.warnings.filter((w) => w.code === "secret_short_leaf");
			expect(short.map((w) => w.message)).toEqual([
				"参数 cfg（入口节点 entry）是保密的对象，默认值里有 2 个短于 4 个字符的字符串或数字：它们单独出现在日志、输出里时不会被打码（整个对象被原样写出时才会）；要保密的短值请单独做成一个保密参数",
				"参数 deep（子流程入口节点 sub）是保密的对象，默认值里有 1 个短于 4 个字符的字符串或数字：它们单独出现在日志、输出里时不会被打码（整个对象被原样写出时才会）；要保密的短值请单独做成一个保密参数",
				"运行预设「预设一」里保密参数 cfg 的值有 1 个短于 4 个字符的字符串或数字：它们单独出现在日志、输出里时不会被打码（整个对象被原样写出时才会）；要保密的短值请单独做成一个保密参数",
			]);
			expect(short.map((w) => w.node_id)).toEqual(["entry", "sub", undefined]);
			// 警告里没有值：不论是长的叶子、短的叶子还是整个对象。
			const text = JSON.stringify(preflight.warnings);
			for (const value of [
				"test-env-value",
				"test-leaf-one",
				"test-wide-value",
				"123456",
				'"a"',
				'"y"',
			]) {
				expect(text, `警告里不能出现 ${value}`).not.toContain(value);
			}
		});
	}, 60_000);

	it("数字的写法：节点（Python）打印的数字和控制面写的不一样时（小数、超出 64 位的整数），整段和叶子都盖住", async () => {
		await withPlane(async ({ api, agent }) => {
			const id = await api.orchestrationWith(
				chainScenario(
					[
						{ name: "cfg", type: "json", secret: true },
						{ name: "big", type: "json", secret: true },
						{ name: "rate", type: "number", secret: true },
					],
					["a", "b"],
				),
			);
			const small = { pin: "12", rate: 0.00001, region: "a" };
			const large = { id: BEYOND_I64, pin: "12" };
			const runId = await api.triggerOk(id, { cfg: small, big: large, rate: 0.00001 });
			const a = await agent.nextAssign();
			const cfg = a.inputs.cfg as typeof small;
			const big = a.inputs.big as typeof large;
			// 节点（Python）打印它收到的对象：json.dumps 默认、紧凑、ensure_ascii=False；数字是 Python 的写法。
			const lines = [
				`cfg=${pythonJson(cfg)}`,
				`cfg=${pythonJson(cfg, false)}`,
				`big=${pythonJson(big)}`,
				`big=${pythonJson(big, false)}`,
				`rate=${pythonNumberText(a.inputs.rate as number)} id=${pythonNumberText(big.id)}`,
				`cfg=${pythonRepr(cfg)} big=${pythonRepr(big)}`,
			];
			expect(lines[0]).toBe('cfg={"pin": "12", "rate": 1e-05, "region": "a"}');
			expect(lines[2]).toBe('big={"id": 9.876543210987654e+19, "pin": "12"}');
			agent.logs(
				a,
				lines.map((text, i) => [i + 1, text]),
			);
			await agent.succeed(a, { cfg, big, rate: a.inputs.rate });
			const b = await agent.nextAssign();
			await agent.fail(b, lines.join("; "));
			const masked = [
				`cfg=${MASK}`,
				`cfg=${MASK}`,
				`big=${MASK}`,
				`big=${MASK}`,
				`rate=${MASK} id=${MASK}`,
				// repr：单引号，整段对不上；不少于 4 个字符的叶子（数字）按值打码，短的叶子留着
				`cfg={'pin': '12', 'rate': ${MASK}, 'region': 'a'} big={'id': ${MASK}, 'pin': '12'}`,
			];
			expect(await logTexts(api, a.taskId, lines.length)).toEqual(masked);
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			const run = await parsedRun(api, runId);
			expect(run.params).toEqual({ cfg: MASK, big: MASK, rate: MASK });
			const text = JSON.stringify(run);
			for (const leak of ["1e-05", "9.876543210987654e+19", "98765432109876540000", "0.00001"]) {
				expect(text, `运行视图里不能出现 ${leak}`).not.toContain(leak);
			}
			expect(run.chains[0]?.nodes[1]?.outputs).toEqual({ cfg: MASK, big: MASK, rate: MASK });
			// 失败信息里同样的写法：和日志里同一个口径
			expect(run.chains[0]?.nodes[2]?.error?.message).toBe(masked.join("; "));
		});
	}, 60_000);

	it("节点原样打印任务文件（task.json）里的文本：小数在 serde 的写法下、两类数字混在一个对象里，整段和叶子都盖住，顶层数字不论多短都盖住", async () => {
		await withPlane(async ({ api, agent }) => {
			const id = await api.orchestrationWith(
				chainScenario(
					[
						{ name: "tiny", type: "json", secret: true },
						{ name: "mixed", type: "json", secret: true },
						{ name: "list", type: "json", secret: true },
						{ name: "rate", type: "number", secret: true },
					],
					["a", "b"],
				),
			);
			const tiny = { pin: "12", rate: 0.000001, region: "a" };
			const mixed = { id: BEYOND_I64, pin: "12", rate: 0.000025 };
			const list = ["ab", 0.000025, 7, BEYOND_I64, "x"];
			const runId = await api.triggerOk(id, { tiny, mixed, list, rate: 0.000001 });
			const a = await agent.nextAssign();
			// 节点读 SFLY_TASK 指向的 task.json 再打印它的文本：Agent 把输入解析再写出，数字是 serde 的写法。
			const taskFile = taskFileJson({ inputs: a.inputs });
			expect(taskFile).toContain('"rate":1e-6');
			expect(taskFile).toContain('"id":9.876543210987654e+19');
			expect(taskFile).toContain('["ab",0.000025,7,9.876543210987654e+19,"x"]');
			const lines = [
				taskFile,
				`tiny=${taskFileJson(a.inputs.tiny)}`,
				`mixed=${taskFileJson(a.inputs.mixed)}`,
				`list=${taskFileJson(a.inputs.list)}`,
				`rate=${serdeNumberText(a.inputs.rate as number)}`,
			];
			agent.logs(
				a,
				lines.map((text, i) => [i + 1, text]),
			);
			await agent.succeed(a, { file: taskFile, tiny: a.inputs.tiny });
			const b = await agent.nextAssign();
			await agent.fail(b, lines.join("; "));
			const texts = await logTexts(api, a.taskId, lines.length);
			expect(texts[1]).toBe(`tiny=${MASK}`);
			expect(texts[2]).toBe(`mixed=${MASK}`);
			expect(texts[3]).toBe(`list=${MASK}`);
			expect(texts[4]).toBe(`rate=${MASK}`);
			// 整个任务文件：里面每个保密值都盖住，没有留下任何一个值或短叶子的明文
			const whole = texts[0] ?? "";
			for (const leak of [
				"1e-6",
				"0.000025",
				"9.876543210987654e+19",
				'"ab"',
				'"x"',
				'"12"',
				'"a"',
			]) {
				expect(whole, `任务文件的文本里不能留下 ${leak}`).not.toContain(leak);
			}
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			const run = await parsedRun(api, runId);
			const text = JSON.stringify(run);
			for (const leak of ["1e-6", "9.876543210987654e+19", "0.000025", "0.000001"]) {
				expect(text, `运行视图里不能出现 ${leak}`).not.toContain(leak);
			}
			expect(run.params).toEqual({ tiny: MASK, mixed: MASK, list: MASK, rate: MASK });
		});
	}, 60_000);

	it("很长的 secret 值（40 KB 的字符串、40 KB 的对象、6000 个汉字）：触发成功，日志存下且已打码，运行视图读得出，控制面的错误输出里没有值", async () => {
		const cases: Array<{ name: string; type: "string" | "json"; value: unknown; text: string }> = [
			{
				name: "40 KB 的字符串",
				type: "string",
				value: `${"abcdefghij".repeat(4096)}-end`,
				text: "",
			},
			{
				name: "40 KB 的对象",
				type: "json",
				value: { blob: "k".repeat(40_000), note: "short-note-value" },
				text: "",
			},
			{ name: "6000 个汉字", type: "string", value: "口令".repeat(3000), text: "" },
		];
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const { name, type, value } of cases) {
				await withPlane(
					async ({ api, agent }) => {
						const id = await api.orchestrationWith(
							chainScenario([{ name: "big", type, secret: true }], ["a", "b"]),
						);
						const runId = await api.triggerOk(id, { big: value });
						const a = await agent.nextAssign();
						expect(a.inputs.big, name).toEqual(value);
						const printed = typeof value === "string" ? value : JSON.stringify(value);
						agent.logs(a, [
							[1, `got ${printed} done`],
							[2, "an ordinary line"],
						]);
						await agent.succeed(a, { echoed: value, text: `x ${printed} y` });
						const b = await agent.nextAssign();
						await agent.fail(b, `bad ${printed}`, undefined, undefined, `load 第 3 行 ${printed}`);

						// 日志存下了两行（不能因为打码出错丢日志），第一行已打码。
						expect(await logTexts(api, a.taskId, 2), name).toEqual([
							`got ${MASK} done`,
							"an ordinary line",
						]);
						await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
						// 运行视图读得出（200，契约解析通过），里面没有值。
						const run = await parsedRun(api, runId);
						const text = JSON.stringify(run);
						expect(run.params, name).toEqual({ big: MASK });
						const probe = typeof value === "string" ? value.slice(0, 200) : "kkkkkkkkkkkkkkkkkkkk";
						expect(text, name).not.toContain(probe);
						// 输出很大（存着的超过 16 KiB）：运行视图只给大小（#633），全文用 /tasks/:id/io 取，读到的是打码之后的。
						const node = run.chains[0]?.nodes[1];
						expect(node?.outputs, name).toBeNull();
						expect(node?.outputs_omitted_bytes ?? 0, name).toBeGreaterThan(16 * 1024);
						const io = await api.get(`/tasks/${a.taskId}/io`);
						expect(io.status, name).toBe(200);
						const full = (await io.json()) as { outputs: unknown };
						expect(full.outputs, name).toEqual({ echoed: MASK, text: `x ${MASK} y` });
						expect(JSON.stringify(full), name).not.toContain(probe);
						expect(run.chains[0]?.nodes[2]?.error?.message, name).toBe(`bad ${MASK}`);
						// 其余出口：任务日志、运行日志、下载。
						for (const path of [
							`/tasks/${a.taskId}/logs`,
							`/tasks/${a.taskId}/logs/download`,
							`/runs/${runId}/logs`,
							`/runs/${runId}/logs/download`,
						]) {
							const res = await api.get(path);
							expect(res.status, `${name} ${path}`).toBe(200);
							expect(await res.text(), `${name} ${path}`).not.toContain(probe);
						}
					},
					{ logger: true },
				);
			}
			// 控制面自己的错误输出（agent session error 之类）里没有任何一个值，打码也没有出过错。
			const output = JSON.stringify(errors.mock.calls);
			expect(output).not.toContain("abcdefghij");
			expect(output).not.toContain("kkkkkkkkkk");
			expect(output).not.toContain("口令口令");
			expect(output).not.toContain("Invalid regular expression");
		} finally {
			errors.mockRestore();
		}
	}, 180_000);
});
