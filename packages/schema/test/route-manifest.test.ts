import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { annotateSchema } from "../src/field-docs.js";
import {
	download,
	endpoint,
	httpApis,
	httpContract,
	RESOURCE_KIND_LABELS,
	SUMMARY_MAX_LENGTH,
	stream,
	Timestamp,
} from "../src/index.js";
import { harvestRouteDocs } from "../src/route-docs.js";
import { buildRouteManifest } from "../src/route-manifest.js";

// 路由清单（随 SDK 打包的 routes.json）里每个接口的说明、读写标记、资源和响应的 JSON Schema。

const manifest = buildRouteManifest(httpContract);
const ajv = new Ajv2020({ strict: false, validateFormats: false });

const common = {
	summary: "测试用的接口",
	effect: "read",
	resource: { kind: "system", target: "global" },
	client: false,
} as const;

describe("路由清单里每个接口的声明和响应", () => {
	it("每个接口带着契约里写的说明、读写标记和资源", () => {
		expect(manifest.routes).toHaveLength(httpContract.length);
		manifest.routes.forEach((entry, index) => {
			const def = httpContract[index];
			expect(entry.method, entry.path).toBe(def?.method);
			expect(entry.path).toBe(def?.path);
			expect(entry.summary, entry.path).toBe(def?.summary);
			expect(entry.effect, entry.path).toBe(def?.effect);
			expect(entry.resource, entry.path).toEqual(def?.resource);
		});
	});

	it("资源类别有中文名，清单里用到的类别都在里面", () => {
		expect(manifest.resource_kinds).toEqual(RESOURCE_KIND_LABELS);
		for (const entry of manifest.routes) {
			expect(manifest.resource_kinds[entry.resource.kind], entry.path).toBeTruthy();
		}
	});

	it("JSON 接口和上传带响应的 JSON Schema，SSE 带每个事件的，下载什么都不带", () => {
		for (const [index, entry] of manifest.routes.entries()) {
			const def = httpContract[index];
			const where = `${entry.method} ${entry.path}`;
			if (entry.kind === "stream") {
				expect(entry.response, where).toBeUndefined();
				expect(Object.keys(entry.events ?? {}), where).toEqual(
					Object.keys((def as { events: object }).events),
				);
			} else if (entry.kind === "download") {
				expect(entry.response, where).toBeUndefined();
				expect(entry.events, where).toBeUndefined();
			} else {
				expect(entry.events, where).toBeUndefined();
				const noBody = (def as { response: z.ZodType }).response._zod.def.type === "undefined";
				expect(entry.response === undefined, where).toBe(noBody);
			}
		}
		const noBody = manifest.routes.filter(
			(e) => (e.kind === "endpoint" || e.kind === "upload") && e.response === undefined,
		);
		expect(noBody.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
			"DELETE /feishu-bots/:name",
			"DELETE /orchestrations/:id/presets/:presetId",
			"POST /orchestrations/:id/presence/leave",
		]);
	});

	it("导出的每个 JSON Schema 都是合法的 draft 2020-12", () => {
		let checked = 0;
		for (const entry of manifest.routes) {
			const schemas = [entry.response, ...Object.values(entry.events ?? {})];
			for (const schema of schemas) {
				if (!schema) continue;
				expect(() => ajv.compile(schema), `${entry.method} ${entry.path}`).not.toThrow();
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(60);
	});

	it("导出的响应 schema 和 zod 对同一份数据的判断一致", () => {
		const health = manifest.routes.find((e) => e.path === "/health");
		const validate = ajv.compile(health?.response ?? {});
		const ok = { status: "ok", database: "ok", time: "2026-11-21T01:00:00.000Z" };
		expect(validate(ok)).toBe(true);
		// 控制面可以先加字段：多出来的字段不让响应不合格
		expect(validate({ ...ok, extra: 1 })).toBe(true);
		expect(validate({ ...ok, status: "broken" })).toBe(false);
		expect(validate({ status: "ok", database: "ok" })).toBe(false);
	});
});

describe("导出响应的规则", () => {
	/** 给这几个接口的路径前缀各登记它们声明的类别，不让路径前缀的检查挡着这里要测的东西。 */
	const lenient = (defs: Parameters<typeof buildRouteManifest>[0]) => ({
		pathKinds: Object.fromEntries(
			defs.map((def) => [
				`/${def.path.split("/").filter(Boolean)[0]}`,
				{ kind: def.resource.kind, why: "测试" },
			]),
		),
		readsWithTraces: {},
	});
	const build = (...defs: Parameters<typeof buildRouteManifest>[0]) =>
		buildRouteManifest(defs, lenient(defs)).routes;

	it("没写 strict 的对象不封闭，写了 strictObject 的封闭", () => {
		const [route] = build(
			endpoint({
				...common,
				method: "GET",
				path: "/a",
				key: ["a", "get"],
				response: z.object({
					open: z.object({ x: z.string() }),
					closed: z.strictObject({ y: z.number() }),
					at: Timestamp,
				}),
			}),
		);
		const props = (
			route?.response as {
				properties: Record<string, Record<string, unknown>>;
				additionalProperties?: unknown;
			}
		).properties;
		expect(route?.response).not.toHaveProperty("additionalProperties");
		expect(props.open).not.toHaveProperty("additionalProperties");
		expect(props.closed?.additionalProperties).toBe(false);
		expect(props.at?.format).toBe("date-time");
	});

	it("可以省略的字段不在 required 里；z.undefined() 的响应没有 response", () => {
		const [withOptional, empty] = build(
			endpoint({
				...common,
				method: "GET",
				path: "/a",
				key: ["a", "get"],
				response: z.object({ a: z.string(), b: z.string().optional(), c: z.string().nullable() }),
			}),
			endpoint({
				...common,
				method: "DELETE",
				path: "/a",
				key: ["a", "remove"],
				effect: "write",
				removes: true,
				response: z.undefined(),
			}),
		);
		expect((withOptional?.response as { required: string[] }).required).toEqual(["a", "c"]);
		expect(empty).not.toHaveProperty("response");
	});

	it("SSE 导出每个事件的 schema，下载只有 content_type", () => {
		const [events, file] = build(
			stream({
				...common,
				path: "/s",
				events: { tick: z.object({ n: z.number() }), done: z.object({}) },
			}),
			download({ ...common, path: "/f", contentType: "text/plain" }),
		);
		expect(Object.keys(events?.events ?? {})).toEqual(["tick", "done"]);
		expect(events).not.toHaveProperty("response");
		expect(file?.content_type).toBe("text/plain");
		expect(file).not.toHaveProperty("response");
		expect(file).not.toHaveProperty("events");
	});

	it("creates 和 removes 进入清单；没声明的不带这两个字段", () => {
		const [creating, removing, plain] = build(
			endpoint({
				...common,
				method: "POST",
				path: "/a/:id/b",
				key: ["a", "create-b"],
				effect: "write",
				resource: { kind: "scenario", target: { params: "id" } },
				creates: "run",
				params: z.object({ id: z.string() }),
				response: z.object({}),
			}),
			endpoint({
				...common,
				method: "DELETE",
				path: "/a/:id",
				key: ["a", "remove"],
				effect: "write",
				resource: { kind: "scenario", target: { params: "id" } },
				removes: true,
				params: z.object({ id: z.string() }),
				response: z.undefined(),
			}),
			endpoint({
				...common,
				method: "GET",
				path: "/a",
				key: ["a", "list"],
				resource: { kind: "scenario", target: "collection" },
				response: z.object({}),
			}),
		);
		expect(creating).toMatchObject({ effect: "write", creates: "run" });
		expect(creating).not.toHaveProperty("removes");
		expect(removing).toMatchObject({ effect: "write", removes: true });
		expect(removing).not.toHaveProperty("creates");
		expect(plain).not.toHaveProperty("creates");
		expect(plain).not.toHaveProperty("removes");
	});

	it("声明不对的接口不导出：报出每一个问题", () => {
		const bad = endpoint({
			...common,
			method: "GET",
			path: "/x/:id",
			key: ["x", "get"],
			summary: "",
			resource: { kind: "scenario", target: { params: "name" } },
			params: z.object({ id: z.string() }),
			response: z.object({}),
		});
		expect(() => buildRouteManifest([bad], lenient([bad]))).toThrow(
			/GET \/x\/:id：缺少 summary[\s\S]*GET \/x\/:id：resource.target 的路径参数 name/,
		);
	});
});

describe("字段说明和按用途找接口", () => {
	const docsFor = harvestRouteDocs(httpApis);
	const withDocs = buildRouteManifest(httpContract, undefined, docsFor);
	const entry = (method: string, path: string) => {
		const found = withDocs.routes.find((r) => r.method === method && r.path === path);
		if (!found) throw new Error(`清单里没有 ${method} ${path}`);
		return found;
	};
	type Node = Record<string, unknown> & { description?: string };
	/** 沿着字段名走（数组元素写 `[]`）；走不到就报错。 */
	const prop = (schema: unknown, ...path: string[]): Node => {
		let node = schema as Node;
		for (const step of path) {
			const next =
				step === "[]"
					? (node.items as Node | undefined)
					: (node.properties as Record<string, Node> | undefined)?.[step];
			if (next === undefined) throw new Error(`没有字段 ${path.join(".")}（停在 ${step}）`);
			node = next;
		}
		return node;
	};

	it("契约里字段上的注释进了清单：请求的路径参数、查询参数、请求体字段，和响应的顶层字段", () => {
		const update = entry("PATCH", "/orchestrations/:id/presets/:presetId");
		expect(prop(update.params, "presetId").description).toBe("运行预设的 id。");
		expect(prop(update.body, "params", "[]", "keep").description).toContain(
			"沿用这个预设里这个 secret 参数原来的值",
		);
		expect(prop(update.body, "params", "[]", "value").description).toContain("固定的值");
		const logs = entry("GET", "/runs/:id/logs");
		expect(prop(logs.query, "level").description).toContain("逗号分隔");
		expect(prop(logs.query, "nodes").description).toContain("链路实例 ID:节点 ID");
		expect(prop(logs.response, "truncated_tasks").description).toContain(
			"日志超过大小上限被截断的任务",
		);
		const run = entry("GET", "/runs/:id");
		expect(prop(run.response, "preset").description).toContain("触发时选用的运行预设");
	});

	it("事件的顶层字段、字典和数组元素里的字段也带说明，没有说明的不凭空造", () => {
		const events = entry("GET", "/runs/:id/events");
		expect(prop(events.events?.run, "preset").description).toContain("触发时选用的运行预设");
		// 没有写注释的字段没有 description
		const health = entry("GET", "/health");
		expect(prop(health.response, "status").description).toContain("控制面整体");
	});

	it("字段上的 zod 说明（.describe）优先于注释", () => {
		const described = z.object({ a: z.string().describe("来自 describe") });
		const json = z.toJSONSchema(described, { io: "input" }) as Record<string, unknown>;
		annotateSchema(json, () => "来自注释");
		expect(prop(json, "a").description).toBe("来自 describe");
	});

	it("请求体的字段（到第三层）和响应的顶层字段读注释，响应更深的不读", () => {
		const run = entry("GET", "/runs/:id");
		const chains = prop(run.response, "chains");
		expect(chains.description ?? "").not.toBe("");
		const chainItem = (chains.items as Record<string, unknown>).properties as Record<
			string,
			Record<string, unknown>
		>;
		// 链实例里的字段在响应第二层：不读注释
		expect(Object.values(chainItem).every((f) => f.description === undefined)).toBe(true);
	});

	it("每个接口的一句话说明都是一行、不超长；每个接口都能按「平台之外的人会用的词」找到", () => {
		for (const route of withDocs.routes) {
			expect(route.summary.length, `${route.method} ${route.path}`).toBeLessThanOrEqual(
				SUMMARY_MAX_LENGTH,
			);
		}
		const find = (word: string) =>
			withDocs.routes
				.filter((r) => r.summary.toLowerCase().includes(word))
				.map((r) => `${r.method} ${r.path}`);
		// 一个没见过这个平台的人找东西会用的词
		expect(find("输出")).toEqual(
			expect.arrayContaining(["GET /runs/:id", "GET /tasks/:id/logs", "GET /runs/:id/logs"]),
		);
		for (const word of ["日志", "产物", "指标", "关注项", "预设", "取消", "失败原因", "开始运行"]) {
			expect(find(word).length, word).toBeGreaterThan(0);
		}
		expect(find("取消")).toContain("POST /runs/:id/cancel");
		expect(find("失败原因")).toContain("GET /runs/:id");
		expect(find("产物")).toEqual(
			expect.arrayContaining([
				"GET /tasks/:id/artifacts",
				"GET /tasks/:id/artifacts/*",
				"PUT /tasks/:id/artifacts/*",
			]),
		);
		expect(find("关注项")).toEqual(
			expect.arrayContaining(["GET /runs/:id/focus", "PATCH /orchestrations/:id"]),
		);
		expect(find("预设")).toEqual(
			expect.arrayContaining([
				"POST /orchestrations/:id/presets",
				"DELETE /orchestrations/:id/presets/:presetId",
			]),
		);
	});
});
