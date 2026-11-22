// 切入点 A：运行通知（#232、#446，ADR 0020、docs/SEMANTICS.md §6）：运行通知是兜底，场景设置里选了机器人的场景，
// 运行失败或被取消时由控制面发一张卡片，写明哪个节点为什么失败；成功的运行从不发。
// HTTP API + 假 Agent + 真实 PostgreSQL + 手动时钟 + 假飞书 Webhook 服务（support/fake-feishu.ts）。
import { errorHeadline, runsApi, runViewFailures } from "@sfly/schema";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { resolveRunFocus } from "../src/focus/run-focus.js";
import { readNodeError } from "../src/runs/run-read.js";
import { ApiClient, type RunView } from "./support/api-client.js";
import { chainOf, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { ErrorKind, FakeAgent, TaskStatus } from "./support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { benchDocument, publishBench, putFocusItemsOk } from "./support/focus-items.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

// 运行通知不再读关注项（#446）：把 resolveRunFocus 换成对真实实现包一层的 vi.fn，数它被调用了几次。
// 控制面里所有调用 resolveRunFocus 的地方（关注项接口、控制台）读到的都是这一份，真实实现照常执行。
vi.mock("../src/focus/run-focus.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/focus/run-focus.js")>();
	return { ...actual, resolveRunFocus: vi.fn(actual.resolveRunFocus) };
});

// 读第一个失败节点的失败原因出错时，运行照常结束（#533 审查）：把 readNodeError 换成对真实实现包一层的 vi.fn，
// 个别用例让它抛错。控制面里读运行的其他地方不用它。
vi.mock("../src/runs/run-read.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/runs/run-read.js")>();
	return { ...actual, readNodeError: vi.fn(actual.readNodeError) };
});

const TOKEN = "tok-6c1f0d52-90a7-4e3b-8f44-2d7a1b9c0e35";
const PUBLIC_URL = "https://sfly.example.com";
/** 明显的假值：入口参数里声明为 secret 的值。 */
const SECRET = "s3cr3t-value-for-notify";
const MASK = "******";

type Node = Record<string, unknown> & { id: string };
type Trigger = "failed" | "failed_or_cancelled";
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

	/** 默认配置了对外地址（SFLY_PUBLIC_URL）；没有配置的情况在「卡片」一组里另起控制面。 */
	async function start(
		options: Parameters<typeof startTestControlPlane>[0] = { publicHttpUrl: PUBLIC_URL },
	) {
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
	/** 等飞书收到了唯一的一张卡片并返回它。 */
	const onlyCard = async (): Promise<Card> => {
		await eventually(() => expect(feishu.requests).toHaveLength(1));
		return cards()[0] as Card;
	};
	const facts = (card: Card) =>
		card.card.body.elements.find((e) => e.content?.includes("**场景**"));
	/** 「失败的节点」那一段（没有失败的节点时没有这一段）。 */
	const failureOf = (card: Card) =>
		card.card.body.elements.find((e) => e.content?.startsWith("**失败的节点**"));
	/** 卡片上除标题以外的全部文字（各元素的 markdown 正文，按钮写 button）。 */
	const textOf = (card: Card) => card.card.body.elements.map((e) => e.content ?? e.tag).join("\n");
	/** 「失败的节点」那一段里某个标签后面的内容；没有这一行时为 undefined。 */
	const fieldOf = (card: Card, label: string): string | undefined => {
		const prefix = `**${label}**：`;
		return failureOf(card)
			?.content?.split("\n")
			.find((line) => line.startsWith(prefix))
			?.slice(prefix.length);
	};

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
	/** 触发一次运行，让单个包节点 a 带着给定的错误信息和出错位置失败。 */
	async function runFailing(
		id: string,
		error: { message: string; location?: string },
		params: Record<string, unknown> = {},
	): Promise<string> {
		const runId = await api.triggerOk(id, params);
		await agent.fail(
			await agent.nextAssign(),
			error.message,
			ErrorKind.NODE_ERROR,
			undefined,
			error.location,
		);
		await status(runId, "failed");
		return runId;
	}
	/** 运行视图里这个节点的错误（按 HTTP 契约解析后的 `error`）。 */
	const viewError = async (runId: string, nodeId: string) =>
		(await api.run(runId)).chains.flatMap((c) => c.nodes).find((n) => n.node_id === nodeId)
			?.error ?? null;
	const single = () => flow([echo("a")]);

	describe("触发条件", () => {
		it.each<[Trigger, Ending, "发" | "不发"]>([
			["failed", "success", "不发"],
			["failed", "failed", "发"],
			["failed", "cancelled", "不发"],
			["failed_or_cancelled", "success", "不发"],
			["failed_or_cancelled", "failed", "发"],
			["failed_or_cancelled", "cancelled", "发"],
		])("%s：运行%s时%s（成功的运行从不发运行通知）", async (trigger, ending, verdict) => {
			const id = await scenario(single(), { trigger });
			const runId = await runEnding(id, ending);

			if (verdict === "发") {
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
			const failed = await runEnding(id, "failed");
			expect((await api.run(failed)).run_notification).toBeNull();
			const cancelled = await runEnding(id, "cancelled");
			expect((await api.run(cancelled)).run_notification).toBeNull();
			const succeeded = await runEnding(id, "success");
			expect((await api.run(succeeded)).run_notification).toBeNull();
			expect(feishu.requests).toHaveLength(0);
		});

		it("读的是运行结束时场景当前的设置：运行中改了设置，按新设置发", async () => {
			// 运行开始时是「仅失败」，取消的运行不发；运行中改成「失败和取消」并换了标题，取消之后按新设置发。
			const id = await scenario(single(), { trigger: "failed", title: "旧标题" });
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();
			await notification(id, { trigger: "failed_or_cancelled", title: "新标题" });
			await api.cancelOk(runId);
			await agent.nextCancel();
			await agent.cancelled(a);
			await status(runId, "cancelled");

			const card = await onlyCard();
			expect(card.card.header.title.content).toBe("新标题");
			expect(card.card.header.subtitle?.content).toBe("运行已取消");
		});

		it("运行中把机器人设成 null：按新设置不发，失败的运行也不发", async () => {
			const id = await scenario(single());
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();
			await notification(id, { bot: null });
			await agent.fail(a, "boom");
			await status(runId, "failed");

			expect((await api.run(runId)).run_notification).toBeNull();
			expect(feishu.requests).toHaveLength(0);
		});
	});

	describe("卡片", () => {
		it("失败的运行：标题、副标题、颜色、附加说明、场景/运行编号/触发人、第一个失败的节点和失败原因、「查看运行」按钮", async () => {
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
								].join("\n"),
							},
							{
								tag: "markdown",
								content: ["**失败的节点**：主链：a", "**失败原因**：boom"].join("\n"),
							},
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

		it.each<[string, Exclude<Ending, "success">, string, string]>([
			["失败", "failed", "red", "运行失败"],
			["取消", "cancelled", "grey", "运行已取消"],
		])("运行%s：颜色 %s，副标题「%s」；标题默认是场景名，没有附加说明时不出现；只有失败的运行有「失败的节点」一段", async (_, ending, color, subtitle) => {
			const id = await scenario(single(), { trigger: "failed_or_cancelled" }, "默认标题的场景");
			await runEnding(id, ending);

			const card = await onlyCard();
			expect(card.card.header).toEqual({
				title: { tag: "plain_text", content: "默认标题的场景" },
				subtitle: { tag: "plain_text", content: subtitle },
				template: color,
			});
			// 附加说明为空：第一个元素就是各个字段；取消的运行没有失败的节点，也就没有失败的那一段。
			expect(card.card.body.elements[0]).toBe(facts(card));
			expect(card.card.body.elements.map((e) => e.tag)).toEqual(
				ending === "failed" ? ["markdown", "markdown", "button"] : ["markdown", "button"],
			);
			expect(failureOf(card) !== undefined).toBe(ending === "failed");
			expect(textOf(card).includes("失败原因")).toBe(ending === "failed");
		});

		it("卡片里没有关注项、预设、开始时间、耗时：这些信息由场景自己的节点用 ctx.notify 发", async () => {
			const id = await scenario(single());
			clock.advance(125_000);
			await runEnding(id, "failed");

			const card = await onlyCard();
			const text = `${card.card.header.title.content}\n${textOf(card)}`;
			for (const gone of ["关注项", "预设", "开始时间", "耗时", "2026-01-01"]) {
				expect(text, gone).not.toContain(gone);
			}
		});

		it("没有配置对外地址（SFLY_PUBLIC_URL）时不显示按钮", async () => {
			await agent.disconnect();
			await feishu.close();
			await cp.close();
			await start({});
			const id = await scenario(single());
			await runEnding(id, "failed");

			const elements = (await onlyCard()).card.body.elements;
			expect(elements.map((e) => e.tag)).toEqual(["markdown", "markdown"]);
		});

		it("附加说明在 JSON 里占的字节数超过 20 KB 时截断，其余字段不受影响", async () => {
			// 设置里附加说明最多 4000 个字符；控制字符在 JSON 里要转义成 6 个字节，刚好撑过飞书的上限。
			const id = await scenario(single(), { note: "\u0001".repeat(4000) });
			await runEnding(id, "failed");

			const card = await onlyCard();
			expect(Buffer.byteLength(feishu.requests[0]?.body ?? "", "utf8")).toBeLessThanOrEqual(
				20 * 1024,
			);
			const note = card.card.body.elements[0]?.content ?? "";
			expect(note.endsWith("…（已截断）")).toBe(true);
			expect(note.length).toBeLessThan(4000);
			expect(facts(card)).toBeDefined();
			expect(failureOf(card)?.content).toBe("**失败的节点**：主链：a\n**失败原因**：boom");
			expect(card.card.body.elements.map((e) => e.tag)).toEqual([
				"markdown",
				"markdown",
				"markdown",
				"button",
			]);
		});
	});

	describe("第一个失败的节点", () => {
		it("有多个失败的节点时只写第一个，不列清单、不写总数", async () => {
			const nodes = [
				echo("f0"),
				...Array.from({ length: 12 }, (_, i) => echo(`f${i + 1}`, { always: true })),
			];
			const id = await scenario(flow(nodes));
			const runId = await api.triggerOk(id);
			for (let i = 0; i < 13; i++) await agent.fail(await agent.nextAssign(), `原因 ${i}`);
			await status(runId, "failed");

			const card = await onlyCard();
			expect(failureOf(card)?.content).toBe("**失败的节点**：主链：f0\n**失败原因**：原因 0");
			const text = textOf(card);
			expect(text.match(/失败的节点/g)).toHaveLength(1);
			expect(text).not.toContain("共 13 个");
			expect(text).not.toContain("f1：");
			expect(text).not.toContain("- ");
			expect(text).not.toContain("原因 1");
		});

		it("和运行视图里的「第一个失败的节点」同一个：按失败的先后，不是链上排在前面的那个", async () => {
			// 主链的 m 和子流程的 s 同时派发，s 先失败、m 晚 5 秒失败；主链排在子流程前面，但第一个失败的是 s。
			const id = await scenario(
				orchestration(
					[
						[{ id: "entry", kind: "entry", params: [] }, spawn("go"), echo("m")],
						[{ id: "sub", kind: "subflow_entry", name: "压测", params: [] }, echo("s")],
					],
					[["go", "sub"]],
				),
			);
			const runId = await api.triggerOk(id);
			const assigned = [await agent.nextAssign(), await agent.nextAssign()];
			const task = (nodeId: string) => {
				const found = assigned.find((a) => a.nodeId === nodeId);
				if (!found) throw new Error(`没有派发节点 ${nodeId}`);
				return found;
			};
			await agent.fail(task("s"), "子流程里的节点先失败");
			clock.advance(5_000);
			await agent.fail(task("m"), "主链上的节点后失败");
			await status(runId, "failed");

			const view = runsApi.get.response.parse(await api.getJson(`/runs/${runId}`));
			const failures = runViewFailures(view.chains);
			expect(failures.map((f) => f.node.node_id)).toEqual(["s", "m"]);
			const instance = chainOf(await api.run(runId), "sub").id.slice(0, 8);

			const card = await onlyCard();
			expect(failureOf(card)?.content).toBe(
				[`**失败的节点**：子流程 压测 · ${instance}：s`, "**失败原因**：子流程里的节点先失败"].join(
					"\n",
				),
			);
			expect(textOf(card)).not.toContain("主链上的节点后失败");
		});

		it("第一个失败的节点带上所在的链：子流程写子流程名称和实例短 ID", async () => {
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

			const card = await onlyCard();
			expect(failureOf(card)?.content).toBe(
				`**失败的节点**：子流程 压测 · ${instance}：b\n**失败原因**：boom`,
			);
		});

		it.each<[string, Record<string, unknown>, string]>([
			[
				"有显示名称：写成「显示名称（节点 ID）」",
				{ display_name: "创建测试用户" },
				"创建测试用户（a）",
			],
			["没有显示名称：只写节点 ID", {}, "a"],
			["显示名称和节点 ID 相同：只写节点 ID", { display_name: "a" }, "a"],
		])("第一个失败的节点%s", async (_, extra, written) => {
			const id = await scenario(flow([echo("a", extra)]));
			await runEnding(id, "failed");

			expect(fieldOf(await onlyCard(), "失败的节点")).toBe(`主链：${written}`);
		});

		it("子流程里失败的节点也写显示名称；名称取自运行绑定的版本，运行中改了场景不影响", async () => {
			const document = (name: string) =>
				orchestration(
					[
						[{ id: "entry", kind: "entry", params: [] }, spawn("go")],
						[
							{ id: "sub", kind: "subflow_entry", name: "压测", params: [] },
							echo("b", { display_name: name }),
						],
					],
					[["go", "sub"]],
				);
			const id = await scenario(document("压测下单接口"));
			const runId = await api.triggerOk(id);
			await api.saveVersion(id, document("改过的名字"));
			await agent.fail(await agent.nextAssign(), "boom");
			await status(runId, "failed");
			const instance = chainOf(await api.run(runId), "sub").id.slice(0, 8);

			const card = await onlyCard();
			expect(fieldOf(card, "失败的节点")).toBe(`子流程 压测 · ${instance}：压测下单接口（b）`);
		});
	});

	describe("失败原因", () => {
		it.each<[string, string, string]>([
			["一行文字", "boom", "boom"],
			[
				"错误信息有堆栈（空行之后）时只取第一行",
				'ValueError: 余额不足\n\nTraceback (most recent call last):\n  File "pay.py", line 3, in run\nValueError: 余额不足',
				"ValueError: 余额不足",
			],
			[
				"第一行以冒号结尾时接上下一行，行首的异常模块路径去掉",
				"sfly_std.assert_.AssertionFailed: 2 条断言不通过：\n第 1 条：响应码不是 200\n第 2 条：…",
				"AssertionFailed: 2 条断言不通过：第 1 条：响应码不是 200",
			],
			["前面有空行时取第一行有内容的", "\n\n  下单失败  \n库存不足", "下单失败"],
		])("卡片上的失败原因和监控页头同一个 errorHeadline，不是整段错误信息：%s", async (_, message, expected) => {
			const id = await scenario(single());
			const runId = await runFailing(id, { message });

			const card = await onlyCard();
			// 期望值取自运行视图里这个节点的 error.message，按同一个函数算，不在测试里再写一遍规则。
			const view = await viewError(runId, "a");
			expect(view?.message).toBe(message);
			expect(fieldOf(card, "失败原因")).toBe(errorHeadline(view?.message));
			expect(fieldOf(card, "失败原因")).toBe(expected);
		});

		it("错误信息里有 secret 参数的值时卡片里是掩码，不是原值", async () => {
			const document = single();
			document.nodes[0] = {
				id: "entry",
				kind: "entry",
				params: [{ name: "token", type: "string", secret: true }],
			};
			const id = await scenario(document);
			const runId = await runFailing(
				id,
				{ message: `auth failed for ${SECRET}\n\nTraceback: ${SECRET}` },
				{ token: SECRET },
			);

			const card = await onlyCard();
			expect(fieldOf(card, "失败原因")).toBe(`auth failed for ${MASK}`);
			expect(fieldOf(card, "失败原因")).toBe(errorHeadline((await viewError(runId, "a"))?.message));
			// 整个请求体里（标题、各段文字、链接）都没有原值。
			expect(feishu.requests[0]?.body).not.toContain(SECRET);
		});

		it("错误信息的第一行超过 300 个字符时截断，末尾加「…」", async () => {
			const id = await scenario(single());
			const runId = await runFailing(id, { message: `${"错".repeat(301)}\n第二行` });

			const reason = fieldOf(await onlyCard(), "失败原因");
			expect(reason).toBe(`${"错".repeat(300)}…`);
			// 截的是卡片上的这一行，运行视图里的错误信息原样保留。
			expect((await viewError(runId, "a"))?.message).toBe(`${"错".repeat(301)}\n第二行`);
		});

		it("恰好 300 个字符不截断；字符数按 Unicode 字符算，一个字符不会被截成两半", async () => {
			const exactly = await scenario(single(), {}, "恰好 300");
			await runFailing(exactly, { message: "好".repeat(300) });
			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(fieldOf(cards()[0] as Card, "失败原因")).toBe("好".repeat(300));

			// 「𠮷」在 UTF-16 里占两个码元：按码元数截会把最后一个字符截成两半。
			const astral = await scenario(single(), {}, "补充平面字符");
			await runFailing(astral, { message: "𠮷".repeat(301) });
			await eventually(() => expect(feishu.requests).toHaveLength(2));
			const reason = fieldOf(cards()[1] as Card, "失败原因");
			expect(reason).toBe(`${"𠮷".repeat(300)}…`);
			expect([...(reason ?? "")]).toHaveLength(301);
		});

		it("没有错误信息时只有失败的节点，没有「失败原因」那一行", async () => {
			const id = await scenario(single());
			await runFailing(id, { message: "" });

			const card = await onlyCard();
			expect(failureOf(card)?.content).toBe("**失败的节点**：主链：a");
			expect(textOf(card)).not.toContain("失败原因");
		});

		it("节点重试过：失败原因是最后一次失败的尝试的，不是第一次的", async () => {
			const id = await scenario(flow([echo("a", { retries: 1 })]));
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "第一次尝试的原因");
			await agent.fail(await agent.nextAssign(), "第二次尝试的原因");
			await status(runId, "failed");

			const card = await onlyCard();
			expect(fieldOf(card, "失败原因")).toBe("第二次尝试的原因");
			expect(textOf(card)).not.toContain("第一次尝试的原因");
		});
	});

	describe("出错位置", () => {
		it("节点失败带出错位置：「失败原因」的下一行写「出错位置」，和运行视图里的 error.location 一致", async () => {
			const id = await scenario(single());
			const runId = await runFailing(id, { message: "boom", location: "stub.echo 第 12 行" });

			const card = await onlyCard();
			expect(failureOf(card)?.content).toBe(
				["**失败的节点**：主链：a", "**失败原因**：boom", "**出错位置**：stub.echo 第 12 行"].join(
					"\n",
				),
			);
			expect(fieldOf(card, "出错位置")).toBe((await viewError(runId, "a"))?.location);
		});

		it("没有出错位置时这一行不出现", async () => {
			const id = await scenario(single());
			await runFailing(id, { message: "boom" });

			const card = await onlyCard();
			expect(failureOf(card)?.content).toBe("**失败的节点**：主链：a\n**失败原因**：boom");
			expect(textOf(card)).not.toContain("出错位置");
		});

		it("没有错误信息但有出错位置：写节点和出错位置，没有「失败原因」那一行", async () => {
			const id = await scenario(single());
			await runFailing(id, { message: "", location: "stub.echo 第 7 行" });

			expect(failureOf(await onlyCard())?.content).toBe(
				"**失败的节点**：主链：a\n**出错位置**：stub.echo 第 7 行",
			);
		});

		it("出错位置里有 secret 参数的值时同样是掩码", async () => {
			const document = single();
			document.nodes[0] = {
				id: "entry",
				kind: "entry",
				params: [{ name: "token", type: "string", secret: true }],
			};
			const id = await scenario(document);
			await runFailing(
				id,
				{ message: "boom", location: `login.py 第 3 行 token=${SECRET}` },
				{ token: SECRET },
			);

			const card = await onlyCard();
			expect(fieldOf(card, "出错位置")).toBe(`login.py 第 3 行 token=${MASK}`);
			expect(feishu.requests[0]?.body).not.toContain(SECRET);
		});
	});

	describe("运行结束时不读关注项", () => {
		it("场景设了关注项也不读：卡片照常发出，resolveRunFocus 一次都没被调用，卡片里没有关注项", async () => {
			await publishBench(cp);
			const id = await scenario(benchDocument());
			const view = await putFocusItemsOk(api, id, [
				{ node_id: "load", chart: "TPS", title: "吞吐" },
				{ node_id: "probe", chart: "level" },
			]);
			expect(view.focus_items).toHaveLength(2);
			const runFocus = vi.mocked(resolveRunFocus);
			runFocus.mockClear();

			const runId = await api.triggerOk(id);
			const load = await agent.nextAssign();
			agent.metrics(load, [["tps", Date.UTC(2026, 0, 1) / 1000 + 1, 500]]);
			await agent.sync();
			await agent.fail(load, "boom");
			await status(runId, "failed");

			const card = await onlyCard();
			expect(card.card.header.subtitle?.content).toBe("运行失败");
			expect(failureOf(card)?.content).toBe("**失败的节点**：主链：load\n**失败原因**：boom");
			expect(card.card.body.elements.map((e) => e.tag)).toEqual(["markdown", "markdown", "button"]);
			expect(textOf(card)).not.toContain("关注项");
			expect(textOf(card)).not.toContain("吞吐");
			expect(runFocus).not.toHaveBeenCalled();

			// 对照：这个替身确实接在控制面用的那个模块上，读关注项的接口一调用，它就记一次。
			const read = await api.get(`/runs/${runId}/focus`);
			expect(read.status, await read.clone().text()).toBe(200);
			expect(runFocus).toHaveBeenCalledTimes(1);
		});
	});

	// 通知是运行结束事务里的一部分（#232：运行的最终状态和「要发这张卡片」一起提交），但从不拦住运行结束：
	// 为通知做的任何一步出错（不认识的触发条件、读失败原因、拼卡片），结果都是「这次不发，记一条日志」，运行照常结束。
	describe("为通知做的事出错不拦住运行结束", () => {
		let errors: MockInstance<typeof console.error>;

		// 控制面的日志默认关着：这一组要看到「记了一条日志」，所以换一个开着日志的控制面。
		beforeEach(async () => {
			await agent.disconnect();
			await feishu.close();
			await cp.close();
			await start({ publicHttpUrl: PUBLIC_URL, logger: true });
			errors = vi.spyOn(console, "error").mockImplementation(() => {});
		});
		afterEach(async () => {
			errors.mockRestore();
			// 换回真实的实现（用例里换成了会出错的）。
			const actual =
				await vi.importActual<typeof import("../src/runs/run-read.js")>("../src/runs/run-read.js");
			vi.mocked(readNodeError).mockReset().mockImplementation(actual.readNodeError);
		});

		/** 运行结束后：运行是失败、Agent 还连着能接新任务、没有发卡片、运行详情里没有运行通知；控制面日志里有这条错误。 */
		async function expectRunEndedAndNothingSent(runId: string, reason: RegExp) {
			expect((await api.run(runId)).run_notification).toBeNull();
			expect(agent.ended).toBe(false);
			const online = await api.get("/agents");
			expect(await online.text()).toContain('"status":"online"');
			expect(feishu.requests).toHaveLength(0);
			const logged = errors.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
			expect(logged).toMatch(/run notification/);
			expect(logged).toMatch(reason);
		}

		/** 库里直接写进一个接口写不进去的触发条件（先去掉约束；迁移加的约束让数据库自己也拒绝，见迁移测试）。 */
		async function writeTrigger(scenarioId: string, trigger: string) {
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query(
					"alter table orchestrations drop constraint if exists orchestrations_run_notify_trigger",
				);
				await client.query("update orchestrations set run_notify_trigger = $1 where id = $2", [
					trigger,
					scenarioId,
				]);
			} finally {
				await client.end();
			}
		}

		it("库里是不认识的触发条件：运行照常以失败结束，Agent 没有被断开，不发通知，控制面记一条错误", async () => {
			const id = await scenario(single());
			await writeTrigger(id, "always");

			const runId = await runEnding(id, "failed");

			await expectRunEndedAndNothingSent(runId, /always/);
			// 之后的运行照常：改回认识的值，通知又能发出去。
			await notification(id, { trigger: "failed" });
			const next = await runEnding(id, "failed");
			expect(feishu.requests).toHaveLength(1);
			expect((await api.run(next)).run_notification).toMatchObject({ bot: "ops" });
		});

		it("读第一个失败的节点时数据库报错（会让整个事务作废的那种）：运行照常以失败结束，不发通知，下一次通知照常", async () => {
			const id = await scenario(single());
			// 持续出错（不是只错一次）：运行结束的事务如果被这个错误作废，会被重做，只错一次就看不出来了。
			vi.mocked(readNodeError).mockImplementation(async (db) => {
				await db.execute(sql`select 1 / 0`);
				throw new Error("不会到这里");
			});

			const runId = await runEnding(id, "failed");

			await expectRunEndedAndNothingSent(runId, /Failed query: select 1 \/ 0/);
			// 出错之后事务还能继续用：同一个运行结束的事务里，运行的最终状态已经提交（上面断言了），
			// 之后读到真实实现时，下一次运行的通知照常发出。
			const actual =
				await vi.importActual<typeof import("../src/runs/run-read.js")>("../src/runs/run-read.js");
			vi.mocked(readNodeError).mockImplementation(actual.readNodeError);
			const next = await runEnding(id, "failed");
			const card = await onlyCard();
			expect(failureOf(card)?.content).toBe("**失败的节点**：主链：a\n**失败原因**：boom");
			expect((await api.run(next)).run_notification).toMatchObject({ bot: "ops" });
		});

		it("读第一个失败的节点时抛出普通的错误：同样不发、运行照常结束", async () => {
			const id = await scenario(single());
			vi.mocked(readNodeError).mockRejectedValue(new Error("读不出来"));

			const runId = await runEnding(id, "failed");

			await expectRunEndedAndNothingSent(runId, /读不出来/);
		});

		// 保存点里写到一半出错：入队和运行上的记录是同一个保存点里的两次写入，一起回滚。用数据库触发器让其中一次写入失败
		// （应用代码里没有别的办法让「语句本身合法、写入却失败」）。
		it.each([
			[
				"runs",
				"update",
				"if new.notification_bot is not null and old.notification_bot is null then raise exception 'probe: write to runs fails'; end if;",
				/Failed query: update "runs"/,
			],
			[
				"feishu_messages",
				"insert",
				"raise exception 'probe: insert into feishu_messages fails';",
				/Failed query: insert into "feishu_messages"/,
			],
		] as const)("保存点里写到一半出错（%s 上的触发器抛错）：入队和运行上的记录一起回滚，运行照常结束，下一次通知照常", async (table, event, body, failed) => {
			const id = await scenario(single());
			const fn = `probe_fail_${table}`;
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query(
					`create function ${fn}() returns trigger language plpgsql as $$ begin ${body} return new; end $$`,
				);
				await client.query(
					`create trigger ${fn} before ${event} on ${table} for each row execute function ${fn}()`,
				);

				const runId = await runEnding(id, "failed");

				// 回滚的是保存点里的全部：发送队列里没有这个运行的消息，运行上没有记「发给哪个机器人」，也没有「未发送」。
				const messages = await client.query(
					"select count(*)::int as n from feishu_messages where run_id = $1",
					[runId],
				);
				expect(messages.rows[0]?.n).toBe(0);
				const run = await client.query(
					"select status, notification_bot, notification_not_sent from runs where id = $1",
					[runId],
				);
				expect(run.rows[0]).toMatchObject({
					status: "failed",
					notification_bot: null,
					notification_not_sent: null,
				});
				await expectRunEndedAndNothingSent(runId, failed);

				// 触发器拿掉之后，下一次运行的通知照常发出。
				await client.query(`drop trigger ${fn} on ${table}`);
				const next = await runEnding(id, "failed");
				await onlyCard();
				expect((await api.run(next)).run_notification).toMatchObject({ bot: "ops" });
			} finally {
				await client.query(`drop trigger if exists ${fn} on ${table}`);
				await client.query(`drop function if exists ${fn}()`);
				await client.end();
			}
		});

		// 连接断了（不是通知自己的错）：保存点接不住，整个事务都没了。这时不能再记一条「这次不发」：它不是真的——
		// 运行结束的事务没有提交，Agent 的流被关，它重连重发结果，运行才结束，卡片才发出。错误照原样往外抛给已有的处理。
		it("连接在保存点里断开：错误往外抛，不记「这次不发」；Agent 重连重发结果之后运行结束、卡片发出一张", async () => {
			const id = await scenario(single());
			const actual =
				await vi.importActual<typeof import("../src/runs/run-read.js")>("../src/runs/run-read.js");
			let calls = 0;
			vi.mocked(readNodeError).mockImplementation(async (db, input) => {
				calls++;
				if (calls === 1) {
					// 被终止的连接，pg 会在这个连接上触发 error 事件；连接池只在连接空闲时接这个事件，借出去的连接上没有监听者，
					// 事件就成了未捕获的异常（这和通知无关，是 pg 的行为）：测试自己接住它。
					const session = (db as unknown as { session?: { client?: pg.PoolClient } }).session;
					session?.client?.on("error", () => {});
					await db.execute(sql`select pg_terminate_backend(pg_backend_pid())`);
				}
				return actual.readNodeError(db, input);
			});
			const runId = await api.triggerOk(id);
			const assigned = await agent.nextAssign();
			await agent.fail(assigned, "boom").catch(() => {});
			expect(errors.mock.calls.map((call) => call.map(String).join(" ")).join("\n")).not.toMatch(
				/run notification: not sent/,
			);

			// 重连，带上手上的任务，重发结果：这一次的事务正常提交。
			const again = await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				slots: 4,
				runningTasks: [{ taskId: assigned.taskId, attempt: assigned.attempt, started: true }],
			});
			try {
				await again.report({
					taskId: assigned.taskId,
					attempt: assigned.attempt,
					status: TaskStatus.FAILED,
					error: { kind: ErrorKind.NODE_ERROR, message: "boom", location: "" },
				});
				await status(runId, "failed");
				await onlyCard();
				expect((await api.run(runId)).run_notification).toMatchObject({ bot: "ops" });
			} finally {
				await again.disconnect();
			}
		});

		it("取消的运行同样：通知出错不影响运行记为已取消", async () => {
			const id = await scenario(single(), { trigger: "failed_or_cancelled" });
			await writeTrigger(id, "always");

			const runId = await runEnding(id, "cancelled");

			await expectRunEndedAndNothingSent(runId, /always/);
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
			const id = await scenario(single(), { trigger: "failed_or_cancelled" });
			const runId = await runEnding(id, "failed");

			await eventually(async () => expect((await settled(runId))?.status).toBe("failed"));
			const state = await settled(runId);
			expect(state?.reason).toContain("关键词");
			expect(state?.reason).not.toContain(TOKEN);
			expect((await api.run(runId)).status).toBe("failed");
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

		it("投递记录跟随运行的保留期：清理之后运行详情里不再有运行通知，运行本身还在", async () => {
			const id = await scenario(single(), { trigger: "failed_or_cancelled" });
			const runId = await runEnding(id, "failed");
			await eventually(async () => expect((await settled(runId))?.status).toBe("delivered"));

			clock.advance(31 * 24 * 3600 * 1000);

			await eventually(async () => expect((await settled(runId)) ?? null).toBeNull());
			expect((await api.run(runId)).status).toBe("failed");
		});

		it("机器人在运行结束时已经不存在：触发不被拦截，运行详情里是「未发送：机器人已删除」", async () => {
			await api.createFeishuBot("gone", feishu.webhookUrl("gone-token"));
			const id = await scenario(single(), { bot: "gone", trigger: "failed_or_cancelled" });
			const removed = await cp.fetch("/feishu-bots/gone", {
				method: "DELETE",
				headers: { "x-sfly-nickname": "tester" },
			});
			expect(removed.status).toBe(204);

			const runId = await runEnding(id, "failed");

			expect(await settled(runId)).toEqual({
				status: "not_sent",
				bot: "gone",
				reason: "机器人已删除",
			});
			expect((await api.run(runId)).status).toBe("failed");
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
			// 随后另一个运行的卡片到达时，前面只有这两次请求。（重启断开了假 Agent 的连接，另连一个。）
			await cp.restart();
			const second = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
			try {
				const other = await scenario(single(), {}, "另一个");
				await api.triggerOk(other);
				await second.fail(await second.nextAssign(), "boom");
				await eventually(() => expect(feishu.requests).toHaveLength(3));
				expect((cards()[2] as Card).card.header.title.content).toBe("另一个");
			} finally {
				await second.disconnect();
			}
		});
	});
});
