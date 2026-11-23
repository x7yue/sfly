// 数值设置的范围（#577），真实的控制面和数据库：上限以内的最大值下，保留期的清理、登录照常工作；超出范围的值在启动时就被拒绝
// （程序里直接给 `startControlPlane` 的选项和环境变量同一个范围，env-settings.test.ts 管环境变量的各种写法）。
// 保留天数很大时清理的截止时间早于数据库能表示的下限（约 247 万天起）或在控制面里就是无效的时间（约 1 亿天起）：
// 以前启动正常，清理任务每分钟报错、悄悄不清理；现在上限是 36500 天（100 年），截止时间永远是有效的时间。
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LOGIN_IDLE_HOURS, MAX_RETENTION_DAYS } from "../src/config/env-settings.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe("启动时拒绝超出范围的数值选项", () => {
	it.each([
		["retentionDays", { retentionDays: 100_000_000 }],
		["retentionDays", { retentionDays: Number.POSITIVE_INFINITY }],
		["retentionDays", { retentionDays: MAX_RETENTION_DAYS + 1 }],
		["metricRetentionDays", { metricRetentionDays: 2_500_000 }],
		["metricRetentionDays", { metricRetentionDays: Number.NaN }],
		["logLimitBytes", { logLimitBytes: Number.POSITIVE_INFINITY }],
		["metricLimitBytes", { metricLimitBytes: 0 }],
		["loginIdleMs", { loginIdleMs: Number.POSITIVE_INFINITY }],
		["loginIdleMs", { loginIdleMs: MAX_LOGIN_IDLE_HOURS * HOUR + 1 }],
	])(
		"%s：控制面不启动，说明写明选项名和范围",
		async (name, options) => {
			await expect(startTestControlPlane(options)).rejects.toThrow(`${name} 不合法`);
		},
		60_000,
	);
});

describe("上限以内的最大值", () => {
	let cp: TestControlPlane | undefined;
	let agent: FakeAgent | undefined;

	afterEach(async () => {
		await agent?.disconnect();
		await cp?.close();
		agent = undefined;
		cp = undefined;
	});

	const clock = () => (cp as TestControlPlane).clock as ManualClock;
	/** 当前时钟之后第 s 秒（Unix 秒）。 */
	const now = (s = 0) => Math.floor(clock().now().getTime() / 1000) + s;
	const fewSweeps = () => new Promise((r) => setTimeout(r, 150));

	describe("日志和产物的保留期：SFLY_RETENTION_DAYS = 36500", () => {
		const DOC = {
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { stub: "1.0.0" },
		};

		it("清理任务正常跑：没到期的运行保留，过了 36500 天的被清理；运行和任务结果保留", async () => {
			// 时钟一次推进一百年：任务租约设得比这更长。
			cp = await startTestControlPlane({
				leaseMs: 40_000 * DAY,
				retentionDays: MAX_RETENTION_DAYS,
			});
			await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
			agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
			const api = new ApiClient(cp);
			const runId = await api.triggerOk(await api.orchestrationWith(DOC));
			const task: AssignedTask = await agent.nextAssign();
			agent.logs(task, [[1, "hello"]]);
			const logPage = async () =>
				(await (await (cp as TestControlPlane).fetch(`/tasks/${task.taskId}/logs`)).json()) as {
					lines: unknown[];
					expired: boolean;
				};
			await eventually(async () => expect((await logPage()).lines).toHaveLength(1));
			await agent.succeed(task, { text: "ok" });
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));

			clock().advance((MAX_RETENTION_DAYS - 1) * DAY);
			await fewSweeps();
			expect((await logPage()).expired).toBe(false);

			clock().advance(2 * DAY);
			await eventually(async () => expect((await logPage()).expired).toBe(true));
			expect((await api.run(runId)).status).toBe("success");
		}, 60_000);
	});

	describe("指标的保留期：SFLY_METRIC_RETENTION_DAYS = 36500", () => {
		it("清理任务正常跑：没到期的运行指标保留，过了 36500 天的标为已过保留期，分区照常创建", async () => {
			cp = await startTestControlPlane({
				leaseMs: 40_000 * DAY,
				metricRetentionDays: MAX_RETENTION_DAYS,
			});
			await publishPackage(cp, "bench", "1.0.0", {
				load: { outputs: [], metrics: [{ name: "tps", unit: "req/s", kind: "gauge" }] },
			});
			agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
			const api = new ApiClient(cp);
			const runId = await api.triggerOk(
				await api.orchestrationWith({
					default_agent: "agent-a",
					nodes: [
						{ id: "entry", kind: "entry" },
						{ id: "load", kind: "package", package: "bench", node: "load" },
					],
					edges: [{ from: "entry", to: "load", kind: "chain" }],
					packages: { bench: "1.0.0" },
				}),
			);
			const task = await agent.nextAssign();
			agent.metrics(task, [["tps", now(1), 10]]);
			await agent.succeed(task);
			const summary = async () =>
				(await (await (cp as TestControlPlane).fetch(`/runs/${runId}/metrics/summary`)).json()) as {
					expired: boolean;
					tasks: unknown[];
				};
			await eventually(async () => expect((await summary()).tasks).toHaveLength(1));

			clock().advance((MAX_RETENTION_DAYS - 1) * DAY);
			await fewSweeps();
			expect((await summary()).expired).toBe(false);

			clock().advance(2 * DAY);
			await eventually(async () => expect((await summary()).expired).toBe(true));
			// 一百年后（2125 年）的分区照常提前创建（扫描没有报错中断）。
			const client = new pg.Client({ connectionString: (cp as TestControlPlane).database.url });
			await client.connect();
			try {
				const { rows } = await client.query<{ name: string }>(
					`select c.relname as name from pg_inherits i
						join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
					where p.relname = 'metric_segments' order by 1`,
				);
				const today = (cp as TestControlPlane).clock
					.now()
					.toISOString()
					.slice(0, 10)
					.replaceAll("-", "");
				expect(today.startsWith("2125")).toBe(true); // 36501 天之后：2125 年
				expect(rows.map((r) => r.name)).toContain(`metric_segments_${today}`);
			} finally {
				await client.end();
			}
		}, 60_000);
	});

	describe("登录的空闲期限：SFLY_LOGIN_IDLE_HOURS = 876000", () => {
		it("登录成功，Cookie 的有效期是 100 年（秒数装得下），过了一年登录仍然有效", async () => {
			cp = await startTestControlPlane({
				initialAdmin: { loginName: "root", password: "admin-password-1", displayName: "管理员" },
				loginIdleMs: MAX_LOGIN_IDLE_HOURS * HOUR,
			});

			const res = await cp.fetch("/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ login_name: "root", password: "admin-password-1" }),
			});

			expect(res.status).toBe(200);
			const setCookie = res.headers.get("set-cookie") ?? "";
			expect(setCookie).toContain(`Max-Age=${MAX_LOGIN_IDLE_HOURS * 3600}`);
			const cookie = /sfly_login=([^;]*)/.exec(setCookie)?.[1] ?? "";
			clock().advance(365 * DAY);
			const me = await cp.fetch("/auth/me", {
				headers: { cookie: `sfly_login=${cookie}`, "sec-fetch-site": "same-origin" },
			});
			expect(me.status).toBe(200);
		}, 60_000);
	});
});
