// sfly scenario versions / agent list / package list、show / run list、show：
// 真实的 sfly 进程查询测试控制面；运行的状态、失败和重试由假 Agent 产生。
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, spawn } from "./support/chains.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import {
	packageArchive,
	packageMetadata,
	publishInit,
	publishPackage,
} from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const CLAUDE_CODE = "sfly-cli/0.5.0 agent/claude-code";
const CODEX = "sfly-cli/0.5.0 agent/codex";
const OTHER_BOT = "sfly-cli/0.5.0 agent/my-bot";

/** 主链 entry → spawn → z（失败时重试 1 次）→ a；spawn 派发子流程「回放」sub → s。 */
const REGRESSION = orchestration(
	[
		[{ id: "entry", kind: "entry" }, spawn("spawn"), { ...echo("z"), retries: 1 }, echo("a")],
		[{ id: "sub", kind: "subflow_entry", name: "回放", params: [] }, echo("s")],
	],
	[["spawn", "sub"]],
);
const SMOKE = orchestration([[{ id: "entry", kind: "entry" }, echo("a")]], []);

const TRACEBACK = [
	"boom 2",
	"",
	"Traceback (most recent call last):",
	'  File "z.py", line 3, in z',
	"ValueError: bad",
].join("\n");

/** 文本输出里的表格：每行去掉行尾空白后按两个及以上空格拆成单元格，方便断言而不依赖列宽。 */
const cells = (line: string) => line.trim().split(/ {2,}/);
const lines = (stdout: string) => stdout.trimEnd().split("\n");

describe("sfly 只读命令 → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const clock = new ManualClock(iso(T0));
	const agents: FakeAgent[] = [];
	const ids: Record<string, string> = {};
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);

	const write = (path: string, body: unknown, client?: string, nickname = "小明") =>
		cp.fetch(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-sfly-nickname": encodeURIComponent(nickname),
				...(client === undefined ? {} : { "x-sfly-client": client }),
			},
			body: JSON.stringify(body),
		});
	const save = async (scenario: string, document: unknown, client?: string, nickname?: string) => {
		const base = await api.headVersion(scenario);
		const res = await write(
			`/orchestrations/${scenario}/versions`,
			{ base_version: base, document },
			client,
			nickname,
		);
		expect(res.status, await res.clone().text()).toBe(201);
	};
	const trigger = async (scenario: string, client: string | undefined, nickname: string) => {
		const res = await write(`/orchestrations/${scenario}/runs`, { params: {} }, client, nickname);
		expect(res.status, await res.clone().text()).toBe(201);
		return ((await res.json()) as { id: string }).id;
	};
	const connect = async (hello: Parameters<typeof FakeAgent.connect>[1]) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};
	/** 按节点收齐派发给 agent 的 n 个任务。 */
	const assigns = async (agent: FakeAgent, n: number) => {
		const tasks: Record<string, AssignedTask> = {};
		for (let i = 0; i < n; i++) {
			const task = await agent.nextAssign();
			tasks[`${task.nodeId}#${task.attempt}`] = task;
		}
		return tasks;
	};

	const richMetadata = (version: string) =>
		packageMetadata({
			name: "rich",
			version,
			nodes: [
				{
					name: "probe",
					title: "探测主机",
					entry: "rich.probe:probe",
					inputs: {
						type: "object",
						properties: {
							host: { type: "string", description: "目标主机" },
							retries: { type: "integer", default: 3 },
							mode: { enum: ["fast", "full"], default: "fast" },
							tags: { type: "array", items: { type: "string" } },
							note: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
							target: { type: "string", "x-sfly-type": "agent" },
							extra: {},
						},
						required: ["host"],
						order: ["host", "retries", "mode", "tags", "note", "target", "extra"],
					},
					outputs: {
						type: "object",
						properties: { alive: { type: "boolean", description: "主机是否在线" } },
					},
				},
				{
					name: "noop",
					title: "什么也不做",
					entry: "rich.noop:noop",
					inputs: { type: "object", properties: {} },
					outputs: { type: "object", properties: {} },
				},
			],
		});
	const publishRich = async (version: string) => {
		const res = await cp.fetch(
			"/packages",
			publishInit(
				packageArchive(richMetadata(version), {
					[`rich-${version}-py3-none-any.whl`]: strToU8("wheel"),
				}),
			),
		);
		expect(res.status, await res.clone().text()).toBe(201);
	};

	let a: FakeAgent;

	beforeAll(async () => {
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		await publishPackage(cp, "alpha", "0.1.0", { one: [] });
		await publishRich("1.0.0");
		clock.advance(60_000);
		await publishRich("1.1.0");

		// Agent：a 在线、版本一致、有对外地址和开发包；b 在线但版本落后；c 已离线。
		a = await connect({
			name: "agent-a",
			peer: { port: 9100, publicAddress: "10.0.0.5" },
			devPackages: [
				{
					name: "demo-dev",
					source: "/src/demo-dev",
					metadataJson: JSON.stringify(richMetadata("0.0.1")),
				},
			],
		});
		await connect({ name: "agent-b", agentVersion: "0.0.1" });
		const c = await connect({ name: "agent-c" });
		await c.disconnect();

		// 场景版本：v1 浏览器、v2 经 Claude Code、v3 经 Codex、v4 经别的助手。
		ids.versions = await api.createOrchestration("版本场景");
		await save(ids.versions, SMOKE);
		clock.advance(1000);
		await save(ids.versions, SMOKE, CLAUDE_CODE, "小红");
		clock.advance(1000);
		await save(ids.versions, SMOKE, CODEX, "小红");
		clock.advance(1000);
		await save(ids.versions, SMOKE, OTHER_BOT);
		ids.noVersions = await api.createOrchestration("没有版本");
		ids.many = await api.createOrchestration("很多版本");
		for (let i = 0; i < 52; i++) await save(ids.many, SMOKE);

		// 运行。R1：z 失败两次（重试）、回放子流程成功，经 Claude Code 触发。
		ids.regression = await api.createOrchestration("回归场景");
		await save(ids.regression, REGRESSION);
		ids.smoke = await api.createOrchestration("冒烟场景");
		await save(ids.smoke, SMOKE);
		clock.set(iso(T0 + 1_000_000));

		const start1 = clock.now().getTime();
		ids.r1 = await trigger(ids.regression, CLAUDE_CODE, "小明");
		const first = await assigns(a, 2);
		clock.advance(1000);
		await a.succeed(first["s#1"] as AssignedTask);
		clock.advance(2000);
		await a.fail(first["z#1"] as AssignedTask, "boom 1");
		const retry = await a.nextAssign();
		expect(retry.attempt).toBe(2);
		clock.advance(4000);
		await a.fail(retry, TRACEBACK);
		expect(clock.now().getTime() - start1).toBe(7000);

		// R2：冒烟，浏览器触发，成功，耗时 1 分 5 秒。
		clock.advance(1000);
		ids.r2 = await trigger(ids.smoke, undefined, "小红");
		const smoke = await a.nextAssign();
		clock.advance(65_000);
		await a.succeed(smoke, { text: "ok" });

		// R3：回归场景，运行中（z 和 s 都在 Agent 上）。
		clock.advance(15_000);
		ids.r3 = await trigger(ids.regression, undefined, "小明");
		await assigns(a, 2);

		// R4：冒烟，经 Claude Code 触发，经 Codex 取消。
		clock.advance(10_000);
		ids.r4 = await trigger(ids.smoke, CLAUDE_CODE, "小红");
		const doomed = await a.nextAssign();
		clock.advance(10_000);
		expect((await write(`/runs/${ids.r4}/cancel`, {}, CODEX, "小明")).status).toBe(200);
		await a.nextCancel();
		await a.cancelled(doomed);
	}, 180_000);

	afterAll(async () => {
		await Promise.all(agents.map((x) => x.disconnect()));
		await cp?.close();
	});

	describe("scenario versions", () => {
		it("文本输出：版本、作者、保存时间，经 AI 编程助手保存的写「经 …」，新的在前", async () => {
			const result = await cli("scenario", "versions", "版本场景");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			const rows = lines(result.stdout).map(cells);
			expect(rows).toEqual([
				["版本", "作者", "保存时间", "经"],
				["4", "小明", expect.stringMatching(/^2026-/), "经 my-bot"],
				["3", "小红", expect.stringMatching(/^2026-/), "经 Codex"],
				["2", "小红", expect.stringMatching(/^2026-/), "经 Claude Code"],
				["1", "小明", expect.stringMatching(/^2026-/)],
			]);
		});

		it("--json 输出数组：author_via 是请求头里的名称，没有时为 null；也可以用 id 指定场景", async () => {
			const result = await cli("scenario", "versions", ids.versions as string, "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
			expect(JSON.parse(result.stdout)).toEqual([
				{ number: 4, author: "小明", author_via: "my-bot", created_at: expect.any(String) },
				{ number: 3, author: "小红", author_via: "codex", created_at: expect.any(String) },
				{ number: 2, author: "小红", author_via: "claude-code", created_at: expect.any(String) },
				{ number: 1, author: "小明", author_via: null, created_at: expect.any(String) },
			]);
		});

		it("默认最多 50 个版本，超出时提示还有多少个和怎么看全部；--json 时提示写到 stderr", async () => {
			const result = await cli("scenario", "versions", "很多版本");
			expect(result.code, result.stderr).toBe(0);
			const out = lines(result.stdout);
			expect(out).toHaveLength(1 + 50 + 1);
			expect(cells(out[1] as string)[0]).toBe("52");
			expect(out.at(-1)).toBe("还有 2 个版本没有显示（共 52 个版本），加 --limit 52 查看全部");

			const json = await cli("scenario", "versions", "很多版本", "--json", "--limit", "2");
			expect(JSON.parse(json.stdout)).toHaveLength(2);
			expect(json.stderr).toContain("还有 50 个版本没有显示");
		});

		it("还没有版本的场景、不存在的场景", async () => {
			const none = await cli("scenario", "versions", "没有版本");
			expect(none.code, none.stderr).toBe(0);
			expect(none.stdout).toBe("场景「没有版本」还没有保存过版本\n");
			expect(JSON.parse((await cli("scenario", "versions", "没有版本", "--json")).stdout)).toEqual(
				[],
			);

			const missing = await cli("scenario", "versions", "不存在", "--json");
			expect(missing.code).toBe(2);
			expect(JSON.parse(missing.stderr).error.code).toBe("scenario_not_found");
		});
	});

	describe("agent list", () => {
		it("文本输出：在线状态、版本、是否与控制面一致、运行中的任务数、对外地址、开发包", async () => {
			const result = await cli("agent", "list");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			const rows = lines(result.stdout).map(cells);
			expect(rows[0]).toEqual([
				"Agent",
				"状态",
				"版本",
				"与控制面一致",
				"运行中任务",
				"对外地址",
				"开发包",
			]);
			expect(rows.slice(1)).toEqual([
				["agent-a", "在线", cp.version, "是", "2/4", "10.0.0.5:9100", "demo-dev"],
				["agent-b", "在线", "0.0.1", `否（控制面 ${cp.version}）`, "0/4", "127.0.0.1", "-"],
				["agent-c", "离线", cp.version, "是", "0/4", "127.0.0.1", "-"],
			]);
		});

		it("--json 输出数组", async () => {
			const result = await cli("agent", "list", "--json");
			expect(result.code, result.stderr).toBe(0);
			const agentRows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
			expect(agentRows).toHaveLength(3);
			expect(agentRows[0]).toEqual({
				name: "agent-a",
				status: "online",
				agent_version: cp.version,
				version_matches: true,
				running_tasks: 2,
				slots: 4,
				address: "10.0.0.5:9100",
				dev_packages: ["demo-dev"],
				last_seen_at: expect.any(String),
			});
			expect(agentRows[1]).toMatchObject({
				name: "agent-b",
				agent_version: "0.0.1",
				version_matches: false,
				running_tasks: 0,
			});
			expect(agentRows[2]).toMatchObject({ name: "agent-c", status: "offline" });
		});

		it("--limit 限制条数并提示还有多少台", async () => {
			const result = await cli("agent", "list", "--limit", "1");
			const out = lines(result.stdout);
			expect(out).toHaveLength(3);
			expect(out.at(-1)).toBe("还有 2 台 Agent没有显示（共 3 台 Agent），加 --limit 3 查看全部");
		});
	});

	describe("package list", () => {
		it("文本输出：每个包的版本（新到旧）和最新版本的节点类型，按包名排序", async () => {
			const result = await cli("package", "list");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(lines(result.stdout).map(cells)).toEqual([
				["节点包", "版本（新到旧）", "最新版本的节点类型"],
				["alpha", "0.1.0", "one"],
				["rich", "1.1.0, 1.0.0", "probe, noop"],
				["stub", "1.0.0", "echo"],
			]);
		});

		it("--json 输出数组：每个版本的发布时间、节点类型、被多少个场景锁定", async () => {
			const result = await cli("package", "list", "--json");
			expect(result.code, result.stderr).toBe(0);
			const packages = JSON.parse(result.stdout);
			expect(packages.map((p: { name: string }) => p.name)).toEqual(["alpha", "rich", "stub"]);
			expect(packages[1]).toEqual({
				name: "rich",
				latest_version: "1.1.0",
				versions: [
					{
						version: "1.1.0",
						published_at: iso(T0 + 60_000),
						nodes: ["probe", "noop"],
						locked_orchestrations: 0,
					},
					{
						version: "1.0.0",
						published_at: iso(T0),
						nodes: ["probe", "noop"],
						locked_orchestrations: 0,
					},
				],
			});
			expect(packages[2].versions[0].locked_orchestrations).toBe(
				// 引用 stub 的场景：版本场景、很多版本、回归场景、冒烟场景。
				4,
			);
		});

		it("--limit 限制包的个数", async () => {
			const result = await cli("package", "list", "--limit", "2");
			const out = lines(result.stdout);
			expect(out).toHaveLength(4);
			expect(out.at(-1)).toBe("还有 1 个节点包没有显示（共 3 个节点包），加 --limit 3 查看全部");
		});
	});

	describe("package show", () => {
		const expectedLatest = [
			"节点包 rich@1.1.0（最新版本），发布于 " + iso(T0 + 60_000),
			"",
			"节点类型 probe  探测主机",
			"  输入：",
			"    参数     类型             说明",
			"    host     string           必填，目标主机",
			"    retries  integer          默认 3",
			'    mode     "fast" | "full"  默认 "fast"',
			"    tags     array<string>",
			"    note     string | null    默认 null",
			"    target   Agent 名称",
			"    extra    any",
			"  输出：",
			"    输出   类型     说明",
			"    alive  boolean  主机是否在线",
			"",
			"节点类型 noop  什么也不做",
			"  输入：无",
			"  输出：无",
		];

		it("不写版本时显示最新版本：节点类型的标题、输入的类型/默认值/是否必填、输出", async () => {
			const result = await cli("package", "show", "rich");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(lines(result.stdout)).toEqual(expectedLatest);
		});

		it("指定版本显示那个版本，不标最新", async () => {
			const result = await cli("package", "show", "rich@1.0.0");
			expect(result.code, result.stderr).toBe(0);
			expect(lines(result.stdout)[0]).toBe("节点包 rich@1.0.0，发布于 " + iso(T0));
		});

		it("--json 输出对象，输入按声明顺序，带类型、必填、默认值、说明", async () => {
			const result = await cli("package", "show", "rich", "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
			const view = JSON.parse(result.stdout);
			expect(view).toMatchObject({ name: "rich", version: "1.1.0", latest: true });
			expect(view.nodes[0]).toEqual({
				name: "probe",
				title: "探测主机",
				inputs: [
					{ name: "host", type: "string", required: true, description: "目标主机" },
					{ name: "retries", type: "integer", required: false, default: 3 },
					{ name: "mode", type: '"fast" | "full"', required: false, default: "fast" },
					{ name: "tags", type: "array<string>", required: false },
					{ name: "note", type: "string | null", required: false, default: null },
					{ name: "target", type: "Agent 名称", required: false },
					{ name: "extra", type: "any", required: false },
				],
				outputs: [{ name: "alive", type: "boolean", description: "主机是否在线" }],
			});
			expect(view.nodes[1]).toEqual({ name: "noop", title: "什么也不做", inputs: [], outputs: [] });
		});

		it("版本不存在时报错，列出已有的版本和下一步", async () => {
			const result = await cli("package", "show", "rich@9.9.9");
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				[
					"错误：节点包 rich 没有版本 9.9.9，已有的版本（新到旧）：",
					"  1.1.0",
					"  1.0.0",
					"下一步：sfly package show rich@1.1.0",
					"",
				].join("\n"),
			);

			const json = await cli("package", "show", "rich@9.9.9", "--json");
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error).toMatchObject({
				code: "package_version_not_found",
				next: "sfly package show rich@1.1.0",
			});
		});

		it("包不存在时报错并提示 sfly package list", async () => {
			const result = await cli("package", "show", "nope");
			expect(result.code).toBe(2);
			expect(result.stderr).toBe("错误：没有节点包 nope\n下一步：sfly package list\n");
		});
	});

	describe("run list", () => {
		const idsInOrder = () => [ids.r4, ids.r3, ids.r2, ids.r1];

		it("文本输出：运行、场景、版本、状态、触发人（经 …）、开始时间、耗时，新的在前", async () => {
			const result = await cli("run", "list");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(lines(result.stdout).map(cells)).toEqual([
				["运行", "场景", "版本", "状态", "触发", "开始时间", "耗时"],
				[ids.r4, "冒烟场景", "1", "已取消", "小红 经 Claude Code", expect.any(String), "10s"],
				[ids.r3, "回归场景", "1", "运行中", "小明", expect.any(String), "-"],
				[ids.r2, "冒烟场景", "1", "成功", "小红", expect.any(String), "1m05s"],
				[ids.r1, "回归场景", "1", "失败", "小明 经 Claude Code", expect.any(String), "7s"],
			]);
		});

		it("--json 输出数组，带原始状态、触发经谁、耗时毫秒和失败的链", async () => {
			const result = await cli("run", "list", "--json");
			expect(result.code, result.stderr).toBe(0);
			const runs = JSON.parse(result.stdout);
			expect(runs.map((r: { id: string }) => r.id)).toEqual(idsInOrder());
			expect(runs[3]).toEqual({
				id: ids.r1,
				scenario_id: ids.regression,
				scenario: "回归场景",
				scenario_version: 1,
				status: "failed",
				cancelling: false,
				triggered_by: "小明",
				triggered_via: "claude-code",
				started_at: expect.any(String),
				ended_at: expect.any(String),
				duration_ms: 7000,
				failures: [
					{
						chain_instance_id: expect.any(String),
						chain_id: "entry",
						subflow: false,
						node_id: "z",
					},
				],
			});
			expect(runs[1]).toMatchObject({ status: "running", ended_at: null, duration_ms: null });
			expect(runs[2].triggered_via).toBeNull();
		});

		it("--scenario 按名称或 id 筛选；--status 按状态筛选", async () => {
			const byName = await cli("run", "list", "--scenario", "回归场景", "--json");
			expect(JSON.parse(byName.stdout).map((r: { id: string }) => r.id)).toEqual([ids.r3, ids.r1]);
			const byId = await cli("run", "list", "--scenario", ids.smoke as string, "--json");
			expect(JSON.parse(byId.stdout).map((r: { id: string }) => r.id)).toEqual([ids.r4, ids.r2]);

			const failed = await cli("run", "list", "--status", "failed", "--json");
			expect(JSON.parse(failed.stdout).map((r: { id: string }) => r.id)).toEqual([ids.r1]);
			const both = await cli("run", "list", "--scenario", "冒烟场景", "--status", "success");
			expect(lines(both.stdout).map(cells)[1]?.[0]).toBe(ids.r2);
			expect(lines(both.stdout)).toHaveLength(2);
		});

		it("没有符合条件的运行；不认识的状态；不存在的场景", async () => {
			const none = await cli("run", "list", "--scenario", "没有版本");
			expect(none.code, none.stderr).toBe(0);
			expect(none.stdout).toBe("没有符合条件的运行\n");

			const bad = await cli("run", "list", "--status", "weird");
			expect(bad.code).toBe(2);
			expect(bad.stderr).toContain("--status");

			const missing = await cli("run", "list", "--scenario", "不存在");
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("没有 id 或名称是「不存在」的场景");
		});

		it("--limit 限制条数，提示还有多少次运行；--json 时提示写到 stderr", async () => {
			const result = await cli("run", "list", "--limit", "3");
			const out = lines(result.stdout);
			expect(out).toHaveLength(1 + 3 + 1);
			expect(out.at(-1)).toBe("还有 1 次运行没有显示（共 4 次），加 --limit 4 查看更多");

			const json = await cli("run", "list", "--limit", "1", "--status", "failed", "--json");
			expect(JSON.parse(json.stdout)).toHaveLength(1);
			expect(json.stderr).toBe("");
		});
	});

	describe("run show", () => {
		it("有失败节点、有重试的运行：各链各节点的状态，失败节点的错误和每次尝试", async () => {
			const result = await cli("run", "show", ids.r1 as string);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			const out = lines(result.stdout);
			expect(out.slice(0, 5)).toEqual([
				`运行 ${ids.r1}  失败，耗时 7s`,
				`场景 回归场景（${ids.regression}），场景版本 1`,
				`触发 小明 经 Claude Code，${iso(T0 + 1_000_000)} 开始，${iso(T0 + 1_007_000)} 结束`,
				"",
				"链 main  失败",
			]);
			const main = out.slice(5, out.indexOf("链 回放  成功"));
			expect(main.map(cells)).toEqual(
				expect.arrayContaining([
					["节点", "状态", "尝试", "Agent", "耗时"],
					["z", "失败", "2", "agent-a", "4s"],
					["a", "已跳过", "0", "agent-a", "-"],
				]),
			);
			expect(out.join("\n")).toContain("链 回放  成功");

			const detail = out.slice(out.indexOf("失败或重试过的节点："));
			expect(detail).toEqual([
				"失败或重试过的节点：",
				"  main:z  失败，共 2 次尝试",
				`    #1 失败  agent-a  ${iso(T0 + 1_000_000)}  3s`,
				"      node_error：boom 1",
				`    #2 失败  agent-a  ${iso(T0 + 1_003_000)}  4s`,
				"      node_error：boom 2",
				"",
				"      Traceback (most recent call last):",
				'        File "z.py", line 3, in z',
				"      ValueError: bad",
			]);
		});

		it("--json 输出对象：各链各节点的状态、每次尝试和完整错误（不含输入输出）", async () => {
			const result = await cli("run", "show", ids.r1 as string, "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout.trim().split("\n")).toHaveLength(1);
			const view = JSON.parse(result.stdout);
			expect(view).toMatchObject({
				id: ids.r1,
				scenario_id: ids.regression,
				scenario: "回归场景",
				scenario_version: 1,
				status: "failed",
				triggered_by: "小明",
				triggered_via: "claude-code",
				duration_ms: 7000,
				cancel: null,
				params: {},
			});
			expect(view.chains.map((c: { chain: string }) => c.chain)).toEqual(["main", "回放"]);
			const z = view.chains[0].nodes.find((n: { id: string }) => n.id === "z");
			expect(z).toMatchObject({ status: "failed", agent: "agent-a" });
			expect(z.attempts).toEqual([
				{
					task_id: expect.any(String),
					attempt: 1,
					status: "failed",
					agent: "agent-a",
					queued_at: expect.any(String),
					started_at: iso(T0 + 1_000_000),
					ended_at: iso(T0 + 1_003_000),
					duration_ms: 3000,
					error: { kind: "node_error", message: "boom 1" },
				},
				expect.objectContaining({
					attempt: 2,
					duration_ms: 4000,
					error: { kind: "node_error", message: TRACEBACK },
				}),
			]);
			expect(z).not.toHaveProperty("outputs");
			expect(z.attempts[0]).not.toHaveProperty("inputs");
		});

		it("运行中的运行不写耗时和结束时间", async () => {
			const result = await cli("run", "show", ids.r3 as string);
			expect(result.code, result.stderr).toBe(0);
			const out = lines(result.stdout);
			expect(out[0]).toBe(`运行 ${ids.r3}  运行中`);
			expect(out[2]).toMatch(/^触发 小明，.+ 开始$/);
			expect(result.stdout).not.toContain("失败或重试过的节点");
		});

		it("被取消的运行写明谁经哪个 AI 编程助手取消", async () => {
			const result = await cli("run", "show", ids.r4 as string);
			expect(result.code, result.stderr).toBe(0);
			const out = lines(result.stdout);
			expect(out[0]).toBe(`运行 ${ids.r4}  已取消，耗时 10s`);
			expect(out[3]).toBe(
				`取消 小明 经 Codex，${iso(T0 + 1_000_000 + 7_000 + 1_000 + 65_000 + 15_000 + 10_000 + 10_000)} 请求取消`,
			);

			const json = JSON.parse((await cli("run", "show", ids.r4 as string, "--json")).stdout);
			expect(json.cancel).toEqual({
				requested_by: "小明",
				requested_via: "codex",
				requested_at: expect.any(String),
				forced_at: null,
			});
		});

		it("成功的运行没有失败节点一节；运行不存在时报错并提示 sfly run list", async () => {
			const ok = await cli("run", "show", ids.r2 as string);
			expect(ok.code, ok.stderr).toBe(0);
			expect(lines(ok.stdout)[0]).toBe(`运行 ${ids.r2}  成功，耗时 1m05s`);
			expect(ok.stdout).not.toContain("失败或重试过的节点");

			const missing = await cli("run", "show", "nope");
			expect(missing.code).toBe(2);
			expect(missing.stderr).toBe("错误：没有 id 是 nope 的运行\n下一步：sfly run list\n");
		});
	});
});
