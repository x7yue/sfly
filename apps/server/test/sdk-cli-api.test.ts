// sfly api：真实的 sfly 进程按路由清单校验后调用测试控制面，以及 --list。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type RecordingProxy, startRecordingProxy } from "./support/recording-proxy.js";
import { repoRoot, sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MANIFEST = join(repoRoot, "sdk/python/src/sfly/schemas/routes.json");
const UNKNOWN_ID = "11111111-1111-4111-8111-111111111111";

interface ListedRoute {
	method: string;
	path: string;
	kind: string;
	key: string[] | null;
	body?: { required?: string[] };
}

describe("sfly api → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let proxy: RecordingProxy;
	let dir: string;
	let alphaId: string;
	const cli = (...args: string[]) => sfly(["api", ...args, "--server", cp.httpUrl]);
	const viaProxy = (...args: string[]) => sfly(["api", ...args, "--server", proxy.url]);

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		proxy = await startRecordingProxy(cp.httpUrl);
		dir = await mkdtemp(join(tmpdir(), "sfly-api-"));
		alphaId = await api.createOrchestration("阿尔法");
		await api.createOrchestration("贝塔");
	}, 120_000);

	afterAll(async () => {
		await proxy?.close();
		await cp?.close();
		await rm(dir, { recursive: true, force: true });
	});

	describe("调用", () => {
		it("GET：响应原样输出，路径里可以直接带查询参数，--query 追加", async () => {
			const direct = await (await api.get("/orchestrations")).text();
			const plain = await cli("GET", "/orchestrations");
			expect(plain.code, plain.stderr).toBe(0);
			expect(plain.stderr).toBe("");
			expect(plain.stdout).toBe(`${direct}\n`);

			const filtered = await cli("get", "/orchestrations", "--query", "q=阿尔法");
			expect(filtered.code, filtered.stderr).toBe(0);
			const found = JSON.parse(filtered.stdout) as { orchestrations: { name: string }[] };
			expect(found.orchestrations.map((s) => s.name)).toEqual(["阿尔法"]);

			const inline = await cli("GET", "/runs?limit=1&status=running");
			expect(inline.code, inline.stderr).toBe(0);
			expect(JSON.parse(inline.stdout)).toEqual(await api.getJson("/runs?limit=1&status=running"));
		});

		it("带公共的昵称和 x-sfly-client 请求头", async () => {
			proxy.requests.length = 0;
			const result = await viaProxy("GET", "/health", "--nickname", "小明");
			expect(result.code, result.stderr).toBe(0);
			const [request] = proxy.requests;
			expect(request?.headers["x-sfly-nickname"]).toBe(encodeURIComponent("小明"));
			expect(request?.headers["x-sfly-client"]).toMatch(/^sfly-cli\/\S+$/);

			proxy.requests.length = 0;
			const inAssistant = await sfly(["api", "GET", "/health", "--server", proxy.url], {
				env: { AI_AGENT: "claude-code" },
			});
			expect(inAssistant.code, inAssistant.stderr).toBe(0);
			expect(proxy.requests[0]?.headers["x-sfly-client"]).toMatch(
				/^sfly-cli\/\S+ agent\/claude-code$/,
			);
		});

		it("POST：--body 给 JSON 文本，或 @文件", async () => {
			const inline = await cli(
				"POST",
				"/orchestrations",
				"--body",
				'{"name":"来自 api","description":"d"}',
				"--nickname",
				"小明",
			);
			expect(inline.code, inline.stderr).toBe(0);
			const created = JSON.parse(inline.stdout) as { id: string; name: string };
			expect(created.name).toBe("来自 api");
			expect(await (await api.get(`/orchestrations/${created.id}`)).json()).toMatchObject({
				name: "来自 api",
				description: "d",
			});

			const file = join(dir, "body.json");
			await writeFile(file, JSON.stringify({ name: "来自文件" }));
			const fromFile = await cli("POST", "/orchestrations", "--body", `@${file}`);
			expect(fromFile.code, fromFile.stderr).toBe(0);
			expect((JSON.parse(fromFile.stdout) as { name: string }).name).toBe("来自文件");
		});

		it("没有请求体的 POST 照常调用", async () => {
			const id = await api.createOrchestration("待归档");
			const result = await cli("POST", `/orchestrations/${id}/archive`);
			expect(result.code, result.stderr).toBe(0);
			expect((JSON.parse(result.stdout) as { archived_at: string | null }).archived_at).not.toBe(
				null,
			);
		});

		it("控制面返回的错误：状态码、错误码和说明写到 stderr，退出码 2", async () => {
			const result = await cli("GET", `/orchestrations/${UNKNOWN_ID}`);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(/^错误：HTTP 404 /);

			const asJson = await cli("GET", `/orchestrations/${UNKNOWN_ID}`, "--json");
			expect(asJson.code).toBe(2);
			expect((JSON.parse(asJson.stderr) as { error: { code: string } }).error.code).toBe(
				"not_found",
			);
		});

		it("下载原样输出文件内容", async () => {
			const direct = await (await api.get("/llms.txt")).text();
			const result = await cli("GET", "/llms.txt");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toBe(direct);
		});

		it("SSE 原样输出事件，读到 --timeout 秒就停止并正常退出", async () => {
			const result = await cli(
				"GET",
				`/orchestrations/${alphaId}/presence/events`,
				"--timeout",
				"1",
			);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("event: time");
			expect(result.stderr).toContain("到 --timeout 的时间");
		});

		it("上传接口不支持：提示用 sfly publish", async () => {
			const result = await cli("POST", "/packages");
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("请求体是原始字节");
			expect(result.stderr).toContain("sfly publish");
		});
	});

	describe("发请求前按路由清单校验", () => {
		const rejected = async (args: string[]) => {
			proxy.requests.length = 0;
			const result = await viaProxy(...args);
			expect(result.code, result.stderr).toBe(2);
			expect(result.stdout).toBe("");
			expect(proxy.requests, "校验不通过就不该发请求").toEqual([]);
			return result.stderr;
		};

		it("body 缺必填字段、字段类型不对、有不认识的字段：逐条列出，不发请求", async () => {
			const missing = await rejected(["POST", "/orchestrations", "--body", '{"description":"x"}']);
			expect(missing).toContain("body：缺少必填字段 name");

			const wrongType = await rejected(["POST", "/orchestrations", "--body", '{"name":3}']);
			expect(wrongType).toContain("body.name：需要 string，收到 integer");

			const extra = await rejected([
				"POST",
				`/orchestrations/${alphaId}/runs`,
				"--body",
				'{"params":{},"wat":1}',
			]);
			expect(extra).toContain("不认识的字段 wat");
			expect(extra).toContain("下一步：sfly api --list POST /orchestrations/:id/runs --json");
		});

		it("缺 --body、body 不是 JSON、文件读不了、接口没有请求体", async () => {
			expect(await rejected(["POST", "/orchestrations"])).toContain("缺少 --body，必填字段：name");
			expect(await rejected(["POST", "/orchestrations", "--body", "{name:"])).toContain(
				"--body 不是合法的 JSON",
			);
			expect(await rejected(["POST", "/orchestrations", "--body", "@/不存在.json"])).toContain(
				"读不了 --body 的文件",
			);
			expect(await rejected(["GET", "/health", "--body", "{}"])).toContain("这个接口没有请求体");
		});

		it("查询参数：不认识的名字、类型不对、没有查询参数的接口", async () => {
			expect(await rejected(["GET", "/runs", "--query", "limt=5"])).toContain(
				"不认识的查询参数 limt（接受：",
			);
			expect(await rejected(["GET", "/runs", "--query", "limit=abc"])).toContain(
				"query.limit：需要 integer，收到 string",
			);
			expect(await rejected(["GET", "/runs", "--query", "limit=0"])).toContain("query.limit：");
			expect(await rejected(["GET", "/health", "--query", "a=1"])).toContain("没有查询参数");
			expect(await rejected(["GET", "/runs", "--query", "limit"])).toContain("名=值");
		});

		it("路径不在清单里：列出最接近的几条路由，不发请求", async () => {
			const typo = await rejected(["GET", "/runs/abc/lgos"]);
			expect(typo).toContain("路由清单里没有 GET /runs/abc/lgos");
			expect(typo).toContain("GET /runs/:id/logs");
			expect(typo).toContain("下一步：sfly api --list");

			const nothing = await rejected(["GET", "/不存在的路径/x/y/z"]);
			expect(nothing).toContain("路由清单里没有 GET");
		});

		it("路径对得上、方法不对：写明这个路径支持的方法", async () => {
			const stderr = await rejected(["GET", "/runs/abc/cancel"]);
			expect(stderr).toContain("不支持 GET，支持的方法：POST");
		});

		it("路径格式不对、清单里的占位符没有换成实际的值、参数个数不对", async () => {
			expect(await rejected(["GET", "runs"])).toContain("路径要以 / 开头");
			expect(await rejected(["GET", "/runs/:id"])).toContain("占位符");
			expect(await rejected(["GET"])).toContain("用法：sfly api <METHOD> <路径>");
		});
	});

	describe("--list", () => {
		it("文本：每个接口一行，写明方法、路径、种类和参数", async () => {
			const result = await cli("--list");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			const lines = result.stdout.split("\n");
			expect(lines[0]).toMatch(/^方法\s+路径\s+种类\s+参数/);
			const row = (method: string, path: string) =>
				lines.find((line) => line.startsWith(method) && line.split(/\s+/)[1] === path);
			expect(row("POST", "/orchestrations")).toMatch(/普通\s+body: name\*, description$/);
			expect(row("GET", "/runs/:id/events")).toMatch(/SSE/);
			expect(row("GET", "/llms.txt")).toMatch(/下载/);
			expect(row("POST", "/packages")).toMatch(/上传/);
			expect(row("GET", "/runs")).toMatch(/query: .*limit/);
		});

		it("--json：清单里全部接口，带 key、种类和 JSON Schema", async () => {
			const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as { routes: ListedRoute[] };
			const result = await cli("--list", "--json");
			expect(result.code, result.stderr).toBe(0);
			const listed = JSON.parse(result.stdout) as ListedRoute[];
			expect(listed.map((r) => `${r.method} ${r.path}`)).toEqual(
				manifest.routes.map((r) => `${r.method} ${r.path}`),
			);
			const create = listed.find((r) => r.method === "POST" && r.path === "/orchestrations");
			expect(create?.key).toEqual(["orchestrations", "create"]);
			expect(create?.kind).toBe("endpoint");
			expect(create?.body?.required).toEqual(["name"]);
		});

		it("后面的关键字筛选接口，没有匹配时报错", async () => {
			const filtered = await cli("--list", "GET", "/runs/:id/logs", "--json");
			expect(filtered.code, filtered.stderr).toBe(0);
			expect((JSON.parse(filtered.stdout) as ListedRoute[]).map((r) => r.path)).toEqual([
				"/runs/:id/logs",
				"/runs/:id/logs/download",
				"/runs/:id/logs/events",
			]);

			const none = await cli("--list", "没有这个接口");
			expect(none.code).toBe(2);
			expect(none.stderr).toContain("没有接口匹配 没有这个接口");
		});
	});
});
