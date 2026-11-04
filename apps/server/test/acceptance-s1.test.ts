// 验收场景 S1 数据流（docs/SEMANTICS.md §8）：真实的控制面、两个真实的 Rust Agent、真实的 SDK 执行器和桩节点包。
// 入口参数传递；跨 Agent 引用上游输出；产物上传和引用；A 启动进程 → B 失败 → C（always）清理进程。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainOf, isAlive, nodeOf, orchestration, statuses, stub } from "./support/acceptance.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("验收 S1：数据流", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agents: RealAgent[] = [];
	const daemons: number[] = [];

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv()]);
		await publishStubPackage(cp);
		agents = await Promise.all(
			["s1-a", "s1-b"].map((name) =>
				startRealAgent({ grpcUrl: cp.grpcUrl, name, venv: venv.path, bin }),
			),
		);
	}, 600_000);

	afterAll(async () => {
		for (const pid of daemons) if (isAlive(pid)) process.kill(pid, "SIGKILL");
		await Promise.all(agents.map((a) => a.close()));
		await cp?.close();
		await venv?.remove();
	});

	it("参数与输出跨 Agent 传递、产物上传后被下游下载；B 失败后普通节点跳过，always 节点清理 A 启动的进程", async () => {
		const api = new ApiClient(cp);
		const onB = { agent: "s1-b" };
		const id = await api.orchestrationWith(
			orchestration("s1-a", [
				[
					{
						id: "entry",
						kind: "entry",
						params: [
							{ name: "who", type: "string", required: true },
							{ name: "ok", type: "boolean", default: true },
						],
					},
					stub("greet", "echo", { text: "你好，${{ params.who }}" }),
					stub("relay", "echo", { text: "${{ nodes.greet.outputs.text }}！" }, onB),
					stub("save", "artifacts", {
						files: { "问候/greeting.txt": "${{ nodes.relay.outputs.text }}" },
					}),
					stub("fetch", "download", { urls: "${{ nodes.save.outputs.refs }}" }, onB),
					stub("start", "start_process"),
					stub("boom", "outcome", { succeed: "${{ params.ok }}", message: "B 按参数失败" }, onB),
					stub("after", "echo", { text: "不应执行" }),
					stub(
						"cleanup",
						"stop_process",
						{ pid: "${{ nodes.start.outputs.pid }}" },
						{
							always: true,
						},
					),
				],
			]),
		);

		const runId = await api.triggerOk(id, { who: "世界", ok: false });
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 60_000);
		const main = chainOf(await api.run(runId), "entry");
		const pid = nodeOf(main, "start").outputs?.pid as number;
		if (typeof pid === "number") daemons.push(pid);

		expect(statuses(main)).toEqual({
			entry: "success",
			greet: "success",
			relay: "success",
			save: "success",
			fetch: "success",
			start: "success",
			boom: "failed",
			after: "skipped",
			cleanup: "success",
		});

		// 入口参数传递、跨 Agent 引用上游输出（内嵌引用拼接字符串）。
		expect(nodeOf(main, "greet")).toMatchObject({ agent: "s1-a", outputs: { text: "你好，世界" } });
		const relay = nodeOf(main, "relay");
		expect(relay).toMatchObject({ agent: "s1-b", outputs: { text: "你好，世界！" } });
		expect(relay.attempts[0]?.inputs).toEqual({ text: "你好，世界！" });

		// 产物：s1-a 上保存并在结果前上传，引用交给 s1-b 上的节点下载；控制面上也能下载。
		const save = nodeOf(main, "save");
		const refs = save.outputs?.refs as Record<string, string>;
		expect(Object.keys(refs)).toEqual(["问候/greeting.txt"]);
		const listed = (await (
			await cp.fetch(`/tasks/${save.attempts[0]?.task_id}/artifacts`)
		).json()) as { artifacts: Array<{ name: string; url: string }> };
		expect(listed.artifacts.map((a) => [a.name, a.url])).toEqual(Object.entries(refs));
		const fetched = nodeOf(main, "fetch");
		expect(fetched.agent).toBe("s1-b");
		expect(fetched.attempts[0]?.inputs).toEqual({ urls: refs });
		expect(fetched.outputs).toEqual({ texts: { "问候/greeting.txt": "你好，世界！" } });
		expect(await (await fetch(refs["问候/greeting.txt"] as string)).text()).toBe("你好，世界！");

		// A 启动的常驻进程在节点结束后继续存活，直到 always 节点 C 把它清理掉。
		const boom = nodeOf(main, "boom");
		expect(boom.attempts[0]?.inputs).toMatchObject({ succeed: false });
		expect(boom.error?.kind).toBe("node_error");
		expect(boom.error?.message).toMatch(/^RuntimeError: B 按参数失败/);
		expect(nodeOf(main, "after").attempts).toEqual([]);
		const cleanup = nodeOf(main, "cleanup");
		expect(cleanup.attempts[0]?.inputs).toEqual({ pid });
		expect(cleanup.outputs).toEqual({ was_running: true });
		expect(isAlive(pid)).toBe(false);
	}, 120_000);

	it("同一编排按参数成功时，B 成功、普通节点执行，always 节点照样清理", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith(
			orchestration("s1-a", [
				[
					{ id: "entry", kind: "entry", params: [{ name: "ok", type: "boolean", default: true }] },
					stub("start", "start_process"),
					stub("boom", "outcome", { succeed: "${{ params.ok }}" }, { agent: "s1-b" }),
					stub("after", "echo", { text: "执行了" }),
					stub(
						"cleanup",
						"stop_process",
						{ pid: "${{ nodes.start.outputs.pid }}" },
						{
							always: true,
						},
					),
				],
			]),
		);
		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		const main = chainOf(await api.run(runId), "entry");
		const pid = nodeOf(main, "start").outputs?.pid as number;
		daemons.push(pid);
		expect(nodeOf(main, "boom").outputs).toEqual({ ok: true });
		expect(nodeOf(main, "after").outputs).toEqual({ text: "执行了" });
		expect(nodeOf(main, "cleanup").outputs).toEqual({ was_running: true });
		expect(isAlive(pid)).toBe(false);
	}, 120_000);
});
