// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
// 切入点 A：投递的可靠性（#230，ADR 0020）：退避重试、限速、积压、截断、重启续投、机器人删除后丢弃，
// 以及管理页要显示的「最近一次投递」和「积压条数」。
// HTTP API + 真实 PostgreSQL + 手动时钟 + 假飞书 Webhook 服务（support/fake-feishu.ts）。
//
// 退避、期限和限速都按控制面时间计算，测试用手动时钟推进，不睡眠：
// - 假飞书服务给每个请求记下到达时的控制面时间（FeishuRequest.at），间隔按它断言；
// - 要「恰好推进到下一次重试的时刻」时，先等控制面记下上一次的结果（管理页上的「最近一次投递」，和排下一次重试在同一个事务里），
//   再推进时钟，这样间隔是确定的；
// - 「不会发出」这类否定的结论，靠同一个机器人按顺序串行投递来证明：后面的消息到了，前面该重试的早就重试过了。
import { type FeishuBotView, feishuBotsApi, NICKNAME_HEADER } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import { ApiClient, type NodeView } from "./support/api-client.js";
import type { Node } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { type FakeFeishu, type FeishuReply, startFakeFeishu } from "./support/fake-feishu.js";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "tok-4f9a8c71-e2b0-43d6-9a55-0a1b2c3d4e5f";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TRUNCATED = "…（已截断）";
const AT_ALL = '<at user_id="all">所有人</at>';
/** 飞书请求体的上限。 */
const BODY_LIMIT = 20 * 1024;

/**
 * 请求在路上耗了时间：每个请求到达假飞书时，控制面时间先走过 `lags` 里的下一个值（用完后不再延迟）。
 * 手动时钟不会自己走，用它模拟真实世界里请求从发出到被飞书收到的这段延迟（例如一连串请求里第一个要建连接）。
 */
const networkLag = (clock: ManualClock, ...lags: number[]): Clock => ({
	now: () => {
		clock.advance(lags.shift() ?? 0);
		return clock.now();
	},
});

const notify = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "feishu_notify",
	bot: "ops",
	text: id,
	...extra,
});

/** 入口 + 单链；只有内置节点，不需要 Agent。 */
function flow(nodes: Node[], params: Array<Record<string, unknown>> = []) {
	const all: Node[] = [{ id: "entry", kind: "entry", params }, ...nodes];
	return {
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: {},
	};
}

interface LogLine {
	level: string;
	source: string;
	time: string;
	text: string;
}

describe("投递的可靠性", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let api: ApiClient;
	let feishu: FakeFeishu;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		clock = cp.clock as ManualClock;
		api = new ApiClient(cp);
		feishu = await startFakeFeishu({ clock });
		await api.createFeishuBot("ops", feishu.webhookUrl(TOKEN));
	});
	afterEach(async () => {
		await feishu.close();
		await cp.close();
	});

	const texts = () =>
		feishu.requests.map((r) => (r.json as { content: { text: string } }).content.text);
	/** 每个请求到达时的控制面时间（毫秒）。 */
	const arrivals = (server: FakeFeishu = feishu) =>
		server.requests.map((r) => (r.at as Date).getTime());
	/** 飞书按到达的时刻数：任意 1 秒（含右端点）里不超过 5 个、任意 1 分钟里不超过 100 个。 */
	const expectWithinRateLimits = (at: number[]) => {
		for (const t of at) {
			expect(at.filter((x) => x > t - SECOND && x <= t).length).toBeLessThanOrEqual(5);
			expect(at.filter((x) => x > t - MINUTE && x <= t).length).toBeLessThanOrEqual(100);
		}
	};
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
	const warnOf = (text: string) => (l: LogLine) => l.level === "warn" && l.text.includes(text);
	const botView = async (name = "ops"): Promise<FeishuBotView> => {
		const { bots } = feishuBotsApi.list.response.parse(await api.getJson("/feishu-bots"));
		const bot = bots.find((b) => b.name === name);
		expect(bot, `机器人「${name}」`).toBeDefined();
		return bot as FeishuBotView;
	};
	/** 等积压降到这个条数：最后一条请求到达假飞书之后，控制面还要记下它的结果。 */
	const backlogReaches = (count: number, bot = "ops") =>
		eventually(async () => expect((await botView(bot)).backlog).toBe(count));
	const botUrl = (name: string) => `/feishu-bots/${encodeURIComponent(name)}`;
	const removeBot = (name: string) =>
		cp.fetch(botUrl(name), {
			method: "DELETE",
			headers: { [NICKNAME_HEADER]: "tester" },
		});
	const replaceWebhook = (name: string, webhookUrl: string) =>
		cp.fetch(botUrl(name), {
			method: "PATCH",
			headers: { "content-type": "application/json", [NICKNAME_HEADER]: "tester" },
			body: JSON.stringify({ webhook_url: webhookUrl }),
		});
	const run = async (nodes: Node[], params: Array<Record<string, unknown>> = [], args = {}) => {
		const id = await api.orchestrationWith(flow(nodes, params));
		return api.triggerOk(id, args);
	};
	const messages = (count: number, extra: Record<string, unknown> = {}) =>
		Array.from({ length: count }, (_, i) => notify(`m${i + 1}`, extra));

	/**
	 * 等第 n 次请求到达，并且控制面已经记下它的结果（管理页上「最近一次投递」的时间就是它到达的控制面时间；
	 * 失败时排下一次重试和记结果在同一个事务里）。返回它到达时的控制面时间。
	 */
	const recorded = async (n: number, bot = "ops"): Promise<number> => {
		let at = 0;
		await eventually(async () => {
			const request = feishu.requests[n - 1];
			expect(request, `第 ${n} 次请求`).toBeDefined();
			at = (request?.at as Date).getTime();
			expect((await botView(bot)).last_delivery?.at).toBe(new Date(at).toISOString());
		});
		return at;
	};
	/** 每次检查之前把控制面时间推进 stepMs，直到检查通过：用来越过退避和限速，不睡眠。 */
	const advancing = (stepMs: number, check: () => void | Promise<void>, timeoutMs = 15_000) => {
		// 超时之后循环还会再跑一次：只推进这个测试自己的时钟。
		const own = clock;
		return eventually(async () => {
			own.advance(stepMs);
			await check();
		}, timeoutMs);
	};

	describe("可重试的失败按退避重试", () => {
		it.each([
			{ name: "HTTP 503", reply: { status: 503 } },
			{ name: "HTTP 429", reply: { status: 429 } },
			{ name: "飞书的限流错误码 11232", reply: { code: 11232 } },
		] satisfies Array<{
			name: string;
			reply: FeishuReply;
		}>)("$name：1 秒后重试，送达后节点日志里是 info，没有 warning", async ({ reply }) => {
			feishu.reply(reply);
			const runId = await run([notify("n")]);
			const first = await recorded(1);
			clock.advance(SECOND);

			await eventually(() => expect(texts()).toEqual(["n", "n"]));
			expect(arrivals()).toEqual([first, first + SECOND]);
			const node = await api.node(runId, "n");
			const line = await logLine(node, (l) => l.level === "info" && l.text.includes("已送达"));
			expect(line.text).toContain("第 2 次");
			expect((await logOf(node)).filter((l) => l.level === "warn")).toEqual([]);
			expect((await api.run(runId)).status).toBe("success");
		});

		it("网络错误同样重试：把 Webhook 地址换成能连上的之后，排队的消息发往新地址", async () => {
			const dead = await startFakeFeishu();
			const deadUrl = dead.webhookUrl("dead-token");
			await dead.close();
			await api.createFeishuBot("dead", deadUrl);
			const runId = await run([notify("n", { bot: "dead" })]);
			await eventually(async () => {
				const bot = await botView("dead");
				expect(bot.last_delivery).toMatchObject({ ok: false });
				expect(bot.backlog).toBe(1);
			});
			expect((await botView("dead")).last_delivery?.message).toContain("无法连接");

			expect((await replaceWebhook("dead", feishu.webhookUrl("new-token"))).status).toBe(200);
			clock.advance(SECOND);

			await eventually(() => expect(feishu.requests).toHaveLength(1));
			expect(feishu.requests[0]?.path).toBe("/open-apis/bot/v2/hook/new-token");
			await logLine(await api.node(runId, "n"), (l) => l.text.includes("已送达"));
			await backlogReaches(0, "dead");
		});

		it("间隔从 1 秒起逐次翻倍，最长 60 秒；重试的一直是同一条消息", async () => {
			feishu.replyAlways({ status: 503 });
			await run([notify("n")]);
			const start = await recorded(1);
			const delays = [1, 2, 4, 8, 16, 32, 60, 60].map((s) => s * SECOND);
			for (const [i, delay] of delays.entries()) {
				clock.advance(delay);
				await recorded(i + 2);
			}

			expect(arrivals().map((at) => (at - start) / SECOND)).toEqual([
				0, 1, 3, 7, 15, 31, 63, 123, 183,
			]);
			expect(new Set(texts())).toEqual(new Set(["n"]));
		});

		it("重试期间同一个机器人后面的消息不会越过它；别的机器人不受影响", async () => {
			await api.createFeishuBot("other", feishu.webhookUrl("other-token"));
			feishu.replyTo(TOKEN, { status: 503 });
			await run(messages(3));
			await run([notify("free", { bot: "other" })]);

			// ops 的第一条在等重试，other 的消息照常送达。
			await eventually(() => expect(texts()).toContain("free"));
			await eventually(async () => {
				const bot = await botView();
				expect(bot.last_delivery).toMatchObject({ ok: false });
				expect(bot.backlog).toBe(3);
			});
			clock.advance(SECOND);

			const ops = () => feishu.requests.filter((r) => r.path.endsWith(TOKEN)).map((r) => r.body);
			await eventually(() => expect(ops()).toHaveLength(4));
			expect(
				ops().map((body) => (JSON.parse(body) as { content: { text: string } }).content.text),
			).toEqual(["m1", "m1", "m2", "m3"]);
		});
	});

	describe("不可重试的错误只发一次就记为失败", () => {
		it.each([
			{
				name: "9499：请求格式不对（飞书回 HTTP 400）",
				reply: { status: 400, code: 9499 },
				includes: ["请求格式不对", "9499"],
			},
			{
				name: "19021：开启了签名校验",
				reply: { code: 19021 },
				includes: ["签名校验", "19021", "关键词", "IP 白名单"],
			},
			{
				name: "19022：出口 IP 不在白名单里",
				reply: { code: 19022 },
				includes: ["出口 IP", "19022"],
			},
			{ name: "19024：没有关键词", reply: { code: 19024 }, includes: ["关键词", "19024"] },
			{
				name: "未知的错误码",
				reply: { code: 99999, msg: "oops" },
				includes: ["99999", "oops"],
			},
			{ name: "HTTP 404", reply: { status: 404, code: 0 }, includes: ["HTTP 404"] },
		] satisfies Array<{
			name: string;
			reply: FeishuReply;
			includes: string[];
		}>)("$name：附上中文原因和下一步，后面的消息照常发出", async ({ reply, includes }) => {
			feishu.reply(reply);
			const runId = await run([notify("m1"), notify("m2")]);

			// 同一个机器人串行投递：m2 到了，说明 m1 没有留在重试里（留着的话它会先重发，m2 要等到它之后）。
			await advancing(MINUTE, () => expect(texts()).toEqual(["m1", "m2"]));
			const node = await api.node(runId, "m1");
			const line = await logLine(node, warnOf("投递失败"));
			for (const text of [...includes, "下一步"]) expect(line.text).toContain(text);
			expect(line.text).not.toContain(TOKEN);
			expect((await api.run(runId)).status).toBe("success");
			await backlogReaches(0);
		});
	});

	describe("从入队算起超过 10 分钟还没送达就记为失败", () => {
		it("按退避重试到期限为止，最后一次恰好在期限那一刻；失败写成 warning，节点和运行不受影响", async () => {
			feishu.replyAlways({ status: 503 });
			const start = clock.now().getTime();
			const runId = await run([notify("n")]);
			const schedule = [0, 1, 3, 7, 15, 31, 63, 123, 183, 243, 303, 363, 423, 483, 543, 600];
			for (const [i, offset] of schedule.entries()) {
				if (i > 0) clock.set(new Date(start + offset * SECOND));
				await recorded(i + 1);
			}

			expect(arrivals().map((at) => (at - start) / SECOND)).toEqual(schedule);
			const node = await api.node(runId, "n");
			const line = await logLine(node, warnOf("投递失败"));
			expect(line.time).toBe(new Date(start + 10 * MINUTE).toISOString());
			for (const text of ["10 分钟", "16 次", "HTTP 503", "下一步"]) {
				expect(line.text).toContain(text);
			}
			expect(node.status).toBe("success");
			expect((await api.run(runId)).status).toBe("success");
			await backlogReaches(0);

			// 失败的消息不再重试：之后的消息直接送达，前面没有它的重发。
			feishu.replyAlways({});
			await run([notify("after")]);
			await advancing(MINUTE, () => expect(texts().slice(schedule.length)).toEqual(["after"]));
		});
	});

	describe("限速：每个机器人每秒 5 条、每分钟 100 条", () => {
		it("突发 120 条消息：到达飞书的速率不超过每秒 5 条、每分钟 100 条，全部按入队顺序送达", {
			timeout: 90_000,
		}, async () => {
			const start = clock.now().getTime();
			const runId = await run(messages(120));
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));

			// 时间不动时，一秒的额度（5 条）马上发出，第 6 条要等。
			await backlogReaches(115);
			expect(arrivals()).toEqual(Array(5).fill(start));

			await advancing(SECOND / 2, () => expect(feishu.requests).toHaveLength(120), 80_000);

			expectWithinRateLimits(arrivals());
			expect(texts()).toEqual(messages(120).map((n) => n.id));
			await backlogReaches(0);
		});

		it("请求在路上耗了时间：第 6 条到达飞书仍比第 1 条晚满 1 秒（飞书按收到请求的时刻数，限速按响应回来的时刻算）", async () => {
			const start = clock.now().getTime();
			const slowStart = await startFakeFeishu({ clock: networkLag(clock, SECOND / 2) });
			try {
				await api.createFeishuBot("slow-start", slowStart.webhookUrl(TOKEN));
				const runId = await run(messages(6, { bot: "slow-start" }));
				await eventually(async () => expect((await api.run(runId)).status).toBe("success"));

				// 第 1 个请求发出时控制面时间是 start，飞书收到它时已经走到 start + 0.5 秒；后面 4 个紧跟着到达。
				await backlogReaches(1, "slow-start");
				expect(arrivals(slowStart)).toEqual(Array(5).fill(start + SECOND / 2));

				await advancing(100, () => expect(slowStart.requests).toHaveLength(6));

				const at = arrivals(slowStart);
				expect((at[5] as number) - (at[0] as number)).toBeGreaterThanOrEqual(SECOND);
				expectWithinRateLimits(at);
				await backlogReaches(0, "slow-start");
			} finally {
				await slowStart.close();
			}
		});

		it("一个机器人被限速时，别的机器人照常发送", async () => {
			await api.createFeishuBot("other", feishu.webhookUrl("other-token"));
			await run(messages(8));
			await run([notify("free", { bot: "other" })]);

			await eventually(() =>
				expect([...texts()].sort()).toEqual(["free", "m1", "m2", "m3", "m4", "m5"]),
			);
			await backlogReaches(3);
			await backlogReaches(0, "other");
		});
	});

	describe("积压超过 1000 条时丢弃最旧的", () => {
		/** 直接往发送队列里放大量排队的消息（走接口要触发上千次运行）。 */
		const withDb = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				return await fn(client);
			} finally {
				await client.end();
			}
		};

		it("超出的部分按入队顺序从最旧的丢起，记为「已丢弃：积压过多」，写进发起它的任务的日志", async () => {
			await api.createFeishuBot("slow", feishu.webhookUrl("slow-token"));
			feishu.replyAlways({ status: 503 });
			const runId = await run([notify("first", { bot: "slow" })]);
			await eventually(async () =>
				expect((await botView("slow")).last_delivery).toMatchObject({ ok: false }),
			);

			await withDb((c) =>
				c.query(
					`insert into feishu_messages (bot_name, source, body, enqueued_at)
					 select 'slow', 'notify',
					        jsonb_build_object('msg_type', 'text', 'content', jsonb_build_object('text', 'bulk-' || i)),
					        $1
					 from generate_series(0, 1099) i order by i`,
					[clock.now()],
				),
			);

			// 1101 条排队，丢掉最旧的 101 条：第一条（来自节点）和 bulk-0 到 bulk-99。
			await backlogReaches(1000, "slow");
			const line = await logLine(await api.node(runId, "first"), warnOf("已丢弃：积压过多"));
			expect(line.text).toContain("「slow」");
			expect(line.text).toContain("1000");
			const { discarded, oldestKept, newestKept } = await withDb(async (c) => {
				const discarded = await c.query(
					"select count(*)::int as n from feishu_messages where status = 'discarded' and last_error like '%积压过多%'",
				);
				const kept = await c.query(
					"select body->'content'->>'text' as text from feishu_messages where status = 'queued' order by seq",
				);
				return {
					discarded: discarded.rows[0].n as number,
					oldestKept: kept.rows[0].text as string,
					newestKept: kept.rows[kept.rows.length - 1].text as string,
				};
			});
			expect(discarded).toBe(101);
			expect([oldestKept, newestKept]).toEqual(["bulk-100", "bulk-1099"]);
		});
	});

	describe("文本超过 20 KB 时在入队时截断", () => {
		const overhead = Buffer.byteLength(JSON.stringify({ msg_type: "text", content: { text: "" } }));
		const params = [{ name: "big", type: "string" }];
		const sendBig = async (text: string, extra: Record<string, unknown> = {}) => {
			await run([notify("n", { text: "${{ params.big }}", ...extra })], params, { big: text });
			await eventually(() => expect(feishu.requests).toHaveLength(1));
			const request = feishu.requests[0] as { body: string; json: unknown };
			return {
				size: Buffer.byteLength(request.body),
				sent: (request.json as { content: { text: string } }).content.text,
			};
		};

		it.each([
			{ name: "ASCII", text: "a".repeat(30_000) },
			{ name: "中文（每个字 3 字节）", text: "测".repeat(10_000) },
			{ name: "emoji（代理对，每个 4 字节）", text: "😀".repeat(8_000) },
			{ name: "引号和换行（JSON 里要转义成两个字节）", text: '"\n'.repeat(15_000) },
		])("$name：请求体不超过 20 KB，正文尽量多地保留，末尾带「…（已截断）」，没有切坏字符", async ({
			text,
		}) => {
			const { size, sent } = await sendBig(text);

			expect(size).toBeLessThanOrEqual(BODY_LIMIT);
			expect(size).toBeGreaterThan(BODY_LIMIT - 16);
			expect(sent.endsWith(TRUNCATED)).toBe(true);
			expect(text.startsWith(sent.slice(0, -TRUNCATED.length))).toBe(true);
		});

		it("打开「@所有人」时，截断的是正文，「@所有人」仍然在最后", async () => {
			const { size, sent } = await sendBig("a".repeat(30_000), { at_all: true });

			expect(size).toBeLessThanOrEqual(BODY_LIMIT);
			expect(sent.endsWith(`${TRUNCATED}${AT_ALL}`)).toBe(true);
		});

		it("刚好 20 KB 的请求体原样发出，多一个字节就截断", async () => {
			const exact = await sendBig("a".repeat(BODY_LIMIT - overhead));
			expect(exact.size).toBe(BODY_LIMIT);
			expect(exact.sent).toBe("a".repeat(BODY_LIMIT - overhead));
		});

		it("多出一个字节：截断", async () => {
			const { size, sent } = await sendBig("a".repeat(BODY_LIMIT - overhead + 1));
			expect(size).toBeLessThanOrEqual(BODY_LIMIT);
			expect(sent.endsWith(TRUNCATED)).toBe(true);
		});
	});

	describe("控制面重启后接着投递", () => {
		it("排队的消息照常送达，已经送达的不会重发；重启之前排好的退避继续算", async () => {
			await run([notify("done")]);
			await eventually(() => expect(texts()).toEqual(["done"]));
			await backlogReaches(0);
			// 之后的请求在另一个控制面时间发出，「最近一次投递」的时间才能说明它已经记下了。
			clock.advance(10 * SECOND);

			feishu.reply({ status: 503 });
			const runId = await run(messages(3));
			const first = await recorded(2);
			await backlogReaches(3);

			await cp.restart();

			// 退避没有因为重启而清零：时间不动就不会重试，推进 1 秒才重试。
			clock.advance(SECOND);
			await eventually(() => expect(texts()).toEqual(["done", "m1", "m1", "m2", "m3"]));
			expect(arrivals().slice(1)).toEqual([first, first + SECOND, first + SECOND, first + SECOND]);
			const node = await api.node(runId, "m1");
			await logLine(node, (l) => l.level === "info" && l.text.includes("已送达"));
			expect((await logOf(node)).filter((l) => l.level === "warn")).toEqual([]);
			await backlogReaches(0);
		});

		it("停机期间已经过了退避时间的，重启后马上重试", async () => {
			feishu.reply({ status: 503 });
			await run([notify("m1")]);
			const first = await recorded(1);

			await cp.restart(() => clock.advance(5 * MINUTE));

			await eventually(() => expect(texts()).toEqual(["m1", "m1"]));
			expect(arrivals()).toEqual([first, first + 5 * MINUTE]);
		});
	});

	describe("删除机器人后丢弃它还没有投递的消息", () => {
		it("记为「已丢弃：机器人已删除」，写进各自任务的日志；不会再发出", async () => {
			feishu.reply({ status: 503 });
			const runId = await run(messages(3));
			await eventually(async () => {
				const bot = await botView();
				expect(bot.last_delivery).toMatchObject({ ok: false });
				expect(bot.backlog).toBe(3);
			});

			expect((await removeBot("ops")).status).toBe(204);

			for (const id of ["m1", "m2", "m3"]) {
				const line = await logLine(await api.node(runId, id), warnOf("已丢弃：机器人已删除"));
				expect(line.text).toContain("「ops」");
			}
			expect((await api.run(runId)).status).toBe("success");

			// 同名重新登记：队列里要是还有那几条，它们会先被送出去，所以 fresh 到了就说明它们已经没有了。
			await api.createFeishuBot("ops", feishu.webhookUrl(TOKEN));
			expect(await botView()).toMatchObject({ backlog: 0, last_delivery: null });
			await run([notify("fresh")]);
			await advancing(MINUTE, () => expect(texts()).toEqual(["m1", "fresh"]));
		});

		it("别的机器人的消息不受影响", async () => {
			await api.createFeishuBot("other", feishu.webhookUrl("other-token"));
			feishu.replyTo(TOKEN, { status: 503 });
			feishu.replyTo("other-token", { status: 503 });
			await run([notify("a1")]);
			await run([notify("b1", { bot: "other" })]);
			await eventually(async () => {
				for (const name of ["ops", "other"]) {
					const bot = await botView(name);
					expect(bot.last_delivery).toMatchObject({ ok: false });
					expect(bot.backlog).toBe(1);
				}
			});

			expect((await removeBot("ops")).status).toBe(204);

			clock.advance(SECOND);
			await eventually(() => expect(texts().sort()).toEqual(["a1", "b1", "b1"]));
			await backlogReaches(0, "other");
		});
	});

	describe("管理页上的最近一次投递和积压条数", () => {
		it("新登记的机器人：没有投递记录，积压为 0", async () => {
			expect(await botView()).toMatchObject({ last_delivery: null, backlog: 0 });
		});

		it("送达后：最近一次投递成功，时间是控制面时间", async () => {
			clock.advance(90 * SECOND);
			const delivered = clock.now().toISOString();
			await run([notify("n")]);

			await eventually(async () =>
				expect(await botView()).toMatchObject({
					last_delivery: { at: delivered, ok: true, message: null },
					backlog: 0,
				}),
			);
		});

		it("不可重试的失败：最近一次投递失败，写着中文原因和下一步", async () => {
			feishu.reply({ code: 19024 });
			await run([notify("n")]);

			await eventually(async () => {
				const bot = await botView();
				expect(bot.last_delivery).toMatchObject({ ok: false });
				expect(bot.last_delivery?.message).toContain("关键词");
				expect(bot.last_delivery?.message).toContain("下一步");
				expect(bot.backlog).toBe(0);
			});
		});

		it("可重试的失败：最近一次投递是失败，积压是还在排队的条数；送达之后恢复", async () => {
			feishu.reply({ status: 503 });
			await run(messages(2));

			await eventually(async () => {
				const bot = await botView();
				expect(bot.last_delivery).toMatchObject({ ok: false });
				expect(bot.last_delivery?.message).toContain("HTTP 503");
				expect(bot.backlog).toBe(2);
			});
			expect(JSON.stringify(await botView())).not.toContain(TOKEN);

			clock.advance(SECOND);
			await eventually(async () =>
				expect(await botView()).toMatchObject({ last_delivery: { ok: true }, backlog: 0 }),
			);
		});
	});
});
