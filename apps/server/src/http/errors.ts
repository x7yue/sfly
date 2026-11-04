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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 路径参数里的 ID 都是 UUID；格式不对的直接当作不存在。 */
export const isUuid = (value: string): boolean => UUID.test(value);
