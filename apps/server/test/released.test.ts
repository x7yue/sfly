// 运行的加密副本什么时候删（#505）：运行结束、每次尝试都已离开 Agent 之手之后；删除之后到达的上报丢弃并计数。
// 一次尝试离手：结果已被 Ack；重连时 Hello 里没有列出；或者在 Welcome 里被放弃、之后的心跳不再列出。租约过期不算。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_MASK as MASK } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attemptReleased } from "../src/engine/released.js";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, param } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "fake-token-2b8e0c51";
const LEASE_MS = 30_000;

const SCENARIO = orchestration(
	[
		[
			{ id: "entry", kind: "entry", params: [param("token", { secret: true })] },
			{ ...echo("a", { text: "${{ params.token }}" }), retries: 1 },
		],
	],
	[],
);

describe("attemptReleased", () => {
	it("从没派发出去的（没有租约）、记下了离手时刻的是离手了；派发过、没记的不是", () => {
		const at = new Date(0);
		expect(attemptReleased({ leaseExpiresAt: null, releasedAt: null })).toBe(true);
		expect(attemptReleased({ leaseExpiresAt: at, releasedAt: at })).toBe(true);
		expect(attemptReleased({ leaseExpiresAt: at, releasedAt: null })).toBe(false);
	});
});

describe("删除副本和迟到的上报", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	const agents: FakeAgent[] = [];

	const query = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (await client.query(sql, args)).rows as T[];
		} finally {
			await client.end();
		}
	};
	const runRow = async (runId: string) => {
		const [row] = await query<{
			status: string;
			vault_deleted_at: Date | null;
			late_reports_dropped: number;
			vaults: number;
		}>(
			`select status, vault_deleted_at, late_reports_dropped,
				(select count(*)::int from run_vaults where run_id = runs.id) as vaults
			from runs where id = $1`,
			[runId],
		);
		if (!row) throw new Error(`no run ${runId}`);
		return row;
	};
	const connect = async (init: Pick<HelloInit, "runningTasks"> = {}, preparing = false) => {
		const agent = await FakeAgent.connect(
			cp.grpcUrl,
			{ slots: 2, ...init, name: "agent-a" },
			{ clock, preparing },
		);
		agents.push(agent);
		return agent;
	};
	const logFiles = async (runId: string) =>
		readdir(join(cp.dataDir, "logs", runId)).catch(() => [] as string[]);
	const start = async () => {
		const runId = await api.triggerOk(await api.orchestrationWith(SCENARIO), { token: TOKEN });
		return runId;
	};

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock, leaseMs: LEASE_MS, retentionDays: 1 });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["out"] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("正常结束：结果 Ack 之后副本删除；之后到达的日志、进度、动作不存，计数，运行详情里看得到", async () => {
		const agent = await connect();
		const runId = await start();
		const a = await agent.nextAssign();
		agent.logs(a, [[1, `using ${TOKEN}`]]);
		await agent.sync();
		await agent.succeed(a);
		await eventually(async () => expect((await runRow(runId)).vaults).toBe(0));
		expect((await runRow(runId)).vault_deleted_at).not.toBeNull();
		const before = await logFiles(runId);

		agent.logs(a, [[2, `late ${TOKEN}`]]);
		agent.progress(a, 2, 2, `late ${TOKEN}`);
		await agent.sync();
		await eventually(async () => expect((await runRow(runId)).late_reports_dropped).toBe(2));
		const [task] = await query<{ log_seq: number; progress: { message: string } | null }>(
			"select log_seq, progress from tasks where id = $1",
			[a.taskId],
		);
		expect(Number(task?.log_seq)).toBe(1);
		expect(await logFiles(runId)).toEqual(before);
		expect((await api.run(runId)).late_reports_dropped).toBe(2);
		expect(
			(await api.getJson<{ late_reports_dropped?: number }>(`/runs/${runId}/summary`))
				.late_reports_dropped,
		).toBe(2);
	});

	it("正常结束之后迟到的动作：明细不存、计一条；摘要不存、不计数（任务已经结束，在准入之前就丢弃）", async () => {
		const agent = await connect();
		const runId = await start();
		const a = await agent.nextAssign();
		const now = clock.now().getTime();
		agent.actions(a, [
			agent.actionStart(1, "early call", now),
			agent.actionEnd(1, "success", now + 1),
		]);
		agent.actionSummary(a, { total: 1, reported: 1 });
		await agent.sync();
		await agent.succeed(a);
		await eventually(async () => expect((await runRow(runId)).vaults).toBe(0));
		const stored = async () => {
			const details = await query<{ name: string }>(
				"select name from task_actions where task_id = $1 order by id",
				[a.taskId],
			);
			const [summary] = await query<{ summary: { total: number } }>(
				"select summary from task_action_summaries where task_id = $1",
				[a.taskId],
			);
			return { names: details.map((d) => d.name), total: summary?.summary.total };
		};
		const dropped = async () => (await runRow(runId)).late_reports_dropped;
		expect(await stored()).toEqual({ names: ["early call"], total: 1 });
		expect(await dropped()).toBe(0);

		// 先只发一批迟到的明细（入站消息按顺序处理，sync 之后它已经处理完）：不存，计一条。
		agent.actions(a, [
			agent.actionStart(2, `late ${TOKEN}`, now + 2, { fields: { key: TOKEN } }),
			agent.actionEnd(2, "failed", now + 3, { reason: `late ${TOKEN}` }),
		]);
		await agent.sync();
		expect(await stored()).toEqual({ names: ["early call"], total: 1 });
		expect(await dropped()).toBe(1);

		// 再发一份迟到的摘要：不存，计数不变（已知边界：摘要是明细的汇总，明细已经计过）。
		agent.actionSummary(a, { total: 2, reported: 2 });
		await agent.sync();
		expect(await stored()).toEqual({ names: ["early call"], total: 1 });
		expect(await dropped()).toBe(1);
		expect((await api.run(runId)).late_reports_dropped).toBe(1);
	});

	it("Agent 离线很久后重连补报：尝试还在它手上，副本保留，补报照常打码存下", async () => {
		let agent = await connect();
		const runId = await start();
		const a = await agent.nextAssign();
		await agent.disconnect();
		agent = await connect({
			runningTasks: [{ taskId: a.taskId, attempt: a.attempt, started: true }],
		});
		agent.logs(a, [[1, `resent ${TOKEN}`]]);
		await agent.sync();
		expect((await runRow(runId)).vaults).toBe(1);
		const page = await api.getJson<{ lines: Array<{ text: string }> }>(`/tasks/${a.taskId}/logs`);
		expect(page.lines.map((l) => l.text)).toEqual([`resent ${MASK}`]);
		await agent.succeed(a);
		await eventually(async () => expect((await runRow(runId)).vaults).toBe(0));
	});

	it("运行被取消时 Agent 不在线：运行结束、副本保留；Agent 回来被放弃、还在执行时保留，心跳不再列出它之后删除", async () => {
		let agent = await connect();
		const runId = await start();
		const a = await agent.nextAssign();
		await agent.disconnect();
		await api.cancelOk(runId);
		clock.advance(LEASE_MS + 1000);
		await eventually(async () => expect((await runRow(runId)).status).toBe("cancelled"));
		expect((await runRow(runId)).vaults).toBe(1);

		// 重连：Hello 列出 a，控制面放弃它；它还在执行（被强制取消、结束前一直在心跳里）。
		agent = await connect(
			{ runningTasks: [{ taskId: a.taskId, attempt: a.attempt, started: true }] },
			true,
		);
		expect(agent.dispositions[a.taskId]).toBe("abandon");
		await agent.heartbeat([a]);
		agent.logs(a, [[1, `still ${TOKEN}`]]);
		await agent.sync();
		expect((await runRow(runId)).vaults).toBe(1);
		const [row] = await query<{ abandoned_at: Date | null; released_at: Date | null }>(
			"select abandoned_at, released_at from tasks where id = $1",
			[a.taskId],
		);
		expect(row?.abandoned_at).not.toBeNull();
		expect(row?.released_at).toBeNull();

		// 结束了：心跳里不再列出它，副本删除；断线期间排队、这时才到的日志丢弃并计数。
		await agent.heartbeat([]);
		await eventually(async () => expect((await runRow(runId)).vaults).toBe(0));
		agent.logs(a, [[2, `queued ${TOKEN}`]]);
		await agent.sync();
		await eventually(async () => expect((await runRow(runId)).late_reports_dropped).toBe(1));
	});

	it("任务被判 agent_lost、重试之后旧尝试又报上来：离手之前照常打码存下，之后丢弃并计数", async () => {
		let agent = await connect();
		const runId = await start();
		const a1 = await agent.nextAssign();
		await agent.disconnect();
		clock.advance(LEASE_MS + 1000);
		// 旧尝试以 agent_lost 失败，重试排在同一台 Agent 上。
		await eventually(async () => {
			const rows = await query<{ attempt: number; status: string }>(
				"select attempt, status from tasks where run_id = $1 and node_id = 'a' order by attempt",
				[runId],
			);
			expect(rows).toEqual([
				{ attempt: 1, status: "failed" },
				{ attempt: 2, status: "queued" },
			]);
		});
		agent = await connect(
			{ runningTasks: [{ taskId: a1.taskId, attempt: a1.attempt, started: true }] },
			true,
		);
		expect(agent.dispositions[a1.taskId]).toBe("abandon");
		await agent.heartbeat([a1]);
		agent.logs(a1, [[1, `old ${TOKEN}`]]);
		await agent.sync();
		const page = await api.getJson<{ lines: Array<{ text: string }> }>(`/tasks/${a1.taskId}/logs`);
		expect(page.lines.map((l) => l.text)).toEqual([`old ${MASK}`]);

		await agent.heartbeat([]);
		const a2: AssignedTask = await agent.nextAssign();
		expect(a2.attempt).toBe(2);
		expect(a2.inputs.text).toBe(TOKEN);
		await agent.succeed(a2);
		await eventually(async () => expect((await runRow(runId)).vaults).toBe(0));
		agent.logs(a1, [[2, `older ${TOKEN}`]]);
		await agent.sync();
		await eventually(async () => expect((await runRow(runId)).late_reports_dropped).toBe(1));
	});

	it("Agent 永远不回来：运行结束后过了保留期，保留期清理删除副本", async () => {
		const agent = await connect();
		const runId = await start();
		await agent.nextAssign();
		await agent.disconnect();
		await api.cancelOk(runId);
		clock.advance(LEASE_MS + 1000);
		await eventually(async () => expect((await runRow(runId)).status).toBe("cancelled"));
		expect((await runRow(runId)).vaults).toBe(1);
		clock.advance(2 * 24 * 3600 * 1000);
		await eventually(async () => {
			const row = await runRow(runId);
			expect(row.vaults).toBe(0);
			expect(row.vault_deleted_at).not.toBeNull();
		});
	});
});
