// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
// 切入点 A：飞书通知节点（文本格式）与发送队列（#229，ADR 0020、docs/SEMANTICS.md §1.3、§2.4）。
// HTTP API + 假 Agent + 真实 PostgreSQL + 手动时钟 + 假飞书 Webhook 服务（support/fake-feishu.ts）。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type NodeView } from "./support/api-client.js";
import { type Node, orchestration } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "tok-4f9a8c71-e2b0-43d6-9a55-0a1b2c3d4e5f";

const notify = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "feishu_notify",
	bot: "ops",
	text: id,
	...extra,
});
const echo = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	inputs: {},
	...extra,
});

/** 入口 + 单链；只有内置节点时不需要 Agent，所以不写默认 Agent。 */
function flow(
	nodes: Node[],
	params: Array<Record<string, unknown>> = [],
	{ agent = false }: { agent?: boolean } = {},
) {
	const all: Node[] = [{ id: "entry", kind: "entry", params }, ...nodes];
	return {
		...(agent ? { default_agent: "agent-a" } : {}),
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
	};
}

interface LogLine {
	level: string;
	source: string;
	text: string;
}

describe("飞书通知节点（文本格式）与发送队列", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let api: ApiClient;
	let feishu: FakeFeishu;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		clock = cp.clock as ManualClock;
		api = new ApiClient(cp);
		feishu = await startFakeFeishu();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await api.createFeishuBot("ops", feishu.webhookUrl(TOKEN));
	});
	afterEach(async () => {
		await feishu.close();
		await cp.close();
	});

	const texts = () =>
		feishu.requests.map((r) => (r.json as { content: { text: string } }).content.text);
	const taskOf = (node: NodeView) => (node.attempts[0] as { task_id: string }).task_id;
	const logOf = async (node: NodeView): Promise<LogLine[]> =>
		(await api.getJson<{ lines: LogLine[] }>(`/tasks/${taskOf(node)}/logs`)).lines;
	/** 等节点日志里出现满足条件的行。 */
	const logLine = async (node: NodeView, match: (l: LogLine) => boolean): Promise<LogLine> => {
		let found: LogLine | undefined;
		await eventually(async () => {
			found = (await logOf(node)).find(match);
			expect(found).toBeDefined();
		});
		return found as LogLine;
	};
	const withAgent = async () => FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });

	it("发出 text 请求体：内嵌引用替换成实际值，「@所有人」追加在正文末尾；节点立即成功、没有输出，不需要 Agent", async () => {
		const id = await api.orchestrationWith(
			flow(
				[notify("start", { text: "压测开始，目标 QPS ${{ params.qps }}", at_all: true })],
				[{ name: "qps", type: "number" }],
			),
		);
		const runId = await api.triggerOk(id, { qps: 100 });

		// 不等投递：运行已经结束，节点成功。
		const run = await api.run(runId);
		expect(run.status).toBe("success");
		const node = await api.node(runId, "start");
		expect(node).toMatchObject({ kind: "feishu_notify", status: "success", agent: null });
		expect(node.attempts[0]).toMatchObject({
			outputs: {},
			inputs: { bot: "ops", text: "压测开始，目标 QPS 100", at_all: true },
		});

		await eventually(() => expect(feishu.requests).toHaveLength(1));
		expect(feishu.requests[0]).toMatchObject({
			method: "POST",
			path: `/open-apis/bot/v2/hook/${TOKEN}`,
			json: {
				msg_type: "text",
				content: { text: '压测开始，目标 QPS 100<at user_id="all">所有人</at>' },
			},
		});
	});

	it("用户自己写在文本里的 at 标签原样发出", async () => {
		const text = '请 <at user_id="ou_123">张三</at> 看一下';
		const id = await api.orchestrationWith(flow([notify("n", { text })]));
		await api.triggerOk(id);
		await eventually(() => expect(texts()).toEqual([text]));
	});

	it("节点日志里有投递结果：送达是 info；日志里没有 Webhook 地址", async () => {
		const id = await api.orchestrationWith(flow([notify("n")]));
		const runId = await api.triggerOk(id);
		const node = await api.node(runId, "n");

		const line = await logLine(node, (l) => l.level === "info" && l.text.includes("已送达"));
		expect(line).toMatchObject({ source: "system" });
		expect(line.text).toContain("「ops」");
		expect(JSON.stringify(await logOf(node))).not.toContain(TOKEN);
	});

	it.each([
		{
			name: "已知的错误码（19024）有中文原因",
			reply: { code: 19024 },
			includes: ["关键词", "19024"],
		},
		{
			name: "未知的错误码带上飞书的说明，其中的地址打码",
			reply: { code: 99999, msg: `oops ${`http://127.0.0.1:1/open-apis/bot/v2/hook/${TOKEN}`}` },
			includes: ["99999", "oops"],
		},
	])("飞书返回错误时节点仍然成功、后面的节点照常执行、运行结果不变；日志里是 warning：$name", async ({
		reply,
		includes,
	}) => {
		const agent = await withAgent();
		feishu.reply(reply);
		const id = await api.orchestrationWith(
			flow([notify("n", { text: "没有关键词" }), echo("after")], [], { agent: true }),
		);
		const runId = await api.triggerOk(id);

		const after = await agent.nextAssign();
		expect(after.nodeId).toBe("after");
		await agent.succeed(after);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		const node = await api.node(runId, "n");
		expect(node.status).toBe("success");

		const line = await logLine(node, (l) => l.level === "warn" && l.text.includes("投递失败"));
		for (const text of includes) expect(line.text).toContain(text);
		expect(JSON.stringify(await logOf(node))).not.toContain(TOKEN);
		expect(feishu.requests).toHaveLength(1);
		await agent.disconnect();
	});

	it("飞书不可达时同样：节点成功，运行结果不变；网络错误重试到期限（10 分钟）后日志里是 warning", async () => {
		const dead = await startFakeFeishu();
		const deadUrl = dead.webhookUrl(TOKEN);
		await dead.close();
		await api.createFeishuBot("dead", deadUrl);
		const id = await api.orchestrationWith(flow([notify("n", { bot: "dead" })]));
		const runId = await api.triggerOk(id);

		const node = await api.node(runId, "n");
		expect(node.status).toBe("success");
		expect((await api.run(runId)).status).toBe("success");
		// 网络错误退避重试（#230）：推进控制面时间越过期限，才记为失败。
		let line: LogLine | undefined;
		await eventually(async () => {
			clock.advance(60_000);
			line = (await logOf(node)).find((l) => l.level === "warn" && l.text.includes("投递失败"));
			expect(line).toBeDefined();
		}, 15_000);
		expect(line?.text).toContain("无法连接");
		expect(JSON.stringify(await logOf(node))).not.toContain(TOKEN);
	});

	describe("引用一律按 always 的规则解析：缺失的输出取 null，节点照常发送并成功", () => {
		it("always 节点引用被跳过的节点的输出", async () => {
			const agent = await withAgent();
			const id = await api.orchestrationWith(
				flow(
					[
						echo("load"),
						echo("mid"),
						notify("bye", {
							always: true,
							text: "收尾：${{ nodes.mid.outputs.v }} / ${{ nodes.load.outputs.v }}",
						}),
					],
					[],
					{ agent: true },
				),
			);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "load 失败");
			await eventually(() => expect(texts()).toEqual(["收尾：null / null"]));

			const run = await api.run(runId);
			expect(run.status).toBe("failed");
			expect(run.chains[0]?.nodes.map((n) => [n.node_id, n.status])).toEqual([
				["entry", "success"],
				["load", "failed"],
				["mid", "skipped"],
				["bye", "success"],
			]);
			await agent.disconnect();
		});

		it("不是 always 的飞书通知节点也一样：引用缺失的输出取 null，不以配置错误失败", async () => {
			const agent = await withAgent();
			const id = await api.orchestrationWith(
				flow([echo("load"), notify("n", { text: "值：${{ nodes.load.outputs.v }}" })], [], {
					agent: true,
				}),
			);
			const runId = await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign(), {});
			await eventually(() => expect(texts()).toEqual(["值：null"]));
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			await agent.disconnect();
		});
	});

	describe("解析出错时节点日志里写 warning，节点成功，消息不发送", () => {
		const params = [
			{ name: "cfg", type: "json" },
			{ name: "channel", type: "json" },
		];

		it("内嵌引用解析出对象", async () => {
			const id = await api.orchestrationWith(
				flow([notify("n", { text: "配置 ${{ params.cfg }}" })], params),
			);
			const runId = await api.triggerOk(id, { cfg: { a: 1 }, channel: "ops" });
			const node = await api.node(runId, "n");
			expect(node.status).toBe("success");
			expect((await api.run(runId)).status).toBe("success");
			const line = await logLine(node, (l) => l.level === "warn");
			expect(line.text).toContain("消息没有发送");
			expect(feishu.requests).toHaveLength(0);
		});

		it("机器人的值不是字符串", async () => {
			const id = await api.orchestrationWith(
				flow([notify("n", { bot: "${{ params.channel }}" })], params),
			);
			const runId = await api.triggerOk(id, { cfg: {}, channel: 5 });
			const node = await api.node(runId, "n");
			expect(node.status).toBe("success");
			const line = await logLine(node, (l) => l.level === "warn");
			expect(line.text).toContain("机器人");
			expect(line.text).toContain("消息没有发送");
			expect(feishu.requests).toHaveLength(0);
		});

		it("运行到这个节点时机器人已被删除", async () => {
			const id = await api.orchestrationWith(
				flow([{ id: "wait", kind: "sleep", duration: "10m" }, notify("n")]),
			);
			const runId = await api.triggerOk(id);
			const res = await cp.fetch("/feishu-bots/ops", {
				method: "DELETE",
				headers: { "x-sfly-nickname": "tester" },
			});
			expect(res.status).toBe(204);

			clock.advance(10 * 60_000);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			const node = await api.node(runId, "n");
			expect(node.status).toBe("success");
			const line = await logLine(node, (l) => l.level === "warn");
			expect(line.text).toContain("「ops」");
			expect(line.text).toContain("消息没有发送");
			expect(feishu.requests).toHaveLength(0);
		});
	});

	describe("机器人必须已登记", () => {
		const saveWarnings = async (id: string, document: unknown) => {
			const res = await api.post(`/orchestrations/${id}/versions`, {
				base_version: await api.headVersion(id),
				document,
			});
			expect(res.status).toBe(201);
			return ((await res.json()) as { warnings: Array<Record<string, unknown>> }).warnings;
		};

		it("常量不是已登记的机器人：保存时警告，触发时阻断并指出是哪个节点", async () => {
			const id = await api.createOrchestration("通知");
			const warnings = await saveWarnings(id, flow([notify("n", { bot: "ghost" })]));
			expect(warnings).toEqual([
				{
					code: "feishu_bot_not_registered",
					message: "节点 n 选择的飞书机器人「ghost」还没有登记",
					node_id: "n",
					input: "bot",
				},
			]);

			const res = await api.trigger(id);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string; details: unknown } };
			expect(body.error.code).toBe("invalid_orchestration");
			expect(body.error.details).toEqual([
				{
					code: "feishu_bot_not_registered",
					message: "节点 n 选择的飞书机器人「ghost」还没有登记",
					node_id: "n",
				},
			]);
		});

		it("没有选择机器人：保存时警告，触发时阻断", async () => {
			const id = await api.createOrchestration("通知");
			const warnings = await saveWarnings(id, flow([notify("n", { bot: undefined })]));
			expect(warnings).toMatchObject([{ code: "feishu_bot_unset", node_id: "n" }]);
			expect((await api.trigger(id)).status).toBe(400);
		});

		it("引用入口参数：保存时不警告，触发时按实际传入的值检查", async () => {
			const id = await api.createOrchestration("通知");
			const document = flow(
				[notify("n", { bot: "${{ params.channel }}" })],
				[{ name: "channel", type: "string" }],
			);
			expect(await saveWarnings(id, document)).toEqual([]);

			const blocked = await api.trigger(id, { channel: "ghost" });
			expect(blocked.status).toBe(400);
			const body = (await blocked.json()) as { error: { details: unknown } };
			expect(body.error.details).toMatchObject([
				{
					code: "feishu_bot_not_registered",
					message: "节点 n 选择的飞书机器人「ghost」还没有登记（取自入口参数）",
					node_id: "n",
				},
			]);

			const runId = await api.triggerOk(id, { channel: "ops" });
			await eventually(() => expect(texts()).toEqual(["n"]));
			expect((await api.run(runId)).status).toBe("success");
		});

		it("子流程里的飞书通知节点引用的参数由异步任务节点传入：按映射的常量检查", async () => {
			const id = await api.orchestrationWith(
				orchestration(
					[
						[
							{ id: "entry", kind: "entry", params: [] },
							{ id: "spawn", kind: "async", params: { c: "ghost" } },
						],
						[
							{
								id: "sub",
								kind: "subflow_entry",
								name: "sub",
								params: [{ name: "c", type: "string" }],
							},
							notify("n", { bot: "${{ params.c }}" }),
						],
					],
					[["spawn", "sub"]],
				),
			);
			const res = await api.trigger(id);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { details: unknown } };
			expect(body.error.details).toMatchObject([
				{ code: "feishu_bot_not_registered", node_id: "n" },
			]);
		});
	});

	describe("投递记录", () => {
		/** 队列里这个运行的消息条数（投递记录只有这一个出口，保留期清理后没有别的地方能看到）。 */
		const recorded = async (runId: string) => {
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				const { rows } = await client.query<{ n: string }>(
					"select count(*) as n from feishu_messages where run_id = $1",
					[runId],
				);
				return Number(rows[0]?.n);
			} finally {
				await client.end();
			}
		};

		it("跟随所属运行的保留期：运行结束超过保留期后清理，之前一直保留", async () => {
			const id = await api.orchestrationWith(flow([notify("n")]));
			const runId = await api.triggerOk(id);
			await eventually(() => expect(feishu.requests).toHaveLength(1));
			await eventually(async () => expect(await recorded(runId)).toBe(1));

			clock.advance(29 * 24 * 60 * 60_000);
			expect(await recorded(runId)).toBe(1);
			clock.advance(2 * 24 * 60 * 60_000);
			await eventually(async () => expect(await recorded(runId)).toBe(0));
		});
	});

	describe("投递", () => {
		it("同一个机器人的多条消息按入队顺序串行到达：同一时刻只有一个请求在途", async () => {
			feishu.replyAlways({ delayMs: 60 });
			// 一共 4 条，在每秒 5 条的限速之内（限速见 feishu-delivery.test.ts）。
			const id = await api.orchestrationWith(flow([notify("m1"), notify("m2")]));
			await api.triggerOk(id);
			await api.triggerOk(id);

			await eventually(() => expect(feishu.requests).toHaveLength(4), 10_000);
			expect(texts()).toEqual(["m1", "m2", "m1", "m2"]);
			expect(feishu.maxInFlight).toBe(1);
		});

		it("控制面重启时还没有结果的消息不记为失败，重启后接着投递", async () => {
			feishu.reply({ hang: true });
			const id = await api.orchestrationWith(flow([notify("n")]));
			const runId = await api.triggerOk(id);
			await eventually(() => expect(feishu.requests).toHaveLength(1));

			await cp.restart();

			await eventually(() => expect(feishu.requests).toHaveLength(2));
			const node = await api.node(runId, "n");
			await logLine(node, (l) => l.level === "info" && l.text.includes("已送达"));
			expect((await logOf(node)).filter((l) => l.level === "warn")).toEqual([]);
		});

		it("一个机器人不响应时，不挡住别的机器人", async () => {
			await api.createFeishuBot("other", feishu.webhookUrl("other-token"));
			feishu.replyTo(TOKEN, { hang: true });
			const id = await api.orchestrationWith(
				flow([notify("stuck", { bot: "ops" }), notify("free", { bot: "other" })]),
			);
			const runId = await api.triggerOk(id);

			// 两个机器人同时投递：到达的先后不确定。ops 不响应，other 的消息照常送达。
			await eventually(() => expect([...texts()].sort()).toEqual(["free", "stuck"]));
			const free = await api.node(runId, "free");
			await logLine(free, (l) => l.level === "info" && l.text.includes("已送达"));
			expect((await api.run(runId)).status).toBe("success");
			const stuck = await api.node(runId, "stuck");
			expect(await logOf(stuck)).toEqual([]);
		});
	});
});
