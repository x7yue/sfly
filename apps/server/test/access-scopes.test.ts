// 范围表（ADR 0029「一处检查」）：范围由「接口作用在哪类资源上 × 只读或写」查表得出，对着 ADR 里逐个接口的那张表，
// 每一行一条；契约里的每个接口都要有一个期望的范围，新加的写接口不在表里就失败，不会悄悄没人管。
import { httpContract, ID_LOCATED_KINDS, RESOURCE_KINDS, type RouteDef } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	ACCOUNT_ROUTES,
	checkAccessRules,
	checkCredentialRoutes,
	locatorOf,
	routeKey,
} from "../src/auth/access-rules.js";
import {
	effectiveScopes,
	PLATFORM_ADMIN_SCOPES,
	ROLE_SCOPES,
	requiredScope,
	SCOPE_TABLE,
	SCOPES,
	type Scope,
	writeNeedsPerson,
} from "../src/auth/scopes.js";

/**
 * ADR 0029 范围表里每一行对应的接口和它要的范围。只读接口都是「读」，不在这里列：
 * 契约里声明为 `read` 的接口（含 POST 的在线编辑者心跳，它写的只是内存里的名单）。
 * `null`：没有人和程序能调用（任务的写：上传产物只给 Agent 凭据）。
 */
const WRITE_ROUTES: Record<string, Scope | null> = {
	// 保存版本、恢复版本、改设置（运行通知、关注项）、新建、归档与恢复场景（场景，写）→ 编辑
	"POST /orchestrations/:id/versions": "edit",
	"POST /orchestrations/:id/versions/:number/restore": "edit",
	"PATCH /orchestrations/:id": "edit",
	"POST /orchestrations": "edit",
	"POST /orchestrations/:id/archive": "edit",
	"POST /orchestrations/:id/unarchive": "edit",
	// 复制场景（场景，写，creates: scenario）：源场景只被读；新建的是场景 → 编辑
	"POST /orchestrations/:id/copy": "edit",
	// 运行预设的增改、复制、删除（场景，写）→ 编辑
	"POST /orchestrations/:id/presets": "edit",
	"PATCH /orchestrations/:id/presets/:presetId": "edit",
	"POST /orchestrations/:id/presets/:presetId/copy": "edit",
	"DELETE /orchestrations/:id/presets/:presetId": "edit",
	// 触发运行（场景，写，creates: run）：场景只被读；新建的是运行 → 运行
	"POST /orchestrations/:id/runs": "run",
	// 取消运行（运行，写）→ 运行
	"POST /runs/:id/cancel": "run",
	// 发布正式版本（节点包，写，upload）→ 发布
	"POST /packages": "publish",
	// Agent 立即更新、飞书机器人的增删改与测试消息（写）→ 管理
	"POST /agents/:name/update-now": "manage",
	"POST /feishu-bots": "manage",
	"PATCH /feishu-bots/:name": "manage",
	"DELETE /feishu-bots/:name": "manage",
	"POST /feishu-bots/:name/test": "manage",
	// 项目令牌的签发、吊销（项目，写）→ 管理
	"POST /projects/:project/tokens": "manage",
	"DELETE /projects/:project/tokens/:id": "manage",
	// 上传产物（任务，写）→ 不给人和程序：只有 Agent 凭据，限派给这台 Agent 的任务
	"PUT /tasks/:id/artifacts/*": null,
	// 建会话、对它说话、停止它（会话，写）→ 编辑：都是在驱动对场景的修改（ADR 0029 的范围表没有会话这一行，ADR 0027 补记）
	"POST /projects/:project/sessions": "edit",
	"POST /sessions/:id/messages": "edit",
	"POST /sessions/:id/stop": "edit",
};

/**
 * 读也不是「读」的接口：项目的管理面（成员、项目令牌、项目密钥）的列表要「管理」，只读和编辑者看不到
 * （ADR 0029 的范围表里「列出项目令牌（项目，读）」一行）。其余只读接口都是「读」。
 */
const MANAGED_READS: Record<string, Scope> = {
	"GET /projects/:project/tokens": "manage",
};

describe("范围表：接口 × 范围", () => {
	it("契约里每个写接口的范围和 ADR 的表一致，只读接口都是「读」", () => {
		const seen = new Set<string>();
		for (const def of httpContract) {
			const key = routeKey(def);
			// 账号类接口不属于项目，不走范围表：见下面「账号类接口」。
			if (def.resource.kind === "account") continue;
			if (def.effect === "read") {
				expect(requiredScope(def), key).toBe(MANAGED_READS[key] ?? "read");
				continue;
			}
			seen.add(key);
			expect(
				key in WRITE_ROUTES,
				`${key} 是新的写接口：在 ADR 0029 的范围表和这个测试的 WRITE_ROUTES 里补一行`,
			).toBe(true);
			expect(requiredScope(def), key).toBe(WRITE_ROUTES[key]);
		}
		expect([...Object.keys(WRITE_ROUTES)].filter((key) => !seen.has(key))).toEqual([]);
	});

	it("范围取 creates（有的话），否则取 resource.kind：复制场景要「编辑」、触发运行要「运行」，不看定位到的场景", () => {
		const base = { effect: "write" as const, resource: { kind: "scenario" as const } };
		expect(requiredScope(base)).toBe("edit");
		expect(requiredScope({ ...base, creates: "scenario" })).toBe("edit");
		expect(requiredScope({ ...base, creates: "run" })).toBe("run");
		expect(requiredScope({ ...base, resource: { kind: "run" } })).toBe("run");
		expect(requiredScope({ effect: "write", resource: { kind: "package" } })).toBe("publish");
		expect(requiredScope({ effect: "write", resource: { kind: "agent" } })).toBe("manage");
		expect(requiredScope({ effect: "write", resource: { kind: "feishu_bot" } })).toBe("manage");
		expect(requiredScope({ effect: "write", resource: { kind: "session" } })).toBe("edit");
		expect(requiredScope({ effect: "read", resource: { kind: "session" } })).toBe("read");
		expect(requiredScope({ effect: "write", resource: { kind: "task" } })).toBeNull();
		expect(requiredScope({ effect: "read", resource: { kind: "task" } })).toBe("read");
		// 项目的管理面：读和写都要管理。
		expect(requiredScope({ effect: "read", resource: { kind: "project" } })).toBe("manage");
		expect(requiredScope({ effect: "write", resource: { kind: "project" } })).toBe("manage");
	});

	it("读也要管理的类别只有项目的管理面（project）：别的类别的读都是「读」", () => {
		const managed = (Object.entries(SCOPE_TABLE) as [string, { read?: string }][])
			.filter(([, row]) => (row.read ?? "read") !== "read")
			.map(([kind]) => kind);
		expect(managed).toEqual(["project"]);
		// MANAGED_READS 里的每一行都在契约里，且都是 project 的读接口。
		for (const key of Object.keys(MANAGED_READS)) {
			const def = httpContract.find((d) => routeKey(d) === key);
			expect(def?.resource.kind, key).toBe("project");
			expect(def?.effect, key).toBe("read");
		}
	});

	it("每个资源类别在范围表里都有一行", () => {
		expect(Object.keys(SCOPE_TABLE).sort()).toEqual([...RESOURCE_KINDS].sort());
	});
});

describe("角色是固定的一组范围（ADR 0029 的表）", () => {
	it("只读只有读；编辑者没有管理；项目管理员全有；平台管理员和项目管理员一样", () => {
		expect(ROLE_SCOPES.read_only).toEqual(["read"]);
		expect(ROLE_SCOPES.editor).toEqual(["read", "run", "edit", "session_build", "publish"]);
		expect([...ROLE_SCOPES.project_admin].sort()).toEqual([...SCOPES].sort());
		expect([...PLATFORM_ADMIN_SCOPES]).toEqual([...ROLE_SCOPES.project_admin]);
	});

	it("令牌的范围和用户此刻的范围取交集；登录没有自己的范围；令牌里不认识的范围名没有意义", () => {
		expect(effectiveScopes(ROLE_SCOPES.editor, ["read", "run", "manage"])).toEqual(["read", "run"]);
		expect(effectiveScopes(ROLE_SCOPES.read_only, [...SCOPES])).toEqual(["read"]);
		expect(effectiveScopes(ROLE_SCOPES.editor, undefined)).toEqual([...ROLE_SCOPES.editor]);
		expect(effectiveScopes(ROLE_SCOPES.project_admin, ["read", "nonsense"])).toEqual(["read"]);
		expect(effectiveScopes(ROLE_SCOPES.project_admin, [])).toEqual([]);
	});
});

describe("只有人能做的写（范围表的 humanOnly）", () => {
	const writeOf = (
		kind: (typeof RESOURCE_KINDS)[number],
		creates?: (typeof RESOURCE_KINDS)[number],
	) => ({
		effect: "write" as const,
		resource: { kind },
		...(creates === undefined ? {} : { creates }),
	});

	it("会话的写（建、发话、停止）只有人能做：范围表里 session 是 humanOnly，别的类别不是", () => {
		expect(writeNeedsPerson(writeOf("session"))).toBe(true);
		expect(writeNeedsPerson(writeOf("project"))).toBe(true);
		// 看新建出来的是什么（和范围同一个取法）：新建会话的接口声明 creates 时也算。
		expect(writeNeedsPerson(writeOf("scenario", "session"))).toBe(true);
		for (const kind of RESOURCE_KINDS.filter((k) => k !== "session" && k !== "project")) {
			expect(writeNeedsPerson(writeOf(kind)), kind).toBe(false);
		}
		// 只读不受影响。
		expect(writeNeedsPerson({ effect: "read", resource: { kind: "session" } })).toBe(false);
		// 契约里恰好是会话的三个写接口。
		expect(
			httpContract
				.filter((def) => def.effect === "write" && writeNeedsPerson(def))
				.map(routeKey)
				.sort(),
		).toEqual([
			"DELETE /projects/:project/tokens/:id",
			"POST /projects/:project/sessions",
			"POST /projects/:project/tokens",
			"POST /sessions/:id/messages",
			"POST /sessions/:id/stop",
		]);
	});

	it("范围表每一行都写了 humanOnly（布尔）：新的资源类别漏写过不了类型检查，这里运行时也核对一遍", () => {
		for (const kind of RESOURCE_KINDS) {
			expect(typeof SCOPE_TABLE[kind].humanOnly, kind).toBe("boolean");
		}
		expect(RESOURCE_KINDS.filter((kind) => SCOPE_TABLE[kind].humanOnly)).toEqual(["session", "project"]);
	});

	it("作用在 humanOnly 的类别上、或新建出的是它，任何一个都算（不能靠写成别的 creates 绕过）", () => {
		expect(writeNeedsPerson(writeOf("session", "scenario"))).toBe(true);
		expect(writeNeedsPerson(writeOf("scenario", "session"))).toBe(true);
		expect(writeNeedsPerson(writeOf("scenario", "run"))).toBe(false);
	});

	it("在「范围够」之上再加一层：humanOnly 的写，范围表里的范围仍是「编辑」", () => {
		expect(SCOPE_TABLE.session).toEqual({ write: "edit", humanOnly: true });
		expect(requiredScope(writeOf("session"))).toBe("edit");
	});
});

describe("契约和访问检查的规则对得上", () => {
	it("按 ID 定位的类别（ID_LOCATED_KINDS，声明检查用）和访问检查的 locatorOf 是同一批：加一个类别只改一处会红", () => {
		const idLocated = RESOURCE_KINDS.filter((kind) => {
			const probe = {
				path: "/probe/:id",
				resource: { kind, target: { params: "id" } },
			} as Pick<RouteDef, "path" | "resource">;
			const locator = locatorOf(probe);
			// 「从资源本身的 ID 找项目」：locator 带着路径参数名，来源就是这个类别自己。
			// 不按「来源等于类别」一条判：以后有类别从别处得出项目（不靠路径里的资源 ID），不该算进去。
			return (
				locator !== undefined &&
				"param" in locator &&
				locator.param !== null &&
				locator.from === kind
			);
		});
		expect([...idLocated].sort()).toEqual([...ID_LOCATED_KINDS].sort());
	});

	it("每个接口的项目从哪里得出都认得出，两份凭据清单里的接口都在契约里", () => {
		expect(checkAccessRules(httpContract)).toEqual([]);
		expect(checkCredentialRoutes(httpContract)).toEqual([]);
	});

	it("不属于项目的接口（system，不需要凭据）只能是只读的：有副作用的 system 接口会让检查报错", () => {
		const readOnly = httpContract.find(
			(def) => def.resource.kind === "system",
		) as (typeof httpContract)[number];
		expect(checkAccessRules([readOnly])).toEqual([]);
		const write = {
			...readOnly,
			method: "POST",
			effect: "write",
		} as unknown as (typeof httpContract)[number];
		expect(checkAccessRules([write])).toEqual([expect.stringContaining("只能是只读的")]);
	});

	it("项目的五类加账号类：不属于项目、路径带项目、经场景、经运行或任务、经会话、账号（不属于项目，不走范围表）", () => {
		const classes = new Map<string, string[]>();
		for (const def of httpContract) {
			const locator = locatorOf(def);
			const label = locator?.from === "path" ? "path" : (locator?.from ?? "undefined");
			classes.set(label, [...(classes.get(label) ?? []), routeKey(def)]);
		}
		expect([...classes.keys()].sort()).toEqual([
			"account",
			"none",
			"path",
			"run",
			"scenario",
			"session",
			"task",
		]);
		// 列表与新建（场景、运行、Agent、节点包、飞书机器人、控制台统计）和按名字定位的 Agent、节点包、飞书机器人。
		expect(classes.get("path")).toEqual(
			expect.arrayContaining([
				"GET /agents",
				"POST /agents/:name/update-now",
				"GET /dashboard",
				"GET /runs",
				"GET /orchestrations",
				"POST /orchestrations",
				"GET /packages",
				"POST /packages",
				"GET /packages/:name/versions/:version/archive",
				"GET /feishu-bots",
				"DELETE /feishu-bots/:name",
				// 会话的列表和新建：路径里的 :project 是项目（会话的集合属于项目）。
				"GET /projects/:project/sessions",
				"POST /projects/:project/sessions",
			]),
		);
		expect(classes.get("scenario")).toContain("POST /orchestrations/:id/runs");
		expect(classes.get("run")).toContain("POST /runs/:id/cancel");
		expect(classes.get("task")).toContain("PUT /tasks/:id/artifacts/*");
		// 按会话 ID 定位的，路径里不带项目：项目从会话得出。
		expect(classes.get("session")).toEqual(
			expect.arrayContaining([
				"GET /sessions/:id",
				"GET /sessions/:id/events",
				"POST /sessions/:id/messages",
				"POST /sessions/:id/stop",
			]),
		);
		expect(classes.get("none")).toEqual(expect.arrayContaining(["GET /health", "GET /install.sh"]));
	});
});

describe("账号类接口（ADR 0029「凭据」的表：不属于项目，不走范围表）", () => {
	const accountRoutes = httpContract.filter((def) => def.resource.kind === "account");

	it("每个账号类接口都在 ACCOUNT_ROUTES 里写明认哪种凭据，表里没有多余的行", () => {
		expect(accountRoutes.map(routeKey).sort()).toEqual(Object.keys(ACCOUNT_ROUTES).sort());
	});

	it("登录、初始化、状态不要凭据；登出什么凭据都不拒绝；当前用户、注销全部登录、改密码只认登录；管理账号只认平台管理员；个人令牌的接口各有各的认法", () => {
		expect(ACCOUNT_ROUTES).toEqual({
			"GET /auth/status": "anonymous",
			"POST /auth/setup": "anonymous",
			"POST /auth/login": "anonymous",
			"POST /auth/logout": "logout",
			"POST /auth/logout-all": "login",
			"GET /auth/me": "login",
			"POST /auth/password": "login",
			"GET /users": "platform_admin",
			"POST /users": "platform_admin",
			"POST /users/:id/disable": "platform_admin",
			"POST /users/:id/enable": "platform_admin",
			"POST /users/:id/password": "platform_admin",
			// 个人令牌：列出认登录或个人令牌；签发认登录，或者账号密码（令牌不能签发令牌）；吊销认登录，个人令牌只能吊销它自己。
			"GET /account/tokens": "login_or_personal",
			"POST /account/tokens": "login_or_password",
			"DELETE /account/tokens/:id": "login_or_personal",
		});
	});

	it("账号类接口定位在当前用户自己（self）或用户 ID，路径里没有项目", () => {
		for (const def of accountRoutes) {
			expect(def.path, routeKey(def)).not.toContain(":project");
			expect(locatorOf(def), routeKey(def)).toEqual({ from: "account" });
		}
	});

	it("契约里加了账号类接口却没有写进 ACCOUNT_ROUTES，启动检查报错", () => {
		const extra = {
			...(accountRoutes[0] as (typeof httpContract)[number]),
			path: "/auth/new-thing",
		};
		expect(checkAccessRules([extra])).toEqual([expect.stringContaining("ACCOUNT_ROUTES")]);
	});
});
