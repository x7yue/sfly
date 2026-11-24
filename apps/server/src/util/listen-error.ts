// 监听失败的错误（#651 的审查）：说明只写变量名、端口和错误码，不带监听地址、不带底层错误的原文。
//
// 监听地址的检查（config/host-setting.ts）认的是「IP 地址或主机名」的形状，这个形状里仍然装得下任意内容：任何一串字母数字都像主机名，
// IPv6 的区域标识后面可以跟任意的字母数字。把一个令牌误填进监听地址，监听失败时 Node 的报错（`getaddrinfo ENOTFOUND <值>`、
// `listen EADDRNOTAVAIL … <值>`，错误对象的 `hostname`、`address` 属性）会把它原样带出来，进启动输出和容器日志。所以监听的两处
// （HTTP、Agent 网关）各包一层，监听不了时只留错误码（`EADDRINUSE`、`EADDRNOTAVAIL`、`ENOTFOUND`、`EACCES`……）。
// 回显的规矩见 config/echo.ts：认得的形状里装得下任意内容的，不回显。

export type ListenTarget = "http" | "grpc";

const TARGETS: Record<ListenTarget, { what: string; host: string; port: string }> = {
	http: { what: "HTTP API", host: "SFLY_HTTP_HOST", port: "SFLY_HTTP_PORT" },
	grpc: { what: "Agent 网关", host: "SFLY_GRPC_HOST", port: "SFLY_GRPC_PORT" },
};

/** 一句怎么办，按错误码说。 */
function advice(code: string | undefined, target: ListenTarget): string {
	const { host, port } = TARGETS[target];
	switch (code) {
		case "EADDRINUSE":
			return `这个端口已经被别的进程占用了：换一个端口（${port}），或者停掉占用它的进程`;
		case "EADDRNOTAVAIL":
			return `这台机器上没有这个地址：${host} 写本机有的地址（0.0.0.0 是监听所有网卡）`;
		case "ENOTFOUND":
		case "EAI_AGAIN":
		case "EAI_NONAME":
			return `这个主机名解析不了：${host} 写 IP 地址，或者能解析的主机名`;
		case "EACCES":
			return `没有权限监听这个端口（小于 1024 的端口要特权）：换一个大的端口（${port}）`;
		default:
			return `看错误码，检查 ${host} 和 ${port}`;
	}
}

/** 监听失败：`message` 只有变量名、端口、错误码和一句怎么办（不含监听地址），`code` 是系统的错误码（没有时为 undefined）。 */
export class ListenError extends Error {
	constructor(
		readonly target: ListenTarget,
		readonly port: number,
		readonly code: string | undefined,
	) {
		const { what, host, port: portName } = TARGETS[target];
		super(
			`${what}监听失败（地址在 ${host}、端口 ${portName}，端口 ${port}；错误码 ${code ?? "未知"}）：${advice(code, target)}`,
		);
		this.name = "ListenError";
	}
}

/** 错误码：只认系统错误码的样子（大写字母、数字、下划线），别的（任意文字）不留。 */
const codeOf = (error: unknown): string | undefined => {
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : undefined;
};

/** 做 `listen`：失败时换成 {@link ListenError}（不带地址、不带底层错误的原文）。 */
export async function listening<T>(
	target: ListenTarget,
	port: number,
	listen: () => Promise<T>,
): Promise<T> {
	try {
		return await listen();
	} catch (error) {
		throw new ListenError(target, port, codeOf(error));
	}
}
