// 切入点 A：Agent 上报的字符串里含 NUL（#207）与单条消息处理失败的隔离。
// PostgreSQL 的 text 和 jsonb 都不接受 NUL：控制面在网关入口把它换成 U+FFFD（src/gateway/storable.ts），
// 一条消息写库失败也不能关掉这台 Agent 的流、拖住它上面的其他任务。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL；写库失败用测试库里的触发器制造。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { InstallState } from "@sfly/proto";
import { agentsApi, logsApi, metricsApi, type RunMetricSummary } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { AgentUpdateState, ErrorKind, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const NUL = "\u0000";
const REPLACEMENT = "\uFFFD";

/** 2026-01-01T00:00:00Z 之后第 s 秒（Unix 秒）。 */
const at = (s: number) => Date.UTC(2026, 0, 1) / 1000 + s;

/** 入口节点 + 若干 stub/echo 包节点串成的单链。 */
function chain(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
	const all: Array<Record<string, unknown>> = [
		{ id: "entry", kind: "entry", params: [] },
		...nodes.map((n) => ({ kind: "package", package: "stub", node: "echo", ...n })),
	];
	return {
		default_agent: "agent-a",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
	};
}

/** 一个 bench/load 节点的场景（带指标）。 */
const BENCH = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "load", kind: "package", package: "bench", node: "load" },
	],
	edges: [{ from: "entry", to: "load", kind: "chain" }],
	packages: { bench: "1.0.0" },
};

describe("Agent 上报的字符串里含 NUL", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	const connect = async (hello: { os?: string } = {}) => {
		const agent = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: "agent-a", slots: 4, ...hello },
			{ clock: cp.clock },
		);
		agents.push(agent);
		return agent;
	};
	const summary = async (runId: string): Promise<RunMetricSummary> =>
		metricsApi.summary.response.parse(
			await (await cp.fetch(`/runs/${runId}/metrics/summary`)).json(),
		);

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v", "obj"] });
		await publishPackage(cp, "bench", "1.0.0", {
			load: {
				outputs: [],
				metrics: [
					{ name: "tps", unit: "req/s", kind: "gauge" },
					{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host"] },
				],
			},
		});
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	it("节点输出含 NUL：任务照常成功，NUL 换成 U+FFFD，后面的节点引用到替换后的值；流不断开", async () => {
		const agent = await connect();
		const id = await api.orchestrationWith(
			chain([
				{ id: "a" },
				{ id: "b", inputs: { v: "${{ nodes.a.outputs.v }}", obj: "${{ nodes.a.outputs.obj }}" } },
			]),
		);
		const runId = await api.triggerOk(id);

		const a = await agent.nextAssign();
		await agent.succeed(a, { v: `x${NUL}y`, obj: { [`k${NUL}`]: [NUL, 1, `${NUL}${NUL}`] } });
		const expected = {
			v: `x${REPLACEMENT}y`,
			obj: { [`k${REPLACEMENT}`]: [REPLACEMENT, 1, `${REPLACEMENT}${REPLACEMENT}`] },
		};
		const b = await agent.nextAssign();
		expect(b.inputs).toEqual(expected);
		await agent.succeed(b);

		expect((await api.run(runId)).status).toBe("success");
		expect((await api.node(runId, "a")).outputs).toEqual(expected);
		expect(agent.ended).toBe(false);
	});

	it("错误信息含 NUL：任务以原本的错误失败，NUL 换成 U+FFFD", async () => {
		const agent = await connect();
		const runId = await api.triggerOk(await api.orchestrationWith(chain([{ id: "a" }])));

		const a = await agent.nextAssign();
		await agent.fail(a, `bad${NUL}byte`, ErrorKind.TIMEOUT);

		expect((await api.node(runId, "a")).error).toEqual({
			kind: "timeout",
			message: `bad${REPLACEMENT}byte`,
		});
		expect((await api.run(runId)).status).toBe("failed");
		expect(agent.ended).toBe(false);
	});

	it("进度说明含 NUL：NUL 换成 U+FFFD", async () => {
		const agent = await connect();
		const runId = await api.triggerOk(await api.orchestrationWith(chain([{ id: "a" }])));

		const a = await agent.nextAssign();
		agent.progress(a, 1, 2, `第 1 步${NUL}`);
		await agent.sync();

		const [attempt] = (await api.node(runId, "a")).attempts;
		expect(attempt?.progress?.message).toBe(`第 1 步${REPLACEMENT}`);
		await agent.succeed(a);
		expect(agent.ended).toBe(false);
	});

	it("日志含 NUL：原样保存（日志写在文件里，不进数据库）", async () => {
		const agent = await connect();
		await api.triggerOk(await api.orchestrationWith(chain([{ id: "a" }])));

		const a = await agent.nextAssign();
		agent.logs(a, [[1, `bin${NUL}ary`]]);
		await agent.sync();

		const page = logsApi.page.response.parse(
			await (await cp.fetch(`/tasks/${a.taskId}/logs`)).json(),
		);
		expect(page.lines.map((l) => l.text)).toEqual([`bin${NUL}ary`]);
		await agent.succeed(a);
	});

	it("指标的标签值含 NUL 时换成 U+FFFD；指标名、标签键含 NUL 时与声明不符，点被丢弃", async () => {
		const agent = await connect();
		const runId = await api.triggerOk(await api.orchestrationWith(BENCH));
		const task = await agent.nextAssign();

		const point = (name: string, labels: Record<string, string>) => ({
			name,
			labels,
			timeUnixS: BigInt(at(1)),
			value: 1,
			min: 1,
			max: 1,
		});
		agent.metrics(task, [
			point("conn_tps", { host: `db${NUL}1` }),
			point(`tps${NUL}`, {}),
			point("conn_tps", { [`host${NUL}`]: "db2" }),
		]);
		await agent.succeed(task);

		const [only] = (await summary(runId)).tasks;
		expect(only?.metrics.map((m) => [m.name, m.labels, m.points])).toEqual([
			["conn_tps", { host: `db${REPLACEMENT}1` }, 1],
		]);
		// 未声明的指标名不计入丢弃数（与 SDK 一致），标签键不符的点计入。
		expect(only?.dropped_points).toBe(1);
		expect(agent.ended).toBe(false);
	});

	it("Agent 信息（Hello、心跳里的更新状态、安装状态）含 NUL：NUL 换成 U+FFFD", async () => {
		const agent = await connect({ os: `linux${NUL}` });
		agent.send({
			case: "heartbeat",
			value: { update: { state: AgentUpdateState.FAILED, reason: `下载失败${NUL}` } },
		});
		agent.send({
			case: "install",
			value: {
				package: `stub${NUL}`,
				version: "1.0.0",
				state: InstallState.FAILED,
				output: `pip${NUL}`,
				installedPackages: [{ name: `stub${NUL}`, version: "1.0.0" }],
			},
		});
		await agent.sync();

		const { agents: listed } = agentsApi.list.response.parse(
			await (await cp.fetch("/agents")).json(),
		);
		const [view] = listed;
		expect(view?.info.os).toBe(`linux${REPLACEMENT}`);
		expect(view?.update.reason).toBe(`下载失败${REPLACEMENT}`);
		expect(view?.install?.package).toBe(`stub${REPLACEMENT}`);
		expect(view?.installed_packages).toEqual([{ name: `stub${REPLACEMENT}`, version: "1.0.0" }]);
		expect(agent.ended).toBe(false);
	});
});

describe("一条消息写库失败不影响这台 Agent 的流和其他任务", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let db: pg.Client;
	const agents: FakeAgent[] = [];

	const connect = async () => {
		const agent = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: "agent-a", slots: 4 },
			{ clock: cp.clock },
		);
		agents.push(agent);
		return agent;
	};
	/** 在测试库里装一个触发器：`when` 成立的写入抛出异常（模拟数据库拒绝这一条数据）。 */
	const reject = async (table: string, when: string, events = "update") => {
		await db.query(`
			create or replace function sfly_test_reject() returns trigger language plpgsql as $$
			begin
				perform nextval('sfly_test_rejected');
				raise exception 'injected write failure';
			end $$;
			create trigger sfly_test_reject before ${events} on ${table}
				for each row when (${when}) execute function sfly_test_reject();`);
	};
	/** 触发器拒绝过的写入次数（序列不随事务回滚）。 */
	const rejected = async () => {
		const { rows } = await db.query<{ n: string }>(
			"select case when is_called then last_value else 0 end as n from sfly_test_rejected",
		);
		return Number(rows[0]?.n);
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await publishPackage(cp, "bench", "1.0.0", {
			load: {
				outputs: [],
				metrics: [{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host"] }],
			},
		});
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		await db.query("create sequence sfly_test_rejected");
	});
	afterEach(async () => {
		await db.end();
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const single = (node = "echo", pkg = "stub") => ({
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "a", kind: "package", package: pkg, node },
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { [pkg]: "1.0.0" },
	});

	it("结果写不进数据库：任务以 node_error 结束并回 Ack，流不断开，这台 Agent 上的其他任务照常", async () => {
		await reject("tasks", "new.outputs ? 'poison'");
		const agent = await connect();
		const id = await api.orchestrationWith(single());
		const first = await api.triggerOk(id);
		const a = await agent.nextAssign();
		const second = await api.triggerOk(id);
		const b = await agent.nextAssign();

		await agent.succeed(a, { poison: 1 });
		const node = await api.node(first, "a");
		expect(node.status).toBe("failed");
		expect(node.error?.kind).toBe("node_error");
		expect(node.error?.message).toContain("injected write failure");
		expect(await rejected()).toBe(1);

		await agent.succeed(b, { v: 1 });
		expect((await api.node(second, "a")).outputs).toEqual({ v: 1 });
		expect(agent.ended).toBe(false);
	});

	it("其他消息写不进数据库（进度）：记下错误、跳过这一条，后面的消息照常处理", async () => {
		await reject("tasks", "new.progress->>'message' = 'poison'");
		const agent = await connect();
		const runId = await api.triggerOk(await api.orchestrationWith(single()));
		const a = await agent.nextAssign();

		agent.progress(a, 1, 2, "poison");
		agent.progress(a, 2, 2, "ok");
		await agent.sync();
		expect(await rejected()).toBe(1);
		expect((await api.node(runId, "a")).attempts[0]?.progress?.message).toBe("ok");

		await agent.succeed(a, { v: 1 });
		expect((await api.run(runId)).status).toBe("success");
		expect(agent.ended).toBe(false);
	});

	describe("指标写库失败", () => {
		const clock = () => cp.clock as ManualClock;
		const point = (host: string, t: number) => ({
			name: "conn_tps",
			labels: { host },
			timeUnixS: BigInt(at(t)),
			value: t,
			min: t,
			max: t,
		});
		const pointsOf = async (runId: string) =>
			metricsApi.summary.response
				.parse(await (await cp.fetch(`/runs/${runId}/metrics/summary`)).json())
				.tasks.flatMap((t) => t.metrics.map((m) => [m.labels.host, m.points]));

		it("任务结束时写不进去：结果照常处理；失败的点重试有限次后丢弃，不影响其他任务的指标", async () => {
			await reject("metric_series", "new.labels->>'host' = 'poison'", "insert");
			const agent = await connect();
			const id = await api.orchestrationWith(single("load", "bench"));
			const first = await api.triggerOk(id);
			const a = await agent.nextAssign();
			const second = await api.triggerOk(id);
			const b = await agent.nextAssign();

			agent.metrics(a, [point("poison", 1)]);
			agent.metrics(b, [point("ok", 1)]);
			await agent.succeed(a);
			expect((await api.run(first)).status).toBe("success");
			expect(await rejected()).toBe(1);

			// 周期写入：a 还剩两次重试，之后丢弃；排在它后面的 b 照常写入。
			clock().advance(10_000);
			await eventually(async () => expect(await pointsOf(second)).toEqual([["ok", 1]]));
			await eventually(async () => expect(await rejected()).toBe(3));

			// 丢弃之后不再重试：b 的下一个点写入（又一轮周期写入）之后，拒绝次数不变。
			agent.metrics(b, [point("ok", 2)]);
			await agent.sync();
			clock().advance(10_000);
			await eventually(async () => expect(await pointsOf(second)).toEqual([["ok", 2]]));
			expect(await rejected()).toBe(3);
			expect(await pointsOf(first)).toEqual([]);
			expect(agent.ended).toBe(false);
		});

		it("暂时写不进去：下一次周期写入时重试，恢复后点照常写入", async () => {
			await reject(
				"metric_series",
				"new.labels->>'host' = 'flaky' and nextval('sfly_test_rejected') <= 1",
				"insert",
			);
			const agent = await connect();
			const runId = await api.triggerOk(await api.orchestrationWith(single("load", "bench")));
			const a = await agent.nextAssign();

			agent.metrics(a, [point("flaky", 1)]);
			await agent.succeed(a);
			clock().advance(10_000);
			await eventually(async () => expect(await pointsOf(runId)).toEqual([["flaky", 1]]));
		});
	});
});
