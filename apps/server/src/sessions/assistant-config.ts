import { ASSISTANT_SECRET_ENV, ASSISTANT_SECRET_MIN_LENGTH } from "@sfly/schema";

/** 助手服务的地址和共享密钥，都配好了。 */
export interface AssistantConfig {
	/** 助手服务的地址（http 或 https，路径部分不用）。 */
	url: URL;
	/** 和助手服务共用的密钥：每个发给助手服务的请求带它，不出现在任何事件和日志里。 */
	secret: string;
}

export const ASSISTANT_URL_ENV = "SFLY_ASSISTANT_URL";

/** 助手有没有配置：配好了带配置，没配好带原因（写进日志和就绪状态）。 */
export type AssistantSetup =
	| { configured: true; config: AssistantConfig }
	| { configured: false; reason: string };

/**
 * 从两个环境变量的值得出助手有没有配置（`SFLY_ASSISTANT_URL`、`SFLY_ASSISTANT_SECRET`）。助手默认关闭：
 * 没配地址或密钥就是「没有配置」；共享密钥短于 {@link ASSISTANT_SECRET_MIN_LENGTH} 个字符也当作没有配置
 * （工作台上的模型在网络上可能连得到助手服务的端口，密钥不能太短），原因写明，不静默地关着。
 */
export function assistantSetup(options: { url?: string; secret?: string }): AssistantSetup {
	const url = options.url?.trim();
	const secret = options.secret ?? "";
	if (!url && secret === "") {
		return {
			configured: false,
			reason: `没有配置 ${ASSISTANT_URL_ENV} 和 ${ASSISTANT_SECRET_ENV}`,
		};
	}
	if (!url) return { configured: false, reason: `没有配置 ${ASSISTANT_URL_ENV}` };
	if (secret === "") return { configured: false, reason: `没有配置 ${ASSISTANT_SECRET_ENV}` };
	if ([...secret].length < ASSISTANT_SECRET_MIN_LENGTH) {
		return {
			configured: false,
			reason: `${ASSISTANT_SECRET_ENV} 短于 ${ASSISTANT_SECRET_MIN_LENGTH} 个字符：共享密钥要足够长，工作台上的模型在网络上可能连得到助手服务的端口`,
		};
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// 原因会进就绪状态和写接口的 503（所有能读的人都看得到）：不回显配置的地址（可能带着用户名和密码），只说是哪一类问题。
		return { configured: false, reason: `${ASSISTANT_URL_ENV} 不是一个合法的地址` };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { configured: false, reason: `${ASSISTANT_URL_ENV} 要写 http 或 https 地址` };
	}
	if (parsed.username !== "" || parsed.password !== "") {
		// 地址里带用户名和密码：fetch 不让请求带它，每个请求都会失败，出错的原文还会把这段地址带进日志；共享密钥有自己的变量。
		return {
			configured: false,
			reason: `${ASSISTANT_URL_ENV} 不能带用户名和密码（共享密钥写在 ${ASSISTANT_SECRET_ENV} 里）`,
		};
	}
	return { configured: true, config: { url: parsed, secret } };
}
