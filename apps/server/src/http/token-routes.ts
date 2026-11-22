// 个人令牌和项目令牌的接口（ADR 0029「凭据」）：契约在 packages/schema/src/http/tokens.ts。
// 各接口认哪种凭据由访问检查规定：个人令牌的接口在 ACCOUNT_ROUTES（src/auth/access-rules.ts），项目令牌的接口走范围表
// （要「管理」），签发项目令牌另外只认登录（LOGIN_ONLY_ROUTES）。走到这里的请求已经过了检查，`request.access` 就是调用方。
// 令牌的原值只在签发的响应里出现一次：这个文件不记日志，错误说明里也不带原值。
import { type IssuedToken, SCOPE_LABELS, tokensApi } from "@sfly/schema";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ACCESS_NOT_FOUND_MESSAGE, type Access } from "../auth/access-guard.js";
import type { AccountService } from "../auth/accounts.js";
import type { Scope } from "../auth/scopes.js";
import { type IssueFailure, MAX_ACTIVE_TOKENS, type TokenService } from "../auth/tokens.js";
import { tooManyAttempts } from "./account-routes.js";
import { clientGone } from "./client-gone.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

export interface TokenRoutesDeps {
	tokens: TokenService;
	accounts: AccountService;
}

const labels = (scopes: readonly Scope[]) =>
	scopes.map((scope) => `「${SCOPE_LABELS[scope]}」`).join("、");

/** 签发失败翻成响应。 */
function refuseIssue(reply: FastifyReply, failure: IssueFailure, name: string): FastifyReply {
	switch (failure.reason) {
		case "project_not_found":
			return sendError(reply, 404, "not_found", ACCESS_NOT_FOUND_MESSAGE);
		case "no_scopes":
			return sendError(
				reply,
				403,
				"no_scopes",
				"你还不是任何项目的成员，没有可以签发的范围：让项目管理员把你加进项目",
			);
		case "scope_exceeds_role":
			return sendError(
				reply,
				403,
				"scope_exceeds_role",
				`要的范围超过了你此刻的角色：${labels(failure.excess)}；你此刻能有的是 ${labels(failure.allowed) || "（没有）"}`,
			);
		case "manage_scope_not_allowed":
			return sendError(
				reply,
				400,
				"manage_scope_not_allowed",
				"项目令牌不能带「管理」范围：成员、项目令牌、Agent 和它的凭据、飞书机器人的管理只能由人做",
			);
		case "name_taken":
			return sendError(
				reply,
				409,
				"token_name_taken",
				`已经有一个同名的有效令牌（${name}）：换个名字，或者先吊销旧的`,
			);
		case "too_many_tokens":
			return sendError(
				reply,
				409,
				"too_many_tokens",
				`有效的令牌已经有 ${MAX_ACTIVE_TOKENS} 个了：先吊销不用的`,
			);
	}
}

export function registerTokenRoutes(
	app: Parameters<typeof contractRoute>[0],
	{ tokens, accounts }: TokenRoutesDeps,
): void {
	/** 个人令牌的接口认登录或个人令牌：`access` 一定有用户。 */
	const person = (request: FastifyRequest): Access & { userId: string } => {
		const access = request.access;
		if (access?.userId == null) {
			throw new Error("个人令牌的接口没有拿到用户的身份（访问检查应该已经拒绝）");
		}
		return access as Access & { userId: string };
	};
	/** 项目令牌的接口走范围表：`access` 一定有项目（不带凭据的请求在检查里就是 401）。 */
	const inProject = (
		request: FastifyRequest,
	): Access & { project: NonNullable<Access["project"]> } => {
		const access = request.access;
		if (access?.project == null) {
			throw new Error("项目令牌的接口没有拿到项目（访问检查应该已经拒绝）");
		}
		return access as Access & { project: NonNullable<Access["project"]> };
	};
	const issued = (
		reply: FastifyReply,
		record: { view: Omit<IssuedToken, "token">; token: string },
	): FastifyReply => reply.code(201).send({ ...record.view, token: record.token });

	// ---- 个人令牌 ----

	contractRoute(app, tokensApi.listPersonal, async (_request, reply, raw) => {
		const access = person(raw);
		const user = await accounts.findUser(access.userId);
		if (user === undefined)
			return sendError(reply, 401, "unauthorized", "凭据无效、已过期或已吊销");
		return {
			tokens: await tokens.listPersonal(access.userId, access.tokenId),
			user: {
				id: user.id,
				login_name: user.loginName,
				display_name: user.displayName,
				is_platform_admin: user.isPlatformAdmin,
			},
		};
	});

	contractRoute(app, tokensApi.issuePersonal, async ({ body }, reply, raw) => {
		let userId = raw.access?.userId ?? null;
		if (userId === null) {
			// 没有登录 Cookie：用请求体里的账号密码换（`sfly login`），和登录共用限速，也不留下登录。
			if (body.login_name === undefined || body.password === undefined) {
				return sendError(
					reply,
					401,
					"unauthorized",
					"需要登录（Cookie），或者在请求体里给 login_name 和 password",
				);
			}
			const result = await accounts.authenticate(
				body.login_name,
				body.password,
				raw.ip,
				clientGone(reply),
			);
			if (!result.ok) {
				if (result.reason === "throttled") return tooManyAttempts(reply, result.retryAfterMs);
				return sendError(reply, 401, "invalid_credentials", "登录名或密码不对");
			}
			userId = result.user.id;
		}
		const user = await accounts.findUser(userId);
		if (user === undefined)
			return sendError(reply, 401, "unauthorized", "凭据无效、已过期或已吊销");
		const result = await tokens.issuePersonal(user, {
			name: body.name,
			...(body.scopes === undefined ? {} : { scopes: body.scopes }),
			...(body.project === undefined ? {} : { project: body.project }),
			...(body.expires_in_days === undefined ? {} : { expiresInDays: body.expires_in_days }),
		});
		return result.ok ? issued(reply, result.issued) : refuseIssue(reply, result, body.name);
	});

	contractRoute(app, tokensApi.revokePersonal, async ({ params }, reply, raw) => {
		const access = person(raw);
		// 个人令牌只能吊销它自己（`sfly logout` 用）；登录可以吊销自己的任何一个。
		if (access.credential === "personal" && access.tokenId !== params.id) {
			return sendError(
				reply,
				403,
				"forbidden",
				"个人令牌只能吊销它自己：要吊销别的令牌，在控制台里用登录操作",
			);
		}
		return (await tokens.revokePersonal(access.userId, params.id))
			? reply.code(204).send()
			: sendError(reply, 404, "not_found", "没有这个令牌");
	});

	// ---- 项目令牌 ----

	contractRoute(app, tokensApi.listProject, async (_request, _reply, raw) => ({
		tokens: await tokens.listProject(inProject(raw).project),
	}));

	contractRoute(app, tokensApi.issueProject, async ({ body }, reply, raw) => {
		const access = inProject(raw);
		const result = await tokens.issueProject(
			access.project,
			{
				name: body.name,
				scopes: body.scopes,
				...(body.expires_in_days === undefined ? {} : { expiresInDays: body.expires_in_days }),
			},
			access.scopes,
		);
		return result.ok ? issued(reply, result.issued) : refuseIssue(reply, result, body.name);
	});

	contractRoute(app, tokensApi.revokeProject, async ({ params }, reply, raw) =>
		(await tokens.revokeProject(inProject(raw).project, params.id))
			? reply.code(204).send()
			: sendError(reply, 404, "not_found", "这个项目里没有这个令牌"),
	);
}
