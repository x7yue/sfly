// 运行预设在命令行里（#330，ADR 0023）：sfly run start --preset、scenario show 与 run show 里的预设。
// 真实的 sfly 进程对测试控制面；预设用 HTTP API 创建，运行由假 Agent 接收。
import { runsApi } from "@sfly/schema";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import {
	createPresetOk,
	deletePreset,
	PRESET_PARAMS,
	presetScenario,
	renamePresetInDb,
	triggerWithPreset,
} from "./support/presets.js";
import { startRecordingProxy } from "./support/recording-proxy.js";
import { sfly } from "./support/sfly-cli.js";
import { type SflyProcess, spawnSfly } from "./support/sfly-process.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PRESET_A = "压测 A 集群";
const PRESET_B = "压测 B 集群";
const SECRET = "tok-from-preset";
const UNMASKED = "******";
const LOCKED_HINT =
	"去掉 --param 或 --params 里的这个参数，预设会填上它保存的值；要用别的值就不要加 --preset。";

describe("sfly 运行预设 → 控制面", { timeout: 60_000 }, () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const processes: SflyProcess[] = [];
	let agents = 0;
	let scenes = 0;

	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const assign = () => agent.nextAssign({ timeoutMs: 30_000 });
	const runsOf = async (scenarioId: string) =>
		(
			await api.getJson<{ runs: Array<{ id: string }> }>(`/orchestrations/${scenarioId}/runs`)
		).runs.map((r) => r.id);

	/** 运行视图，按 HTTP 契约解析（`ApiClient.run` 的类型里没有 `preset`）。 */
	const runView = async (runId: string) =>
		runsApi.get.response.parse(await api.getJson(`/runs/${runId}`));

	/** 入口参数是 `params`（默认 PRESET_PARAMS）、派发到当前测试的 Agent 的场景文档。 */
	const document = (params = PRESET_PARAMS) => ({
		...presetScenario(params),
		default_agent: agent.name,
	});
	/** 新场景；名称带序号，同一个控制面里不重名。 */
	const scene = async (label: string) => {
		const name = `${label}-${++scenes}`;
		return { name, id: await api.orchestrationWith(document(), name) };
	};
	/** 场景加预设 A：固定 host、port 和 secret 的 token。 */
	const sceneWithA = async (label: string) => {
		const { name, id } = await scene(label);
		const preset = await createPresetOk(api, id, {
			name: PRESET_A,
			description: "A 集群的压测参数",
			params: [
				{ name: "host", value: "a.example" },
				{ name: "port", value: 9000 },
				{ name: "token", value: SECRET },
			],
		});
		return { name, id, preset };
	};
	/** 在 {@link sceneWithA} 上再加预设 B（固定 verbose 和 options），并让场景的新版本删掉 verbose：B 失效，A 仍然可用。 */
	const sceneWithAAndInvalidB = async (label: string) => {
		const found = await sceneWithA(label);
		const b = await createPresetOk(api, found.id, {
			name: PRESET_B,
			params: [
				{ name: "verbose", value: true },
				{ name: "options", value: { mode: "fast" } },
			],
		});
		await api.saveVersion(found.id, document(PRESET_PARAMS.filter((p) => p.name !== "verbose")));
		return { ...found, b };
	};

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
	}, 120_000);

	beforeEach(async () => {
		agent = await FakeAgent.connect(cp.grpcUrl, { name: `agent-${++agents}`, slots: 4 });
	});

	afterEach(async () => {
		for (const process of processes.splice(0)) process.kill();
		await agent.disconnect();
	});

	afterAll(async () => {
		await cp?.close();
	});

	describe("run start --preset", () => {
		it("预设参数取预设保存的值，其余参数照常传，运行上记下预设；secret 的值不出现在输出里", async () => {
			const { name, id, preset } = await sceneWithA("触发");
			const result = await cli(
				...["run", "start", name],
				...["--preset", PRESET_A],
				...["--param", "verbose=true"],
				"--json",
			);
			expect(result.code, result.stderr).toBe(0);

			const [runId] = await runsOf(id);
			const run = await runView(runId as string);
			expect(JSON.parse(result.stdout)).toEqual({
				id: run.id,
				status: "running",
				scenario_id: id,
				scenario_version: 1,
				url: `${cp.httpUrl}/runs/${run.id}`,
			});
			expect(run.params).toMatchObject({ host: "a.example", port: 9000, verbose: true });
			expect(run.preset).toEqual({
				id: preset.id,
				name: PRESET_A,
				params: ["host", "port", "token"],
			});
			expect((await assign()).inputs).toMatchObject({
				host: "a.example",
				port: 9000,
				verbose: true,
				token: SECRET,
			});
			expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
		});

		it("给预设参数传和预设相同的值照常触发：--param 先按声明的类型转换，再连同 preset 一起发出", async () => {
			const { name, id } = await sceneWithA("相同的值");
			const result = await cli(
				...["run", "start", name, "--preset", PRESET_A],
				...["--param", "port=9000"],
				...["--params", '{"host":"a.example"}'],
			);
			expect(result.code, result.stderr).toBe(0);
			const [runId] = await runsOf(id);
			expect((await runView(runId as string)).params).toMatchObject({
				host: "a.example",
				port: 9000,
			});
		});

		it("--wait 照常：等运行结束，退出码表示结果", async () => {
			const { name, id } = await sceneWithA("等待");
			const waiting = spawnSfly([
				...["run", "start", name, "--preset", PRESET_A, "--wait"],
				...["--server", cp.httpUrl],
			]);
			processes.push(waiting);
			const task = await assign();
			expect(task.inputs).toMatchObject({ host: "a.example", port: 9000 });
			await agent.succeed(task);

			const result = await waiting.exited;
			expect(result.code, result.stderr).toBe(0);
			const [runId] = await runsOf(id);
			expect(result.stdout).toContain(`运行 ${runId}：成功`);
		});

		it("没有创建预设的命令：用 sfly api 创建，再用 --preset 触发", async () => {
			const { name, id } = await scene("用 api 创建");
			const body = JSON.stringify({
				name: "压测 C 集群",
				params: [{ name: "host", value: "c.example" }],
			});
			const created = await cli("api", "POST", `/orchestrations/${id}/presets`, "--body", body);
			expect(created.code, created.stderr).toBe(0);
			expect(JSON.parse(created.stdout)).toMatchObject({ name: "压测 C 集群", status: "ok" });

			const result = await cli("run", "start", name, "--preset", "压测 C 集群");
			expect(result.code, result.stderr).toBe(0);
			const [runId] = await runsOf(id);
			expect((await runView(runId as string)).params).toMatchObject({ host: "c.example" });
		});
	});

	describe("run start --preset 报错：退出码 2，stderr 写明原因和下一步，不产生运行", () => {
		it("预设名称不存在：列出这个场景的全部预设（失效的写明原因），名称要完全一致", async () => {
			const { name, id } = await sceneWithAAndInvalidB("没有这个预设");
			const result = await cli("run", "start", name, "--preset", "压测 a 集群");
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				[
					`错误：场景「${name}」没有名称是「压测 a 集群」的运行预设。这个场景的运行预设（名称要完全一致）：`,
					`  ${PRESET_A}`,
					`  ${PRESET_B}（已失效：参数 verbose 已不存在）`,
					`下一步：sfly scenario show ${id}`,
					"",
				].join("\n"),
			);
			expect(await runsOf(id)).toEqual([]);

			const json = await cli("run", "start", name, "--preset", "压测 a 集群", "--json");
			expect(json.code).toBe(2);
			expect(json.stdout).toBe("");
			expect(JSON.parse(json.stderr).error).toMatchObject({
				code: "preset_not_found",
				next: `sfly scenario show ${id}`,
			});
			expect(await runsOf(id)).toEqual([]);
		});

		it("场景还没有运行预设：写明这一点，提示用 sfly api 创建", async () => {
			const { name, id } = await scene("没有预设");
			const result = await cli("run", "start", name, "--preset", PRESET_A);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				[
					`错误：场景「${name}」没有名称是「${PRESET_A}」的运行预设，这个场景还没有任何运行预设。`,
					`新建运行预设：在控制台场景列表的「运行预设…」里，或者 sfly api POST /orchestrations/${id}/presets`,
					"下一步：sfly api --list presets",
					"",
				].join("\n"),
			);
			expect(await runsOf(id)).toEqual([]);
		});

		it("预设已失效：写明是哪个参数、什么原因和怎么修", async () => {
			const { name, id, b } = await sceneWithAAndInvalidB("失效");
			const result = await cli("run", "start", name, "--preset", PRESET_B);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				[
					`错误：运行预设「${PRESET_B}」已失效，不能用来触发：参数 verbose 已不存在`,
					`在控制台场景列表的「运行预设…」里修好它，或者用 sfly api PATCH /orchestrations/${id}/presets/${b.id} 修改。`,
					`下一步：sfly scenario show ${id}`,
					"",
				].join("\n"),
			);
			expect(await runsOf(id)).toEqual([]);

			const json = await cli("run", "start", name, "--preset", PRESET_B, "--json");
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error).toMatchObject({
				code: "preset_invalid",
				message: expect.stringContaining("参数 verbose 已不存在"),
				next: `sfly scenario show ${id}`,
			});
			expect(await runsOf(id)).toEqual([]);
		});

		it("预设里的值不符合参数现在的类型时，原因写明现在的类型；有几个问题就都写出来", async () => {
			const { name, id } = await sceneWithA("类型变了");
			await api.saveVersion(
				id,
				document(
					PRESET_PARAMS.flatMap((p) => {
						if (p.name === "host") return [];
						if (p.name === "port") return [{ ...p, type: "string", default: "80" }];
						return [p];
					}),
				),
			);
			const result = await cli("run", "start", name, "--preset", PRESET_A);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain(
				`错误：运行预设「${PRESET_A}」已失效，不能用来触发：参数 host 已不存在；参数 port 保存的值不符合现在的类型（string）`,
			);
			expect(await runsOf(id)).toEqual([]);
		});

		it("--param 给预设参数传了不同的值：控制面拒绝，报出参数名和预设名", async () => {
			const { name, id } = await sceneWithA("锁定");
			const result = await cli(
				...["run", "start", name, "--preset", PRESET_A],
				...["--param", "host=b.example"],
			);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				[
					`错误：参数 host 由运行预设「${PRESET_A}」固定，请求里不要给它传值`,
					LOCKED_HINT,
					`下一步：sfly scenario show ${id}`,
					"",
				].join("\n"),
			);
			expect(await runsOf(id)).toEqual([]);
		});

		it("secret 预设参数给什么值都拒绝，包括和预设相同的值；错误里不出现这个值", async () => {
			const { name, id } = await sceneWithA("锁定 secret");
			for (const value of [SECRET, "wrong-secret"]) {
				const result = await cli(
					...["run", "start", name, "--preset", PRESET_A],
					...["--params", JSON.stringify({ token: value })],
					"--json",
				);
				expect(result.code).toBe(2);
				expect(result.stdout).toBe("");
				expect(result.stderr).not.toContain(value);
				expect(JSON.parse(result.stderr)).toEqual({
					error: {
						code: "preset_param_locked",
						message: `参数 token 由运行预设「${PRESET_A}」固定，请求里不要给它传值\n${LOCKED_HINT}`,
						next: `sfly scenario show ${id}`,
					},
				});
			}
			expect(await runsOf(id)).toEqual([]);
		});
	});

	describe("预检之后预设变了：控制面拒绝，错误和预检时一样写明原因，带下一步", () => {
		/** 命令行预检、读到预设可用之后，触发请求发出之前，执行 `change`。 */
		const startedAfter = async (name: string, change: () => Promise<unknown>) => {
			const proxy = await startRecordingProxy(cp.httpUrl, async (request) => {
				if (request.method === "POST" && request.path.endsWith("/runs")) await change();
			});
			try {
				return await sfly(["run", "start", name, "--preset", PRESET_A, "--server", proxy.url]);
			} finally {
				await proxy.close();
			}
		};

		it("预设被删除：preset_not_found", async () => {
			const { name, id, preset } = await sceneWithA("触发前删除");
			const result = await startedAfter(name, () => deletePreset(api, id, preset.id));
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				["错误：这个场景没有这个运行预设", `下一步：sfly scenario show ${id}`, ""].join("\n"),
			);
			expect(await runsOf(id)).toEqual([]);
		});

		it("预设失效：preset_invalid", async () => {
			const { name, id } = await sceneWithA("触发前失效");
			const result = await startedAfter(name, () =>
				api.saveVersion(id, document(PRESET_PARAMS.filter((p) => p.name !== "host"))),
			);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				[
					`错误：运行预设「${PRESET_A}」已失效，不能用来触发：参数 host 已不存在`,
					`下一步：sfly scenario show ${id}`,
					"",
				].join("\n"),
			);
			expect(await runsOf(id)).toEqual([]);
		});
	});

	describe("scenario show", () => {
		/** 文本里从「运行预设：」开始、到下一个空行之前的行。 */
		const section = (stdout: string) => {
			const lines = stdout.split("\n");
			const start = lines.indexOf("运行预设：");
			expect(start, stdout).toBeGreaterThan(-1);
			return lines.slice(start, lines.indexOf("", start));
		};

		it("文本：「运行预设」一节写名称、说明、是否可用（失效时写原因）、预设参数和值，secret 打码", async () => {
			const { name } = await sceneWithAAndInvalidB("显示预设");
			const result = await cli("scenario", "show", name);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(section(result.stdout)).toEqual([
				"运行预设：",
				`  ${PRESET_A}  可用`,
				"    说明：A 集群的压测参数",
				"    预设参数：",
				"      参数   值",
				'      host   "a.example"',
				"      port   9000",
				`      token  ${UNMASKED}`,
				`  ${PRESET_B}  已失效：参数 verbose 已不存在`,
				"    预设参数：",
				"      参数     值",
				'      options  {"mode":"fast"}',
				`      verbose  ${UNMASKED}`,
			]);
			expect(result.stdout).not.toContain(SECRET);
		});

		it("--json：presets 里有同样的字段，secret 的值是 ******", async () => {
			const { name, preset, b } = await sceneWithAAndInvalidB("预设的 JSON");
			const result = await cli("scenario", "show", name, "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).not.toContain(SECRET);
			expect(JSON.parse(result.stdout).presets).toEqual([
				{
					id: preset.id,
					name: PRESET_A,
					description: "A 集群的压测参数",
					status: "ok",
					problems: [],
					params: [
						{ name: "host", secret: false, value: "a.example" },
						{ name: "port", secret: false, value: 9000 },
						{ name: "token", secret: true, value: UNMASKED },
					],
				},
				{
					id: b.id,
					name: PRESET_B,
					description: "",
					status: "invalid",
					problems: [{ param: "verbose", reason: "missing" }],
					params: [
						{ name: "options", secret: false, value: { mode: "fast" } },
						{ name: "verbose", secret: true, value: UNMASKED },
					],
				},
			]);
		});

		it("没有运行预设的场景：文本里没有这一节，--json 里是空数组", async () => {
			const { name } = await scene("没有预设可看");
			const text = await cli("scenario", "show", name);
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout).not.toContain("运行预设");
			const json = await cli("scenario", "show", name, "--json");
			expect(JSON.parse(json.stdout).presets).toEqual([]);
		});
	});

	describe("run show", () => {
		it("文本写一行「预设 <名称>」，--json 带 preset；预设改名之后仍是触发时的名称", async () => {
			const { id, preset } = await sceneWithA("运行里的预设");
			const triggered = await triggerWithPreset(api, id, preset.id, { verbose: true });
			expect(triggered.status, await triggered.clone().text()).toBe(201);
			const { id: runId } = (await triggered.json()) as { id: string };

			const text = await cli("run", "show", runId);
			expect(text.code, text.stderr).toBe(0);
			const lines = text.stdout.split("\n");
			expect(lines[1]).toMatch(/^场景 .+，场景版本 1$/);
			expect(lines[2]).toBe(`预设 ${PRESET_A}`);
			expect(lines[3]).toMatch(/^触发 tester，/);
			expect(text.stdout).not.toContain(SECRET);

			await renamePresetInDb(cp, preset.id, "改过的名称");
			const json = await cli("run", "show", runId, "--json");
			expect(json.code, json.stderr).toBe(0);
			expect(json.stdout).not.toContain(SECRET);
			expect(JSON.parse(json.stdout).preset).toEqual({
				id: preset.id,
				name: PRESET_A,
				params: ["host", "port", "token"],
			});
		});

		it("没用预设的运行没有这一行，--json 里的 preset 是 null", async () => {
			const { id } = await sceneWithA("没用预设");
			const runId = await api.triggerOk(id, { host: "h" });
			const text = await cli("run", "show", runId);
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout.split("\n").some((line) => line.startsWith("预设 "))).toBe(false);
			const json = await cli("run", "show", runId, "--json");
			expect(JSON.parse(json.stdout).preset).toBeNull();
		});
	});
});
