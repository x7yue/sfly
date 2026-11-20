// 数值经过控制面（#450）：节点输出里的数值，控制面存下来、引用到下游节点的输入里、经接口返回，都是同一个双精度数。
// 控制面这一段只涉及 JavaScript 的 JSON.parse / JSON.stringify 和 PostgreSQL 的 jsonb（数字存成 numeric）：
// 假 Agent 上报 Python 的 json.dumps 会写出的文本，逐段比较。Agent 那一段在 agent/tests/execute.rs，
// 整条链路在 full-stack-number-roundtrip.test.ts。
//
// 控制面保存的是 JSON 里的数，不区分整数和小数，和 JavaScript 一样按双精度数处理，有三处和执行器写出的文本不同：
// 超过 2^53 的整数按最接近的双精度数保存、负零的符号丢掉、整数值的小数（3.0）下游收到的写法是 3。下面各有断言。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent, TaskStatus } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 执行器（Python）写进 output.json 的文本（`json.dumps` 的写法：1e-07、1.7976931348623157e+308、3.0、-0.0）。 */
const WRITTEN = {
	short: "60.157",
	scaled: "60.157000000000004",
	tenth: "0.1",
	tiny: "1e-07",
	long_fraction: "123456789.12345679",
	drift: "29491.727857142858",
	tiny_drift: "7.038531e-26",
	max: "1.7976931348623157e+308",
	min_subnormal: "5e-324",
	safe_int: "9007199254740991",
	big_int: "9007199254740993",
	u64_int: "18446744073709551615",
	huge_int: "1180591620717411303424",
	integral_float: "3.0",
	neg_zero: "-0.0",
} as const;
type Name = keyof typeof WRITTEN;
const NAMES = Object.keys(WRITTEN) as Name[];

/** 一串各种数量级的 17 位有效数字的数（固定的伪随机数列），整个数组是一个引用时用。 */
function series(): number[] {
	let state = 450;
	const next = () => {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		return state / 2 ** 31;
	};
	return Array.from({ length: 300 }, () => (next() * 10 ** Math.floor(next() * 25 - 12)) / 7);
}

/** 控制面保存、下游收到的值：文本按 IEEE 754 读成双精度数（JavaScript 的读法是精确的），负零的符号丢掉。 */
const kept = (name: Name): number => {
	const value = Number(WRITTEN[name]);
	return Object.is(value, -0) ? 0 : value;
};

const REF = (name: string) => `\${{ nodes.a.outputs.${name} }}`;

describe("数值经过控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let db: pg.Client;
	let agent: FakeAgent;
	let runId: string;
	let assigned: Record<string, unknown>;
	let assignedText: string;
	const chain = series();

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		await publishPackage(cp, "stub", "1.0.0", {
			echo: [...NAMES, "series", "nested"],
		});
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 2 }, { clock: cp.clock });
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
				{
					id: "b",
					kind: "package",
					package: "stub",
					node: "echo",
					inputs: {
						// 整值引用：输入值恰好是一个引用，保持原类型
						whole: Object.fromEntries(NAMES.map((name) => [name, REF(name)])),
						// 内嵌引用：引用夹在字符串里，按字符串拼接
						embedded: Object.fromEntries(NAMES.map((name) => [name, `x=${REF(name)}`])),
						// 整个数组、整个对象是一个引用
						series: REF("series"),
						nested: REF("nested"),
					},
				},
			],
			edges: [
				{ from: "entry", to: "a", kind: "chain" },
				{ from: "a", to: "b", kind: "chain" },
			],
			packages: { stub: "1.0.0" },
		});
		runId = await api.triggerOk(id);

		const a = await agent.nextAssign();
		const outputsJson = `{${[
			...NAMES.map((name) => `"${name}":${WRITTEN[name]}`),
			`"series":[${chain.map(String).join(", ")}]`,
			`"nested":{"a":{"b":[${WRITTEN.short}, ${WRITTEN.scaled}, {"c":${WRITTEN.drift}}]}}`,
		].join(", ")}}`;
		await agent.report({
			taskId: a.taskId,
			attempt: a.attempt,
			status: TaskStatus.SUCCESS,
			outputsJson,
		});
		const b = await agent.nextAssign();
		assigned = b.inputs;
		assignedText = b.inputsJson;
		await agent.succeed(b);
	});
	afterEach(async () => {
		await agent.disconnect();
		await db.end();
		await cp.close();
	});

	it("接口返回的输出：和执行器写出的是同一个双精度数", async () => {
		const outputs = (await api.node(runId, "a")).outputs ?? {};
		expect(NAMES.map((name) => [name, outputs[name]])).toEqual(
			NAMES.map((name) => [name, kept(name)]),
		);
		expect(outputs.series).toEqual(chain);
		expect(outputs.nested).toEqual({
			a: { b: [kept("short"), kept("scaled"), { c: kept("drift") }] },
		});
		// 响应原文里是最短表示，Python 的 json.loads 读出同一个数
		const text = await (await cp.fetch(`/runs/${runId}`)).text();
		expect(text).toContain('"scaled":60.157000000000004');
		expect(text).toContain('"drift":29491.727857142858');
		expect(text).toContain('"tiny_drift":7.038531e-26');
		expect(text).toContain('"min_subnormal":5e-324');
		expect(text).toContain('"max":1.7976931348623157e+308');
	});

	it("数据库里的 jsonb：数字存成 numeric，读出来是同一个双精度数", async () => {
		const { rows } = await db.query<{ outputs: string }>(
			"select outputs::text as outputs from tasks where node_id = 'a'",
		);
		const outputs = JSON.parse(rows[0]?.outputs ?? "{}") as Record<string, unknown>;
		expect(NAMES.map((name) => [name, outputs[name]])).toEqual(
			NAMES.map((name) => [name, kept(name)]),
		);
		expect(outputs.series).toEqual(chain);
	});

	it("整值引用：下游收到的输入和上游写出的是同一个双精度数", () => {
		const whole = assigned.whole as Record<string, unknown>;
		expect(NAMES.map((name) => [name, whole[name]])).toEqual(
			NAMES.map((name) => [name, kept(name)]),
		);
		// inputs_json 的原文：Agent 把它写进 task.json，Python 读出同一个数
		expect(assignedText).toContain('"scaled":60.157000000000004');
		expect(assignedText).toContain('"drift":29491.727857142858');
		expect(assignedText).toContain('"tiny_drift":7.038531e-26');
	});

	it("内嵌在字符串里的引用：数写成 JavaScript 的数转字符串的格式，读回来是同一个数", () => {
		const embedded = assigned.embedded as Record<string, string>;
		expect(NAMES.map((name) => [name, embedded[name]])).toEqual(
			NAMES.map((name) => [name, `x=${String(kept(name))}`]),
		);
		expect(NAMES.map((name) => [name, Number((embedded[name] ?? "").slice(2))])).toEqual(
			NAMES.map((name) => [name, kept(name)]),
		);
	});

	it("整个数组、整个对象是一个引用：里面每个数都不变", () => {
		expect(assigned.series).toEqual(chain);
		expect(assigned.nested).toEqual({
			a: { b: [kept("short"), kept("scaled"), { c: kept("drift") }] },
		});
	});

	it("和执行器写出的文本不同的三处：超过 2^53 的整数、负零、整数值的小数", async () => {
		const outputs = (await api.node(runId, "a")).outputs ?? {};
		// 2^53 + 1 在双精度里不存在，保存的是最接近的 2^53（偶数舍入）；超过 u64 的整数同样取最接近的双精度数
		expect(outputs.big_int).toBe(9007199254740992);
		expect(outputs.u64_int).toBe(18446744073709552000);
		expect(outputs.huge_int).toBe(2 ** 70);
		// 负零保存成 0
		expect(Object.is(outputs.neg_zero, 0)).toBe(true);
		// 整数值的小数下游收到的写法是整数（JSON 里 3.0 和 3 是同一个数）；1e21 起 JavaScript 写成带指数的写法
		expect(assignedText).toMatch(/"integral_float":3[,}]/);
		expect(assignedText).toMatch(/"neg_zero":0[,}]/);
		expect(assignedText).toContain('"huge_int":1.1805916207174113e+21');
		expect(assignedText).toContain('"u64_int":18446744073709552000');
	});
});
