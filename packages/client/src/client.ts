import { ApiError } from "./errors.js";
import { createExchange, type FetchLike, type Nickname, type ResponseLike } from "./exchange.js";
import { type Api, routes } from "./generated/routes.js";
import {
	type CallOptions,
	type Methods,
	type RouteInput,
	type RouteRef,
	requestPath,
} from "./route.js";

export interface ClientOptions {
	/**
	 * 控制面地址，例如 `http://sfly.internal:8080`，直接调用控制面根路径上的接口。
	 * 同源页面可以只给路径（控制台用 `/api`），这时下载地址也是同源路径。
	 */
	baseUrl: string;
	/** 默认用全局 fetch。 */
	fetch?: FetchLike;
	/** 每个响应带回的控制面时间（ISO 8601），原样交给回调。 */
	onControlPlaneTime?: (time: string) => void;
	/**
	 * 写操作的昵称（运行记录里的触发人）：固定值，或每次请求时取值的函数，空白算没有。
	 * 非 GET 的请求没有昵称时，在发请求之前抛出错误码 `nickname_required` 的 ApiError；读操作不受影响。
	 */
	nickname?: Nickname;
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
}

export type Client = LowLevel & Methods<Api>;

export function createClient(options: ClientOptions): Client {
	const exchange = createExchange({
		baseUrl: options.baseUrl,
		fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
		nickname: options.nickname,
		onControlPlaneTime: options.onControlPlaneTime ?? (() => {}),
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
	const low: LowLevel = { request, url: exchange.url };

	const bind = (route: RouteRef & { readonly kind: "endpoint" | "download" }) => {
		switch (route.kind) {
			case "endpoint":
				return (input?: RouteInput, call?: CallOptions) => low.request(route, input, call);
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
