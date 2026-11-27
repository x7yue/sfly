import { ApiError } from "./errors.js";
import {
	createExchange,
	type FetchLike,
	type ResponseLike,
	type Token,
	type VersionMismatch,
} from "./exchange.js";
import { type Api, routes } from "./generated/routes.js";
import {
	type CallOptions,
	type Handlers,
	type Methods,
	type RouteInput,
	type RouteRef,
	requestPath,
	type SubscribeOptions,
	type Unsubscribe,
} from "./route.js";
import { subscribe } from "./subscribe.js";

export interface ClientOptions {
	/**
	 * 控制面地址，例如 `http://sfly.internal:8080`，直接调用控制面根路径上的接口。
	 * 同源页面可以只给路径（控制台用 `/api`），这时下载地址也是同源路径。
	 */
	baseUrl: string;
	/** 默认用全局 fetch。 */
	fetch?: FetchLike;
	/** 每个响应和事件流带回的控制面时间（ISO 8601），原样交给回调。 */
	onControlPlaneTime?: (time: string) => void;
	/**
	 * API 令牌（`sfly_pat_…` 个人令牌或 `sfly_prj_…` 项目令牌，在控制台的「令牌」页签发）：固定值，或每次请求时
	 * 取值的函数（轮换令牌），空白算没有。每个请求（含事件流）带 `Authorization: Bearer <令牌>`，身份由令牌决定：
	 * 运行记录里的触发人是令牌所属的用户（项目令牌是令牌的名称）。令牌的范围不够时控制面回 403。
	 * 没有令牌时请求照发，控制面回 401：抛出错误码 `unauthorized` 的 ApiError。同源页面靠登录后的 Cookie，不用给令牌。
	 */
	token?: Token;
	/**
	 * 控制面和客户端的版本不一致时，每个客户端实例调用一次；请求照常进行。
	 * 默认 `console.warn(mismatch.message)`。
	 */
	onVersionMismatch?: (mismatch: VersionMismatch) => void;
	/**
	 * 带着令牌往不是本机的 `http://` 地址发请求时（令牌在网络上是明文），每个客户端实例调用一次；请求照常进行。
	 * 默认 `console.warn(message)`。
	 */
	onInsecureToken?: (message: string) => void;
}

/** 按路由描述调用任何接口：生成的方法建立在它上面，控制台用契约里的 zod 定义调用它。 */
export interface LowLevel {
	/** 下载：返回 2xx 的响应，响应体还没读。 */
	request(
		route: RouteRef & { readonly kind: "download" },
		input?: RouteInput,
		options?: CallOptions,
	): Promise<ResponseLike>;
	/** JSON 接口：返回解析后的响应体（204 为 undefined），不校验形状。 */
	request(route: RouteRef, input?: RouteInput, options?: CallOptions): Promise<unknown>;
	/** 接口的地址，不发请求。 */
	url(route: RouteRef, input?: RouteInput): string;
	/** 订阅事件流：按事件名分发给处理函数（不校验形状），断线自动重连；返回关闭函数。 */
	subscribe(
		route: RouteRef & { readonly kind: "stream" },
		input: RouteInput | undefined,
		handlers: Handlers<Record<string, unknown>>,
		options?: SubscribeOptions,
	): Unsubscribe;
}

export type Client = LowLevel & Methods<Api>;

export function createClient(options: ClientOptions): Client {
	const exchange = createExchange({
		baseUrl: options.baseUrl,
		fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
		token: options.token,
		onControlPlaneTime: options.onControlPlaneTime ?? (() => {}),
		onVersionMismatch: options.onVersionMismatch ?? ((mismatch) => console.warn(mismatch.message)),
		onInsecureToken: options.onInsecureToken ?? ((message) => console.warn(message)),
	});

	function request(
		route: RouteRef & { readonly kind: "download" },
		input?: RouteInput,
		call?: CallOptions,
	): Promise<ResponseLike>;
	function request(route: RouteRef, input?: RouteInput, call?: CallOptions): Promise<unknown>;
	async function request(
		route: RouteRef,
		input?: RouteInput,
		call: CallOptions = {},
	): Promise<unknown> {
		if (route.kind === "download") {
			return exchange.send(route, input, { ...call, accept: route.contentType ?? "*/*" });
		}
		const res = await exchange.send(route, input, { ...call, accept: "application/json" });
		if (res.status === 204) return undefined;
		try {
			return await res.json();
		} catch (error) {
			if (call.signal?.aborted) throw call.signal.reason;
			throw new ApiError({
				status: res.status,
				code: "invalid_response",
				message: "响应不是 JSON",
				details: String(error),
				cause: error,
				method: route.method,
				path: requestPath(route, input),
			});
		}
	}
	const low: LowLevel = {
		request,
		url: exchange.url,
		subscribe: (route, input, handlers, options) =>
			subscribe(exchange, route, input, handlers, options),
	};

	const bind = (
		route:
			| (RouteRef & { readonly kind: "endpoint" })
			| (RouteRef & { readonly kind: "stream" })
			| (RouteRef & { readonly kind: "download" }),
	) => {
		switch (route.kind) {
			case "endpoint":
				return (input?: RouteInput, call?: CallOptions) => low.request(route, input, call);
			case "stream":
				return (
					input: RouteInput,
					handlers: Handlers<Record<string, unknown>>,
					options?: SubscribeOptions,
				) => low.subscribe(route, input, handlers, options);
			case "download":
				return (input?: RouteInput) => low.url(route, input);
		}
	};
	const domains = Object.fromEntries(
		Object.entries(routes).map(([domain, table]) => [
			domain,
			Object.fromEntries(Object.entries(table).map(([name, route]) => [name, bind(route)])),
		]),
	);
	return { ...domains, ...low } as Client;
}
