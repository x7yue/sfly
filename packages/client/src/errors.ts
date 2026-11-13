/**
 * 客户端自己给出的错误码；其余错误码来自控制面的 `{ error: { code } }`。
 *
 * - `network_error`：没有收到响应（控制面不可达、连接被断开、浏览器拦下跨域请求），status 为 0。
 * - `http_error`：错误响应不是控制面的错误格式（例如代理返回的页面），details 是响应体。
 * - `invalid_response`：成功响应的格式不对（JSON 接口的不是 JSON，事件流的不是 `text/event-stream`）。
 */
export type ClientErrorCode = "network_error" | "http_error" | "invalid_response";

export interface ApiErrorInit {
	/** HTTP 状态；没有收到响应时为 0。 */
	status: number;
	code: ClientErrorCode | (string & {});
	message: string;
	details?: unknown;
	method: string;
	/** 相对控制面地址的请求路径，含查询参数。 */
	path: string;
	cause?: unknown;
}

/** 调用失败时抛出的唯一错误类型。构造函数公开：上层可以抛出同一种错误。 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: ClientErrorCode | (string & {});
	readonly details: unknown;
	readonly method: string;
	readonly path: string;

	constructor(init: ApiErrorInit) {
		super(init.message, { cause: init.cause });
		this.name = "ApiError";
		this.status = init.status;
		this.code = init.code;
		this.details = init.details;
		this.method = init.method;
		this.path = init.path;
	}
}

const isErrorBody = (
	body: unknown,
): body is { error: { code: string; message: string; details?: unknown } } => {
	const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
	return typeof error?.code === "string" && typeof error.message === "string";
};

export async function errorFromResponse(
	res: { status: number; text(): Promise<string> },
	method: string,
	path: string,
): Promise<ApiError> {
	const text = await res.text().catch(() => "");
	let body: unknown = text === "" ? undefined : text;
	try {
		body = JSON.parse(text);
	} catch {}
	if (isErrorBody(body)) {
		const { code, message, details } = body.error;
		return new ApiError({ status: res.status, code, message, details, method, path });
	}
	return new ApiError({
		status: res.status,
		code: "http_error",
		message: `HTTP ${res.status}`,
		details: body,
		method,
		path,
	});
}
