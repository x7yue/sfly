import { feishuBotsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
	type FeishuBots,
	testMessage,
	toFeishuBotView,
	toTestResult,
} from "../feishu/feishu-bots.js";
import type { FeishuClient } from "../feishu/feishu-client.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";
import { requireNickname } from "./nickname.js";

const notFound = (reply: FastifyReply, name: string) =>
	sendError(reply, 404, "not_found", `飞书机器人「${name}」不存在`);

/**
 * 飞书机器人 API（契约见 @sfly/schema 的 feishuBotsApi，ADR 0020）：登记、列表、替换 Webhook 地址、删除，
 * 以及直接同步发一条测试消息。写操作都需要昵称。接口返回的 Webhook 地址一律是打码后的。
 */
export function registerFeishuBotRoutes(
	app: FastifyInstance,
	{ bots, client }: { bots: FeishuBots; client: FeishuClient },
): void {
	contractRoute(app, feishuBotsApi.list, async () => ({
		bots: (await bots.list()).map(toFeishuBotView),
	}));

	contractRoute(app, feishuBotsApi.create, async ({ body }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		const result = await bots.create(body.name, body.webhook_url);
		if (result.kind === "name_taken") {
			return sendError(reply, 409, "name_taken", `飞书机器人「${body.name}」已存在，名称不能重复`);
		}
		return reply.code(201).send(toFeishuBotView(result.bot));
	});

	contractRoute(app, feishuBotsApi.replaceWebhook, async ({ params, body }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		const bot = await bots.replaceWebhookUrl(params.name, body.webhook_url);
		return bot ? toFeishuBotView(bot) : notFound(reply, params.name);
	});

	contractRoute(app, feishuBotsApi.remove, async ({ params }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		if (!(await bots.remove(params.name))) return notFound(reply, params.name);
		return reply.code(204).send();
	});

	contractRoute(app, feishuBotsApi.test, async ({ params }, reply, raw) => {
		if (!requireNickname(raw, reply)) return reply;
		const bot = await bots.get(params.name);
		if (!bot) return notFound(reply, params.name);
		return toTestResult(await client.send(bot.webhookUrl, testMessage(bot.name)));
	});
}
