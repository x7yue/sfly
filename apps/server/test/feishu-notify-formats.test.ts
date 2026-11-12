// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
// 切入点 A：飞书通知节点的 Markdown 卡片和原始消息（#231，ADR 0020、docs/SEMANTICS.md §4.2）。
// HTTP API + 假 Agent + 真实 PostgreSQL + 假飞书 Webhook 服务（support/fake-feishu.ts）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type NodeView } from "./support/api-client.js";
import type { Node } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "tok-4f9a8c71-e2b0-43d6-9a55-0a1b2c3d4e5f";
const LIMIT = 20 * 1024;

const notify = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "feishu_notify",
	bot: "ops",
	...extra,
});
const card = (id: string, extra: Record<string, unknown> = {}): Node =>
	notify(id, { format: "card", title: id, markdown: id, ...extra });
const raw = (id: string, message: unknown, extra: Record<string, unknown> = {}): Node =>
	notify(id, { format: "raw", message, ...extra });
const echo = (id: string): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	inputs: {},
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

describe("飞书通知节点：Markdown 卡片与原始消息", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let feishu: FakeFeishu;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		feishu = await startFakeFeishu();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await api.createFeishuBot("ops", feishu.webhookUrl(TOKEN));
	});
	afterEach(async () => {
		await feishu.close();
		await cp.close();
	});

	const taskOf = (node: NodeView) => (node.attempts[0] as { task_id: string }).task_id;
	const logOf = async (node: NodeView): Promise<LogLine[]> =>
		(await api.getJson<{ lines: LogLine[] }>(`/tasks/${taskOf(node)}/logs`)).lines;
	const logLine = async (node: NodeView, match: (l: LogLine) => boolean): Promise<LogLine> => {
		let found: LogLine | undefined;
		await eventually(async () => {
			found = (await logOf(node)).find(match);
			expect(found).toBeDefined();
		});
		return found as LogLine;
	};
	/** 飞书收到的请求体。 */
	const bodies = () => feishu.requests.map((r) => r.json);
	const cardBody = (title: string, markdown: string, template = "blue") => ({
		msg_type: "interactive",
		card: {
			schema: "2.0",
			header: { title: { tag: "plain_text", content: title }, template },
			body: { elements: [{ tag: "markdown", content: markdown }] },
		},
	});

	describe("Markdown 卡片", () => {
		it("发出卡片 JSON 2.0：标题、颜色、正文都对，内嵌引用已替换；节点立即成功、没有输出，不需要 Agent", async () => {
			const id = await api.orchestrationWith(
				flow(
					[
						card("done", {
							title: "【${{ params.env }}】压测完成",
							color: "green",
							markdown: "**QPS** ${{ params.qps }}\n\n> 详见 [报告](https://example.com/r)",
						}),
					],
					[
						{ name: "env", type: "string" },
						{ name: "qps", type: "number" },
					],
				),
			);
			const runId = await api.triggerOk(id, { env: "A 环境", qps: 1200 });

			expect((await api.run(runId)).status).toBe("success");
			const node = await api.node(runId, "done");
			expect(node).toMatchObject({ kind: "feishu_notify", status: "success", agent: null });
			expect(node.attempts[0]).toMatchObject({
				outputs: {},
				inputs: {
					bot: "ops",
					format: "card",
					title: "【A 环境】压测完成",
					color: "green",
					markdown: "**QPS** 1200\n\n> 详见 [报告](https://example.com/r)",
				},
			});

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(feishu.requests[0]).toMatchObject({
				method: "POST",
				path: `/open-apis/bot/v2/hook/${TOKEN}`,
			});
			expect(bodies()).toEqual([
				cardBody(
					"【A 环境】压测完成",
					"**QPS** 1200\n\n> 详见 [报告](https://example.com/r)",
					"green",
				),
			]);
			await logLine(node, (l) => l.level === "info" && l.text.includes("已送达"));
		});

		it("五种标题颜色都按所选的颜色发出；没有选颜色是蓝色", async () => {
			const colors = ["blue", "green", "orange", "red", "grey"];
			const id = await api.orchestrationWith(
				flow([
					...colors.map((color) => card(color, { color })),
					notify("default", { format: "card", title: "默认", markdown: "x" }),
				]),
			);
			await api.triggerOk(id);
			await eventually(() => expect(feishu.requests).toHaveLength(6));
			expect(bodies().map((b) => (b as ReturnType<typeof cardBody>).card.header.template)).toEqual([
				...colors,
				"blue",
			]);
		});

		it("引用缺失的输出取 null（前面的节点失败、被跳过），节点照常发送并成功", async () => {
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
			const id = await api.orchestrationWith(
				flow(
					[
						echo("load"),
						card("bye", {
							always: true,
							title: "结果 ${{ nodes.load.outputs.v }}",
							markdown: "耗时 ${{ nodes.load.outputs.v }}",
						}),
					],
					[],
					{ agent: true },
				),
			);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "load 失败");

			await eventually(() => expect(bodies()).toEqual([cardBody("结果 null", "耗时 null")]));
			expect((await api.run(runId)).status).toBe("failed");
			expect((await api.node(runId, "bye")).status).toBe("success");
			await agent.disconnect();
		});

		it("正文超过 20 KB：截断，末尾加「…（已截断）」，发出的请求体不超过 20 KB，节点成功", async () => {
			const id = await api.orchestrationWith(
				flow(
					[card("long", { markdown: "${{ params.body }}" })],
					[{ name: "body", type: "string" }],
				),
			);
			const runId = await api.triggerOk(id, { body: "字".repeat(30_000) });

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const request = feishu.requests[0];
			expect(Buffer.byteLength(request?.body ?? "", "utf8")).toBeLessThanOrEqual(LIMIT);
			const content =
				(request?.json as ReturnType<typeof cardBody>).card.body.elements[0]?.content ?? "";
			expect(content.endsWith("…（已截断）")).toBe(true);
			expect(content.startsWith("字字字")).toBe(true);
			expect(content.length).toBeGreaterThan(6_000);
			expect(content.length).toBeLessThan(30_000);
			expect((await api.node(runId, "long")).status).toBe("success");
			expect((await api.run(runId)).status).toBe("success");
		});

		it("标题大到连截断后的正文都放不下：不发送，节点日志里有 warning，节点和运行仍然成功", async () => {
			const id = await api.orchestrationWith(
				flow(
					[card("huge", { title: "${{ params.t }}" }), notify("after", { text: "after" })],
					[{ name: "t", type: "string" }],
				),
			);
			const runId = await api.triggerOk(id, { t: "T".repeat(30_000) });

			const node = await api.node(runId, "huge");
			expect(node.status).toBe("success");
			const line = await logLine(node, (l) => l.level === "warn");
			expect(line.text).toContain("消息没有发送");
			expect(line.text).toContain("标题");
			expect((await api.run(runId)).status).toBe("success");
			// 同一个机器人的下一条消息不受影响。
			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(bodies()).toEqual([{ msg_type: "text", content: { text: "after" } }]);
		});

		it.each([
			["标题", { title: "${{ params.cfg }}" }],
			["正文", { markdown: "${{ params.cfg }} 和别的" }],
		])("%s里的内嵌引用解析出对象：不发送，节点日志里有 warning，节点成功", async (_field, extra) => {
			const id = await api.orchestrationWith(
				flow([card("n", extra)], [{ name: "cfg", type: "json" }]),
			);
			const runId = await api.triggerOk(id, { cfg: { a: 1 } });
			const node = await api.node(runId, "n");
			expect(node.status).toBe("success");
			const line = await logLine(node, (l) => l.level === "warn");
			expect(line.text).toContain("消息没有发送");
			expect(feishu.requests).toHaveLength(0);
			expect((await api.run(runId)).status).toBe("success");
		});
	});

	describe("原始消息", () => {
		const params = [
			{ name: "who", type: "string" },
			{ name: "msg", type: "json" },
			{ name: "n", type: "number" },
		];

		it("原样发出；字符串字段里的引用逐个解析，值里有引号、换行、反斜杠时请求体仍是有效 JSON", async () => {
			const awkward = 'He said "hi"\n第二行 \\ 反斜杠\t制表';
			const message = {
				msg_type: "interactive",
				card: {
					schema: "2.0",
					header: {
						title: { tag: "plain_text", content: "来自 ${{ params.who }}" },
						template: "red",
					},
					body: {
						elements: [
							{ tag: "markdown", content: "**${{ params.who }}**\n没有引用的行" },
							{ tag: "hr" },
						],
					},
				},
				extra: { n: 5, ok: true, nothing: null, list: ["${{ params.who }}", 1] },
			};
			const id = await api.orchestrationWith(flow([raw("r", message)], params));
			const runId = await api.triggerOk(id, { who: awkward, msg: {}, n: 1 });

			expect((await api.run(runId)).status).toBe("success");
			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const request = feishu.requests[0];
			// 收到的请求体是有效的 JSON（json 解析成功），里面的字符串值是引用替换后的原文。
			expect(request?.json).toEqual({
				msg_type: "interactive",
				card: {
					schema: "2.0",
					header: { title: { tag: "plain_text", content: `来自 ${awkward}` }, template: "red" },
					body: {
						elements: [{ tag: "markdown", content: `**${awkward}**\n没有引用的行` }, { tag: "hr" }],
					},
				},
				extra: { n: 5, ok: true, nothing: null, list: [awkward, 1] },
			});
			expect(() => JSON.parse(request?.body ?? "")).not.toThrow();
			const node = await api.node(runId, "r");
			expect(node.attempts[0]).toMatchObject({ inputs: { bot: "ops", format: "raw" } });
			await logLine(node, (l) => l.level === "info" && l.text.includes("已送达"));
		});

		it("整值引用入口参数：发出这个 json 参数的值", async () => {
			const message = {
				msg_type: "post",
				content: { post: { zh_cn: { title: "标题", content: [] } } },
			};
			const id = await api.orchestrationWith(flow([raw("r", "${{ params.msg }}")], params));
			await api.triggerOk(id, { who: "x", msg: message, n: 1 });
			await eventually(() => expect(bodies()).toEqual([message]));
		});

		it("飞书支持的 msg_type 都可以发（这里是 image 和 share_chat）", async () => {
			const image = { msg_type: "image", content: { image_key: "img_v2_xxx" } };
			const share = { msg_type: "share_chat", content: { share_chat_id: "oc_xxx" } };
			const id = await api.orchestrationWith(flow([raw("a", image), raw("b", share)]));
			await api.triggerOk(id);
			await eventually(() => expect(bodies()).toEqual([image, share]));
		});

		it.each([
			["message 还没有填写", undefined, "还没有填写"],
			["不是对象：数组", [], "不是一个对象"],
			["不是对象：字符串", "hello", "不是一个对象"],
			["不是对象：整值引用解析出数字", "${{ params.n }}", "不是一个对象"],
			["缺 msg_type", { content: { text: "x" } }, "msg_type"],
			["msg_type 不是飞书支持的类型", { msg_type: "audio", content: {} }, "msg_type"],
		])("%s：不发送，节点日志里写明原因，节点和运行仍然成功", async (_name, message, reason) => {
			const id = await api.orchestrationWith(
				flow([raw("r", message), notify("after", { text: "after" })], params),
			);
			const runId = await api.triggerOk(id, { who: "x", msg: {}, n: 5 });

			const node = await api.node(runId, "r");
			expect(node.status).toBe("success");
			const line = await logLine(node, (l) => l.level === "warn");
			expect(line.text).toContain("消息没有发送");
			expect(line.text).toContain(reason);
			expect((await api.run(runId)).status).toBe("success");
			// 同一个机器人的下一条消息照常发出，没有任何原始消息的请求。
			await eventually(() =>
				expect(bodies()).toEqual([{ msg_type: "text", content: { text: "after" } }]),
			);
		});

		it("超过 20 KB：不截断，不发送，节点日志里有 warning，节点和运行仍然成功", async () => {
			const message = { msg_type: "text", content: { text: "${{ params.who }}" } };
			const id = await api.orchestrationWith(flow([raw("big", message)], params));
			const runId = await api.triggerOk(id, { who: "a".repeat(25_000), msg: {}, n: 1 });

			const node = await api.node(runId, "big");
			expect(node.status).toBe("success");
			const line = await logLine(node, (l) => l.level === "warn");
			expect(line.text).toContain("消息没有发送");
			expect(line.text).toContain("20 KB");
			expect((await api.run(runId)).status).toBe("success");
			expect(feishu.requests).toHaveLength(0);
		});
	});

	describe("切换格式", () => {
		it("只有当前格式的字段生效：其他格式里留着的内容不会发出，也不参与解析", async () => {
			const stale = {
				text: "文本里还留着 ${{ params.nope }}",
				title: "旧标题",
				markdown: "旧正文",
				message: { msg_type: "audio" },
				at_all: true,
			};
			const id = await api.orchestrationWith(
				flow([
					notify("t", { ...stale, format: "text", text: "只发文本" }),
					notify("c", { ...stale, format: "card", title: "卡片", markdown: "只发卡片" }),
					notify("r", {
						...stale,
						format: "raw",
						message: { msg_type: "text", content: { text: "只发原始" } },
					}),
				]),
			);
			await api.triggerOk(id);
			await eventually(() => expect(feishu.requests).toHaveLength(3));
			expect(bodies()).toEqual([
				{ msg_type: "text", content: { text: '只发文本<at user_id="all">所有人</at>' } },
				cardBody("卡片", "只发卡片"),
				{ msg_type: "text", content: { text: "只发原始" } },
			]);
		});
	});
});
