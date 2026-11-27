// sfly api：真实的 sfly 进程按路由清单校验后调用测试控制面，以及 --list。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { createQueuedRun } from "./support/queued-run.js";
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
	summary: string;
	effect: "read" | "write";
	resource: { kind: string; target: unknown };
	creates?: string;
	removes?: true;
	body?: { required?: string[] };
	response?: Record<string, unknown>;
	events?: Record<string, unknown>;
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
			// 测的是命令行发的昵称请求头（不带令牌时才发，#494 一并删除）：不带默认的令牌。
			const result = await sfly(
				["api", "GET", "/health", "--nickname", "小明", "--server", proxy.url],
				{
					env: { SFLY_API_TOKEN: undefined },
				},
			);
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
				`/runs/${await createQueuedRun(cp)}/events`,
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

		it("取值不在枚举里：列出可以填的值，带上字段在契约里的说明（已经去掉的 always 写明去掉了）", async () => {
			const removed = await rejected([
				"PATCH",
				`/orchestrations/${alphaId}`,
				"--body",
				'{"run_notification":{"trigger":"always"}}',
			]);
			expect(removed).toContain(
				'body.run_notification.trigger：取值要是 "failed"、"failed_or_cancelled" 之一',
			);
			expect(removed).toContain("`always` 已去掉：成功的运行不再发运行通知");
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
		it("文本：每个接口一行，写明方法、路径、种类、只读还是有副作用、一句话说明和参数", async () => {
			const result = await cli("--list");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			const lines = result.stdout.split("\n");
			expect(lines[0]).toMatch(/^方法\s+路径\s+种类\s+效果\s+说明\s+参数/);
			const row = (method: string, path: string) =>
				lines.find((line) => line.startsWith(method) && line.split(/\s+/)[1] === path);
			expect(row("POST", "/orchestrations")).toMatch(
				/普通\s+有副作用\s+新建一个场景\s+body: name\*, description$/,
			);
			expect(row("GET", "/runs/:id/events")).toMatch(/SSE\s+只读\s+实时推送一次运行/);
			expect(row("GET", "/llms.txt")).toMatch(/下载\s+只读/);
			expect(row("POST", "/packages")).toMatch(/上传\s+有副作用/);
			expect(row("GET", "/runs")).toMatch(/query: .*limit/);
			// 新建别类、新建同类、删除或归档，在效果一列里写明
			expect(row("POST", "/orchestrations/:id/runs")).toMatch(
				/有副作用（新建运行）\s+触发一个场景/,
			);
			expect(row("POST", "/orchestrations/:id/copy")).toMatch(/有副作用（新建场景）/);
			expect(row("POST", "/orchestrations/:id/archive")).toMatch(/有副作用（删除或归档）/);
			expect(row("DELETE", "/feishu-bots/:name")).toMatch(/有副作用（删除或归档）/);
			expect(result.stdout).toContain("sfly api --describe <方法> <路径>");
		});

		it("--json：清单里全部接口，带 key、种类、说明、读写、资源和 JSON Schema，与清单一致", async () => {
			const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as { routes: ListedRoute[] };
			const result = await cli("--list", "--json");
			expect(result.code, result.stderr).toBe(0);
			const listed = JSON.parse(result.stdout) as ListedRoute[];
			expect(listed.map((r) => `${r.method} ${r.path}`)).toEqual(
				manifest.routes.map((r) => `${r.method} ${r.path}`),
			);
			expect(listed).toEqual(manifest.routes);
			const create = listed.find((r) => r.method === "POST" && r.path === "/orchestrations");
			expect(create?.key).toEqual(["orchestrations", "create"]);
			expect(create?.kind).toBe("endpoint");
			expect(create?.body?.required).toEqual(["name"]);
			expect(create).toMatchObject({
				summary: "新建一个场景",
				effect: "write",
				resource: { kind: "scenario", target: "collection" },
			});
			expect(create?.response).toMatchObject({ type: "object" });
			const events = listed.find((r) => r.path === "/runs/:id/events");
			expect(Object.keys(events?.events ?? {})).toEqual(["run", "progress", "metrics"]);
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

		it("关键字也匹配一句话说明：按用途找接口", async () => {
			const found = await cli("--list", "日志", "--json");
			expect(found.code, found.stderr).toBe(0);
			const paths = (JSON.parse(found.stdout) as ListedRoute[]).map((r) => r.path);
			expect(paths).toEqual(
				expect.arrayContaining(["/tasks/:id/logs", "/runs/:id/logs", "/runs/:id/logs/download"]),
			);
			expect(paths).not.toContain("/health");
		});

		it("按用途找：输出、产物、预设、取消、失败原因都能找到对应的接口", async () => {
			const paths = async (word: string) => {
				const found = await cli("--list", word, "--json");
				expect(found.code, `${word}：${found.stderr}`).toBe(0);
				return (JSON.parse(found.stdout) as ListedRoute[]).map((r) => `${r.method} ${r.path}`);
			};
			expect(await paths("输出")).toEqual(expect.arrayContaining(["GET /runs/:id"]));
			expect(await paths("产物")).toContain("GET /tasks/:id/artifacts");
			expect(await paths("预设")).toContain("POST /orchestrations/:id/presets");
			expect(await paths("取消")).toEqual(["POST /runs/:id/cancel"]);
			expect(await paths("失败原因")).toContain("GET /runs/:id");
		});

		it("--list 和 --describe 不能同时给", async () => {
			const both = await cli("--list", "--describe", "GET", "/health");
			expect(both.code).toBe(2);
			expect(both.stderr).toContain("--list 和 --describe 只能给一个");
		});
	});

	describe("--describe", () => {
		it("文本：说明、种类、读写、资源、怎么调用，以及请求和响应的字段", async () => {
			const result = await cli("--describe", "GET", "/runs/:id");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			const text = result.stdout;
			expect(text.split("\n").slice(0, 6)).toEqual([
				"GET /runs/:id",
				"说明：读一次运行的状态：各链、各节点的状态、输出、失败原因和每次尝试",
				"种类：普通",
				"效果：只读",
				"资源：运行，用路径参数 id 定位到具体的那一个",
				"调用：sfly api GET /runs/<id>",
			]);
			expect(text).toContain("路径参数（* 必填）\n  id*: string");
			expect(text).toContain("响应（JSON）\n");
			expect(text).toContain('  status*: "running" | "success" | "failed" | "cancelled"');
			expect(text).toContain("  chains*: object[]");
		});

		it("字段的说明写在类型后面（契约里写在字段上的注释）；没有说明的字段只有类型", async () => {
			const preset = await cli("--describe", "PATCH", "/orchestrations/:id/presets/:presetId");
			expect(preset.code, preset.stderr).toBe(0);
			expect(preset.stdout).toContain("  presetId*: string — 运行预设的 id。");
			expect(preset.stdout).toMatch(
				/keep: true — 写 `true` 表示沿用这个预设里这个 secret 参数原来的值/,
			);
			expect(preset.stdout).toContain("  name: string — 新名称（场景内唯一）。");
			const logs = await cli("--describe", "GET", "/runs/:id/logs");
			expect(logs.stdout).toContain("  level: string — 只要这些级别的日志，逗号分隔");
			expect(logs.stdout).toContain("  truncated_tasks*: object[] — 日志超过大小上限被截断的任务");
			// 没有注释的字段只写类型
			expect(logs.stdout).toContain("\n  run_id*: string\n");
		});

		it("路径可以带实际的 id，也可以带占位符；方法不分大小写", async () => {
			const template = await cli("--describe", "GET", "/runs/:id");
			const actual = await cli("--describe", "get", `/runs/${UNKNOWN_ID}`);
			expect(actual.code, actual.stderr).toBe(0);
			expect(actual.stdout).toBe(template.stdout);
		});

		it("有副作用、请求体和资源在列表上的接口", async () => {
			const result = await cli("--describe", "POST", "/orchestrations");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("效果：有副作用");
			expect(result.stdout).toContain("资源：场景，列表或新建，没有具体的那一个");
			expect(result.stdout).toContain(
				"请求体（JSON，* 必填）\n  name*: string — 场景名称。\n  description: string — 场景说明（可以是空的）。",
			);
		});

		it("新建和删除：写明新建的是什么、定位到的资源只被读；删除或归档", async () => {
			const trigger = await cli("--describe", "POST", "/orchestrations/:id/runs");
			expect(trigger.stdout).toContain("资源：场景，用路径参数 id 定位到具体的那一个");
			expect(trigger.stdout).toContain("新建：运行（定位到的场景只被读，写落在新建出来的运行上）");
			const archive = await cli("--describe", "POST", "/orchestrations/:id/archive");
			expect(archive.stdout).toContain("删除或归档：是（让定位到的场景或它的一部分不再可用）");
			expect(archive.stdout).not.toContain("新建：");
			const save = await cli("--describe", "POST", "/orchestrations/:id/versions");
			expect(save.stdout).not.toContain("新建：");
			expect(save.stdout).not.toContain("删除或归档");
		});

		it("SSE 列出每个事件，下载写 content-type，上传说明不能直接调用，没有响应体的写 204", async () => {
			const events = await cli("--describe", "GET", "/runs/:id/events");
			expect(events.stdout).toContain("事件流（SSE）");
			for (const name of ["run", "progress", "metrics"]) {
				expect(events.stdout).toContain(`\n事件 ${name}\n`);
			}
			const download = await cli("--describe", "GET", "/llms.txt");
			expect(download.stdout).toContain(
				"响应：文件内容（content-type：text/plain; charset=utf-8）",
			);
			const upload = await cli("--describe", "POST", "/packages");
			expect(upload.stdout).toContain("sfly api 不能直接调用");
			const empty = await cli("--describe", "DELETE", "/feishu-bots/:name");
			expect(empty.stdout).toContain("响应：没有响应体（204）");
		});

		it("--json：这个接口在清单里的一条，带完整的 JSON Schema", async () => {
			const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as { routes: ListedRoute[] };
			const result = await cli("--describe", "POST", "/orchestrations/:id/runs", "--json");
			expect(result.code, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(
				manifest.routes.find((r) => r.method === "POST" && r.path === "/orchestrations/:id/runs"),
			);
		});

		it("清单里没有的接口：列出最接近的；方法不对：写明支持的方法；参数个数不对", async () => {
			const typo = await cli("--describe", "GET", "/runs/x/lgos");
			expect(typo.code).toBe(2);
			expect(typo.stderr).toContain("路由清单里没有 GET /runs/x/lgos");
			expect(typo.stderr).toContain("GET /runs/:id/logs");
			const method = await cli("--describe", "PUT", "/runs/:id");
			expect(method.code).toBe(2);
			expect(method.stderr).toContain("不支持 PUT，支持的方法：GET");
			const usage = await cli("--describe", "GET");
			expect(usage.code).toBe(2);
			expect(usage.stderr).toContain("用法：sfly api --describe <METHOD> <路径>");
		});
	});
});
