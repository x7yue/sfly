// 保存和触发前预检：写错的输入名、开发版本的节点也查输入名和类型（#444，docs/SEMANTICS.md §2.4、§6、§7）。
// 节点没有声明这个输入时，执行器在运行时以 config_error 拒绝（`runner.py` 的 `_check_declared`），任务要先派发到 Agent 上
// 才知道；这里在保存时给警告、触发前阻断。锁定 `包名@dev` 的节点用在线 Agent 上报的开发版本元信息做同样的检查。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface Problem {
	code: string;
	message: string;
	node_id?: string;
	input?: string;
}

const TUNE_INPUTS = {
	properties: {
		host: { type: "string" },
		retries: { type: "integer", default: 3 },
		n: { type: "integer" },
	},
	required: ["host"],
	order: ["host", "retries", "n"],
};

/** 开发版本的元信息：节点 tune 的输入和已发布的 tuner@1.0.0 一样。 */
const devMetadata = (
	name: string,
	properties: Record<string, unknown> = TUNE_INPUTS.properties,
) => ({
	name,
	version: "dev",
	requires_python: ">=3.10",
	nodes: [
		{
			name: "tune",
			title: "调参",
			entry: `${name}:tune`,
			inputs: { type: "object", properties, required: ["host"], order: Object.keys(properties) },
			outputs: { type: "object", properties: {} },
		},
	],
});

/** Hello 里上报的开发版本。 */
const loaded = (
	name: string,
	properties?: Record<string, unknown>,
): Pick<HelloInit, "devPackages"> => ({
	devPackages: [
		{ name, source: `/src/${name}`, metadataJson: JSON.stringify(devMetadata(name, properties)) },
	],
});

const tune = (id: string, pkg: string, inputs: Record<string, unknown>) => ({
	id,
	kind: "package",
	package: pkg,
	node: "tune",
	inputs,
});

describe("写错的输入名、开发版本的节点：保存时的警告和触发前的预检", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (name: string, init: Pick<HelloInit, "devPackages"> = {}) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, ...init });
		agents.push(agent);
		return agent;
	};
	const document = (
		nodes: unknown[],
		packages: Record<string, string>,
		params: unknown[] = [],
	) => ({
		default_agent: "agent-a",
		nodes: [{ id: "entry", kind: "entry", params }, ...nodes],
		edges: nodes.map((n, i) => ({
			from: i === 0 ? "entry" : (nodes[i - 1] as { id: string }).id,
			to: (n as { id: string }).id,
			kind: "chain",
		})),
		packages,
	});
	/** 保存一份文档，返回保存的版本号和响应里的警告。 */
	const save = async (doc: unknown) => {
		const id = await api.createOrchestration("输入名");
		const res = await api.post(`/orchestrations/${id}/versions`, {
			base_version: 0,
			document: doc,
		});
		expect(res.status, await res.clone().text()).toBe(201);
		const saved = (await res.json()) as { number: number; warnings: Problem[] };
		return { id, number: saved.number, warnings: saved.warnings };
	};
	const preflight = async (id: string) =>
		(await api.getJson<{ problems: Problem[] }>(`/orchestrations/${id}/preflight`)).problems;
	const refusal = async (res: Response) => {
		expect(res.status, await res.clone().text()).toBe(400);
		return (await res.json()) as {
			error: { code: string; message: string; details: Problem[] };
		};
	};
	const runsOf = async (id: string) =>
		(await api.getJson<{ runs: unknown[] }>(`/orchestrations/${id}/runs`)).runs;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "tuner", "1.0.0", { tune: { outputs: [], inputs: TUNE_INPUTS } });
		await publishPackage(cp, "bare", "1.0.0", {
			noop: { outputs: [], inputs: { properties: {} } },
		});
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("已发布的节点包", () => {
		it("写错的输入名：保存时警告（仍然保存），触发前预检阻断；写明节点、写错的名字、声明了哪些输入，差一两个字符时问是不是想写…", async () => {
			await connect("agent-a");
			const { id, number, warnings } = await save(
				document([tune("t", "tuner", { host: "h", retires: 2 })], { tuner: "1.0.0" }),
			);
			expect(number).toBe(1);
			const message =
				"节点 t 的输入 retires 没有声明：节点类型 tune 声明的输入有 host、retries、n；是不是想写 retries？";
			expect(warnings).toEqual([
				{ code: "input_not_declared", node_id: "t", input: "retires", message },
			]);

			// 预检的问题不带 input 字段（只有 code、message、node_id）。
			const problem = { code: "input_not_declared", node_id: "t", message };
			expect(await preflight(id)).toEqual([problem]);
			const refused = await refusal(await api.trigger(id));
			expect(refused.error.code).toBe("invalid_orchestration");
			expect(refused.error.details).toEqual([problem]);
			expect(await runsOf(id)).toEqual([]);
		});

		it("差得远的名字不瞎猜，只列出声明的输入；引用写在没有声明的输入上也报", async () => {
			await connect("agent-a");
			const { warnings } = await save(
				document(
					[tune("t", "tuner", { host: "h", timeout: "${{ params.x }}" })],
					{ tuner: "1.0.0" },
					[{ name: "x", type: "string" }],
				),
			);
			expect(warnings.map((w) => w.message)).toEqual([
				"节点 t 的输入 timeout 没有声明：节点类型 tune 声明的输入有 host、retries、n；改成其中一个，或者删掉这个输入",
			]);
		});

		it("节点类型没有声明任何输入：写「不接收任何输入」", async () => {
			const { warnings } = await save(
				document([{ id: "b", kind: "package", package: "bare", node: "noop", inputs: { x: 1 } }], {
					bare: "1.0.0",
				}),
			);
			expect(warnings.map((w) => w.message)).toEqual([
				"节点 b 的输入 x 没有声明：节点类型 noop 不接收任何输入；删掉这个输入",
			]);
		});

		it("写对的输入不受影响：没有警告，预检通过，照常触发", async () => {
			await connect("agent-a");
			const { id, warnings } = await save(
				document([tune("t", "tuner", { host: "h", retries: 2 })], { tuner: "1.0.0" }),
			);
			expect(warnings).toEqual([]);
			expect(await preflight(id)).toEqual([]);
			await api.triggerOk(id);
		});
	});

	describe("开发版本（包名@dev）", () => {
		it("在线的 Agent 加载了它：写错的输入名、常量类型不符，保存时警告，触发前阻断", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			const { id, warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", retires: 2, n: "八" })], {
					"tuner-dev": "dev",
				}),
			);
			// 警告按输入在库里的键顺序排（JSONB 不保留写入的顺序），这里按输入名排好再比。
			const byInput = [...warnings].sort((a, b) => (a.input ?? "").localeCompare(b.input ?? ""));
			expect(byInput.map((w) => [w.code, w.input, w.message])).toEqual([
				["input_type_mismatch", "n", '节点 t 的输入 n 应为 integer，实际是 "八"'],
				[
					"input_not_declared",
					"retires",
					"节点 t 的输入 retires 没有声明：节点类型 tune 声明的输入有 host、retries、n；是不是想写 retries？",
				],
			]);

			expect((await preflight(id)).map((p) => p.message).sort()).toEqual(
				warnings.map((w) => w.message).sort(),
			);
			await refusal(await api.trigger(id));
			expect(await runsOf(id)).toEqual([]);
		});

		it("入口参数的值接到整数输入、值是小数：触发时拒绝，和已发布的版本一样", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			const id = (
				await save(
					document(
						[tune("t", "tuner-dev", { host: "h", n: "${{ params.n }}" })],
						{ "tuner-dev": "dev" },
						[{ name: "n", type: "number", required: true }],
					),
				)
			).id;

			const refused = await refusal(await api.trigger(id, { n: 8.5 }));
			expect(refused.error.code).toBe("invalid_params");
			expect(refused.error.details).toEqual([
				{
					code: "param_input_type_mismatch",
					node_id: "t",
					message:
						"节点 t 的输入 n 应为 integer，实际是 8.5（入口参数 n，触发时给的值）：请把 n 改成 integer 类型的值再触发，例如：sfly run start <场景> --param n=<整数>",
				},
			]);
			expect(await runsOf(id)).toEqual([]);
			await api.triggerOk(id, { n: 8 });
		});

		it("写对的输入不受影响：没有警告，预检通过", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			const { id, warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", retries: 2 })], { "tuner-dev": "dev" }),
			);
			expect(warnings).toEqual([]);
			expect(await preflight(id)).toEqual([]);
		});

		it("同一个开发包加载在几台在线的 Agent 上、内容相同：照常检查", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			await connect("agent-b", loaded("tuner-dev"));
			const { warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", retires: 2 })], { "tuner-dev": "dev" }),
			);
			expect(warnings.map((w) => w.code)).toEqual(["input_not_declared"]);
		});

		it("几台在线的 Agent 加载的内容不同：不知道节点会落在哪一份上，不检查（和没有元信息一样），不误报", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			// agent-b 上的是旧源码：没有 retires 之外的输入声明。
			await connect("agent-b", loaded("tuner-dev", { host: { type: "string" } }));
			const { id, warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", retires: 2 })], { "tuner-dev": "dev" }),
			);
			expect(warnings).toEqual([]);
			expect(await preflight(id)).toEqual([]);
		});

		it("只有离线的 Agent 加载过它：控制面不知道它现在加载了什么，不检查", async () => {
			const off = await connect("agent-off", loaded("tuner-dev"));
			await off.close();
			await eventually(async () => {
				const { agents: list } = await api.getJson<{ agents: { name: string; status: string }[] }>(
					"/agents",
				);
				expect(list.find((a) => a.name === "agent-off")?.status).toBe("offline");
			});
			const { warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", retires: 2 })], { "tuner-dev": "dev" }),
			);
			expect(warnings).toEqual([]);
		});

		it("上报的元信息不是合法的节点类型：不检查，不报错", async () => {
			await connect("agent-a", {
				devPackages: [
					{
						name: "tuner-dev",
						source: "/src/tuner-dev",
						metadataJson: JSON.stringify({ nodes: [{ name: "tune", inputs: "不是对象" }] }),
					},
				],
			});
			const { warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", retires: 2 })], { "tuner-dev": "dev" }),
			);
			expect(warnings).toEqual([]);
		});
	});
});
