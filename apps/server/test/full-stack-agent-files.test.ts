// 全栈（#198，ADR 0019）：真实的控制面、两台真实 Rust Agent（同一台机器、不同的主目录和端口）和 SDK 执行器。
// fs-runner 上的节点用 ctx.agent(source) 列出、查看 fs-source 上的文件，调用路径是 SDK → fs-runner → fs-source，
// 数据不经过控制面；ctx.agent() 对 fs-runner 自己有相同的结果。另外覆盖：只能访问参数里选的 Agent、连不通时写明
// 从哪台到哪台和地址端口、超时、运行被取消时调用立即结束，以及联调（sfly dev 装到 fs-runner 的开发版本）。
// 节点包是 testdata/agent-files-package。
import { execFile } from "node:child_process";
import {
	cp as copy,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { logsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./support/agent-binary.js";
import {
	type AgentPair,
	type BrokenPeers,
	registerBrokenPeers,
	startAgentPair,
} from "./support/agent-pair.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { publishTestPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PACKAGE = "sfly-agent-files";

/** 节点看到的文件属性（testdata/agent-files-package 的 _info）。 */
async function expected(path: string) {
	const s = await stat(path, { bigint: true });
	return {
		path,
		size: Number(s.size),
		mtime_ns: Number(s.mtimeNs),
		device: Number(s.dev),
		inode: Number(s.ino),
	};
}

describe("全栈：Agent 能力 files", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let pair: AgentPair;
	let broken: BrokenPeers;
	let logs: string;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishTestPackage(cp, "testdata/agent-files-package", `${PACKAGE}-0.1.0.sflypkg`);
		pair = await startAgentPair({
			grpcUrl: cp.grpcUrl,
			runner: "fs-runner",
			source: "fs-source",
			// sfly dev 装开发版本时不访问外网：节点包没有依赖，给一个不存在的镜像。
			runnerArgs: ["--index-url", "http://127.0.0.1:9/simple/"],
		});
		broken = await registerBrokenPeers(cp.grpcUrl, { gone: "fs-gone", silent: "fs-silent" });
		// fs-source 上的日志目录（两台 Agent 在同一台机器上，绝对路径相同）。
		logs = await mkdtemp(join(tmpdir(), "sfly-agent-files-"));
		await mkdir(join(logs, "old"));
		await writeFile(join(logs, "app.log"), "current\n");
		await writeFile(join(logs, "app.log.1"), "rotated once\n");
		await writeFile(join(logs, "notes.txt"), "not a log\n");
		await writeFile(join(logs, "old", "app.log.2"), "rotated twice\n");
	}, 600_000);

	afterAll(async () => {
		await broken?.close();
		await pair?.close();
		await cp?.close();
		if (logs) await rm(logs, { recursive: true, force: true });
	});

	/** 在 fs-runner 上运行一个节点（`source` 等参数来自入口参数），等运行结束，返回这个节点。 */
	const runNode = async (
		node: string,
		inputs: Record<string, unknown>,
		options: { version?: string; until?: string[] } = {},
	) => {
		const id = await api.orchestrationWith({
			default_agent: "fs-runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{
					id: "n",
					kind: "package",
					package: options.version ? `${PACKAGE}-dev` : PACKAGE,
					node,
					inputs,
				},
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: options.version ? { [`${PACKAGE}-dev`]: options.version } : { [PACKAGE]: "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		await eventually(
			async () =>
				expect(options.until ?? ["success", "failed"]).toContain((await api.run(runId)).status),
			60_000,
		);
		return { runId, node: await api.node(runId, "n") };
	};

	it("fs-runner 上的节点列出、查看 fs-source 上的文件；ctx.agent() 对自己所在的 Agent 结果相同", async () => {
		const remote = await runNode("list_files", {
			source: "fs-source",
			directory: logs,
			pattern: "app.log*",
			recursive: true,
		});
		expect(remote.node.status, JSON.stringify(remote.node.error)).toBe("success");
		const names = ["app.log", "app.log.1", "old/app.log.2"];
		const files = await Promise.all(names.map((n) => expected(join(logs, n))));
		expect(remote.node.outputs).toEqual({ files });

		const own = await runNode("list_files", {
			directory: logs,
			pattern: "app.log*",
			recursive: true,
		});
		expect(own.node.outputs).toEqual({ files });

		const one = await runNode("stat_file", { source: "fs-source", path: join(logs, "app.log") });
		expect(one.node.outputs).toEqual({ file: await expected(join(logs, "app.log")) });
	}, 180_000);

	const tryStat = async (inputs: Record<string, unknown>) => {
		const { node } = await runNode("try_stat", inputs);
		expect(node.status, JSON.stringify(node.error)).toBe("success");
		return (node.outputs as { error: Record<string, unknown> | null }).error;
	};

	it("访问没有通过参数拿到的 Agent、文件不存在、连不通、超时：错误可区分，连不通时写明两端和地址端口", async () => {
		expect(await tryStat({ source: "fs-source", name: "fs-gone", path: "/" })).toMatchObject({
			type: "AgentNotReferenced",
			kind: "not_referenced",
			agent: "fs-gone",
		});

		expect(await tryStat({ source: "fs-source", path: join(logs, "gone.log") })).toEqual({
			type: "AgentFileNotFound",
			kind: "not_found",
			agent: "fs-source",
			message: `Agent fs-source：${join(logs, "gone.log")} 不存在`,
		});

		const unreachable = await tryStat({ source: "fs-gone", path: "/" });
		expect(unreachable).toMatchObject({
			type: "AgentUnreachable",
			kind: "unreachable",
			agent: "fs-gone",
		});
		expect(unreachable?.message).toMatch(
			new RegExp(
				`^从 Agent fs-runner 连不上 Agent fs-gone（地址 127\\.0\\.0\\.1，端口 ${broken.gonePort}）：`,
			),
		);

		expect(await tryStat({ source: "fs-silent", path: "/", timeout: 1 })).toMatchObject({
			type: "AgentTimeout",
			kind: "timeout",
			agent: "fs-silent",
		});
	}, 180_000);

	it("运行被取消时，等着另一台 Agent 回应的调用立即结束并抛出取消", async () => {
		const id = await api.orchestrationWith({
			default_agent: "fs-runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{
					id: "n",
					kind: "package",
					package: PACKAGE,
					node: "wait_stat",
					inputs: { source: "fs-silent", path: "/" },
				},
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: { [PACKAGE]: "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		const lines = async () => {
			const taskId = (await api.node(runId, "n")).attempts[0]?.task_id;
			if (!taskId) return [];
			const page = logsApi.page.response.parse(
				await api.getJson(`/tasks/${encodeURIComponent(taskId)}/logs`),
			);
			return page.lines.map((l) => l.text);
		};
		await eventually(async () => expect(await lines()).toContain("开始调用"), 60_000);

		await api.cancelOk(runId);
		await eventually(async () => expect((await api.run(runId)).status).toBe("cancelled"), 30_000);
		// 取消在调用里抛出 Cancelled，节点的 except 照常执行：调用没有拖住它。
		expect(await lines()).toContain("调用被取消");
	}, 180_000);

	it("联调：sfly dev 装到 fs-runner 的开发版本也能访问 fs-source", async () => {
		// 开发版本用另一个包名，不和已发布的 sfly-agent-files 在共享 venv 里互相替换。
		const project = await mkdtemp(join(tmpdir(), "sfly-agent-files-dev-"));
		try {
			await copy(join(repoRoot, "testdata/agent-files-package"), project, { recursive: true });
			await rename(
				join(project, "src/sfly_agent_files"),
				join(project, "src/sfly_agent_files_dev"),
			);
			const pyproject = join(project, "pyproject.toml");
			await writeFile(
				pyproject,
				(await readFile(pyproject, "utf8")).replace(
					`name = "${PACKAGE}"`,
					`name = "${PACKAGE}-dev"`,
				),
			);
			await promisify(execFile)(
				"uv",
				[
					"run",
					"--locked",
					"--quiet",
					"sfly",
					"dev",
					project,
					"--socket",
					join(pair.runner.workDir, "tasks", "agent.sock"),
				],
				{ cwd: repoRoot },
			);
			await eventually(async () => {
				const { agents } = await api.getJson<{
					agents: Array<{ name: string; dev_packages: Array<{ name: string }> }>;
				}>("/agents");
				expect(agents.find((a) => a.name === "fs-runner")?.dev_packages).toMatchObject([
					{ name: `${PACKAGE}-dev` },
				]);
			});

			const { node } = await runNode(
				"stat_file",
				{ source: "fs-source", path: join(logs, "notes.txt") },
				{ version: "dev" },
			);
			expect(node.status, JSON.stringify(node.error)).toBe("success");
			expect(node.outputs).toEqual({ file: await expected(join(logs, "notes.txt")) });
		} finally {
			await rm(project, { recursive: true, force: true });
		}
	}, 180_000);

	it("节点包声明的最低 Agent 版本：预检对节点所在的 Agent 和引用的 Agent 都检查，写明是哪台、需要哪个版本", async () => {
		const project = await mkdtemp(join(tmpdir(), "sfly-agent-files-req-"));
		try {
			await copy(join(repoRoot, "testdata/agent-files-package"), project, { recursive: true });
			const pyproject = join(project, "pyproject.toml");
			await writeFile(
				pyproject,
				`${(await readFile(pyproject, "utf8")).replace('version = "0.1.0"', 'version = "0.2.0"')}\n[tool.sfly]\nrequires-agent = ">=99"\n`,
			);
			await publishTestPackage(cp, project, `${PACKAGE}-0.2.0.sflypkg`);
		} finally {
			await rm(project, { recursive: true, force: true });
		}
		const id = await api.orchestrationWith({
			default_agent: "fs-runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{
					id: "n",
					kind: "package",
					package: PACKAGE,
					node: "stat_file",
					inputs: { source: "fs-source", path: "/" },
				},
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: { [PACKAGE]: "0.2.0" },
		});
		const { problems } = await api.getJson<{ problems: Array<{ code: string; message: string }> }>(
			`/orchestrations/${id}/preflight`,
		);
		const version = cp.version;
		expect(problems).toEqual([
			{
				code: "agent_version_unsatisfied",
				node_id: "n",
				message: `节点 n：节点包 ${PACKAGE}@0.2.0 需要 Agent >=99，节点所在的 Agent fs-runner 会先自更新到控制面的版本 ${version}：请升级控制面`,
			},
			{
				code: "agent_version_unsatisfied",
				node_id: "n",
				message: `节点 n：节点包 ${PACKAGE}@0.2.0 需要 Agent >=99，参数 source 选的 Agent fs-source 的版本是 ${version}：请升级 Agent fs-source`,
			},
		]);
		expect((await api.trigger(id)).status).toBe(400);
	}, 180_000);
});
