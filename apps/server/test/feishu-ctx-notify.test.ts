// 切入点 A：ctx.notify（#234，ADR 0020、ADR 0015）。节点在执行中途发的飞书通知经 Agent 以 Notification 消息转给控制面：
// 机器人必须在任务派发时下发的名单里（「飞书机器人」类型的输入引用的机器人）并且已登记，控制面才把它写进发送队列；
// 否则在这个任务的日志里写一条 warning、不发送。投递结果写进这个任务的日志，不改变任务和运行的状态。
// 发原始消息（#235，`ctx.notify(bot, message=...)`，含 sfly.feishu.card 组装的卡片）：完整的请求体原样发出，
// 只校验是对象、msg_type 是飞书支持的类型、不超过 20 KB（不截断），不合格的不发送、任务日志里有原因。
// 控制面写进任务日志的行不占用 Agent 的日志序号，和 Agent 上报的行一样出现在按运行合并的日志里（#220）。
// HTTP API + 假 Agent + 真实 PostgreSQL + 假飞书 Webhook 服务（support/fake-feishu.ts）。
import { logsApi, RunLogDownloadRow, type RunLogLine } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const OPS = "tok-ops-6b1f0d2e";
const DEV = "tok-dev-93c4a7b5";

/** alert(bot: FeishuBot)、pick() -> {bot}：sfly build 生成的元信息。 */
const metadata = packageMetadata({
	name: "alerts",
	version: "1.0.0",
	nodes: [
		{
			name: "alert",
			title: "告警",
			entry: "alerts:alert",
			inputs: {
				type: "object",
				properties: { bot: { type: "string", "x-sfly-type": "feishu_bot" } },
				required: ["bot"],
				order: ["bot"],
			},
			outputs: { type: "object", properties: {} },
		},
		{
			name: "pick",
			title: "选择",
			entry: "alerts:pick",
			inputs: { type: "object", properties: {} },
			outputs: { type: "object", properties: { bot: { type: "string" } } },
		},
	],
});

/** 入口 → alert；`pick` 时入口 → pick → alert（机器人取自 pick 的输出）。 */
const scenario = (bot: string, { pick = false } = {}) => {
	const nodes = [
		{ id: "entry", kind: "entry", params: [] },
		...(pick ? [{ id: "pick", kind: "package", package: "alerts", node: "pick", inputs: {} }] : []),
		{ id: "alert", kind: "package", package: "alerts", node: "alert", inputs: { bot } },
	];
	return {
		default_agent: "runner",
		nodes,
		edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]?.id, to: n.id, kind: "chain" })),
		packages: { alerts: "1.0.0" },
	};
};

interface LogLine {
	seq: number;
	source: string;
	level: string;
	text: string;
}

describe("ctx.notify：节点在执行中途发飞书通知", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let feishu: FakeFeishu;
	let runner: FakeAgent;
	const agents: FakeAgent[] = [];

	const connect = async (name: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		agents.push(agent);
		return agent;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		feishu = await startFakeFeishu();
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
		await api.createFeishuBot("ops", feishu.webhookUrl(OPS));
		await api.createFeishuBot("dev", feishu.webhookUrl(DEV));
		runner = await connect("runner");
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await feishu.close();
		await cp.close();
	});

	/** 触发一次运行，返回派发给 runner 的 alert 任务。 */
	const start = async (bot = "ops"): Promise<{ runId: string; task: AssignedTask }> => {
		const runId = await api.triggerOk(await api.orchestrationWith(scenario(bot)));
		return { runId, task: await runner.nextAssign() };
	};
	/** Agent 转发节点写进事件管道的一行通知事件（sfly.context）。 */
	const notify = (agent: FakeAgent, task: AssignedTask, event: Record<string, unknown>) =>
		agent.send({
			case: "notification",
			value: {
				taskId: task.taskId,
				attempt: task.attempt,
				eventJson: JSON.stringify({ type: "notify", ts: Date.UTC(2026, 0, 1), ...event }),
			},
		});
	const logOf = async (taskId: string): Promise<LogLine[]> =>
		(await api.getJson<{ lines: LogLine[] }>(`/tasks/${taskId}/logs`)).lines;
	/** 等任务日志里出现满足条件的行。 */
	const logLine = async (taskId: string, match: (l: LogLine) => boolean): Promise<LogLine> => {
		let found: LogLine | undefined;
		await eventually(async () => {
			found = (await logOf(taskId)).find(match);
			expect(found).toBeDefined();
		});
		return found as LogLine;
	};

	it("发给任务引用的机器人：发出文本请求体，投递结果写进这个任务的日志", async () => {
		const { runId, task } = await start();
		expect(task.referencedFeishuBots).toEqual(["ops"]);

		notify(runner, task, {
			bot: "ops",
			text: '指标越界 <at user_id="ou_1">张三</at>',
			at_all: true,
		});

		await eventually(() => expect(feishu.requests).toHaveLength(1));
		expect(feishu.requests[0]).toMatchObject({
			method: "POST",
			path: `/open-apis/bot/v2/hook/${OPS}`,
			json: {
				msg_type: "text",
				content: { text: '指标越界 <at user_id="ou_1">张三</at><at user_id="all">所有人</at>' },
			},
		});
		const line = await logLine(task.taskId, (l) => l.text.includes("已送达"));
		expect(line).toMatchObject({ source: "system", level: "info" });
		expect(line.text).toContain("「ops」");
		expect(JSON.stringify(await logOf(task.taskId))).not.toContain(OPS);

		await runner.succeed(task);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});

	it("不带 at_all 时不追加「@所有人」", async () => {
		const { task } = await start();
		notify(runner, task, { bot: "ops", text: "完成" });
		await eventually(() => expect(feishu.requests).toHaveLength(1));
		expect(feishu.requests[0]?.json).toEqual({ msg_type: "text", content: { text: "完成" } });
	});

	it("文本超过 20 KB：截断后发出，请求体不超过 20 KB，末尾带「…（已截断）」，「@所有人」仍在最后", async () => {
		const { task } = await start();
		notify(runner, task, { bot: "ops", text: "a".repeat(30_000), at_all: true });

		await eventually(() => expect(feishu.requests).toHaveLength(1));
		const request = feishu.requests[0];
		expect(Buffer.byteLength(request?.body ?? "", "utf8")).toBeLessThanOrEqual(20 * 1024);
		const text = (request?.json as { content: { text: string } }).content.text;
		expect(text.startsWith("aaa")).toBe(true);
		expect(text.endsWith('…（已截断）<at user_id="all">所有人</at>')).toBe(true);
	});

	it("文本含 NUL：换成 U+FFFD 后照常发送（发送队列存不下 NUL）", async () => {
		const { task } = await start();
		notify(runner, task, { bot: "ops", text: "a\u0000b" });
		await eventually(() => expect(feishu.requests).toHaveLength(1));
		expect(feishu.requests[0]?.json).toEqual({ msg_type: "text", content: { text: "a�b" } });
	});

	it("机器人不在任务引用的名单里：不发送，任务日志里写 warning，提示把它声明成「飞书机器人」类型的参数", async () => {
		const { task } = await start();

		notify(runner, task, { bot: "dev", text: "发错了" });
		const warning = await logLine(task.taskId, (l) => l.level === "warn");
		expect(warning.source).toBe("system");
		expect(warning.text).toContain("「dev」");
		expect(warning.text).toContain("飞书机器人");
		expect(warning.text).toContain("sfly.FeishuBot");

		// 名单里的照常发送：飞书只收到这一条。
		notify(runner, task, { bot: "ops", text: "发对了" });
		await logLine(task.taskId, (l) => l.text.includes("已送达"));
		expect(feishu.requests.map((r) => r.path)).toEqual([`/open-apis/bot/v2/hook/${OPS}`]);
	});

	it("机器人在名单里但没有登记（取自前面节点的输出）：不发送，任务日志里写 warning", async () => {
		await api.triggerOk(
			await api.orchestrationWith(scenario("${{ nodes.pick.outputs.bot }}", { pick: true })),
		);
		await runner.succeed(await runner.nextAssign(), { bot: "ghost" });
		const task = await runner.nextAssign();
		expect(task.referencedFeishuBots).toEqual(["ghost"]);

		notify(runner, task, { bot: "ghost", text: "x" });
		const warning = await logLine(task.taskId, (l) => l.level === "warn");
		expect(warning).toMatchObject({ source: "system" });
		expect(warning.text).toContain("「ghost」");
		expect(warning.text).toContain("没有登记");

		notify(runner, task, { bot: "ops", text: "ops 不在名单里" });
		await logLine(task.taskId, (l) => l.text.includes("「ops」"));
		expect(feishu.requests).toEqual([]);
	});

	it("任务派发之后机器人被删除：不发送，任务日志里写 warning，任务和运行不受影响", async () => {
		const { runId, task } = await start();
		expect(task.referencedFeishuBots).toEqual(["ops"]);
		const res = await cp.fetch("/feishu-bots/ops", {
			method: "DELETE",
			headers: { "x-sfly-nickname": "tester" },
		});
		expect(res.status).toBe(204);

		notify(runner, task, { bot: "ops", text: "机器人已经删了" });
		const warning = await logLine(task.taskId, (l) => l.level === "warn");
		expect(warning.source).toBe("system");
		expect(warning.text).toContain("ctx.notify 的消息没有发送：");
		expect(warning.text).toContain("「ops」");
		expect(warning.text).toContain("已被删除");
		expect(feishu.requests).toEqual([]);

		await runner.succeed(task);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});

	describe("原始消息：ctx.notify(bot, message=...)", () => {
		const CARD = {
			msg_type: "interactive",
			card: {
				schema: "2.0",
				header: { title: { tag: "plain_text", content: '压测 "A" 环境' }, template: "red" },
				body: {
					elements: [
						{ tag: "markdown", content: "**P99** 超标\n请 <at id=all></at> 看一下 😀" },
						{
							tag: "button",
							text: { tag: "plain_text", content: "查看" },
							behaviors: [{ type: "open_url", default_url: "https://example.com/r/1" }],
						},
					],
				},
			},
		};

		it("原样发出完整的请求体（不改写、不补字段），投递结果写进这个任务的日志", async () => {
			const { runId, task } = await start();

			notify(runner, task, { bot: "ops", message: CARD });

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(feishu.requests[0]).toMatchObject({
				method: "POST",
				path: `/open-apis/bot/v2/hook/${OPS}`,
				json: CARD,
			});
			const line = await logLine(task.taskId, (l) => l.text.includes("已送达"));
			expect(line).toMatchObject({ source: "system", level: "info" });
			expect(line.text).toContain("「ops」");
			await runner.succeed(task);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		});

		it("字符串里含 NUL：换成 U+FFFD 后照常发送", async () => {
			const { task } = await start();
			notify(runner, task, {
				bot: "ops",
				message: { msg_type: "text", content: { text: "a\u0000b" } },
			});
			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(feishu.requests[0]?.json).toEqual({ msg_type: "text", content: { text: "a�b" } });
		});

		it.each([
			["不是对象：数组", [{ msg_type: "text" }], "不是一个对象"],
			["不是对象：JSON 字符串", '{"msg_type":"text"}', "不是一个对象"],
			["没有 msg_type", { content: { text: "x" } }, "msg_type"],
			["msg_type 不认识", { msg_type: "audio", content: {} }, "msg_type"],
			["msg_type 不是字符串", { msg_type: 1, content: {} }, "msg_type"],
			["超过 20 KB：不截断", { msg_type: "text", content: { text: "a".repeat(21_000) } }, "20 KB"],
		])("%s：不发送，任务日志里写 warning 说明原因，之后的通知照常发送，任务和运行不受影响", async (_name, message, reason) => {
			const { runId, task } = await start();

			notify(runner, task, { bot: "ops", message });
			const warning = await logLine(task.taskId, (l) => l.level === "warn");
			expect(warning.source).toBe("system");
			expect(warning.text).toContain("ctx.notify 的消息没有发送：");
			expect(warning.text).toContain(reason);

			notify(runner, task, { bot: "ops", text: "后一条" });
			await logLine(task.taskId, (l) => l.text.includes("已送达"));
			expect(feishu.requests.map((r) => r.json)).toEqual([
				{ msg_type: "text", content: { text: "后一条" } },
			]);
			await runner.succeed(task);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		});

		it("机器人不在任务引用的名单里：原始消息同样不发送，提示声明成「飞书机器人」类型的参数", async () => {
			const { task } = await start();

			notify(runner, task, { bot: "dev", message: CARD });
			const warning = await logLine(task.taskId, (l) => l.level === "warn");
			expect(warning.text).toContain("「dev」");
			expect(warning.text).toContain("sfly.FeishuBot");
			expect(feishu.requests).toEqual([]);
		});

		it("同时带 text 和 message、或者都没有：内容不完整，不发送，任务日志里写 warning", async () => {
			const { task } = await start();

			notify(runner, task, { bot: "ops", text: "x", message: CARD });
			notify(runner, task, { bot: "ops" });
			await eventually(async () =>
				expect((await logOf(task.taskId)).filter((l) => l.level === "warn")).toHaveLength(2),
			);
			expect(feishu.requests).toEqual([]);
		});
	});

	it("投递失败：任务和运行的结果不受影响，任务日志里是 warning", async () => {
		feishu.replyAlways({ code: 19024 });
		const { runId, task } = await start();

		notify(runner, task, { bot: "ops", text: "没有关键词" });
		const warning = await logLine(task.taskId, (l) => l.text.includes("投递失败"));
		expect(warning).toMatchObject({ source: "system", level: "warn" });

		await runner.succeed(task, {});
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		expect((await api.node(runId, "alert")).status).toBe("success");
	});

	it("其他 Agent 冒充发来的通知被忽略", async () => {
		const other = await connect("intruder");
		const { task } = await start();

		notify(other, task, { bot: "ops", text: "冒充" });
		await other.sync();
		notify(runner, task, { bot: "ops", text: "本人" });

		await logLine(task.taskId, (l) => l.text.includes("已送达"));
		expect(
			feishu.requests.map((r) => (r.json as { content: { text: string } }).content.text),
		).toEqual(["本人"]);
	});

	it("控制面写进任务日志的行不占用 Agent 的序号：之后 Agent 上报的行照常写入，丢失的行仍显示为序号缺口；重启后同样", async () => {
		const { task } = await start();
		runner.logs(task, [
			[1, "a1"],
			[2, "a2"],
		]);
		notify(runner, task, { bot: "dev", text: "不在名单里" });
		await logLine(task.taskId, (l) => l.level === "warn");
		// Agent 的第 4 行在断线排队时被丢弃（控制面看到缺口）。
		runner.logs(task, [
			[3, "a3"],
			[5, "a5"],
		]);
		await logLine(task.taskId, (l) => l.text === "a5");

		await cp.restart();
		runner = await connect("runner");
		runner.logs(task, [
			[5, "重复"],
			[6, "a6"],
		]);
		await logLine(task.taskId, (l) => l.text === "a6");

		const lines = await logOf(task.taskId);
		expect(lines.map((l) => [l.seq, l.source === "system" ? "warning" : l.text])).toEqual([
			[1, "a1"],
			[2, "a2"],
			[3, "warning"],
			[4, "a3"],
			[6, "a5"],
			[7, "a6"],
		]);
	});

	it("控制面写的行（ctx.notify 的告警和投递结果）出现在按运行合并的日志里：分页、往前翻页、实时推送和下载都恰好一次，与 Agent 上报的行按序号排在一起；只有控制面写的行的任务也在", async () => {
		const doc = scenario("ops");
		doc.nodes.push({
			id: "second",
			kind: "package",
			package: "alerts",
			node: "alert",
			inputs: { bot: "ops" },
		} as never);
		doc.edges.push({ from: "alert", to: "second", kind: "chain" });
		const runId = await api.triggerOk(await api.orchestrationWith(doc));
		const task = await runner.nextAssign();
		runner.logs(task, [
			[1, "a1"],
			[2, "a2"],
		]);
		await logLine(task.taskId, (l) => l.text === "a2");

		const runPage = async (params: Record<string, string | number>) => {
			const search = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
			const res = await cp.fetch(`/runs/${runId}/logs?${search}`);
			expect(res.status, await res.clone().text()).toBe(200);
			return logsApi.runPage.response.parse(await res.json());
		};
		const first = await runPage({ limit: 1000 });
		expect(first.lines.map((l) => l.text)).toEqual(["a1", "a2"]);
		const sse = await SseClient.open(cp, `/runs/${runId}/logs/events?after=${first.live_after}`);
		try {
			notify(runner, task, { bot: "dev", text: "不在名单里" });
			await logLine(task.taskId, (l) => l.level === "warn");
			runner.logs(task, [[3, "a3"]]);
			await logLine(task.taskId, (l) => l.text === "a3");
			notify(runner, task, { bot: "ops", text: "发对了" });
			await logLine(task.taskId, (l) => l.text.includes("已送达"));
			await runner.succeed(task);
			// 第二个节点的任务没有 Agent 上报的行，日志里只有控制面写的投递结果。
			const second = await runner.nextAssign();
			notify(runner, second, { bot: "ops", text: "第二个节点" });
			await logLine(second.taskId, (l) => l.text.includes("已送达"));
			await runner.succeed(second);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));

			const brief = (l: Pick<RunLogLine, "node_id" | "seq" | "source" | "text">) =>
				`${l.node_id}#${l.seq} ${l.source === "system" ? "system" : l.text}`;
			const expected = [
				"alert#1 a1",
				"alert#2 a2",
				"alert#3 system",
				"alert#4 a3",
				"alert#5 system",
				"second#1 system",
			];
			const all = await runPage({ limit: 1000 });
			expect(all.lines.map(brief)).toEqual(expected);

			const pages = [await runPage({ limit: 2 })];
			for (let last = pages[0]; last && !last.reached_start; last = pages.at(-1)) {
				pages.push(await runPage({ limit: 2, before: last.before }));
			}
			expect(pages.toReversed().flatMap((p) => p.lines)).toEqual(all.lines);

			const live: RunLogLine[] = [];
			while (live.length < 4) {
				live.push(...logsApi.runEvents.events.logs.parse((await sse.next("logs")).data).lines);
			}
			expect(live).toEqual(all.lines.slice(2));

			const res = await cp.fetch(`/runs/${runId}/logs/download`);
			expect(res.status).toBe(200);
			const rows = (await res.text())
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => RunLogDownloadRow.parse(JSON.parse(l)));
			expect(rows.map(brief)).toEqual(expected);
		} finally {
			sse.close();
		}
	});
});
