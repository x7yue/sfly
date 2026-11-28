// sfly package show <包>@dev 在同一个开发包加载在不止一台 Agent 上时（#472）：真实的 sfly 进程查询测试控制面，
// 开发包的元信息是 Agent 在 Hello 里上报的（sfly dev 交给 Agent 的那份）。
// 只加载在一台、没有加载的情况在 sdk-cli-read-commands.test.ts。
// 离线的 Agent 上残留的开发包不算加载（和运行准入一致，apps/server/src/runs/dev-package-loaded.ts）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageMetadata } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const lines = (stdout: string) => stdout.trimEnd().split("\n");

const metadata = (title: string, name = "twin-dev") =>
	packageMetadata({
		name,
		version: "dev",
		nodes: [
			{
				name: "probe",
				title,
				entry: "twin_dev.probe:probe",
				inputs: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
				outputs: { type: "object", properties: {} },
			},
		],
	});

describe("sfly package show 包@dev：开发包加载在两台 Agent 上", () => {
	let cp: TestControlPlane;
	const agents: FakeAgent[] = [];
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	beforeAll(async () => {
		cp = await startTestControlPlane();
		for (const [name, title] of [
			["agent-d", "探测（d 上的）"],
			["agent-e", "探测（e 上的）"],
		] as const) {
			agents.push(
				await FakeAgent.connect(cp.grpcUrl, {
					name,
					devPackages: [
						{
							name: "twin-dev",
							source: `/src/${name}/twin-dev`,
							metadataJson: JSON.stringify(metadata(title)),
						},
					],
				}),
			);
		}
	});

	afterAll(async () => {
		await Promise.all(agents.map((a) => a.disconnect()));
		await cp?.close();
	});

	it("不指定 Agent：报错列出是哪两台，要求用 --agent 指定", async () => {
		const result = await cli("package", "show", "twin-dev@dev");
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			[
				"错误：节点包 twin-dev 的开发版本加载在 2 台 Agent 上：agent-d、agent-e，用 --agent 指定看哪一台的",
				"下一步：sfly package show twin-dev@dev --agent agent-d",
				"",
			].join("\n"),
		);

		const json = await cli("package", "show", "twin-dev@dev", "--json");
		expect(json.code).toBe(2);
		expect(json.stdout).toBe("");
		expect(JSON.parse(json.stderr).error).toMatchObject({
			code: "dev_package_ambiguous",
			next: "sfly package show twin-dev@dev --agent agent-d",
		});
	});

	it("用 --agent 指定后显示那一台上的节点定义（文本和 --json）", async () => {
		const text = await cli("package", "show", "twin-dev@dev", "--agent", "agent-e");
		expect(text.code, text.stderr).toBe(0);
		expect(lines(text.stdout).slice(0, 3)).toEqual([
			"节点包 twin-dev@dev（开发版本，用 sfly dev 加载在 Agent agent-e 上，源码目录 /src/agent-e/twin-dev）",
			"",
			"节点类型 probe  探测（e 上的）",
		]);

		const json = await cli("package", "show", "twin-dev@dev", "--agent", "agent-e", "--json");
		expect(json.code, json.stderr).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual({
			name: "twin-dev",
			version: "dev",
			agent: "agent-e",
			source: "/src/agent-e/twin-dev",
			nodes: [
				{
					name: "probe",
					title: "探测（e 上的）",
					inputs: [{ name: "host", type: "string", required: true }],
					outputs: [],
				},
			],
		});
	});

	it("--agent 指定的 Agent 上没有加载这个开发包：报错列出加载了它的 Agent", async () => {
		const result = await cli("package", "show", "twin-dev@dev", "--agent", "agent-x");
		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			[
				"错误：Agent agent-x 上没有加载节点包 twin-dev 的开发版本；加载了它的 Agent：agent-d、agent-e",
				"下一步：sfly package show twin-dev@dev --agent agent-d",
				"",
			].join("\n"),
		);
	});
});

describe("sfly package show 包@dev：只算在线的 Agent", () => {
	let cp: TestControlPlane;
	const agents: FakeAgent[] = [];
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const connect = async (name: string, packages: Array<{ name: string; metadataJson: string }>) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name,
			devPackages: packages.map((p) => ({ ...p, source: `/src/${name}/${p.name}` })),
		});
		agents.push(agent);
		return agent;
	};

	beforeAll(async () => {
		cp = await startTestControlPlane();
		// pair-dev：agent-f 在线，agent-g 离线；gone-dev 只在离线的 agent-g 上；bad-dev 的节点缺字段
		await connect("agent-f", [
			{ name: "pair-dev", metadataJson: JSON.stringify(metadata("探测（f 上的）", "pair-dev")) },
			{
				name: "bad-dev",
				metadataJson: JSON.stringify({
					name: "bad-dev",
					version: "dev",
					nodes: [{ name: "probe" }],
				}),
			},
		]);
		const offline = await connect("agent-g", [
			{ name: "pair-dev", metadataJson: JSON.stringify(metadata("探测（g 上的）", "pair-dev")) },
			{ name: "gone-dev", metadataJson: JSON.stringify(metadata("探测", "gone-dev")) },
		]);
		await offline.disconnect();
		const api = new ApiClient(cp);
		await eventually(async () => {
			const { agents: listed } = (await api.getJson("/projects/default/agents")) as {
				agents: Array<{ name: string; status: string }>;
			};
			expect(listed.find((a) => a.name === "agent-g")?.status).toBe("offline");
		});
	});

	afterAll(async () => {
		await Promise.all(agents.map((a) => a.disconnect()));
		await cp?.close();
	});

	it("一台在线、一台离线：不算多台，直接显示在线那台的", async () => {
		const result = await cli("package", "show", "pair-dev@dev");
		expect(result.code, result.stderr).toBe(0);
		expect(lines(result.stdout).slice(0, 3)).toEqual([
			"节点包 pair-dev@dev（开发版本，用 sfly dev 加载在 Agent agent-f 上，源码目录 /src/agent-f/pair-dev）",
			"",
			"节点类型 probe  探测（f 上的）",
		]);
	});

	it("只有离线的 Agent 上有：按没有加载报错，提到离线的那台，下一步不指向它", async () => {
		const result = await cli("package", "show", "gone-dev@dev");
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			[
				"错误：节点包 gone-dev 的开发版本没有加载在任何在线的 Agent 上（离线的 Agent agent-g 上次加载过它）。开发版本由 sfly dev 加载到 Agent 上，不在已发布的节点包列表里",
				"下一步：在节点包源码目录里运行 sfly dev，再用 sfly agent list 看各台 Agent 加载了哪些开发包",
				"",
			].join("\n"),
		);
		const json = await cli("package", "show", "gone-dev@dev", "--json");
		expect(JSON.parse(json.stderr).error.code).toBe("dev_package_not_loaded");
	});

	it("--agent 指定了离线的 Agent：报它离线，不显示旧的定义", async () => {
		const result = await cli("package", "show", "pair-dev@dev", "--agent", "agent-g");
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			[
				"错误：Agent agent-g 离线：它上次上报的开发包定义可能已经过时，运行也不会派发给它；在线且加载了 pair-dev 的 Agent：agent-f",
				"下一步：sfly package show pair-dev@dev --agent agent-f",
				"",
			].join("\n"),
		);
		const json = await cli("package", "show", "pair-dev@dev", "--agent", "agent-g", "--json");
		expect(JSON.parse(json.stderr).error.code).toBe("agent_offline");
	});

	it("开发包的节点缺字段：报元信息读不出节点定义，不抛 KeyError", async () => {
		const result = await cli("package", "show", "bad-dev@dev");
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			[
				"错误：Agent agent-f 上报的开发包 bad-dev 的元信息读不出节点定义",
				"下一步：在节点包源码目录里重新运行 sfly dev",
				"",
			].join("\n"),
		);
	});
});
