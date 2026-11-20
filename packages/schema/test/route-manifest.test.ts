import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	download,
	endpoint,
	httpContract,
	RESOURCE_KIND_LABELS,
	stream,
	Timestamp,
} from "../src/index.js";
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
	const build = (...defs: Parameters<typeof buildRouteManifest>[0]) =>
		buildRouteManifest(defs).routes;

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
		expect(() => buildRouteManifest([bad])).toThrow(
			/GET \/x\/:id：缺少 summary[\s\S]*GET \/x\/:id：resource.target 的路径参数 name/,
		);
	});
});
