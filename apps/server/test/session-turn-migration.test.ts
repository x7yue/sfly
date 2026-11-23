// 迁移 0036_session_current_turn：会话表加 `current_turn`，用 `turn_started` 的条数回填；之后控制面按它认「此刻在做的那一轮」。
// 模拟旧库：只含这条迁移之前的迁移，往里插各种历史形状的会话（和 `run-notification-migration.test.ts` 同一个做法），
// 再用全部迁移重新启动：看回填的数，以及回填之后停止、助手事件、下一轮的轮次对不对。
import { randomUUID } from "node:crypto";
import { cp as copy, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEventBody } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsDir } from "../src/db/database.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MIGRATION = "0036_session_current_turn";
const AT = "2026-01-01T00:00:00Z";
const USAGE = { input: 1, output: 1, cache_read: 0, cache_write: 0 };

const user = (n: number): SessionEventBody => ({
	type: "user_message",
	message_id: randomUUID(),
	text: `第 ${n} 句`,
	steer: false,
	author: "alice",
	author_user_id: null,
});
const started = (turn: number): SessionEventBody => ({ type: "turn_started", turn });
const ended = (turn: number): SessionEventBody => ({
	type: "turn_end",
	turn,
	outcome: "completed",
	reason: "完成",
	steps: 1,
	model_calls: 1,
	duration_ms: 1,
	usage: USAGE,
});

/** 各种历史形状的会话：名字、项目、状态、持久事件。同一个项目至多一个在做的，所以在做的各占一个项目。 */
const SEEDS: Record<string, { project: string; status: string; events: SessionEventBody[] }> = {
	idle_3_turns: {
		project: "default",
		status: "idle",
		events: [
			user(1),
			started(1),
			ended(1),
			user(2),
			started(2),
			ended(2),
			user(3),
			started(3),
			ended(3),
		],
	},
	running_turn_2: {
		project: "p-running",
		status: "running",
		events: [user(1), started(1), ended(1), user(2), started(2)],
	},
	idle_no_events: { project: "default", status: "idle", events: [] },
	stuck_mid_turn_2: {
		project: "p-stuck",
		status: "running",
		// 旧版本留下的：第 2 轮的 user_message 写了、turn_started 没写。
		events: [user(1), started(1), ended(1), user(2)],
	},
	ended_1_turn: {
		project: "default",
		status: "ended",
		events: [user(1), started(1), ended(1), { type: "session_ended", by: "alice" }],
	},
	running_no_events: { project: "p-legacy", status: "running", events: [] },
};

describe("升级：会话表加 current_turn，按 turn_started 的条数回填", () => {
	let cp: TestControlPlane;
	let oldMigrations: string;
	const ids: Record<string, string> = {};

	const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (await client.query(sql, params)).rows as T[];
		} finally {
			await client.end();
		}
	};
	const turnOf = async (name: string) =>
		(
			await query<{ current_turn: number; status: string }>(
				"select current_turn, status from sessions where id = $1",
				[ids[name]],
			)
		)[0];

	/** 只含这条迁移之前的迁移的目录，模拟旧版控制面的数据库。 */
	const migrationsBeforeThis = async () => {
		const dir = await mkdtemp(join(tmpdir(), "sfly-migrations-"));
		await copy(defaultMigrationsDir, dir, { recursive: true });
		const journalPath = join(dir, "meta", "_journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			entries: { idx: number; tag: string }[];
		};
		const at = journal.entries.findIndex((e) => e.tag === MIGRATION);
		expect(at, `迁移日志里没有 ${MIGRATION}`).toBeGreaterThan(0);
		journal.entries = journal.entries.slice(0, at);
		await writeFile(journalPath, JSON.stringify(journal));
		return dir;
	};

	beforeAll(async () => {
		oldMigrations = await migrationsBeforeThis();
		cp = await startTestControlPlane({ migrationsDir: oldMigrations });
		// 旧库里没有这一列：这条测试没有在空转。
		const columns = await query<{ column_name: string }>(
			"select column_name from information_schema.columns where table_name = 'sessions'",
		);
		expect(columns.map((c) => c.column_name)).not.toContain("current_turn");
		for (const project of new Set(Object.values(SEEDS).map((seed) => seed.project))) {
			await query(
				"insert into projects (id, display_name, created_at) values ($1, $1, $2) on conflict do nothing",
				[project, AT],
			);
		}
		for (const [name, seed] of Object.entries(SEEDS)) {
			const id = randomUUID();
			ids[name] = id;
			await query(
				`insert into sessions (id, project_id, title, status, created_by, created_at, last_activity_at)
				values ($1, $2, $3, $4, 'alice', $5, $5)`,
				[id, seed.project, name, seed.status, AT],
			);
			for (const [index, body] of seed.events.entries()) {
				const { type, ...payload } = body;
				await query(
					"insert into session_events (session_id, seq, type, payload, created_at) values ($1, $2, $3, $4, $5)",
					[id, index + 1, type, JSON.stringify(payload), AT],
				);
			}
		}
		await cp.restart(undefined, { migrationsDir: defaultMigrationsDir });
	}, 60_000);
	afterAll(async () => {
		await cp?.close();
		await rm(oldMigrations, { recursive: true, force: true });
	});

	it("回填的轮次是 turn_started 的条数：空闲做过 3 轮是 3、在做第 2 轮是 2、没有事件是 0、已结束做过 1 轮是 1", async () => {
		expect((await turnOf("idle_3_turns"))?.current_turn).toBe(3);
		expect((await turnOf("running_turn_2"))?.current_turn).toBe(2);
		expect((await turnOf("idle_no_events"))?.current_turn).toBe(0);
		expect((await turnOf("ended_1_turn"))?.current_turn).toBe(1);
		// 状态原样。
		expect((await turnOf("running_turn_2"))?.status).toBe("running");
	});

	it("旧版本卡在第 2 轮（有 user_message、没有 turn_started）回填成 1：停止之后回到空闲，下一轮是第 2 轮", async () => {
		expect((await turnOf("stuck_mid_turn_2"))?.current_turn).toBe(1);
		const store = cp.current.sessions;
		// 它在做、current_turn 是 1，第 1 轮早就有结局：控制面结束的是「此刻在做的这一轮」，这一轮已有结局时也只改回空闲。
		await store.append(ids.stuck_mid_turn_2 as string, {
			type: "turn_end",
			turn: 1,
			outcome: "stopped",
			reason: "停止",
			duration_ms: 1,
		});
		expect(await turnOf("stuck_mid_turn_2")).toMatchObject({ status: "idle", current_turn: 1 });
		expect(
			(
				await query("select 1 from session_events where session_id = $1 and type = 'turn_end'", [
					ids.stuck_mid_turn_2,
				])
			).length,
		).toBe(1);
	});

	it("在做、没有任何事件的旧数据回填成 0：控制面结束它之后 current_turn 抬到 1，下一轮是第 2 轮，那一轮真正的 turn_end 不被当成重复吞掉", async () => {
		expect((await turnOf("running_no_events"))?.current_turn).toBe(0);
		const store = cp.current.sessions;
		const id = ids.running_no_events as string;
		await store.append(id, {
			type: "turn_end",
			turn: 1,
			outcome: "stopped",
			reason: "停止",
			duration_ms: 1,
		});
		expect(await turnOf("running_no_events")).toMatchObject({ status: "idle", current_turn: 1 });
		const begun = await store.beginTurn(id, "p-legacy" as never, (turn) => [
			user(9),
			started(turn),
		]);
		expect(begun).toMatchObject({ started: true, turn: 2 });
		const stored = await store.appendFromAssistant(
			id,
			2,
			{
				type: "turn_end",
				turn: 2,
				outcome: "completed",
				reason: "完成",
				steps: 1,
				model_calls: 1,
				duration_ms: 1,
				usage: USAGE,
			},
			new Date(AT),
		);
		expect(stored).toMatchObject({ stored: { type: "turn_end", turn: 2 } });
		expect(await turnOf("running_no_events")).toMatchObject({ status: "idle", current_turn: 2 });
	});

	it("在做第 2 轮的会话升级之后照收第 2 轮的事件，第 1 轮迟到的事件丢掉", async () => {
		const store = cp.current.sessions;
		const id = ids.running_turn_2 as string;
		const message = { type: "assistant_message" as const, text: "好", usage: USAGE };
		const at = new Date(AT);
		expect(await store.appendFromAssistant(id, 1, message, at)).toEqual({ dropped: "other_turn" });
		expect(await store.appendFromAssistant(id, 2, message, at)).toMatchObject({
			stored: { type: "assistant_message" },
		});
	});
});
