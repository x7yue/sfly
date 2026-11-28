// 测试基建默认带凭据（#493）：控制面测试的请求默认带个人令牌，按昵称请求头换人；`credentials: "omit"` 不带。
// 另外演示用辅助造另一个项目的凭据，写「另一个项目读不到、改不了」的隔离测试。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { actAs, bearer, DEFAULT_TESTER, loginNameOf, TestAccounts } from "./support/credentials.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("测试基建默认带凭据", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let accounts: TestAccounts;

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		accounts = new TestAccounts(cp.database.url);
	});
	afterAll(async () => {
		await accounts?.close();
		await cp?.close();
	});

	const saveVersion = (id: string, nickname?: string) =>
		cp.fetch(`/orchestrations/${id}/versions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(nickname ? actAs(nickname) : {}),
			},
			body: JSON.stringify({ base_version: 0, document: { nodes: [], edges: [] } }),
		});

	it("默认以 tester 的个人令牌请求：写操作记在他的显示名下", async () => {
		const res = await saveVersion(await api.createOrchestration("默认凭据"));
		expect(res.status, await res.clone().text()).toBe(201);
		expect(await res.json()).toMatchObject({ author: DEFAULT_TESTER });
		const tokens = await api.getJson<{ tokens: { current: boolean }[] }>("/account/tokens");
		expect(tokens.tokens.filter((token) => token.current)).toHaveLength(1);
	});

	it("昵称请求头换人：每个昵称一个用户，显示名是昵称原样（登录名不合格式时用哈希）", async () => {
		const res = await saveVersion(await api.createOrchestration("换人"), "小明");
		expect(await res.json()).toMatchObject({ author: "小明" });
		expect(loginNameOf("小明")).toMatch(/^t_[0-9a-f]{24}$/);
		expect(await cp.users.user("小明")).toEqual(await cp.users.user("小明"));
		const id = await accounts.userNamed(loginNameOf("小明"));
		expect(id).toBe((await cp.users.user("小明")).id);
	});

	it('credentials: "omit" 不带凭据；请求自己带了凭据时不动', async () => {
		expect((await cp.fetch("/account/tokens", { credentials: "omit" })).status).toBe(401);
		const invalid = bearer("sfly_pat_0000000000000000000000000000");
		expect((await cp.fetch("/account/tokens", { headers: invalid })).status).toBe(401);
	});

	it("另一个项目的凭据读不到、改不了默认项目的场景", async () => {
		const scenario = await api.createOrchestration("只在默认项目");
		const project = await accounts.project("project-b");
		const outsider = await accounts.user("outsider");
		await accounts.member(project, outsider, "project_admin");
		const asOutsider = bearer(await accounts.personalToken(outsider));
		const projectToken = bearer(await accounts.projectToken(project));
		for (const headers of [asOutsider, projectToken]) {
			const read = await cp.fetch(`/orchestrations/${scenario}`, { headers });
			expect(read.status).toBe(404);
			const write = await cp.fetch(`/orchestrations/${scenario}`, {
				method: "PATCH",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ name: "改掉" }),
			});
			expect(write.status).toBe(404);
		}
		expect(await api.getJson(`/orchestrations/${scenario}`)).toMatchObject({
			name: "只在默认项目",
		});
	});
});
