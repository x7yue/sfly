// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
// 切入点 A：定时节点与 Sleep 节点（docs/SEMANTICS.md §5）——持久化定时器、late、不占用 Agent、always、取消、重启。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL；时间只由手动时钟推进，不做真实等待。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MINUTE = 60_000;
/** 手动时钟起点：2026-01-01T00:00:00Z = 上海 08:00:00。 */
const START = "2026-01-01T00:00:00.000Z";

/** 入口节点 + 若干节点串成的单链；没写 kind 的是 stub/echo 包节点。 */
function chain(
	nodes: Array<Record<string, unknown>>,
	params: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
	const all: Array<Record<string, unknown>> = [
		{ id: "entry", kind: "entry", params },
		...nodes.map((n) => (n.kind ? n : { kind: "package", package: "stub", node: "echo", ...n })),
	];
	return {
		default_agent: "agent-a",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
	};
}

describe("定时节点与 Sleep 节点", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		clock = new ManualClock(START);
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 1 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const statuses = async (runId: string) =>
		Object.fromEntries(
			(await api.run(runId)).chains[0]?.nodes.map((n) => [n.node_id, n.status]) ?? [],
		);

	it("Sleep 节点等待期间为 waiting、唤醒时间可见，时钟到点后成功并继续推进链", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "s", kind: "sleep", duration: "10m" }, { id: "a" }]),
		);
		const runId = await api.triggerOk(id);

		const waiting = await api.node(runId, "s");
		expect(waiting).toMatchObject({ status: "waiting", agent: null });
		expect(waiting.attempts).toHaveLength(1);
		expect(waiting.attempts[0]).toMatchObject({
			status: "waiting",
			agent: null,
			started_at: START,
			wake_at: "2026-01-01T00:10:00.000Z",
		});
		clock.advance(10 * MINUTE - 1000);
		await agent.expectNoAssign(150);
		expect(await statuses(runId)).toMatchObject({ s: "waiting", a: "pending" });

		clock.advance(1000);
		const a = await agent.nextAssign();
		expect(a.nodeId).toBe("a");
		const done = await api.node(runId, "s");
		expect(done.status).toBe("success");
		expect(done.outputs).toEqual({ triggered_at: "2026-01-01T00:10:00.000Z" });
		await agent.succeed(a);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});

	it("Sleep 时长可以引用入口参数", async () => {
		const id = await api.orchestrationWith(
			chain(
				[{ id: "s", kind: "sleep", duration: "${{ params.wait }}" }, { id: "a" }],
				[{ name: "wait", type: "string", default: "1h" }],
			),
		);
		const runId = await api.triggerOk(id, { wait: "30s" });
		expect((await api.node(runId, "s")).attempts[0]?.wake_at).toBe("2026-01-01T00:00:30.000Z");
		clock.advance(30_000);
		expect((await agent.nextAssign()).nodeId).toBe("a");
	});

	it("引用解析出的时长无效时 Sleep 节点以 config_error 失败", async () => {
		const id = await api.orchestrationWith(
			chain(
				[{ id: "s", kind: "sleep", duration: "${{ params.wait }}" }, { id: "a" }],
				[{ name: "wait", type: "string" }],
			),
		);
		const runId = await api.triggerOk(id, { wait: "soon" });
		const s = await api.node(runId, "s");
		expect(s.status).toBe("failed");
		expect(s.error?.kind).toBe("config_error");
		expect(await statuses(runId)).toMatchObject({ a: "skipped" });
		expect((await api.run(runId)).status).toBe("failed");
	});

	it("定时节点 HH:MM:SS：等到节点开始当天（默认 Asia/Shanghai）的这个时刻，输出 late=false", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "t", kind: "timer", at: "09:30:00" }, { id: "a" }]),
		);
		const runId = await api.triggerOk(id);
		expect((await api.node(runId, "t")).attempts[0]).toMatchObject({
			status: "waiting",
			wake_at: "2026-01-01T01:30:00.000Z",
		});

		clock.advance(89 * MINUTE);
		await agent.expectNoAssign(150);
		clock.advance(MINUTE + 5000);
		expect((await agent.nextAssign()).nodeId).toBe("a");
		const t = await api.node(runId, "t");
		expect(t.status).toBe("success");
		// triggered_at 是实际完成时间（扫描发现到期的那一刻）。
		expect(t.outputs).toEqual({ triggered_at: "2026-01-01T01:30:05.000Z", late: false });
	});

	it("定时节点的时刻已经过去时立即成功，输出 late=true", async () => {
		const id = await api.orchestrationWith(
			chain([
				{ id: "t", kind: "timer", at: "07:00:00" },
				{ id: "t2", kind: "timer", at: "2025-12-31T00:00:00Z", tz: "UTC" },
				{ id: "a" },
			]),
		);
		const runId = await api.triggerOk(id);
		expect((await agent.nextAssign()).nodeId).toBe("a");
		for (const nodeId of ["t", "t2"]) {
			const t = await api.node(runId, nodeId);
			expect(t.status).toBe("success");
			expect(t.outputs).toEqual({ triggered_at: START, late: true });
		}
	});

	it("定时节点可以用完整日期时间和其他时区", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "t", kind: "timer", at: "2026-01-01T20:00:00", tz: "America/New_York" }]),
		);
		const runId = await api.triggerOk(id);
		expect((await api.node(runId, "t")).attempts[0]?.wake_at).toBe("2026-01-02T01:00:00.000Z");
		clock.set("2026-01-02T01:00:00.000Z");
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});

	it("等待中的节点不占用 Agent 槽位", async () => {
		const waiting = await api.orchestrationWith(
			chain([{ id: "s", kind: "sleep", duration: "1h" }, { id: "a" }]),
		);
		const busy = await api.orchestrationWith(chain([{ id: "b" }]), "other");
		const first = await api.triggerOk(waiting);
		await api.triggerOk(busy);
		// agent-a 只有 1 个槽位：另一个运行的包节点照常派发。
		expect((await agent.nextAssign()).nodeId).toBe("b");
		expect(await statuses(first)).toMatchObject({ s: "waiting" });
	});

	it("always 的 Sleep 节点在前面失败后照常等待，之后的普通节点被跳过", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "a" }, { id: "s", kind: "sleep", duration: "5m", always: true }, { id: "b" }]),
		);
		const runId = await api.triggerOk(id);
		await agent.fail(await agent.nextAssign());
		await eventually(async () =>
			expect(await statuses(runId)).toMatchObject({ a: "failed", s: "waiting" }),
		);
		clock.advance(5 * MINUTE);
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
		expect(await statuses(runId)).toMatchObject({ s: "success", b: "skipped" });
	});

	it("取消运行时，正在等待的节点立即变为 cancelled", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "t", kind: "timer", at: "23:00:00" }, { id: "a" }, { id: "c", always: true }]),
		);
		const runId = await api.triggerOk(id);
		await api.cancelOk(runId);
		expect((await agent.nextAssign()).nodeId).toBe("c");
		expect(await statuses(runId)).toMatchObject({ t: "cancelled", a: "cancelled", c: "running" });
		// 被取消的等待算一次尝试（已经开始等待）。
		expect((await api.node(runId, "t")).attempts.map((t) => t.status)).toEqual(["cancelled"]);

		// 定时器不会在之后再次触发。
		clock.advance(24 * 60 * MINUTE);
		await agent.expectNoAssign(150);
		expect((await api.node(runId, "t")).status).toBe("cancelled");
	});

	it("always 的 Sleep 节点在普通取消时照常等待，再次取消（强制）时立即取消", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "s", kind: "sleep", duration: "1h", always: true }, { id: "a" }]),
		);
		const runId = await api.triggerOk(id);
		await api.cancelOk(runId);
		expect(await statuses(runId)).toMatchObject({ s: "waiting" });
		expect((await api.run(runId)).status).toBe("running");

		await api.cancelOk(runId);
		const run = await api.run(runId);
		expect(run.status).toBe("cancelled");
		expect(await statuses(runId)).toMatchObject({ s: "cancelled", a: "cancelled" });
	});

	it("定时器状态在 PG 中：控制面重启后继续等待并按时唤醒", async () => {
		const id = await api.orchestrationWith(
			chain([{ id: "s", kind: "sleep", duration: "10m" }, { id: "a" }]),
		);
		const runId = await api.triggerOk(id);
		await agent.disconnect();
		await cp.restart();
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 1 });
		expect(await statuses(runId)).toMatchObject({ s: "waiting" });

		clock.advance(10 * MINUTE);
		expect((await agent.nextAssign()).nodeId).toBe("a");
	});

	it("触发时拒绝无效的定时 / Sleep 配置", async () => {
		const id = await api.orchestrationWith(
			chain([
				{ id: "t", kind: "timer", at: "9点半" },
				{ id: "s", kind: "sleep", duration: "ten minutes" },
			]),
		);
		const res = await api.trigger(id);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; details: Array<{ code: string }> };
		};
		expect(body.error.code).toBe("invalid_orchestration");
		expect(body.error.details.map((d) => d.code)).toEqual(
			expect.arrayContaining(["timer_at_invalid", "sleep_duration_invalid"]),
		);
	});
});
