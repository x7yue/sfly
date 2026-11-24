// 会话令牌的写（触发、保存、恢复、复制）和同一个会话的助手事件之间的锁（规格 #547，审查 #616）。
// 不变式：**任何代码都不在拿着数据库连接或开着事务的时候等进程里的锁**。会话令牌的写在事务里先做慢的（引擎的锁、场景那一行、
// 运行和版本的写入；带 `session_id` 的行插入时，外键检查给会话那一行加 `FOR KEY SHARE`），最后才给会话那一行加
// `FOR NO KEY UPDATE`、分配序号、写记录，然后提交；提交之后才把推送交给会话的链（不等它）。
// 下面的用例都是以前会卡死的情形，或者失败之后会留下卡住的状态的情形：真实控制面、真实 PostgreSQL（连接池 10 个）、假 Agent。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const JSON_HEADERS = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const document = () => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "host", type: "string", required: true }] },
		{
			id: "a",
			kind: "package",
			package: "stub",
			node: "echo",
			inputs: { v: "${{ params.host }}" },
		},
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});
const notice = (message: string) => ({
	type: "notice" as const,
	kind: "compaction" as const,
	message,
});

type Within<T> = { ok: true; value: T } | { ok: false };
/** 等一个 Promise 最多 `ms` 毫秒：卡住（比如死锁）时不挂住整个测试。 */
const within = <T>(promise: Promise<T>, ms: number): Promise<Within<T>> =>
	Promise.race([
		promise.then((value) => ({ ok: true as const, value })),
		sleep(ms).then(() => ({ ok: false as const })),
	]);

interface SessionStoreSeam {
	deps: {
		afterCommit?: (sessionId: string, event: { type: string; seq: number }) => Promise<void>;
	};
}

describe("会话令牌的写和助手事件：事务里不等进程里的锁", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let api: ApiClient;
	let agent: FakeAgent;
	let editor: string;
	let sessionId: string;
	let token: string;
	const extraClients: pg.Client[] = [];

	const start = async (options: { sessionWriteLockTimeoutMs?: number } = {}) => {
		cp = await startTestControlPlane(options);
		api = new ApiClient(cp);
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
		editor = await accounts.user("editor1", { displayName: "小编" });
		await accounts.member("default", editor, "editor");
		sessionId = await accounts.session(editor, "default", { title: "改巡检节点" });
		token = await accounts.sessionTokenIn(sessionId, editor, "default", {
			name: "会话：改巡检节点",
			scopes: ["read", "run", "edit", "session_build"],
		});
	};
	beforeEach(async () => {
		await start();
	});
	afterEach(async () => {
		for (const client of extraClients.splice(0)) await client.end().catch(() => undefined);
		await agent.disconnect();
		await db.end();
		await accounts.close();
		await cp.close();
	});

	/** 另开一个连接（测试里模拟「别的事务占着一把锁」）。 */
	const connect = async () => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		extraClients.push(client);
		return client;
	};
	const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
		cp.fetch(path, {
			method,
			headers: { ...(body === undefined ? {} : JSON_HEADERS), ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const status = (promise: Promise<Response>) =>
		promise.then(
			(res) => res.status,
			(error: Error) => `fetch-error ${error.name}`,
		);
	const scenario = (name = "接口巡检") => api.orchestrationWith(document(), name);
	const head = async (id: string) =>
		(
			await db.query<{ n: number }>("select head_version as n from orchestrations where id = $1", [
				id,
			])
		).rows[0]?.n ?? 0;
	const events = async (id = sessionId) =>
		(
			await db.query<{ seq: number; type: string }>(
				"select seq, type from session_events where session_id = $1 order by seq",
				[id],
			)
		).rows;
	const count = async (table: string): Promise<number> =>
		(await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n ?? 0;
	const sessions = () => cp.current.sessions;
	const seam = () => sessions() as unknown as SessionStoreSeam;

	const kinds = ["触发", "保存", "恢复", "复制"] as const;
	type Kind = (typeof kinds)[number];
	const writes: Record<Kind, (id: string) => Promise<Response>> = {
		触发: (id) =>
			send("POST", `/orchestrations/${id}/runs`, bearer(token), { params: { host: "h" } }),
		保存: async (id) =>
			send("POST", `/orchestrations/${id}/versions`, bearer(token), {
				base_version: await head(id),
				document: document(),
			}),
		恢复: (id) => send("POST", `/orchestrations/${id}/versions/1/restore`, bearer(token)),
		复制: (id) =>
			send("POST", `/orchestrations/${id}/copy`, bearer(token), { name: `副本${Math.random()}` }),
	};
	/** 这个会话的链有没有空出来：一条事件 1 秒内落库、推送完。 */
	const chainFree = async () =>
		(await within(sessions().append(sessionId, notice(`链空着吗 ${Math.random()}`)), 1000)).ok;
	/** 事件流里收到的持久事件的序号。 */
	const seqs = (sse: SseClient) =>
		sse.received.filter((e) => e.id !== undefined).map((e) => Number(e.id));

	describe("助手事件在链上、在会话那一行上的时候", () => {
		it.each(
			kinds,
		)("链被一条已经提交、停在推送之前的助手事件占着：会话令牌的%s照常完成（不等链），记录落库，订阅的一方看到的序号连续", async (kind) => {
			const id = await scenario();
			const sse = await SseClient.open(cp, `/sessions/${sessionId}/events`, bearer(token));
			try {
				await sse.next("turn_started");
				let release: () => void = () => {};
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				seam().deps.afterCommit = async (_id, event) => {
					if (event.type === "notice") await gate;
				};
				// 助手事件提交了，停在推送之前：链被它占着。
				const appended = sessions().append(sessionId, notice("占着链"));
				await eventually(async () =>
					expect((await events()).map((e) => e.type)).toContain("notice"),
				);
				const done = await within(status(writes[kind](id)), 3000);
				expect(done, `${kind}在链被占着时没有在 3 秒内完成`).toEqual({ ok: true, value: 201 });
				expect((await events()).filter((e) => e.type === "platform")).toHaveLength(1);
				release();
				await appended;
				seam().deps.afterCommit = undefined;
				await eventually(async () => expect(seqs(sse)).toEqual((await events()).map((e) => e.seq)));
			} finally {
				seam().deps.afterCommit = undefined;
				sse.close();
			}
		}, 30_000);

		it.each(
			kinds,
		)("链头的助手事件在等会话那一行的锁，会话令牌的%s同时进来：都完成，没有死锁，序号连续、推送一条不少（以前：外键检查的共享锁和助手事件的排他锁互相等）", async (kind) => {
			const id = await scenario();
			const sse = await SseClient.open(cp, `/sessions/${sessionId}/events`, bearer(token));
			const locker = await connect();
			try {
				await sse.next("turn_started");
				// 别的事务占着会话那一行：助手事件在事务里等它，同时占着链。
				await locker.query("begin");
				await locker.query("select id from sessions where id = $1 for no key update", [sessionId]);
				const appended = sessions().append(sessionId, notice("等行锁"));
				await sleep(150);
				const write = status(writes[kind](id));
				await sleep(300);
				await locker.query("commit");
				const results = await within(Promise.all([appended, write]), 5000);
				expect(results.ok, `${kind}和助手事件 5 秒内没有都完成（死锁）`).toBe(true);
				expect(results.ok && results.value[1]).toBe(201);
				const all = await events();
				expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
				await eventually(() => expect(seqs(sse)).toEqual(all.map((e) => e.seq)));
				expect(await chainFree()).toBe(true);
			} finally {
				sse.close();
			}
		}, 30_000);

		it.each([
			["恢复", "恢复"],
			["触发", "恢复"],
			["复制", "恢复"],
			["保存", "保存"],
		] as const)(
			"同一个会话两件写并发（%s 和 %s，两个场景），反复做：每次都完成，没有 5xx",
			async (first, second) => {
				const x = await scenario("X");
				const y = await scenario("Y");
				for (let round = 0; round < 8; round++) {
					const both = await within(
						Promise.all([status(writes[first](x)), status(writes[second](y))]),
						5000,
					);
					expect(both.ok, `第 ${round} 轮卡住`).toBe(true);
					expect(both.ok && both.value, `第 ${round} 轮`).toEqual([201, 201]);
				}
				expect(await chainFree()).toBe(true);
				const all = await events();
				expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
			},
			60_000,
		);

		it("两个会话令牌加一个人，在同一个场景上并发 60 个触发、恢复、复制、保存：都完成，没有 5xx（上一轮这一条每次都卡住）", async () => {
			const other = await accounts.session(editor, "default", { title: "二" });
			const otherToken = await accounts.sessionTokenIn(other, editor, "default", {
				scopes: ["read", "run", "edit"],
			});
			const id = await scenario("巡检");
			const credentials = [bearer(token), bearer(otherToken), { "x-sfly-nickname": "ren" }];
			const jobs: Promise<number | string>[] = [];
			for (let i = 0; i < 60; i++) {
				const credential = credentials[i % 3] ?? {};
				const pick = Math.floor(i / 3) % 4;
				const request =
					pick === 0
						? send("POST", `/orchestrations/${id}/runs`, credential, { params: { host: "h" } })
						: pick === 1
							? send("POST", `/orchestrations/${id}/versions/1/restore`, credential)
							: pick === 2
								? send("POST", `/orchestrations/${id}/copy`, credential, { name: `c${i}` })
								: send("POST", `/orchestrations/${id}/versions`, credential, {
										base_version: 1,
										document: document(),
									});
				jobs.push(status(request));
			}
			const done = await within(Promise.all(jobs), 20_000);
			expect(done.ok, "60 个并发写 20 秒内没有都完成").toBe(true);
			const codes = done.ok ? done.value : [];
			expect(codes.filter((code) => typeof code !== "number" || code >= 500)).toEqual([]);
			for (const sid of [sessionId, other]) {
				const all = await events(sid);
				expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
			}
		}, 60_000);

		it("连接池（10 个）：十几个会话令牌的写并发，同时这个会话有助手事件排着：都完成，别的读请求照常（以前：连接全在事务里空等，只能重启进程）", async () => {
			const id = await scenario();
			const locker = await connect();
			await locker.query("begin");
			await locker.query("select id from sessions where id = $1 for no key update", [sessionId]);
			const appended = sessions().append(sessionId, notice("排着"));
			const copies = Array.from({ length: 15 }, () => status(writes.复制(id)));
			await sleep(800);
			await locker.query("commit");
			const read = await within(status(send("GET", "/orchestrations", {})), 3000);
			expect(read, "池满时别的读请求拿不到连接").toEqual({ ok: true, value: 200 });
			const done = await within(Promise.all([appended, ...copies]), 15_000);
			expect(done.ok, "15 个复制和助手事件 15 秒内没有都完成").toBe(true);
			expect(done.ok && done.value.slice(1)).toEqual(Array.from({ length: 15 }, () => 201));
			expect(await chainFree()).toBe(true);
		}, 60_000);
	});

	describe("失败之后不留下卡住的状态", () => {
		/** 让指定表上的每次插入在提交时失败（延迟的约束触发器）。 */
		const failAtCommit = async (table: string) => {
			await db.query(`create or replace function t_fail_commit() returns trigger language plpgsql as $$
				begin raise exception 'forced commit failure'; end $$`);
			await db.query(`create constraint trigger t_fail_${table} after insert on ${table}
				deferrable initially deferred for each row execute function t_fail_commit()`);
		};
		/** session_events 上只拦平台记录的插入（写记录本身失败）。 */
		const failPlatformInsert = async () => {
			await db.query(`create or replace function t_fail_platform() returns trigger language plpgsql as $$
				begin if new.type = 'platform' then raise exception 'platform insert failed'; end if; return new; end $$`);
			await db.query(
				"create trigger t_fail_platform before insert on session_events for each row execute function t_fail_platform()",
			);
		};

		it.each(
			kinds,
		)("提交失败（%s）：500，运行和版本都没有，没有记录；同一个会话紧接着再写一条事件，马上落库、推送", async (kind) => {
			const id = await scenario();
			await failAtCommit(kind === "触发" ? "runs" : "orchestration_versions");
			const runsBefore = await count("runs");
			const versionsBefore = await count("orchestration_versions");
			const sse = await SseClient.open(cp, `/sessions/${sessionId}/events`, bearer(token));
			try {
				await sse.next("turn_started");
				expect(await status(writes[kind](id))).toBe(500);
				expect(await count("runs")).toBe(runsBefore);
				expect(await count("orchestration_versions")).toBe(versionsBefore);
				expect((await events()).filter((e) => e.type === "platform")).toEqual([]);
				expect(await chainFree()).toBe(true);
				await sse.next("notice");
			} finally {
				sse.close();
			}
		});

		it.each(
			kinds,
		)("写记录本身失败（%s）：500，运行和版本也没有（记录和它们在同一个事务里，不是提交之后另写的）；再写一条事件马上落库", async (kind) => {
			const id = await scenario();
			await failPlatformInsert();
			const runsBefore = await count("runs");
			const versionsBefore = await count("orchestration_versions");
			const scenariosBefore = await count("orchestrations");
			const headBefore = await head(id);
			expect(await status(writes[kind](id))).toBe(500);
			expect(await count("runs")).toBe(runsBefore);
			expect(await count("orchestration_versions")).toBe(versionsBefore);
			expect(await count("orchestrations")).toBe(scenariosBefore);
			expect(await head(id)).toBe(headBefore);
			expect((await events()).filter((e) => e.type === "platform")).toEqual([]);
			expect(await chainFree()).toBe(true);
			// 记录写得进去之后，同样的写成功，序号接着往下（失败的那次没有占掉序号）。
			await db.query("drop trigger t_fail_platform on session_events");
			expect(await status(writes[kind](id))).toBe(201);
			const all = await events();
			expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
		});

		it("推送抛异常（测试缝）：201，已提交的运行照样派发；没推出去的那一条，下一条事件推送时从库里补上，订阅的一方看到的序号仍然连续", async () => {
			const id = await scenario();
			const sse = await SseClient.open(cp, `/sessions/${sessionId}/events`, bearer(token));
			try {
				await sse.next("turn_started");
				seam().deps.afterCommit = async (_id, event) => {
					if (event.type === "platform") throw new Error("推送坏了");
				};
				expect(await status(writes.触发(id))).toBe(201);
				expect(await status(writes.保存(id))).toBe(201);
				await sleep(200);
				// 平台记录都没有推出去；这时来一条别的事件，它的推送把前面漏的从库里补上、按序号推。
				seam().deps.afterCommit = undefined;
				await sessions().append(sessionId, notice("后来的"));
				await eventually(async () => expect(seqs(sse)).toEqual((await events()).map((e) => e.seq)));
				// 漏的两条平台记录补上之后，按序号排在「后来的」前面。
				expect((await events()).map((e) => e.type).slice(-3)).toEqual([
					"platform",
					"platform",
					"notice",
				]);
			} finally {
				seam().deps.afterCommit = undefined;
				sse.close();
			}
		});

		it.each(
			kinds.slice(0, 2),
		)("请求中途断开（%s，等场景那一行的锁时客户端断开）：处理照常做完，链空着", async (kind) => {
			const id = await scenario();
			const locker = await connect();
			await locker.query("begin");
			await locker.query("select id from orchestrations where id = $1 for update", [id]);
			const abort = new AbortController();
			const runsBefore = await count("runs");
			const request =
				kind === "触发"
					? cp.fetch(`/orchestrations/${id}/runs`, {
							method: "POST",
							headers: { ...JSON_HEADERS, ...bearer(token) },
							body: JSON.stringify({ params: { host: "h" } }),
							signal: abort.signal,
						})
					: cp.fetch(`/orchestrations/${id}/versions`, {
							method: "POST",
							headers: { ...JSON_HEADERS, ...bearer(token) },
							body: JSON.stringify({ base_version: await head(id), document: document() }),
							signal: abort.signal,
						});
			const outcome = status(request);
			await sleep(300);
			abort.abort();
			await outcome;
			await locker.query("commit");
			await eventually(async () =>
				expect((await events()).filter((e) => e.type === "platform")).toHaveLength(1),
			);
			if (kind === "触发") expect(await count("runs")).toBe(runsBefore + 1);
			expect(await chainFree()).toBe(true);
		}, 30_000);
	});

	describe("兜底：等锁有上限", () => {
		it.each(
			kinds,
		)("会话那一行被别的事务占着不放（%s）：等锁超时之后这一次请求 503、事务回滚（运行、版本、记录都没有）；放掉之后同样的写成功", async (kind) => {
			await afterEachCleanup();
			await start({ sessionWriteLockTimeoutMs: 400 });
			const id = await scenario();
			const locker = await connect();
			await locker.query("begin");
			await locker.query("select id from sessions where id = $1 for no key update", [sessionId]);
			const runsBefore = await count("runs");
			const versionsBefore = await count("orchestration_versions");
			const started = Date.now();
			const res = await within(writes[kind](id), 5000);
			expect(res.ok, "等锁超时之后请求没有返回").toBe(true);
			if (res.ok) {
				expect(res.value.status).toBe(503);
				expect(await res.value.json()).toMatchObject({ error: { code: "server_busy" } });
			}
			expect(Date.now() - started).toBeLessThan(3000);
			expect(await count("runs")).toBe(runsBefore);
			expect(await count("orchestration_versions")).toBe(versionsBefore);
			await locker.query("commit");
			expect(await status(writes[kind](id))).toBe(201);
			expect(await chainFree()).toBe(true);
		}, 30_000);

		it("场景那一行被别的事务占着不放：会话令牌的写同样在上限之后 503（不只是会话那一行）", async () => {
			await afterEachCleanup();
			await start({ sessionWriteLockTimeoutMs: 400 });
			const id = await scenario();
			const locker = await connect();
			await locker.query("begin");
			await locker.query("select id from orchestrations where id = $1 for update", [id]);
			const res = await within(writes.保存(id), 5000);
			expect(res).toMatchObject({ ok: true });
			expect(res.ok && res.value.status).toBe(503);
			await locker.query("commit");
			expect(await status(writes.保存(id))).toBe(201);
		}, 30_000);
	});

	/** 用例里换一个调了锁等待上限的控制面：先把 beforeEach 起的收掉。 */
	const afterEachCleanup = async () => {
		await agent.disconnect();
		await db.end();
		await accounts.close();
		await cp.close();
	};
});
