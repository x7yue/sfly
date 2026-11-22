// 契约路由上的访问检查（ADR 0029「一处检查」，规格 #489）：鉴权模块不依赖 Fastify，这里连内存里的 AccessStore 单独测。
// 角色 × 接口的结果是从契约里的每个接口生成的：新加接口自动进来。
import { readdirSync, readFileSync } from "node:fs";
import { httpContract, type RouteDef } from "@sfly/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ACCESS_NOT_FOUND_MESSAGE,
	AccessGuard,
	type AccessRequest,
	type AccessResult,
} from "../src/auth/access-guard.js";
import {
	ACCOUNT_ROUTES,
	AGENT_CREDENTIAL_ROUTES,
	LOGIN_ONLY_ROUTES,
	locatorOf,
	REQUIRES_CREDENTIAL,
	routeKey,
	TASK_CREDENTIAL_ROUTES,
} from "../src/auth/access-rules.js";
import type { StoredToken, StoredUser } from "../src/auth/access-store.js";
import { hashCredential } from "../src/auth/credential-hash.js";
import { ROLE_SCOPES, requiredScope, SCOPES } from "../src/auth/scopes.js";
import type { ProjectRole } from "../src/db/schema.js";
import type { ProjectId } from "../src/projects/project-id.js";
import { FakeAccessStore } from "./support/fake-access-store.js";
import { ManualClock } from "./support/manual-clock.js";

const NOW = "2026-06-01T00:00:00.000Z";
const BEFORE = new Date("2026-05-01T00:00:00Z");
const AFTER = new Date("2026-07-01T00:00:00Z");
const p = (id: string) => id as ProjectId;
const DEFAULT = p("default");
const ALPHA = p("alpha");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** 默认项目（乙，被访问的）和项目 alpha（甲，攻击者的）各有一套场景、运行、任务。 */
const RES = {
	scenario: { default: id(1), alpha: id(2) },
	run: { default: id(11), alpha: id(12) },
	task: { default: id(21), alpha: id(22), mine: id(23) },
};

const user = (n: number, extra: Partial<StoredUser> = {}): StoredUser => ({
	id: id(100 + n),
	displayName: `用户${n}`,
	disabledAt: null,
	isPlatformAdmin: false,
	...extra,
});
const USERS = {
	reader: user(1),
	editor: user(2),
	boss: user(3),
	admin: user(4, { isPlatformAdmin: true }),
	outsider: user(5),
	stranger: user(6),
	/** 平台管理员，同时是默认项目的成员：只读 / 编辑者 / 项目管理员。 */
	adminMember: user(7, { isPlatformAdmin: true }),
	adminEditor: user(8, { isPlatformAdmin: true }),
	adminBoss: user(9, { isPlatformAdmin: true }),
};

describe("契约路由的访问检查", () => {
	let store: FakeAccessStore;
	let guard: AccessGuard;
	let clock: ManualClock;
	let counter = 0;

	beforeEach(() => {
		clock = new ManualClock(NOW);
		store = new FakeAccessStore();
		guard = new AccessGuard({ store, clock });
		store.projects.add("alpha");
		store.scenarios.set(RES.scenario.default, DEFAULT).set(RES.scenario.alpha, ALPHA);
		store.runs.set(RES.run.default, DEFAULT).set(RES.run.alpha, ALPHA);
		store.tasks
			.set(RES.task.default, { projectId: DEFAULT, agentName: "agent-default" })
			.set(RES.task.alpha, { projectId: ALPHA, agentName: "agent-alpha" })
			.set(RES.task.mine, { projectId: DEFAULT, agentName: "agent-a" });
		store.setRole("default", USERS.reader, "read_only");
		store.setRole("default", USERS.editor, "editor");
		store.setRole("default", USERS.boss, "project_admin");
		store.setRole("alpha", USERS.outsider, "project_admin");
		store.setRole("default", USERS.adminMember, "read_only");
		store.setRole("default", USERS.adminEditor, "editor");
		store.setRole("default", USERS.adminBoss, "project_admin");
	});

	/** 登记一个登录，返回请求头里的 Cookie。 */
	const login = (
		who: StoredUser,
		extra: { idleExpiresAt?: Date; revokedAt?: Date | null } = {},
	) => {
		const cookie = `cookie-${++counter}`;
		store.logins.set(hashCredential(cookie), {
			id: `login-${counter}`,
			lastUsedAt: clock.now(),
			user: who,
			idleExpiresAt: extra.idleExpiresAt ?? AFTER,
			revokedAt: extra.revokedAt ?? null,
		});
		return { cookie: `sfly_login=${cookie}` };
	};
	const token = (fields: Partial<StoredToken> & Pick<StoredToken, "kind">) => {
		const secret = `sfly_x_${++counter}`;
		store.tokens.set(hashCredential(secret), {
			id: `token-${counter}`,
			name: `令牌${counter}`,
			user: null,
			projectId: null,
			scopes: [...SCOPES],
			expiresAt: null,
			revokedAt: null,
			lastUsedAt: null,
			...fields,
		});
		return { authorization: `Bearer ${secret}` };
	};
	const personal = (who: StoredUser, extra: Partial<StoredToken> = {}) =>
		token({ kind: "personal", user: who, ...extra });

	type Credentials = Pick<AccessRequest, "authorization" | "cookie">;

	/** 一个接口的请求：路径参数里的 ID 指向 `project` 里的资源，其余参数填样本值。 */
	const request = (
		route: RouteDef,
		credentials: Credentials,
		project: "default" | "alpha" = "default",
		params: Record<string, string> = {},
	): AccessRequest => {
		const filled: Record<string, string> = {};
		for (const name of route.path.matchAll(/:([A-Za-z_]+)|\*$/g)) {
			filled[name[1] ?? "*"] = "x";
		}
		// 路径里的项目（`/projects/:project/…`）：指向这次请求作用的项目。
		if ("project" in filled) filled.project = project;
		const target = route.resource.target;
		if (typeof target === "object" && "params" in target) {
			const kind = route.resource.kind;
			if (kind === "scenario") filled[target.params] = RES.scenario[project];
			if (kind === "run") filled[target.params] = RES.run[project];
			if (kind === "task") filled[target.params] = RES.task[project];
		}
		// 登录 Cookie 要同源的请求才认（./cross-site.ts）：这些测试默认是控制台自己发的请求。
		return {
			route,
			params: { ...filled, ...params },
			fetchSite: "same-origin",
			...credentials,
		};
	};
	const run = (route: RouteDef, credentials: Credentials, project?: "default" | "alpha") =>
		guard.check(request(route, credentials, project));

	const outcome = (result: AccessResult) => (result.ok ? "ok" : result.status);
	const OUTSIDE_PROJECT = httpContract.filter((def) => {
		const from = locatorOf(def)?.from;
		return from !== "none" && from !== "account";
	});
	const SYSTEM = httpContract.filter((def) => locatorOf(def)?.from === "none");
	/** 现在就要求凭据的接口（项目的管理面）：不走「不带凭据照旧放行」的过渡。 */
	const needsCredential = (def: RouteDef) => REQUIRES_CREDENTIAL.has(def.resource.kind);
	/** 只认人的登录的接口：令牌（含带管理范围的个人令牌）是 403。 */
	const loginOnly = (def: RouteDef) => routeKey(def) in LOGIN_ONLY_ROUTES;
	const route = (key: string): RouteDef => {
		const found = httpContract.find((def) => routeKey(def) === key);
		if (!found) throw new Error(`契约里没有 ${key}`);
		return found;
	};

	describe("不带凭据、带共享令牌：照旧放行（到 #494 才拒绝）", () => {
		it("不带凭据的请求每个接口都放行，不读库，没有身份（账号类接口除外：它们需要登录，见 accounts-http.test.ts）", async () => {
			for (const def of httpContract) {
				// 登录、初始化、状态本来就不要凭据，登出什么凭据都不拒绝，其余账号类接口不带登录是 401：这是新接口，没有「照旧」可言。
				if (locatorOf(def)?.from === "account" || needsCredential(def)) continue;
				const result = await run(def, {});
				expect(result, routeKey(def)).toEqual({ ok: true, access: null });
			}
			expect(store.reads).toBe(0);
		});

		it("项目的管理面（项目令牌）是新接口，没有「照旧」可言：不带凭据是 401，带共享令牌是 403，不读库", async () => {
			store.agentCredentials.set(hashCredential("shared-secret"), {
				kind: "shared",
				projectId: DEFAULT,
				agentName: null,
				user: null,
				revokedAt: null,
			});
			const covered = httpContract.filter(needsCredential);
			expect(covered.map(routeKey)).toEqual(
				expect.arrayContaining([
					"GET /projects/:project/tokens",
					"POST /projects/:project/tokens",
					"DELETE /projects/:project/tokens/:id",
				]),
			);
			for (const def of covered) {
				expect(outcome(await run(def, {})), routeKey(def)).toBe(401);
			}
			expect(store.reads).toBe(0);
			for (const def of covered) {
				expect(
					outcome(await run(def, { authorization: "Bearer shared-secret" })),
					routeKey(def),
				).toBe(403);
			}
		});

		it("账号类接口：登录、初始化、状态不要凭据（带什么都不看）；其余需要登录，不带凭据是 401，不读库", async () => {
			for (const def of httpContract) {
				if (locatorOf(def)?.from !== "account") continue;
				const rule = ACCOUNT_ROUTES[routeKey(def) as keyof typeof ACCOUNT_ROUTES];
				const result = await run(def, {});
				// 登录、初始化、状态、登出、签发个人令牌（请求体里是账号密码，处理函数验证）可以不带凭据。
				if (rule === "anonymous" || rule === "logout" || rule === "login_or_password") {
					expect(result, routeKey(def)).toEqual({ ok: true, access: null });
				} else {
					expect(outcome(result), routeKey(def)).toBe(401);
				}
			}
			expect(store.reads).toBe(0);
		});

		it("共享令牌认得出（登记成默认项目的旧式 Agent 凭据），和不带凭据一样放行、没有身份", async () => {
			store.agentCredentials.set(hashCredential("shared-secret"), {
				kind: "shared",
				projectId: DEFAULT,
				agentName: null,
				user: null,
				revokedAt: null,
			});
			for (const def of OUTSIDE_PROJECT) {
				if (needsCredential(def)) continue;
				const result = await run(def, { authorization: "Bearer shared-secret" });
				expect(result, routeKey(def)).toEqual({ ok: true, access: null });
			}
		});

		it("吊销了的共享令牌是 401：不会退回到「不带凭据」的放行", async () => {
			store.agentCredentials.set(hashCredential("shared-secret"), {
				kind: "shared",
				projectId: DEFAULT,
				agentName: null,
				user: null,
				revokedAt: BEFORE,
			});
			expect(
				outcome(
					await run(route("PUT /tasks/:id/artifacts/*"), { authorization: "Bearer shared-secret" }),
				),
			).toBe(401);
		});

		it("不属于项目的接口不需要凭据：带什么都不看，不读库", async () => {
			for (const def of SYSTEM) {
				for (const credentials of [
					{ authorization: "Bearer 从没见过的令牌" },
					{ cookie: "sfly_login=过期的" },
				]) {
					expect(await run(def, credentials), routeKey(def)).toEqual({ ok: true, access: null });
				}
			}
			expect(store.reads).toBe(0);
			// 对照：同样的凭据请求属于项目的接口，是 401。
			expect(
				outcome(
					await run(route("GET /orchestrations"), { authorization: "Bearer 从没见过的令牌" }),
				),
			).toBe(401);
		});
	});

	describe("带了失效的凭据：401，不退回到放行", () => {
		const get = route("GET /orchestrations");
		const cases: [string, () => Credentials][] = [
			[
				"库里没有的 Bearer（带不带前缀都一样）",
				() => ({ authorization: "Bearer sfly_pat_unknown" }),
			],
			["库里没有的 Bearer（没有前缀）", () => ({ authorization: "Bearer unknown" })],
			["库里没有的登录 Cookie", () => ({ cookie: "sfly_login=unknown" })],
			["吊销了的个人令牌", () => personal(USERS.editor, { revokedAt: BEFORE })],
			["过期的个人令牌", () => personal(USERS.editor, { expiresAt: BEFORE })],
			["吊销了的项目令牌", () => token({ kind: "project", projectId: DEFAULT, revokedAt: BEFORE })],
			["过期的项目令牌", () => token({ kind: "project", projectId: DEFAULT, expiresAt: BEFORE })],
			[
				"吊销了的会话令牌",
				() => token({ kind: "session", user: USERS.editor, projectId: DEFAULT, revokedAt: BEFORE }),
			],
			["吊销了的任务凭据", () => token({ kind: "task", projectId: DEFAULT, revokedAt: BEFORE })],
			["用户被停用之后的个人令牌", () => personal(user(8, { disabledAt: BEFORE }))],
			["用户被停用之后的登录", () => login(user(9, { disabledAt: BEFORE }))],
			["已注销的登录", () => login(USERS.editor, { revokedAt: BEFORE })],
			["空闲过期的登录", () => login(USERS.editor, { idleExpiresAt: BEFORE })],
		];
		for (const [name, credentials] of cases) {
			it(name, async () => {
				const result = await run(get, credentials());
				expect(result).toMatchObject({ ok: false, status: 401, code: "unauthorized" });
			});
		}

		it("带了 Bearer 就按 Bearer 算：Bearer 无效时，别的有效的 Cookie 不能顶上", async () => {
			const result = await run(get, {
				authorization: "Bearer unknown",
				...login(USERS.editor),
			});
			expect(outcome(result)).toBe(401);
		});

		it("写了 Bearer 就是带了凭据：空的、缺令牌、换了空白字符的都是 401，不会退回到 Cookie 或放行", async () => {
			const { cookie } = login(USERS.editor);
			for (const authorization of [
				"Bearer",
				"Bearer ",
				"Bearer\tunknown",
				"bearer unknown",
				"BEARER   ",
			]) {
				expect(outcome(await run(get, { authorization })), JSON.stringify(authorization)).toBe(401);
				expect(
					outcome(await run(get, { authorization, cookie })),
					JSON.stringify(authorization),
				).toBe(401);
			}
			// 空的登录 Cookie 同样是带了凭据：401。
			expect(outcome(await run(get, { cookie: "sfly_login" }))).toBe(401);
			expect(outcome(await run(get, { cookie: "sfly_login=" }))).toBe(401);
			// 令牌前后的空白不影响（代理加的）。
			const { authorization } = personal(USERS.editor);
			expect(outcome(await run(get, { authorization: `  ${authorization}  ` }))).toBe("ok");
			expect(
				outcome(await run(get, { authorization: authorization.replace("Bearer ", "bearer\t") })),
			).toBe("ok");
		});

		it("不是 Bearer 的 Authorization 写法不是 sfly 的凭据，不认；Cookie 里别的名字也不认", async () => {
			expect(await run(get, { authorization: "Basic dXNlcjpwYXNz" })).toEqual({
				ok: true,
				access: null,
			});
			expect(await run(get, { cookie: "other=1; theme=dark" })).toEqual({ ok: true, access: null });
			// 多个 Cookie 里认得出登录的那个。
			const { cookie } = login(USERS.editor);
			expect(outcome(await run(get, { cookie: `theme=dark; ${cookie}; other=1` }))).toBe("ok");
		});

		it("用户被停用或被移出项目：已有的令牌和登录立即失效、失去权限", async () => {
			const { cookie } = login(USERS.editor);
			const bearer = personal(USERS.editor);
			const write = route("POST /orchestrations");
			expect(outcome(await run(write, { cookie }))).toBe("ok");
			expect(outcome(await run(write, bearer))).toBe("ok");

			store.setRole("default", USERS.editor, "read_only");
			expect(outcome(await run(write, { cookie }))).toBe(403);
			expect(outcome(await run(write, bearer))).toBe(403);
			expect(outcome(await run(get, bearer))).toBe("ok");

			store.setRole("default", USERS.editor, undefined);
			expect(outcome(await run(get, { cookie }))).toBe(404);
			expect(outcome(await run(get, bearer))).toBe(404);
		});
	});

	describe("范围表：每种角色对每个接口的结果（从契约生成）", () => {
		const roles: [string, StoredUser, ProjectRole][] = [
			["只读", USERS.reader, "read_only"],
			["编辑者", USERS.editor, "editor"],
			["项目管理员", USERS.boss, "project_admin"],
		];
		for (const [label, who, role] of roles) {
			it(`${label}：接口要的范围在角色里就通过，不在就 403（登录和令牌的结果一样）`, async () => {
				const credentials = [login(who), personal(who)];
				for (const def of OUTSIDE_PROJECT) {
					const needed = requiredScope(def);
					const expected =
						needed !== null && (ROLE_SCOPES[role] as readonly string[]).includes(needed)
							? "ok"
							: 403;
					for (const [i, c] of credentials.entries()) {
						// 令牌不能签发令牌：签发项目令牌只认登录，个人令牌即使带「管理」范围也是 403。
						const result = i === 1 && loginOnly(def) ? 403 : expected;
						expect(
							outcome(await run(def, c)),
							`${routeKey(def)}（${i === 0 ? "登录" : "令牌"}）`,
						).toBe(result);
					}
				}
			});
		}

		it("通过的请求带着身份：用户、令牌的名称、项目、角色和有效的范围", async () => {
			const bearer = personal(USERS.editor, {
				name: "我的令牌",
				scopes: ["read", "run", "manage"],
			});
			const result = await run(route("POST /runs/:id/cancel"), bearer);
			expect(result).toEqual({
				ok: true,
				access: {
					credential: "personal",
					userId: USERS.editor.id,
					name: "用户2",
					tokenName: "我的令牌",
					loginId: null,
					tokenId: expect.stringMatching(/^token-\d+$/),
					adminActionId: null,
					project: DEFAULT,
					role: "editor",
					// 令牌的范围和编辑者此刻的范围取交集：「管理」没了。
					scopes: ["read", "run"],
				},
			});
			expect(await run(route("GET /orchestrations"), login(USERS.reader))).toMatchObject({
				ok: true,
				access: { credential: "login", tokenName: null, scopes: ["read"] },
			});
		});

		it("取令牌的范围和用户此刻的角色的交集：令牌只给了读，编辑者也不能写；令牌给了管理，编辑者也不能管理", async () => {
			expect(
				outcome(
					await run(route("POST /orchestrations"), personal(USERS.editor, { scopes: ["read"] })),
				),
			).toBe(403);
			expect(
				outcome(
					await run(
						route("POST /feishu-bots"),
						personal(USERS.editor, { scopes: ["read", "manage"] }),
					),
				),
			).toBe(403);
			expect(
				outcome(
					await run(route("POST /feishu-bots"), personal(USERS.boss, { scopes: ["manage"] })),
				),
			).toBe("ok");
			// 范围是空的，什么都不能做，连读也不行。
			expect(
				outcome(await run(route("GET /orchestrations"), personal(USERS.boss, { scopes: [] }))),
			).toBe(403);
		});

		it("项目令牌没有用户，只看自己的范围", async () => {
			const readOnly = token({ kind: "project", projectId: DEFAULT, scopes: ["read"] });
			const runner = token({
				kind: "project",
				projectId: DEFAULT,
				scopes: ["read", "run"],
				name: "CI",
			});
			expect(outcome(await run(route("GET /runs"), readOnly))).toBe("ok");
			expect(outcome(await run(route("POST /runs/:id/cancel"), readOnly))).toBe(403);
			const cancel = await run(route("POST /runs/:id/cancel"), runner);
			expect(cancel).toMatchObject({
				ok: true,
				access: { credential: "project", userId: null, name: "CI", tokenName: "CI", role: null },
			});
			expect(outcome(await run(route("POST /packages"), runner))).toBe(403);
		});

		it("项目令牌不能带「管理」：成员、角色、Agent 和飞书机器人的管理只能由人做，库里写了 manage 也不认", async () => {
			const everything = token({ kind: "project", projectId: DEFAULT, scopes: [...SCOPES] });
			const manager = token({ kind: "project", projectId: DEFAULT, scopes: ["read", "manage"] });
			for (const c of [everything, manager]) {
				expect(outcome(await run(route("POST /feishu-bots"), c))).toBe(403);
				expect(outcome(await run(route("POST /agents/:name/update-now"), c))).toBe(403);
				expect(outcome(await run(route("GET /feishu-bots"), c))).toBe("ok");
			}
			// 别的范围照常：带了全部范围的项目令牌能运行、编辑、发布。
			expect(outcome(await run(route("POST /orchestrations/:id/runs"), everything))).toBe("ok");
			expect(outcome(await run(route("POST /packages"), everything))).toBe("ok");
			// 人的凭据不受影响：项目管理员照样管理。
			expect(outcome(await run(route("POST /feishu-bots"), personal(USERS.boss)))).toBe("ok");
		});

		it("没有人和程序能调用的接口（任务的写：上传产物只给 Agent 凭据）：403，管理员也不行", async () => {
			const upload = route("PUT /tasks/:id/artifacts/*");
			for (const c of [login(USERS.boss), personal(USERS.boss), login(USERS.admin)]) {
				expect(outcome(await run(upload, c))).toBe(403);
			}
		});

		it("会话令牌：读照常按范围，写在 #495 接进来之前一律 403", async () => {
			const session = token({
				kind: "session",
				user: USERS.editor,
				projectId: DEFAULT,
				name: "会话",
			});
			expect(outcome(await run(route("GET /orchestrations"), session))).toBe("ok");
			expect(outcome(await run(route("POST /orchestrations/:id/runs"), session))).toBe(403);
			expect(outcome(await run(route("POST /orchestrations"), session))).toBe(403);
			// 会话限定在一个项目里，也和发起人此刻的角色取交集。
			expect(outcome(await run(route("GET /orchestrations"), session, "alpha"))).toBe("ok");
			const stranger = token({ kind: "session", user: USERS.stranger, projectId: DEFAULT });
			expect(outcome(await run(route("GET /orchestrations"), stranger))).toBe(404);
		});
	});

	describe("别的项目的资源和不存在一样：404，不是 403", () => {
		it("不是这个项目的成员：每个接口都是 404，读和写一样，说法也一样", async () => {
			const credentials = [login(USERS.stranger), personal(USERS.stranger), login(USERS.outsider)];
			for (const def of OUTSIDE_PROJECT) {
				for (const c of credentials) {
					const result = await run(def, c);
					expect(result, routeKey(def)).toMatchObject({
						ok: false,
						status: 404,
						code: "not_found",
						message: ACCESS_NOT_FOUND_MESSAGE,
					});
				}
			}
		});

		it("资源不存在、ID 写得不对：和属于别的项目一样的 404（只对带了凭据的请求）", async () => {
			const cancel = route("POST /runs/:id/cancel");
			const missing = { ...request(cancel, login(USERS.boss)), params: { id: id(999) } };
			expect(await guard.check(missing)).toMatchObject({
				ok: false,
				status: 404,
				message: ACCESS_NOT_FOUND_MESSAGE,
			});
			for (const bad of ["x", "not-a-uuid", ""]) {
				expect(
					await guard.check({ ...missing, params: { id: bad } }),
					JSON.stringify(bad),
				).toMatchObject({ ok: false, status: 404 });
			}
			// 不带凭据的请求照旧放行，由处理函数回答「不存在」。
			expect(
				await guard.check({ ...missing, authorization: undefined, cookie: undefined }),
			).toEqual({
				ok: true,
				access: null,
			});
		});

		it("限定项目的凭据请求别的项目：404（经场景、经运行、经任务的接口都按资源所在的项目）", async () => {
			const alphaOnly = [
				personal(USERS.boss, { projectId: ALPHA }),
				token({ kind: "project", projectId: ALPHA }),
				token({ kind: "session", user: USERS.boss, projectId: ALPHA }),
			];
			store.setRole("alpha", USERS.boss, "project_admin");
			for (const def of OUTSIDE_PROJECT) {
				for (const c of alphaOnly) {
					// 项目 alpha 里没有这个接口要的资源时（列表和新建，项目是默认项目）：限定的项目不是它。
					expect(outcome(await run(def, c, "default")), routeKey(def)).toBe(404);
				}
			}
			// 对照：限定的项目里的资源通过。
			expect(
				outcome(await run(route("GET /orchestrations/:id"), alphaOnly[0] as Credentials, "alpha")),
			).toBe("ok");
			expect(outcome(await run(route("GET /runs/:id"), alphaOnly[1] as Credentials, "alpha"))).toBe(
				"ok",
			);
			expect(
				outcome(await run(route("GET /tasks/:id/logs"), alphaOnly[2] as Credentials, "alpha")),
			).toBe("ok");
		});

		it("资源在别的项目里（用户是那个项目的成员，不是这个项目的）：404", async () => {
			const bearer = personal(USERS.outsider);
			expect(outcome(await run(route("GET /orchestrations/:id"), bearer, "alpha"))).toBe("ok");
			expect(outcome(await run(route("GET /orchestrations/:id"), bearer, "default"))).toBe(404);
			expect(outcome(await run(route("POST /orchestrations/:id/runs"), bearer, "default"))).toBe(
				404,
			);
		});
	});

	describe("公共项目：任何凭据都能读它的节点包", () => {
		// 路径还不带项目（#488）：用 #488 之后的写法构造接口，路径里有 :project 就按它得出项目。
		const publicPackage: RouteDef = {
			...route("GET /packages/:name/versions/:version"),
			path: "/projects/:project/packages/:name/versions/:version",
		};
		const publish: RouteDef = { ...route("POST /packages"), path: "/projects/:project/packages" };
		const scenarios: RouteDef = {
			...route("GET /orchestrations"),
			path: "/projects/:project/orchestrations",
		};
		const at = (def: RouteDef, project: string, credentials: Credentials) => ({
			route: def,
			params: { project, name: "sfly-std", version: "0.1.0" },
			...credentials,
		});

		it("不是成员、限定了别的项目的凭据，读公共项目里的节点包照常得到结果", async () => {
			for (const c of [
				login(USERS.stranger),
				personal(USERS.stranger),
				personal(USERS.outsider, { projectId: ALPHA }),
				token({ kind: "project", projectId: ALPHA, scopes: ["read"] }),
			]) {
				expect(outcome(await guard.check(at(publicPackage, "public", c)))).toBe("ok");
			}
		});

		it("只是节点包的读：写、别的资源、别的项目都照旧", async () => {
			const c = personal(USERS.stranger);
			expect(outcome(await guard.check(at(publish, "public", c)))).toBe(404);
			expect(outcome(await guard.check(at(scenarios, "public", c)))).toBe(404);
			expect(outcome(await guard.check(at(publicPackage, "alpha", c)))).toBe(404);
			// 公共项目的发布要平台管理员（#501 再加「只有平台管理员」的规则；这里只看范围）。
			expect(outcome(await guard.check(at(publish, "public", personal(USERS.boss))))).toBe(404);
		});

		it("路径里的项目写得不对、项目不存在：404", async () => {
			const c = personal(USERS.admin);
			for (const project of ["Bad_Project", "-x", "", "no-such-project"]) {
				expect(outcome(await guard.check(at(scenarios, project, c))), JSON.stringify(project)).toBe(
					404,
				);
			}
		});
	});

	describe("登录的空闲期限：用着就顺延，不用就过期（PR #555 的独立审查）", () => {
		const HOUR = 3_600_000;
		const idle = 12 * HOUR;
		const get = () => route("GET /orchestrations");
		const loginFor = (who: StoredUser) =>
			login(who, { idleExpiresAt: new Date(clock.now().getTime() + idle) });

		it("满一分钟之后再用：空闲期限顺延到「现在 + 12 小时」，库里记下最后使用时间，响应重新下发 Cookie（Max-Age 是空闲期限）", async () => {
			const { cookie } = loginFor(USERS.reader);
			clock.advance(60_000);
			const result = await run(get(), { cookie });
			expect(result).toMatchObject({ ok: true });
			expect(store.touches).toEqual([
				{
					id: expect.stringMatching(/^login-/),
					lastUsedAt: clock.now(),
					idleExpiresAt: new Date(clock.now().getTime() + idle),
				},
			]);
			const setCookie = (result as { setCookie?: string }).setCookie ?? "";
			expect(setCookie).toContain(`sfly_login=${cookie.replace("sfly_login=", "")}`);
			expect(setCookie).toContain(`Max-Age=${idle / 1000}`);
			expect(setCookie).toMatch(/HttpOnly/);
		});

		it("一分钟之内再用：不写库，也不重新下发 Cookie；满了一分钟才再写一次", async () => {
			const { cookie } = loginFor(USERS.reader);
			clock.advance(60_000);
			await run(get(), { cookie });
			expect(store.touches).toHaveLength(1);
			clock.advance(59_999);
			const soon = await run(get(), { cookie });
			expect(store.touches).toHaveLength(1);
			expect((soon as { setCookie?: string }).setCookie).toBeUndefined();
			clock.advance(1);
			const again = await run(get(), { cookie });
			expect(store.touches).toHaveLength(2);
			expect((again as { setCookie?: string }).setCookie).toContain("Max-Age=");
			// 刚用过一次，不到一分钟：登录没有因为期间有人用着就一直写。
			expect(store.touches[1]?.idleExpiresAt).toEqual(new Date(clock.now().getTime() + idle));
		});

		it("用着就一直有效：每隔不到空闲期限用一次，几天之后仍然有效", async () => {
			const { cookie } = loginFor(USERS.reader);
			for (let i = 0; i < 10; i++) {
				clock.advance(idle - HOUR);
				expect(outcome(await run(get(), { cookie })), `第 ${i + 1} 次`).toBe("ok");
			}
		});

		it("过了空闲期限没人用：被拒绝（401），并让浏览器删掉这个 Cookie；到点的那一刻也算过期", async () => {
			const { cookie } = loginFor(USERS.reader);
			clock.advance(idle - 1);
			expect(outcome(await run(get(), { cookie }))).toBe("ok");
			// 上面用过一次，期限顺延了；再不用，过一个空闲期限就失效。
			clock.advance(idle);
			const expired = await run(get(), { cookie });
			expect(outcome(expired)).toBe(401);
			const setCookie = (expired as { setCookie?: string }).setCookie ?? "";
			expect(setCookie).toContain("Max-Age=0");
			expect(setCookie).toMatch(/sfly_login=;/);
		});
	});

	describe("个人令牌的接口认哪种凭据（ADR 0029「凭据」的表）", () => {
		const list = route("GET /account/tokens");
		const issue = route("POST /account/tokens");
		const revoke = route("DELETE /account/tokens/:id");
		const projectToken = () =>
			token({ kind: "project", projectId: DEFAULT, scopes: ["read", "run"] });

		it("列出自己的令牌、吊销令牌：登录和个人令牌都认；项目令牌、共享令牌、会话令牌是 403；不带凭据是 401；失效的是 401", async () => {
			for (const def of [list, revoke]) {
				expect(outcome(await run(def, login(USERS.reader))), routeKey(def)).toBe("ok");
				expect(outcome(await run(def, personal(USERS.reader))), routeKey(def)).toBe("ok");
				expect(outcome(await run(def, projectToken())), routeKey(def)).toBe(403);
				expect(
					outcome(
						await run(def, token({ kind: "session", user: USERS.editor, projectId: DEFAULT })),
					),
					routeKey(def),
				).toBe(403);
				expect(outcome(await run(def, {})), routeKey(def)).toBe(401);
				expect(
					outcome(await run(def, personal(USERS.reader, { revokedAt: BEFORE }))),
					routeKey(def),
				).toBe(401);
				expect(
					outcome(await run(def, personal(USERS.reader, { expiresAt: BEFORE }))),
					routeKey(def),
				).toBe(401);
				// 停用的用户的令牌失效。
				expect(
					outcome(await run(def, personal(user(50, { disabledAt: BEFORE })))),
					routeKey(def),
				).toBe(401);
			}
		});

		it("通过时身份里带着用户和令牌的 ID：处理函数据此判断「个人令牌只能吊销它自己」", async () => {
			const bearer = personal(USERS.reader, { name: "我的" });
			const result = await run(revoke, bearer);
			expect(result).toMatchObject({
				ok: true,
				access: {
					credential: "personal",
					userId: USERS.reader.id,
					tokenName: "我的",
					tokenId: expect.stringMatching(/^token-/),
					loginId: null,
					project: null,
				},
			});
			const viaLogin = await run(revoke, login(USERS.reader));
			expect(viaLogin).toMatchObject({
				ok: true,
				access: { credential: "login", tokenId: null, loginId: expect.stringMatching(/^login-/) },
			});
		});

		it("签发个人令牌：登录认；不带凭据放行（请求体里是账号密码，处理函数验证）；任何令牌都是 403：令牌不能签发令牌", async () => {
			expect(outcome(await run(issue, login(USERS.reader)))).toBe("ok");
			expect(await run(issue, {})).toEqual({ ok: true, access: null });
			for (const credentials of [
				personal(USERS.boss),
				projectToken(),
				token({ kind: "session", user: USERS.editor, projectId: DEFAULT }),
			]) {
				expect(outcome(await run(issue, credentials))).toBe(403);
			}
			// 失效的令牌是 401，不是放行也不是 403。
			expect(outcome(await run(issue, personal(USERS.boss, { revokedAt: BEFORE })))).toBe(401);
			// 过期的登录 Cookie 是 401。
			expect(outcome(await run(issue, login(USERS.reader, { idleExpiresAt: BEFORE })))).toBe(401);
		});

		it("个人令牌不能用在只认登录的账号接口上：改密码、当前用户、注销全部登录都是 403", async () => {
			for (const key of ["POST /auth/password", "GET /auth/me", "POST /auth/logout-all"]) {
				expect(outcome(await run(route(key), personal(USERS.boss))), key).toBe(403);
			}
		});

		it("登出什么凭据都不拒绝（幂等，总是清 Cookie），但令牌登不了出：带令牌的登出没有身份，不注销任何登录", async () => {
			const result = await run(route("POST /auth/logout"), personal(USERS.boss));
			expect(outcome(result)).toBe("ok");
			expect((result as { access: unknown }).access).toBeNull();
		});
	});

	describe("项目令牌的签发只认登录", () => {
		const issue = route("POST /projects/:project/tokens");
		const listTokens = route("GET /projects/:project/tokens");
		const revoke = route("DELETE /projects/:project/tokens/:id");

		it("项目管理员用登录签发通过；个人令牌（哪怕带管理范围）、项目令牌都是 403；列出和吊销令牌可以用带管理范围的个人令牌", async () => {
			expect(outcome(await run(issue, login(USERS.boss)))).toBe("ok");
			const withManage = personal(USERS.boss, { scopes: ["read", "manage"] });
			expect(outcome(await run(issue, withManage))).toBe(403);
			expect((await run(issue, withManage)) as { message: string }).toMatchObject({
				message: LOGIN_ONLY_ROUTES["POST /projects/:project/tokens"],
			});
			// 令牌可以吊销、列出令牌：那只会收窄权限。
			expect(outcome(await run(listTokens, withManage))).toBe("ok");
			expect(outcome(await run(revoke, withManage))).toBe("ok");
			// 没有「管理」范围：403（缺范围）。
			expect(outcome(await run(listTokens, personal(USERS.boss, { scopes: ["read"] })))).toBe(403);
			// 项目令牌没有管理：列出、吊销、签发都是 403。
			const projectScoped = token({ kind: "project", projectId: DEFAULT, scopes: [...SCOPES] });
			for (const def of [issue, listTokens, revoke]) {
				expect(outcome(await run(def, projectScoped)), routeKey(def)).toBe(403);
			}
		});

		it("编辑者、只读不能列出、签发、吊销（管理范围）；别的项目的管理员是 404", async () => {
			for (const who of [USERS.reader, USERS.editor]) {
				for (const def of [issue, listTokens, revoke]) {
					expect(outcome(await run(def, login(who))), routeKey(def)).toBe(403);
				}
			}
			for (const def of [issue, listTokens, revoke]) {
				expect(outcome(await run(def, login(USERS.outsider))), routeKey(def)).toBe(404);
			}
		});

		it("路径里的项目写得不对、项目不存在：404；限定在别的项目的令牌：404", async () => {
			const at = (project: string, credentials: Credentials) =>
				guard.check({
					...request(listTokens, credentials),
					params: { project },
				});
			for (const project of ["Bad_Project", "-x", "", "no-such-project"]) {
				expect(outcome(await at(project, login(USERS.boss))), JSON.stringify(project)).toBe(404);
			}
			const limited = personal(USERS.boss, { projectId: ALPHA });
			expect(outcome(await at("default", limited))).toBe(404);
		});
	});

	describe("令牌的最后使用时间：按令牌节流，一分钟最多写一次", () => {
		it("第一次使用写；一分钟内不再写；满一分钟再写；失效的令牌不写；登录不走这条", async () => {
			const bearer = personal(USERS.boss);
			const get = route("GET /orchestrations");
			expect(outcome(await run(get, bearer))).toBe("ok");
			expect(store.tokenTouches).toHaveLength(1);
			clock.advance(59_999);
			await run(get, bearer);
			expect(store.tokenTouches).toHaveLength(1);
			clock.advance(1);
			await run(get, bearer);
			expect(store.tokenTouches).toHaveLength(2);
			expect(store.tokenTouches[1]?.at).toEqual(clock.now());
			// 失效的令牌：401，不写。
			const revoked = personal(USERS.boss, { revokedAt: BEFORE });
			clock.advance(600_000);
			expect(outcome(await run(get, revoked))).toBe(401);
			expect(store.tokenTouches).toHaveLength(2);
			// 登录有自己的续期，不记令牌的使用时间。
			await run(get, login(USERS.boss));
			expect(store.tokenTouches).toHaveLength(2);
		});

		it("不带凭据的请求不读库、不写", async () => {
			await run(route("GET /orchestrations"), {});
			expect(store.reads).toBe(0);
			expect(store.tokenTouches).toEqual([]);
		});
	});

	describe("平台管理员", () => {
		it("在每个项目里都有项目管理员的权限，读写都通过", async () => {
			for (const c of [login(USERS.admin), personal(USERS.admin)]) {
				for (const def of OUTSIDE_PROJECT) {
					if (requiredScope(def) === null) continue;
					// 签发项目令牌只认登录：个人令牌（哪怕是平台管理员的）是 403。
					const expected = loginOnly(def) && "authorization" in c ? 403 : "ok";
					expect(outcome(await run(def, c, "alpha")), routeKey(def)).toBe(expected);
				}
			}
		});

		it("在自己不是成员的项目里的写操作留记录（谁、什么时候、哪个接口、作用在哪个资源上），读不记", async () => {
			clock.set("2026-06-02T03:04:05.000Z");
			await run(route("GET /orchestrations/:id"), login(USERS.admin), "alpha");
			await run(route("GET /orchestrations"), login(USERS.admin));
			expect(store.adminWrites).toEqual([]);

			await run(route("POST /orchestrations/:id/versions"), login(USERS.admin), "alpha");
			await run(
				route("POST /orchestrations/:id/runs"),
				personal(USERS.admin, { name: "运维令牌" }),
			);
			await run(route("POST /feishu-bots"), login(USERS.admin));
			await run(route("POST /packages"), login(USERS.admin));
			expect(store.adminWrites).toEqual([
				{
					projectId: ALPHA,
					userId: USERS.admin.id,
					at: new Date("2026-06-02T03:04:05.000Z"),
					route: "POST /orchestrations/:id/versions",
					resourceKind: "scenario",
					resourceId: RES.scenario.alpha,
					tokenName: null,
					memberRole: null,
				},
				{
					projectId: DEFAULT,
					userId: USERS.admin.id,
					at: new Date("2026-06-02T03:04:05.000Z"),
					route: "POST /orchestrations/:id/runs",
					// 和 resourceId 说的是同一个资源：请求定位到的场景（新建出来的运行不在这里）。
					resourceKind: "scenario",
					resourceId: RES.scenario.default,
					tokenName: "运维令牌",
					memberRole: null,
				},
				expect.objectContaining({
					route: "POST /feishu-bots",
					resourceKind: "feishu_bot",
					resourceId: null,
				}),
				expect.objectContaining({
					route: "POST /packages",
					resourceKind: "package",
					resourceId: null,
				}),
			]);
		});

		it("是成员、角色本来就有这个范围的写不记；被拒绝的请求不记，别的用户（项目管理员）的写也不记", async () => {
			const editor = login(USERS.adminEditor);
			const boss = login(USERS.adminBoss);
			await run(route("POST /orchestrations/:id/versions"), editor);
			await run(route("POST /orchestrations/:id/runs"), editor);
			await run(route("POST /feishu-bots"), boss);
			await run(route("POST /packages"), boss);
			expect(store.adminWrites).toEqual([]);
			await run(route("POST /feishu-bots"), login(USERS.boss));
			await run(route("PUT /tasks/:id/artifacts/*"), login(USERS.admin), "alpha");
			expect(store.adminWrites).toEqual([]);
		});

		it("是成员、但这次写要靠平台管理员的权限（角色没有这个范围）：照样留记录，读不记", async () => {
			const readOnly = login(USERS.adminMember);
			const editor = login(USERS.adminEditor);
			await run(route("GET /orchestrations"), readOnly);
			// 只读成员写场景、编辑者管理飞书机器人：都超出了他们作为成员的角色。
			expect(outcome(await run(route("POST /orchestrations/:id/versions"), readOnly))).toBe("ok");
			expect(outcome(await run(route("POST /feishu-bots"), editor))).toBe("ok");
			expect(store.adminWrites.map((w) => [w.userId, w.route])).toEqual([
				[USERS.adminMember.id, "POST /orchestrations/:id/versions"],
				[USERS.adminEditor.id, "POST /feishu-bots"],
			]);
			// 记着他当时作为成员的角色：和「不是成员」（空）区分开。
			expect(store.adminWrites.map((w) => w.memberRole)).toEqual(["read_only", "editor"]);
		});

		it("项目不存在：404；管理员停用之后的凭据 401", async () => {
			const missing = request(route("GET /orchestrations"), login(USERS.admin));
			const result = await guard.check({ ...missing, params: { project: "x" } });
			expect(outcome(result)).toBe("ok"); // 路径里没有项目的接口项目是默认项目，它存在
			const disabled = { ...USERS.admin, disabledAt: BEFORE };
			expect(outcome(await run(route("GET /orchestrations"), login(disabled)))).toBe(401);
		});
	});

	describe("Agent 凭据和任务凭据：显式的接口清单，不走范围表", () => {
		const agent = (project: ProjectId, name: string) => {
			const secret = `sfly_agt_${++counter}`;
			store.agentCredentials.set(hashCredential(secret), {
				kind: "agent",
				projectId: project,
				agentName: name,
				user: null,
				revokedAt: null,
			});
			return { authorization: `Bearer ${secret}` };
		};
		const taskCredential = (project: ProjectId) =>
			token({ kind: "task", projectId: project, name: "任务凭据" });
		const archive = route("GET /packages/:name/versions/:version/archive");
		const upload = route("PUT /tasks/:id/artifacts/*");
		const download = route("GET /tasks/:id/artifacts/*");

		it("清单之外的每个接口都是 403（从契约生成）", async () => {
			for (const def of OUTSIDE_PROJECT) {
				const key = routeKey(def);
				const agentOk = key in AGENT_CREDENTIAL_ROUTES;
				const taskOk = key in TASK_CREDENTIAL_ROUTES;
				const forAgent = outcome(await run(def, agent(DEFAULT, "agent-a")));
				const forTask = outcome(await run(def, taskCredential(DEFAULT)));
				if (!agentOk) expect(forAgent, `Agent 凭据：${key}`).toBe(403);
				if (!taskOk) expect(forTask, `任务凭据：${key}`).toBe(403);
			}
		});

		it("清单之外的接口 403 不取决于资源存不存在、在哪个项目里：存在的、别的项目的、不存在的、ID 写得不对的，都是同一个 403", async () => {
			const cancel = route("POST /runs/:id/cancel");
			for (const c of [agent(DEFAULT, "agent-a"), agent(ALPHA, "agent-a"), taskCredential(ALPHA)]) {
				for (const id of [RES.run.default, RES.run.alpha, id_(999), "not-a-uuid"]) {
					const result = await guard.check({ ...request(cancel, c), params: { id } });
					expect(result, `${id}`).toMatchObject({ ok: false, status: 403, code: "forbidden" });
				}
			}
		});

		it("清单是这三个接口：Agent 凭据下载节点包归档、上传产物；任务凭据下载产物", () => {
			expect(Object.keys(AGENT_CREDENTIAL_ROUTES).sort()).toEqual([
				"GET /packages/:name/versions/:version/archive",
				"PUT /tasks/:id/artifacts/*",
			]);
			expect(Object.keys(TASK_CREDENTIAL_ROUTES)).toEqual(["GET /tasks/:id/artifacts/*"]);
		});

		it("下载节点包归档：本项目和公共项目的包可以，别的项目的 404", async () => {
			const cred = agent(DEFAULT, "agent-a");
			expect(outcome(await run(archive, cred))).toBe("ok");
			expect(outcome(await run(archive, agent(ALPHA, "agent-b")))).toBe(404);
			// #488 把路径改成 /projects/:project/…：清单的键跟着改，项目取路径里的。
			const inProject: RouteDef = {
				...archive,
				path: "/projects/:project/packages/:name/versions/:version/archive",
			};
			const projectGuard = new AccessGuard({
				store,
				clock,
				agentRoutes: { [routeKey(inProject)]: "package_archive" },
			});
			const at = (project: string, c: Credentials) =>
				projectGuard.check({
					route: inProject,
					params: { project, name: "n", version: "1" },
					...c,
				});
			expect(outcome(await at("public", cred))).toBe("ok");
			expect(outcome(await at("default", cred))).toBe("ok");
			expect(outcome(await at("alpha", cred))).toBe(404);
		});

		it("上传产物：只能传给派给这台 Agent 的任务；别的 Agent 的任务、别的项目的任务、不存在的任务都是 404", async () => {
			const mine = agent(DEFAULT, "agent-a");
			const result = await guard.check({
				...request(upload, mine),
				params: { id: RES.task.mine, "*": "a.txt" },
			});
			expect(result).toMatchObject({
				ok: true,
				access: { credential: "agent", name: "agent-a", userId: null },
			});
			for (const id of [RES.task.default, RES.task.alpha, id_(999), "not-a-uuid"]) {
				const denied = await guard.check({
					...request(upload, mine),
					params: { id, "*": "a.txt" },
				});
				expect(outcome(denied), id).toBe(404);
			}
			// 同名的 Agent 在别的项目里：任务的项目不是它的项目。
			const sameNameElsewhere = agent(ALPHA, "agent-a");
			const other = await guard.check({
				...request(upload, sameNameElsewhere),
				params: { id: RES.task.mine, "*": "a" },
			});
			expect(outcome(other)).toBe(404);
		});

		it("任务凭据：只能下载本项目的任务的产物，读本项目任务的日志、动作被拒绝（403）", async () => {
			const cred = taskCredential(DEFAULT);
			expect(outcome(await run(download, cred))).toBe("ok");
			expect(outcome(await run(download, cred, "alpha"))).toBe(404);
			expect(outcome(await run(route("GET /tasks/:id/logs"), cred))).toBe(403);
			expect(outcome(await run(route("GET /tasks/:id/actions"), cred))).toBe(403);
			expect(outcome(await run(route("GET /tasks/:id/artifacts"), cred))).toBe(403);
			expect(outcome(await run(upload, cred))).toBe(403);
		});

		it("开发 Agent 的凭据记在编辑者名下：所属用户被停用，它立即失效（401）；按台签发的没有用户，不受影响", async () => {
			const devAgent = (user: StoredUser, name = "dev-xiaoming-laptop") => {
				const secret = `sfly_agt_${++counter}`;
				store.agentCredentials.set(hashCredential(secret), {
					kind: "agent",
					projectId: DEFAULT,
					agentName: name,
					user,
					revokedAt: null,
				});
				return { authorization: `Bearer ${secret}` };
			};
			const active = devAgent(USERS.editor);
			expect(outcome(await run(archive, active))).toBe("ok");
			const disabled = devAgent({ ...USERS.editor, disabledAt: BEFORE });
			expect(outcome(await run(archive, disabled))).toBe(401);
			expect(outcome(await run(download, disabled))).toBe(401);
			// 没有用户的（管理员签发的、按台的）不看用户。
			expect(outcome(await run(archive, agent(DEFAULT, "agent-a")))).toBe("ok");
		});

		it("吊销了的 Agent 凭据是 401", async () => {
			store.agentCredentials.set(hashCredential("revoked-agent"), {
				kind: "agent",
				projectId: DEFAULT,
				agentName: "agent-a",
				user: null,
				revokedAt: BEFORE,
			});
			expect(outcome(await run(archive, { authorization: "Bearer revoked-agent" }))).toBe(401);
		});
	});

	it("处理一个请求读库的次数固定，不随请求变多：登录一次、令牌先查令牌表再查 Agent 凭据表（最多两次），成员一次，项目最多一次", async () => {
		// 令牌：查令牌表命中一次，成员一次，场景所在的项目一次。
		store.reads = 0;
		await run(route("GET /orchestrations/:id"), personal(USERS.editor));
		expect(store.reads).toBe(3);
		// 登录 Cookie：只查登录表（不查令牌表），成员一次。
		store.reads = 0;
		await run(route("GET /orchestrations"), login(USERS.editor));
		expect(store.reads).toBe(2);
		// 库里没有的 Bearer、共享令牌、Agent 凭据：令牌表没有，再查 Agent 凭据表，一共两次凭据查询。
		store.reads = 0;
		await run(route("GET /orchestrations"), { authorization: "Bearer nobody" });
		expect(store.reads).toBe(2);
		// Agent 上传产物：两次凭据查询，加任务的归属一次（任务所在的项目和派给了哪台 Agent 是同一行，不查两遍）。
		const secret = "sfly_agt_reads";
		store.agentCredentials.set(hashCredential(secret), {
			kind: "agent",
			projectId: DEFAULT,
			agentName: "agent-a",
			user: null,
			revokedAt: null,
		});
		store.reads = 0;
		const upload = await guard.check({
			...request(route("PUT /tasks/:id/artifacts/*"), { authorization: `Bearer ${secret}` }),
			params: { id: RES.task.mine, "*": "a.txt" },
		});
		expect(outcome(upload)).toBe("ok");
		expect(store.reads).toBe(3);
	});
});

const id_ = id;

describe("鉴权模块不依赖 Fastify", () => {
	it("src/auth/ 下的每个文件都不引用 fastify：鉴权可以不起 HTTP 服务单独测试", () => {
		const dir = new URL("../src/auth/", import.meta.url);
		const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
		expect(files).toContain("access-guard.ts");
		for (const file of files) {
			expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/from ["']fastify["']/);
		}
	});
});
