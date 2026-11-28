// 验收场景 S2 并行（docs/SEMANTICS.md §8）：真实的控制面、真实的 Rust Agent、真实的 SDK 执行器和桩节点包。
// 异步任务节点触发子流程，主链不等待；子流程嵌套 2 层；子流程失败不影响主链；运行等待所有链结束；
// 停止子流程节点停止嵌套子流程（被停止的节点收到 Cancelled、finally 照常执行，always 清理照常执行，运行记为成功）。
// 「让子流程停在某处」靠桩节点包的闸门节点：测试写放行文件才让它结束，不依赖真实等待。
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logsApi } from "@sfly/schema";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chainOf, nodeOf, orchestration, statuses, stub } from "./support/acceptance.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { makeTempDir } from "./support/temp-dir.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describeWithAgent("验收 S2：并行", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let dir: string;

	beforeAll(async () => {
		dir = await makeTempDir("sfly-s2-");
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv()]);
		await publishStubPackage(cp);
		agent = await startRealAgent({ grpcUrl: cp.grpcUrl, name: "s2-agent", venv: venv.path, bin });
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("主链触发两层子流程后不等待；孙子流程失败不影响主链和子流程；子流程的闸门放行后运行才结束", async () => {
		const api = new ApiClient(cp);
		const file = (name: string) => join(dir, name);
		const read = (name: string) => readFile(file(name), "utf8").catch(() => "");
		const id = await api.orchestrationWith(
			orchestration(
				"s2-agent",
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [{ name: "tag", type: "string", required: true }],
						},
						stub("mark", "echo", { text: "main-${{ params.tag }}" }),
						{ id: "spawn1", kind: "async", params: { x: "${{ nodes.mark.outputs.text }}" } },
						stub("after_spawn", "echo", { text: "after-${{ params.tag }}" }),
					],
					[
						{
							id: "sub1",
							kind: "subflow_entry",
							params: [{ name: "x", type: "string", required: true }],
						},
						stub("s1", "echo", { text: "${{ params.x }}/1" }),
						{ id: "spawn2", kind: "async", params: { y: "${{ nodes.s1.outputs.text }}" } },
						// 子流程停在这里，等测试放行。
						stub("hold", "gate", {
							ready_file: file("hold-ready"),
							release_file: file("hold-release"),
						}),
						stub("s1_done", "echo", { text: "released ${{ nodes.hold.outputs.attempt }}" }),
					],
					[
						{
							id: "sub2",
							kind: "subflow_entry",
							params: [{ name: "y", type: "string", required: true }],
						},
						stub("s2", "echo", { text: "${{ params.y }}/2" }),
						stub("s2_fail", "outcome", { succeed: false, message: "孙子流程失败" }),
						stub("s2_after", "echo", { text: "不应执行" }),
					],
				],
				[
					["spawn1", "sub1"],
					["spawn2", "sub2"],
				],
			),
		);
		const runId = await api.triggerOk(id, { tag: "T" });

		// 主链结束、孙子流程失败、子流程停在闸门上：运行仍在进行。
		await eventually(async () => {
			const run = await api.run(runId);
			expect(chainOf(run, "entry").status).toBe("success");
			expect(chainOf(run, "sub2").status).toBe("failed");
			// hold-ready 由节点代码写出，控制面可能还没处理 TaskStarted（仍是 dispatched），所以也要等。
			expect(await read("hold-ready")).not.toBe("");
			expect(nodeOf(chainOf(run, "sub1"), "hold").status).toBe("running");
		}, 60_000);
		let run = await api.run(runId);
		expect(run.status).toBe("running");
		expect(run.ended_at).toBeNull();
		const main = chainOf(run, "entry");
		const sub1 = chainOf(run, "sub1");
		const sub2 = chainOf(run, "sub2");

		// 主链：异步任务节点立即成功并输出子流程实例 ID，后面的节点不等子流程。
		expect(statuses(main)).toEqual({
			entry: "success",
			mark: "success",
			spawn1: "success",
			after_spawn: "success",
		});
		expect(nodeOf(main, "spawn1").outputs).toEqual({ chain_instance_id: sub1.id });
		expect(nodeOf(main, "after_spawn").outputs).toEqual({ text: "after-T" });

		// 两层嵌套，参数按值传入。
		expect(sub1).toMatchObject({
			depth: 1,
			parent_chain_instance_id: main.id,
			async_node_id: "spawn1",
			status: "running",
			params: { x: "main-T" },
		});
		expect(sub2).toMatchObject({
			depth: 2,
			parent_chain_instance_id: sub1.id,
			async_node_id: "spawn2",
			status: "failed",
			params: { y: "main-T/1" },
		});
		expect(nodeOf(sub1, "spawn2").outputs).toEqual({ chain_instance_id: sub2.id });
		expect(statuses(sub1)).toEqual({
			sub1: "success",
			s1: "success",
			spawn2: "success",
			hold: "running",
			s1_done: "pending",
		});
		expect(statuses(sub2)).toEqual({
			sub2: "success",
			s2: "success",
			s2_fail: "failed",
			s2_after: "skipped",
		});
		expect(nodeOf(sub2, "s2").outputs).toEqual({ text: "main-T/1/2" });
		expect(nodeOf(sub2, "s2_fail").error?.kind).toBe("node_error");

		// 放行闸门：子流程继续，最后一条链结束后运行才结束；孙子流程失败 → 运行 failed，主链仍是 success。
		await writeFile(file("hold-release"), "");
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 60_000);
		run = await api.run(runId);
		expect(run.ended_at).not.toBeNull();
		expect(chainOf(run, "entry").status).toBe("success");
		const done = chainOf(run, "sub1");
		expect(done.status).toBe("success");
		expect(nodeOf(done, "hold").outputs).toEqual({ attempt: 1 });
		expect(nodeOf(done, "s1_done").outputs).toEqual({ text: "released 1" });
	}, 120_000);

	it("压测结束后停止监控：嵌套的两层子流程一起停止，节点里收到 Cancelled、finally 清理执行，always 清理照常执行，运行成功", async () => {
		const api = new ApiClient(cp);
		const file = (name: string) => join(dir, name);
		const read = (name: string) => readFile(file(name), "utf8").catch(() => "");
		const id = await api.orchestrationWith(
			orchestration(
				"s2-agent",
				[
					[
						{ id: "entry", kind: "entry" },
						{ id: "spawn_mon", kind: "async", params: {} },
						// 「压测」：等测试放行才结束，确保停止时两个监控节点都在运行。
						stub("load", "gate", {
							ready_file: file("load-ready"),
							release_file: file("load-release"),
						}),
						{ id: "stop_mon", kind: "stop_subflow", subflow: "mon", always: true },
						stub("report", "echo", { text: "监控=${{ nodes.stop_mon.outputs.status }}" }),
					],
					[
						{ id: "mon", kind: "subflow_entry", name: "监控", params: [] },
						{ id: "spawn_logs", kind: "async", params: {} },
						stub("watch", "wait_cancel", {
							ready_file: file("watch-ready"),
							report_file: file("watch-report"),
						}),
						stub("watch_after", "echo", { text: "不应执行" }),
						// 子流程自己的 always 清理：同样等测试放行，用来确认停止子流程节点等它结束。
						stub(
							"tidy",
							"gate",
							{ ready_file: file("tidy-ready"), release_file: file("tidy-release") },
							{ always: true },
						),
					],
					[
						{ id: "logs", kind: "subflow_entry", name: "日志", params: [] },
						stub("tail", "wait_cancel", {
							ready_file: file("tail-ready"),
							report_file: file("tail-report"),
						}),
						stub("tail_after", "echo", { text: "不应执行" }),
					],
				],
				[
					["spawn_mon", "mon"],
					["spawn_logs", "logs"],
				],
			),
		);
		const runId = await api.triggerOk(id);

		// 压测和两层监控同时在跑。
		await eventually(async () => {
			expect(await read("load-ready")).not.toBe("");
			expect(await read("watch-ready")).not.toBe("");
			expect(await read("tail-ready")).not.toBe("");
		}, 60_000);
		// 就绪文件由节点代码写出，控制面可能还没处理 TaskStarted（仍是 dispatched），所以节点的状态也要等。
		let run = await api.run(runId);
		await eventually(async () => {
			run = await api.run(runId);
			expect(run.status).toBe("running");
			expect(nodeOf(chainOf(run, "mon"), "watch").status).toBe("running");
			expect(nodeOf(chainOf(run, "logs"), "tail").status).toBe("running");
		}, 30_000);

		// 压测结束 → 停止子流程「监控」：它和它触发的「日志」一起停止。
		// 被停止的节点在节点代码里收到 Cancelled，finally 里的清理照常执行；子流程的 always 清理照常开始。
		await writeFile(file("load-release"), "");
		await eventually(async () => {
			expect(await read("watch-report")).toBe("cancelled");
			expect(await read("tail-report")).toBe("cancelled");
			expect(await read("tidy-ready")).not.toBe("");
		}, 60_000);
		await eventually(async () => {
			const r = await api.run(runId);
			expect(chainOf(r, "logs").status).toBe("success");
			expect(nodeOf(chainOf(r, "mon"), "watch").status).toBe("stopped");
			// tidy-ready 由节点代码写出，控制面可能还没处理 TaskStarted（仍是 dispatched），所以也要等。
			expect(nodeOf(chainOf(r, "mon"), "tidy").status).toBe("running");
		}, 30_000);
		// always 清理还没结束：停止子流程节点仍在等待，主链停在这里。
		run = await api.run(runId);
		expect(run.status).toBe("running");
		expect(chainOf(run, "mon").status).toBe("running");
		expect(statuses(chainOf(run, "entry"))).toMatchObject({
			stop_mon: "waiting",
			report: "pending",
		});

		// 清理结束 → 子流程结束 → 停止子流程节点成功，主链继续，运行成功。
		await writeFile(file("tidy-release"), "");
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);

		run = await api.run(runId);
		expect(run.ended_at).not.toBeNull();
		const main = chainOf(run, "entry");
		const mon = chainOf(run, "mon");
		const logs = chainOf(run, "logs");
		expect(statuses(main)).toEqual({
			entry: "success",
			spawn_mon: "success",
			load: "success",
			stop_mon: "success",
			report: "success",
		});
		expect(statuses(mon)).toEqual({
			mon: "success",
			spawn_logs: "success",
			watch: "stopped",
			watch_after: "stopped",
			tidy: "success",
		});
		expect(statuses(logs)).toEqual({ logs: "success", tail: "stopped", tail_after: "stopped" });
		// 停止不算失败：两条子流程都记为成功，名称照常显示。
		expect(mon).toMatchObject({ status: "success", name: "监控", depth: 1 });
		expect(logs).toMatchObject({ status: "success", name: "日志", depth: 2 });
		expect(main.status).toBe("success");

		// 停止子流程节点输出子流程的最终结果，后面的节点可以引用。
		expect(nodeOf(main, "stop_mon").outputs).toEqual({ status: "success" });
		expect(nodeOf(main, "report").outputs).toEqual({ text: "监控=success" });

		// 被停止是正常终止，不是节点出错：被停止的监控类节点的日志里没有堆栈、没有 WARN 和 ERROR 级的行
		// （概览的「其他警告与错误」不会因它出现），只有一行 INFO 写明被终止。
		for (const node of [nodeOf(mon, "watch"), nodeOf(logs, "tail")]) {
			const taskId = node.attempts[0]?.task_id ?? "";
			const page = logsApi.page.response.parse(
				await api.getJson(`/tasks/${encodeURIComponent(taskId)}/logs`),
			);
			expect(page.lines.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
			expect(page.lines.filter((l) => l.text.includes("Traceback"))).toEqual([]);
			expect(page.lines.filter((l) => l.text.includes("被终止")).map((l) => l.level)).toEqual([
				"info",
			]);
		}
	}, 120_000);
});
