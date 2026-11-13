// 唯一的请求路径：客户端的每个请求都经过 send，请求头只在 headersFor 里决定，响应带回的信息只在 observe 里读。
import { ApiError, errorFromResponse } from "./errors.js";
import { CONTROL_PLANE_TIME_HEADER } from "./generated/protocol.js";
import { type CallOptions, type RouteInput, type RouteRef, requestPath } from "./route.js";

/** 客户端调用 fetch 时用到的部分：全局 fetch、undici 的 fetch 和测试替身都符合。 */
export type FetchLike = (url: string, init: FetchInit) => Promise<ResponseLike>;

export interface FetchInit {
	method: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	keepalive?: boolean;
}

export interface ResponseLike {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	text(): Promise<string>;
}

export interface ExchangeConfig {
	/** 不带末尾的 `/`：http(s) 地址，或同源页面用的路径（控制台用 `/api`）。 */
	baseUrl: string;
	fetch: FetchLike;
	onControlPlaneTime: (time: string) => void;
}

export interface SendInit extends CallOptions {
	accept: string;
}

export interface Exchange {
	/** 发出一个请求，收到 2xx 时返回还没读的响应；失败时抛出 ApiError，中止时抛出中止的原因。 */
	send(route: RouteRef, input: RouteInput | undefined, init: SendInit): Promise<ResponseLike>;
	url(route: RouteRef, input: RouteInput | undefined): string;
	/** 控制面时间的唯一入口：响应头里的和事件流里的都经过这里交给回调。 */
	noteTime(time: string | null | undefined): void;
}

export function createExchange(config: ExchangeConfig): Exchange {
	const headersFor = (input: RouteInput | undefined, init: SendInit): Record<string, string> => {
		const headers: Record<string, string> = { accept: init.accept };
		if (input?.body !== undefined) headers["content-type"] = "application/json";
		return headers;
	};

	const noteTime = (time: string | null | undefined): void => {
		if (time) config.onControlPlaneTime(time);
	};

	const observe = (res: ResponseLike): void => {
		noteTime(res.headers.get(CONTROL_PLANE_TIME_HEADER));
	};

	const url = (route: RouteRef, input: RouteInput | undefined) =>
		`${config.baseUrl}${requestPath(route, input)}`;

	const send = async (route: RouteRef, input: RouteInput | undefined, init: SendInit) => {
		const path = requestPath(route, input);
		let res: ResponseLike;
		try {
			res = await config.fetch(`${config.baseUrl}${path}`, {
				method: route.method,
				headers: headersFor(input, init),
				body: input?.body === undefined ? undefined : JSON.stringify(input.body),
				signal: init.signal,
				keepalive: init.keepalive,
			});
		} catch (error) {
			if (init.signal?.aborted) throw init.signal.reason;
			throw new ApiError({
				status: 0,
				code: "network_error",
				message: "无法连接控制面",
				details: String(error),
				cause: error,
				method: route.method,
				path,
			});
		}
		observe(res);
		if (!res.ok) throw await errorFromResponse(res, route.method, path);
		return res;
	};

	return { send, url, noteTime };
}
