// sfly scenario pull / push / create / copy / rename：真实的 sfly 进程编辑测试控制面里的场景。
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { ManualClock } from "./support/manual-clock.js";
import { type RecordingProxy, startRecordingProxy } from "./support/recording-proxy.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SAVED_AT = "2026-03-04T05:06:07.000Z";
const repoRoot = resolve(import.meta.dirname, "../../..");

const entry = { id: "entry", kind: "entry", params: [], position: { x: 40, y: 40 } };

/** 只有入口、Sleep 节点的文档：没有任何保存警告。 */
const sleepDocument = (agent = "agent-a") => ({
	default_agent: agent,
	nodes: [entry, { id: "pause", kind: "sleep", duration: "5s", position: { x: 300, y: 90 } }],
	edges: [{ from: "entry", to: "pause", kind: "chain" }],
	packages: {},
});

interface ScenarioFile {
	scenario: string;
	base_version: number;
	document: {
		default_agent?: string;
		nodes: { id: string; kind: string; position?: { x: number; y: number } }[];
		edges: { from: string; to: string; kind: string }[];
	};
}

type EntryParams = { params: Record<string, unknown>[] };
/** 文档的入口节点（sleepDocument 里的第一个节点）。 */
const entryOf = (document: ScenarioFile["document"]) => document.nodes[0] as unknown as EntryParams;

describe("sfly scenario pull / push / create / copy / rename → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let cliVersion: string;
	let dir: string;
	const clock = new ManualClock(SAVED_AT);
	const proxies: RecordingProxy[] = [];
	let fileCount = 0;

	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const newFile = () => join(dir, `scenario-${++fileCount}.json`);
	const readScenarioFile = async (file: string) =>
		JSON.parse(await readFile(file, "utf8")) as ScenarioFile;
	const writeScenarioFile = (file: string, content: unknown) =>
		writeFile(file, JSON.stringify(content, null, 2));

	const createScenario = async (name: string, document?: unknown): Promise<string> => {
		const res = await api.post("/orchestrations", { name });
		const { id } = (await res.json()) as { id: string };
		if (document) await api.saveVersion(id, document);
		clock.advance(1000);
		return id;
	};
	const head = (id: string) =>
		api.getJson<{ number: number; author: string | null; document: ScenarioFile["document"] }>(
			`/orchestrations/${id}/head`,
		);
	const versions = async (id: string) =>
		(
			await api.getJson<{
				versions: { number: number; author: string; author_via: string | null }[];
			}>(`/orchestrations/${id}/versions`)
		).versions;
	const detail = (id: string) =>
		api.getJson<{ name: string; description: string; head_version: number }>(
			`/orchestrations/${id}`,
		);

	/** pull 到一个新文件，返回文件路径。 */
	const pull = async (ref: string, ...extra: string[]): Promise<string> => {
		const file = newFile();
		const result = await cli("scenario", "pull", ref, "-o", file, ...extra);
		expect(result.code, result.stderr).toBe(0);
		return file;
	};

	beforeAll(async () => {
		cliVersion = (await sfly(["--version"])).stdout.trim().replace(/^sfly /, "");
		cp = await startTestControlPlane({ clock, version: cliVersion });
		api = new ApiClient(cp);
		dir = await mkdtemp(join(tmpdir(), "sfly-scenario-edit-"));
	}, 120_000);

	afterAll(async () => {
		await Promise.all(proxies.map((p) => p.close()));
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	describe("pull", () => {
		it("写出场景 id、最新版本号和场景文档；用 id 或名称指定都行", async () => {
			const id = await createScenario("拉取-基本", sleepDocument("old-agent"));
			await api.saveVersion(id, sleepDocument("agent-a"));

			const file = newFile();
			const result = await cli("scenario", "pull", "拉取-基本", "-o", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				`已把场景「拉取-基本」的最新版本 2 写到 ${file}（base_version 2）。\n`,
			);
			expect(await readScenarioFile(file)).toEqual({
				scenario: id,
				base_version: 2,
				document: (await head(id)).document,
			});
			expect((await readScenarioFile(file)).document.default_agent).toBe("agent-a");

			const byId = await pull(id);
			expect(await readScenarioFile(byId)).toEqual(await readScenarioFile(file));
		});

		it("--version 拉旧版本：文档是旧版本的，base_version 仍是最新版本号", async () => {
			const id = await createScenario("拉取-旧版本", sleepDocument("old-agent"));
			await api.saveVersion(id, sleepDocument("agent-a"));

			const file = newFile();
			const result = await cli("scenario", "pull", id, "-o", file, "--version", "1");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("版本 1");
			expect(result.stdout).toContain("push 会以版本 1 的内容为起点保存新版本");
			const pulled = await readScenarioFile(file);
			expect(pulled.base_version).toBe(2);
			expect(pulled.document.default_agent).toBe("old-agent");
		});

		it("--version 指定的版本不存在时报错，不写文件", async () => {
			const id = await createScenario("拉取-没有这个版本", sleepDocument());
			const file = newFile();
			const result = await cli("scenario", "pull", id, "-o", file, "--version", "9");
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("没有版本 9");
			expect(result.stderr).toContain("最新版本是 1");
			await expect(stat(file)).rejects.toThrow();
		});

		it("还没有保存过版本的场景：写出初始文档，base_version 是 0", async () => {
			const id = await createScenario("拉取-空场景");
			const file = newFile();
			const result = await cli("scenario", "pull", id, "-o", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("还没有保存过版本");
			const pulled = await readScenarioFile(file);
			expect(pulled.base_version).toBe(0);
			expect(pulled.document.nodes.map((n) => n.kind)).toEqual(["entry"]);
		});

		it("不给 -o 时写到当前目录的「场景名.scenario.json」", async () => {
			await createScenario("拉取/默认 文件名", sleepDocument());
			const result = await sfly(["scenario", "pull", "拉取/默认 文件名", "--server", cp.httpUrl], {
				cwd: dir,
				env: { UV_PROJECT: repoRoot },
			});
			expect(result.code, result.stderr).toBe(0);
			const file = join(dir, "拉取-默认-文件名.scenario.json");
			expect(result.stdout).toContain(file);
			expect((await readScenarioFile(file)).base_version).toBe(1);
		});

		it("--json：stdout 是一个对象，写明文件和版本", async () => {
			const id = await createScenario("拉取-json", sleepDocument());
			const file = newFile();
			const result = await cli("scenario", "pull", id, "-o", file, "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				scenario: id,
				name: "拉取-json",
				file,
				version: 1,
				base_version: 1,
			});
		});

		it("场景不存在时报错", async () => {
			const result = await cli("scenario", "pull", "没有这个场景", "-o", newFile());
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("没有 id 或名称是「没有这个场景」的场景");
		});
	});

	describe("push", () => {
		it("pull → 改 → push：保存成新版本，作者是昵称，文件里的 base_version 更新后可以接着 push", async () => {
			const id = await createScenario("推送-基本", sleepDocument());
			const file = await pull(id);

			const edited = await readScenarioFile(file);
			edited.document.default_agent = "agent-b";
			await writeScenarioFile(file, edited);
			const first = await cli("scenario", "push", file, "--nickname", "小林");
			expect(first.code, first.stderr).toBe(0);
			expect(first.stderr).toBe("");
			expect(first.stdout).toContain(`已保存场景 ${id} 的版本 2`);
			expect(first.stdout).toContain(`文件 ${file} 的 base_version 已更新为 2`);
			expect((await readScenarioFile(file)).base_version).toBe(2);
			expect((await head(id)).document.default_agent).toBe("agent-b");
			expect((await versions(id))[0]).toMatchObject({
				number: 2,
				author: "小林",
				author_via: null,
			});

			// 文件里的 base_version 已经是新版本，接着改接着 push。
			edited.base_version = (await readScenarioFile(file)).base_version;
			edited.document.default_agent = "agent-c";
			await writeScenarioFile(file, edited);
			const second = await cli("scenario", "push", file, "--json");
			expect(second.code, second.stderr).toBe(0);
			expect(JSON.parse(second.stdout)).toMatchObject({
				scenario: id,
				version: 3,
				base_version: 2,
				warnings: [],
				file,
			});
			expect((await readScenarioFile(file)).base_version).toBe(3);
			expect((await head(id)).document.default_agent).toBe("agent-c");
		});

		it("保存版本的请求带着昵称和 x-sfly-client（在 AI 编程助手里时带上它的名称）", async () => {
			const id = await createScenario("推送-请求头", sleepDocument());
			const file = await pull(id);
			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);

			const result = await sfly(["scenario", "push", file, "--server", seen.url], {
				env: { SFLY_NICKNAME: "阿杰", CLAUDECODE: "1" },
			});
			expect(result.code, result.stderr).toBe(0);
			const save = seen.requests.filter(
				(r) => r.method === "POST" && r.path === `/orchestrations/${id}/versions`,
			);
			expect(save).toHaveLength(1);
			expect(save[0]?.headers["x-sfly-client"]).toBe(`sfly-cli/${cliVersion} agent/claude-code`);
			expect(save[0]?.headers["x-sfly-nickname"]).toBe(encodeURIComponent("阿杰"));
			expect((await versions(id))[0]).toMatchObject({
				number: 2,
				author: "阿杰",
				author_via: "claude-code",
			});
		});

		it("保存警告：文本里逐条列出，--json 时在 warnings 里", async () => {
			const id = await createScenario("推送-警告", sleepDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.nodes.push({
				id: "deploy",
				kind: "package",
				package: "stub",
				node: "echo",
			} as ScenarioFile["document"]["nodes"][number]);
			edited.document.edges.push({ from: "pause", to: "deploy", kind: "chain" });
			await writeScenarioFile(file, edited);

			const text = await cli("scenario", "push", file);
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout).toContain("警告（1）：");
			expect(text.stdout).toContain("  节点 deploy 的节点包 stub 没有锁定版本");

			const again = await pull(id);
			const json = await cli("scenario", "push", again, "--json");
			expect(json.code, json.stderr).toBe(0);
			expect(JSON.parse(json.stdout).warnings).toEqual([
				{
					code: expect.any(String),
					message: "节点 deploy 的节点包 stub 没有锁定版本",
					node_id: "deploy",
				},
			]);
		});

		it("本地校验没通过：列出出错的位置，不发任何请求，不产生版本", async () => {
			const id = await createScenario("推送-校验失败", sleepDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.nodes.push({ id: "ghost", kind: "teleport" }, { id: "wait", kind: "sleep" });
			(edited.document.edges[0] as { kind: string }).kind = "fly";
			await writeScenarioFile(file, edited);

			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);
			const result = await sfly(["scenario", "push", file, "--server", seen.url]);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("没有通过校验");
			expect(result.stderr).toContain("edges/0/kind");
			expect(result.stderr).toContain("nodes/2/kind");
			expect(result.stderr).toContain("ghost");
			expect(result.stderr).toContain("nodes/3");
			expect(result.stderr).toContain("'duration' is a required property");
			expect(seen.requests).toEqual([]);
			expect((await detail(id)).head_version).toBe(1);

			const json = await sfly(["scenario", "push", file, "--json", "--server", seen.url]);
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error.code).toBe("invalid_document");
			expect(seen.requests).toEqual([]);
		});

		it("带参数说明的文档能 push：说明去掉首尾空白后保存，空说明不保存", async () => {
			const id = await createScenario("推送-参数说明", sleepDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			entryOf(edited.document).params = [
				{ name: "host", type: "string", description: "  目标主机，不带端口  " },
				{ name: "port", type: "number", description: "   " },
				{ name: "tag", type: "string" },
			];
			await writeScenarioFile(file, edited);

			const result = await cli("scenario", "push", file);
			expect(result.code, result.stderr).toBe(0);
			const saved = [
				{
					name: "host",
					type: "string",
					required: false,
					secret: false,
					description: "目标主机，不带端口",
				},
				{ name: "port", type: "number", required: false, secret: false },
				{ name: "tag", type: "string", required: false, secret: false },
			];
			expect(entryOf((await head(id)).document).params).toStrictEqual(saved);
			expect(entryOf((await readScenarioFile(file)).document).params).toStrictEqual(saved);
		});

		it("参数说明最长 200 个字符：200 个 emoji 能 push，201 个本地校验报出位置，控制面的判断相同", async () => {
			const emoji = "😀";
			const id = await createScenario("推送-说明长度", sleepDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			entryOf(edited.document).params = [
				{ name: "host", type: "string", description: emoji.repeat(200) },
			];
			await writeScenarioFile(file, edited);
			const fits = await cli("scenario", "push", file);
			expect(fits.code, fits.stderr).toBe(0);
			expect(entryOf((await head(id)).document).params[0]?.description).toBe(emoji.repeat(200));

			const tooLong = await readScenarioFile(file);
			const param = entryOf(tooLong.document).params[0] as Record<string, unknown>;
			param.description = emoji.repeat(201);
			await writeScenarioFile(file, tooLong);
			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);
			const rejected = await sfly(["scenario", "push", file, "--server", seen.url]);
			expect(rejected.code).toBe(2);
			expect(rejected.stdout).toBe("");
			expect(rejected.stderr).toContain("没有通过校验");
			expect(rejected.stderr).toContain("nodes/0/params/0/description");
			expect(rejected.stderr).toContain("节点 entry");
			expect(seen.requests).toEqual([]);

			const direct = await api.post(`/orchestrations/${id}/versions`, {
				base_version: await api.headVersion(id),
				document: tooLong.document,
			});
			expect(direct.status).toBe(400);
			expect(await direct.json()).toMatchObject({ error: { code: "invalid_document" } });
			expect(await api.headVersion(id)).toBe(2);
		});

		it("参数说明只能写一行：带换行的说明本地校验报出位置，控制面同样拒绝", async () => {
			const id = await createScenario("推送-说明换行", sleepDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			entryOf(edited.document).params = [
				{ name: "host", type: "string", description: "第一行\n第二行" },
			];
			await writeScenarioFile(file, edited);

			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);
			const rejected = await sfly(["scenario", "push", file, "--server", seen.url]);
			expect(rejected.code).toBe(2);
			expect(rejected.stderr).toContain("nodes/0/params/0/description");
			expect(seen.requests).toEqual([]);

			const direct = await api.post(`/orchestrations/${id}/versions`, {
				base_version: 1,
				document: edited.document,
			});
			expect(direct.status).toBe(400);
		});

		it("别人在 pull 之后保存了新版本：报冲突，写明最新版本、作者和时间，不保存，文件不变", async () => {
			const id = await createScenario("推送-冲突", sleepDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.default_agent = "mine";
			await writeScenarioFile(file, edited);
			clock.advance(5000);
			await api.saveVersion(id, sleepDocument("theirs"), "bob");
			const saved = (await api.getJson<{ created_at: string }>(`/orchestrations/${id}/versions/2`))
				.created_at;
			const before = await readFile(file, "utf8");

			const result = await cli("scenario", "push", file);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			const lines = result.stderr.trimEnd().split("\n");
			expect(lines[0]).toBe(
				`错误：场景已有更新的版本：版本 2 由 bob 保存于 ${saved}，你的文件基于版本 1。` +
					"重新 pull，把你的改动合并进去再 push",
			);
			expect(lines[1]).toBe(
				`下一步：sfly scenario pull ${id} -o ${file.replace(/\.json$/, "")}.latest.json`,
			);
			expect(await readFile(file, "utf8")).toBe(before);
			expect((await detail(id)).head_version).toBe(2);
			expect((await head(id)).document.default_agent).toBe("theirs");

			const json = await cli("scenario", "push", file, "--json");
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error.code).toBe("version_conflict");

			// 按提示重新 pull，把改动合并进去再 push。
			const latest = await pull(id);
			const merged = await readScenarioFile(latest);
			merged.document.default_agent = "merged";
			await writeScenarioFile(latest, merged);
			expect((await cli("scenario", "push", latest)).code).toBe(0);
			expect((await head(id)).document.default_agent).toBe("merged");
		});

		it("文件不是 pull 写出的格式时报错：不是 JSON、缺字段、读不到", async () => {
			const notJson = newFile();
			await writeFile(notJson, "{ nodes: [");
			const a = await cli("scenario", "push", notJson);
			expect(a.code).toBe(2);
			expect(a.stderr).toContain(`${notJson} 不是合法的 JSON`);

			const noBase = newFile();
			await writeScenarioFile(noBase, { scenario: "x", document: sleepDocument() });
			const b = await cli("scenario", "push", noBase);
			expect(b.code).toBe(2);
			expect(b.stderr).toContain("base_version");
			expect(b.stderr).toContain("sfly scenario pull");

			const noDocument = newFile();
			await writeScenarioFile(noDocument, { scenario: "x", base_version: 1 });
			const c = await cli("scenario", "push", noDocument);
			expect(c.code).toBe(2);
			expect(c.stderr).toContain("document");

			const missing = await cli("scenario", "push", join(dir, "没有这个文件.json"));
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("没有这个文件.json");
		});

		it("文件里的场景 id 不存在时报错", async () => {
			const file = newFile();
			const unknown = "00000000-0000-4000-8000-000000000000";
			await writeScenarioFile(file, {
				scenario: unknown,
				base_version: 0,
				document: sleepDocument(),
			});
			const result = await cli("scenario", "push", file);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain(`没有 id 是 ${unknown} 的场景`);
		});

		it("没有坐标的节点由控制面补上（和整理布局一致），原有节点的坐标不变", async () => {
			const id = await createScenario("推送-补坐标", sleepDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.nodes.push({ id: "tail", kind: "sleep", duration: "1s" } as never);
			edited.document.edges.push({ from: "pause", to: "tail", kind: "chain" });
			await writeScenarioFile(file, edited);
			expect((await cli("scenario", "push", file)).code).toBe(0);

			const again = await readScenarioFile(await pull(id));
			const positions = Object.fromEntries(again.document.nodes.map((n) => [n.id, n.position]));
			expect(positions).toEqual({
				entry: { x: 40, y: 40 },
				pause: { x: 300, y: 90 },
				// 整理布局给的 (504, 0) 压在 pause 上，往右下错开一步。
				tail: { x: 536, y: 32 },
			});
		});

		it("push 成功后文件里写回控制面实际保存的文档（含补好的坐标），再 push 同一个文件坐标不变", async () => {
			const id = await createScenario("推送-写回坐标", sleepDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.nodes.push({ id: "tail", kind: "sleep", duration: "1s" } as never);
			edited.document.edges.push({ from: "pause", to: "tail", kind: "chain" });
			await writeScenarioFile(file, edited);

			const first = await cli("scenario", "push", file);
			expect(first.code, first.stderr).toBe(0);
			const pushed = await readScenarioFile(file);
			expect(pushed.base_version).toBe(2);
			expect(pushed.document.nodes.every((n) => n.position)).toBe(true);
			expect(pushed.document).toEqual((await head(id)).document);
			expect(pushed.document).toEqual((await readScenarioFile(await pull(id))).document);

			const second = await cli("scenario", "push", file);
			expect(second.code, second.stderr).toBe(0);
			const again = await readScenarioFile(file);
			expect(again.base_version).toBe(3);
			expect(again.document).toEqual(pushed.document);
			expect((await head(id)).document).toEqual(pushed.document);
		});

		it("所有节点都没有坐标时整份文档按整理布局排好；浏览器保存的带坐标的版本原样保留", async () => {
			const id = await createScenario("推送-全部补坐标");
			const file = newFile();
			await writeScenarioFile(file, {
				scenario: id,
				base_version: 0,
				document: {
					nodes: [
						{ id: "entry", kind: "entry" },
						{ id: "a", kind: "sleep", duration: "1s" },
						{ id: "b", kind: "sleep", duration: "1s" },
					],
					edges: [
						{ from: "entry", to: "a", kind: "chain" },
						{ from: "a", to: "b", kind: "chain" },
					],
				},
			});
			expect((await cli("scenario", "push", file)).code).toBe(0);
			expect((await head(id)).document.nodes.map((n) => [n.id, n.position])).toEqual([
				["entry", { x: 0, y: 0 }],
				["a", { x: 252, y: 0 }],
				["b", { x: 504, y: 0 }],
			]);

			const moved = {
				...sleepDocument(),
				nodes: [
					{ ...entry, position: { x: -120.5, y: 33 } },
					{ id: "pause", kind: "sleep", duration: "5s", position: { x: 999, y: -7 } },
				],
			};
			await api.saveVersion(id, moved);
			expect((await head(id)).document.nodes.map((n) => n.position)).toEqual([
				{ x: -120.5, y: 33 },
				{ x: 999, y: -7 },
			]);
		});
	});

	describe("create", () => {
		it("新建场景：名称和说明，还没有版本", async () => {
			const result = await cli(
				"scenario",
				"create",
				"--name",
				"新建-空场景",
				"--description",
				"联调用",
			);
			expect(result.code, result.stderr).toBe(0);
			const id = /（([0-9a-f-]{36})）/.exec(result.stdout)?.[1] as string;
			expect(result.stdout).toContain("已新建场景「新建-空场景」");
			expect(await detail(id)).toMatchObject({
				name: "新建-空场景",
				description: "联调用",
				head_version: 0,
			});

			const json = await cli("scenario", "create", "--name", "新建-空场景-json", "--json");
			expect(json.code, json.stderr).toBe(0);
			expect(JSON.parse(json.stdout)).toMatchObject({
				name: "新建-空场景-json",
				description: "",
				head_version: 0,
				warnings: [],
			});
		});

		it("--from 文件：同时保存第一个版本，作者是昵称，保存警告一并输出", async () => {
			const source = await createScenario("新建-来源", sleepDocument("from-agent"));
			const file = await pull(source);
			const edited = await readScenarioFile(file);
			edited.document.nodes.push({
				id: "deploy",
				kind: "package",
				package: "stub",
				node: "echo",
			} as never);
			edited.document.edges.push({ from: "pause", to: "deploy", kind: "chain" });
			await writeScenarioFile(file, edited);

			const result = await cli(
				"scenario",
				"create",
				"--name",
				"新建-来自文件",
				"--from",
				file,
				"--nickname",
				"小林",
			);
			expect(result.code, result.stderr).toBe(0);
			const id = /（([0-9a-f-]{36})）/.exec(result.stdout)?.[1] as string;
			expect(id).not.toBe(source);
			expect(result.stdout).toContain("保存了版本 1");
			expect(result.stdout).toContain("  节点 deploy 的节点包 stub 没有锁定版本");
			expect(await detail(id)).toMatchObject({ name: "新建-来自文件", head_version: 1 });
			expect((await versions(id))[0]).toMatchObject({
				number: 1,
				author: "小林",
				author_via: null,
			});
			const created = await head(id);
			expect(created.document.default_agent).toBe("from-agent");
			expect(created.document.nodes.map((n) => n.id)).toEqual(["entry", "pause", "deploy"]);
			expect((await head(source)).number).toBe(1);
		});

		it("经 AI 编程助手创建并保存第一个版本时，版本上记着检测到的名称", async () => {
			const file = newFile();
			await writeScenarioFile(file, { document: sleepDocument() });
			const result = await sfly(
				["scenario", "create", "--name", "新建-经助手", "--from", file, "--server", cp.httpUrl],
				{ env: { CODEX_SANDBOX: "seatbelt", SFLY_NICKNAME: "小林" } },
			);
			expect(result.code, result.stderr).toBe(0);
			const id = /（([0-9a-f-]{36})）/.exec(result.stdout)?.[1] as string;
			expect((await versions(id))[0]).toMatchObject({
				number: 1,
				author: "小林",
				author_via: "codex",
			});
		});

		it("--from 的文件可以只有 document（不需要 scenario 和 base_version）", async () => {
			const file = newFile();
			await writeScenarioFile(file, { document: sleepDocument("only-doc") });
			const result = await cli("scenario", "create", "--name", "新建-只有文档", "--from", file);
			expect(result.code, result.stderr).toBe(0);
			const id = /（([0-9a-f-]{36})）/.exec(result.stdout)?.[1] as string;
			expect((await head(id)).document.default_agent).toBe("only-doc");
		});

		it("--from 的文档没有通过校验时报错，也不会新建场景", async () => {
			const before = (await api.getJson<{ orchestrations: unknown[] }>("/orchestrations"))
				.orchestrations.length;
			const file = newFile();
			await writeScenarioFile(file, {
				document: {
					nodes: [
						{ id: "entry", kind: "entry" },
						{ id: "x", kind: "teleport" },
					],
				},
			});
			const result = await cli("scenario", "create", "--name", "新建-不会出现", "--from", file);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("nodes/1/kind");
			const after = (await api.getJson<{ orchestrations: unknown[] }>("/orchestrations"))
				.orchestrations.length;
			expect(after).toBe(before);
		});
	});

	describe("copy", () => {
		it("复制场景：新场景的第 1 版是源场景最新版本的内容，源场景不变", async () => {
			const source = await createScenario("复制-来源", sleepDocument("old-agent"));
			await api.saveVersion(source, sleepDocument("latest-agent"));

			const result = await cli("scenario", "copy", "复制-来源", "--name", "复制-副本");
			expect(result.code, result.stderr).toBe(0);
			const id = /（([0-9a-f-]{36})）/.exec(result.stdout)?.[1] as string;
			expect(id).not.toBe(source);
			expect(result.stdout).toContain("已把场景「复制-来源」复制为「复制-副本」");
			expect(await detail(id)).toMatchObject({ name: "复制-副本", head_version: 1 });
			expect((await head(id)).document.default_agent).toBe("latest-agent");
			expect((await detail(source)).head_version).toBe(2);

			const json = await cli("scenario", "copy", source, "--name", "复制-副本-json", "--json");
			expect(json.code, json.stderr).toBe(0);
			expect(JSON.parse(json.stdout)).toMatchObject({
				name: "复制-副本-json",
				head_version: 1,
				source: source,
			});
		});

		it("源场景指定不明确或不存在时报错", async () => {
			const result = await cli("scenario", "copy", "没有这个场景", "--name", "x");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("没有 id 或名称是「没有这个场景」的场景");
		});
	});

	describe("rename", () => {
		it("修改名称和说明，不产生新版本", async () => {
			const id = await createScenario("改名-原名", sleepDocument());
			const before = await versions(id);

			const name = await cli("scenario", "rename", id, "--name", "改名-新名");
			expect(name.code, name.stderr).toBe(0);
			expect(name.stdout).toContain("已修改场景「改名-新名」");
			expect(name.stdout).toContain("没有产生新版本");
			expect(await detail(id)).toMatchObject({ name: "改名-新名", description: "" });

			const description = await cli("scenario", "rename", "改名-新名", "--description", "新的说明");
			expect(description.code, description.stderr).toBe(0);
			expect(await detail(id)).toMatchObject({ name: "改名-新名", description: "新的说明" });

			const both = await cli(
				"scenario",
				"rename",
				id,
				"--name",
				"改名-最终",
				"--description",
				"",
				"--json",
			);
			expect(both.code, both.stderr).toBe(0);
			expect(JSON.parse(both.stdout)).toMatchObject({
				id,
				name: "改名-最终",
				description: "",
				head_version: 1,
			});
			expect(await detail(id)).toMatchObject({ name: "改名-最终", description: "" });

			expect(await versions(id)).toEqual(before);
		});

		it("没有给 --name 也没有给 --description 时报错", async () => {
			const id = await createScenario("改名-没改什么", sleepDocument());
			const result = await cli("scenario", "rename", id);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("--name");
			expect(result.stderr).toContain("--description");
			expect((await detail(id)).name).toBe("改名-没改什么");
		});

		it("名称是空白时报错，场景不变", async () => {
			const id = await createScenario("改名-空名称", sleepDocument());
			const result = await cli("scenario", "rename", id, "--name", "   ");
			expect(result.code).toBe(2);
			expect((await detail(id)).name).toBe("改名-空名称");
		});
	});
});
