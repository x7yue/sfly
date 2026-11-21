// 全栈（#450）：节点输出里的数值经过平台，下游节点和接口读到的是同一个双精度数。
// 真实的控制面、真实的 Rust Agent 和 SDK 执行器；节点包是 testdata/number-package：一个节点写出一组有代表性的数值，
// 下一个节点把收到的数值用 `类型名:repr` 写回去（字符串经过平台不会变），测试逐段比较：
//
//   节点写出 → SDK 写 output.json → Agent 读它并上报 → 控制面存进 jsonb → GET /runs/:id（HTTP 与命令行）
//   → 引用解析（整值引用、内嵌在字符串里的引用、整个对象 / 数组的引用）→ inputs_json → Agent 写 task.json → 下游节点
//
// 平台的约定（docs/guide/sdk-reference.md「输出」）：数值按双精度数处理，往返后是同一个数。三处例外，下面各有一个用例逐项断言：
// - 超过 2^53 的整数按最接近的双精度数保存；写法保留到 1e21，再大的写成带指数的小数，下游收到的是 float；
// - 负零的符号丢掉（jsonb 里没有负零）；
// - 整数值的小数（3.0）到下游是整数 3（JSON 里没有区别）。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { sfly } from "./support/sfly-cli.js";
import { publishTestPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 节点包 `emit` 写出的数值（CASES 的键）；节点包改了这里要跟着改。 */
const NAMES = [
	"short",
	"negative",
	"tenth",
	"tiny",
	"long_fraction",
	"sum",
	"scaled",
	"drift",
	"tiny_drift",
	"max",
	"min_subnormal",
	"safe_int",
	"big_int",
	"u64_int",
	"huge_int",
	"integral_float",
	"neg_zero",
];

/** 验收清单里的值：节点包里这些名称对应的 JSON 文本必须是这些。 */
const REQUIRED: Record<string, string> = {
	short: "60.157",
	tenth: "0.1",
	tiny: "1e-7",
	long_fraction: "123456789.123456789",
	big_int: "9007199254740993",
	neg_zero: "-0.0",
};

/** 平台保存之后的值：和节点写出的是同一个双精度数，负零的符号丢掉。 */
function stored(text: string): number {
	const value = Number(text);
	return Object.is(value, -0) ? 0 : value;
}

/**
 * 下游节点（Python）收到的类型：控制面写出的整数（不带小数点和指数）里，Agent 只把放得进 64 位整数的读成整数，
 * 其余（超过 2^64 - 1，或小于 -2^63）读成浮点数；其他的数是 float。
 */
function pythonType(value: number): "int" | "float" {
	const integral = Number.isInteger(value) && Math.abs(value) < 1e21;
	return integral && value < 2 ** 64 && value >= -(2 ** 63) ? "int" : "float";
}

/** 从 `类型名:repr` 读出下游节点收到的数。 */
function received(description: unknown): { type: string; value: number } {
	if (typeof description !== "string") throw new Error(`不是 类型名:repr：${String(description)}`);
	const colon = description.indexOf(":");
	return { type: description.slice(0, colon), value: Number(description.slice(colon + 1)) };
}

/** 下游节点收到的数，换成 `[类型, 值]` 方便整体比较（`Object.is` 区分 0 和 -0，toEqual 也是）。 */
function asReceived(description: unknown): [string, number] {
	const { type, value } = received(description);
	return [type, value];
}

function expectedReceived(value: number): [string, number] {
	return [pythonType(value), value];
}

/** 数值的列表，找出不同的：失败信息里一眼看出是第几个、各是什么。 */
function mismatches(actual: unknown[], expected: unknown[]): [number, unknown, unknown][] {
	return expected.flatMap((value, i): [number, unknown, unknown][] =>
		Object.is(actual[i], value) ? [] : [[i, actual[i], value]],
	);
}

function outputsOf(node: { outputs: Record<string, unknown> | null }): Record<string, unknown> {
	if (!node.outputs) throw new Error("节点没有输出");
	return node.outputs;
}

describeWithAgent("全栈：数值经过平台", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let api: ApiClient;
	let runId: string;
	let emitted: Record<string, unknown>;
	let inspected: Record<string, unknown>;
	let texts: Record<string, string>;
	/** 期望：节点写出的 `series`（来自 Python 的 repr，也是 JSON，JavaScript 解析是对的）。 */
	let series: number[];

	beforeAll(async () => {
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv({ sdkOnly: true })]);
		await publishTestPackage(cp, "testdata/number-package", "sfly-numbers-0.1.0.sflypkg");
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "numbers",
			venv: venv.path,
			bin: agentBinary(),
		});
		api = new ApiClient(cp);
		const ref = (name: string) => `\${{ nodes.emit.outputs.${name} }}`;
		const id = await api.orchestrationWith({
			default_agent: "numbers",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "emit", kind: "package", package: "sfly-numbers", node: "emit" },
				{
					id: "inspect",
					kind: "package",
					package: "sfly-numbers",
					node: "inspect_numbers",
					inputs: {
						// 整值引用：输入值恰好是一个引用，保持原类型
						whole: Object.fromEntries(NAMES.map((name) => [name, ref(name)])),
						// 内嵌引用：引用夹在字符串里，按字符串拼接
						embedded: Object.fromEntries(NAMES.map((name) => [name, `x=${ref(name)}`])),
						// 整个对象、整个数组是一个引用
						nested: ref("nested"),
						series: ref("series"),
					},
				},
			],
			edges: [
				{ from: "entry", to: "emit", kind: "chain" },
				{ from: "emit", to: "inspect", kind: "chain" },
			],
			packages: { "sfly-numbers": "0.1.0" },
		});
		runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 120_000);
		emitted = outputsOf(await api.node(runId, "emit"));
		inspected = outputsOf(await api.node(runId, "inspect"));
		texts = emitted.texts as Record<string, string>;
		series = JSON.parse((emitted.reprs as Record<string, string>).series as string) as number[];
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
	});

	it("节点包写出的值：包含验收清单里的，名称与这里列的一致", () => {
		expect(Object.keys(texts).sort()).toEqual([...NAMES].sort());
		expect(texts).toMatchObject(REQUIRED);
		expect(series).toHaveLength(300);
	});

	it("接口返回的输出和节点写出的是同一个双精度数（SDK 写 → Agent 上报 → jsonb → HTTP）", () => {
		const actual = NAMES.map((name) => emitted[name]);
		const expected = NAMES.map((name) => stored(texts[name] as string));
		expect(mismatches(actual, expected)).toEqual([]);
		expect(mismatches(emitted.series as number[], series)).toEqual([]);
		expect(emitted.nested).toEqual({
			a: {
				b: [
					stored(texts.short as string),
					stored(texts.sum as string),
					{ c: stored(texts.drift as string) },
				],
			},
		});
	});

	it("命令行读到的和接口返回的相同（sfly api 原样输出响应）", async () => {
		const result = await sfly(["api", "GET", `/runs/${runId}`, "--server", cp.httpUrl]);
		expect(result.code).toBe(0);
		const run = JSON.parse(result.stdout) as {
			chains: { nodes: { node_id: string; outputs: Record<string, unknown> | null }[] }[];
		};
		const outputs = outputsOf(
			run.chains[0]?.nodes.find((n) => n.node_id === "emit") ?? { outputs: null },
		);
		expect(
			mismatches(
				NAMES.map((name) => outputs[name]),
				NAMES.map((name) => emitted[name]),
			),
		).toEqual([]);
		expect(mismatches(outputs.series as number[], series)).toEqual([]);
	}, 60_000);

	it("整值引用：下游节点收到的和上游写出的是同一个数，类型也一样", () => {
		const whole = inspected.whole as Record<string, unknown>;
		const actual = NAMES.map((name) => asReceived(whole[name]));
		const expected = NAMES.map((name) => expectedReceived(stored(texts[name] as string)));
		expect(actual).toEqual(expected);
	});

	it("内嵌在字符串里的引用：写成 JavaScript 的数转字符串的格式，读回来是同一个数", () => {
		const embedded = inspected.embedded as Record<string, string>;
		const expected = NAMES.map((name) => `x=${String(stored(texts[name] as string))}`);
		expect(NAMES.map((name) => embedded[name])).toEqual(expected);
		// 这个写法 Python 的 float() 也读得回来，读回来的是同一个数
		const parsed = NAMES.map((name) => Number((embedded[name] as string).slice(2)));
		expect(
			mismatches(
				parsed,
				NAMES.map((name) => stored(texts[name] as string)),
			),
		).toEqual([]);
	});

	it("整个对象、整个数组是一个引用：里面每个数都不变", () => {
		const leaves = (inspected.nested as { a: { b: [string, string, { c: string }] } }).a.b;
		expect([leaves[0], leaves[1], leaves[2].c].map(asReceived)).toEqual(
			["short", "sum", "drift"].map((name) => expectedReceived(stored(texts[name] as string))),
		);
		const actual = (inspected.series as unknown[]).map(asReceived);
		expect(actual).toHaveLength(series.length);
		expect(
			actual.flatMap(([, value], i) =>
				Object.is(value, series[i]) ? [] : [[i, value, series[i]]],
			),
		).toEqual([]);
		expect(actual.every(([type]) => type === "float")).toBe(true);
	});

	it("超过 2^53 的整数：按最接近的双精度数保存，超过 1e21 的写成带指数的小数", () => {
		expect(emitted.safe_int).toBe(9007199254740991);
		// 2^53 + 1 在双精度里不存在，保存的是 2^53
		expect(emitted.big_int).toBe(9007199254740992);
		expect(emitted.u64_int).toBe(18446744073709552000);
		expect(emitted.huge_int).toBe(2 ** 70);
		const whole = inspected.whole as Record<string, unknown>;
		expect(asReceived(whole.safe_int)).toEqual(["int", 9007199254740991]);
		expect(asReceived(whole.big_int)).toEqual(["int", 9007199254740992]);
		// 控制面写出的 18446744073709552000 超过 u64 的上限（2^64 - 1）：Agent 读成浮点数，下游收到的是 float
		expect(asReceived(whole.u64_int)).toEqual(["float", 18446744073709552000]);
		expect(asReceived(whole.huge_int)).toEqual(["float", 2 ** 70]);
	});

	it("负零的符号丢掉：保存的和下游收到的都是 0；整数值的小数到下游是整数", () => {
		expect(Object.is(emitted.neg_zero, 0)).toBe(true);
		const whole = inspected.whole as Record<string, unknown>;
		expect(asReceived(whole.neg_zero)).toEqual(["int", 0]);
		expect(asReceived(whole.integral_float)).toEqual(["int", 3]);
	});

	// JSON 里没有 NaN 和无穷：节点写出这样的值，任务失败（不是写成别的数、也不是悄悄变成 null）。
	it.each(["nan", "inf", "-inf"])("节点输出 %s：任务失败，下游不执行", async (kind) => {
		const id = await api.orchestrationWith({
			default_agent: "numbers",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "kind", type: "string", required: true }] },
				{
					id: "bad",
					kind: "package",
					package: "sfly-numbers",
					node: "emit_nan",
					inputs: { kind: "${{ params.kind }}" },
				},
			],
			edges: [{ from: "entry", to: "bad", kind: "chain" }],
			packages: { "sfly-numbers": "0.1.0" },
		});
		const failedRun = await api.triggerOk(id, { kind });
		await eventually(async () => expect((await api.run(failedRun)).status).toBe("failed"), 60_000);
		const bad = await api.node(failedRun, "bad");
		expect(bad.outputs).toBeNull();
		expect(bad.error?.kind).toBe("node_error");
		// 错误信息写明是哪个输出、怎么办（#481）：不是看不出原因的「执行器异常退出（exit status: 0）」。
		const shown = { nan: "NaN", inf: "Infinity", "-inf": "-Infinity" }[kind];
		expect(bad.error?.message).toMatch(
			new RegExp(
				`^NodeOutputError: 节点返回值不能序列化为 JSON：输出 x 的值是 ${shown}。` +
					"JSON 里没有 NaN 和无穷，换成 None（表示没有值），或者换成字符串（例如 str\\(值\\)）再返回\n",
			),
		);
		expect(bad.error?.message).not.toContain("执行器异常退出");
	}, 120_000);
});
