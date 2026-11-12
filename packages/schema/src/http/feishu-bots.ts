import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 飞书机器人（GLOSSARY、ADR 0020）相关接口的契约（约定见 ./contract.ts）。
 *
 * 每个机器人有名称和 Webhook 地址：名称全局唯一、创建后不能修改；Webhook 地址相当于一个凭据，
 * 只存在控制面的数据库里，接口返回的一律是打码后的形式（只露出开头和结尾），修改时只能整个替换。
 */

/** 机器人名称的长度上限（字符数）。 */
export const FEISHU_BOT_NAME_MAX = 64;
/** Webhook 地址的长度上限（字符数）。 */
export const WEBHOOK_URL_MAX = 2048;

const HttpUrl = z.url({ protocol: /^https?$/ });

/** 是不是 http 或 https 地址（带主机）。 */
export const isHttpUrl = (value: string): boolean => HttpUrl.safeParse(value).success;

/** 机器人名称：去掉首尾空白后 1 到 {@link FEISHU_BOT_NAME_MAX} 个字符。 */
export const FeishuBotName = z
	.string()
	.trim()
	.min(1, "名称不能为空")
	.max(FEISHU_BOT_NAME_MAX, `名称不能超过 ${FEISHU_BOT_NAME_MAX} 个字符`);

/** Webhook 地址：必须是 http 或 https 地址，不含空白字符。 */
export const FeishuWebhookUrl = z
	.string()
	.trim()
	.min(1, "Webhook 地址不能为空")
	.max(WEBHOOK_URL_MAX, `Webhook 地址不能超过 ${WEBHOOK_URL_MAX} 个字符`)
	.refine((value) => !/\s/.test(value), "Webhook 地址不能含空白字符")
	.refine(isHttpUrl, "Webhook 地址必须是 http 或 https 地址");

export const FeishuBotView = z.object({
	name: z.string(),
	/** 打码后的 Webhook 地址：只露出开头和结尾。完整地址不通过任何接口返回。 */
	webhook_url: z.string(),
	created_at: Timestamp,
});

/** 「发送测试消息」的结果；失败也是 200，结果在 `ok` 里。 */
export const FeishuTestResult = z.object({
	ok: z.boolean(),
	/** 一句话说明结果：成功是「测试消息已送达」，失败是中文原因（Webhook 地址已打码）。 */
	message: z.string(),
	/** 失败时的下一步（中文）；成功时为 null。 */
	next_step: z.string().nullable(),
	/** 飞书返回的错误码；成功，或者没有收到飞书的响应（网络错误、超时）时为 null。 */
	feishu_code: z.number().int().nullable(),
	/** 收到响应时的 HTTP 状态码；网络错误和超时为 null。 */
	http_status: z.number().int().nullable(),
});

const NameParams = z.object({ name: z.string().min(1) });

export const feishuBotsApi = {
	/** 全部飞书机器人，按名称排序。 */
	list: endpoint({
		method: "GET",
		path: "/feishu-bots",
		key: ["feishu-bots", "list"],
		response: z.object({ bots: z.array(FeishuBotView) }),
	}),
	/**
	 * 登记一个飞书机器人（201，需要昵称请求头）。名称已被占用 409 `name_taken`。
	 */
	create: endpoint({
		method: "POST",
		path: "/feishu-bots",
		key: ["feishu-bots", "create"],
		body: z.object({ name: FeishuBotName, webhook_url: FeishuWebhookUrl }),
		response: FeishuBotView,
	}),
	/**
	 * 替换 Webhook 地址（需要昵称请求头）。名称创建后不能修改：请求里带 `name` 返回 400 `name_immutable`。
	 * 机器人不存在 404 `not_found`。
	 */
	replaceWebhook: endpoint({
		method: "PATCH",
		path: "/feishu-bots/:name",
		key: ["feishu-bots", "replace-webhook"],
		params: NameParams,
		body: z.strictObject({ webhook_url: FeishuWebhookUrl }),
		requestError: ({ body }) =>
			typeof body === "object" && body !== null && "name" in body
				? {
						code: "name_immutable",
						message: "飞书机器人的名称创建后不能修改；要换名称，请新建一个机器人再删除旧的",
					}
				: undefined,
		response: FeishuBotView,
	}),
	/** 删除（204，需要昵称请求头）。机器人不存在 404 `not_found`。 */
	remove: endpoint({
		method: "DELETE",
		path: "/feishu-bots/:name",
		key: ["feishu-bots", "remove"],
		params: NameParams,
		response: z.undefined(),
	}),
	/**
	 * 发送测试消息：不经过发送队列，直接同步向 Webhook 地址发一条固定文本（单次超时 10 秒），
	 * 把飞书的结果翻译成中文返回。机器人不存在 404 `not_found`。
	 */
	test: endpoint({
		method: "POST",
		path: "/feishu-bots/:name/test",
		key: ["feishu-bots", "test"],
		params: NameParams,
		response: FeishuTestResult,
	}),
};

export type FeishuBotView = z.infer<typeof FeishuBotView>;
export type FeishuTestResult = z.infer<typeof FeishuTestResult>;
