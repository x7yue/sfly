// 切入点 A：飞书机器人的登记和测试消息（#228，ADR 0020）。真实控制面 + 假飞书 Webhook 服务（support/fake-feishu.ts）。
import { type FeishuBotView, feishuBotsApi, NICKNAME_HEADER } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECRET = "tok-4f9a8c71-e2b0-43d6-9a55-0a1b2c3d4e5f";

describe("飞书机器人的登记和测试消息", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let feishu: FakeFeishu;
	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		feishu = await startFakeFeishu();
	});
	afterEach(async () => {
		await feishu.close();
		await cp.close();
	});

	const botUrl = (name: string) => `/feishu-bots/${encodeURIComponent(name)}`;
	const list = async () =>
		feishuBotsApi.list.response.parse(await api.getJson("/feishu-bots")).bots;
	const patch = (name: string, body: unknown, nickname = "tester") =>
		cp.fetch(botUrl(name), {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				[NICKNAME_HEADER]: encodeURIComponent(nickname),
			},
			body: JSON.stringify(body),
		});
	const remove = (name: string, nickname = "tester") =>
		cp.fetch(botUrl(name), {
			method: "DELETE",
			headers: { [NICKNAME_HEADER]: encodeURIComponent(nickname) },
		});
	const test = (name: string) => api.postEmpty(`${botUrl(name)}/test`);
	const testResult = async (name: string) => {
		const res = await test(name);
		expect(res.status, await res.clone().text()).toBe(200);
		return feishuBotsApi.test.response.parse(await res.json());
	};

	describe("登记、查看、替换地址、删除", () => {
		it("新增后在列表里按名称排序；名称与创建时间原样返回", async () => {
			await api.createFeishuBot("bot-b", feishu.webhookUrl("b"));
			await api.createFeishuBot("bot-a", feishu.webhookUrl("a"));

			const bots = await list();
			expect(bots.map((b) => b.name)).toEqual(["bot-a", "bot-b"]);
			expect(bots[0]?.created_at).toBe("2026-01-01T00:00:00.000Z");
		});

		it("名称去掉首尾空白后保存", async () => {
			const bot = await api.createFeishuBot("  压测群 ", feishu.webhookUrl());
			expect(bot.name).toBe("压测群");
			expect((await list()).map((b) => b.name)).toEqual(["压测群"]);
		});

		it("名称重复时拒绝，409 name_taken，错误信息是中文", async () => {
			await api.createFeishuBot("压测群", feishu.webhookUrl("a"));
			const res = await api.post("/feishu-bots", {
				name: "压测群",
				webhook_url: feishu.webhookUrl("b"),
			});
			expect(res.status).toBe(409);
			const { error } = (await res.json()) as { error: { code: string; message: string } };
			expect(error.code).toBe("name_taken");
			expect(error.message).toBe("飞书机器人「压测群」已存在，名称不能重复");
			expect(await list()).toHaveLength(1);
		});

		it("同时登记同一个名称：只有一个成功", async () => {
			const results = await Promise.all(
				[1, 2, 3].map((i) =>
					api.post("/feishu-bots", { name: "压测群", webhook_url: feishu.webhookUrl(`t${i}`) }),
				),
			);
			expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
		});

		it("名称或 Webhook 地址不合法时 400，信息是中文", async () => {
			const bad = async (body: unknown) => {
				const res = await api.post("/feishu-bots", body);
				expect(res.status, JSON.stringify(body)).toBe(400);
				const { error } = (await res.json()) as { error: { code: string; message: string } };
				expect(error.code).toBe("invalid_request");
				return error.message;
			};
			const url = feishu.webhookUrl();
			expect(await bad({ name: "", webhook_url: url })).toContain("名称不能为空");
			expect(await bad({ name: "   ", webhook_url: url })).toContain("名称不能为空");
			expect(await bad({ name: "x".repeat(65), webhook_url: url })).toContain("不能超过 64 个字符");
			for (const webhook of [
				"",
				"不是地址",
				"ftp://example.com/hook/1",
				"feishu://hook/1",
				"http://",
				"https://open.feishu.cn/hook/a b",
			]) {
				expect(await bad({ name: "群", webhook_url: webhook }), webhook).toContain("Webhook 地址");
			}
			expect(await bad({ name: "群" })).toContain("webhook_url");
			expect(await list()).toEqual([]);
		});

		it("http 和 https 地址都可以登记", async () => {
			await api.createFeishuBot("a", "http://feishu.internal/open-apis/bot/v2/hook/1");
			await api.createFeishuBot("b", "https://open.feishu.cn/open-apis/bot/v2/hook/2");
			expect((await list()).map((b) => b.name)).toEqual(["a", "b"]);
		});

		it("所有写操作都需要昵称", async () => {
			await api.createFeishuBot("群", feishu.webhookUrl());
			const noNickname = (method: string, path: string, body?: unknown) =>
				cp.fetch(path, {
					method,
					headers: body === undefined ? {} : { "content-type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			for (const res of [
				await noNickname("POST", "/feishu-bots", { name: "新", webhook_url: feishu.webhookUrl() }),
				await noNickname("PATCH", botUrl("群"), { webhook_url: feishu.webhookUrl("n") }),
				await noNickname("DELETE", botUrl("群")),
				await noNickname("POST", `${botUrl("群")}/test`),
			]) {
				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({ error: { code: "nickname_required" } });
			}
			expect(feishu.requests).toEqual([]);
			expect((await list()).map((b) => b.name)).toEqual(["群"]);
		});

		it("替换 Webhook 地址：之后的测试消息发往新地址；名称不变", async () => {
			const before = await api.createFeishuBot("压测群", feishu.webhookUrl("old"));
			const res = await patch("压测群", { webhook_url: feishu.webhookUrl("new") });
			expect(res.status).toBe(200);
			const after = feishuBotsApi.replaceWebhook.response.parse(await res.json());
			expect(after.name).toBe("压测群");
			expect(after.created_at).toBe(before.created_at);
			expect(after.webhook_url).not.toBe(before.webhook_url);

			expect((await testResult("压测群")).ok).toBe(true);
			expect(feishu.requests.map((r) => r.path)).toEqual(["/open-apis/bot/v2/hook/new"]);
		});

		it("名称创建后不能修改：请求里带 name 返回 400 name_immutable", async () => {
			await api.createFeishuBot("压测群", feishu.webhookUrl("old"));
			const res = await patch("压测群", { name: "新名字", webhook_url: feishu.webhookUrl("new") });
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: {
					code: "name_immutable",
					message: "飞书机器人的名称创建后不能修改；要换名称，请新建一个机器人再删除旧的",
				},
			});
			expect((await list()).map((b) => b.name)).toEqual(["压测群"]);
			expect((await testResult("压测群")).ok).toBe(true);
			expect(feishu.requests.map((r) => r.path)).toEqual(["/open-apis/bot/v2/hook/old"]);
		});

		it("替换时地址不合法返回 400；机器人不存在返回 404", async () => {
			await api.createFeishuBot("压测群", feishu.webhookUrl());
			const invalid = await patch("压测群", { webhook_url: "ftp://x/y" });
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
			const missing = await patch("不存在", { webhook_url: feishu.webhookUrl() });
			expect(missing.status).toBe(404);
			expect(await missing.json()).toMatchObject({
				error: { code: "not_found", message: "飞书机器人「不存在」不存在" },
			});
		});

		it("删除后不再出现在列表里，可以用同一个名称重新登记；不存在时 404", async () => {
			await api.createFeishuBot("压测群", feishu.webhookUrl("a"));
			const deleted = await remove("压测群");
			expect(deleted.status).toBe(204);
			expect(await list()).toEqual([]);
			expect((await remove("压测群")).status).toBe(404);
			expect((await test("压测群")).status).toBe(404);

			await api.createFeishuBot("压测群", feishu.webhookUrl("b"));
			expect((await list()).map((b) => b.name)).toEqual(["压测群"]);
		});

		it("名称里有空格、斜杠和中文也能按名称操作", async () => {
			const name = "压测 群/A 环境?";
			await api.createFeishuBot(name, feishu.webhookUrl());
			expect((await testResult(name)).ok).toBe(true);
			expect((await remove(name)).status).toBe(204);
		});
	});

	describe("Webhook 地址只以打码的形式出现", () => {
		const url = () => feishu.webhookUrl(SECRET);
		const everyResponse = async () => {
			const responses: string[] = [];
			const text = async (res: Response) => {
				const body = await res.text();
				responses.push(body);
				return body;
			};
			await text(await cp.fetch("/feishu-bots"));
			await text(await patch("群", { webhook_url: url() }));
			await text(await test("群"));
			return responses;
		};

		it("新增、列表、替换的返回里只有开头和结尾，没有完整地址和令牌", async () => {
			const created = await api.post("/feishu-bots", { name: "群", webhook_url: url() });
			const createdBody = await created.text();
			const bots = await list();
			const masked = bots[0]?.webhook_url ?? "";
			expect(masked).toMatch(/^http:\/\/127\.0.*4e5f$/);
			expect(masked.length).toBeLessThan(url().length / 2);
			for (const body of [createdBody, ...(await everyResponse())]) {
				expect(body).not.toContain(SECRET);
				expect(body).not.toContain(url());
				expect(body).not.toContain("bot/v2/hook");
			}
		});

		it("同一个地址总是打成同样的样子；不同地址打成不同的样子", async () => {
			const a = await api.createFeishuBot("a", url());
			const b = await api.createFeishuBot("b", url());
			const c = await api.createFeishuBot("c", feishu.webhookUrl("another-token-9999"));
			expect(a.webhook_url).toBe(b.webhook_url);
			expect(c.webhook_url).not.toBe(a.webhook_url);
		});

		it("编辑时看不到原值：只有打码的地址，替换的接口不回显", async () => {
			await api.createFeishuBot("群", url());
			const res = await patch("群", { webhook_url: feishu.webhookUrl("replaced-token-1234") });
			const body = (await res.json()) as FeishuBotView;
			expect(JSON.stringify(body)).not.toContain("replaced-token");
			expect(JSON.stringify(body)).not.toContain(SECRET);
		});

		it("飞书的错误信息里带着完整地址时，返回的错误信息里也是打码的", async () => {
			await api.createFeishuBot("群", url());
			feishu.reply({ code: 12345, msg: `invalid hook ${url()}` });
			const result = await testResult("群");
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain(SECRET);
			expect(JSON.stringify(result)).not.toContain("bot/v2/hook");
		});
	});

	describe("发送测试消息", () => {
		const registerBot = (name = "压测群", token = "t1") =>
			api.createFeishuBot(name, feishu.webhookUrl(token));

		it("把一条固定文本直接发到 Webhook 地址里的主机，结果立即返回", async () => {
			await registerBot("压测群", "t1");
			const result = await testResult("压测群");
			expect(result).toEqual({
				ok: true,
				message: "测试消息已送达",
				next_step: null,
				feishu_code: null,
				http_status: 200,
			});
			expect(feishu.requests).toHaveLength(1);
			const request = feishu.requests[0];
			expect(request?.method).toBe("POST");
			expect(request?.path).toBe("/open-apis/bot/v2/hook/t1");
			expect(request?.headers["content-type"]).toMatch(/^application\/json/);
			expect(request?.json).toEqual({
				msg_type: "text",
				content: { text: "sfly 测试消息：飞书机器人「压测群」已连通，这条消息由控制面发出。" },
			});
		});

		it("不经过发送队列：只发一次，失败也不重试", async () => {
			await registerBot();
			feishu.replyAlways({ status: 500, body: "boom" });
			const result = await testResult("压测群");
			expect(result.ok).toBe(false);
			// 请求是同步的：结果返回时已经没有别的请求（没有队列，也没有后台重试）。
			expect(feishu.requests).toHaveLength(1);
		});

		it("HTTP 2xx 但 code 不为 0 也是失败", async () => {
			await registerBot();
			feishu.reply({ status: 200, code: 99999, msg: "weird" });
			const result = await testResult("压测群");
			expect(result.ok).toBe(false);
			expect(result.feishu_code).toBe(99999);
		});

		describe("失败时把飞书的错误码翻译成中文，并写出下一步", () => {
			const failure = async (reply: Parameters<FakeFeishu["reply"]>[0]) => {
				await registerBot();
				feishu.reply(reply);
				const result = await testResult("压测群");
				expect(result.ok).toBe(false);
				expect(result.next_step).toEqual(expect.any(String));
				return result;
			};

			it("19021：开启了签名校验，sfly 不支持", async () => {
				const result = await failure({
					code: 19021,
					msg: "sign match fail or timestamp is not within one hour from current time",
				});
				expect(result.feishu_code).toBe(19021);
				expect(result.http_status).toBe(200);
				expect(result.message).toContain("签名校验");
				expect(result.message).toContain("sfly 不支持");
				expect(result.next_step).toContain("关键词");
				expect(result.next_step).toContain("IP 白名单");
			});

			it("19022：控制面的出口 IP 不在白名单里", async () => {
				const result = await failure({ code: 19022, msg: "Ip Not Allowed" });
				expect(result.feishu_code).toBe(19022);
				expect(result.message).toContain("出口 IP");
				expect(result.message).toContain("白名单");
				expect(result.next_step).toContain("IP 白名单");
			});

			it("19024：消息里没有群设置的关键词", async () => {
				const result = await failure({ code: 19024, msg: "Key Words Not Found" });
				expect(result.feishu_code).toBe(19024);
				expect(result.message).toContain("关键词");
				expect(result.next_step).toContain("关键词");
				expect(result.next_step).toContain("sfly");
			});

			it("9499：请求格式不对（飞书对它回 HTTP 400）", async () => {
				const result = await failure({ status: 400, code: 9499, msg: "Bad Request" });
				expect(result.feishu_code).toBe(9499);
				expect(result.http_status).toBe(400);
				expect(result.message).toContain("请求格式");
			});

			it("11232：触发了飞书的频率限制", async () => {
				const result = await failure({ code: 11232, msg: "rate limited" });
				expect(result.feishu_code).toBe(11232);
				expect(result.message).toContain("频率限制");
				expect(result.next_step).toContain("整点");
			});

			it("未知的错误码：写出错误码和飞书的说明，指向官方文档", async () => {
				const result = await failure({ code: 12345, msg: "something odd" });
				expect(result.feishu_code).toBe(12345);
				expect(result.message).toContain("12345");
				expect(result.message).toContain("something odd");
				expect(result.next_step).toContain("自定义机器人使用指南");
			});

			it.each([429, 500, 502, 503])("HTTP %i 且响应体不是飞书的格式", async (status) => {
				const result = await failure({ status, body: "<html>gateway</html>" });
				expect(result.feishu_code).toBeNull();
				expect(result.http_status).toBe(status);
				expect(result.message).toContain(`HTTP ${status}`);
			});

			it("HTTP 2xx 但响应体不是飞书的格式（例如网关返回的网页）", async () => {
				const result = await failure({ body: "<html>login</html>" });
				expect(result.feishu_code).toBeNull();
				expect(result.http_status).toBe(200);
				expect(result.message).toContain("不是飞书");
				expect(result.next_step).toContain("Webhook 地址");
			});

			it("其他 HTTP 错误（例如 404 地址写错了）", async () => {
				const result = await failure({ status: 404, body: "not found" });
				expect(result.http_status).toBe(404);
				expect(result.message).toContain("HTTP 404");
				expect(result.next_step).toContain("Webhook 地址");
			});
		});

		it("网络错误：连不上主机，写出主机和下一步", async () => {
			await api.createFeishuBot("群", feishu.webhookUrl("closed"));
			await feishu.close();
			const result = await testResult("群");
			expect(result.ok).toBe(false);
			expect(result.feishu_code).toBeNull();
			expect(result.http_status).toBeNull();
			expect(result.message).toContain("无法连接");
			expect(result.message).toContain("127.0.0.1");
			expect(result.message).not.toContain("closed");
			expect(result.next_step).toContain("防火墙");
			expect(result.next_step).not.toContain("PROXY");
		});

		it("超时：飞书一直不响应，10 秒后失败，不无限等待", { timeout: 30_000 }, async () => {
			await registerBot();
			feishu.reply({ hang: true });
			const result = await testResult("压测群");
			expect(result.ok).toBe(false);
			expect(result.feishu_code).toBeNull();
			expect(result.http_status).toBeNull();
			expect(result.message).toContain("10 秒");
			expect(result.message).toContain("超时");
			expect(result.next_step).toContain("防火墙");
			expect(feishu.requests).toHaveLength(1);
		});
	});
});
