import { ApiError, errorFromResponse } from "./errors.js";
import { CONTROL_PLANE_TIME_HEADER, CONTROL_PLANE_VERSION_HEADER } from "./generated/protocol.js";
import { type CallOptions, type RouteInput, type RouteRef, requestPath } from "./route.js";
import { CLIENT_VERSION } from "./version.js";

const NICKNAME_HEADER = "x-sfly-nickname";
const CLIENT_HEADER = "x-sfly-client";

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

/** 固定的昵称，或每次请求时取值的函数；空白算没有。 */
export type Nickname = string | (() => string | null | undefined);

export interface VersionMismatch {
	clientVersion: string;
	controlPlaneVersion: string;
	/** 写明两边版本和处理办法的一句话。 */
	message: string;
}

export interface ExchangeConfig {
	baseUrl: string;
	fetch: FetchLike;
	nickname?: Nickname;
	onControlPlaneTime: (time: string) => void;
	onVersionMismatch: (mismatch: VersionMismatch) => void;
}

export interface SendInit extends CallOptions {
	accept: string;
}

export interface Exchange {
	send(route: RouteRef, input: RouteInput | undefined, init: SendInit): Promise<ResponseLike>;
	url(route: RouteRef, input: RouteInput | undefined): string;
}

export function createExchange(config: ExchangeConfig): Exchange {
	const baseUrl = normalizeBaseUrl(config.baseUrl);

	let versionWarned = false;

	const nicknameNow = (): string | undefined => {
		const value = typeof config.nickname === "function" ? config.nickname() : config.nickname;
		return value?.trim() || undefined;
	};

	const headersFor = (
		route: RouteRef,
		input: RouteInput | undefined,
		init: SendInit,
	): Record<string, string> => {
		const headers: Record<string, string> = {
			accept: init.accept,
			[CLIENT_HEADER]: `sfly-client/${CLIENT_VERSION}`,
		};
		if (input?.body !== undefined) headers["content-type"] = "application/json";
		const nickname = nicknameNow();
		if (nickname !== undefined) {
			headers[NICKNAME_HEADER] = encodeURIComponent(nickname);
		} else if (route.method !== "GET") {
			throw new ApiError({
				status: 400,
				code: "nickname_required",
				message: "写操作需要昵称：创建客户端时给 nickname",
				method: route.method,
				path: requestPath(route, input),
			});
		}
		return headers;
	};

	const observe = (res: ResponseLike): void => {
		const time = res.headers.get(CONTROL_PLANE_TIME_HEADER);
		if (time) config.onControlPlaneTime(time);
		const controlPlaneVersion = res.headers.get(CONTROL_PLANE_VERSION_HEADER);
		if (!controlPlaneVersion || controlPlaneVersion === CLIENT_VERSION || versionWarned) return;
		versionWarned = true;
		config.onVersionMismatch({
			clientVersion: CLIENT_VERSION,
			controlPlaneVersion,
			message: `警告：sfly API 客户端（${CLIENT_VERSION}）与控制面（${controlPlaneVersion}）版本不一致，接口可能对不上。请从控制面重新安装 API 客户端。`,
		});
	};

	const url = (route: RouteRef, input: RouteInput | undefined) =>
		`${baseUrl}${requestPath(route, input)}`;

	const send = async (route: RouteRef, input: RouteInput | undefined, init: SendInit) => {
		const path = requestPath(route, input);
		const headers = headersFor(route, input, init);
		let res: ResponseLike;
		try {
			res = await config.fetch(`${baseUrl}${path}`, {
				method: route.method,
				headers,
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

	return { send, url };
}

function normalizeBaseUrl(baseUrl: string): string {
	if (baseUrl === "" || !/^(https?:\/\/[^/?#]+)?(\/[^?#]*)?$/.test(baseUrl)) {
		throw new TypeError(`baseUrl 要是 http(s) 地址或以 / 开头的路径：${baseUrl}`);
	}
	return baseUrl.replace(/\/+$/, "");
}
