import type { EndpointDef, EndpointRequest, EndpointResponse } from "@sfly/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { sendError } from "./errors.js";

/**
 * 按 @sfly/schema 的契约注册路由（ADR 0007，约定见 packages/schema/src/http/contract.ts）：
 * 先用契约校验路径参数、查询参数与请求体（失败返回 400 `invalid_request`，details 为 zod issues，
 * path 以 params / query / body 开头），handler 拿到解析后的值；handler 的返回值在类型上受响应
 * schema 约束（运行时不再解析，响应与契约一致由测试用契约解析来保证）。
 * handler 也可以直接返回 `reply`（例如 sendError 的结果、201 状态码）。
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
	app.route({
		method: def.method,
		url: def.path,
		handler: async (req, reply) => {
			const issues: z.core.$ZodIssue[] = [];
			const parsePart = (part: "params" | "query" | "body", value: unknown) => {
				const schema = def[part];
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
			} as EndpointRequest<E>;
			if (issues.length > 0) {
				const summary = issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；");
				return sendError(reply, 400, "invalid_request", `请求不符合接口契约：${summary}`, issues);
			}
			return handler(request, reply, req);
		},
	});
}
