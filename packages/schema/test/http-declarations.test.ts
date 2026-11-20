import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	checkRouteDeclarations,
	download,
	endpoint,
	httpContract,
	RESOURCE_KIND_LABELS,
	RESOURCE_KINDS,
	type RouteDef,
	SUMMARY_MAX_LENGTH,
	stream,
} from "../src/index.js";

// 接口声明（契约约定 10）：每个接口写明说明、只读还是有副作用、作用在哪类资源上。
// 类型保证写了，checkRouteDeclarations 保证写得对；缺一项的接口在类型检查和这个测试里都过不了。

const base = {
	summary: "测试用的接口",
	effect: "read",
	resource: { kind: "system", target: "global" },
	client: false,
} as const;

/** 拿一个合法的接口，改坏一处（绕过类型）。 */
const broken = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}): RouteDef =>
	({
		method: "GET",
		path: "/things/:id",
		...base,
		resource: { kind: "scenario", target: { params: "id" } },
		key: ["things", "get"],
		params: z.object({ id: z.string() }),
		response: z.object({}),
		...extra,
		...patch,
	}) as RouteDef;

describe("契约里全部接口的声明", () => {
	it("每个接口的 summary、effect、resource 都站得住", () => {
		expect(httpContract.length).toBeGreaterThan(50);
		expect(checkRouteDeclarations(httpContract)).toEqual([]);
	});

	it("每一类资源都有接口在用，每类都有中文名", () => {
		const used = new Set(httpContract.map((def) => def.resource.kind));
		expect([...used].sort()).toEqual([...RESOURCE_KINDS].sort());
		expect(Object.keys(RESOURCE_KIND_LABELS).sort()).toEqual([...RESOURCE_KINDS].sort());
	});

	it("同一个方法和路径只声明一次", () => {
		const seen = httpContract.map((def) => `${def.method} ${def.path}`);
		expect(seen.filter((key, i) => seen.indexOf(key) !== i)).toEqual([]);
	});
});

describe("缺声明的接口：类型检查过不了", () => {
	// 这些 @ts-expect-error 由 `tsc -p .`（pnpm typecheck）检查：去掉必填的限制，它们会因为「没有错误」而失败。
	it("endpoint、stream、download 都要写 summary、effect、resource", () => {
		const { summary, effect, resource, ...rest } = base;
		const withoutSummary = { effect, resource, ...rest };
		const withoutEffect = { summary, resource, ...rest };
		const withoutResource = { summary, effect, ...rest };
		const common = { method: "GET", path: "/x", key: ["x", "y"], response: z.object({}) } as const;

		// @ts-expect-error 缺 summary
		endpoint({ ...common, ...withoutSummary });
		// @ts-expect-error 缺 effect
		endpoint({ ...common, ...withoutEffect });
		// @ts-expect-error 缺 resource
		endpoint({ ...common, ...withoutResource });
		// @ts-expect-error 缺 summary
		stream({ path: "/x", events: {}, ...withoutSummary });
		// @ts-expect-error 缺 effect
		stream({ path: "/x", events: {}, ...withoutEffect });
		// @ts-expect-error 缺 resource
		stream({ path: "/x", events: {}, ...withoutResource });
		// @ts-expect-error 缺 summary
		download({ path: "/x", contentType: "text/plain", ...withoutSummary });
		// @ts-expect-error 缺 effect
		download({ path: "/x", contentType: "text/plain", ...withoutEffect });
		// @ts-expect-error 缺 resource
		download({ path: "/x", contentType: "text/plain", ...withoutResource });
		// @ts-expect-error effect 只能是 read 或 write
		endpoint({ ...common, ...base, effect: "maybe" });
		// @ts-expect-error 资源类别要在枚举里
		endpoint({ ...common, ...base, resource: { kind: "orchestration", target: "collection" } });
		// @ts-expect-error resource.target 必填
		endpoint({ ...common, ...base, resource: { kind: "scenario" } });
		expect(true).toBe(true);
	});
});

describe("写得不对的声明：检查给出具体的问题", () => {
	const problems = (def: RouteDef) => checkRouteDeclarations([def]);

	it("合法的声明没有问题", () => {
		expect(problems(broken({}))).toEqual([]);
		expect(
			problems(
				broken({
					resource: { kind: "scenario", target: "collection" },
					path: "/things",
					params: undefined,
				}),
			),
		).toEqual([]);
	});

	it("没有 summary、是空的、不止一行、太长", () => {
		expect(problems(broken({ summary: undefined }))).toEqual([
			"GET /things/:id：缺少 summary（一句话说明这个接口做什么）",
		]);
		expect(problems(broken({ summary: "  " }))[0]).toContain("缺少 summary");
		expect(problems(broken({ summary: "第一行\n第二行" }))[0]).toContain("写成一行");
		expect(problems(broken({ summary: " 前面有空白" }))[0]).toContain("写成一行");
		expect(problems(broken({ summary: "字".repeat(SUMMARY_MAX_LENGTH + 1) }))[0]).toContain("超过");
		expect(problems(broken({ summary: "字".repeat(SUMMARY_MAX_LENGTH) }))).toEqual([]);
	});

	it("effect 不是 read 或 write", () => {
		expect(problems(broken({ effect: undefined }))[0]).toContain("effect 要写 read 或 write");
		expect(problems(broken({ effect: "readonly" }))[0]).toContain('收到 "readonly"');
	});

	it("没有 resource、资源类别不在枚举里、没有 target", () => {
		expect(problems(broken({ resource: undefined }))[0]).toContain("缺少 resource");
		expect(
			problems(broken({ resource: { kind: "orchestration", target: "collection" } }))[0],
		).toContain('收到 "orchestration"');
		expect(problems(broken({ resource: { kind: "scenario" } }))[0]).toContain(
			"缺少 resource.target",
		);
		expect(problems(broken({ resource: { kind: "scenario", target: {} } }))[0]).toContain(
			"要写 { params }",
		);
	});

	it("路径参数、查询参数、请求体字段必须真的在请求里", () => {
		expect(
			problems(broken({ resource: { kind: "scenario", target: { params: "name" } } }))[0],
		).toContain("路径参数 name 不在路径 /things/:id 里");
		expect(
			problems(broken({ resource: { kind: "scenario", target: { params: "*" } } }))[0],
		).toContain("路径参数 * 不在路径");
		const withQuery = { query: z.object({ owner: z.string() }) };
		expect(
			problems(broken({ resource: { kind: "agent", target: { query: "owner" } } }, withQuery)),
		).toEqual([]);
		expect(
			problems(broken({ resource: { kind: "agent", target: { query: "who" } } }, withQuery))[0],
		).toContain("字段 who，它不在 query 里");
		expect(
			problems(broken({ resource: { kind: "agent", target: { query: "owner" } } }))[0],
		).toContain("没有对象形式的 query");
		const withBody = { method: "POST", body: z.object({ name: z.string() }).refine(() => true) };
		expect(
			problems(broken({ resource: { kind: "agent", target: { body: "name" } } }, withBody)),
		).toEqual([]);
		expect(
			problems(broken({ resource: { kind: "agent", target: { body: "id" } } }, withBody))[0],
		).toContain("字段 id，它不在 body 里");
		// 套了一层包装的对象也认得出
		const wrapped = { method: "POST", body: z.object({ name: z.string() }).optional() };
		expect(
			problems(broken({ resource: { kind: "agent", target: { body: "name" } } }, wrapped)),
		).toEqual([]);
	});

	it("collection 不能用在带路径参数的接口上，upload 只给上传，global 只给 system", () => {
		expect(problems(broken({ resource: { kind: "scenario", target: "collection" } }))[0]).toContain(
			"路径里有参数",
		);
		expect(
			problems(
				broken({
					resource: { kind: "package", target: "upload" },
					path: "/things",
					params: undefined,
				}),
			)[0],
		).toContain("接口不是上传");
		expect(
			problems(
				broken(
					{ resource: { kind: "package", target: "upload" }, path: "/things", params: undefined },
					{ upload: true },
				),
			),
		).toEqual([]);
		expect(problems(broken({ resource: { kind: "scenario", target: "global" } }))[0]).toContain(
			"global 只用于 system",
		);
		expect(
			problems(
				broken({
					resource: { kind: "system", target: "collection" },
					path: "/things",
					params: undefined,
				}),
			)[0],
		).toContain("system 没有具体的那一个");
		expect(
			problems(broken({ resource: { kind: "system", target: { params: "id" } } }))[0],
		).toContain("system 没有具体的那一个");
	});

	it("每个有问题的接口各报各的，带着方法和路径", () => {
		const list = checkRouteDeclarations([
			broken({ summary: "" }),
			broken({}),
			broken({ effect: "x" }, { method: "PATCH", path: "/other/:id" }),
		]);
		expect(list).toHaveLength(2);
		expect(list[0]).toMatch(/^GET \/things\/:id：/);
		expect(list[1]).toMatch(/^PATCH \/other\/:id：/);
	});
});
