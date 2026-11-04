// 切入点 A：日志和产物的保留期（#18）。运行结束超过保留期后，日志和产物被自动清理；
// 是否到期只按注入的时钟判断：测试推进 ManualClock，周期扫描很快就会处理。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DAY = 24 * 60 * 60 * 1000;

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

describe("日志和产物的保留期", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;

	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const setup = async (options: { retentionDays?: number } = {}) => {
		// 时钟一次推进几十天：任务租约（#15）设得比这更长，免得假 Agent 没心跳导致还在运行的任务以 agent_lost 结束。
		cp = await startTestControlPlane({ leaseMs: 400 * DAY, ...options });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		return new ApiClient(cp);
	};
	const clock = () => cp.clock as ManualClock;

	/** 触发一次运行：任务写日志、上传一个产物。finish 时上报成功，运行结束。 */
	const runWithFiles = async (api: ApiClient, finish = true) => {
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		agent.logs(task, [[1, "hello"]]);
		await eventually(async () => expect((await logPage(task)).last_seq).toBe(1));
		const put = await fetch(`${task.artifactUploadUrl}report.txt`, {
			method: "PUT",
			headers: { "content-type": "application/octet-stream" },
			body: "report",
		});
		expect(put.status).toBe(201);
		if (finish) await agent.succeed(task, { text: "ok" });
		return { runId, task };
	};

	const logPage = async (task: AssignedTask) =>
		(await (await cp.fetch(`/tasks/${task.taskId}/logs`)).json()) as {
			lines: unknown[];
			last_seq: number;
			expired: boolean;
		};
	const artifactList = async (task: AssignedTask) =>
		(await (await cp.fetch(`/tasks/${task.taskId}/artifacts`)).json()) as {
			artifacts: unknown[];
			expired: boolean;
		};
	/** 等几轮扫描（间隔 20ms），用来断言"没有被清理"。 */
	const fewSweeps = () => new Promise((r) => setTimeout(r, 150));

	it("运行结束超过保留期（可配置）后，日志和产物被清理；运行和任务结果保留", async () => {
		const api = await setup({ retentionDays: 7 });
		const { runId, task } = await runWithFiles(api);

		clock().advance(7 * DAY - 1000);
		await fewSweeps();
		expect((await logPage(task)).lines).toHaveLength(1);
		expect((await artifactList(task)).artifacts).toHaveLength(1);
		expect((await cp.fetch(`/tasks/${task.taskId}/artifacts/report.txt`)).status).toBe(200);

		clock().advance(2000);
		await eventually(async () => expect((await logPage(task)).expired).toBe(true));
		expect((await logPage(task)).lines).toEqual([]);
		expect(await artifactList(task)).toMatchObject({ artifacts: [], expired: true });
		const download = await cp.fetch(`/tasks/${task.taskId}/artifacts/report.txt`);
		expect(download.status).toBe(410);
		expect(((await download.json()) as { error: { code: string } }).error.code).toBe("expired");
		expect((await cp.fetch(`/tasks/${task.taskId}/logs/download`)).status).toBe(410);
		// 磁盘上这个运行的日志和产物目录都被删除。
		expect(existsSync(join(cp.dataDir, "logs", runId))).toBe(false);
		expect(existsSync(join(cp.dataDir, "artifacts", runId))).toBe(false);

		const run = await api.run(runId);
		expect(run.status).toBe("success");
		expect(run.chains[0]?.nodes.find((n) => n.node_id === "a")?.outputs).toEqual({ text: "ok" });
	});

	it("默认保留 30 天；还在运行的运行不清理", async () => {
		const api = await setup();
		const done = await runWithFiles(api);
		const running = await runWithFiles(api, false);

		clock().advance(30 * DAY - 1000);
		await fewSweeps();
		expect((await logPage(done.task)).expired).toBe(false);

		clock().advance(2000);
		await eventually(async () => expect((await logPage(done.task)).expired).toBe(true));

		clock().advance(365 * DAY);
		await fewSweeps();
		expect(await logPage(running.task)).toMatchObject({ expired: false, last_seq: 1 });
		expect((await artifactList(running.task)).artifacts).toHaveLength(1);
		expect(existsSync(join(cp.dataDir, "logs", running.runId))).toBe(true);
	});

	it("控制面重启后，按数据库里的结束时间照常清理", async () => {
		const api = await setup({ retentionDays: 1 });
		const { task } = await runWithFiles(api);
		await agent.disconnect();
		await cp.restart();
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });

		clock().advance(DAY + 1000);
		await eventually(async () => expect((await artifactList(task)).expired).toBe(true));
	});
});
