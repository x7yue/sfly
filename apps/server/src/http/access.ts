// 访问检查接进 Fastify（ADR 0029「一处检查」）：检查本身在 src/auth/access-guard.ts，不依赖 Fastify；
// 这里把它装到应用上，契约路由的注册入口（contract-route.ts 的 `register`）在每个请求进处理函数之前调用它。
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Access, AccessGuard } from "../auth/access-guard.js";

declare module "fastify" {
	interface FastifyInstance {
		/** 契约路由用的访问检查；没有安装时注册契约路由会抛错（不留「忘了装就没有检查」的路）。 */
		accessGuard: AccessGuard | null;
		/** 公开地址（`SFLY_PUBLIC_URL`）是 https：登录 Cookie 加 Secure。 */
		publicHttps: boolean;
	}
	interface FastifyRequest {
		/** 通过检查的凭据；不带凭据、带共享令牌（照旧放行）、不属于项目的接口为 null。 */
		access: Access | null;
	}
}

/**
 * 给应用装上访问检查；要在注册任何契约路由之前调用。`publicHttps`：公开地址是 https。
 */
export function installAccessGuard(
	app: FastifyInstance,
	guard: AccessGuard,
	options: { publicHttps: boolean } = { publicHttps: false },
): void {
	app.decorate("accessGuard", guard);
	app.decorate("publicHttps", options.publicHttps);
	app.decorateRequest("access", null);
}

/**
 * 浏览器看到的是 HTTPS：公开地址是 https，或者这个请求本身是 https（直连 TLS，或反向代理带了 `X-Forwarded-Proto: https`）。
 * 判断错了偏向「加 Secure」：多一个 Secure 只会让 http 的访问登录不上，少一个会让 Cookie 能走明文。
 */
export function isSecureRequest(request: FastifyRequest, publicHttps: boolean): boolean {
	if (publicHttps || request.protocol === "https") return true;
	const forwarded = request.headers["x-forwarded-proto"];
	const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
	return first?.toLowerCase() === "https";
}

/** 契约路由注册时取访问检查；没有安装时抛错。 */
export function accessGuardOf(app: FastifyInstance): AccessGuard {
	const guard = app.accessGuard;
	if (!guard) {
		throw new Error(
			"没有安装访问检查：注册契约路由之前先调用 installAccessGuard（src/http/access.ts）",
		);
	}
	return guard;
}
