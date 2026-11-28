// 运行通知的触发条件去掉了「总是」（always，#446）：升级时一次性的数据迁移把存量的「总是」改成「失败和取消」，
// 读取时没有兼容分支。触发条件只存在场景表的 `run_notify_trigger` 列里（不属于场景版本），所以历史版本和运行不受影响。
// 模拟旧库：只含这条迁移之前的迁移，往里插「总是」的场景，再用全部迁移重新启动。
import { cp as copy, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir } from "../src/db/database.js";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { ApiClient } from "./support/api-client.js";
import { makeTempDir } from "./support/temp-dir.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MIGRATION = "0034_run_notify_always_to_failed_or_cancelled";
const AT = "2026-01-01T00:00:00Z";

const ids = (n: number) => ({
	scenario: `00000000-0000-4000-8000-0000000001${n}1`,
	version: `00000000-0000-4000-8000-0000000001${n}2`,
	run: `00000000-0000-4000-8000-0000000001${n}3`,
});

describe("升级：运行通知的触发条件「总是」改成「失败和取消」", () => {
	let cp: TestControlPlane;
	let oldMigrations: string;

	/** 只含这条迁移之前的迁移的目录，模拟旧版控制面的数据库。 */
	const migrationsBeforeThis = async () => {
		const dir = await makeTempDir("sfly-migrations-");
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

	beforeEach(async () => {
		oldMigrations = await migrationsBeforeThis();
		cp = await startTestControlPlane({ migrationsDir: oldMigrations });
	});
	afterEach(async () => {
		await cp.close();
		await rm(oldMigrations, { recursive: true, force: true });
	});

	const seed = async (
		client: pg.Client,
		n: number,
		name: string,
		trigger: string,
		bot: string | null,
	) => {
		const id = ids(n);
		await client.query(
			`insert into orchestrations (id, name, description, head_version, created_at, project_id,
				run_notify_bot, run_notify_trigger, run_notify_title, run_notify_note)
			values ($1, $2, '', 1, $3, $6, $4, $5, '旧标题', '旧说明')`,
			[id.scenario, name, AT, bot, trigger, DEFAULT_PROJECT],
		);
		await client.query(
			`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
			values ($1, $2, 1, $3, '旧人', $4)`,
			[
				id.version,
				id.scenario,
				JSON.stringify({
					default_agent: "agent-a",
					nodes: [{ id: "entry", kind: "entry", params: [] }],
					edges: [],
					packages: {},
				}),
				AT,
			],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, triggered_by, params, status, started_at, ended_at, project_id)
			values ($1, $2, $3, '旧人', '{}', 'success', $4, $4, $5)`,
			[id.run, id.scenario, id.version, AT, DEFAULT_PROJECT],
		);
	};

	it("存量的「总是」变成「失败和取消」，其余的触发条件和别的设置原样，历史版本和运行不动", async () => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await seed(client, 1, "总是", "always", "运维群");
			await seed(client, 2, "总是但没选机器人", "always", null);
			await seed(client, 3, "仅失败", "failed", "运维群");
			await seed(client, 4, "失败和取消", "failed_or_cancelled", "运维群");
			const before = await client.query(
				"select id, document from orchestration_versions order by id",
			);
			// 旧库里确实有「总是」：这条测试没有在空转。
			const old = await client.query(
				"select count(*)::int as n from orchestrations where run_notify_trigger = 'always'",
			);
			expect(old.rows[0]?.n).toBe(2);

			await cp.restart(undefined, { migrationsDir: defaultMigrationsDir });

			const api = new ApiClient(cp);
			const setting = async (n: number) =>
				(
					await api.getJson<{
						run_notification: { bot: string | null; trigger: string; title: string; note: string };
					}>(`/orchestrations/${ids(n).scenario}`)
				).run_notification;
			expect(await setting(1)).toEqual({
				bot: "运维群",
				trigger: "failed_or_cancelled",
				title: "旧标题",
				note: "旧说明",
			});
			expect(await setting(2)).toMatchObject({ bot: null, trigger: "failed_or_cancelled" });
			expect(await setting(3)).toMatchObject({ bot: "运维群", trigger: "failed" });
			expect(await setting(4)).toMatchObject({ bot: "运维群", trigger: "failed_or_cancelled" });

			const left = await client.query(
				"select count(*)::int as n from orchestrations where run_notify_trigger = 'always'",
			);
			expect(left.rows[0]?.n).toBe(0);
			// 场景版本是不可变的记录：迁移一个字节都没有碰。
			const after = await client.query(
				"select id, document from orchestration_versions order by id",
			);
			expect(after.rows).toEqual(before.rows);
			expect((await api.run(ids(1).run)).status).toBe("success");
		} finally {
			await client.end();
		}
	});

	it("场景列表里也读得出来（列表和详情是同一份设置），复制场景带着改好的触发条件", async () => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await seed(client, 1, "总是", "always", "运维群");
		} finally {
			await client.end();
		}
		await cp.restart(undefined, { migrationsDir: defaultMigrationsDir });

		const api = new ApiClient(cp);
		const list = await api.getJson<{
			orchestrations: Array<{ id: string; run_notification: { trigger: string } }>;
		}>("/projects/default/orchestrations");
		expect(
			list.orchestrations.find((o) => o.id === ids(1).scenario)?.run_notification.trigger,
		).toBe("failed_or_cancelled");
		const copied = await api.post(`/orchestrations/${ids(1).scenario}/copy`, { name: "副本" });
		expect(copied.status).toBe(201);
		const { id } = (await copied.json()) as { id: string };
		const copy = await api.getJson<{ run_notification: { trigger: string; bot: string | null } }>(
			`/orchestrations/${id}`,
		);
		expect(copy.run_notification).toMatchObject({ trigger: "failed_or_cancelled", bot: "运维群" });
	});

	it("升级之后库里不能再写「总是」或别的不认识的触发条件：数据库的约束拒绝（运行结束时不会遇到不认识的值）", async () => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await seed(client, 1, "仅失败", "failed", "运维群");
			await cp.restart(undefined, { migrationsDir: defaultMigrationsDir });

			for (const trigger of ["always", "", "Failed", "success"]) {
				await expect(
					client.query("update orchestrations set run_notify_trigger = $1", [trigger]),
					JSON.stringify(trigger),
				).rejects.toThrow(/orchestrations_run_notify_trigger/);
				await expect(
					seed(client, 2, "新场景", trigger, null),
					`insert ${JSON.stringify(trigger)}`,
				).rejects.toThrow(/orchestrations_run_notify_trigger/);
			}
			// 认识的两个值照常能写。
			for (const trigger of ["failed", "failed_or_cancelled"]) {
				await client.query("update orchestrations set run_notify_trigger = $1", [trigger]);
			}
		} finally {
			await client.end();
		}
	});
});
