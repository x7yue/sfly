import type { FastifyReply } from "fastify";

/** 统一的错误响应：`{ error: { code, message, details? } }`。 */
export function sendError(
	reply: FastifyReply,
	status: number,
	code: string,
	message: string,
	details?: unknown,
): FastifyReply {
	return reply
		.code(status)
		.send({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}
