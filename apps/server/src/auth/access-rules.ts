// 访问检查要用的、只和契约有关的规则（ADR 0029「项目从请求的哪里来」「一处检查」）：
// 一个接口的项目从哪里得出，以及 Agent 凭据和任务凭据各自能调用的接口清单。不依赖 Fastify，也不碰数据库。
import { PROJECT_PARAM, pathParamNames, type ResourceTarget, type RouteDef } from "@sfly/schema";
import type { z } from "zod";

/**
 * 一个接口的项目怎么得出（ADR 0029 把现有接口分成四类）：
 *
 * - `none`：不属于项目（`system`：健康检查、文档、SDK 与 Agent 二进制、安装脚本、API 客户端安装包、Python 索引），不需要凭据；
 * - `account`：账号类接口（登录、登出、当前用户、改密码、管理账号），不属于项目，不走范围表：认哪种凭据看 {@link ACCOUNT_ROUTES}；
 * - `path`：路径带项目（列表与新建，以及按名字定位的 Agent、节点包、飞书机器人，#488）：取路径里的 `:project`；
 * - `scenario`、`run`、`task`、`session`：经场景、运行、任务或会话（按 ID 定位，路径里不带项目）：项目是那个资源所在的项目
 *   （任务经它所属的运行）。`param` 是路径里 ID 的参数名。
 */
export type ProjectLocator =
	| { from: "none" }
	| { from: "account" }
	| { from: "path"; param: typeof PROJECT_PARAM }
	| { from: "scenario" | "run" | "task" | "session"; param: string };

/**
 * 接口的项目怎么得出；认不出时返回 undefined（`checkAccessRules` 在启动时拒绝，访问检查不会走到这里）。
 * 对资源类别穷举（`switch` 加 `never` 的兜底）：契约里加一个资源类别，这里不处理就过不了类型检查，
 * 不会让它悄悄落进某个默认的分支（#554）。
 */
export function locatorOf(
	def: Pick<RouteDef, "path" | "resource"> & { query?: z.ZodType | undefined },
): ProjectLocator | undefined {
	const { kind, target } = def.resource;
	switch (kind) {
		case "system":
			return { from: "none" };
		case "account":
			return { from: "account" };
		case "project":
			// 项目本身和项目的管理面：项目就是路径里的 `:project`，没有别的得出方式。
			return pathParamNames(def.path).includes(PROJECT_PARAM)
				? { from: "path", param: PROJECT_PARAM }
				: undefined;
		case "scenario":
		case "run":
		case "task":
		case "session":
		case "package":
		case "agent":
		case "dev_agent":
		case "feishu_bot":
			return locatorOfScoped(def, kind, target);
		default:
			return exhaustive(kind);
	}
}

/** 属于项目的资源类别（场景、运行、任务、会话、节点包、Agent、飞书机器人）：路径带项目、列表与新建、按名字或按 ID 定位。 */
function locatorOfScoped(
	def: Pick<RouteDef, "path"> & { query?: z.ZodType | undefined },
	kind: "scenario" | "run" | "task" | "session" | "package" | "agent" | "dev_agent" | "feishu_bot",
	target: ResourceTarget,
): ProjectLocator | undefined {
	// 列表、新建、上传和按名字定位的，路径一定带 `:project`（契约检查 `checkProjectInPath` 保证）；按 ID 定位的一定不带。
	if (pathParamNames(def.path).includes(PROJECT_PARAM))
		return { from: "path", param: PROJECT_PARAM };
	if (typeof target === "object" && "params" in target) {
		if (kind === "agent" || kind === "dev_agent" || kind === "package" || kind === "feishu_bot") {
			return undefined;
		}
		return { from: kind, param: target.params };
	}
	return undefined;
}

/** `switch` 穷举的兜底：走到这里说明加了新的取值而没有处理（类型检查会先报错）。 */
export function exhaustive(value: never): never {
	throw new Error(`没有处理的取值：${String(value)}`);
}

/**
 * 账号类接口各认哪种凭据（ADR 0029「凭据」的表；没列的凭据一律不认）：
 *
 * - `anonymous`：不要凭据（状态、登录、初始化第一个管理员；初始化要初始化码，登录要密码）：带了什么凭据都不看，
 *   过期的 Cookie 不该让登录页登录不了；
 * - `login`：只认登录 Cookie（当前用户、注销全部登录、改密码）；不带凭据是 401，带了别的凭据（个人令牌、项目令牌…）是 403；
 * - `logout`：登出：什么凭据都不拒绝，登出是幂等的、总是成功，响应总是清掉浏览器上的 Cookie。带着有效的登录 Cookie 就把库里的
 *   这一个登录注销，**不看同源判定**（公开地址和浏览器实际打开的地址不一致、跨站，同源检查都过不了：浏览器上的 Cookie
 *   清了、库里的登录却还有效，拿到这个 Cookie 的人还能继续用）；没带 Cookie、Cookie 已经失效，就只清 Cookie：
 *   不然页面说「已登出」，Cookie 还在，刷新又是登录着；
 * - `platform_admin`：只认平台管理员的登录 Cookie（管理账号）；不是平台管理员是 403；
 * - `login_or_personal`：登录 Cookie 或个人令牌（列出自己的令牌；吊销自己的令牌：个人令牌只能吊销它自己，由处理函数核对）；
 *   不带凭据是 401，别的凭据（项目令牌、会话令牌…）是 403；
 * - `login_or_password`：签发个人令牌：登录 Cookie，或者请求体里的账号密码（`sfly login` 换令牌，由处理函数验证）；
 *   带了令牌（任何一种）是 403：令牌不能签发令牌。
 *
 * 这些是新接口，不带凭据时的「照旧放行」（#494 才拒绝）不适用于它们：需要身份的接口没有身份就没法做。
 */
export type AccountCredential =
	| "anonymous"
	| "login"
	| "logout"
	| "platform_admin"
	| "login_or_personal"
	| "login_or_password";

export const ACCOUNT_ROUTES = {
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
	"GET /account/tokens": "login_or_personal",
	"POST /account/tokens": "login_or_password",
	"DELETE /account/tokens/:id": "login_or_personal",
} as const satisfies Record<string, AccountCredential>;

/**
 * 被停用的用户仍然可以用自己的凭据做的事：吊销自己的凭据（#578）。停用是可撤回的暂停，不是作废：停用期间他的登录和个人令牌对
 * 别的接口都拒绝；要是连吊销也拒绝，想登出的人（脚本里的 `sfly logout`、停用之前开着的页面）吊销不了，启用之后这些凭据又能用了。
 * 所以这几个接口在停用期间也认他自己的登录 Cookie 和个人令牌（别的凭据——会话令牌、项目令牌……——不认，所有者被停用的照旧 401）：
 * 注销全部登录、吊销个人令牌（登录可以吊销自己名下的任何一个，个人令牌只能吊销它自己，处理函数核对，停用期间也一样）；
 * `POST /auth/logout` 本来就认任何 Cookie（上面 `logout`），停用的用户的登录同样在内。这是账号类接口表之外的一条例外，放在同一处检查。
 * 不续期（不顺延登录的空闲期限、不写令牌的最后使用时间）：停用期间的凭据是只出不进的。
 */
export const REVOKE_OWN_ROUTES: ReadonlySet<string> = new Set([
	"POST /auth/logout-all",
	"DELETE /account/tokens/:id",
]);

/**
 * 只认人的登录 Cookie 的项目内接口（令牌不能签发令牌）：签发项目令牌要「管理」范围，并且只认登录；带了令牌（含带「管理」范围的
 * 个人令牌）是 403。列出和吊销项目令牌不在其中：令牌可以吊销令牌，那只会收窄权限。
 * 这是范围表之外的一条凭据种类的限制，和范围表放在同一处检查里（./access-guard.ts）。
 */
export const LOGIN_ONLY_ROUTES = {
	"POST /projects/:project/tokens": "令牌不能签发令牌：项目令牌只能由人在控制台里用登录签发",
} as const satisfies Record<string, string>;

/**
 * 不带凭据（和只带共享令牌）的请求一律 401（#494，ADR 0029「强制」）：说明写明怎么带上凭据。个别接口有自己的说明。
 * 公开的接口（`system`）和账号类接口里不看凭据的（登录、初始化、状态、登出）不走到这里。
 */
export const CREDENTIAL_REQUIRED =
	"需要登录或令牌：命令行运行 `sfly login`（脚本里设环境变量 SFLY_API_TOKEN），控制台先登录，API 客户端在 `token` 里给个人令牌或项目令牌（请求头 `Authorization: Bearer <令牌>`）";

/** 不带凭据时 401 的说明里另有要说的接口。 */
export const CREDENTIAL_REQUIRED_MESSAGES: Readonly<Record<string, string>> = {
	"POST /projects/:project/sessions":
		"建会话需要登录的用户：先登录控制台，或者在命令行运行 `sfly login`，再带上登录 Cookie 或个人令牌" +
		"（`Authorization: Bearer <个人令牌>`）；不带凭据、项目令牌、会话令牌都不行（会话令牌代发起人干活，建会话要有发起人）",
};

/** 不带凭据时的 401 说明。 */
export const credentialRequiredMessage = (def: Pick<RouteDef, "method" | "path">): string =>
	CREDENTIAL_REQUIRED_MESSAGES[routeKey(def)] ?? CREDENTIAL_REQUIRED;

/**
 * 过渡窗口里，以旧方式连接的 Agent（共享令牌、没有凭据，#492 记在连接上）、升级控制面之后正在做完手上任务的上一版 Agent
 * （版本不一致：它下载归档不带凭据，#719 之前），和它们手上的旧 SDK 还要用的三条 HTTP 通道
 * （ADR 0029「迁移与过渡」，#494）。不带凭据和带共享令牌的请求走同一套判断，只看 URL 里的版本或任务，不当作「某一台 Agent」：
 * - `archive`：下载节点包归档——有一个还没结束的任务派给了一台以旧方式连接的 Agent，节点要的正是这个包的这个版本；
 * - `upload`：上传产物——任务派给了一台以旧方式连接的 Agent，还在上报期内（和产物保存时的判断一样）；
 * - `task_artifacts`：任务里下载产物（旧 SDK 不认识任务凭据）——这次运行里此刻有任务在一台以旧方式连接的 Agent 上执行。
 * 任何一个项目登记了工作台，窗口就关上（`ProjectWorkbench.credentialRequired`）；之后这三条也是 401。
 */
export const LEGACY_AGENT_ROUTES = {
	"GET /projects/:project/packages/:name/versions/:version/archive": "archive",
	"PUT /tasks/:id/artifacts/*": "upload",
	"GET /tasks/:id/artifacts/*": "task_artifacts",
} as const satisfies Record<string, "archive" | "upload" | "task_artifacts">;
export type LegacyAgentRoute = (typeof LEGACY_AGENT_ROUTES)[keyof typeof LEGACY_AGENT_ROUTES];

/** `方法 路径模板`，清单和检查用它认接口。 */
export const routeKey = (def: Pick<RouteDef, "method" | "path">): string =>
	`${def.method} ${def.path}`;

/**
 * Agent 凭据和任务凭据不走范围表：它们不是人也不是程序，各有一份显式的接口清单，清单之外一律拒绝（403）
 * （ADR 0029「一处检查」）。值说明这个接口上还要核对什么：
 *
 * - `package_archive`：下载节点包归档，包要在这台 Agent 所属的项目或公共项目里；
 * - `assigned_task`：上传产物，任务要是派给这台 Agent 的（任务名和 Agent 的名字相同，且在同一个项目里）；
 * - `project_task`：下载产物，任务要在凭据所属的项目里。
 *
 * 任务凭据在任何节点代码里都拿得到，所以它不给「任务的读」那样宽的范围（那会包括全项目每个任务的日志和动作）。
 * 项目的写法见 {@link locatorOf}：这些接口的项目都经过同样的得出方式，#488 改路径时清单的键跟着改（测试检查清单里的接口都在契约里）。
 */
export const AGENT_CREDENTIAL_ROUTES = {
	"GET /projects/:project/packages/:name/versions/:version/archive": "package_archive",
	"PUT /tasks/:id/artifacts/*": "assigned_task",
} as const satisfies Record<string, "package_archive" | "assigned_task">;

export const TASK_CREDENTIAL_ROUTES = {
	"GET /tasks/:id/artifacts/*": "project_task",
} as const satisfies Record<string, "project_task">;

/** 访问检查要求的契约性质，启动时检查（`guardHttpContract`）：每个接口的项目都认得出来，吊销自己的凭据的例外清单里只有账号类接口。返回问题列表，空表示没有问题。 */
export function checkAccessRules(contract: readonly RouteDef[]): string[] {
	return contract.flatMap((def) => {
		// 没有写 resource 的接口由声明检查（checkRouteDeclarations）报，这里不重复。
		if (def.resource === undefined) return [];
		const problems: string[] = [];
		if (locatorOf(def) === undefined) {
			problems.push(
				`${routeKey(def)}：认不出项目从哪里得出（${def.resource.kind} × ${JSON.stringify(def.resource.target)}）：` +
					"新的资源类别或定位方式要在 locatorOf（src/auth/access-rules.ts）里写明",
			);
		}
		if (def.resource.kind === "account" && !(routeKey(def) in ACCOUNT_ROUTES)) {
			problems.push(
				`${routeKey(def)}：账号类接口要在 ACCOUNT_ROUTES（src/auth/access-rules.ts）里写明认哪种凭据：没有写明的账号类接口不能上线`,
			);
		}
		// 吊销自己的凭据的例外清单（REVOKE_OWN_ROUTES）只能放账号类、认登录或个人令牌的接口（启动时检查，#606）：写进不是账号类的接口
		// （不生效）、认别的凭据的账号类接口（例如平台管理员的 `POST /users`，会悄悄放宽它）都让控制面起不来。**写进别的只认登录或个人令牌的
		// 账号接口（当前用户、改密码、列出令牌）这里不报**：它们满足上面的条件，由行为测试拦住（停用的用户在这些接口上仍然是 401，
		// `test/disabled-revoke.test.ts`、`test/access-guard.test.ts`）。
		if (REVOKE_OWN_ROUTES.has(routeKey(def))) {
			const rule = (ACCOUNT_ROUTES as Record<string, string>)[routeKey(def)];
			if (def.resource.kind !== "account" || (rule !== "login" && rule !== "login_or_personal")) {
				problems.push(
					`${routeKey(def)}：REVOKE_OWN_ROUTES（停用的用户也认自己的凭据）只能放账号类、认登录或个人令牌的接口（ACCOUNT_ROUTES 里是 login、login_or_personal）`,
				);
			}
		}
		if (def.resource.kind === "system" && def.effect !== "read") {
			problems.push(
				`${routeKey(def)}：不属于项目的接口（system）不需要凭据，只能是只读的；有副作用的接口要作用在某类资源上，走范围表`,
			);
		}
		return problems;
	});
}

/** 几份凭据清单里的接口都在（完整的）契约里：接口改名或删掉了，清单要一起改。契约测试对 `httpContract` 运行它。 */
export function checkCredentialRoutes(contract: readonly RouteDef[]): string[] {
	const known = new Set(contract.map(routeKey));
	return [
		["AGENT_CREDENTIAL_ROUTES", AGENT_CREDENTIAL_ROUTES],
		["TASK_CREDENTIAL_ROUTES", TASK_CREDENTIAL_ROUTES],
		["ACCOUNT_ROUTES", ACCOUNT_ROUTES],
		["LOGIN_ONLY_ROUTES", LOGIN_ONLY_ROUTES],
		["LEGACY_AGENT_ROUTES", LEGACY_AGENT_ROUTES],
		["REVOKE_OWN_ROUTES", Object.fromEntries([...REVOKE_OWN_ROUTES].map((key) => [key, true]))],
		["CREDENTIAL_REQUIRED_MESSAGES", CREDENTIAL_REQUIRED_MESSAGES],
	].flatMap(([name, list]) =>
		Object.keys(list as object)
			.filter((key) => !known.has(key))
			.map((key) => `${name} 的 ${key} 不在契约里：接口改名或删掉了，把清单一起改掉`),
	);
}
