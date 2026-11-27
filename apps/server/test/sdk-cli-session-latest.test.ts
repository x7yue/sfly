// 会话令牌下的 `sfly run … latest`（#787）：真实的 sfly 进程带着会话令牌（`SFLY_API_TOKEN`）和会话 ID（`SFLY_SESSION_ID`，
// 控制面交给工作台的环境变量）对着测试控制面，找的是这个会话触发的最近一次运行；不问 `GET /account/tokens`（会话令牌被 403）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DOCUMENT = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

describe("会话令牌下的 sfly run … latest", { timeout: 60_000 }, () => {
	const clock = new ManualClock();
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let agent: FakeAgent;
	let editor: string;
	let scenario: string;
	let sessionId: string;
	let sessionToken: string;
	let personalToken: string;

	const trigger = async (token: string): Promise<string> => {
		const res = await cp.fetch(`/orchestrations/${scenario}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json", ...bearer(token) },
			body: JSON.stringify({ params: {} }),
		});
		expect(res.status, await res.clone().text()).toBe(201);
		clock.advance(1000);
		return ((await res.json()) as { id: string }).id;
	};
	const cli = (env: Record<string, string | undefined>, ...args: string[]) =>
		sfly([...args, "--server", cp.httpUrl], { env });

	beforeAll(async () => {
		cp = await startTestControlPlane({ clock });
		accounts = new TestAccounts(cp.database.url);
		editor = await accounts.user("xiaoming", { displayName: "小明" });
		await accounts.member("default", editor, "editor");
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
		scenario = await new ApiClient(cp).orchestrationWith(DOCUMENT, "巡检");
		sessionId = await accounts.session(editor, "default");
		sessionToken = await accounts.sessionTokenIn(sessionId, editor, "default");
		personalToken = await accounts.personalToken(editor);
	});
	afterAll(async () => {
		await agent.disconnect();
		await accounts.close();
		await cp.close();
	});

	it("找的是这个会话触发的最近一次：发起人自己后来触发的、别的会话触发的都不算；个人令牌照旧是用户触发的最近一次；控制面按会话筛", async () => {
		const other = await accounts.sessionToken(editor, "default");
		const mine = await trigger(sessionToken);
		await trigger(other);
		const byPerson = await trigger(personalToken);

		const env = { SFLY_API_TOKEN: sessionToken, SFLY_SESSION_ID: sessionId };
		const shown = await cli(env, "run", "show", "latest", "--json");
		expect(shown.code, shown.stderr).toBe(0);
		expect((JSON.parse(shown.stdout) as { id: string }).id).toBe(mine);

		const personal = await cli(
			{ SFLY_API_TOKEN: personalToken },
			"run",
			"show",
			"latest",
			"--json",
		);
		expect(personal.code, personal.stderr).toBe(0);
		expect((JSON.parse(personal.stdout) as { id: string }).id).toBe(byPerson);

		// 控制面按会话筛（`GET /runs?session_id=`）。
		const res = await cp.fetch(`/runs?session_id=${sessionId}`, { headers: bearer(sessionToken) });
		expect(res.status).toBe(200);
		const { runs } = (await res.json()) as { runs: { id: string }[] };
		expect(runs.map((run) => run.id)).toEqual([mine]);
	});

	it("会话令牌没有 SFLY_SESSION_ID：说清是会话令牌、缺什么，不说成项目令牌", async () => {
		const result = await cli({ SFLY_API_TOKEN: sessionToken }, "run", "show", "latest", "--json");
		expect(result.code).not.toBe(0);
		const { error } = JSON.parse(result.stderr) as { error: { code: string; message: string } };
		expect(error.code).toBe("session_id_missing");
		expect(error.message).toContain("会话令牌");
		expect(error.message).toContain("SFLY_SESSION_ID");
		expect(error.message).not.toContain("项目令牌");
	});
});
