// 账号与登录的接口（ADR 0029「用户、项目与角色」「认证的几处细节」）：契约在 packages/schema/src/http/accounts.ts。
// 各接口认哪种凭据由访问检查里的 ACCOUNT_ROUTES 规定（src/auth/access-rules.ts）：走到这里的请求已经过了它，
// `request.access` 就是登录的用户。
import { authApi, type CurrentUser, type UserView, usersApi } from "@sfly/schema";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type AccountService, LoginNameTaken, type UserRecord } from "../auth/accounts.js";
import { clearLoginCookieHeader, loginCookieHeader } from "../auth/login-cookie.js";
import { isSecureRequest } from "./access.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

export interface AccountRoutesDeps {
	accounts: AccountService;
	/** 公开地址（`SFLY_PUBLIC_URL`）是 https：Cookie 加 Secure。 */
	publicHttps: boolean;
}

const currentUser = (user: UserRecord): CurrentUser => ({
	id: user.id,
	login_name: user.loginName,
	display_name: user.displayName,
	is_platform_admin: user.isPlatformAdmin,
});

const userView = (user: UserRecord): UserView => ({
	...currentUser(user),
	disabled_at: user.disabledAt?.toISOString() ?? null,
	created_at: user.createdAt.toISOString(),
});

function tooManyAttempts(reply: FastifyReply, retryAfterMs: number): FastifyReply {
	const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
	reply.header("retry-after", seconds);
	return sendError(reply, 429, "too_many_attempts", `失败次数太多，请 ${seconds} 秒之后再试`);
}

export function registerAccountRoutes(
	app: Parameters<typeof contractRoute>[0],
	{ accounts, publicHttps }: AccountRoutesDeps,
): void {
	const secure = (request: FastifyRequest) => isSecureRequest(request, publicHttps);
	const startCookie = (
		reply: FastifyReply,
		request: FastifyRequest,
		cookie: string,
		maxAge: number,
	) => reply.header("set-cookie", loginCookieHeader(cookie, maxAge, { secure: secure(request) }));
	/** 通过访问检查的登录：账号类接口的 `access` 一定有用户和登录。 */
	const loggedIn = (request: FastifyRequest) => {
		const access = request.access;
		if (access?.userId == null || access.loginId == null) {
			throw new Error("账号类接口没有拿到登录的身份（访问检查应该已经拒绝）");
		}
		return { userId: access.userId, loginId: access.loginId };
	};

	contractRoute(app, authApi.status, async () => ({
		setup_required: await accounts.setupRequired(),
	}));

	contractRoute(app, authApi.setup, async ({ body }, reply, raw) => {
		const result = await accounts.setup(
			{
				code: body.setup_code,
				loginName: body.login_name,
				displayName: body.display_name,
				password: body.password,
			},
			raw.ip,
		);
		if (!result.ok) {
			if (result.reason === "throttled") return tooManyAttempts(reply, result.retryAfterMs);
			if (result.reason === "setup_done") {
				return sendError(reply, 409, "setup_done", "已经有用户了，不需要初始化；用账号登录");
			}
			return sendError(
				reply,
				403,
				"invalid_setup_code",
				"初始化码不对：用控制面启动时打印在日志里的那个，或数据目录里的 setup-code 文件",
			);
		}
		startCookie(reply, raw, result.login.cookie, result.login.maxAgeSeconds);
		return reply.code(201).send(currentUser(result.login.user));
	});

	contractRoute(app, authApi.login, async ({ body }, reply, raw) => {
		const result = await accounts.login(body.login_name, body.password, raw.ip);
		if (!result.ok) {
			if (result.reason === "throttled") return tooManyAttempts(reply, result.retryAfterMs);
			return sendError(reply, 401, "invalid_credentials", "登录名或密码不对");
		}
		startCookie(reply, raw, result.login.cookie, result.login.maxAgeSeconds);
		return currentUser(result.login.user);
	});

	contractRoute(app, authApi.logout, async (_request, reply, raw) => {
		const { userId, loginId } = loggedIn(raw);
		await accounts.logout(userId, loginId);
		reply.header("set-cookie", clearLoginCookieHeader({ secure: secure(raw) }));
		return reply.code(204).send();
	});

	contractRoute(app, authApi.logoutAll, async (_request, reply, raw) => {
		await accounts.logoutAll(loggedIn(raw).userId);
		reply.header("set-cookie", clearLoginCookieHeader({ secure: secure(raw) }));
		return reply.code(204).send();
	});

	contractRoute(app, authApi.me, async (_request, reply, raw) => {
		const user = await accounts.findUser(loggedIn(raw).userId);
		return user
			? currentUser(user)
			: sendError(reply, 401, "unauthorized", "凭据无效、已过期或已吊销");
	});

	contractRoute(app, authApi.changePassword, async ({ body }, reply, raw) => {
		const { userId, loginId } = loggedIn(raw);
		const result = await accounts.changePassword(
			userId,
			loginId,
			body.old_password,
			body.new_password,
			raw.ip,
		);
		if (result.ok) return reply.code(204).send();
		if (result.reason === "throttled") return tooManyAttempts(reply, result.retryAfterMs);
		return sendError(reply, 403, "wrong_password", "旧密码不对");
	});

	contractRoute(app, usersApi.list, async () => ({
		users: (await accounts.listUsers()).map(userView),
	}));

	contractRoute(app, usersApi.create, async ({ body }, reply) => {
		try {
			const user = await accounts.createUser({
				loginName: body.login_name,
				displayName: body.display_name,
				password: body.password,
				isPlatformAdmin: body.is_platform_admin,
			});
			return reply.code(201).send(userView(user));
		} catch (error) {
			if (error instanceof LoginNameTaken) {
				return sendError(reply, 409, "login_name_taken", error.message);
			}
			throw error;
		}
	});

	const notFound = (reply: FastifyReply) => sendError(reply, 404, "not_found", "没有这个用户");

	contractRoute(app, usersApi.disable, async ({ params }, reply, raw) => {
		if (params.id === loggedIn(raw).userId) {
			return sendError(reply, 409, "cannot_disable_self", "不能停用自己：让另一位平台管理员来停用");
		}
		const user = await accounts.disable(params.id);
		return user ? userView(user) : notFound(reply);
	});

	contractRoute(app, usersApi.enable, async ({ params }, reply) => {
		const user = await accounts.enable(params.id);
		return user ? userView(user) : notFound(reply);
	});

	contractRoute(app, usersApi.resetPassword, async ({ params, body }, reply, raw) => {
		if (params.id === loggedIn(raw).userId) {
			return sendError(
				reply,
				409,
				"cannot_reset_self",
				"不能重置自己的密码：用「改密码」（要旧密码）；忘了密码就在控制面所在的主机上执行重置命令",
			);
		}
		return (await accounts.resetPassword(params.id, body.password))
			? reply.code(204).send()
			: notFound(reply);
	});
}
