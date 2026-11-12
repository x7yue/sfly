// 每个飞书机器人的消息严格按提交的先后投递（ADR 0020、docs/SEMANTICS.md §4.2）。
// 入队的 seq 在 INSERT 时分配，而事务提交的先后可以不同：引擎在 step 的事务里入队（持有引擎的互斥锁），
// ctx.notify 在自己的事务里入队（不经过引擎）。后分配 seq 的消息先提交时，投递按「最小的可见 seq」取队首，
// 会把它投在先分配 seq、后提交的消息前面。这里直接开两个事务，把「谁先提交」固定下来：
// 第一个事务入队后一直不提交，第二个事务入队；假飞书那一端收到的顺序必须是第一条在前。
// 这是并发的缺陷，用 pg_locks 判断第二个事务「已经提交，或者在等第一个事务」，不靠睡眠。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/database.js";
import { enqueueFeishuMessage } from "../src/feishu/feishu-queue.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("同一个机器人的消息按提交的先后投递", () => {
	let cp: TestControlPlane;
	let feishu: FakeFeishu;
	let database: Database;
	let admin: pg.Client;
	/** 还没提交的入队事务：测试失败时也要放开，否则关闭连接池会一直等。 */
	let holds: Array<{ commit(): void; done: Promise<void> }>;

	beforeEach(async () => {
		holds = [];
		cp = await startTestControlPlane();
		feishu = await startFakeFeishu();
		const api = new ApiClient(cp);
		await api.createFeishuBot("ops", feishu.webhookUrl("ops-token"));
		await api.createFeishuBot("dev", feishu.webhookUrl("dev-token"));
		database = openDatabase(cp.database.url, () => {});
		admin = new pg.Client({ connectionString: cp.database.url });
		await admin.connect();
	});
	afterEach(async () => {
		for (const hold of holds) hold.commit();
		await Promise.allSettled(holds.map((hold) => hold.done));
		await admin.end();
		await database.close();
		await feishu.close();
		await cp.close();
	});

	const texts = () =>
		feishu.requests.map((r) => (r.json as { content: { text: string } }).content.text);
	/** 已提交的消息（别的连接只看得到已提交的）。 */
	const committed = async () =>
		(
			await admin.query<{ text: string }>(
				"select body->'content'->>'text' as text from feishu_messages order by seq",
			)
		).rows.map((r) => r.text);
	/** 有没有事务在等咨询锁（入队在等同一个机器人上一条还没提交的消息）。 */
	const waitingForLock = async () =>
		Number(
			(
				await admin.query<{ n: string }>(
					`select count(*) as n from pg_locks
					 where locktype = 'advisory' and not granted
					   and database = (select oid from pg_database where datname = current_database())`,
				)
			).rows[0]?.n,
		) > 0;
	const message = (bot: string, text: string) => ({
		botName: bot,
		source: "notify" as const,
		body: { msg_type: "text", content: { text } },
		now: cp.clock.now(),
	});

	/** 开一个入队后一直不提交的事务，返回「提交它」的开关。 */
	async function openEnqueue(bot: string, text: string) {
		const inserted = deferred();
		const release = deferred();
		const done = database.db.transaction(async (tx) => {
			await enqueueFeishuMessage(tx, message(bot, text));
			inserted.resolve();
			await release.promise;
		});
		await inserted.promise;
		const hold = { commit: () => release.resolve(), done };
		holds.push(hold);
		return hold;
	}

	it("先入队、后提交的消息，不会被后入队、先提交的消息抢在前面", async () => {
		const first = await openEnqueue("ops", "first");

		let secondCommitted = false;
		const second = database.db
			.transaction((tx) => enqueueFeishuMessage(tx, message("ops", "second")))
			.then(() => {
				secondCommitted = true;
			});
		// 第二个事务要么已经提交（没有保证顺序），要么在等第一个事务（保证了顺序）。
		await eventually(async () => expect(secondCommitted || (await waitingForLock())).toBe(true));

		// 第一条还没有提交：别的连接看不到任何消息，投递也就没有东西可发。
		expect(await committed()).toEqual([]);

		first.commit();
		await Promise.all([first.done, second]);
		await eventually(() => expect(texts()).toEqual(["first", "second"]));
	});

	it("不同机器人互不影响：一个机器人的消息还没提交，另一个机器人的消息照常投递", async () => {
		const held = await openEnqueue("ops", "held");

		await database.db.transaction((tx) => enqueueFeishuMessage(tx, message("dev", "other")));
		await eventually(() => expect(texts()).toEqual(["other"]));

		held.commit();
		await held.done;
		await eventually(() => expect(texts()).toEqual(["other", "held"]));
	});
});
