// 全栈：控制面的包索引里的标准节点包 sfly-std（#556）。一个依赖 sfly-std 的节点包，场景里没有任何 sfly-std 的节点：
// 真实的 Agent（共享 venv 里只有 SDK，没有 sfly-std）从控制面下载这个节点包，装它的依赖时 sfly-std 来自控制面的包索引
// （`Welcome.package_index_url`，公共项目里已发布的 sfly-std），httpx、psutil 这些依赖来自 PyPI 镜像桩。
// PyPI 镜像桩里没有 sfly-std（它不在 PyPI 上），另一台 Agent 的镜像里放一个同名、版本更高的假包：装上的仍是控制面的那个。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { dependencyWheel, type PypiStub, startPypiStub } from "./support/pypi-stub.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import {
	buildStdPackage,
	publishIntoPublicProject,
	type StdPackage,
	wheelhouse,
} from "./support/std-package.js";
import { publishTestPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** PyPI 镜像上同名假包的版本：比控制面里的 sfly-std 高得多。 */
const FAKE_VERSION = "99.0.0";

describeWithAgent("全栈：节点包依赖 sfly-std，sfly-std 来自控制面的包索引", () => {
	let dir: string;
	let cp: TestControlPlane;
	let std: StdPackage;
	let pypi: PypiStub;
	let pypiWithFake: PypiStub;
	const venvs: Array<{ remove(): Promise<void> }> = [];
	const agents: RealAgent[] = [];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-full-std-index-"));
		let wheels: Awaited<ReturnType<typeof wheelhouse>>;
		[cp, std, wheels] = await Promise.all([
			startTestControlPlane({ clock: systemClock }),
			buildStdPackage(join(dir, "dist")),
			// sfly-std 的依赖（httpx、psutil 及它们的依赖），没有 sfly-std 本身。
			wheelhouse(join(dir, "wheels"), [], { withStdDependencies: true }),
		]);
		expect(wheels.map(([project]) => project)).not.toContain("sfly_std");
		pypi = await startPypiStub(wheels);
		pypiWithFake = await startPypiStub([...wheels, dependencyWheel("sfly-std", FAKE_VERSION)]);
		// sfly-std 由平台管理员经接口发布到公共项目（POST /packages?project=public，#565，平台维护的包放在公共项目，
		// ADR 0029）；依赖它的节点包是普通的用户节点包。
		await publishIntoPublicProject(cp, new Uint8Array(await readFile(std.path)), {
			name: "sfly-std",
			version: std.version,
		});
		await publishTestPackage(cp, "testdata/std-dependent-package", "sfly-std-user-0.1.0.sflypkg");
	}, 600_000);

	afterAll(async () => {
		await Promise.all(agents.map((a) => a.close()));
		await Promise.all(venvs.map((v) => v.remove()));
		await cp?.close();
		await pypi?.close();
		await pypiWithFake?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	/** 一台干净的 Agent：共享 venv 里只有 SDK 运行时，PyPI 镜像用 `mirror`。 */
	async function cleanAgent(name: string, mirror: PypiStub) {
		const venv = await createStubVenv({ sdkOnly: true });
		venvs.push(venv);
		const agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name,
			venv: venv.path,
			args: ["--index-url", mirror.indexUrl],
			bin: agentBinary(),
		});
		agents.push(agent);
		return { agent, venv };
	}

	/** 只含 sfly-std-user 一个节点的场景（没有任何 sfly-std 的节点），运行到结束，返回这个节点的结果。 */
	async function runUsesStd(agentName: string) {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: agentName,
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "use", kind: "package", package: "sfly-std-user", node: "uses_std" },
			],
			edges: [{ from: "entry", to: "use", kind: "chain" }],
			packages: { "sfly-std-user": "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		await eventually(
			async () => expect(["success", "failed"]).toContain((await api.run(runId)).status),
			180_000,
		);
		return { api, runId, run: await api.run(runId) };
	}

	it("干净的 Agent 装上依赖 sfly-std 的节点包并执行成功：sfly-std 来自控制面的包索引，PyPI 镜像里没有它", async () => {
		await cleanAgent("std-index-agent", pypi);
		const { api, runId, run } = await runUsesStd("std-index-agent");

		expect(run.status, JSON.stringify(run)).toBe("success");
		const node = await api.node(runId, "use");
		expect(node).toMatchObject({ status: "success", agent: "std-index-agent" });
		expect(node.outputs).toMatchObject({ std_version: std.version });
		// 节点里导入的是装进共享 venv 的 sfly-std（不是仓库里的源码）。
		expect((node.outputs as { std_module: string }).std_module).toContain("site-packages");
		// sfly-std 是从控制面的索引装的，没有去 PyPI 镜像里找它；它的依赖照常来自镜像。
		expect(pypi.requests).not.toContain("/simple/sfly-std/");
		expect(pypi.requests).toContain("/simple/httpx/");
	}, 300_000);

	it("PyPI 镜像上有同名、版本更高的假 sfly-std：装上的仍是控制面里的那个，假包一次也没有被下载", async () => {
		await cleanAgent("std-index-agent-fake", pypiWithFake);
		const { api, runId, run } = await runUsesStd("std-index-agent-fake");

		expect(run.status, JSON.stringify(run)).toBe("success");
		const outputs = (await api.node(runId, "use")).outputs as { std_version: string };
		expect(outputs.std_version).toBe(std.version);
		expect(outputs.std_version).not.toBe(FAKE_VERSION);
		expect(pypiWithFake.requests.filter((p) => p.includes("sfly_std"))).toEqual([]);
	}, 300_000);
});
