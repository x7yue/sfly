// 切入点 A：运行通知（#232，ADR 0020、docs/SEMANTICS.md §6）：场景设置里选了机器人的场景，运行结束时由控制面发一张卡片。
// HTTP API + 假 Agent + 真实 PostgreSQL + 手动时钟 + 假飞书 Webhook 服务（support/fake-feishu.ts）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type RunView } from "./support/api-client.js";
import { chainOf, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

// 卡片里的时间按控制面所在的时区显示：固定成东八区，期望值才与运行测试的机器无关。
process.env.TZ = "Asia/Shanghai";

const TOKEN = "tok-6c1f0d52-90a7-4e3b-8f44-2d7a1b9c0e35";
const PUBLIC_URL = "https://sfly.example.com";

type Node = Record<string, unknown> & { id: string };
type Trigger = "failed" | "failed_or_cancelled" | "always";
type Ending = "success" | "failed" | "cancelled";

const echo = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	inputs: {},
	...extra,
});

/** 入口 + 若干包节点串成的单链。 */
function flow(nodes: Node[]) {
	const all: Node[] = [{ id: "entry", kind: "entry", params: [] }, ...nodes];
	return {
		default_agent: "agent-a",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
	};
}

interface Card {
	msg_type: string;
	card: {
		schema: string;
		header: {
			title: { tag: string; content: string };
			subtitle?: { tag: string; content: string };
			template: string;
		};
		body: { elements: Array<{ tag: string; content?: string } & Record<string, unknown>> };
	};
}

describe("运行通知", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let api: ApiClient;
	let feishu: FakeFeishu;
	let agent: FakeAgent;

	/** 默认配置了对外地址（SFLY_PUBLIC_URL）；没有配置的情况在最后一组里另起控制面。 */
	async function start(options: { publicHttpUrl?: string } = { publicHttpUrl: PUBLIC_URL }) {
		cp = await startTestControlPlane(options);
		clock = cp.clock as ManualClock;
		api = new ApiClient(cp);
		feishu = await startFakeFeishu();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await api.createFeishuBot("ops", feishu.webhookUrl(TOKEN));
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	}
	beforeEach(() => start());
	afterEach(async () => {
		await agent.disconnect();
		await feishu.close();
		await cp.close();
	});

	const notification = async (id: string, settings: Record<string, unknown>) => {
		const res = await api.patch(`/orchestrations/${id}`, { run_notification: settings });
		expect(res.status, await res.clone().text()).toBe(200);
	};
	/** 建一个场景并配好运行通知（默认发给 ops、仅失败）。 */
	const scenario = async (
		document: unknown,
		settings: Record<string, unknown> = {},
		name = "订单压测",
	) => {
		const id = await api.orchestrationWith(document, name);
		await notification(id, { bot: "ops", ...settings });
		return id;
	};
	const status = async (runId: string, expected: string) =>
		eventually(async () => expect((await api.run(runId)).status).toBe(expected));
	const cards = () => feishu.requests.map((r) => r.json as Card);
	const facts = (card: Card) =>
		card.card.body.elements.find((e) => e.content?.includes("**场景**"));

	/** 触发一次运行并让它以指定的结果结束（单个包节点 a）。 */
	async function runEnding(id: string, ending: Ending): Promise<string> {
		const runId = await api.triggerOk(id);
		const a = await agent.nextAssign();
		if (ending === "success") await agent.succeed(a);
		if (ending === "failed") await agent.fail(a, "boom");
		if (ending === "cancelled") {
			await api.cancelOk(runId);
			await agent.nextCancel();
			await agent.cancelled(a);
		}
		await status(runId, ending);
		return runId;
	}
	const single = () => flow([echo("a")]);

	describe("触发条件", () => {
		it.each<[Trigger, Ending, boolean]>([
			["failed", "success", false],
			["failed", "failed", true],
			["failed", "cancelled", false],
			["failed_or_cancelled", "success", false],
			["failed_or_cancelled", "failed", true],
			["failed_or_cancelled", "cancelled", true],
			["always", "success", true],
			["always", "failed", true],
			["always", "cancelled", true],
		])("%s：运行%s时%s", async (trigger, ending, sends) => {
			const id = await scenario(single(), { trigger });
			const runId = await runEnding(id, ending);

			if (sends) {
				await eventually(() => expect(feishu.requests).toHaveLength(1));
				await eventually(async () =>
					expect((await api.run(runId)).run_notification).toMatchObject({
						status: "delivered",
						bot: "ops",
					}),
				);
			} else {
				// 运行结束的事务里就决定了发不发：结束之后运行详情里没有运行通知，飞书那边什么也没收到。
				expect((await api.run(runId)).run_notification).toBeNull();
				expect(feishu.requests).toHaveLength(0);
			}
		});

		it("没有选机器人（默认）时不发，任何结果都不发", async () => {
			const id = await api.orchestrationWith(single(), "没开");
			const runId = await runEnding(id, "failed");
			expect((await api.run(runId)).run_notification).toBeNull();
			expect(feishu.requests).toHaveLength(0);
		});

		it("读的是运行结束时场景当前的设置：运行中改了设置，按新设置发", async () => {
			const id = await scenario(single(), { trigger: "failed", title: "旧标题" });
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();
			await notification(id, { trigger: "always", title: "新标题" });
			await agent.succeed(a);
			await status(runId, "success");

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(cards()[0]?.card.header.title.content).toBe("新标题");
		});
	});

	describe("卡片", () => {
		it("失败的运行：标题、副标题、颜色、附加说明、各个字段、失败的节点、「查看运行」按钮", async () => {
			const id = await scenario(
				flow([echo("a"), echo("b")]),
				{ title: "【订单压测-A 环境】", note: "环境 A，负责人 <at id=ou_1></at>" },
				"订单压测",
			);
			const runId = await api.triggerOk(id);
			clock.advance(125_000);
			await agent.fail(await agent.nextAssign(), "boom");
			await status(runId, "failed");

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(feishu.requests[0]).toMatchObject({
				method: "POST",
				path: `/open-apis/bot/v2/hook/${TOKEN}`,
			});
			expect(cards()[0]).toEqual({
				msg_type: "interactive",
				card: {
					schema: "2.0",
					header: {
						title: { tag: "plain_text", content: "【订单压测-A 环境】" },
						subtitle: { tag: "plain_text", content: "运行失败" },
						template: "red",
					},
					body: {
						elements: [
							{ tag: "markdown", content: "环境 A，负责人 <at id=ou_1></at>" },
							{
								tag: "markdown",
								content: [
									"**场景**：订单压测",
									`**运行编号**：${runId.slice(0, 8)}`,
									"**触发人**：tester",
									"**开始时间**：2026-01-01 08:00:00 (UTC+8)",
									"**耗时**：2 分 05 秒",
								].join("\n"),
							},
							{ tag: "markdown", content: "**失败的节点**\n- 主链：a" },
							{
								tag: "button",
								text: { tag: "plain_text", content: "查看运行" },
								type: "primary",
								behaviors: [{ type: "open_url", default_url: `${PUBLIC_URL}/runs/${runId}` }],
							},
						],
					},
				},
			});
		});

		it.each<[Ending, string, string]>([
			["success", "green", "运行成功"],
			["failed", "red", "运行失败"],
			["cancelled", "grey", "运行已取消"],
		])("运行%s：颜色 %s，副标题写明结果；标题默认是场景名，没有附加说明和失败节点时不出现", async (ending, color, subtitle) => {
			const id = await scenario(single(), { trigger: "always" }, "默认标题的场景");
			await runEnding(id, ending);

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const card = cards()[0] as Card;
			expect(card.card.header).toEqual({
				title: { tag: "plain_text", content: "默认标题的场景" },
				subtitle: { tag: "plain_text", content: subtitle },
				template: color,
			});
			// 附加说明为空：第一个元素就是各个字段；只有失败的运行才有失败的节点。
			expect(card.card.body.elements[0]).toBe(facts(card));
			const text = card.card.body.elements.map((e) => e.content ?? e.tag).join("\n");
			expect(text.includes("失败的节点")).toBe(ending === "failed");
		});

		it("失败的节点带上所在的链：子流程写子流程名称和实例短 ID", async () => {
			const id = await scenario(
				orchestration(
					[
						[{ id: "entry", kind: "entry", params: [] }, spawn("go")],
						[{ id: "sub", kind: "subflow_entry", name: "压测", params: [] }, echo("b")],
					],
					[["go", "sub"]],
				),
			);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "boom");
			await status(runId, "failed");
			const instance = chainOf(await api.run(runId), "sub").id.slice(0, 8);

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const list = (cards()[0] as Card).card.body.elements.find((e) =>
				e.content?.startsWith("**失败的节点**"),
			);
			expect(list?.content).toBe(`**失败的节点**\n- 子流程 压测 · ${instance}：b`);
		});

		it("失败的节点最多列 10 个，其余写总数", async () => {
			const nodes = [
				echo("f0"),
				...Array.from({ length: 12 }, (_, i) => echo(`f${i + 1}`, { always: true })),
			];
			const id = await scenario(flow(nodes));
			const runId = await api.triggerOk(id);
			for (let i = 0; i < 13; i++) await agent.fail(await agent.nextAssign(), "boom");
			await status(runId, "failed");

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const list = (cards()[0] as Card).card.body.elements.find((e) =>
				e.content?.startsWith("**失败的节点**"),
			);
			expect(list?.content).toBe(
				[
					"**失败的节点**（共 13 个，只列出前 10 个）",
					...Array.from({ length: 10 }, (_, i) => `- 主链：f${i}`),
				].join("\n"),
			);
		});

		it("附加说明在 JSON 里占的字节数超过 20 KB 时截断，其余字段不受影响", async () => {
			// 设置里附加说明最多 4000 个字符；控制字符在 JSON 里要转义成 6 个字节，刚好撑过飞书的上限。
			const id = await scenario(single(), { trigger: "always", note: "\u0001".repeat(4000) });
			await runEnding(id, "failed");

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const request = feishu.requests[0];
			expect(Buffer.byteLength(request?.body ?? "", "utf8")).toBeLessThanOrEqual(20 * 1024);
			const note = (cards()[0] as Card).card.body.elements[0]?.content ?? "";
			expect(note.endsWith("…（已截断）")).toBe(true);
			expect(note.length).toBeLessThan(4000);
			expect(facts(cards()[0] as Card)).toBeDefined();
			expect(cards()[0]?.card.body.elements.map((e) => e.tag)).toEqual([
				"markdown",
				"markdown",
				"markdown",
				"button",
			]);
		});

		it("没有配置对外地址（SFLY_PUBLIC_URL）时不显示按钮", async () => {
			await agent.disconnect();
			await feishu.close();
			await cp.close();
			await start({});
			const id = await scenario(single(), { trigger: "always" });
			await runEnding(id, "success");

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const elements = (cards()[0] as Card).card.body.elements;
			expect(elements.map((e) => e.tag)).toEqual(["markdown"]);
		});
	});

	describe("运行详情里的状态", () => {
		const settled = async (runId: string): Promise<RunView["run_notification"]> =>
			(await api.run(runId)).run_notification;

		it("运行结束时消息已经在队列里：飞书不响应时是排队中", async () => {
			feishu.reply({ hang: true });
			const id = await scenario(single());
			const runId = await runEnding(id, "failed");

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(await settled(runId)).toEqual({ status: "queued", bot: "ops", reason: null });
		});

		it("投递失败：运行通知是失败并写明原因，运行的结果不变", async () => {
			feishu.reply({ code: 19024 });
			const id = await scenario(single(), { trigger: "always" });
			const runId = await runEnding(id, "success");

			await eventually(async () => expect((await settled(runId))?.status).toBe("failed"));
			const state = await settled(runId);
			expect(state?.reason).toContain("关键词");
			expect(state?.reason).not.toContain(TOKEN);
			expect((await api.run(runId)).status).toBe("success");
		});

		it("机器人在消息投递之前被删除：已丢弃", async () => {
			feishu.reply({ hang: true });
			const id = await scenario(single());
			const runId = await runEnding(id, "failed");
			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const removed = await cp.fetch("/feishu-bots/ops", {
				method: "DELETE",
				headers: { "x-sfly-nickname": "tester" },
			});
			expect(removed.status).toBe(204);

			await cp.restart();

			await eventually(async () => expect((await settled(runId))?.status).toBe("discarded"));
			expect((await settled(runId))?.reason).toContain("已被删除");
		});

		it("机器人在运行结束时已经不存在：触发不被拦截，运行详情里是「未发送：机器人已删除」", async () => {
			await api.createFeishuBot("gone", feishu.webhookUrl("gone-token"));
			const id = await scenario(single(), { bot: "gone", trigger: "always" });
			const removed = await cp.fetch("/feishu-bots/gone", {
				method: "DELETE",
				headers: { "x-sfly-nickname": "tester" },
			});
			expect(removed.status).toBe(204);

			const runId = await runEnding(id, "success");

			expect(await settled(runId)).toEqual({
				status: "not_sent",
				bot: "gone",
				reason: "机器人已删除",
			});
			expect(feishu.requests).toHaveLength(0);
		});
	});

	describe("控制面重启", () => {
		it("运行结束后马上重启：消息接着投递，只有这一张卡片，不漏发也不重复发", async () => {
			feishu.reply({ hang: true });
			const id = await scenario(single());
			const runId = await runEnding(id, "failed");
			await eventually(() => expect(feishu.requests).toHaveLength(1));

			await cp.restart();

			// 被中断的那次请求不记结果，重启后同一张卡片再发一次并送达。
			await eventually(() => expect(feishu.requests).toHaveLength(2));
			await eventually(async () =>
				expect((await api.run(runId)).run_notification).toMatchObject({ status: "delivered" }),
			);
			expect(feishu.requests[1]?.body).toBe(feishu.requests[0]?.body);

			// 再重启一次：已送达的不会再发，重启时也不会为已经结束的运行补发。
			// 随后另一个运行的卡片到达时，前面只有这两次请求。
			await cp.restart();
			const other = await api.orchestrationWith(
				{ nodes: [{ id: "entry", kind: "entry", params: [] }], edges: [], packages: {} },
				"另一个",
			);
			await notification(other, { bot: "ops", trigger: "always" });
			await api.triggerOk(other);
			await eventually(() => expect(feishu.requests).toHaveLength(3));
			expect((cards()[2] as Card).card.header.title.content).toBe("另一个");
		});
	});
});
