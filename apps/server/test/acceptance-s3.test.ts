// 验收场景 S3 故障（docs/SEMANTICS.md §8）：真实的控制面、真实的 Rust Agent、真实的 SDK 执行器和桩节点包。
// Agent 断线后按重试配置重新派发；超时杀掉进程树；取消时 always 节点照常执行，再次取消则强制终止；
// 依赖冲突以 env_error 失败且不重试（PyPI 镜像是本地桩）；控制面重启后定时器和运行继续推进。
// 控制面用手动时钟（租约、Sleep 何时到期由测试决定）；超时与取消宽限由 Agent 按真实时间执行。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainOf, isAlive, nodeOf, orchestration, statuses, stub } from "./support/acceptance.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import type { ManualClock } from "./support/manual-clock.js";
import { dependencyWheel, type PypiStub, startPypiStub } from "./support/pypi-stub.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { buildStubPackage, publishArchive, publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const readPids = async (file: string) =>
	(await readFile(file, "utf8")).trim().split(" ").map(Number);

describe("验收 S3：故障", () => {
	let bin: string;
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let bareVenv: Awaited<ReturnType<typeof createStubVenv>>;
	let pypi: PypiStub;
	let dir: string;
	let agent: RealAgent;
	const extraAgents: RealAgent[] = [];
	const pids: number[] = [];

	beforeAll(async () => {
		bin = agentBinary();
		[cp, venv, bareVenv, dir] = await Promise.all([
			startTestControlPlane(),
			createStubVenv(),
			createStubVenv({ sdkOnly: true }),
			mkdtemp(join(tmpdir(), "sfly-s3-")),
		]);
		api = new ApiClient(cp);
		clock = cp.clock as ManualClock;
		await publishStubPackage(cp);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "s3-agent",
			venv: venv.path,
			bin,
			args: ["--terminate-grace", "10"],
		});
	}, 600_000);

	afterAll(async () => {
		for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
		await Promise.all([agent, ...extraAgents].map((a) => a?.close()));
		await pypi?.close();
		await cp?.close();
		await Promise.all([venv?.remove(), bareVenv?.remove()]);
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("Agent 断线后租约过期（agent_lost），按 retries 重新派发到同一个 Agent，Agent 回来后执行成功", async () => {
		const ready = join(dir, "lost-ready");
		const release = join(dir, "lost-release");
		const start = () =>
			startRealAgent({ grpcUrl: cp.grpcUrl, name: "s3-flaky", venv: venv.path, bin });
		const first = await start();
		extraAgents.push(first);
		const id = await api.orchestrationWith(
			orchestration("s3-flaky", [
				[
					{ id: "entry", kind: "entry" },
					stub("g", "gate", { ready_file: ready, release_file: release }, { retries: 1 }),
					stub("after", "echo", { text: "继续" }),
				],
			]),
		);
		const runId = await api.triggerOk(id);
		await eventually(async () => expect(await readFile(ready, "utf8")).toBe("1\n"), 30_000);

		// Agent 进程被杀：控制面在租约（30 秒）过期前仍认为任务在运行。
		await first.close();
		expect((await api.node(runId, "g")).status).toBe("running");
		clock.advance(31_000);
		await eventually(async () => {
			const g = await api.node(runId, "g");
			expect(g.attempts.map((a) => [a.attempt, a.status, a.agent, a.error?.kind ?? null])).toEqual([
				[1, "failed", "s3-flaky", "agent_lost"],
				[2, "queued", "s3-flaky", null],
			]);
		}, 30_000);

		// 同名 Agent 重新上线后收到第 2 次尝试。
		await writeFile(release, "");
		extraAgents.push(await start());
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);
		const g = await api.node(runId, "g");
		expect(g.attempts.map((a) => [a.attempt, a.status])).toEqual([
			[1, "failed"],
			[2, "success"],
		]);
		expect(g.outputs).toEqual({ attempt: 2 });
		expect(await readFile(ready, "utf8")).toBe("1\n2\n");
		expect((await api.node(runId, "after")).status).toBe("success");
	}, 120_000);

	it("超时后杀掉整个进程树（执行器和它启动的子进程）", async () => {
		const pidFile = join(dir, "timeout-pids");
		const id = await api.orchestrationWith(
			orchestration("s3-agent", [
				[
					{ id: "entry", kind: "entry" },
					stub("tree", "process_tree", { pid_file: pidFile }, { timeout: 1 }),
				],
			]),
		);
		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 30_000);
		const tree = await api.node(runId, "tree");
		expect(tree.attempts.map((a) => [a.status, a.error?.kind])).toEqual([["failed", "timeout"]]);
		expect(tree.error?.message).toContain("1 秒");
		const tracked = await readPids(pidFile);
		pids.push(...tracked);
		expect(tracked).toHaveLength(2);
		await eventually(() => expect(tracked.filter(isAlive)).toEqual([]), 10_000);
	}, 60_000);

	it("取消：运行中的节点被优雅终止，always 节点照常执行；清理中再次取消则强制终止 always 节点", async () => {
		const ready = join(dir, "cancel-ready");
		const report = join(dir, "cancel-report");
		const pidFile = join(dir, "cancel-pids");
		const id = await api.orchestrationWith(
			orchestration("s3-agent", [
				[
					{ id: "entry", kind: "entry" },
					stub("work", "wait_cancel", { ready_file: ready, report_file: report }),
					stub("next", "echo", { text: "x" }),
					// 这个 always 节点忽略 SIGTERM，只有强制终止（SIGKILL）才能停下它。
					stub(
						"cleanup",
						"process_tree",
						{ pid_file: pidFile, ignore_term: true },
						{ always: true },
					),
					stub("final", "echo", { text: "y" }, { always: true }),
				],
			]),
		);
		const runId = await api.triggerOk(id);
		await eventually(async () => expect(await readFile(ready, "utf8")).not.toBe(""), 30_000);

		await api.cancelOk(runId);
		await eventually(async () => expect(await readPids(pidFile)).toHaveLength(2), 30_000);
		const tracked = await readPids(pidFile);
		pids.push(...tracked);
		expect(await readFile(report, "utf8")).toBe("cancelled");
		let run = await api.run(runId);
		expect(run.status).toBe("running");
		expect(run.cancel).toMatchObject({ requested_by: "tester", forced_at: null });
		expect(statuses(chainOf(run, "entry"))).toEqual({
			entry: "success",
			work: "cancelled",
			next: "cancelled",
			cleanup: "running",
			final: "pending",
		});
		expect(tracked.every(isAlive)).toBe(true);

		// 再次取消 = 强制：always 节点的进程树立即被杀，后面的 always 节点也不再执行。
		const forcedAt = Date.now();
		await api.cancelOk(runId);
		await eventually(async () => expect((await api.run(runId)).status).toBe("cancelled"), 30_000);
		run = await api.run(runId);
		expect(run.cancel?.forced_at).not.toBeNull();
		expect(statuses(chainOf(run, "entry"))).toMatchObject({
			cleanup: "cancelled",
			final: "cancelled",
		});
		await eventually(() => expect(tracked.filter(isAlive)).toEqual([]), 10_000);
		// 比 10 秒宽限期快得多：不是先 SIGTERM 再等宽限（进程忽略 SIGTERM）。
		expect(Date.now() - forcedAt).toBeLessThan(8_000);
	}, 60_000);

	it("依赖冲突：节点包安装失败以 env_error 结束且不重试，已安装的包不受影响", async () => {
		pypi = await startPypiStub([
			dependencyWheel("sfly-dep", "1.0"),
			dependencyWheel("sfly-dep", "2.0"),
		]);
		const [a, b] = await Promise.all([
			buildStubPackage("conf-a", "1.0.0", ["sfly-dep==1.0"]),
			buildStubPackage("conf-b", "1.0.0", ["sfly-dep==2.0"]),
		]);
		await publishArchive(cp, a);
		await publishArchive(cp, b);
		const installer = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "s3-install",
			venv: bareVenv.path,
			bin,
			args: ["--index-url", pypi.indexUrl],
			env: { UV_CACHE_DIR: join(dir, "uv-cache") },
		});
		extraAgents.push(installer);

		const id = await api.orchestrationWith(
			orchestration(
				"s3-install",
				[
					[
						{ id: "entry", kind: "entry" },
						stub("a", "about", {}, { package: "conf-a" }),
						stub("b", "about", {}, { package: "conf-b", retries: 2 }),
						stub("after", "about", {}, { package: "conf-a" }),
						stub("again", "about", {}, { package: "conf-a", always: true }),
					],
				],
				[],
				{ "conf-a": "1.0.0", "conf-b": "1.0.0" },
			),
		);
		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 120_000);
		const main = chainOf(await api.run(runId), "entry");
		expect(statuses(main)).toEqual({
			entry: "success",
			a: "success",
			b: "failed",
			after: "skipped",
			again: "success",
		});
		expect(nodeOf(main, "a").outputs).toEqual({ package: "conf-a", version: "1.0.0" });
		const failed = nodeOf(main, "b");
		expect(failed.attempts).toHaveLength(1);
		expect(failed.error?.kind).toBe("env_error");
		expect(failed.error?.message).toContain("conf-b@1.0.0");
		expect(failed.error?.message).toContain("sfly-dep");
		expect(nodeOf(main, "again").outputs).toEqual({ package: "conf-a", version: "1.0.0" });

		const { agents } = await api.getJson<{
			agents: Array<{ name: string; installed_packages: unknown; install: unknown }>;
		}>("/agents");
		expect(agents.find((x) => x.name === "s3-install")).toMatchObject({
			installed_packages: [{ name: "conf-a", version: "1.0.0" }],
			install: { package: "conf-b", version: "1.0.0", state: "failed" },
		});
		// 依赖只来自本地镜像桩。
		expect(pypi.requests).toContain("/files/sfly_dep-1.0-py3-none-any.whl");
	}, 180_000);

	it("控制面重启：运行中的任务在停机期间完成后结果照常上报，等待中的 Sleep 在重启后到点继续推进", async () => {
		const ready = join(dir, "restart-ready");
		const release = join(dir, "restart-release");
		const id = await api.orchestrationWith(
			orchestration("s3-agent", [
				[
					{ id: "entry", kind: "entry" },
					stub("g", "gate", { ready_file: ready, release_file: release }),
					{ id: "nap", kind: "sleep", duration: "5m" },
					stub("done", "echo", { text: "${{ nodes.nap.outputs.triggered_at }}" }),
				],
			]),
		);
		const runId = await api.triggerOk(id);
		await eventually(async () => expect(await readFile(ready, "utf8")).toBe("1\n"), 30_000);
		const taskId = (await api.node(runId, "g")).attempts[0]?.task_id as string;
		const welcomes = () => agent.events.filter((e) => e.event === "welcome").length;
		const before = welcomes();

		// 第一次重启：停机期间任务完成（执行器写出结果），Agent 重连后 Hello 列出它、补报结果。
		await cp.restart(async () => {
			await writeFile(release, "");
			await eventually(() => access(join(agent.workDir, "tasks", taskId, "output.json")), 30_000);
		});
		await eventually(async () => {
			expect(welcomes()).toBeGreaterThan(before);
			expect((await api.node(runId, "nap")).status).toBe("waiting");
		}, 30_000);
		const g = await api.node(runId, "g");
		expect(g.attempts.map((a) => [a.attempt, a.status])).toEqual([[1, "success"]]);
		expect(g.outputs).toEqual({ attempt: 1 });
		const wakeAt = (await api.node(runId, "nap")).attempts[0]?.wake_at as string;

		// 第二次重启：停机期间时钟越过唤醒时间，重启后定时器扫描照常唤醒，后续节点派发到重连的 Agent。
		await cp.restart(() => clock.advance(6 * 60_000));
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);
		expect(welcomes()).toBeGreaterThanOrEqual(before + 2);
		const nap = await api.node(runId, "nap");
		const triggeredAt = nap.outputs?.triggered_at as string;
		expect(Date.parse(triggeredAt)).toBeGreaterThanOrEqual(Date.parse(wakeAt));
		expect((await api.node(runId, "done")).outputs).toEqual({ text: triggeredAt });
		expect(await readFile(ready, "utf8")).toBe("1\n");
	}, 120_000);
});
