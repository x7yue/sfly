// 切入点 A：控制面向 Webhook 地址发请求时遵循 HTTPS_PROXY / HTTP_PROXY 和 NO_PROXY（#228，ADR 0020）。
// 代理是另一个假飞书服务：它记下以绝对地址到达的请求和 CONNECT 隧道请求。环境变量在控制面启动时读取，
// 所以每个用例先设置环境变量、再启动控制面；每个测试文件在独立进程里运行，改 process.env 不影响别的文件。
import { feishuBotsApi } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const PROXY_VARS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

describe("飞书请求遵循 HTTPS_PROXY 和 NO_PROXY", () => {
	const saved = new Map(PROXY_VARS.map((name) => [name, process.env[name]]));
	let cp: TestControlPlane | undefined;
	const servers: FakeFeishu[] = [];
	afterEach(async () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await cp?.close();
		cp = undefined;
		await Promise.all(servers.splice(0).map((s) => s.close()));
	});

	const fakeServer = async () => {
		const server = await startFakeFeishu();
		servers.push(server);
		return server;
	};
	/** 设置代理环境变量（没写的清掉），再启动控制面、登记一个机器人。 */
	async function start(
		env: Partial<Record<(typeof PROXY_VARS)[number], string>>,
		webhookUrl: string,
	) {
		for (const name of PROXY_VARS) delete process.env[name];
		Object.assign(process.env, env);
		cp = await startTestControlPlane();
		const api = new ApiClient(cp);
		await api.createFeishuBot("群", webhookUrl);
		const res = await api.postEmpty(`/feishu-bots/${encodeURIComponent("群")}/test`);
		expect(res.status).toBe(200);
		return feishuBotsApi.test.response.parse(await res.json());
	}

	it("设置了 HTTP_PROXY：http 地址的请求发给代理，请求里仍是 Webhook 地址里的主机和路径", async () => {
		const proxy = await fakeServer();
		const result = await start(
			{ HTTP_PROXY: proxy.origin },
			"http://feishu.test/open-apis/bot/v2/hook/tok",
		);
		expect(result.ok).toBe(true);
		expect(proxy.requests).toHaveLength(1);
		expect(proxy.requests[0]).toMatchObject({
			method: "POST",
			path: "/open-apis/bot/v2/hook/tok",
			viaProxy: true,
		});
		expect(proxy.requests[0]?.headers.host).toBe("feishu.test");
	});

	it("设置了 HTTPS_PROXY：https 地址经代理建立隧道，目标是 Webhook 地址里的主机", async () => {
		const proxy = await fakeServer();
		const result = await start(
			{ HTTPS_PROXY: proxy.origin },
			"https://open.feishu.cn/open-apis/bot/v2/hook/secret-token",
		);
		expect(proxy.connects).toEqual(["open.feishu.cn:443"]);
		// 假代理拒绝建立隧道：失败信息指出是代理的问题，不含地址里的令牌。
		expect(result.ok).toBe(false);
		expect(result.message).toContain("代理");
		expect(JSON.stringify(result)).not.toContain("secret-token");
	});

	it("NO_PROXY 里有 Webhook 地址的主机：不经代理，直接请求", async () => {
		const proxy = await fakeServer();
		const feishu = await fakeServer();
		const result = await start(
			{ HTTP_PROXY: proxy.origin, NO_PROXY: "127.0.0.1" },
			feishu.webhookUrl("direct"),
		);
		expect(result.ok).toBe(true);
		expect(proxy.requests).toEqual([]);
		expect(feishu.requests).toHaveLength(1);
		expect(feishu.requests[0]).toMatchObject({
			path: "/open-apis/bot/v2/hook/direct",
			viaProxy: false,
		});
	});

	it("NO_PROXY 没有覆盖这个主机时仍然走代理", async () => {
		const proxy = await fakeServer();
		const result = await start(
			{ HTTP_PROXY: proxy.origin, NO_PROXY: "other.internal,.example.org" },
			"http://feishu.test/open-apis/bot/v2/hook/tok",
		);
		expect(result.ok).toBe(true);
		expect(proxy.requests).toHaveLength(1);
	});

	it("没有设置代理环境变量：直接请求 Webhook 地址里的主机", async () => {
		const feishu = await fakeServer();
		const result = await start({}, feishu.webhookUrl("plain"));
		expect(result.ok).toBe(true);
		expect(feishu.requests).toHaveLength(1);
		expect(feishu.requests[0]?.viaProxy).toBe(false);
	});
});
