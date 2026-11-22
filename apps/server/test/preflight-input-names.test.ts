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

const tune = (id: string, pkg: string, inputs: Record<string, unknown>, agent?: string) => ({
	id,
	kind: "package",
	package: pkg,
	node: "tune",
	inputs,
	...(agent === undefined ? {} : { agent }),
});

/** 开发版本的警告说明末尾那句：声明取自节点派发到的 Agent 上次 sfly dev 时的上报，写明是哪台。 */
const devHint = (agent: string) =>
	`（开发版本的声明取自节点派发到的 Agent ${agent} 上次运行 sfly dev 时的上报，刚改过节点的参数的话，在 ${agent} 所在的机器上重新运行 sfly dev）`;

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
					`节点 t 的输入 retires 没有声明：节点类型 tune 声明的输入有 host、retries、n；是不是想写 retries？${devHint("agent-a")}`,
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

		it("只看节点派发到的 Agent：别的在线 Agent 上加载的内容不同，不影响检查", async () => {
			// agent-a（默认 Agent）加载的新源码多了输入 extra；agent-b 上是没有 extra 的旧源码。
			const withExtra = { ...TUNE_INPUTS.properties, extra: { type: "string" } };
			await connect("agent-a", loaded("tuner-dev", withExtra));
			await connect("agent-b", loaded("tuner-dev"));
			// 节点派发到 agent-a：extra 是声明过的，不报；写错的 retires 报。
			const onA = await save(
				document([tune("t", "tuner-dev", { host: "h", extra: "x", retires: 2 })], {
					"tuner-dev": "dev",
				}),
			);
			expect(onA.warnings.map((w) => [w.code, w.input])).toEqual([
				["input_not_declared", "retires"],
			]);
			// 节点派发到 agent-b：按 agent-b 加载的，extra 没有声明。
			const onB = await save(
				document([tune("t", "tuner-dev", { host: "h", extra: "x" }, "agent-b")], {
					"tuner-dev": "dev",
				}),
			);
			expect(onB.warnings.map((w) => [w.code, w.input])).toEqual([["input_not_declared", "extra"]]);
		});

		it("派发目标离线、别的在线 Agent 加载的是旧源码：不检查，不拦，触发后任务排队等它上线", async () => {
			// agent-b 上的新源码声明了 extra，现在离线；在线的 agent-a 加载的是没有 extra 的旧源码。
			const withExtra = { ...TUNE_INPUTS.properties, extra: { type: "string" } };
			const off = await connect("agent-b", loaded("tuner-dev", withExtra));
			await off.close();
			await eventually(async () => {
				const { agents: list } = await api.getJson<{ agents: { name: string; status: string }[] }>(
					"/agents",
				);
				expect(list.find((a) => a.name === "agent-b")?.status).toBe("offline");
			});
			await connect("agent-a", loaded("tuner-dev"));
			const { id, warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", extra: "x" }, "agent-b")], {
					"tuner-dev": "dev",
				}),
			);
			expect(warnings).toEqual([]);
			expect(await preflight(id)).toEqual([]);
			await api.triggerOk(id);
		});

		it("派发目标在线但没加载这个包（别的 Agent 加载了）：预检只指出没有加载，不再按别的 Agent 的声明多报输入名", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			await connect("agent-b");
			const { id, warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", retires: 2 }, "agent-b")], {
					"tuner-dev": "dev",
				}),
			);
			expect(warnings).toEqual([]);
			expect((await preflight(id)).map((p) => p.code)).toEqual(["dev_package_not_loaded"]);
		});

		it("用到这个包的几个节点派发到不同的 Agent：这几台上报的内容相同才检查，不同就不检查", async () => {
			const two = () =>
				document(
					[
						tune("t1", "tuner-dev", { host: "h", retires: 1 }, "agent-a"),
						tune("t2", "tuner-dev", { host: "h", retires: 2 }, "agent-b"),
					],
					{ "tuner-dev": "dev" },
				);
			await connect("agent-a", loaded("tuner-dev"));
			// agent-b 上是旧源码：没有 retries、n 的声明。
			const b = await connect("agent-b", loaded("tuner-dev", { host: { type: "string" } }));
			const differ = await save(two());
			expect(differ.warnings).toEqual([]);
			expect(await preflight(differ.id)).toEqual([]);
			// agent-b 重新 sfly dev 之后内容相同：两个节点都按它检查。
			await b.close();
			await eventually(async () => {
				const { agents: list } = await api.getJson<{ agents: { name: string; status: string }[] }>(
					"/agents",
				);
				expect(list.find((a) => a.name === "agent-b")?.status).toBe("offline");
			});
			await connect("agent-b", loaded("tuner-dev"));
			const same = await save(two());
			expect(same.warnings.map((w) => [w.node_id, w.code, w.input]).sort()).toEqual([
				["t1", "input_not_declared", "retires"],
				["t2", "input_not_declared", "retires"],
			]);
		});

		it("同一个包的两个节点：一个派到在线、加载了旧源码的 agent-a，另一个派到离线的（或在线但没加载的）agent-b：整包不查，不能只拿加载了的那台去查", async () => {
			// agent-b 上次上报的是新源码（多了 extra）；agent-a 在线、旧源码。节点 t1 写了 extra：派到 agent-a 的话它没声明，
			// 但整包不查（agent-b 不确定），所以没有警告、不拦。
			const withExtra = { ...TUNE_INPUTS.properties, extra: { type: "string" } };
			const two = () =>
				document(
					[
						tune("t1", "tuner-dev", { host: "h", extra: "x" }, "agent-a"),
						tune("t2", "tuner-dev", { host: "h", extra: "x" }, "agent-b"),
					],
					{ "tuner-dev": "dev" },
				);
			await connect("agent-a", loaded("tuner-dev"));
			// agent-b 在线但没有加载这个包。
			await connect("agent-b");
			const notLoaded = await save(two());
			expect(notLoaded.warnings.filter((w) => w.code === "input_not_declared")).toEqual([]);
			// agent-b 离线（上次上报的是新源码）。
			const off = await connect("agent-c", loaded("tuner-dev", withExtra));
			await off.close();
			await eventually(async () => {
				const { agents: list } = await api.getJson<{ agents: { name: string; status: string }[] }>(
					"/agents",
				);
				expect(list.find((a) => a.name === "agent-c")?.status).toBe("offline");
			});
			const offline = await save(
				document(
					[
						tune("t1", "tuner-dev", { host: "h", extra: "x" }, "agent-a"),
						tune("t2", "tuner-dev", { host: "h", extra: "x" }, "agent-c"),
					],
					{ "tuner-dev": "dev" },
				),
			);
			expect(offline.warnings.filter((w) => w.code === "input_not_declared")).toEqual([]);
		});

		it("开发节点的「飞书机器人」类型的输入写了没登记的机器人：和已发布的版本一样保存时警告、触发前阻断（以前开发版本触发成功，运行时不发送、任务照常成功）", async () => {
			const botProps = {
				host: { type: "string" },
				bot: { type: "string", "x-sfly-type": "feishu_bot" },
			};
			await connect("agent-a", loaded("tuner-dev", botProps));
			const { id, warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", bot: "没登记的机器人" })], {
					"tuner-dev": "dev",
				}),
			);
			expect(warnings.map((w) => w.code)).toEqual(["feishu_bot_not_registered"]);
			expect((await preflight(id)).map((p) => p.code)).toEqual(["feishu_bot_not_registered"]);
			await refusal(await api.trigger(id));
			expect(await runsOf(id)).toEqual([]);
		});

		it("引用开发节点没有声明的输出键：保存时警告并提醒在那台 Agent 上重新运行 sfly dev，触发前阻断", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			const { id, warnings } = await save(
				document(
					[
						tune("t1", "tuner-dev", { host: "h" }),
						tune("t2", "tuner-dev", { host: "${{ nodes.t1.outputs.nope }}" }),
					],
					{ "tuner-dev": "dev" },
				),
			);
			expect(warnings.map((w) => w.code)).toEqual(["reference_unknown_output"]);
			expect(warnings[0]?.message).toContain("引用的输出键 nope 没有在节点 t1 的节点类型中声明");
			expect(warnings[0]?.message).toContain(
				"节点派发到的 Agent agent-a 上次运行 sfly dev 时的上报，刚改过节点的输出的话，在 agent-a 所在的机器上重新运行 sfly dev",
			);
			await refusal(await api.trigger(id));
		});

		it("派发目标的 Agent 没有注册过：不知道它加载了什么，不检查", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			const { warnings } = await save(
				document([tune("t", "tuner-dev", { host: "h", retires: 2 }, "agent-nobody")], {
					"tuner-dev": "dev",
				}),
			);
			expect(warnings).toEqual([]);
		});

		it("没有节点用这个开发包：不读 Agent，没有警告", async () => {
			await connect("agent-a", loaded("tuner-dev"));
			const { warnings } = await save(document([], { "tuner-dev": "dev" }));
			expect(warnings.filter((w) => w.code === "input_not_declared")).toEqual([]);
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
				document([tune("t", "tuner-dev", { host: "h", retires: 2 }, "agent-off")], {
					"tuner-dev": "dev",
				}),
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
