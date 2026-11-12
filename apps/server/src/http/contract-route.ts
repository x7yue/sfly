import type {
	DownloadDef,
	EndpointDef,
	EndpointRequest,
	EndpointResponse,
	RouteDef,
	StreamDef,
	StreamEvents,
} from "@sfly/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Sse } from "../sse/sse.js";
import { sendError } from "./errors.js";

/**
 * 按 @sfly/schema 的契约注册路由（ADR 0007，约定见 packages/schema/src/http/contract.ts）：
 * 先用契约校验路径参数、查询参数与请求体（失败返回 400，默认错误码 `invalid_request`，契约可以用
 * `requestError` 换成更具体的错误码；details 为 zod issues，path 以 params / query / body 开头），
 * handler 拿到解析后的值。
 *
 * NUL（`\u0000`）存不进 PostgreSQL 的文本，数据库会直接报错，所以在进 handler 之前统一拦下：
 * 路径参数含 NUL，说明这个标识不指向任何东西，返回 404 `not_found`；查询参数与 JSON 请求体
 * （递归遍历普通对象和数组，上传的字节流不检查）里含 NUL 的字符串，返回 400 `invalid_request`。
 *
 * - {@link contractRoute}：JSON 接口，handler 的返回值在类型上受响应 schema 约束（运行时不再解析，
 *   响应与契约一致由测试用契约解析来保证）；也可以直接返回 `reply`（sendError 的结果、201 状态码）。
 * - {@link contractStream}：SSE，`open` 打开的流只能发送契约里声明的事件。
 * - {@link contractDownload}：返回字节流的下载。
 *
 * {@link guardHttpContract} 保证控制面注册的路由与契约一一对应（启动时检查）。
 *
 *   contractRoute(app, packagesApi.get, async ({ params }, reply) =>
 *     (await packages.get(params.name)) ?? sendError(reply, 404, "not_found", "..."));
 */
export function contractRoute<E extends EndpointDef>(
	app: FastifyInstance,
	def: E,
	handler: (
		request: EndpointRequest<E>,
		reply: FastifyReply,
		raw: FastifyRequest,
	) => Promise<z.input<E["response"]> | EndpointResponse<E> | FastifyReply>,
): void {
	register(app, def, handler);
}

/** SSE 流上的类型化发送：事件名与 data 都受契约约束。 */
export interface ContractStream<S extends StreamDef> {
	send<K extends keyof StreamEvents<S> & string>(
		event: K,
		data: z.input<S["events"][K]>,
		id?: string | number,
	): void;
	/** 由服务端结束这条流。 */
	close(): void;
	readonly closed: boolean;
	/** 浏览器重连时带上的最后一条消息 ID（`Last-Event-ID` 请求头）。 */
	readonly lastEventId: string | undefined;
}

/**
 * SSE 路由：校验请求后由 handler 决定是否 `open`（例如先确认运行存在，否则 sendError 返回 404）。
 * setup 的约定与 Sse#open 相同：订阅数据源，返回的清理函数在流结束时调用。
 */
export function contractStream<S extends StreamDef>(
	app: FastifyInstance,
	sse: Sse,
	def: S,
	handler: (
		request: EndpointRequest<S>,
		open: (setup: (stream: ContractStream<S>) => (() => void) | undefined) => void,
		reply: FastifyReply,
		raw: FastifyRequest,
	) => Promise<FastifyReply | undefined>,
): void {
	register(app, def, (request, reply, raw) =>
		handler(
			request,
			(setup) =>
				sse.open(raw, reply, (stream) =>
					setup({
						send: (event, data, id) => stream.send({ event, data, id }),
						close: () => stream.close(),
						get closed() {
							return stream.closed;
						},
						get lastEventId() {
							return stream.lastEventId;
						},
					}),
				),
			reply,
			raw,
		),
	);
}

/** 下载路由：handler 用 reply 发送字节流（或 sendError）。 */
export function contractDownload<D extends DownloadDef>(
	app: FastifyInstance,
	def: D,
	handler: (
		request: EndpointRequest<D>,
		reply: FastifyReply,
		raw: FastifyRequest,
	) => Promise<FastifyReply>,
): void {
	register(app, def, handler);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	// Fastify 的 params / query 是原型为 null 或 Empty 的字典（普通对象的原型也满足：它的原型是 null）。
	return proto === null || Object.getPrototypeOf(proto) === null;
}

function hasNul(value: unknown): boolean {
	if (typeof value === "string") return value.includes("\u0000");
	if (Array.isArray(value)) return value.some(hasNul);
	return isPlainObject(value) && Object.values(value).some(hasNul);
}

function register<D extends RouteDef>(
	app: FastifyInstance,
	def: D,
	handler: (request: EndpointRequest<D>, reply: FastifyReply, raw: FastifyRequest) => unknown,
): void {
	app.route({
		method: def.method,
		url: def.path,
		handler: async (req, reply) => {
			if (hasNul(req.params)) {
				return sendError(reply, 404, "not_found", "路径参数含 NUL 字符，没有对应的资源");
			}
			if (hasNul(req.query) || hasNul(req.body)) {
				return sendError(reply, 400, "invalid_request", "请求里的字符串不能含 NUL 字符（\\u0000）");
			}
			const issues: z.core.$ZodIssue[] = [];
			const parsePart = (part: "params" | "query" | "body", value: unknown) => {
				const schema = (def as { [K in typeof part]?: z.ZodType })[part];
				if (!schema) return undefined;
				const parsed = schema.safeParse(value);
				if (parsed.success) return parsed.data;
				issues.push(...parsed.error.issues.map((i) => ({ ...i, path: [part, ...i.path] })));
				return undefined;
			};
			const request = {
				params: parsePart("params", req.params),
				query: parsePart("query", req.query),
				body: parsePart("body", req.body),
			} as EndpointRequest<D>;
			if (issues.length > 0) {
				const specific = def.requestError?.({
					params: req.params,
					query: req.query,
					body: req.body,
				});
				const summary = issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；");
				return sendError(
					reply,
					400,
					specific?.code ?? "invalid_request",
					specific?.message ?? `请求不符合接口契约：${summary}`,
					issues,
				);
			}
			return handler(request, reply, req);
		},
	});
}

const routeKey = (method: string, path: string) => `${method} ${path}`;

/**
 * 控制面注册的路由与契约一一对应（约定 7）：注册不在契约里的路由立即抛错；
 * 契约里有、却没有注册的接口在 `ready()`（listen 之前）时报错。必须在注册任何路由之前调用。
 * Fastify 为 GET 自动生成的 HEAD 路由不计入。
 */
export function guardHttpContract(app: FastifyInstance, contract: readonly RouteDef[]): void {
	const expected = new Set(contract.map((def) => routeKey(def.method, def.path)));
	const registered = new Set<string>();
	app.addHook("onRoute", (route) => {
		for (const method of [route.method].flat()) {
			if (method === "HEAD") continue;
			const key = routeKey(method, route.url);
			if (!expected.has(key)) {
				throw new Error(`路由 ${key} 不在 HTTP 契约里（packages/schema/src/http）`);
			}
			registered.add(key);
		}
	});
	app.addHook("onReady", async () => {
		const missing = [...expected].filter((key) => !registered.has(key));
		if (missing.length > 0) {
			throw new Error(`HTTP 契约里的接口没有注册路由：${missing.join("、")}`);
		}
	});
}
