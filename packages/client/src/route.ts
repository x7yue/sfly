export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * 调用一个接口需要知道的：生成的路由表和契约里的 zod 定义（控制台用）都是这个形状。
 * 没有 `kind` 的是 JSON 接口。
 */
export interface RouteRef {
	readonly method: HttpMethod;
	/** 路径模板：`:name` 是路径参数，末尾的 `*` 匹配剩余路径（参数名为 `*`）。不含 `/api` 前缀。 */
	readonly path: string;
	readonly kind?: "endpoint" | "stream" | "download";
	/** 下载成功时响应的 content-type，作为请求的 accept。 */
	readonly contentType?: string;
}

/** 契约里的请求：路径参数、查询参数和 JSON 请求体。 */
export interface RouteInput {
	readonly params?: Readonly<Record<string, string | number>>;
	/** 值为 `undefined` 或 `null` 的不发送，其余按 `String(value)` 发送。 */
	readonly query?: Readonly<Record<string, unknown>>;
	/** `undefined` 表示没有请求体，也不带 content-type。 */
	readonly body?: unknown;
}

export interface CallOptions {
	/** 中止后调用以中止的原因失败，不是 ApiError。 */
	signal?: AbortSignal;
	/** 页面关闭时请求仍然发出。 */
	keepalive?: boolean;
}

export interface Endpoint<I, O> {
	kind: "endpoint";
	input: I;
	output: O;
}

export interface Download<I> {
	kind: "download";
	input: I;
}

type KindOf<R> = R extends { kind: infer K extends NonNullable<RouteRef["kind"]> } ? K : never;

export type RouteTable<A> = {
	readonly [D in keyof A]: {
		readonly [N in keyof A[D]]: RouteRef & { readonly kind: KindOf<A[D][N]> };
	};
};

type Args<I> = Partial<I> extends I ? [input?: I] : [input: I];

export type Method<R> =
	R extends Endpoint<infer I, infer O>
		? (...args: [...Args<I>, options?: CallOptions]) => Promise<O>
		: R extends Download<infer I>
			? (...args: Args<I>) => string
			: never;

export type Methods<A> = {
	readonly [D in keyof A]: { readonly [N in keyof A[D]]: Method<A[D][N]> };
};

function fillPath(route: RouteRef, params: RouteInput["params"]): string {
	const value = (name: string) => {
		const v = params?.[name];
		if (v === undefined) throw new TypeError(`缺少路径参数 ${name}（${route.path}）`);
		return String(v);
	};
	return route.path
		.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => encodeURIComponent(value(name)))
		.replace(/\*$/, () => value("*").split("/").map(encodeURIComponent).join("/"));
}

function searchOf(query: RouteInput["query"]): string {
	const entries = Object.entries(query ?? {})
		.filter(([, v]) => v !== undefined && v !== null)
		.map(([k, v]) => [k, String(v)]);
	return entries.length === 0 ? "" : `?${new URLSearchParams(entries)}`;
}

export const requestPath = (route: RouteRef, input: RouteInput | undefined): string =>
	`${fillPath(route, input?.params)}${searchOf(input?.query)}`;
