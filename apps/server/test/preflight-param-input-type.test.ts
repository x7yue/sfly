// 触发前检查：入口参数的实际取值整个接到一个节点输入上（`${{ params.x }}`），值不符合输入的类型（#421，docs/SEMANTICS.md §6）：
// 比如小数接到 integer 输入，派发到那个节点才会以 config_error 失败（「输入 x 应为 integer，实际是 8.5」），触发前就拒绝。
// 取值有三个来源：触发时给的值、运行预设里的值、默认值；子流程里取自异步任务节点传入的值。判断和派发时是同一个（typeProblem）。
import { inputProblems } from "@sfly/orchestration";
import { NICKNAME_HEADER, type OrchestrationDocument } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planRun } from "../src/engine/chain.js";
import { knownParams } from "../src/runs/known-params.js";
import { type ParamOrigins, paramInputTypeProblems } from "../src/runs/param-input-type.js";
import { ApiClient } from "./support/api-client.js";
import { orchestration, param, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { type InputsSchema, publishPackage } from "./support/package-archive.js";
import { createPresetOk } from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** tune(n: int)：派发前按输入 schema 检查，n 必须是整数。 */
const TUNE: { outputs: string[]; inputs: InputsSchema } = {
	outputs: [],
	inputs: { properties: { n: { type: "integer" } }, required: ["n"] },
};

const tuneNode = (inputs: Record<string, unknown> = { n: "${{ params.n }}" }) => ({
	id: "t",
	kind: "package",
	package: "tuner",
	node: "tune",
	display_name: "压测",
	inputs,
});

const entry = (params: unknown[]) => ({ id: "entry", kind: "entry", params });

interface Rejection {
	code: string;
	message: string;
	details: { code: string; message: string; node_id?: string }[];
}

describe("触发前检查：入口参数的值接到类型不符的输入", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "tuner", "1.0.0", { tune: TUNE });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const scenario = (params: unknown[], inputs?: Record<string, unknown>) =>
		api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [entry(params), tuneNode(inputs)],
			edges: [{ from: "entry", to: "t", kind: "chain" }],
			packages: { tuner: "1.0.0" },
		});
	const rejected = async (res: Response): Promise<Rejection> => {
		expect(res.status, await res.clone().text()).toBe(400);
		const { error } = (await res.json()) as { error: Rejection };
		return error;
	};
	const runsOf = async (id: string) =>
		(await api.getJson<{ runs: unknown[] }>(`/orchestrations/${id}/runs`)).runs;
	/** 触发请求的原文：`8.0` 要照原样发给控制面，JSON.stringify 会把它写成 8。 */
	const triggerRaw = (id: string, body: string) =>
		cp.fetch(`/orchestrations/${id}/runs`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[NICKNAME_HEADER]: encodeURIComponent("tester"),
			},
			body,
		});

	describe("触发时给的值", () => {
		it("小数接到整数输入：拒绝触发，写明哪个参数、接到哪个节点的哪个输入、值是什么、怎么改，不产生运行", async () => {
			const id = await scenario([param("n", { type: "number", required: true })]);

			const error = await rejected(await api.trigger(id, { n: 8.5 }));
			expect(error.code).toBe("invalid_params");
			const message =
				"节点 压测（t） 的输入 n 应为 integer，实际是 8.5（入口参数 n，触发时给的值）：请把 n 改成 integer 类型的值再触发，例如：sfly run start <场景> --param n=<整数>";
			expect(error.message).toBe(message);
			expect(error.details).toEqual([{ code: "param_input_type_mismatch", message, node_id: "t" }]);
			expect(await runsOf(id)).toEqual([]);
		});

		it("8 和 8.0 都是 JSON 数值 8，是整数，放行；派发时同样通过，节点收到的是 8", async () => {
			const id = await scenario([param("n", { type: "number", required: true })]);

			for (const text of ["8", "8.0", "1e1"]) {
				const res = await triggerRaw(id, `{"params":{"n":${text}}}`);
				expect(res.status, `n=${text}: ${await res.clone().text()}`).toBe(201);
				const assign = await agent.nextAssign();
				expect(assign.inputs).toEqual({ n: Number(text) });
				await agent.succeed(assign, {});
			}
		});

		it('string 参数的值接到整数输入也一样（派发时「应为 integer，实际是 "8"」）', async () => {
			const id = await scenario([param("n", { required: true })]);

			const error = await rejected(await api.trigger(id, { n: "8" }));
			expect(error.message).toContain(
				'输入 n 应为 integer，实际是 "8"（入口参数 n，触发时给的值）',
			);
			expect(await runsOf(id)).toEqual([]);
		});

		it("secret 参数的值不写进说明，写掩码；经异步任务节点传进子流程的 secret 值也一样", async () => {
			const id = await scenario([param("n", { type: "number", required: true, secret: true })]);
			const error = await rejected(await api.trigger(id, { n: 8.5 }));
			expect(error.message).toBe(
				"节点 压测（t） 的输入 n 应为 integer，实际是 ******（入口参数 n，触发时给的值）：请把 n 改成 integer 类型的值再触发，例如：sfly run start <场景> --param n=<整数>",
			);
			expect(JSON.stringify(error)).not.toContain("8.5");
			expect(await runsOf(id)).toEqual([]);

			const sub = await api.orchestrationWith({
				...orchestration(
					[
						[
							entry([param("pin", { type: "number", required: true, secret: true })]),
							spawn("spawn", { n: "${{ params.pin }}" }),
						],
						[
							// 子流程里的参数没有声明 secret，值仍然是 secret 值。
							{
								id: "sub",
								kind: "subflow_entry",
								name: "调参",
								params: [param("n", { type: "number" })],
							},
							tuneNode(),
						],
					],
					[["spawn", "sub"]],
				),
				packages: { tuner: "1.0.0", stub: "1.0.0" },
			});
			const viaSubflow = await rejected(await api.trigger(sub, { pin: 2.25 }));
			expect(viaSubflow.message).toContain("实际是 ******");
			expect(JSON.stringify(viaSubflow)).not.toContain("2.25");
		});

		it("没有值（可选参数没给）的不在这里查，派发时照常检查：触发成功，节点以 config_error 失败", async () => {
			const id = await scenario([param("n", { type: "number" })]);

			const runId = await api.triggerOk(id);
			await eventually(async () => {
				const node = await api.node(runId, "t");
				expect(node.status).toBe("failed");
				expect(node.error).toEqual({
					kind: "config_error",
					message: "输入 n 应为 integer，实际是 null",
					location: null,
				});
			});
		});

		it("引用夹在文字里、常量都不在这里查：夹在文字里的在派发时才失败，触发成功", async () => {
			const id = await scenario([param("n", { type: "number" })], { n: "${{ params.n }}0" });

			const runId = await api.triggerOk(id, { n: 8.5 });
			await eventually(async () => expect((await api.node(runId, "t")).status).toBe("failed"));
		});
	});

	describe("默认值", () => {
		it("没有给值、默认值是小数：拒绝触发，写明是默认值，给了整数就放行", async () => {
			const id = await scenario([param("n", { type: "number", default: 8.5 })]);

			const error = await rejected(await api.trigger(id));
			expect(error.message).toBe(
				"节点 压测（t） 的输入 n 应为 integer，实际是 8.5（入口参数 n，声明的默认值）：" +
					"请触发时给 n 传值，例如：sfly run start <场景> --param n=<整数>；或者在场景的入口节点里把 n 的默认值改成 integer 类型的值",
			);
			expect(await runsOf(id)).toEqual([]);

			expect((await api.trigger(id, { n: 8 })).status).toBe(201);
		});

		it("默认值是整数：不给值照常触发", async () => {
			const id = await scenario([param("n", { type: "number", default: 8 })]);
			await api.triggerOk(id);
			expect((await agent.nextAssign()).inputs).toEqual({ n: 8 });
		});
	});

	describe("运行预设里的值", () => {
		it("预设固定的值是小数：拒绝触发，写明是运行预设里的值和哪个预设，改成整数的预设放行", async () => {
			const id = await scenario([param("n", { type: "number", required: true })]);
			const bad = await createPresetOk(api, id, {
				name: "压测A",
				params: [{ name: "n", value: 8.5 }],
			});
			const good = await createPresetOk(api, id, {
				name: "压测B",
				params: [{ name: "n", value: 8 }],
			});

			const error = await rejected(
				await api.post(`/orchestrations/${id}/runs`, { params: {}, preset: bad.id }),
			);
			expect(error.message).toBe(
				"节点 压测（t） 的输入 n 应为 integer，实际是 8.5（入口参数 n，运行预设「压测A」里的值）：" +
					"请在场景列表的「运行预设…」里把运行预设「压测A」里 n 的值改成 integer 类型的值（命令行用 sfly api --list presets 列出修改预设的接口）",
			);
			expect(await runsOf(id)).toEqual([]);

			const ok = await api.post(`/orchestrations/${id}/runs`, { params: {}, preset: good.id });
			expect(ok.status, await ok.clone().text()).toBe(201);
		});
	});

	describe("子流程里取自异步任务节点传入的值", () => {
		const subflowScenario = (mapping: Record<string, unknown>, mainParams: unknown[] = []) =>
			api.orchestrationWith({
				...orchestration(
					[
						[entry(mainParams), spawn("spawn", mapping)],
						[
							{
								id: "sub",
								kind: "subflow_entry",
								name: "调参",
								params: [param("n", { type: "number" })],
							},
							{ ...tuneNode(), package: "tuner" },
						],
					],
					[["spawn", "sub"]],
				),
				packages: { tuner: "1.0.0", stub: "1.0.0" },
			});

		it("映射的常量是小数：拒绝触发，写明是子流程的参数、由哪个异步任务节点传入", async () => {
			const id = await subflowScenario({ n: 8.5 });

			const error = await rejected(await api.trigger(id));
			expect(error.message).toBe(
				"节点 压测（t） 的输入 n 应为 integer，实际是 8.5（入口参数 n，取自子流程的参数，由异步任务节点 spawn 传入）：" +
					"请改这个异步任务节点的参数映射，让传给 n 的值是 integer 类型的值",
			);
			expect(await runsOf(id)).toEqual([]);
		});

		it("映射的是主链的入口参数：触发时给了小数就拒绝，给整数放行", async () => {
			const id = await subflowScenario({ n: "${{ params.n }}" }, [
				param("n", { type: "number", required: true }),
			]);

			const error = await rejected(await api.trigger(id, { n: 2.5 }));
			expect(error.message).toContain(
				"实际是 2.5（入口参数 n，取自子流程的参数，由异步任务节点 spawn 传入）",
			);
			expect((await api.trigger(id, { n: 2 })).status).toBe(201);
		});
	});
});

describe("入口参数的值接到输入：和派发时的校验是同一个判断", () => {
	const io = TUNE.inputs;
	const document = OrchestrationDocumentOf();
	const origins: ParamOrigins = { preset: null, given: new Set(["n"]) };
	const metadata = new Map([["tuner", { nodes: [{ name: "tune", inputs: io }] }]]);
	const problemsFor = (value: unknown) => {
		const plan = planRun(document);
		if ("errors" in plan) throw new Error(plan.errors.join("; "));
		return paramInputTypeProblems(
			plan.main,
			knownParams(plan, { n: value }),
			metadata as never,
			origins,
		);
	};

	it.each([
		[8, true],
		[JSON.parse("8.0"), true],
		[JSON.parse("1e1"), true],
		[0, true],
		[-3, true],
		[8.5, false],
		[-0.1, false],
		["8", false],
		[true, false],
		[[8], false],
		[{ n: 8 }, false],
	])("值 %j：预检放行当且仅当派发时的校验放行", (value, accepted) => {
		const dispatch = inputProblems(io as never, { n: value });
		expect(dispatch.length === 0).toBe(accepted);
		expect(problemsFor(value).length === 0).toBe(dispatch.length === 0);
	});
});

function OrchestrationDocumentOf(): OrchestrationDocument {
	return {
		default_agent: "agent-a",
		nodes: [entry([param("n", { type: "json" })]), tuneNode()],
		edges: [{ from: "entry", to: "t", kind: "chain" }],
		packages: { tuner: "1.0.0" },
	} as unknown as OrchestrationDocument;
}
