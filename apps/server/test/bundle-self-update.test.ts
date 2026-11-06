// 跨版本自更新（ADR 0014）：上一个 Release 的 Agent 在当前打包后的控制面上跑完手上的任务、结果被 Ack 后
// 自更新到当前版本，并以当前版本握手。相邻版本之间的会话协议兼容性由这项测试保证。
// 上一个 Release 的 Agent 由 `pnpm fetch:previous-agent`（scripts/release/previous-agent.sh）放到
// SFLY_PREVIOUS_AGENT_DIR；它还不支持自更新（第一个带自更新的版本）时跳过并写明原因。
//
// 过程：
// 1. 「旧控制面」：源码里的控制面以上一个版本号启动（只用来让旧 Agent 接到一个任务，版本一致才会派发）；
//    旧 Agent 装在 $SFLY_HOME/bin（安装脚本的位置，才会自更新），共享 venv 预先装好同版本的 SDK。
// 2. 闸门任务运行中时，换成当前打包的控制面（同一个数据库和数据目录、同样的端口，相当于升级控制面）：
//    旧 Agent 重连，版本不一致，下载新二进制后等待任务结束。
// 3. 放行任务：结果上报并被 Ack 后 Agent 替换自己并 execve（进程号不变），以当前版本握手，然后照常接新任务。
//
// 本地验证「支持自更新」的路径：`pnpm bundle:server && pnpm fetch:previous-agent --simulate`
// 用当前构建的 Agent 扮演上一版本（隐藏的版本覆盖参数），再 `pnpm test:bundle`。
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentView } from "@sfly/schema";
import { afterAll, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { type ControlPlane, startControlPlane } from "../src/control-plane.js";
import { repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { type BundledServer, startBundledServer } from "./support/bundled-server.js";
import { eventually } from "./support/eventually.js";
import { type RealAgent, startRealAgent } from "./support/real-agent.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const run = promisify(execFile);
const bundleDir = process.env.SFLY_BUNDLE_DIR;
const previousDir = process.env.SFLY_PREVIOUS_AGENT_DIR;
const { version } = packageJson;
const NAME = "previous-agent";

/** 上一个 Release 的 Agent；不能测试时给出跳过原因。 */
type Previous = { skip: string } | { bin: string; wheel: string; version: string };

const MISSING = "没有准备上一个 Release 的 Agent：先运行 pnpm fetch:previous-agent";

async function previousAgent(dir: string | undefined): Promise<Previous> {
	if (!dir) return { skip: MISSING };
	const skip = await readFile(join(dir, "skip"), "utf8").catch(() => undefined);
	if (skip !== undefined) return { skip: skip.trim() };
	const previous = await readFile(join(dir, "version"), "utf8").catch(() => undefined);
	if (previous === undefined) return { skip: MISSING };
	const bin = join(dir, "sfly-agent");
	const wheel = (await readdir(dir)).find((f) => f.endsWith(".whl"));
	if (!wheel) throw new Error(`${dir} 里没有 SDK wheel`);
	// 是否支持自更新：问二进制自己。自更新与 --no-auto-update 同时引入（ADR 0014），
	// 不认识这个参数的 Agent 不会自更新；clap 按顺序解析，未知参数先于 --version 报错。
	try {
		await run(bin, ["--no-auto-update", "--version"], { env: { PATH: process.env.PATH } });
	} catch {
		return {
			skip:
				`上一个 Release ${previous.trim()} 的 Agent 还不支持自更新（不认识 --no-auto-update）：` +
				"第一个带自更新的版本没有可比较的旧版本，从下一个版本起生效",
		};
	}
	return { bin, wheel: join(dir, wheel), version: previous.trim() };
}

describe.skipIf(!bundleDir)("上一个 Release 的 Agent 在当前控制面上自更新", () => {
	const cleanups: Array<() => Promise<unknown>> = [];
	afterAll(async () => {
		for (const cleanup of cleanups.reverse()) await cleanup();
	});

	it("跑完手上的任务、结果被 Ack 后自更新，并以当前版本握手", async (ctx) => {
		const previous = await previousAgent(previousDir);
		if ("skip" in previous) {
			// 跳过原因也打到标准错误，CI 日志里一眼能看到。
			console.warn(`跳过跨版本自更新测试：${previous.skip}`);
			// CI 里必须先下载（ci.yml 的 Previous release agent 步骤），不能因为漏了这一步悄悄跳过。
			if (process.env.CI && previous.skip === MISSING) throw new Error(previous.skip);
			ctx.skip(previous.skip);
			return;
		}
		expect(previous.version).not.toBe(version);

		const database: TestDatabase = await createTestDatabase();
		cleanups.push(() => database.drop());
		const [dataDir, sflyHome, scratch] = await Promise.all(
			["data", "home", "scratch"].map((n) => mkdtemp(join(tmpdir(), `sfly-skew-${n}-`))),
		);
		cleanups.push(() =>
			Promise.all(
				[dataDir, sflyHome, scratch].map((d) => rm(d as string, { recursive: true, force: true })),
			),
		);
		const home = sflyHome as string;
		const tmp = scratch as string;

		// 旧 Agent 装在安装脚本的位置；共享 venv 预先装好它的 SDK（「旧控制面」不提供旧版本的 wheel）。
		const installed = join(home, "bin", "sfly-agent");
		await run("install", ["-D", "-m", "0755", previous.bin, installed]);
		const venv = join(home, "venv");
		const pythonVersion = (await readFile(join(repoRoot, ".python-version"), "utf8")).trim();
		await run("uv", ["venv", "--quiet", "--python", pythonVersion, venv]);
		await run("uv", ["pip", "install", "--quiet", "--python", venv, previous.wheel]);

		// 1. 「旧控制面」：当前源码以上一个版本号启动。
		let old: ControlPlane | undefined = await startControlPlane({
			databaseUrl: database.url,
			dataDir: dataDir as string,
			version: previous.version,
			http: { host: "127.0.0.1", port: 0 },
			grpc: { host: "127.0.0.1", port: 0 },
		});
		cleanups.push(async () => old?.close());
		const ports = {
			http: Number(new URL(old.httpUrl).port),
			grpc: Number(new URL(old.grpcUrl).port),
		};
		let httpUrl = old.httpUrl;
		const api = new ApiClient({ fetch: (path, init) => fetch(`${httpUrl}${path}`, init) });

		const out = join(tmp, "pkg");
		await run(
			"uv",
			["run", "--locked", "--quiet", "sfly", "build", "testdata/stub-package", "--out", out],
			{
				cwd: repoRoot,
			},
		);
		const res = await fetch(`${httpUrl}/packages`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: await readFile(join(out, "sfly-stub-0.1.0.sflypkg")),
		});
		expect(res.status).toBe(201);

		// 版本覆盖只给扮演上一版本的本地构建用（--simulate）；真正的旧 Agent 不认识这个环境变量，没有影响。
		const agent: RealAgent = await startRealAgent({
			grpcUrl: old.grpcUrl,
			name: NAME,
			bin: installed,
			venv,
			env: { SFLY_HOME: home, SFLY_VERSION_OVERRIDE: previous.version },
			welcomeTimeoutMs: 120_000,
		});
		cleanups.push(() => agent.close());
		const pid = agent.child.pid;

		const ready = join(tmp, "ready");
		const release = join(tmp, "release");
		/** 入口后只有一个 sfly-stub 节点的编排。 */
		const orchestration = (name: string, node: Record<string, unknown> & { id: string }) =>
			api.orchestrationWith(
				{
					default_agent: NAME,
					nodes: [
						{ id: "entry", kind: "entry" },
						{ kind: "package", package: "sfly-stub", ...node },
					],
					edges: [{ from: "entry", to: node.id, kind: "chain" }],
					packages: { "sfly-stub": "0.1.0" },
				},
				name,
			);
		const gated = await orchestration("gated", {
			id: "g",
			node: "gate",
			inputs: { ready_file: ready, release_file: release, seconds: 600 },
		});
		const runId = await api.triggerOk(gated);
		await eventually(() => access(ready), 120_000);

		// 2. 升级控制面：换成当前打包的控制面，同一个数据库、数据目录和端口。
		await old.close();
		old = undefined;
		const server: BundledServer = await startBundledServer({
			dir: bundleDir as string,
			databaseUrl: database.url,
			dataDir: dataDir as string,
			ports,
		});
		cleanups.push(() => server.stop());
		httpUrl = server.httpUrl;
		const view = async () => {
			const { agents, control_plane_version } = await api.getJson<{
				agents: AgentView[];
				control_plane_version: string;
			}>("/agents");
			expect(control_plane_version).toBe(version);
			const found = agents.find((a) => a.name === NAME);
			if (!found) throw new Error(`没有 Agent ${NAME}`);
			return found;
		};

		// 旧 Agent 重连：版本不一致，先下载新二进制，再等手上的任务结束。
		await eventually(async () => {
			const a = await view();
			expect([a.status, a.info.agent_version, a.version_mismatch]).toEqual([
				"online",
				previous.version,
				true,
			]);
			expect(a.update).toEqual({ state: "waiting_for_tasks", remaining_tasks: 1, reason: "" });
		}, 120_000);
		expect((await api.node(runId, "g")).status).toBe("running");

		// 3. 放行任务：结果被 Ack 后替换自己并 execve，以当前版本握手。
		await writeFile(release, "");
		await eventually(async () => {
			const a = await view();
			expect([a.status, a.info.agent_version, a.version_mismatch, a.update.state]).toEqual([
				"online",
				version,
				false,
				"none",
			]);
		}, 180_000);
		expect((await api.run(runId)).status).toBe("success");
		const g = await api.node(runId, "g");
		expect(g.attempts.map((a) => [a.attempt, a.status])).toEqual([[1, "success"]]);

		// 同一个进程（execve）；装上的是控制面提供的当前版本，旧版本留作 .prev。
		expect(agent.child.exitCode).toBeNull();
		expect(agent.child.pid).toBe(pid);
		expect(agent.events.filter((e) => e.event === "welcome").length).toBeGreaterThanOrEqual(2);
		const hostArch = arch() === "arm64" ? "aarch64" : "x86_64";
		const bundled = await readFile(join(bundleDir as string, "agent", hostArch, "sfly-agent"));
		expect((await readFile(installed)).equals(bundled)).toBe(true);
		expect((await readFile(`${installed}.prev`)).equals(await readFile(previous.bin))).toBe(true);
		const { stdout } = await run(installed, ["--version"]);
		expect(stdout.trim()).toBe(`sfly-agent ${version}`);

		// 自更新后照常接新任务。
		const echo = await orchestration("after-update", {
			id: "a",
			node: "echo",
			inputs: { text: "更新后" },
		});
		const after = await api.triggerOk(echo);
		await eventually(async () => expect((await api.run(after)).status).toBe("success"), 120_000);
		expect((await api.node(after, "a")).outputs).toEqual({ text: "更新后" });
	}, 600_000);
});
