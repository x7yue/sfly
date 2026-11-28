// 登记项目的工作台经 HTTP（`PUT /projects/:project/workbench`，ADR 0027、0029「迁移与过渡」，#549）：真实控制面和数据库，
// 假 Agent 走真实的 gRPC。登记要「管理」范围、只认人的凭据；前置条件不满足是 409 并列出没换的 Agent；登记之后共享令牌和不带凭据的
// 连接都被拒绝，控制面重启之后照旧；没有登记时「助手」页写没有登记工作台。登记和连接的竞争的细节在 project-workbench.test.ts。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConnectError } from "@connectrpc/connect";
import type { SessionListResponse } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { shellBlocks } from "./support/doc-commands.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FakeAssistant } from "./support/fake-assistant.js";
import { repoRoot, sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SHARED = "s3cret-shared-token";
const JSON_HEADERS = { "content-type": "application/json" };

interface Registered {
	project: string;
	agent: string;
	previous_agent: string | null;
}
interface ApiError {
	error: {
		code: string;
		message: string;
		details?: { agents?: string[]; other_projects?: number };
	};
}

describe("登记项目的工作台", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let boss: Record<string, string>;
	/** 平台管理员，也是默认项目的项目管理员：开关还没开时只有平台管理员能登记（#778）。 */
	let root: Record<string, string>;
	let editor: Record<string, string>;
	let reader: Record<string, string>;
	let session: Record<string, string>;
	let projectToken: Record<string, string>;
	const agents: FakeAgent[] = [];

	beforeEach(async () => {
		cp = await startTestControlPlane({ agentToken: SHARED });
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		const bossId = await accounts.user("boss");
		await accounts.member("default", bossId, "project_admin");
		const editorId = await accounts.user("alice");
		await accounts.member("default", editorId, "editor");
		const readerId = await accounts.user("rita");
		await accounts.member("default", readerId, "read_only");
		boss = bearer(await accounts.personalToken(bossId));
		const rootId = await accounts.user("root", { admin: true });
		await accounts.member("default", rootId, "project_admin");
		root = bearer(await accounts.personalToken(rootId));
		editor = bearer(await accounts.personalToken(editorId));
		reader = bearer(await accounts.personalToken(readerId));
		session = bearer(await accounts.sessionToken(bossId, "default"));
		projectToken = bearer(await accounts.projectToken("default"));
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await db.end();
		await accounts.close();
		await cp.close();
	});

	// 凭据都由调用方写明（`{}` 是不带凭据）：不要测试控制面默认带的那一个。
	const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
		cp.fetch(path, {
			method,
			credentials: "omit",
			headers: { ...(body === undefined ? {} : JSON_HEADERS), ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const register = (agent: string, headers = root, project = "default") =>
		send("PUT", `/projects/${project}/workbench`, headers, { agent });
	const json = async <T>(res: Response, status: number): Promise<T> => {
		expect(res.status, await res.clone().text()).toBe(status);
		return (await res.json()) as T;
	};
	const column = async () =>
		(await db.query("select workbench_agent from projects where id = 'default'")).rows[0]
			?.workbench_agent as string | null;
	const connect = async (name: string, token?: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name,
			...(token === undefined ? {} : { token }),
		});
		agents.push(agent);
		return agent;
	};
	/** 用自己的 Agent 凭据连上来的 Agent（签发、连接）。 */
	const onCredential = async (name: string) => {
		const issued = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, name);
		return { agent: await connect(name, issued.token), token: issued.token };
	};
	/** 被拒绝的 Hello：gRPC 状态码和说明。 */
	const refusal = async (name: string, token?: string) => {
		const error = await connect(name, token).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error, `${name} 应该被拒绝`).toBeInstanceOf(ConnectError);
		const refused = error as ConnectError;
		return { code: refused.code, message: refused.rawMessage };
	};
	const UNAUTHENTICATED = 16;

	describe("谁能登记", () => {
		it("要「管理」范围、只认人：只读角色、编辑者、项目令牌、会话令牌都被拒绝，不带凭据 401，共享令牌也不行；库里没有登记", async () => {
			await onCredential("wb");
			for (const [who, headers] of [
				["只读角色", reader],
				["编辑者", editor],
				["项目令牌", projectToken],
				["会话令牌", session],
			] as const) {
				const body = await json<ApiError>(await register("wb", headers), 403);
				expect(body.error.code, who).toBeDefined();
			}
			await json<ApiError>(await register("wb", {}), 401);
			await json<ApiError>(await register("wb", bearer(SHARED)), 403);
			expect(await column()).toBeNull();
			// 对照：平台管理员的个人令牌登记得成（项目管理员见下面 #778 那一条）。
			await json<Registered>(await register("wb"), 200);
			expect(await column()).toBe("wb");
		});

		it("开关还没开时项目管理员登记不了（403，写明要平台管理员），不改任何东西；平台管理员登记之后，项目管理员能换自己项目的工作台（#778）", async () => {
			await onCredential("wb");
			await onCredential("wb-2");
			const refused = await json<ApiError>(await register("wb", boss), 403);
			expect(refused.error.code).toBe("workbench_switch_platform_admin_only");
			expect(refused.error.message).toContain("平台管理员");
			expect(await column()).toBeNull();
			await json<Registered>(await register("wb"), 200);
			expect((await json<Registered>(await register("wb-2", boss), 200)).previous_agent).toBe("wb");
		});

		it("项目不存在、或者调用方不是这个项目的成员：404（不透露有没有这个项目）", async () => {
			await onCredential("wb");
			await accounts.project("alpha");
			await json<ApiError>(await register("wb", boss, "no-such-project"), 404);
			// boss 是默认项目的管理员，不是 alpha 的成员。
			await json<ApiError>(await register("wb", boss, "alpha"), 404);
			expect(await column()).toBeNull();
		});

		it("请求体：只认 {agent: 名字}，多余的字段、空名字、不合格的名字都是 400，库里没有登记", async () => {
			await onCredential("wb");
			for (const body of [
				{},
				{ agent: "" },
				{ agent: "wb", extra: 1 },
				{ agent: "a\u001b[2Jb" },
				{ agent: "n".repeat(65) },
				{ agent: 7 },
			]) {
				const res = await send("PUT", "/projects/default/workbench", boss, body);
				expect(res.status, JSON.stringify(body)).toBe(400);
			}
			expect(await column()).toBeNull();
		});
	});

	describe("前置条件", () => {
		it("有没换成 Agent 凭据的 Agent：409 agents_not_on_credentials 并列出它们；停用的不挡；签发了凭据、最近一次仍用共享令牌连接的挡，换成凭据连上之后不再挡", async () => {
			const { agent: workbenchAgent } = await onCredential("wb");
			expect(workbenchAgent.name).toBe("wb");
			await connect("legacy-shared", SHARED);
			await connect("mixed", SHARED);
			// 「mixed」签发了 Agent 凭据，但最近一次连接仍用共享令牌；「never-connected」只签发过、从没连上，不算。
			const mixed = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "mixed");
			await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "never-connected");

			const blocked = await json<ApiError>(await register("wb"), 409);
			expect(blocked.error.code).toBe("agents_not_on_credentials");
			expect(blocked.error.details).toEqual({
				agents: ["legacy-shared", "mixed"],
				other_projects: 0,
			});
			expect(blocked.error.message).toContain("2 台");
			expect(blocked.error.message).toContain("POST /projects/default/agents/<名字>/disable");
			expect(await column()).toBeNull();

			// 停用 legacy-shared：不再挡；「mixed」还挡着（签发过凭据不算换了）。
			expect(
				(await send("POST", "/projects/default/agents/legacy-shared/disable", boss)).status,
			).toBe(204);
			const stillBlocked = await json<ApiError>(await register("wb"), 409);
			expect(stillBlocked.error.details?.agents).toEqual(["mixed"]);

			// 「mixed」用它的 Agent 凭据重新连上：最近一次连接是 Agent 凭据，登记成功。
			await connect("mixed", mixed.token);
			const done = await json<Registered>(await register("wb"), 200);
			expect(done).toEqual({ project: "default", agent: "wb", previous_agent: null });
			expect(await column()).toBe("wb");
		});

		it("另一个项目（乙）登记工作台：乙的管理员 403、看不到默认项目里任何 Agent 的名字；平台管理员在乙登记时只列乙里没换的，默认项目里的只给台数（#778）", async () => {
			await accounts.project("beta");
			const betaBossId = await accounts.user("bella");
			await accounts.member("beta", betaBossId, "project_admin");
			const betaBoss = bearer(await accounts.personalToken(betaBossId));
			const rootId = (await db.query("select id from users where login_name = 'root'")).rows[0]?.id;
			await accounts.member("beta", rootId, "project_admin");
			const betaWb = await cp.current.agentCredentials.issue("beta" as never, "beta-wb");
			await connect("beta-wb", betaWb.token);
			await connect("default-secret-box", SHARED);
			await connect("default-old", SHARED);
			const betaOld = await cp.current.agentCredentials.issue("beta" as never, "beta-old");
			await cp.current.agentCredentials.issue("beta" as never, "beta-unused");
			await connect("beta-old", betaOld.token);
			// beta-old 最近一次用共享令牌连接（不算换了）：把它记成旧方式。
			await db.query("update agents set last_auth_kind = 'shared' where name = 'beta-old'");

			const refused = await register("beta-wb", betaBoss, "beta");
			const text = await refused.text();
			expect(refused.status, text).toBe(403);
			for (const name of ["default-secret-box", "default-old", "beta-old"]) {
				expect(text).not.toContain(name);
			}

			const blocked = await json<ApiError>(await register("beta-wb", root, "beta"), 409);
			expect(blocked.error.code).toBe("agents_not_on_credentials");
			expect(blocked.error.details).toEqual({ agents: ["beta-old"], other_projects: 2 });
			expect(blocked.error.message).toContain("另有 2 台在别的项目里，请部署者处理");
			expect(JSON.stringify(blocked)).not.toContain("default-");
		});

		it("登记的工作台本身：没有这台 Agent、别的项目里的名字、被停用、最近一次连接不是 Agent 凭据，各是各的 409，不改任何东西", async () => {
			await accounts.project("alpha");
			const alpha = await cp.current.agentCredentials.issue("alpha" as never, "in-alpha");
			await connect("in-alpha", alpha.token);
			await onCredential("off");
			expect((await send("POST", "/projects/default/agents/off/disable", boss)).status).toBe(204);
			await connect("shared-one", SHARED);

			const code = async (name: string) => (await json<ApiError>(await register(name), 409)).error;
			expect((await code("nobody")).code).toBe("workbench_agent_unknown");
			// 别的项目里的名字：和没有一样（说明也一样），不透露那边有没有它。
			expect(await code("in-alpha")).toEqual({
				...(await code("nobody")),
			});
			const disabled = await code("off");
			expect(disabled.code).toBe("workbench_agent_disabled");
			// 说明里恢复它的写法照着做得通（路径带项目，#488）。
			expect(disabled.message).toContain("POST /projects/default/agents/off/enable");
			expect((await code("shared-one")).code).toBe("workbench_agent_not_on_credential");
			expect(await column()).toBeNull();
		});
	});

	describe("文档里的命令", () => {
		it("README「助手和工作台」里登记工作台的命令照着执行一遍（真实的 sfly 命令行，个人令牌）：登记成功，响应是 {project, agent, previous_agent}，再执行一遍是幂等的", async () => {
			await onCredential("workbench");
			const readme = await readFile(join(repoRoot, "README.md"), "utf8");
			const block = shellBlocks(readme).find((code) =>
				code.includes("sfly api PUT /projects/default/workbench"),
			);
			expect(block, "README 里没有登记工作台的命令").toBeDefined();
			const command = /^sfly api PUT (\S+) --body '([^']*)'$/m.exec(block ?? "");
			expect(command, `README 里登记工作台的命令的写法变了：${block}`).not.toBeNull();
			const [, path = "", body = ""] = command ?? [];
			expect(JSON.parse(body)).toEqual({ agent: "workbench" });

			const token = (root.authorization ?? "").replace(/^Bearer /, "");
			const run = () =>
				sfly(["api", "PUT", path, "--body", body, "--server", cp.httpUrl], {
					env: { SFLY_API_TOKEN: token },
				});
			const first = await run();
			expect(first.code, first.stderr).toBe(0);
			expect(JSON.parse(first.stdout)).toEqual({
				project: "default",
				agent: "workbench",
				previous_agent: null,
			});
			expect(await column()).toBe("workbench");
			const again = await run();
			expect(again.code, again.stderr).toBe(0);
			expect(JSON.parse(again.stdout)).toMatchObject({ agent: "workbench", previous_agent: null });
			// 命令行没有登录时的 401（不是登记成功）：命令用的是令牌，不是共享令牌。
			const anonymous = await sfly(["api", "PUT", path, "--body", body, "--server", cp.httpUrl], {
				env: { SFLY_API_TOKEN: SHARED },
			});
			expect(anonymous.code).not.toBe(0);
		}, 120_000);
	});

	describe("读不到开关：旧方式的 Hello 被拒绝，不放行", () => {
		it("控制面启动之后库里读开关的那一列坏了：共享令牌和没有凭据的连接都进不来（Hello 以错误结束），带 Agent 凭据的照常；恢复之后共享令牌又连得上", async () => {
			await db.query("alter table projects rename column workbench_agent to workbench_gone");
			try {
				for (const token of [SHARED, ""]) {
					const error = await connect("legacy", token).then(
						() => undefined,
						(caught: unknown) => caught,
					);
					expect(error, `token=${JSON.stringify(token)} 应该被拒绝`).toBeInstanceOf(ConnectError);
				}
				expect((await db.query("select 1 from agents where name = 'legacy'")).rowCount).toBe(0);
				const { token } = await onCredential("on-credential");
				expect(token).toMatch(/^sfly_agt_/);
			} finally {
				await db.query("alter table projects rename column workbench_gone to workbench_agent");
			}
			await (await connect("legacy", SHARED)).disconnect();
		}, 60_000);
	});

	describe("登记之后", () => {
		it("共享令牌和不带凭据的连接都被拒绝（Unauthenticated，写明只接受 Agent 凭据），带 Agent 凭据的照常；控制面重启之后照旧", async () => {
			await onCredential("wb");
			// 登记之前：共享令牌连得上（对照）。
			const before = await connect("legacy", SHARED);
			await before.disconnect();
			agents.splice(agents.indexOf(before), 1);
			// 旧方式的 Agent 要先换成凭据（或停用）才能登记。
			expect((await send("POST", "/projects/default/agents/legacy/disable", boss)).status).toBe(
				204,
			);
			await json<Registered>(await register("wb"), 200);

			const assertClosed = async () => {
				for (const [how, token] of [
					["共享令牌", SHARED],
					["没有凭据", ""],
				] as const) {
					for (const name of ["legacy", "brand-new"]) {
						const refused = await refusal(name, token);
						expect(refused.code, `${how} × ${name}`).toBe(UNAUTHENTICATED);
						expect(refused.message, `${how} × ${name}`).toContain("只接受 Agent 凭据");
					}
				}
				// 带自己的 Agent 凭据照常（新名字也行：凭据本来就能登记一个新名字）。
				const issued = await cp.current.agentCredentials.issue(DEFAULT_PROJECT, "fresh");
				await (await connect("fresh", issued.token)).disconnect();
			};
			await assertClosed();
			// 重启：开关从库里得出，不是只在内存里。
			await cp.restart();
			await assertClosed();
			expect(await column()).toBe("wb");
		}, 60_000);

		it("换一台工作台：返回换下来的那台；登记同一台是幂等的；开关一直开着", async () => {
			await onCredential("wb-1");
			await onCredential("wb-2");
			expect((await json<Registered>(await register("wb-1"), 200)).previous_agent).toBeNull();
			expect((await json<Registered>(await register("wb-1"), 200)).previous_agent).toBeNull();
			expect(await json<Registered>(await register("wb-2"), 200)).toEqual({
				project: "default",
				agent: "wb-2",
				previous_agent: "wb-1",
			});
			expect(await column()).toBe("wb-2");
			expect((await refusal("legacy", SHARED)).message).toContain("只接受 Agent 凭据");
		});

		it("登记和旧方式的连接同时来（真实的 HTTP 和 gRPC）：登记成功时旧方式的连接进不来；旧方式的连接进来了，登记 409 并列出它", async () => {
			await onCredential("wb");
			const [registered, attached] = await Promise.allSettled([
				register("wb"),
				connect("racer", SHARED),
			]);
			if (registered.status !== "fulfilled") throw registered.reason;
			if (registered.value.status === 200) {
				expect(attached.status, "登记成功之后旧方式的连接不能进来").toBe("rejected");
				expect((await db.query("select 1 from agents where name = 'racer'")).rowCount).toBe(0);
			} else {
				const body = await json<ApiError>(registered.value, 409);
				expect(body.error.details?.agents).toEqual(["racer"]);
				expect(attached.status).toBe("fulfilled");
			}
		});
	});
});

describe("助手页：没有登记工作台", () => {
	let assistant: FakeAssistant;
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let boss: Record<string, string>;
	let workbench: FakeAgent | undefined;

	beforeEach(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			assistantReconnectMs: { min: 20, max: 100 },
		});
		accounts = new TestAccounts(cp.database.url);
		// 第一次登记打开整个部署的开关，要平台管理员（#778）。
		const bossId = await accounts.user("boss", { admin: true });
		await accounts.member("default", bossId, "project_admin");
		boss = bearer(await accounts.personalToken(bossId));
	});
	afterEach(async () => {
		await workbench?.disconnect();
		workbench = undefined;
		await accounts.close();
		await cp.close();
		await assistant.close();
	});

	const readiness = async () =>
		(
			(await (
				await cp.fetch("/projects/default/sessions", { headers: boss })
			).json()) as SessionListResponse
		).readiness;

	it("登记的工作台被停用：就绪状态写「已被停用」（不是「不在线」）；恢复之后还没连上就是「不在线」，连上了就绪", async () => {
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: "wb", peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		const registered = await cp.fetch("/projects/default/workbench", {
			method: "PUT",
			headers: { ...JSON_HEADERS, ...boss },
			body: JSON.stringify({ agent: "wb" }),
		});
		expect(registered.status, await registered.clone().text()).toBe(200);
		expect(await readiness()).toMatchObject({ ready: true, workbench: "wb" });

		const toggle = async (action: "disable" | "enable") =>
			(await cp.fetch(`/projects/default/agents/wb/${action}`, { method: "POST", headers: boss }))
				.status;
		expect(await toggle("disable")).toBe(204);
		const disabled = await readiness();
		expect(disabled).toMatchObject({ ready: false, workbench: "wb" });
		expect(disabled.problems).toEqual([
			expect.objectContaining({
				kind: "workbench_offline",
				message: expect.stringContaining("已被停用"),
			}),
		]);
		expect(disabled.problems[0]?.message).not.toContain("不在线");
		// 建会话也写同一句（503 assistant_unavailable）。
		const created = await cp.fetch("/projects/default/sessions", {
			method: "POST",
			headers: { ...JSON_HEADERS, ...boss },
			body: JSON.stringify({ text: "你好" }),
		});
		expect(created.status).toBe(503);
		expect(((await created.json()) as ApiError).error.message).toContain("已被停用");

		// 恢复：Agent 的连接在停用时断开了，还没重新连上就是「不在线」（不再是「已被停用」）。
		expect(await toggle("enable")).toBe(204);
		const offline = await readiness();
		expect(offline.problems[0]?.message).toContain("不在线");
		expect(offline.problems[0]?.message).not.toContain("已被停用");
		await workbench.disconnect();
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: "wb", peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		expect(await readiness()).toMatchObject({ ready: true, workbench: "wb", problems: [] });
	}, 60_000);

	it("没有登记：就绪状态是 workbench_not_set、写「没有登记工作台」，建会话 503 assistant_unavailable；登记之后工作台在线、就绪", async () => {
		const before = await readiness();
		expect(before).toMatchObject({ ready: false, workbench: null });
		expect(before.problems).toEqual([
			expect.objectContaining({
				kind: "workbench_not_set",
				message: expect.stringContaining("没有登记工作台"),
			}),
		]);
		// 控制面里没有环境变量 SFLY_WORKBENCH_AGENT 的痕迹：说明里也不让人去设环境变量。
		expect(before.problems[0]?.message).not.toContain("SFLY_WORKBENCH_AGENT");
		const created = await cp.fetch("/projects/default/sessions", {
			method: "POST",
			headers: { ...JSON_HEADERS, ...boss },
			body: JSON.stringify({ text: "你好" }),
		});
		expect(created.status).toBe(503);
		expect(((await created.json()) as ApiError).error.code).toBe("assistant_unavailable");

		// 工作台连上来（Agent 凭据，上报了能力端口），登记。
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: "wb", peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		const registered = await cp.fetch("/projects/default/workbench", {
			method: "PUT",
			headers: { ...JSON_HEADERS, ...boss },
			body: JSON.stringify({ agent: "wb" }),
		});
		expect(registered.status, await registered.clone().text()).toBe(200);
		const after = await readiness();
		expect(after).toMatchObject({ ready: true, workbench: "wb", problems: [] });
	}, 60_000);
});
