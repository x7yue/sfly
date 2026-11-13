import { CONTROL_PLANE_TIME_HEADER, CONTROL_PLANE_VERSION_HEADER } from "@sfly/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";

const ENV_NAME = "SFLY_CORS_ORIGINS";
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE";
const ALLOWED_REQUEST_HEADERS = "content-type, x-sfly-nickname, x-sfly-client, last-event-id";
const EXPOSED_RESPONSE_HEADERS = `${CONTROL_PLANE_VERSION_HEADER}, ${CONTROL_PLANE_TIME_HEADER}`;
/** 每个请求都带 `x-sfly-client`，都要预检；让浏览器缓存预检结果，名单改动十分钟内生效。 */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * 解析环境变量 `SFLY_CORS_ORIGINS`：逗号分隔的来源名单，每一项规范成浏览器发来的 `Origin` 写法
 * （协议和主机小写、去掉默认端口和路径）。没有设置、全是空项或含 `*` 时返回 undefined，表示允许所有来源；
 * 有不是来源的项时报错，不让一个写错的名单悄悄变成「谁也调不通」。
 */
export function parseCorsOrigins(raw: string | undefined): string[] | undefined {
	const entries = (raw ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0 || entries.includes("*")) return undefined;
	return entries.map((entry) => {
		const origin = URL.canParse(entry) ? new URL(entry).origin : "null";
		if (origin === "null") {
			throw new Error(
				`${ENV_NAME} 里的 ${JSON.stringify(entry)} 不是来源，要写成 https://dash.example.com 这样的「协议://主机[:端口]」`,
			);
		}
		return origin;
	});
}

const isPreflight = ({ method, headers }: FastifyRequest) =>
	method === "OPTIONS" &&
	headers.origin !== undefined &&
	headers["access-control-request-method"] !== undefined;

export interface CorsOptions {
	/** 允许的来源名单；不设置时允许所有来源（ADR 0022）。 */
	origins?: readonly string[];
}

/**
 * 跨域（ADR 0022）：自建页面托管在别的来源，浏览器调用控制面前先预检。
 * 默认允许所有来源且不带凭据；给了名单就只对名单里的来源回应允许，并带 `Vary: Origin`。
 *
 * 在 `onRequest` 里答复预检、给之后的响应设置响应头，所以要在 registerWebApp 之后注册：
 * 前端静态文件在它的钩子里已经答复，走不到这里，不带跨域头。
 * 事件流（SSE）的响应绕过 `onSend`，Sse#open 把 reply 上已经设置的响应头一并写进响应头。
 */
export function registerCors(app: FastifyInstance, { origins }: CorsOptions): void {
	app.addHook("onRequest", async (request, reply) => {
		const allowed = origins ? origins.find((o) => o === request.headers.origin) : "*";
		if (origins) reply.header("vary", "origin");
		if (allowed) {
			reply.header("access-control-allow-origin", allowed);
			reply.header("access-control-expose-headers", EXPOSED_RESPONSE_HEADERS);
		}
		if (!isPreflight(request)) return;
		if (allowed) {
			reply.header("access-control-allow-methods", ALLOWED_METHODS);
			reply.header("access-control-allow-headers", ALLOWED_REQUEST_HEADERS);
			reply.header("access-control-max-age", PREFLIGHT_MAX_AGE_SECONDS);
		}
		return reply.code(204).send();
	});
}
