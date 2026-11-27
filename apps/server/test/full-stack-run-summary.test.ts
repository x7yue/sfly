// 全栈（#452，ADR 0031）：真实的控制面、Rust Agent 和 SDK 执行器，「运行汇总」示例节点（sfly-stub 的 run_summary，
// 同样的代码写在 docs/guide/sdk-reference.md「运行汇总」）放在链末尾、总是执行，用 ${{ run.state }} 拿到整个运行的状态，
// 给假飞书发一张卡片。三种运行各一个：有节点失败（写出失败的节点和失败原因一行）、被取消（写「已取消」和取消的人，
// 不把被取消的节点写成失败）、节点超时（写成失败，原因是超时）；子流程里失败的节点主链末尾的汇总节点也写得出来。
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "tok-summary-5d1f0e83";
const HOOK = `/open-apis/bot/v2/hook/${TOKEN}`;
/** 入口声明的 secret 参数的值：出现在失败节点的错误信息里，不能出现在汇总节点收到的输入、任务的 task.json、卡片里。 */
const SECRET = "pw-7c3e91a4-do-not-leak";

type Node = Record<string, unknown> & { id: string };

const stub = (id: string, node: string, inputs: Record<string, unknown>, extra = {}): Node => ({
	id,
	kind: "package",
	package: "sfly-stub",
	node,
	inputs,
	...extra,
});

/** 链末尾、总是执行的汇总节点。 */
const summary = (): Node =>
	stub(
		"summary",
		"run_summary",
		{ bot: "${{ params.bot }}", run: "${{ run.state }}" },
		{ always: true, display_name: "运行汇总" },
	);

interface Card {
	msg_type: string;
	card: {
		header: { title: { content: string }; template: string };
		body: { elements: Array<{ tag: string; content: string }> };
	};
}

describeWithAgent("全栈：运行汇总节点用 ${{ run.state }} 读整个运行的状态", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let feishu: FakeFeishu;
	let api: ApiClient;
	let dir: string;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv, feishu, dir] = await Promise.all([
			startTestControlPlane(),
			createStubVenv(),
			startFakeFeishu(),
			mkdtemp(join(tmpdir(), "sfly-run-summary-")),
		]);
		api = new ApiClient(cp);
		await publishStubPackage(cp);
		await api.createFeishuBot("ops", feishu.webhookUrl(TOKEN));
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "summary-agent",
			venv: venv.path,
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await feishu?.close();
		await cp?.close();
		await venv?.remove();
		await rm(dir, { recursive: true, force: true });
	});

	/** 入口参数 bot 加给定的节点按顺序串成的单链。 */
	const scenario = (name: string, nodes: Node[], extra: Record<string, unknown> = {}) => {
		const all: Node[] = [
			{
				id: "entry",
				kind: "entry",
				params: [
					{ name: "bot", type: "string", required: true },
					{ name: "password", type: "string", default: SECRET, secret: true },
				],
			},
			...nodes,
		];
		return api.orchestrationWith(
			{
				default_agent: "summary-agent",
				nodes: all,
				edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
				packages: { "sfly-stub": "0.1.0" },
				...extra,
			},
			name,
		);
	};
	/** Agent 工作目录下每个任务的 task.json（原文和解析后的内容）。 */
	const taskSpecs = async (root: string) => {
		const found: Array<{ raw: string; json: { task_id?: string } }> = [];
		for (const dirName of await readdir(root).catch(() => [])) {
			const raw = await readFile(join(root, dirName, "task.json"), "utf8").catch(() => undefined);
			if (raw) found.push({ raw, json: JSON.parse(raw) });
		}
		return found;
	};
	/** 假飞书收到的卡片（按到达顺序）。 */
	const cards = () => feishu.requests.filter((r) => r.path === HOOK).map((r) => r.json as Card);
	const cardCount = () => cards().length;
	/** 卡片的标题、颜色和正文各段。 */
	const parts = (card: Card) => ({
		title: card.card.header.title.content,
		color: card.card.header.template,
		text: card.card.body.elements.map((e) => e.content).join("\n"),
	});

	it("有节点失败：卡片写出失败的节点（显示名称）和失败原因一行，被跳过的节点不算失败", async () => {
		const id = await scenario("失败汇总", [
			stub("ok", "echo", { text: "x" }),
			stub(
				"pay",
				"fail",
				{ message: "余额不足，口令 ${{ params.password }}" },
				{ display_name: "付款" },
			),
			stub("next", "echo", { text: "y" }),
			summary(),
		]);
		const before = cardCount();
		const runId = await api.triggerOk(id, { bot: "ops" });

		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 60_000);
		await eventually(() => expect(cardCount()).toBe(before + 1));
		expect((await api.node(runId, "next")).status).toBe("skipped");
		expect((await api.node(runId, "summary")).status).toBe("success");
		expect(parts(cards().at(-1) as Card)).toEqual({
			title: "失败汇总：有节点失败",
			color: "red",
			text: "- 失败：付款：RuntimeError: 余额不足，口令 ******",
		});
		expect(JSON.stringify(feishu.requests.map((r) => r.body))).not.toContain(SECRET);
		// 汇总节点收到的输入记在它的任务上：状态里自己是准备中。
		const inputs = (await api.node(runId, "summary")).attempts[0]?.inputs as {
			run: { self: { node_id: string }; failures: string[] };
		};
		expect(inputs.run).toMatchObject({ self: { node_id: "summary" }, failures: ["pay"] });
		// secret 参数的值（它出现在失败节点的错误信息里）在汇总节点收到的输入里已经打码：运行视图里记着的输入，
		// 和 Agent 为这个任务写下的 task.json 里都搜不到原值。
		expect(JSON.stringify(inputs)).not.toContain(SECRET);
		const taskId = (await api.node(runId, "summary")).attempts[0]?.task_id as string;
		const specs = await taskSpecs(join(agent.workDir, "tasks"));
		const spec = specs.find((s) => s.json.task_id === taskId);
		expect(spec, `没有找到任务 ${taskId} 的 task.json`).toBeDefined();
		expect(spec?.raw).not.toContain(SECRET);
		expect(spec?.raw).toContain("余额不足，口令 ******");
	}, 120_000);

	it("被取消：卡片写「已取消」和取消的人，被取消的节点不写成失败", async () => {
		const ready = join(dir, "cancel-ready");
		const report = join(dir, "cancel-report");
		const id = await scenario("取消汇总", [
			stub("wait", "wait_cancel", { ready_file: ready, report_file: report }),
			summary(),
		]);
		const before = cardCount();
		const runId = await api.triggerOk(id, { bot: "ops" });
		await eventually(async () => expect(await readFile(ready, "utf8")).not.toBe(""), 30_000);
		await api.cancelOk(runId);

		await eventually(async () => expect((await api.run(runId)).status).toBe("cancelled"), 30_000);
		await eventually(() => expect(cardCount()).toBe(before + 1));
		expect((await api.node(runId, "wait")).status).toBe("cancelled");
		expect(parts(cards().at(-1) as Card)).toEqual({
			title: "取消汇总：已取消",
			color: "grey",
			text: "- 由 tester 取消",
		});
	}, 120_000);

	it("节点超时：写成失败，原因是超时", async () => {
		const id = await scenario("超时汇总", [
			stub("slow", "sleep", { seconds: 60 }, { timeout: 1 }),
			summary(),
		]);
		const before = cardCount();
		const runId = await api.triggerOk(id, { bot: "ops" });

		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 60_000);
		await eventually(() => expect(cardCount()).toBe(before + 1));
		expect((await api.node(runId, "slow")).attempts[0]?.error?.kind).toBe("timeout");
		expect(parts(cards().at(-1) as Card)).toEqual({
			title: "超时汇总：有节点失败",
			color: "red",
			text: expect.stringMatching(/^- 失败：slow：任务执行超过 1 秒/),
		});
	}, 120_000);

	it("主链末尾的汇总节点写得出子流程里失败的节点", async () => {
		const id = await api.orchestrationWith(
			{
				default_agent: "summary-agent",
				nodes: [
					{ id: "entry", kind: "entry", params: [{ name: "bot", type: "string", required: true }] },
					{ id: "spawn", kind: "async", params: {} },
					stub("hold", "sleep", { seconds: 2 }),
					summary(),
					{ id: "sub", kind: "subflow_entry", name: "探测", params: [] },
					stub("probe", "fail", { message: "探测失败" }, { display_name: "探测接口" }),
				],
				edges: [
					{ from: "entry", to: "spawn", kind: "chain" },
					{ from: "spawn", to: "hold", kind: "chain" },
					{ from: "hold", to: "summary", kind: "chain" },
					{ from: "sub", to: "probe", kind: "chain" },
					{ from: "spawn", to: "sub", kind: "dispatch" },
				],
				packages: { "sfly-stub": "0.1.0" },
			},
			"子流程汇总",
		);
		const before = cardCount();
		const runId = await api.triggerOk(id, { bot: "ops" });

		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 60_000);
		await eventually(() => expect(cardCount()).toBe(before + 1));
		expect(parts(cards().at(-1) as Card)).toEqual({
			title: "子流程汇总：有节点失败",
			color: "red",
			text: "- 失败：探测接口：RuntimeError: 探测失败",
		});
	}, 120_000);
});
