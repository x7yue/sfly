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
	NON_GET_READS,
	PATH_KINDS,
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
		expect(nonGetReads.sort()).toEqual(Object.keys(NON_GET_READS).sort());
	});

	it("NON_GET_READS 里的接口都在契约里、都声明为只读，都写明了为什么只读、会留下什么", () => {
		const known = new Map(httpContract.map((def) => [`${def.method} ${def.path}`, def]));
		for (const [key, what] of Object.entries(NON_GET_READS)) {
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
			"DELETE /account/tokens/:id",
			"DELETE /feishu-bots/:name",
			"DELETE /orchestrations/:id/presets/:presetId",
			"DELETE /projects/:project/agents/:name/credentials/:id",
			"DELETE /projects/:project/dev-agents/:name",
			"DELETE /projects/:project/tokens/:id",
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
		nonGetReads: NON_GET_READS,
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
					path: "/projects/:project/things",
					params: z.object({ project: z.string() }),
				}),
			),
		).toEqual([]);
	});

	it("列表、新建、上传和按名字定位的路径带 :project，按 ID 定位的不带；system、account 都不带（ADR 0029）", () => {
		const at = (resource: unknown, path: string, extra: Record<string, unknown> = {}) =>
			problems(broken({ resource, path, params: undefined }, extra));
		const message = "路径要写成 /projects/:project/…";
		expect(at({ kind: "scenario", target: "collection" }, "/things").join()).toContain(message);
		expect(at({ kind: "package", target: "upload" }, "/things", { upload: true }).join()).toContain(
			message,
		);
		expect(at({ kind: "agent", target: { params: "name" } }, "/things/:name").join()).toContain(
			message,
		);
		expect(
			at({ kind: "agent", target: { params: "name" } }, "/projects/:project/things/:name"),
		).toEqual([]);
		expect(at({ kind: "run", target: { params: "id" } }, "/things/:id")).toEqual([]);
		// 名字写在查询参数或请求体里也是按名字定位：路径同样要带项目（#834 审查）。
		const byName = z.object({ name: z.string() });
		const viaQuery = { kind: "feishu_bot", target: { query: "name" } };
		const viaBody = { kind: "feishu_bot", target: { body: "name" } };
		const post = { method: "POST", effect: "write" };
		expect(at(viaQuery, "/things", { query: byName }).join()).toContain(message);
		expect(at(viaBody, "/things", { ...post, body: byName }).join()).toContain(message);
		expect(
			at(viaQuery, "/projects/:project/things", {
				query: byName,
				params: z.object({ project: z.string() }),
			}),
		).toEqual([]);
		expect(
			at(viaBody, "/projects/:project/things", {
				...post,
				body: byName,
				params: z.object({ project: z.string() }),
			}),
		).toEqual([]);
		// 按 ID 定位的从查询参数取 ID：路径不带项目，不报。
		expect(
			at({ kind: "run", target: { query: "id" } }, "/things", {
				query: z.object({ id: z.string() }),
			}),
		).toEqual([]);
		expect(at({ kind: "system", target: "global" }, "/projects/:project/things").join()).toContain(
			"system 不属于项目",
		);
		// 还没有搬过去的接口登记在 projectPathPending 里，先不报。
		const pending = broken({
			resource: { kind: "scenario", target: "collection" },
			path: "/things",
			params: undefined,
		});
		expect(
			checkRouteDeclarations([pending], {
				...rulesFor(pending),
				projectPathPending: { "GET /things": "测试" },
			}),
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
		// 用按 ID 定位的类别（运行）：路径里不带项目也合法，只看字段在不在请求里。
		const withQuery = { query: z.object({ owner: z.string() }) };
		expect(
			problems(broken({ resource: { kind: "run", target: { query: "owner" } } }, withQuery)),
		).toEqual([]);
		expect(
			problems(broken({ resource: { kind: "run", target: { query: "who" } } }, withQuery))[0],
		).toContain("字段 who，它不在 query 里");
		expect(
			problems(broken({ resource: { kind: "run", target: { query: "owner" } } }))[0],
		).toContain("没有对象形式的 query");
		const withBody = {
			method: "POST",
			effect: "write",
			body: z.object({ name: z.string() }).refine(() => true),
		};
		expect(
			problems(broken({ resource: { kind: "run", target: { body: "name" } } }, withBody)),
		).toEqual([]);
		expect(
			problems(broken({ resource: { kind: "run", target: { body: "id" } } }, withBody))[0],
		).toContain("字段 id，它不在 body 里");
		// 套了一层包装的对象也认得出
		const wrapped = {
			method: "POST",
			effect: "write",
			body: z.object({ name: z.string() }).optional(),
		};
		expect(
			problems(broken({ resource: { kind: "run", target: { body: "name" } } }, wrapped)),
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
					path: "/projects/:project/things",
					params: z.object({ project: z.string() }),
				}),
			)[0],
		).toContain("接口不是上传");
		expect(
			problems(
				broken(
					{
						resource: { kind: "package", target: "upload" },
						path: "/projects/:project/things",
						params: z.object({ project: z.string() }),
					},
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

	it("账号（account）：self 只用于账号，是发起请求的用户自己，路径里不能有参数；管理别人的账号用路径参数或 collection", () => {
		const account = (target: unknown, path: string, params?: unknown) =>
			broken({
				path,
				resource: { kind: "account", target },
				...(params === undefined ? { params: undefined } : { params }),
			});
		// 合法：自己（路径没有参数）、用户 ID（路径参数）、列表和新建。
		expect(problems(account("self", "/auth/me"))).toEqual([]);
		expect(problems(account({ params: "id" }, "/users/:id"))).toEqual([]);
		expect(problems(account("collection", "/users"))).toEqual([]);
		// self 不是账号：只用于 account。
		expect(
			problems(broken({ resource: { kind: "scenario", target: "self" }, path: "/things" }))[0],
		).toContain("self 只用于 account");
		expect(
			problems(broken({ resource: { kind: "system", target: "self" }, path: "/things" })).join(
				"；",
			),
		).toContain("self 只用于 account");
		// self 的路径里有参数：有参数就是在定位别人的账号。
		expect(problems(account("self", "/auth/:id"))[0]).toContain("self，但路径里有参数");
	});

	it("路径带项目（/projects/:project/…）的列表和新建用 collection：:project 只限定项目，不算在定位资源", () => {
		const project = z.object({ project: z.string() });
		const scoped = { path: "/projects/:project/things", params: project };
		const collection = { kind: "scenario", target: "collection" };
		expect(problems(broken({ resource: collection, ...scoped }))).toEqual([]);
		// 项目之外还有别的路径参数，就是在定位某个资源，仍然不能写 collection。
		expect(
			problems(
				broken({
					resource: collection,
					path: "/projects/:project/things/:id",
					params: project.extend({ id: z.string() }),
				}),
			)[0],
		).toContain("路径里有参数");
		// 不是 /projects/:project/ 下面的 :project 参数（别的路径里碰巧叫 project 的参数）不是项目。
		expect(
			problems(broken({ resource: collection, path: "/things/:project", params: project }))[0],
		).toContain("路径里有参数");
		// 用 { params: "project" } 定位项目本身（以后的资源类别 project）：不是用 ID 定位的类别照旧可以；
		// 用 ID 定位的类别（场景、运行、任务、会话）在这类路径上只接受 collection，写 { params: "project" } 也拒绝。
		expect(
			problems(broken({ resource: { kind: "package", target: { params: "project" } }, ...scoped })),
		).toEqual([]);
		for (const kind of ["scenario", "run", "task", "session"] as const) {
			const found = problems(
				broken({ resource: { kind, target: { params: "project" } }, ...scoped }),
			);
			expect(found, kind).toHaveLength(1);
			expect(found[0], kind).toContain("只能写 collection");
		}
	});

	it('/projects/:project/… 下还有别的路径参数：用 ID 定位的资源不带 :project，{ params: "project" } 不算定位；按名字定位的写 :project 之后的参数', () => {
		const project = z.object({ project: z.string() });
		const withId = {
			path: "/projects/:project/things/:id",
			params: project.extend({ id: z.string() }),
		};
		// 用 ID 定位的类别（场景、运行、任务、会话）：不管写 { params: "project" } 还是 { params: "id" }，路径都不该带项目。
		for (const kind of ["scenario", "run", "task", "session"] as const) {
			for (const params of ["project", "id"]) {
				const found = problems(broken({ resource: { kind, target: { params } }, ...withId }));
				expect(found, `${kind} ${params}`).toHaveLength(1);
				expect(found[0], `${kind} ${params}`).toContain("用 ID 定位，路径带 :project");
				expect(found[0], `${kind} ${params}`).toContain("只能写 collection");
				// 报错提示不能再叫人「改成 { params: "project" }」。
				expect(found[0], `${kind} ${params}`).not.toContain('改成 { params: "project" }');
				expect(found[0], `${kind} ${params}`).toContain('{ params: "id" }');
			}
		}
		// 按名字定位的类别（节点包、Agent、飞书机器人）：项目在路径里，定位的是 :project 之后的第一个参数。
		const byName = {
			path: "/projects/:project/things/:name",
			params: project.extend({ name: z.string() }),
		};
		expect(
			problems(broken({ resource: { kind: "package", target: { params: "name" } }, ...byName })),
		).toEqual([]);
		const wrongProject = problems(
			broken({ resource: { kind: "package", target: { params: "project" } }, ...byName }),
		);
		expect(wrongProject).toHaveLength(1);
		expect(wrongProject[0]).toContain('写了 { params: "project" }，但路径里还有 :name');
		expect(wrongProject[0]).toContain('改成 { params: "name" }');
		// :project 之后的第二个参数不是定位用的。
		const deeper = {
			path: "/projects/:project/things/:name/versions/:version",
			params: project.extend({ name: z.string(), version: z.string() }),
		};
		expect(
			problems(broken({ resource: { kind: "package", target: { params: "version" } }, ...deeper })),
		).toHaveLength(1);
		expect(
			problems(broken({ resource: { kind: "package", target: { params: "name" } }, ...deeper })),
		).toEqual([]);
		// 路径不带项目的（按 ID 定位）照旧：第一个参数就是定位用的。
		expect(
			problems(
				broken({ resource: { kind: "session", target: { params: "id" } }, path: "/sessions/:id" }),
			),
		).toEqual([]);
	});

	it("项目本身和它的管理面（project）：定位的就是路径里的 :project，它之后的参数（令牌 ID…）是项目名下的子项，不算在定位", () => {
		const project = z.object({ project: z.string() });
		const tokens = { path: "/projects/:project/tokens", params: project };
		const token = {
			path: "/projects/:project/tokens/:id",
			params: project.extend({ id: z.string() }),
		};
		const located = { kind: "project", target: { params: "project" } };
		// 列表、新建：只有 :project。吊销一个令牌：:project 之后还有令牌的 ID，定位的仍然是项目（要「管理」范围的是项目）。
		expect(problems(broken({ resource: located, ...tokens }))).toEqual([]);
		expect(problems(broken({ resource: located, ...token }))).toEqual([]);
		// 定位写成令牌 ID 不对：project 定位的是项目本身，访问检查只认路径里的 :project。
		const wrong = problems(
			broken({ resource: { kind: "project", target: { params: "id" } }, ...token }),
		);
		expect(wrong).toHaveLength(1);
		expect(wrong[0]).toContain(
			'project 定位的是项目本身，resource.target 写 { params: "project" }',
		);
		// 别的按名字定位的类别不受这条放宽影响：{ params: "project" } 仍然不算它们的定位。
		const byName = {
			path: "/projects/:project/things/:name",
			params: project.extend({ name: z.string() }),
		};
		expect(
			problems(broken({ resource: { kind: "package", target: { params: "project" } }, ...byName })),
		).toHaveLength(1);
	});

	it("/projects/:project/… 下用 ID 定位的类别写成 { query }、{ body } 也不行：只接受 collection；按名字定位的类别和路径不带项目的不受影响", () => {
		const project = z.object({ project: z.string() });
		for (const kind of ["scenario", "run", "task", "session"] as const) {
			// 路径只有 :project（列表和新建）：写 { body } 定位——访问检查只按路径里的项目查，不核对 body 里的 ID。
			const byBody = problems(
				broken({
					method: "POST",
					effect: "write",
					path: "/projects/:project/things",
					params: project,
					body: z.object({ thing_id: z.string() }),
					resource: { kind, target: { body: "thing_id" } },
				}),
			);
			expect(byBody, `${kind} body`).toHaveLength(1);
			expect(byBody[0], `${kind} body`).toContain("只能写 collection");
			// 路径还有别的参数、定位写成 { query }：同样不行（同一类绕过）。
			const byQuery = problems(
				broken({
					path: "/projects/:project/things/:id",
					params: project.extend({ id: z.string() }),
					query: z.object({ id: z.string() }),
					resource: { kind, target: { query: "id" } },
				}),
			);
			expect(byQuery, `${kind} query`).toHaveLength(1);
			expect(byQuery[0], `${kind} query`).toContain("只能写 collection");
			// collection 是对的。
			expect(
				problems(
					broken({
						method: "POST",
						effect: "write",
						path: "/projects/:project/things",
						params: project,
						resource: { kind, target: "collection" },
					}),
				),
				`${kind} collection`,
			).toEqual([]);
		}
		// 按名字定位的类别（节点包）：query、body 照旧可以（项目就是路径里的项目）。
		expect(
			problems(
				broken({
					method: "POST",
					effect: "write",
					path: "/projects/:project/things",
					params: project,
					body: z.object({ name: z.string() }),
					resource: { kind: "package", target: { body: "name" } },
				}),
			),
		).toEqual([]);
		// 路径不带项目的 ID 定位类别：{ query } 照旧可以（项目从那个 ID 得出，不看路径）。
		expect(
			problems(
				broken({
					path: "/things",
					params: undefined,
					query: z.object({ id: z.string() }),
					resource: { kind: "session", target: { query: "id" } },
				}),
			),
		).toEqual([]);
	});

	it("GET 必须只读，DELETE 必须声明 removes，非 GET 的只读接口必须登记", () => {
		expect(problems(broken({ effect: "write" }))[0]).toContain("GET 要声明为只读");
		expect(problems(broken({ method: "DELETE", effect: "write" }))[0]).toContain(
			"DELETE 接口要声明 removes: true",
		);
		expect(problems(broken({ method: "DELETE", effect: "write", removes: true }))).toEqual([]);
		expect(
			problems(broken({ method: "POST", effect: "read", path: "/things/:id/query" }))[0],
		).toContain("NON_GET_READS");
		// 登记过的（这里用测试自己的一张表）就没有问题
		const registered: DeclarationRules = {
			...rulesFor(broken({})),
			nonGetReads: { "POST /things/:id/query": "测试：只写内存里的状态" },
		};
		expect(
			checkRouteDeclarations(
				[broken({ method: "POST", effect: "read", path: "/things/:id/query" })],
				registered,
			),
		).toEqual([]);
	});

	it("表里没有登记的非 GET 只读接口被拦下，登记后才通过（和 NON_GET_READS 里现在有什么无关）", () => {
		const def = broken({ method: "POST", effect: "read", path: "/things/:id/query" });
		const rules = { ...rulesFor(def), nonGetReads: {} };
		expect(checkRouteDeclarations([def], rules)).toEqual([
			expect.stringContaining("方法不是 GET 的只读接口要登记在 NON_GET_READS"),
		]);
		expect(
			checkRouteDeclarations([def], {
				...rules,
				nonGetReads: { "POST /things/:id/query": "测试：只写内存里的状态" },
			}),
		).toEqual([]);
		// 登记了、但契约里没有这个接口（接口删了、表里留着）：表检查也报错
		expect(
			checkDeclarationTables([], {
				pathKinds: {},
				nonGetReads: { "POST /things/:id/query": "测试：只写内存里的状态" },
			}),
		).toEqual(["NON_GET_READS 的 POST /things/:id/query 不在契约里：接口改名或删掉了"]);
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
			nonGetReads: {},
		});
		expect(list).toHaveLength(2);
		expect(list[0]).toMatch(/^GET \/things\/:id：/);
		expect(list[1]).toMatch(/^PATCH \/other\/:id：/);
	});
});

describe("路径里的项目一律写成 /projects/:project/…（访问检查据此得出项目）", () => {
	const problems = (def: RouteDef) => checkRouteDeclarations([def], DECLARATION_RULES);
	const project = (patch: Record<string, unknown>) =>
		broken({
			method: "GET",
			path: "/projects/:project/tokens",
			resource: { kind: "project", target: { params: "project" } },
			key: ["tokens", "project"],
			params: z.object({ project: z.string() }),
			...patch,
		});

	it("项目令牌的接口（/projects/:project/tokens…）按 PATH_KINDS 里的一项登记，资源类别是 project，定位用路径里的 :project", () => {
		for (const key of [
			"GET /projects/:project/tokens",
			"POST /projects/:project/tokens",
			"DELETE /projects/:project/tokens/:id",
		]) {
			const def = httpContract.find((d) => `${d.method} ${d.path}` === key);
			expect(def?.resource, key).toEqual({ kind: "project", target: { params: "project" } });
			expect(problems(def as RouteDef), key).toEqual([]);
		}
		expect(PATH_KINDS["/projects/:project/tokens"]?.kind).toBe("project");
		expect(PATH_KINDS["/account"]?.kind).toBe("account");
	});

	it(":project 只能写在 /projects/:project/… 里：别处的 :project（PEP 503 的包曾经叫它）被拦下，说明改叫什么", () => {
		const other = broken({
			path: "/simple/:project/",
			resource: { kind: "system", target: "global" },
			params: z.object({ project: z.string() }),
		});
		expect(checkRouteDeclarations([other], { ...DECLARATION_RULES })[0]).toContain(
			"里的 :project 位置不对",
		);
		expect(problems(project({ path: "/things/:project/tokens" })).join("；")).toContain(
			"里的 :project 位置不对",
		);
		// 公开的简单索引现在叫 :package，没有这个问题。
		expect(problems(httpContract.find((d) => d.path === "/simple/:package/") as RouteDef)).toEqual(
			[],
		);
		expect(
			httpContract.some((d) => d.path.includes(":project") && !d.path.startsWith("/projects/")),
		).toBe(false);
	});

	it("/projects/ 后面一段不是 :project：拦下", () => {
		expect(
			problems(
				project({
					path: "/projects/:name/tokens",
					params: z.object({ name: z.string() }),
					resource: { kind: "project", target: { params: "name" } },
				}),
			).join("；"),
		).toContain("/projects/ 后面一段要写 :project");
	});

	it("路径带项目的接口写成别的资源类别：拦住（项目令牌的路径只能是 project）", () => {
		const wrong = project({ resource: { kind: "scenario", target: { params: "project" } } });
		expect(problems(wrong).join("；")).toContain(
			"PATH_KINDS 里 /projects/:project/tokens 对应 project",
		);
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
			nonGetReads: {},
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
			nonGetReads: {},
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
		expect(tables({ pathKinds: own, nonGetReads: {}, projectPathPending: {} })).toEqual([]);
		expect(
			tables({
				pathKinds: own,
				nonGetReads: {},
				projectPathPending: { "GET /gone": "测试" },
			}).join(),
		).toContain("PROJECT_PATH_PENDING 的 GET /gone 不在契约里");
		const cover = checkPathKindsCover({ pathKinds: own, nonGetReads: {} }).join("\n");
		expect(cover).toContain("资源类别 scenario 在 PATH_KINDS 里没有任何路径前缀");
		expect(cover).not.toContain("资源类别 run ");

		const stale = tables({
			projectPathPending: {},
			pathKinds: { ...own, "/old": { kind: "run", why: "旧的" } },
			nonGetReads: { "POST /gone": "没有这个接口", "GET /runs/:id": "不是写" },
		}).join("\n");
		expect(stale).toContain("PATH_KINDS 的 /old 没有接口在用");
		expect(stale).toContain("NON_GET_READS 的 POST /gone 不在契约里");
		expect(stale).not.toContain("没有声明为只读");

		const notRead = tables({
			projectPathPending: {},
			pathKinds: own,
			nonGetReads: { "GET /runs/:id": "" },
		}).join("\n");
		expect(notRead).toContain("NON_GET_READS 的 GET /runs/:id：要写明为什么只读、会留下什么");
		const bad = tables({
			pathKinds: { "no-slash": { kind: "run", why: "" } },
			nonGetReads: {},
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
