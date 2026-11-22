// 范围表（ADR 0029「一处检查」）：范围由「接口作用在哪类资源上 × 只读或写」查表得出，对着 ADR 里逐个接口的那张表，
// 每一行一条；契约里的每个接口都要有一个期望的范围，新加的写接口不在表里就失败，不会悄悄没人管。
import { httpContract, RESOURCE_KINDS } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
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
	// 局部编辑（#470）：一组操作存成新版本，就是 ADR 表里「保存版本」那一行（场景 × 写）→ 编辑
	"POST /orchestrations/:id/edits": "edit",
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
	// 上传产物（任务，写）→ 不给人和程序：只有 Agent 凭据，限派给这台 Agent 的任务
	"PUT /tasks/:id/artifacts/*": null,
	// 建会话、对它说话、停止它（会话，写）→ 编辑：都是在驱动对场景的修改（ADR 0029 的范围表没有会话这一行，ADR 0027 补记）
	"POST /projects/:project/sessions": "edit",
	"POST /sessions/:id/messages": "edit",
	"POST /sessions/:id/stop": "edit",
};

describe("范围表：接口 × 范围", () => {
	it("契约里每个写接口的范围和 ADR 的表一致，只读接口都是「读」", () => {
		const seen = new Set<string>();
		for (const def of httpContract) {
			const key = routeKey(def);
			if (def.effect === "read") {
				expect(requiredScope(def), key).toBe("read");
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

describe("契约和访问检查的规则对得上", () => {
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

	it("项目的五类：不属于项目、路径带项目、经场景、经运行或任务、经会话", () => {
		const classes = new Map<string, string[]>();
		for (const def of httpContract) {
			const locator = locatorOf(def);
			const label = locator?.from === "path" ? "path" : (locator?.from ?? "undefined");
			classes.set(label, [...(classes.get(label) ?? []), routeKey(def)]);
		}
		expect([...classes.keys()].sort()).toEqual([
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
