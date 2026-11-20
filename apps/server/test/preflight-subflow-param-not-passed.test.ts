// 触发前预检：异步任务节点没有给子流程的参数传值，而子流程里有节点用到它时给警告（#421，docs/SEMANTICS.md §6）。
// 警告不阻断触发：参数是非必填、没有默认值的，那些节点拿到的是空值（null）；子流程里没有任何地方引用它时不报。
// 必填又没有默认值的参数没有传值，是保存时就有的 subflow_param_missing，阻断触发，这里不重复。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, type Node, orchestration, param, spawn } from "./support/chains.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

const entry = (): Node => ({ id: "entry", kind: "entry", params: [] });
const subflow = (id: string, name: string, params: unknown[]): Node => ({
	id,
	kind: "subflow_entry",
	name,
	params,
});

describe("触发前预检：子流程的参数没有传值", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const check = (id: string) =>
		api.getJson<{ problems: Problem[]; warnings: Problem[] }>(`/orchestrations/${id}/preflight`);

	it("非必填、没有默认值的参数没有传值，子流程里的节点用到了它：警告写明哪个节点、哪个参数，不阻断触发，触发成功", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), { ...spawn("spawn"), display_name: "派发汇报" }],
					[
						subflow("sub", "汇报", [param("host")]),
						{ ...echo("clean", { v: "${{ params.host }}" }), display_name: "清洗" },
					],
				],
				[["spawn", "sub"]],
			),
		);

		const { problems, warnings } = await check(id);
		expect(problems).toEqual([]);
		expect(warnings).toEqual([
			{
				code: "subflow_param_not_passed",
				node_id: "spawn",
				message:
					"节点 派发汇报（spawn） 没有给子流程 汇报（sub） 的参数 host 传值，子流程里的节点 清洗（clean） 用到了它，拿到的会是空值（null）：" +
					"在这个节点的参数映射里给 host 传值，或者在子流程入口节点给它设默认值",
			},
		]);

		const runId = await api.triggerOk(id);
		expect((await api.run(runId)).status).toBe("running");
	});

	it("子流程里没有任何地方引用这个参数：不报", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn")],
					[subflow("sub", "汇报", [param("host")]), echo("clean")],
				],
				[["spawn", "sub"]],
			),
		);
		expect((await check(id)).warnings).toEqual([]);
	});

	it("参数传了值、有默认值：不报；必填又没有默认值的没传是 subflow_param_missing，阻断触发，不在警告里重复", async () => {
		const used = { v: "${{ params.host }}-${{ params.port }}-${{ params.tag }}" };
		const doc = (mapping: Record<string, unknown>, params: unknown[]) =>
			orchestration(
				[
					[entry(), spawn("spawn", mapping)],
					[subflow("sub", "汇报", params), echo("clean", used)],
				],
				[["spawn", "sub"]],
			);
		const declared = [
			param("host"),
			param("port", { type: "number", default: 8080 }),
			param("tag", { required: true }),
		];

		const mapped = await check(
			await api.orchestrationWith(doc({ host: "h", port: 1, tag: "t" }, declared)),
		);
		expect(mapped).toMatchObject({ problems: [], warnings: [] });

		// host 没有传值（警告），port 有默认值（不报），tag 必填没有默认值又没传（阻断，已有的检查）。
		const missing = await check(await api.orchestrationWith(doc({}, declared)));
		expect(missing.problems.map((p) => p.code)).toEqual(["subflow_param_missing"]);
		expect(missing.warnings.map((w) => w.code)).toEqual(["subflow_param_not_passed"]);
		expect(missing.warnings[0]?.message).toContain("的参数 host 传值");
	});

	it("引用夹在文字里、或者子流程里的异步任务节点把它传给下一层，都算用到了；每个用到它的节点都列出来", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn1")],
					[
						subflow("sub1", "一层", [param("p")]),
						echo("a", { v: "前缀-${{ params.p }}" }),
						echo("b", { v: "${{ params.p }}" }),
						spawn("spawn2", { q: "${{ params.p }}" }),
					],
					[subflow("sub2", "二层", [param("q")]), echo("c", { v: "${{ params.q }}" })],
				],
				[
					["spawn1", "sub1"],
					["spawn2", "sub2"],
				],
			),
		);

		const { warnings } = await check(id);
		expect(warnings).toEqual([
			{
				code: "subflow_param_not_passed",
				node_id: "spawn1",
				message:
					"节点 spawn1 没有给子流程 一层（sub1） 的参数 p 传值，子流程里的节点 a、b、spawn2 用到了它，拿到的会是空值（null）：" +
					"在这个节点的参数映射里给 p 传值，或者在子流程入口节点给它设默认值",
			},
		]);
	});

	it("用到参数的节点多于三个时只列前三个，写出一共几个", async () => {
		const nodes = ["a", "b", "c", "d", "e"].map((id) => echo(id, { v: "${{ params.p }}" }));
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn")],
					[subflow("sub", "汇报", [param("p")]), ...nodes],
				],
				[["spawn", "sub"]],
			),
		);
		expect((await check(id)).warnings[0]?.message).toContain(
			"子流程里的节点 a、b、c 等 5 个节点 用到了它",
		);
	});

	it("参数按子流程各算各的：另一个子流程里同名的参数被引用，不算这个子流程用到了它", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[entry(), spawn("spawn1"), spawn("spawn2", { host: "h" })],
					[subflow("sub1", "不用", [param("host")]), echo("a")],
					[subflow("sub2", "在用", [param("host")]), echo("b", { v: "${{ params.host }}" })],
				],
				[
					["spawn1", "sub1"],
					["spawn2", "sub2"],
				],
			),
		);
		expect((await check(id)).warnings).toEqual([]);
	});

	it("主链的入口参数不在这项检查里：没有给值的可选参数照常触发，不报", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [param("host")] },
						echo("a", { v: "${{ params.host }}" }),
					],
				],
				[],
			),
		);
		expect((await check(id)).warnings).toEqual([]);
		await api.triggerOk(id);
	});
});
