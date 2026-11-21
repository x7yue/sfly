// 访问检查接进 Fastify（ADR 0029「一处检查」）：检查本身在 src/auth/access-guard.ts，不依赖 Fastify；
// 这里把它装到应用上，契约路由的注册入口（contract-route.ts 的 `register`）在每个请求进处理函数之前调用它。
import type { FastifyInstance } from "fastify";
import type { Access, AccessGuard } from "../auth/access-guard.js";

declare module "fastify" {
	interface FastifyInstance {
		/** 契约路由用的访问检查；没有安装时注册契约路由会抛错（不留「忘了装就没有检查」的路）。 */
		accessGuard: AccessGuard | null;
	}
	interface FastifyRequest {
		/** 通过检查的凭据；不带凭据、带共享令牌（照旧放行）、不属于项目的接口为 null。 */
		access: Access | null;
	}
}

/** 给应用装上访问检查；要在注册任何契约路由之前调用。 */
export function installAccessGuard(app: FastifyInstance, guard: AccessGuard): void {
	app.decorate("accessGuard", guard);
	app.decorateRequest("access", null);
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
