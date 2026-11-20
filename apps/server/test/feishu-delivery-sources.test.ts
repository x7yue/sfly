// 切入点 A：和消息来源无关的投递行为（#229，ADR 0020、docs/SEMANTICS.md §4.2）：投递结果写进任务日志、
// 投递记录跟随所属运行的保留期、同一个机器人的消息串行到达、控制面重启时没有结果的消息、一个机器人不响应时不挡别的机器人、
// 原始消息的请求体经发送队列原样发出。
// 这些行为原来借「飞书通知节点」这个来源验证；现在消息由 support/feishu-source.ts 直接放进真实的发送队列
// （和 ctx.notify 同一条入队路径），不需要 Agent。
// HTTP API + 真实 PostgreSQL + 手动时钟 + 假飞书 Webhook 服务（support/fake-feishu.ts）。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { type FeishuSource, startFeishuSource } from "./support/feishu-source.js";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "tok-4f9a8c71-e2b0-43d6-9a55-0a1b2c3d4e5f";

interface LogLine {
	level: string;
	source: string;
	text: string;
}

describe("不同来源的消息共用的投递行为", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let api: ApiClient;
	let feishu: FakeFeishu;
	let source: FeishuSource;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		clock = cp.clock as ManualClock;
		api = new ApiClient(cp);
		source = await startFeishuSource(cp, api);
		feishu = await startFakeFeishu();
		await api.createFeishuBot("ops", feishu.webhookUrl(TOKEN));
	});
	afterEach(async () => {
		await feishu.close();
		await source.close();
		await cp.close();
	});

	const texts = () =>
		feishu.requests.map((r) => (r.json as { content: { text: string } }).content.text);
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
	const delivered = (l: LogLine) => l.level === "info" && l.text.includes("已送达");

	it("投递结果写进任务日志：送达是 info、来源是系统；日志里没有 Webhook 地址", async () => {
		const run = await source.run();
		await run.text("完成");

		const line = await logLine(run.taskId, delivered);
		expect(line).toMatchObject({ source: "system" });
		expect(line.text).toContain("「ops」");
		expect(JSON.stringify(await logOf(run.taskId))).not.toContain(TOKEN);
	});

	it("原始消息：完整的请求体经发送队列原样到达飞书，字符串里有引号、换行、反斜杠和 emoji 时请求体仍是有效 JSON", async () => {
		const awkward = 'He said "hi"\n第二行 \\ 反斜杠\t制表 😀';
		const message = {
			msg_type: "interactive",
			card: {
				schema: "2.0",
				header: { title: { tag: "plain_text", content: `来自 ${awkward}` }, template: "red" },
				body: {
					elements: [{ tag: "markdown", content: `**${awkward}**\n没有引用的行` }, { tag: "hr" }],
				},
			},
			extra: { n: 5, ok: true, nothing: null, list: [awkward, 1] },
		};
		const run = await source.run();
		await run.raw(message);

		await eventually(() => expect(feishu.requests).toHaveLength(1));
		const request = feishu.requests[0];
		expect(request?.json).toEqual(message);
		expect(() => JSON.parse(request?.body ?? "")).not.toThrow();
		await logLine(run.taskId, delivered);
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
			const run = await source.run();
			await run.text("n");
			await eventually(() => expect(feishu.requests).toHaveLength(1));
			await eventually(async () => expect(await recorded(run.runId)).toBe(1));

			clock.advance(29 * 24 * 60 * 60_000);
			expect(await recorded(run.runId)).toBe(1);
			clock.advance(2 * 24 * 60 * 60_000);
			await eventually(async () => expect(await recorded(run.runId)).toBe(0));
		});
	});

	describe("投递", () => {
		it("同一个机器人的多条消息按入队顺序串行到达：同一时刻只有一个请求在途", async () => {
			feishu.replyAlways({ delayMs: 60 });
			// 一共 4 条，在每秒 5 条的限速之内（限速见 feishu-delivery.test.ts）。
			const first = await source.run();
			await first.texts(["m1", "m2"]);
			const second = await source.run();
			await second.texts(["m1", "m2"]);

			await eventually(() => expect(feishu.requests).toHaveLength(4), 10_000);
			expect(texts()).toEqual(["m1", "m2", "m1", "m2"]);
			expect(feishu.maxInFlight).toBe(1);
		});

		it("控制面重启时还没有结果的消息不记为失败，重启后接着投递", async () => {
			feishu.reply({ hang: true });
			const run = await source.run();
			await run.text("n");
			await eventually(() => expect(feishu.requests).toHaveLength(1));

			await cp.restart();

			await eventually(() => expect(feishu.requests).toHaveLength(2));
			await logLine(run.taskId, delivered);
			expect((await logOf(run.taskId)).filter((l) => l.level === "warn")).toEqual([]);
		});

		it("一个机器人不响应时，不挡住别的机器人", async () => {
			await api.createFeishuBot("other", feishu.webhookUrl("other-token"));
			feishu.replyTo(TOKEN, { hang: true });
			const stuck = await source.run();
			await stuck.text("stuck", { bot: "ops" });
			const free = await source.run();
			await free.text("free", { bot: "other" });

			// 两个机器人同时投递：到达的先后不确定。ops 不响应，other 的消息照常送达。
			await eventually(() => expect([...texts()].sort()).toEqual(["free", "stuck"]));
			await logLine(free.taskId, delivered);
			expect((await api.run(free.runId)).status).toBe("success");
			expect(await logOf(stuck.taskId)).toEqual([]);
		});
	});
});
