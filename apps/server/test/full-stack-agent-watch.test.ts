// 全栈（#201，ADR 0019）：真实的控制面、两台真实 Rust Agent（同一台机器、不同的主目录和端口）和 SDK 执行器。
// fw-runner 上的节点用 ctx.agent(source).files.watch 监听 fw-source 上的日志目录，调用路径是 SDK → fw-runner → fw-source，
// 数据不经过控制面。模拟一次日志轮转：节点先收到快照，再收到改名、新建、写完关闭的事件。
// 节点包是 testdata/agent-files-package（sfly_agent_files.watch）。
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentPair, startAgentPair } from "./support/agent-pair.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { publishTestPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PACKAGE = "sfly-agent-files";

describe("全栈：Agent 能力 files.watch", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let pair: AgentPair;
	let dir: string;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishTestPackage(cp, "testdata/agent-files-package", `${PACKAGE}-0.1.0.sflypkg`);
		pair = await startAgentPair({ grpcUrl: cp.grpcUrl, runner: "fw-runner", source: "fw-source" });
		dir = await mkdtemp(join(tmpdir(), "sfly-agent-watch-"));
	}, 600_000);

	afterAll(async () => {
		await pair?.close();
		await cp?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("fw-runner 上的节点监听 fw-source 上的日志目录：先收到快照，日志轮转时收到改名、新建和写完关闭", async () => {
		// fw-source 上的日志目录；两台 Agent 在同一台机器上，绝对路径相同。
		const logs = join(dir, "logs");
		const ready = join(dir, "ready");
		await mkdir(logs);
		await writeFile(join(logs, "app.log"), "current\n");
		await writeFile(join(logs, "notes.txt"), "not a log\n");
		const current = Number((await stat(join(logs, "app.log"), { bigint: true })).ino);

		const id = await api.orchestrationWith({
			default_agent: "fw-runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{
					id: "n",
					kind: "package",
					package: PACKAGE,
					node: "watch_until",
					inputs: {
						source: "fw-source",
						directory: logs,
						pattern: "app.log*",
						stop: "app.log.stop",
						ready,
					},
				},
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: { [PACKAGE]: "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		// 节点收到快照后新建 ready（它在 fw-runner 上运行，也是这台机器）。
		await eventually(async () => expect((await stat(ready)).isFile()).toBe(true), 120_000);

		// 轮转：app.log → app.log.1，新建 app.log 写一行后关闭，最后新建 app.log.stop 让节点结束。
		await rename(join(logs, "app.log"), join(logs, "app.log.1"));
		await writeFile(join(logs, "app.log"), "fresh\n");
		await writeFile(join(logs, "notes.txt"), "still not a log\n");
		await writeFile(join(logs, "app.log.stop"), "");

		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			60_000,
		);
		const node = await api.node(runId, "n");
		expect(node.status, JSON.stringify(node.error)).toBe("success");
		const outputs = node.outputs as {
			snapshots: { files: string[]; missed: boolean }[];
			events: { kind: string; path: string; old_path: string | null; inode: number }[];
		};
		expect(outputs.snapshots).toEqual([{ files: [join(logs, "app.log")], missed: false }]);
		const fresh = Number((await stat(join(logs, "app.log"), { bigint: true })).ino);
		expect(outputs.events).toEqual([
			{
				kind: "moved",
				path: join(logs, "app.log.1"),
				old_path: join(logs, "app.log"),
				inode: current,
			},
			{ kind: "created", path: join(logs, "app.log"), old_path: null, inode: fresh },
			{ kind: "modified", path: join(logs, "app.log"), old_path: null, inode: fresh },
			{ kind: "closed", path: join(logs, "app.log"), old_path: null, inode: fresh },
			{
				kind: "created",
				path: join(logs, "app.log.stop"),
				old_path: null,
				inode: Number((await stat(join(logs, "app.log.stop"), { bigint: true })).ino),
			},
		]);
	}, 240_000);
});
