// 全栈（#204，ADR 0019）：真实的控制面、两台真实 Rust Agent（同一台机器、不同的主目录和端口）和 SDK 执行器。
// ex-runner 上的节点用 ctx.agent(source).exec.run 在 ex-source 上执行命令：拿到退出码，命令的输出逐行进入 ex-runner 上
// 这个任务的日志并标明来自 ex-source；ctx.agent() 对 ex-runner 自己同样可用。命令不占 ex-source 的槽位、不产生任务；
// 超时、运行被取消时命令连同它的子进程一起结束。节点包是 testdata/agent-files-package（commands.py）。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsApi, logsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentPair, startAgentPair } from "./support/agent-pair.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { publishTestPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PACKAGE = "sfly-agent-files";

/** 一棵进程树：sh 在后台启动 sleep，把两者的 PID 写进 $PIDS，然后等它。 */
const TREE = 'sleep 300 & echo $! >> "$PIDS"; echo $$ >> "$PIDS"; echo started; wait';

/** 进程是否还活着（僵尸进程算已经结束）。 */
async function alive(pid: number): Promise<boolean> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 1).trim()[0];
		return state !== "Z" && state !== "X";
	} catch {
		return false;
	}
}

async function pidsIn(path: string): Promise<number[]> {
	try {
		return (await readFile(path, "utf8")).split(/\s+/).filter(Boolean).map(Number);
	} catch {
		return [];
	}
}

describe("全栈：Agent 能力 exec", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let pair: AgentPair;
	let dir: string;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishTestPackage(cp, "testdata/agent-files-package", `${PACKAGE}-0.1.0.sflypkg`);
		pair = await startAgentPair({ grpcUrl: cp.grpcUrl, runner: "ex-runner", source: "ex-source" });
		dir = await mkdtemp(join(tmpdir(), "sfly-agent-exec-"));
	}, 600_000);

	afterAll(async () => {
		await pair?.close();
		await cp?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	/** 在 ex-runner 上触发一个只有 run_command 节点的运行，返回运行 ID。 */
	const trigger = async (inputs: Record<string, unknown>) => {
		const id = await api.orchestrationWith({
			default_agent: "ex-runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{ id: "n", kind: "package", package: PACKAGE, node: "run_command", inputs },
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: { [PACKAGE]: "0.1.0" },
		});
		return api.triggerOk(id);
	};

	/** 运行一次，等它结束，返回运行 ID 和节点成功结束时的输出。 */
	const runCommand = async (inputs: Record<string, unknown>) => {
		const runId = await trigger(inputs);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			60_000,
		);
		const n = await api.node(runId, "n");
		expect(n.status, JSON.stringify(n.error)).toBe("success");
		return { runId, outputs: n.outputs as Record<string, unknown> };
	};

	/** 节点 n 的第一个任务的日志：[来源, 文本]。 */
	const logsOf = async (runId: string) => {
		const taskId = (await api.node(runId, "n")).attempts[0]?.task_id;
		if (!taskId) return [];
		const page = logsApi.page.response.parse(
			await api.getJson(`/tasks/${encodeURIComponent(taskId)}/logs`),
		);
		return page.lines.map((l) => [l.source, l.text]);
	};

	const sourceSlots = async () => {
		const listed = agentsApi.list.response.parse(await api.getJson("/agents")).agents;
		return listed.find((a) => a.name === "ex-source")?.running_tasks;
	};

	it("ex-runner 上的节点在 ex-source 上执行命令，拿到退出码，输出进入自己的日志并标明来自 ex-source", async () => {
		const { runId, outputs } = await runCommand({
			source: "ex-source",
			command: 'echo "out $GREETING"; echo err >&2; pwd; exit 7',
			cwd: dir,
			env: { GREETING: "你好" },
		});
		expect(outputs).toEqual({ exit_code: 7, error: null });
		await eventually(async () =>
			expect(await logsOf(runId)).toEqual(
				expect.arrayContaining([
					["stdout", "[Agent ex-source] out 你好"],
					["stderr", "[Agent ex-source] err"],
					["stdout", `[Agent ex-source] ${dir}`],
				]),
			),
		);

		// 自己所在的 Agent 同样可以执行。
		const own = await runCommand({ argv: ["sh", "-c", "echo own; exit 0"] });
		expect(own.outputs).toEqual({ exit_code: 0, error: null });
		await eventually(async () =>
			expect(await logsOf(own.runId)).toContainEqual(["stdout", "[Agent ex-runner] own"]),
		);
	}, 240_000);

	it("超过超时时命令连同子进程一起结束，节点得到超时；命令运行期间 ex-source 的槽位占用不变", async () => {
		const pids = join(dir, "timeout-pids");
		const runId = await trigger({
			source: "ex-source",
			command: TREE,
			timeout: 3,
			env: { PIDS: pids },
		});
		await eventually(async () => expect(await pidsIn(pids)).toHaveLength(2), 60_000);
		expect(await sourceSlots()).toEqual([]);

		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		const n = await api.node(runId, "n");
		expect(n.outputs).toEqual({
			exit_code: null,
			error: {
				type: "AgentTimeout",
				kind: "timeout",
				agent: "ex-source",
				message: "Agent ex-source：命令超过 3 秒没有结束，已结束它的进程树",
			},
		});
		await eventually(async () =>
			expect(await logsOf(runId)).toContainEqual(["stdout", "[Agent ex-source] started"]),
		);
		await eventually(async () => {
			for (const pid of await pidsIn(pids)) expect(await alive(pid)).toBe(false);
		});
	}, 240_000);

	it("运行被取消时，ex-source 上的命令连同子进程一起结束", async () => {
		const pids = join(dir, "cancel-pids");
		const runId = await trigger({
			source: "ex-source",
			command: TREE,
			timeout: 600,
			env: { PIDS: pids },
		});
		await eventually(async () => expect(await pidsIn(pids)).toHaveLength(2), 60_000);
		const tree = await pidsIn(pids);
		for (const pid of tree) expect(await alive(pid)).toBe(true);

		await api.cancelOk(runId);
		await eventually(async () => expect((await api.run(runId)).status).toBe("cancelled"), 30_000);
		await eventually(async () => {
			for (const pid of tree) expect(await alive(pid)).toBe(false);
		});
	}, 240_000);
});
