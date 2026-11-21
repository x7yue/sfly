// sfly package show <包>@dev 在同一个开发包加载在不止一台 Agent 上时（#472）：真实的 sfly 进程查询测试控制面，
// 开发包的元信息是 Agent 在 Hello 里上报的（sfly dev 交给 Agent 的那份）。
// 只加载在一台、没有加载的情况在 sdk-cli-read-commands.test.ts。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgent } from "./support/fake-agent.js";
import { packageMetadata } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const lines = (stdout: string) => stdout.trimEnd().split("\n");

const metadata = (title: string) =>
	packageMetadata({
		name: "twin-dev",
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
