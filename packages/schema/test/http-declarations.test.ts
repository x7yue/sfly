import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	checkDeclarationTables,
	checkPathKindsCover,
	checkRouteDeclarations,
	DECLARATION_RULES,
	type DeclarationRules,
	dashboardApi,
	download,
	endpoint,
	feishuBotsApi,
	httpContract,
	PATH_KINDS,
	READS_WITH_TRACES,
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

	it("GET 都是只读，DELETE 都声明 removes，非 GET 的只读接口都登记了写什么", () => {
		// 下游按「所有 GET 都没有副作用」判断（登录 Cookie 只对有副作用的方法做来源校验），
		// 按「DELETE 与归档用 removes 标出」判断助手的会话能不能做；这些前提不靠约定。
		const gets = httpContract.filter((def) => def.method === "GET");
		expect(gets.length).toBeGreaterThan(40);
		expect(gets.filter((def) => def.effect !== "read").map((d) => d.path)).toEqual([]);
		const deletes = httpContract.filter((def) => def.method === "DELETE");
		expect(deletes.length).toBeGreaterThan(0);
		expect(deletes.filter((def) => def.removes !== true).map((d) => d.path)).toEqual([]);
		const nonGetReads = httpContract
			.filter((def) => def.method !== "GET" && def.effect === "read")
			.map((def) => `${def.method} ${def.path}`);
		expect(nonGetReads.sort()).toEqual(Object.keys(READS_WITH_TRACES).sort());
	});

	it("READS_WITH_TRACES 里的接口都在契约里、都声明为只读，都写明了写什么", () => {
		const known = new Map(httpContract.map((def) => [`${def.method} ${def.path}`, def]));
		for (const [key, what] of Object.entries(READS_WITH_TRACES)) {
			expect(known.get(key)?.effect, key).toBe("read");
			expect(what.trim(), key).not.toBe("");
		}
	});

	it("creates 和 removes：现有写接口各按定义声明", () => {
		const find = (key: string) => httpContract.find((def) => `${def.method} ${def.path}` === key);
		// 定位到一个已有资源后新建别类 / 同类
		expect(find("POST /orchestrations/:id/runs")).toMatchObject({
			effect: "write",
			resource: { kind: "scenario", target: { params: "id" } },
			creates: "run",
		});
		expect(find("POST /orchestrations/:id/copy")).toMatchObject({
			resource: { kind: "scenario", target: { params: "id" } },
			creates: "scenario",
		});
		// 新建、没有定位到已有资源：不写 creates
		expect(find("POST /orchestrations")).toMatchObject({
			resource: { kind: "scenario", target: "collection" },
		});
		expect(find("POST /orchestrations")?.creates).toBeUndefined();
		// 让资源（或它的一部分）不再可用
		const removing = httpContract
			.filter((def) => def.removes)
			.map((def) => `${def.method} ${def.path}`);
		expect(removing.sort()).toEqual([
			"DELETE /feishu-bots/:name",
			"DELETE /orchestrations/:id/presets/:presetId",
			"POST /orchestrations/:id/archive",
		]);
		// 恢复归档、改、取消都不是 removes
		expect(find("POST /orchestrations/:id/unarchive")?.removes).toBeUndefined();
		expect(find("POST /runs/:id/cancel")?.removes).toBeUndefined();
		const creating = httpContract
			.filter((def) => def.creates)
			.map((def) => `${def.method} ${def.path}`);
		expect(creating.sort()).toEqual([
			"POST /orchestrations/:id/copy",
			"POST /orchestrations/:id/runs",
		]);
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

/** 只给这个接口自己的路径前缀登记它声明的类别（让路径前缀的检查不挡着别的测试）。 */
const rulesFor = (def: RouteDef): DeclarationRules => {
	const [first = ""] = def.path.split("/").filter(Boolean);
	const kind = def.resource?.kind;
	return {
		pathKinds: kind ? { [`/${first}`]: { kind, why: "测试" } } : {},
		readsWithTraces: READS_WITH_TRACES,
	};
};

describe("写得不对的声明：检查给出具体的问题", () => {
	const problems = (def: RouteDef) => checkRouteDeclarations([def], rulesFor(def));

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
		const withBody = {
			method: "POST",
			effect: "write",
			body: z.object({ name: z.string() }).refine(() => true),
		};
		expect(
			problems(broken({ resource: { kind: "agent", target: { body: "name" } } }, withBody)),
		).toEqual([]);
		expect(
			problems(broken({ resource: { kind: "agent", target: { body: "id" } } }, withBody))[0],
		).toContain("字段 id，它不在 body 里");
		// 套了一层包装的对象也认得出
		const wrapped = {
			method: "POST",
			effect: "write",
			body: z.object({ name: z.string() }).optional(),
		};
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

	it("GET 必须只读，DELETE 必须声明 removes，非 GET 的只读接口必须登记", () => {
		expect(problems(broken({ effect: "write" }))[0]).toContain("GET 要声明为只读");
		expect(problems(broken({ method: "DELETE", effect: "write" }))[0]).toContain(
			"DELETE 接口要声明 removes: true",
		);
		expect(problems(broken({ method: "DELETE", effect: "write", removes: true }))).toEqual([]);
		expect(
			problems(broken({ method: "POST", effect: "read", path: "/things/:id/query" }))[0],
		).toContain("READS_WITH_TRACES");
		// 登记过的（这里用测试自己的一张表，真正的 READS_WITH_TRACES 现在是空的）就没有问题
		const registered: DeclarationRules = {
			...rulesFor(broken({})),
			readsWithTraces: { "POST /things/:id/query": "测试：只写内存里的状态" },
		};
		expect(
			checkRouteDeclarations(
				[broken({ method: "POST", effect: "read", path: "/things/:id/query" })],
				registered,
			),
		).toEqual([]);
	});

	it("READS_WITH_TRACES 没有登记任何接口时机制仍然有效：非 GET 的只读接口被拦下，登记后才通过", () => {
		const def = broken({ method: "POST", effect: "read", path: "/things/:id/query" });
		const rules = { ...rulesFor(def), readsWithTraces: {} };
		expect(checkRouteDeclarations([def], rules)).toEqual([
			expect.stringContaining("方法不是 GET 的只读接口要登记在 READS_WITH_TRACES"),
		]);
		expect(
			checkRouteDeclarations([def], {
				...rules,
				readsWithTraces: { "POST /things/:id/query": "测试：只写内存里的状态" },
			}),
		).toEqual([]);
		// 登记了、但契约里没有这个接口（接口删了、表里留着）：表检查也报错
		expect(
			checkDeclarationTables([], {
				pathKinds: {},
				readsWithTraces: { "POST /things/:id/query": "测试：只写内存里的状态" },
			}),
		).toEqual(["READS_WITH_TRACES 的 POST /things/:id/query 不在契约里：接口改名或删掉了"]);
	});

	it("creates 要是资源类别、只能在写接口上；removes 只能写 true、只能在写接口上、不能和 creates 同时出现", () => {
		const post = { method: "POST", effect: "write" };
		expect(problems(broken({ ...post, creates: "run" }))).toEqual([]);
		expect(problems(broken({ ...post, creates: "scenario" }))).toEqual([]);
		expect(problems(broken({ ...post, creates: "orchestration" }))[0]).toContain(
			"creates 要写 scenario",
		);
		expect(problems(broken({ creates: "run" }))).toHaveLength(1);
		expect(problems(broken({ ...post, effect: "read", creates: "run" })).join("\n")).toContain(
			"只读接口不能声明 creates",
		);
		expect(problems(broken({ ...post, removes: true }))).toEqual([]);
		expect(problems(broken({ ...post, removes: false }))[0]).toContain("removes 只能写 true");
		expect(problems(broken({ ...post, effect: "read", removes: true })).join("\n")).toContain(
			"只读接口不能声明 removes",
		);
		expect(problems(broken({ ...post, removes: true, creates: "run" }))[0]).toContain(
			"creates 和 removes 不能同时声明",
		);
	});

	it("每个有问题的接口各报各的，带着方法和路径", () => {
		const defs = [
			broken({ summary: "" }),
			broken({}),
			broken({ effect: "x" }, { method: "PATCH", path: "/other/:id" }),
		];
		const list = checkRouteDeclarations(defs, {
			pathKinds: {
				"/things": { kind: "scenario", why: "测试" },
				"/other": { kind: "scenario", why: "测试" },
			},
			readsWithTraces: {},
		});
		expect(list).toHaveLength(2);
		expect(list[0]).toMatch(/^GET \/things\/:id：/);
		expect(list[1]).toMatch(/^PATCH \/other\/:id：/);
	});
});

describe("资源类别和路径前缀对得上（kind 写错、system 写错都拦得住）", () => {
	const real = (key: string): RouteDef => {
		const def = httpContract.find((d) => `${d.method} ${d.path}` === key);
		if (!def) throw new Error(`契约里没有 ${key}`);
		return def;
	};
	const withResource = (def: RouteDef, resource: RouteDef["resource"]) => ({ ...def, resource });
	const problems = (def: RouteDef) => checkRouteDeclarations([def], DECLARATION_RULES);

	it("现有接口都过", () => {
		expect(checkRouteDeclarations(httpContract, DECLARATION_RULES)).toEqual([]);
		expect(checkDeclarationTables(httpContract, DECLARATION_RULES)).toEqual([]);
		expect(checkPathKindsCover(DECLARATION_RULES)).toEqual([]);
	});

	it("把 /dashboard 写成 system + global：拦住，说明写 system 就是公开，也说明怎么改", () => {
		const wrong = withResource(dashboardApi.get, { kind: "system", target: "global" });
		const [problem, ...rest] = problems(wrong);
		expect(rest).toEqual([]);
		expect(problem).toContain(
			"GET /dashboard：resource.kind 写的是 system，PATH_KINDS 里 /dashboard 对应 run",
		);
		expect(problem).toContain("声明成 system 就等于这个接口不带项目、不需要凭据（公开）");
		expect(problem).toContain("声明写错了就改成 run");
		expect(problem).toContain("在 PATH_KINDS 里为它加一个更长的前缀并写明理由");
	});

	it("把平台自身的接口写成别的类别：拦住", () => {
		const wrong = withResource(real("GET /health"), { kind: "run", target: "collection" });
		expect(problems(wrong).join("\n")).toContain(
			"/health 是平台自身的接口（system，不带项目、不需要凭据）",
		);
		const docs = withResource(real("GET /llms.txt"), { kind: "scenario", target: "collection" });
		expect(problems(docs).join("\n")).toContain("声明写错了就改成 system");
	});

	it("写接口的 kind 写错：拦住（飞书测试消息写成 agent）", () => {
		const wrong = withResource(feishuBotsApi.test, { kind: "agent", target: { params: "name" } });
		expect(problems(wrong).join("\n")).toContain(
			"resource.kind 写的是 agent，PATH_KINDS 里 /feishu-bots 对应 feishu_bot",
		);
	});

	it("路径不在表里的新接口：拦住，说明要在表里加一项并写理由", () => {
		const added = endpoint({
			method: "GET",
			path: "/accounts/:id",
			summary: "读一个账号",
			effect: "read",
			resource: { kind: "scenario", target: { params: "id" } },
			client: false,
			key: ["accounts", "get"],
			params: z.object({ id: z.string() }),
			response: z.object({}),
		});
		const [problem] = problems(added);
		expect(problem).toContain("路径 /accounts/:id 不在 PATH_KINDS（http/declarations.ts）里");
		expect(problem).toContain('"/accounts": { kind: …, why: "…" }');
		expect(problem).toContain('"/accounts/:id": { kind: "system", exact: true, why: "…" }');
	});

	it("system 的每条路径都要单独列出来：新增一个 system 接口一定要改表，落在已有 system 路径下面的也不行", () => {
		const system = (path: string) =>
			endpoint({
				method: "GET",
				path,
				summary: "测试",
				effect: "read",
				resource: { kind: "system", target: "global" },
				client: false,
				key: ["x", "y"],
				response: z.object({}),
			});
		// 现有的 system 接口各自在表里
		expect(checkRouteDeclarations([system("/health")], DECLARATION_RULES)).toEqual([]);
		expect(checkRouteDeclarations([system("/docs/:page.md")], DECLARATION_RULES)).toEqual([]);
		// 新增的 system 接口：哪怕正好在 /docs 这样已有的路径下面，表里没有就报错
		for (const path of [
			"/docs/admin",
			"/health/secret",
			"/agent/binaries/:version/:arch/extra",
			"/new-public",
		]) {
			const found = checkRouteDeclarations([system(path)], DECLARATION_RULES);
			expect(found.join("\n"), path).toContain(`路径 ${path} 不在 PATH_KINDS`);
		}
		// 表里的 system 项忘了写 exact：表检查报错
		const loose = checkDeclarationTables([system("/health")], {
			pathKinds: { "/health": { kind: "system", why: "健康检查" } },
			readsWithTraces: {},
		});
		expect(loose.join("\n")).toContain("PATH_KINDS 的 /health 是 system，要写 exact: true");
		// 现有表里的 system 项都是 exact
		for (const [prefix, entry] of Object.entries(PATH_KINDS)) {
			if (entry.kind === "system") expect(entry.exact, prefix).toBe(true);
		}
	});

	it("前缀按路径段匹配，取最长的一项；例外写成更长的前缀", () => {
		const rules: DeclarationRules = {
			pathKinds: {
				"/runs": { kind: "run", why: "运行" },
				"/runs/:id/special": { kind: "system", why: "例外" },
			},
			readsWithTraces: {},
		};
		const make = (path: string, kind: "run" | "system") =>
			endpoint({
				method: "GET",
				path,
				summary: "测试",
				effect: "read",
				resource:
					kind === "system" ? { kind, target: "global" } : { kind, target: { params: "id" } },
				client: false,
				key: ["x", "y"],
				params: z.object({ id: z.string() }),
				response: z.object({}),
			});
		expect(checkRouteDeclarations([make("/runs/:id", "run")], rules)).toEqual([]);
		expect(checkRouteDeclarations([make("/runs/:id/special", "system")], rules)).toEqual([]);
		expect(checkRouteDeclarations([make("/runs/:id/special", "run")], rules).join("\n")).toContain(
			"对应 system",
		);
		// /runs-x 不在 /runs 下
		expect(checkRouteDeclarations([make("/runs-x/:id", "run")], rules)[0]).toContain(
			"不在 PATH_KINDS",
		);
	});

	it("表本身：没有接口用的前缀、没有前缀的类别、登记了不存在或不是只读的接口，都报错", () => {
		const contract = [real("GET /health"), real("GET /runs/:id")];
		const tables = (rules: Partial<DeclarationRules>) =>
			checkDeclarationTables(contract, { ...DECLARATION_RULES, ...rules });
		const own = Object.fromEntries(
			Object.entries(PATH_KINDS).filter(([prefix]) => ["/health", "/runs"].includes(prefix)),
		);
		expect(tables({ pathKinds: own, readsWithTraces: {} })).toEqual([]);
		const cover = checkPathKindsCover({ pathKinds: own, readsWithTraces: {} }).join("\n");
		expect(cover).toContain("资源类别 scenario 在 PATH_KINDS 里没有任何路径前缀");
		expect(cover).not.toContain("资源类别 run ");

		const stale = tables({
			pathKinds: { ...own, "/old": { kind: "run", why: "旧的" } },
			readsWithTraces: { "POST /gone": "没有这个接口", "GET /runs/:id": "不是写" },
		}).join("\n");
		expect(stale).toContain("PATH_KINDS 的 /old 没有接口在用");
		expect(stale).toContain("READS_WITH_TRACES 的 POST /gone 不在契约里");
		expect(stale).not.toContain("没有声明为只读");

		const notRead = tables({
			pathKinds: own,
			readsWithTraces: { "GET /runs/:id": "" },
		}).join("\n");
		expect(notRead).toContain("READS_WITH_TRACES 的 GET /runs/:id：要写明写了什么");
		const bad = tables({
			pathKinds: { "no-slash": { kind: "run", why: "" } },
			readsWithTraces: {},
		}).join("\n");
		expect(bad).toContain("PATH_KINDS 的键 no-slash 要以 / 开头");
		expect(bad).toContain("PATH_KINDS 的 no-slash：要写明为什么");
	});

	it("{ params } 必须是路径里的第一个参数", () => {
		const nested = endpoint({
			method: "GET",
			path: "/runs/:id/steps/:step",
			summary: "测试",
			effect: "read",
			resource: { kind: "run", target: { params: "step" } },
			client: false,
			key: ["runs", "step"],
			params: z.object({ id: z.string(), step: z.string() }),
			response: z.object({}),
		});
		const [problem] = problems(nested);
		expect(problem).toContain("路径参数 step 不是路径里的第一个参数 :id");
		expect(problem).toContain('改成 { params: "id" }');
		expect(problems({ ...nested, resource: { kind: "run", target: { params: "id" } } })).toEqual(
			[],
		);
	});
});
