// 契约路由上的一处访问检查（ADR 0029「一处检查」）：解析凭据，按接口的声明得出项目，查归属，查范围。
// 不依赖 Fastify：输入是凭据和接口的声明，输出是「谁、哪个项目、允许还是拒绝、拒绝的原因」，读数据走 {@link AccessStore}。
//
// 这一步只对带了凭据的请求生效（规格 #489）：不带凭据的请求照旧放行，到 #494 才改成 401；带共享令牌的 HTTP 请求
// 和不带凭据的走同一套（共享令牌不对应任何一台 Agent）。带了凭据就一定检查：库里没有的、过期的、吊销的、用户停用的，
// 一律 401，不会退回到「不带凭据」的放行。
import type { RouteDef } from "@sfly/schema";
import type { Clock } from "../clock.js";
import type { ProjectRole } from "../db/schema.js";
import {
	DEFAULT_PROJECT,
	type ProjectId,
	PUBLIC_PROJECT,
	parseProjectId,
	readableProjects,
} from "../projects/project-id.js";
import { isUuid } from "../util/uuid.js";
import {
	ACCOUNT_ROUTES,
	AGENT_CREDENTIAL_ROUTES,
	locatorOf,
	type ProjectLocator,
	routeKey,
	TASK_CREDENTIAL_ROUTES,
} from "./access-rules.js";
import type {
	AccessStore,
	StoredAgentCredential,
	StoredLogin,
	StoredToken,
	StoredUser,
} from "./access-store.js";
import { hashCredential } from "./credential-hash.js";
import { cookieAllowed, type OriginRules } from "./cross-site.js";
import { clearLoginCookieHeader, loginCookieHeader } from "./login-cookie.js";
import {
	effectiveScopes,
	PLATFORM_ADMIN_SCOPES,
	PROJECT_TOKEN_SCOPES,
	ROLE_SCOPES,
	requiredScope,
	SCOPE_LABELS,
	type Scope,
} from "./scopes.js";

/** 控制台登录的 Cookie 名（签发在 #490）。 */
export const LOGIN_COOKIE = "sfly_login";

/** 凭据是什么种类（ADR 0029「凭据」）：登录 Cookie、个人令牌、项目令牌、会话令牌，以及 Agent 凭据、任务凭据。 */
export type CredentialKind = "login" | "personal" | "project" | "session" | "agent" | "task";

/** 通过检查的凭据：谁、在哪个项目、有哪些范围。处理函数据此记下是谁做的，不再自己读请求头。 */
export interface Access {
	credential: CredentialKind;
	/** 用户 ID；项目令牌、Agent 凭据、任务凭据没有用户。 */
	userId: string | null;
	/** 显示名：有用户时是用户的显示名，否则是令牌的名称（Agent 凭据是 Agent 的名字）。 */
	name: string;
	/** 经哪个令牌（令牌的名称，ADR 0029「经 …」）；登录和 Agent 凭据没有。 */
	tokenName: string | null;
	/** 登录 Cookie 对应的登录（`logins.id`）；其余凭据没有。注销和停用时按它关掉打开的事件流。 */
	loginId: string | null;
	/** 令牌的 ID（`api_tokens.id`）；登录和 Agent 凭据没有。 */
	tokenId: string | null;
	/**
	 * 这次请求在 `platform_admin_actions` 里的记录（平台管理员靠自己的权限做的写）；没有记录为 null。
	 * 请求结束时用它回填响应的状态码（{@link AccessGuard.finishAdminWrite}）。
	 */
	adminActionId: string | null;
	/** 请求作用在哪个项目里；账号类接口不属于项目，没有。不属于项目的接口（system）不会带出 Access。 */
	project: ProjectId | null;
	/** 有用户的凭据：用户在这个项目里的角色（平台管理员不是成员时为 null）；其余为 null。 */
	role: ProjectRole | null;
	/** 这次请求有效的范围：令牌的范围和用户此刻的范围的交集。Agent 凭据、任务凭据不走范围表，是空的。 */
	scopes: readonly Scope[];
}

/**
 * 检查的结果：通过时带出身份（不带凭据、带共享令牌时为 null，照旧放行），拒绝时带 HTTP 状态和原因。
 * `setCookie` 是要随响应下发的 `Set-Cookie`：登录用了一段时间之后续期（空闲期限顺延，浏览器上的 Cookie 也跟着续），
 * 或者带来的登录 Cookie 已经失效时让浏览器删掉它（不然失效的 Cookie 会让每个请求都是 401）。
 */
export type AccessResult =
	| { ok: true; access: Access | null; setCookie?: string }
	| { ok: false; status: 401 | 403 | 404; code: string; message: string; setCookie?: string };

/** 一个请求里和检查有关的部分。 */
export interface AccessRequest {
	route: Pick<RouteDef, "method" | "path" | "effect" | "resource" | "creates">;
	/** 路径参数（解析前的字符串）。 */
	params: Record<string, string | undefined>;
	/** `Authorization` 请求头。 */
	authorization?: string | undefined;
	/** `Cookie` 请求头。 */
	cookie?: string | undefined;
	/** 来源检查要看的请求头（`Sec-Fetch-*`、`Origin`、`Host`），只对带 Cookie 的请求有用（./cross-site.ts）。 */
	fetchSite?: string | undefined;
	fetchMode?: string | undefined;
	fetchDest?: string | undefined;
	origin?: string | undefined;
	host?: string | undefined;
	/** 浏览器看到的是 HTTPS：下发 Cookie 时加 Secure。 */
	secure?: boolean | undefined;
}

/** 登录用了之后，隔多久才把「最后使用时间」写一次库（并续期）：不要每个请求写一次库。 */
export const LOGIN_TOUCH_INTERVAL_MS = 60_000;
/** 登录的空闲期限，默认 12 小时（`SFLY_LOGIN_IDLE_HOURS`）。 */
export const DEFAULT_LOGIN_IDLE_MS = 12 * 3_600_000;

/**
 * 资源不存在、属于别的项目、凭据限定的项目不是这个：一律 404，说法也一样，不透露别的项目里有什么
 * （ADR 0029）。测试按这句话区分「访问检查拒绝的 404」和处理函数自己的 404。
 */
export const ACCESS_NOT_FOUND_MESSAGE = "资源不存在，或不在这个凭据能访问的项目里";

const denied = (status: 401 | 403 | 404, code: string, message: string): AccessResult => ({
	ok: false,
	status,
	code,
	message,
});
const notFound = () => denied(404, "not_found", ACCESS_NOT_FOUND_MESSAGE);

/** 请求里带的凭据原值，来自哪里。 */
type Presented = { from: "bearer" | "cookie"; secret: string };

/**
 * `Authorization: Bearer <令牌>` 优先；没有时看登录 Cookie。写了 `Bearer`（或带了 `sfly_login` Cookie）就是带了凭据：
 * 令牌是空的、格式不对也算，会因为库里没有它而 401，不会退回到别的凭据或不带凭据。
 * 其余的 Authorization 写法（`Basic …`）不是 sfly 的凭据，不认。
 */
function presentedCredential(request: AccessRequest): Presented | undefined {
	const bearer = /^Bearer(?:\s+(.*))?$/is.exec((request.authorization ?? "").trim());
	if (bearer) return { from: "bearer", secret: (bearer[1] ?? "").trim() };
	for (const part of (request.cookie ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === LOGIN_COOKIE) return { from: "cookie", secret: value.join("=") };
	}
	return undefined;
}

/** 解析出的凭据：有用户的（登录、个人令牌、会话令牌）、项目令牌、Agent 凭据、任务凭据；共享令牌单独一种。 */
type Principal =
	| {
			kind: "login" | "personal" | "session";
			user: StoredUser;
			/** 登录的 ID（`logins.id`）；令牌没有。 */
			loginId: string | null;
			/** 令牌的 ID；登录没有。 */
			tokenId: string | null;
			tokenName: string | null;
			/** 令牌自己的范围（登录没有）。 */
			granted: readonly string[] | undefined;
			/** 令牌限定的项目（登录和没有限定的个人令牌没有）。 */
			limit: ProjectId | null;
	  }
	| {
			kind: "project";
			tokenId: string;
			name: string;
			granted: readonly string[];
			project: ProjectId;
	  }
	| { kind: "agent"; agentName: string; project: ProjectId }
	| { kind: "task"; tokenId: string; name: string; project: ProjectId }
	| { kind: "shared" };

/** 解析出的凭据，以及要不要续期它的 Cookie。 */
interface Resolved {
	principal: Principal | undefined;
	/** 刚把登录续了期：响应要重新下发 Cookie（值就是请求里带来的那个）。 */
	renew?: string;
	/** 是登录 Cookie 但失效了：响应让浏览器删掉它。 */
	clear?: boolean;
}

export class AccessGuard {
	constructor(
		private readonly deps: {
			store: AccessStore;
			clock: Clock;
			/** Agent 凭据、任务凭据的接口清单；默认是 access-rules.ts 里的（测试可以换成别的路径写法）。 */
			agentRoutes?: Readonly<Record<string, string>>;
			taskRoutes?: Readonly<Record<string, string>>;
			/** 登录的空闲期限（毫秒），默认 12 小时。 */
			loginIdleMs?: number;
			/** 哪些来源算同源（./cross-site.ts）；默认没有配置公开地址，用请求的 Host 兜底。 */
			origins?: OriginRules;
		},
	) {}

	get #idleMs(): number {
		return this.deps.loginIdleMs ?? DEFAULT_LOGIN_IDLE_MS;
	}

	/** 检查一个请求；返回拒绝的原因，或通过时的身份。 */
	async check(request: AccessRequest): Promise<AccessResult> {
		const locator = locatorOf(request.route);
		if (locator === undefined) {
			throw new Error(`${routeKey(request.route)} 认不出项目从哪里得出（启动时应该已经拒绝）`);
		}
		// 不属于项目的接口不需要凭据，带了也不看（过期的 Cookie 不该让健康检查和下载安装脚本失败）。
		if (locator.from === "none") return { ok: true, access: null };
		const offered = presentedCredential(request);
		// 登录 Cookie 是浏览器自动带上的：跨站的请求（有副作用的，或者不是页面导航的）不认它，当作没有登录。
		const crossSite = offered?.from === "cookie" && !this.#sameSite(request);
		const presented = crossSite ? undefined : offered;
		// 登出例外（`#checkLogout`）：它要看到跨站带来的 Cookie，才能把库里的这条登录也注销。
		if (locator.from === "account") return this.#checkAccount(request, presented, offered);
		if (presented === undefined) return { ok: true, access: null };
		const resolved = await this.#resolve(presented);
		const result = await this.#decide(resolved, request, locator);
		return withCookie(result, resolved, request, this.#idleMs);
	}

	async #decide(
		{ principal }: Resolved,
		request: AccessRequest,
		locator: Exclude<ProjectLocator, { from: "none" | "account" }>,
	): Promise<AccessResult> {
		if (principal === undefined) {
			return denied(401, "unauthorized", "凭据无效、已过期或已吊销");
		}
		if (principal.kind === "shared") return { ok: true, access: null };
		// 路径参数含 NUL：它不指向任何东西，和不带凭据时一样是 404（契约路由的约定，#212）；
		// 不能往下走：管理员的写记录要把路径参数写进库，NUL 存不进 PostgreSQL 的文本。
		if (Object.values(request.params).some((value) => value?.includes("\u0000"))) {
			return denied(404, "not_found", "路径参数含 NUL 字符，没有对应的资源");
		}
		// Agent 凭据和任务凭据先看接口清单：403 只取决于接口，不取决于资源存不存在、在哪个项目里。
		if (principal.kind === "agent" || principal.kind === "task") {
			return this.#checkProgram(principal, request, locator);
		}
		const project = await this.#projectOf(locator, request.params);
		if (project === undefined) return notFound();
		return this.#checkScoped(principal, request, project);
	}

	#sameSite(request: AccessRequest): boolean {
		return cookieAllowed(
			{
				method: request.route.method,
				fetchSite: request.fetchSite,
				fetchMode: request.fetchMode,
				fetchDest: request.fetchDest,
				origin: request.origin,
				host: request.host,
			},
			this.deps.origins ?? { origins: [], hostFallback: true },
		);
	}

	// ---- 账号类接口：不属于项目，不走范围表，认哪种凭据看 ACCOUNT_ROUTES ----

	async #checkAccount(
		request: AccessRequest,
		presented: Presented | undefined,
		offered: Presented | undefined,
	): Promise<AccessResult> {
		const key = routeKey(request.route);
		const rule: string | undefined = (ACCOUNT_ROUTES as Record<string, string>)[key];
		if (rule === undefined) {
			throw new Error(`${key} 是账号类接口，却没有写在 ACCOUNT_ROUTES 里（启动时应该已经拒绝）`);
		}
		// 登录、初始化、状态不要凭据，带了什么都不看：过期的 Cookie 不该让登录页登录不了。
		if (rule === "anonymous") return { ok: true, access: null };
		if (rule === "logout") return this.#checkLogout(offered);
		if (presented === undefined) return denied(401, "unauthorized", "需要登录");
		const resolved = await this.#resolve(presented);
		const { principal } = resolved;
		const refused = (status: 401 | 403, code: string, message: string): AccessResult =>
			withCookie(denied(status, code, message), resolved, request, this.#idleMs);
		if (principal === undefined) return refused(401, "unauthorized", "凭据无效、已过期或已吊销");
		if (principal.kind !== "login") {
			return refused(403, "forbidden", "这个接口只认登录（Cookie），令牌和别的凭据不能用它");
		}
		if (rule === "platform_admin" && !principal.user.isPlatformAdmin) {
			return refused(403, "forbidden", "只有平台管理员能这样做");
		}
		return withCookie(
			{
				ok: true,
				access: {
					credential: "login",
					userId: principal.user.id,
					name: principal.user.displayName,
					tokenName: null,
					loginId: principal.loginId,
					tokenId: null,
					adminActionId: null,
					project: null,
					role: null,
					scopes: [],
				},
			},
			resolved,
			request,
			this.#idleMs,
		);
	}

	/**
	 * 登出：总是放行。请求带着有效的登录 Cookie 就带出身份（处理函数据此注销库里的这一个登录），**不看同源判定**：
	 * 浏览器上的 Cookie 无条件清掉，库里的登录却因为这次请求被当作跨站、公开地址对不上而留着有效，
	 * 拿到这个 Cookie 的人还能继续用；而能带上这个 Cookie 的「不同源」请求只有同站的（SameSite=Lax 挡掉了跨站的写请求），
	 * 它们能做到的只是强迫登出，清 Cookie 本来就是无条件的，服务端多注销一次不增加危害。
	 * 没带 Cookie、带的是令牌、Cookie 已经失效，都没有身份，处理函数只清浏览器上的 Cookie。
	 */
	async #checkLogout(presented: Presented | undefined): Promise<AccessResult> {
		if (presented?.from !== "cookie") return { ok: true, access: null };
		const { principal } = await this.#resolve(presented);
		if (principal?.kind !== "login") return { ok: true, access: null };
		return {
			ok: true,
			access: {
				credential: "login",
				userId: principal.user.id,
				name: principal.user.displayName,
				tokenName: null,
				loginId: principal.loginId,
				tokenId: null,
				adminActionId: null,
				project: null,
				role: null,
				scopes: [],
			},
		};
	}

	// ---- 解析凭据 ----

	async #resolve(presented: Presented): Promise<Resolved> {
		const hash = hashCredential(presented.secret);
		const now = this.deps.clock.now();
		if (presented.from === "cookie") {
			const login = await this.deps.store.loginByCookieHash(hash);
			const principal = login && loginPrincipal(login, now);
			if (login === undefined || principal === undefined)
				return { principal: undefined, clear: true };
			// 用了一段时间之后才写一次库：最后使用时间、空闲期限顺延，浏览器上的 Cookie 也跟着续。
			if (now.getTime() - login.lastUsedAt.getTime() >= LOGIN_TOUCH_INTERVAL_MS) {
				await this.deps.store.touchLogin(login.id, now, new Date(now.getTime() + this.#idleMs));
				return { principal, renew: presented.secret };
			}
			return { principal };
		}
		const token = await this.deps.store.tokenByHash(hash);
		if (token) return { principal: tokenPrincipal(token, now) };
		const credential = await this.deps.store.agentCredentialByHash(hash);
		return { principal: credential && agentPrincipal(credential) };
	}

	// ---- 项目从请求的哪里来 ----

	/** 请求作用在哪个项目里；资源不存在（或路径里的项目写得不对）时返回 undefined。 */
	async #projectOf(
		locator: Exclude<ProjectLocator, { from: "none" | "account" }>,
		params: AccessRequest["params"],
	): Promise<ProjectId | undefined> {
		if (locator.from === "path") {
			if (locator.param === null) return DEFAULT_PROJECT;
			const value = params[locator.param];
			return value === undefined ? undefined : parseProjectId(value);
		}
		const id = params[locator.param];
		if (id === undefined || !isUuid(id)) return undefined;
		const { store } = this.deps;
		if (locator.from === "scenario") return store.projectOfScenario(id);
		if (locator.from === "run") return store.projectOfRun(id);
		return store.projectOfTask(id);
	}

	// ---- Agent 凭据和任务凭据：显式的接口清单 ----

	async #checkProgram(
		principal: Extract<Principal, { kind: "agent" | "task" }>,
		request: AccessRequest,
		locator: Exclude<ProjectLocator, { from: "none" | "account" }>,
	): Promise<AccessResult> {
		const key = routeKey(request.route);
		const routes: Readonly<Record<string, string>> =
			principal.kind === "agent"
				? (this.deps.agentRoutes ?? AGENT_CREDENTIAL_ROUTES)
				: (this.deps.taskRoutes ?? TASK_CREDENTIAL_ROUTES);
		const rule = routes[key];
		if (rule === undefined) {
			return denied(
				403,
				"forbidden",
				`${principal.kind === "agent" ? "Agent 凭据" : "任务凭据"}不能调用这个接口`,
			);
		}
		// 上传产物要看任务派给了哪台 Agent，任务所在的项目也在同一行里：一次查询，不查两遍。
		// ID 不是 UUID 的和不存在一样（404）：不能拿去查 uuid 列，PostgreSQL 会报错，变成 500。
		const taskId = rule === "assigned_task" ? requestTaskId(request) : undefined;
		if (taskId !== undefined && !isUuid(taskId)) return notFound();
		const assignment =
			taskId === undefined ? undefined : await this.deps.store.taskAssignment(taskId);
		const project =
			rule === "assigned_task"
				? assignment?.projectId
				: await this.#projectOf(locator, request.params);
		if (project === undefined) return notFound();
		const access: Access = {
			credential: principal.kind,
			userId: null,
			name: principal.kind === "agent" ? principal.agentName : principal.name,
			tokenName: null,
			loginId: null,
			tokenId: principal.kind === "task" ? principal.tokenId : null,
			adminActionId: null,
			project,
			role: null,
			scopes: [],
		};
		if (rule === "package_archive") {
			// 本项目和公共项目的包（路径里的项目是包所在的项目，ADR 0029「凭据」）。
			return readableProjects(principal.project).includes(project)
				? { ok: true, access }
				: notFound();
		}
		if (rule === "project_task") {
			return project === principal.project ? { ok: true, access } : notFound();
		}
		// assigned_task：任务是派给这台 Agent 的。
		const mine =
			assignment !== undefined &&
			assignment.projectId === principal.project &&
			principal.kind === "agent" &&
			assignment.agentName === principal.agentName;
		return mine ? { ok: true, access } : notFound();
	}

	// ---- 有用户的凭据和项目令牌：范围表 ----

	async #checkScoped(
		principal: Exclude<Principal, { kind: "agent" | "task" | "shared" }>,
		request: AccessRequest,
		project: ProjectId,
	): Promise<AccessResult> {
		const { route } = request;
		const needed = requiredScope(route);
		// 公共项目任何凭据都能读它（节点包）：不看限定的项目，也不要求是成员。
		const publicRead =
			project === PUBLIC_PROJECT && route.effect === "read" && route.resource.kind === "package";
		const limit = principal.kind === "project" ? principal.project : principal.limit;
		if (!publicRead && limit !== null && limit !== project) return notFound();

		let role: ProjectRole | null = null;
		let scopes: Scope[];
		/**
		 * 平台管理员的用户 ID，以及他作为成员本来就有的范围（不是成员时没有）：这次写要是靠平台管理员的权限才通过
		 * （不是成员，或成员的角色没有这个范围），要留记录。
		 */
		let admin: { userId: string; memberScopes: Scope[] } | null = null;
		if (principal.kind === "project") {
			// 项目令牌不能带「管理」：成员、角色、Agent 和它的凭据、飞书机器人的管理只能由人做（库里写了也不认）。
			scopes = effectiveScopes(PROJECT_TOKEN_SCOPES, principal.granted);
		} else {
			const { user } = principal;
			role = (await this.deps.store.role(project, user.id)) ?? null;
			if (user.isPlatformAdmin) {
				// 平台管理员在每个项目里都有项目管理员的权限；项目要真的存在。
				if (role === null && !(await this.deps.store.projectExists(project))) return notFound();
				admin = {
					userId: user.id,
					memberScopes: role === null ? [] : effectiveScopes(ROLE_SCOPES[role], principal.granted),
				};
				scopes = effectiveScopes(PLATFORM_ADMIN_SCOPES, principal.granted);
			} else if (role === null) {
				if (!publicRead) return notFound();
				scopes = effectiveScopes(["read"], principal.granted);
			} else {
				scopes = effectiveScopes(ROLE_SCOPES[role], principal.granted);
			}
		}

		const access: Access = {
			credential: principal.kind,
			userId: principal.kind === "project" ? null : principal.user.id,
			name: principal.kind === "project" ? principal.name : principal.user.displayName,
			tokenName:
				principal.kind === "login"
					? null
					: principal.kind === "project"
						? principal.name
						: principal.tokenName,
			loginId: principal.kind === "login" ? principal.loginId : null,
			tokenId: principal.kind === "login" ? null : principal.tokenId,
			adminActionId: null,
			project,
			role,
			scopes,
		};
		if (needed === null) {
			return denied(
				403,
				"forbidden",
				"没有人和程序（令牌、登录）能调用这个接口：它只给 Agent 凭据",
			);
		}
		if (!scopes.includes(needed)) {
			return denied(
				403,
				"forbidden",
				`缺少「${SCOPE_LABELS[needed]}」范围：${routeKey(route)} 需要它`,
			);
		}
		// 会话令牌的勾选（可以改的场景、可以用的 Agent、可以发消息的机器人）和待批准的操作在 #495、#496 接进来；
		// 在那之前会话令牌只读，不放任何写。
		if (principal.kind === "session" && route.effect === "write") {
			return denied(403, "forbidden", "会话令牌的写入还没有开放");
		}
		if (admin !== null && route.effect === "write" && !admin.memberScopes.includes(needed)) {
			const target = route.resource.target;
			// 先记、记不上整个请求就失败（不会漏记）；响应的状态码在请求结束时回填（finishAdminWrite）。
			access.adminActionId = await this.deps.store.recordAdminWrite({
				projectId: project,
				userId: admin.userId,
				at: this.deps.clock.now(),
				route: routeKey(route),
				// 和 resourceId 说的是同一个资源：请求定位到的那个（触发运行记场景，不是新建出来的运行）。
				resourceKind: route.resource.kind,
				resourceId:
					typeof target === "object" && "params" in target
						? (request.params[target.params] ?? null)
						: null,
				tokenName: access.tokenName,
				memberRole: role,
			});
		}
		return { ok: true, access };
	}

	/** 平台管理员的写请求结束了：回填响应的状态码。进程在此之前退出的留空，表示结果未知。 */
	async finishAdminWrite(id: string, status: number): Promise<void> {
		await this.deps.store.completeAdminWrite(id, status);
	}
}

const requestTaskId = (request: AccessRequest): string => {
	const target = request.route.resource.target;
	const name = typeof target === "object" && "params" in target ? target.params : "id";
	return request.params[name] ?? "";
};

function loginPrincipal(login: StoredLogin, now: Date): Principal | undefined {
	if (login.revokedAt !== null || login.idleExpiresAt <= now || login.user.disabledAt !== null) {
		return undefined;
	}
	return {
		kind: "login",
		user: login.user,
		loginId: login.id,
		tokenId: null,
		tokenName: null,
		granted: undefined,
		limit: null,
	};
}

function tokenPrincipal(token: StoredToken, now: Date): Principal | undefined {
	if (token.revokedAt !== null || (token.expiresAt !== null && token.expiresAt <= now)) {
		return undefined;
	}
	if (token.user !== null && token.user.disabledAt !== null) return undefined;
	switch (token.kind) {
		case "personal":
		case "session":
			return token.user === null
				? undefined
				: {
						kind: token.kind,
						user: token.user,
						loginId: null,
						tokenId: token.id,
						tokenName: token.name,
						granted: token.scopes,
						limit: token.projectId,
					};
		case "project":
			return token.projectId === null
				? undefined
				: {
						kind: "project",
						tokenId: token.id,
						name: token.name,
						granted: token.scopes,
						project: token.projectId,
					};
		case "task":
			return token.projectId === null
				? undefined
				: { kind: "task", tokenId: token.id, name: token.name, project: token.projectId };
	}
}

function agentPrincipal(credential: StoredAgentCredential): Principal | undefined {
	if (credential.revokedAt !== null) return undefined;
	// 开发 Agent 的凭据记在编辑者名下：用户被停用，它随之失效（ADR 0029「用户、项目与角色」：停用时他的全部凭据立即失效）。
	if (credential.user !== null && credential.user.disabledAt !== null) return undefined;
	if (credential.kind === "shared") return { kind: "shared" };
	return credential.agentName === null
		? undefined
		: { kind: "agent", agentName: credential.agentName, project: credential.projectId };
}

/** 把续期、清除 Cookie 的 `Set-Cookie` 加到结果上（只在登录 Cookie 的请求上有）。 */
function withCookie(
	result: AccessResult,
	resolved: Resolved,
	request: AccessRequest,
	idleMs: number,
): AccessResult {
	const secure = request.secure ?? false;
	if (resolved.renew !== undefined && result.ok) {
		return { ...result, setCookie: loginCookieHeader(resolved.renew, idleMs / 1000, { secure }) };
	}
	if (resolved.clear && !result.ok) {
		return { ...result, setCookie: clearLoginCookieHeader({ secure }) };
	}
	return result;
}
