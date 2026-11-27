import { z } from "zod";
import { nameProblem, nameRefinement } from "../text-safety.js";
import { endpoint, Timestamp } from "./contract.js";
import { SCOPES } from "./scopes.js";

/**
 * 账号与登录相关接口的契约（约定见 ./contract.ts，ADR 0029「用户、项目与角色」「认证的几处细节」）。
 *
 * 全部是账号类接口（资源类别 `account`）：不属于任何项目，路径不带项目，不走项目的范围表。各接口认哪种凭据，
 * 由控制面的访问检查里的一张表规定（apps/server/src/auth/access-rules.ts 的 `ACCOUNT_ROUTES`）：
 * 登录、初始化和状态不要凭据；当前用户、登出、改密码只认登录 Cookie；管理账号只认平台管理员的登录 Cookie。
 * 这些接口只给控制台用，不进 API 客户端（`client: false`）；个人令牌和 `sfly login` 是 #491。
 */

/** 登录名的写法（ADR 0029）：小写字母、数字、下划线，长度 1–32，不含连字符：开发 Agent 的名字 `dev-<登录名>-<主机>` 靠这一点没有歧义。 */
export const LOGIN_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
export const LOGIN_NAME_RULE =
	"登录名只能用小写字母、数字和下划线，长度 1–32 个字符（不能含连字符、大写字母、空格）";

/** 密码的长度范围（字符数）：太短的拒绝；上限防止有人拿超长的输入拖慢哈希。 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** 显示名的长度上限（字符数）；显示名不受字符集限制。 */
export const DISPLAY_NAME_MAX_LENGTH = 64;

export const LoginName = z.string().regex(LOGIN_NAME_PATTERN, LOGIN_NAME_RULE);

/** 新密码：长度在范围内即可，不做复杂度规则（见 PASSWORD_MIN_LENGTH）。 */
export const NewPassword = z
	.string()
	.min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`)
	.max(PASSWORD_MAX_LENGTH, `密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符`);

/**
 * 显示名：去掉首尾空白后 1 到 {@link DISPLAY_NAME_MAX_LENGTH} 个字符，不含 `text-safety.ts` 里那张明确的表里的字符
 * （控制字符、双向文字的控制字符、零宽空格这类看不见的字符：显示名会出现在「经 …」、作者和命令行的输出里）。
 */
export const AccountDisplayName = z
	.string()
	.trim()
	.min(1, "显示名不能为空")
	.max(DISPLAY_NAME_MAX_LENGTH, `显示名不能超过 ${DISPLAY_NAME_MAX_LENGTH} 个字符`)
	.refine((name) => nameProblem(name) === undefined, nameRefinement("显示名"));

/** 一个用户的账号信息（令牌页的「属于谁」、当前登录的用户和平台管理员看到的用户都从这里长出来）。 */
export const AccountUser = z.object({
	id: z.string(),
	login_name: z.string(),
	display_name: z.string(),
	/** 平台管理员：管理账号、建项目、维护公共项目，并在每个项目里有项目管理员的权限。 */
	is_platform_admin: z.boolean(),
});

/** 当前登录的用户，加上他在默认项目里此刻有的范围（`scopes`）。 */
export const CurrentUser = AccountUser.extend({
	/**
	 * 这个用户**此刻在默认项目里**有的范围（读、运行、编辑、会话构建、发布、管理）：控制台按它决定显示哪些操作（例如有「管理」才显示
	 * Agent 的凭据和停用）。**只是默认项目里的范围**：Agent 页和 `/agents` 现在都在默认项目，页面才能拿它判断；别的项目里的页面不能用它，
	 * 项目切换、路径带项目（#499）之后要改成按页面所在的项目给。算法和访问检查是同一处（控制面的 `userScopes`）：平台管理员有项目管理员的全部范围，
	 * 成员按角色，不是默认项目成员的什么范围都没有（在别的项目里是管理员也一样）。它只是让页面少显示点不了的按钮，不是授权：
	 * 每个请求服务端照样检查；也不缓存：登录、初始化和 `GET /auth/me` 每次都按此刻的角色算。
	 */
	scopes: z.array(z.enum(SCOPES)),
});

/** 平台管理员看到的一个用户。 */
export const UserView = z.object({
	...AccountUser.shape,
	/** 停用的时间；没有停用为 null。停用的用户的登录和令牌立即失效。 */
	disabled_at: Timestamp.nullable(),
	created_at: Timestamp,
});

/**
 * 登录页和初始化页用的状态，不带凭据可读：
 *
 * - `setup_required`：没有任何用户时要先初始化第一个管理员；
 * - `public_url`：控制面认的公开地址（`SFLY_PUBLIC_URL`，去掉末尾的斜杠），没有配置为 null；
 * - `request_host`：控制面看到的这个请求的 `Host`。
 *
 * 后两个让页面发现「浏览器打开的地址和控制面认的不一致」：登录 Cookie 只认同源的请求（ADR 0029），内网用 http 访问时浏览器不发
 * `Sec-Fetch-Site`，判断落到 `Origin` 对公开地址（没配公开地址时对 `Host`）上，对不上的写请求被当作没登录。
 * 页面比较 `location` 和这两个值，不一致就提示「请用 <公开地址> 打开」，不让人在一个什么都改不了的页面上干等。
 */
export const AuthStatus = z.object({
	setup_required: z.boolean(),
	public_url: z.string().nullable(),
	request_host: z.string(),
});

export const UserIdParams = z.object({ id: z.uuid() });

export const authApi = {
	/** 登录页和 `/setup` 页据此决定显示哪一个。 */
	status: endpoint({
		method: "GET",
		path: "/auth/status",
		summary: "读登录状态：是不是还没有任何用户、要先初始化第一个管理员",
		effect: "read",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["auth", "status"],
		response: AuthStatus,
	}),
	/**
	 * 用初始化码建第一个平台管理员，并直接登录（响应带 `Set-Cookie`）。初始化码在控制面启动时没有任何用户的情况下
	 * 打印在日志里、写在数据目录的 `setup-code` 文件里；用过即失效。已经有用户时是 409 `setup_done`。
	 */
	setup: endpoint({
		method: "POST",
		path: "/auth/setup",
		summary: "用初始化码建第一个平台管理员并登录",
		effect: "write",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["auth", "setup"],
		body: z.object({
			setup_code: z.string().min(1).max(256),
			login_name: LoginName,
			display_name: AccountDisplayName,
			password: NewPassword,
		}),
		response: CurrentUser,
	}),
	/**
	 * 用登录名和密码登录，响应带 `Set-Cookie`（HttpOnly、SameSite=Lax，HTTPS 下加 Secure）。登录名或密码不对是 401
	 * `invalid_credentials`（不区分是哪一个，也不区分账号是否停用）；连续失败太多是 429 `too_many_attempts`，带 `Retry-After`。
	 */
	login: endpoint({
		method: "POST",
		path: "/auth/login",
		summary: "用登录名和密码登录",
		effect: "write",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["auth", "login"],
		// 登录名这里不按「登录名的写法」校验：写法不对的登录名和不存在的一样得到 401，不给出规则的提示。
		body: z.object({
			login_name: z.string().min(1).max(256),
			password: z
				.string()
				.min(1)
				.max(PASSWORD_MAX_LENGTH * 4),
		}),
		response: CurrentUser,
	}),
	logout: endpoint({
		method: "POST",
		path: "/auth/logout",
		summary: "登出：注销当前这一个登录",
		effect: "write",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["auth", "logout"],
		response: z.undefined(),
	}),
	/** 注销自己所有的登录（包括当前这个）；他在别处打开的页面和事件流随之失效。 */
	logoutAll: endpoint({
		method: "POST",
		path: "/auth/logout-all",
		summary: "注销自己所有的登录",
		effect: "write",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["auth", "logout-all"],
		response: z.undefined(),
	}),
	me: endpoint({
		method: "GET",
		path: "/auth/me",
		summary: "读当前登录的用户",
		effect: "read",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["auth", "me"],
		response: CurrentUser,
	}),
	/** 要登录 Cookie 加旧密码；改完后他在别处的其他登录都注销，当前这个保留。旧密码不对是 403 `wrong_password`。 */
	changePassword: endpoint({
		method: "POST",
		path: "/auth/password",
		summary: "改自己的密码（要旧密码）",
		effect: "write",
		resource: { kind: "account", target: "self" },
		client: false,
		key: ["auth", "password"],
		body: z.object({
			old_password: z
				.string()
				.min(1)
				.max(PASSWORD_MAX_LENGTH * 4),
			new_password: NewPassword,
		}),
		response: z.undefined(),
	}),
};

export const usersApi = {
	list: endpoint({
		method: "GET",
		path: "/users",
		summary: "列出所有用户（平台管理员）",
		effect: "read",
		resource: { kind: "account", target: "collection" },
		client: false,
		key: ["users", "list"],
		response: z.object({ users: z.array(UserView) }),
	}),
	/** 登录名重复是 409 `login_name_taken`；登录名的写法不对是 400，说明规则。 */
	create: endpoint({
		method: "POST",
		path: "/users",
		summary: "建一个用户（平台管理员）",
		effect: "write",
		resource: { kind: "account", target: "collection" },
		client: false,
		key: ["users", "create"],
		body: z.object({
			login_name: LoginName,
			display_name: AccountDisplayName,
			password: NewPassword,
			is_platform_admin: z.boolean().default(false),
		}),
		response: UserView,
	}),
	/** 停用后他的全部登录和令牌立即失效，打开的事件流随之关闭。不能停用自己。 */
	disable: endpoint({
		method: "POST",
		path: "/users/:id/disable",
		summary: "停用一个用户（平台管理员）",
		effect: "write",
		resource: { kind: "account", target: { params: "id" } },
		client: false,
		key: ["users", "disable"],
		params: UserIdParams,
		response: UserView,
	}),
	enable: endpoint({
		method: "POST",
		path: "/users/:id/enable",
		summary: "恢复一个停用的用户（平台管理员）",
		effect: "write",
		resource: { kind: "account", target: { params: "id" } },
		client: false,
		key: ["users", "enable"],
		params: UserIdParams,
		response: UserView,
	}),
	/** 平台管理员给出新密码；他的全部登录随之注销（令牌不受影响）。 */
	resetPassword: endpoint({
		method: "POST",
		path: "/users/:id/password",
		summary: "重置一个用户的密码（平台管理员）",
		effect: "write",
		resource: { kind: "account", target: { params: "id" } },
		client: false,
		key: ["users", "reset-password"],
		params: UserIdParams,
		body: z.object({ password: NewPassword }),
		response: z.undefined(),
	}),
};

export type AccountUser = z.infer<typeof AccountUser>;
export type CurrentUser = z.infer<typeof CurrentUser>;
export type UserView = z.infer<typeof UserView>;
export type AuthStatus = z.infer<typeof AuthStatus>;
