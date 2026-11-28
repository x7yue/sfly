// sfly scenario pull / push / create / copy / rename：真实的 sfly 进程编辑测试控制面里的场景。
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { addDocumentFields } from "./support/legacy-document.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { type RecordingProxy, startRecordingProxy } from "./support/recording-proxy.js";
import { registerAgents } from "./support/registered-agents.js";
import { sfly } from "./support/sfly-cli.js";
import { paramsOf, storedDocument } from "./support/stored-document.js";
import { storeNodeField } from "./support/stored-over-limit.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SAVED_AT = "2026-03-04T05:06:07.000Z";
const repoRoot = resolve(import.meta.dirname, "../../..");

const entry = { id: "entry", kind: "entry", params: [], position: { x: 40, y: 40 } };

/** 一个 demo/echo 包节点（节点包 demo 在 beforeAll 里发布）。 */
const demoNode = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: "demo",
	node: "echo",
	...extra,
});

/** 只有入口、一个包节点的文档：没有任何保存警告。 */
const echoDocument = (agent = "agent-a") => ({
	default_agent: agent,
	nodes: [entry, demoNode("pause", { position: { x: 300, y: 90 } })],
	edges: [{ from: "entry", to: "pause", kind: "chain" }],
	packages: { demo: "1.0.0" },
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
/** 文档的入口节点（echoDocument 里的第一个节点）。 */
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
		const res = await api.post("/projects/default/orchestrations", { name });
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
		// 文档里的包节点锁定的版本已发布、派发到的 Agent 注册过：保存时没有警告。
		await publishPackage(cp, "demo", "1.0.0", { echo: ["v"] });
		await registerAgents(cp.database.url, ["agent-a", "agent-b", "agent-c"]);
		dir = await mkdtemp(join(tmpdir(), "sfly-scenario-edit-"));
	}, 120_000);

	afterAll(async () => {
		await Promise.all(proxies.map((p) => p.close()));
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	describe("pull", () => {
		it("写出场景 id、最新版本号和场景文档；用 id 或名称指定都行", async () => {
			const id = await createScenario("拉取-基本", echoDocument("old-agent"));
			await api.saveVersion(id, echoDocument("agent-a"));

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
			const id = await createScenario("拉取-旧版本", echoDocument("old-agent"));
			await api.saveVersion(id, echoDocument("agent-a"));

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
			const id = await createScenario("拉取-没有这个版本", echoDocument());
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
			await createScenario("拉取/默认 文件名", echoDocument());
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
			const id = await createScenario("拉取-json", echoDocument());
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
			const id = await createScenario("推送-基本", echoDocument());
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

		it("保存版本的请求带着令牌和 x-sfly-client（在 AI 编程助手里时带上它的名称），作者是令牌的用户", async () => {
			const id = await createScenario("推送-请求头", echoDocument());
			const file = await pull(id);
			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);

			// 经代理连控制面：默认凭据认不出代理的地址，自己给阿杰的个人令牌。
			const token = await cp.users.token("阿杰");
			const result = await sfly(["scenario", "push", file, "--server", seen.url], {
				env: { CLAUDECODE: "1", SFLY_API_TOKEN: token },
			});
			expect(result.code, result.stderr).toBe(0);
			const save = seen.requests.filter(
				(r) => r.method === "POST" && r.path === `/orchestrations/${id}/versions`,
			);
			expect(save).toHaveLength(1);
			expect(save[0]?.headers["x-sfly-client"]).toBe(`sfly-cli/${cliVersion} agent/claude-code`);
			expect(save[0]?.headers.authorization).toBe(`Bearer ${token}`);
			expect((await versions(id))[0]).toMatchObject({
				number: 2,
				author: "阿杰",
				author_via: "claude-code",
			});
		});

		it("保存警告：文本里逐条列出，--json 时在 warnings 里", async () => {
			const id = await createScenario("推送-警告", echoDocument());
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
			const id = await createScenario("推送-校验失败", echoDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.nodes.push(
				{ id: "ghost", kind: "teleport" },
				{ id: "wait", kind: "package" },
			);
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
			expect(result.stderr).toContain("'package' is a required property");
			expect(seen.requests).toEqual([]);
			expect((await detail(id)).head_version).toBe(1);

			const json = await sfly(["scenario", "push", file, "--json", "--server", seen.url]);
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error.code).toBe("invalid_document");
			expect(seen.requests).toEqual([]);
		});

		it("带参数说明的文档能 push：说明去掉首尾空白后保存，空说明不保存", async () => {
			const id = await createScenario("推送-参数说明", echoDocument());
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
			const id = await createScenario("推送-说明长度", echoDocument());
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
			const id = await createScenario("推送-说明换行", echoDocument());
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

		it("带显示名称的文档能 push：名称去掉首尾空白后保存，空白的名称不保存，pull 回来的文件一致", async () => {
			const id = await createScenario("推送-显示名称", echoDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.nodes = [
				{ ...edited.document.nodes[0], display_name: "   " },
				{ ...edited.document.nodes[1], display_name: "  等缓存刷新  " },
			] as unknown as ScenarioFile["document"]["nodes"];
			await writeScenarioFile(file, edited);

			const result = await cli("scenario", "push", file);
			expect(result.code, result.stderr).toBe(0);
			const nodes = (await head(id)).document.nodes;
			expect(nodes[0]).not.toHaveProperty("display_name");
			expect(nodes[1]).toMatchObject({ id: "pause", display_name: "等缓存刷新" });
			expect((await readScenarioFile(file)).document.nodes).toEqual(nodes);
			expect((await readScenarioFile(await pull(id))).document.nodes).toEqual(nodes);
		});

		it("显示名称最长 40 个字符：40 个 emoji 能 push，41 个本地校验报出位置，控制面的判断相同", async () => {
			const emoji = "😀";
			const id = await createScenario("推送-名称长度", echoDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			const pause = edited.document.nodes[1] as Record<string, unknown>;
			pause.display_name = emoji.repeat(40);
			await writeScenarioFile(file, edited);
			const fits = await cli("scenario", "push", file);
			expect(fits.code, fits.stderr).toBe(0);
			expect((await head(id)).document.nodes[1]).toMatchObject({ display_name: emoji.repeat(40) });

			const tooLong = await readScenarioFile(file);
			(tooLong.document.nodes[1] as Record<string, unknown>).display_name = emoji.repeat(41);
			await writeScenarioFile(file, tooLong);
			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);
			const rejected = await sfly(["scenario", "push", file, "--server", seen.url]);
			expect(rejected.code).toBe(2);
			expect(rejected.stdout).toBe("");
			expect(rejected.stderr).toContain("没有通过校验");
			expect(rejected.stderr).toContain("nodes/1/display_name");
			expect(rejected.stderr).toContain("节点 pause");
			expect(seen.requests).toEqual([]);

			const direct = await api.post(`/orchestrations/${id}/versions`, {
				base_version: await api.headVersion(id),
				document: tooLong.document,
			});
			expect(direct.status).toBe(400);
			expect(await direct.json()).toMatchObject({ error: { code: "invalid_document" } });
			expect(await api.headVersion(id)).toBe(2);
		});

		it("显示名称只能写一行：带换行的名称本地校验报出位置，控制面同样拒绝", async () => {
			const id = await createScenario("推送-名称换行", echoDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			(edited.document.nodes[1] as Record<string, unknown>).display_name = "第一行\n第二行";
			await writeScenarioFile(file, edited);

			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);
			const rejected = await sfly(["scenario", "push", file, "--server", seen.url]);
			expect(rejected.code).toBe(2);
			expect(rejected.stderr).toContain("nodes/1/display_name");
			expect(seen.requests).toEqual([]);

			const direct = await api.post(`/orchestrations/${id}/versions`, {
				base_version: 1,
				document: edited.document,
			});
			expect(direct.status).toBe(400);
		});

		it("子流程入口节点没有显示名称这个字段：写了本地校验报出位置，控制面同样拒绝", async () => {
			const id = await createScenario("推送-子流程入口名称", echoDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.nodes.push({
				id: "sub",
				kind: "subflow_entry",
				name: "report",
				display_name: "不该有",
				params: [],
			} as unknown as ScenarioFile["document"]["nodes"][number]);
			await writeScenarioFile(file, edited);

			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);
			const rejected = await sfly(["scenario", "push", file, "--server", seen.url]);
			expect(rejected.code).toBe(2);
			expect(rejected.stderr).toContain("nodes/2");
			expect(rejected.stderr).toContain("display_name");
			expect(seen.requests).toEqual([]);

			const direct = await api.post(`/orchestrations/${id}/versions`, {
				base_version: 1,
				document: edited.document,
			});
			expect(direct.status).toBe(400);
		});

		it("别人在 pull 之后保存了新版本：报冲突，写明最新版本、作者和时间，不保存，文件不变", async () => {
			const id = await createScenario("推送-冲突", echoDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.default_agent = "mine";
			await writeScenarioFile(file, edited);
			clock.advance(5000);
			await api.saveVersion(id, echoDocument("theirs"), "bob");
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
			await writeScenarioFile(noBase, { scenario: "x", document: echoDocument() });
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
				document: echoDocument(),
			});
			const result = await cli("scenario", "push", file);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain(`没有 id 是 ${unknown} 的场景`);
		});

		it("没有坐标的节点由控制面补上（和整理布局一致），原有节点的坐标不变", async () => {
			const id = await createScenario("推送-补坐标", echoDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			// 把 pause 挪到整理布局给 tail 的位置 (600, 0) 附近，让这个位置被压住。
			const pause = edited.document.nodes.find((n) => n.id === "pause");
			if (pause) pause.position = { x: 640, y: 30 };
			edited.document.nodes.push(demoNode("tail") as never);
			edited.document.edges.push({ from: "pause", to: "tail", kind: "chain" });
			await writeScenarioFile(file, edited);
			expect((await cli("scenario", "push", file)).code).toBe(0);

			const again = await readScenarioFile(await pull(id));
			const positions = Object.fromEntries(again.document.nodes.map((n) => [n.id, n.position]));
			expect(positions).toEqual({
				entry: { x: 40, y: 40 },
				pause: { x: 640, y: 30 },
				// 整理布局给的 (600, 0) 压在 pause 上，往右下错开几步，直到不再压住。
				tail: { x: 696, y: 96 },
			});
		});

		it("push 成功后文件里写回控制面实际保存的文档（含补好的坐标），再 push 同一个文件坐标不变", async () => {
			const id = await createScenario("推送-写回坐标", echoDocument());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			edited.document.nodes.push(demoNode("tail") as never);
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
					default_agent: "agent-a",
					nodes: [{ id: "entry", kind: "entry" }, demoNode("a"), demoNode("b")],
					edges: [
						{ from: "entry", to: "a", kind: "chain" },
						{ from: "a", to: "b", kind: "chain" },
					],
					packages: { demo: "1.0.0" },
				},
			});
			expect((await cli("scenario", "push", file)).code).toBe(0);
			expect((await head(id)).document.nodes.map((n) => [n.id, n.position])).toEqual([
				["entry", { x: 0, y: 0 }],
				["a", { x: 300, y: 0 }],
				["b", { x: 600, y: 0 }],
			]);

			const moved = {
				...echoDocument(),
				nodes: [
					{ ...entry, position: { x: -120.5, y: 33 } },
					demoNode("pause", { position: { x: 999, y: -7 } }),
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
			const source = await createScenario("新建-来源", echoDocument("from-agent"));
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
			await writeScenarioFile(file, { document: echoDocument() });
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
			await writeScenarioFile(file, { document: echoDocument("only-doc") });
			const result = await cli("scenario", "create", "--name", "新建-只有文档", "--from", file);
			expect(result.code, result.stderr).toBe(0);
			const id = /（([0-9a-f-]{36})）/.exec(result.stdout)?.[1] as string;
			expect((await head(id)).document.default_agent).toBe("only-doc");
		});

		it("--from 的文档没有通过校验时报错，也不会新建场景", async () => {
			const before = (
				await api.getJson<{ orchestrations: unknown[] }>("/projects/default/orchestrations")
			).orchestrations.length;
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
			const after = (
				await api.getJson<{ orchestrations: unknown[] }>("/projects/default/orchestrations")
			).orchestrations.length;
			expect(after).toBe(before);
		});
	});

	describe("copy", () => {
		it("复制场景：新场景的第 1 版是源场景最新版本的内容，源场景不变", async () => {
			const source = await createScenario("复制-来源", echoDocument("old-agent"));
			await api.saveVersion(source, echoDocument("latest-agent"));

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

		it("源场景里存着超限的超时、排队超时（升级前保存的）：照样复制，警告写明是哪个节点的哪个字段，--json 里也有", async () => {
			const source = await createScenario("复制-超限来源", echoDocument());
			await storeNodeField(cp.database.url, source, "pause", "timeout", 5_000_000_000);
			await storeNodeField(cp.database.url, source, "pause", "queue_timeout", 9_000_000_000_000);

			const result = await cli("scenario", "copy", source, "--name", "复制-超限副本");

			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("已把场景「复制-超限来源」复制为「复制-超限副本」");
			expect(result.stdout).toContain("警告（2）：");
			expect(result.stdout).toContain(
				"节点 pause：timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 5000000000",
			);
			expect(result.stdout).toContain(
				"节点 pause：queue_timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 9000000000000",
			);
			const json = await cli("scenario", "copy", source, "--name", "复制-超限副本-json", "--json");
			expect(json.code, json.stderr).toBe(0);
			const { warnings } = JSON.parse(json.stdout) as { warnings: Array<{ code: string }> };
			expect(warnings.map((w) => w.code).sort()).toEqual([
				"queue_timeout_out_of_range",
				"timeout_out_of_range",
			]);
		});

		it("源场景没有问题时复制的输出里没有警告", async () => {
			await createScenario("复制-干净来源", echoDocument());

			const result = await cli("scenario", "copy", "复制-干净来源", "--name", "复制-干净副本");

			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).not.toContain("警告");
		});

		it("源场景指定不明确或不存在时报错", async () => {
			const result = await cli("scenario", "copy", "没有这个场景", "--name", "x");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("没有 id 或名称是「没有这个场景」的场景");
		});
	});

	describe("rename", () => {
		it("修改名称和说明，不产生新版本", async () => {
			const id = await createScenario("改名-原名", echoDocument());
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
			const id = await createScenario("改名-没改什么", echoDocument());
			const result = await cli("scenario", "rename", id);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("--name");
			expect(result.stderr).toContain("--description");
			expect((await detail(id)).name).toBe("改名-没改什么");
		});

		it("名称是空白时报错，场景不变", async () => {
			const id = await createScenario("改名-空名称", echoDocument());
			const result = await cli("scenario", "rename", id, "--name", "   ");
			expect(result.code).toBe(2);
			expect((await detail(id)).name).toBe("改名-空名称");
		});
	});
	describe("secret 参数的默认值（#467）", () => {
		const SECRET = "test-secret-value";
		const MASK = "******";
		/** 入口有一个 secret 参数（带默认值）和一个普通参数的文档。 */
		const withSecret = (secret: unknown = SECRET) => ({
			...echoDocument(),
			nodes: [
				{
					...entry,
					params: [
						{ name: "token", type: "string", secret: true, default: secret },
						{ name: "region", type: "string", default: "cn-east" },
					],
				},
				...echoDocument().nodes.slice(1),
			],
		});

		it("pull 得到的文件里 secret 默认值是占位符，普通参数的默认值照旧，并提示怎么处理", async () => {
			const id = await createScenario("secret-拉取", withSecret());
			const file = newFile();
			const result = await cli("scenario", "pull", id, "-o", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("占位符 ******");
			expect(result.stdout).toContain("沿用");
			const text = await readFile(file, "utf8");
			expect(text).not.toContain(SECRET);
			const content = await readScenarioFile(file);
			expect(entryOf(content.document).params).toMatchObject([
				{ name: "token", secret: true, default: MASK },
				{ name: "region", secret: false, default: "cn-east" },
			]);
			// 不含 secret 的场景没有这条提示。
			const plain = await createScenario("secret-拉取-没有", echoDocument());
			expect((await cli("scenario", "pull", plain, "-o", newFile())).stdout).not.toContain(
				"占位符",
			);
		});

		it("pull 之后不改动直接 push：新版本里的默认值仍是原值，文件里写回的还是占位符", async () => {
			const id = await createScenario("secret-原样推送", withSecret());
			const file = await pull(id);
			const result = await cli("scenario", "push", file);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).not.toContain(SECRET);
			// secret 参数写了默认值：保存时提醒（默认值会留在这个版本里）。
			expect(result.stdout).toContain("警告");
			expect(result.stdout).toContain("token");
			expect(paramsOf(await storedDocument(cp, id, 2))[0]?.default).toBe(SECRET);
			expect(await readFile(file, "utf8")).not.toContain(SECRET);
			expect((await readScenarioFile(file)).base_version).toBe(2);
			// 接着改别的字段再 push：仍然沿用。
			const edited = await readScenarioFile(file);
			edited.document.default_agent = "another";
			await writeScenarioFile(file, edited);
			expect((await cli("scenario", "push", file)).code).toBe(0);
			expect(paramsOf(await storedDocument(cp, id, 3))[0]?.default).toBe(SECRET);
		});

		it("改成新的值再 push：存的是新值，文件里写回的是占位符", async () => {
			const id = await createScenario("secret-新值", withSecret());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			const [token] = entryOf(edited.document).params;
			if (token) token.default = "test-secret-replaced";
			await writeScenarioFile(file, edited);
			const result = await cli("scenario", "push", file);
			expect(result.code, result.stderr).toBe(0);
			expect(paramsOf(await storedDocument(cp, id, 2))[0]?.default).toBe("test-secret-replaced");
			const after = await readFile(file, "utf8");
			expect(after).not.toContain("test-secret-replaced");
			expect(after).toContain(MASK);
		});

		it("--version 拉旧版本再 push：占位符沿用的是最新版本的值，pull 时写明", async () => {
			const id = await createScenario("secret-旧版本", withSecret("test-secret-old"));
			await api.saveVersion(id, withSecret("test-secret-latest"));
			const file = newFile();
			const pulled = await cli("scenario", "pull", id, "-o", file, "--version", "1");
			expect(pulled.code, pulled.stderr).toBe(0);
			expect(pulled.stdout).toContain("最新版本 2");
			expect((await cli("scenario", "push", file)).code).toBe(0);
			expect(paramsOf(await storedDocument(cp, id, 3))[0]?.default).toBe("test-secret-latest");
		});

		it("参数改了名、占位符还在：控制面拒绝，写明哪个参数，没有产生版本，文件不变", async () => {
			const id = await createScenario("secret-改名", withSecret());
			const file = await pull(id);
			const edited = await readScenarioFile(file);
			const [token] = entryOf(edited.document).params;
			if (token) token.name = "access_token";
			await writeScenarioFile(file, edited);
			const before = await readFile(file, "utf8");
			const result = await cli("scenario", "push", file);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("没有保存");
			expect(result.stderr).toContain("节点 entry 的参数 access_token");
			expect(result.stderr).not.toContain(SECRET);
			expect(await readFile(file, "utf8")).toBe(before);
			expect((await detail(id)).head_version).toBe(1);
			const json = await cli("scenario", "push", file, "--json");
			expect(JSON.parse(json.stderr).error.code).toBe("secret_default_placeholder");
		});

		it("create --from 带着占位符的文件：新场景没有上一个版本可以沿用，报错，不新建场景", async () => {
			const source = await createScenario("secret-新建来源", withSecret());
			const file = await pull(source);
			const result = await cli("scenario", "create", "--name", "secret-新建副本", "--from", file);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("没有新建场景");
			expect(result.stderr).toContain("节点 entry 的参数 token");
			expect(result.stderr).toContain(`sfly scenario copy ${source} --name <新名称>`);
			const listing = await cli("scenario", "list", "--json", "--search", "secret-新建副本");
			expect(JSON.parse(listing.stdout)).toEqual([]);
			// 写上默认值（或删掉 default）就能新建。
			const edited = await readScenarioFile(file);
			const [token] = entryOf(edited.document).params;
			if (token) token.default = "test-secret-fresh";
			await writeScenarioFile(file, edited);
			const created = await cli("scenario", "create", "--name", "secret-新建副本", "--from", file);
			expect(created.code, created.stderr).toBe(0);
		});

		it("copy：secret 默认值跟着复制，读副本仍是占位符；show 和 versions 的输出里没有原值", async () => {
			const source = await createScenario("secret-复制来源", withSecret());
			const copied = await cli("scenario", "copy", source, "--name", "secret-复制副本", "--json");
			expect(copied.code, copied.stderr).toBe(0);
			const { id } = JSON.parse(copied.stdout) as { id: string };
			expect(paramsOf(await storedDocument(cp, id, 1))[0]?.default).toBe(SECRET);
			const copyFile = await pull(id);
			expect(await readFile(copyFile, "utf8")).not.toContain(SECRET);

			for (const args of [
				["scenario", "show", source],
				["scenario", "show", source, "--json"],
				["scenario", "versions", source],
				["scenario", "list"],
			]) {
				const result = await cli(...args);
				expect(result.code, result.stderr).toBe(0);
				expect(result.stdout + result.stderr, args.join(" ")).not.toContain(SECRET);
			}
		});
	});

	describe("移除之前保存的场景：版本里带着便签（sticky_notes，ADR 0028）", () => {
		const stickyNotes = [{ id: "sticky_1", title: "跑之前确认", text: "- Agent 都在线" }];
		const removedMessage =
			"场景文档里的 sticky_notes（便签）有 1 条内容，已不再支持，不能保存：先把要留的内容挪走，再把这一项删掉。替换办法：便签：要留的内容写进节点的备注或注释框的备注";

		it("pull 写出的文档里没有 sticky_notes，show 不列便签；原样 push 保存的新版本里也没有，旧版本不动", async () => {
			const id = await createScenario("legacy-pull", echoDocument());
			await addDocumentFields(cp, id, { sticky_notes: stickyNotes }, 1);

			const file = await pull(id);
			expect((await readScenarioFile(file)).document).not.toHaveProperty("sticky_notes");

			const text = await cli("scenario", "show", id);
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout).not.toContain("便签");
			expect(text.stdout).not.toContain("跑之前确认");
			const json = JSON.parse((await cli("scenario", "show", id, "--json")).stdout);
			expect(json).not.toHaveProperty("sticky_notes");

			const pushed = await cli("scenario", "push", file);
			expect(pushed.code, pushed.stderr).toBe(0);
			expect(await storedDocument(cp, id, 2)).not.toHaveProperty("sticky_notes");
			expect(await storedDocument(cp, id, 1)).toHaveProperty("sticky_notes", stickyNotes);
		});

		it("push 一个仍带着有内容的 sticky_notes 的旧文件：本地校验写明有几条、怎么办，不发请求；删掉这一项后保存成功", async () => {
			const id = await createScenario("legacy-push", echoDocument());
			const file = await pull(id);
			const old = await readScenarioFile(file);
			await writeScenarioFile(file, {
				...old,
				document: { ...old.document, sticky_notes: stickyNotes },
			});

			const seen = await startRecordingProxy(cp.httpUrl);
			proxies.push(seen);
			const rejected = await sfly(["scenario", "push", file, "--server", seen.url]);
			expect(rejected.code).toBe(2);
			expect(rejected.stdout).toBe("");
			expect(rejected.stderr).toContain("没有通过校验");
			expect(rejected.stderr).toContain(removedMessage);
			expect(rejected.stderr).not.toContain("Additional properties");
			expect(seen.requests).toEqual([]);
			expect((await detail(id)).head_version).toBe(1);

			const json = await sfly(["scenario", "push", file, "--json", "--server", seen.url]);
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stderr).error.code).toBe("invalid_document");
			expect(JSON.parse(json.stderr).error.message).toContain(removedMessage);
			expect(seen.requests).toEqual([]);

			await writeScenarioFile(file, old);
			const fixed = await cli("scenario", "push", file);
			expect(fixed.code, fixed.stderr).toBe(0);
			expect((await detail(id)).head_version).toBe(2);
		});

		it("push 一个带着空 sticky_notes 的旧文件（每个旧版本都有）：本地校验不报，控制面接受并丢掉，新版本里没有它", async () => {
			const id = await createScenario("legacy-push-empty", echoDocument());
			const file = await pull(id);
			const old = await readScenarioFile(file);
			await writeScenarioFile(file, {
				...old,
				document: { ...old.document, sticky_notes: [] },
			});

			const pushed = await cli("scenario", "push", file);
			expect(pushed.code, pushed.stderr).toBe(0);
			expect((await detail(id)).head_version).toBe(2);
			expect(await storedDocument(cp, id, 2)).not.toHaveProperty("sticky_notes");
		});
	});
});
