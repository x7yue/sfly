// Agent 凭据的签发、吊销、停用和「我的开发 Agent」经 HTTP（ADR 0029「凭据」，规格 #492）：真实控制面和数据库。
// 签发和吊销要「管理」范围；开发 Agent 要「编辑」范围并且只认有用户的人的凭据；原值只在签发的响应里出现一次，库里只有哈希和前缀。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCredential } from "../src/auth/credential-hash.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import type { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const JSON_HEADERS = { "content-type": "application/json" };

interface Issued {
	credential: {
		id: string;
		prefix: string;
		created_at: string;
		last_used_at: string | null;
		revoked_at: string | null;
		user: string | null;
	};
	token: string;
}

describe("Agent 凭据和开发 Agent", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let db: pg.Client;
	let boss: Record<string, string>;
	let editor: Record<string, string>;
	let editorId: string;
	let reader: Record<string, string>;
	let other: Record<string, string>;
	let session: Record<string, string>;
	let projectToken: Record<string, string>;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		const bossId = await accounts.user("boss", { displayName: "老板" });
		await accounts.member("default", bossId, "project_admin");
		editorId = await accounts.user("alice", { displayName: "爱丽丝" });
		await accounts.member("default", editorId, "editor");
		const readerId = await accounts.user("rita");
		await accounts.member("default", readerId, "read_only");
		const otherId = await accounts.user("bob", { displayName: "鲍勃" });
		await accounts.member("default", otherId, "editor");
		boss = bearer(await accounts.personalToken(bossId));
		editor = bearer(await accounts.personalToken(editorId));
		reader = bearer(await accounts.personalToken(readerId));
		other = bearer(await accounts.personalToken(otherId));
		session = bearer(await accounts.sessionToken(editorId, "default"));
		projectToken = bearer(await accounts.projectToken("default"));
	});
	afterEach(async () => {
		await db.end();
		await accounts.close();
		await cp.close();
	});

	const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
		cp.fetch(path, {
			method,
			headers: { ...(body === undefined ? {} : JSON_HEADERS), ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const json = async <T>(res: Response, status: number): Promise<T> => {
		expect(res.status, await res.clone().text()).toBe(status);
		return (await res.json()) as T;
	};
	const issue = (name: string, headers = boss) =>
		send("POST", `/agents/${name}/credentials`, headers, {});
	const rows = async (name: string) =>
		(
			await db.query(
				"select kind, project_id, agent_name, prefix, token_hash, user_id, revoked_at from agent_credentials where agent_name = $1 order by created_at",
				[name],
			)
		).rows;

	describe("按台签发", () => {
		it("项目管理员签发：原值带 sfly_agt_ 前缀、只在这次响应里出现；库里只有哈希和展示用的前缀，属于默认项目和这个名字", async () => {
			const issued = await json<Issued>(await issue("worker-1"), 201);
			expect(issued.token).toMatch(/^sfly_agt_[0-9a-f]{48}$/);
			expect(issued.credential).toMatchObject({
				prefix: issued.token.slice(0, 13),
				last_used_at: null,
				revoked_at: null,
				user: null,
			});
			const [row] = await rows("worker-1");
			expect(row).toMatchObject({
				kind: "agent",
				project_id: "default",
				agent_name: "worker-1",
				prefix: issued.token.slice(0, 13),
				token_hash: hashCredential(issued.token),
				user_id: null,
				revoked_at: null,
			});
			// 原值不在库里（任何一列）。
			expect(JSON.stringify(row)).not.toContain(issued.token);
		});

		it("名称和 Agent 在 Hello 里报的名称同一个规则（#670）：表里的字符、看起来是空的、超过 64 个字符都拒绝，说第几个字符、哪个码位或上限，不回显名称，库里没有凭据；64 个字符、中文、组合表情照常签发", async () => {
			const code = (...points: number[]) => String.fromCodePoint(...points);
			const rejected = async (name: string): Promise<string> => {
				const res = await issue(encodeURIComponent(name));
				const text = await res.text();
				expect(res.status, JSON.stringify(name)).toBe(400);
				// 原样的名称不出现在报错里（控制字符、转义序列不回显）。
				expect(text, JSON.stringify(name)).not.toContain(name);
				expect(await rows(name), JSON.stringify(name)).toEqual([]);
				return text;
			};
			expect(await rejected(`a${code(0x1b)}[2Jb`)).toContain("Agent 的名称的第 2 个字符是 U+001B");
			expect(await rejected(`a${code(0x9b)}b`)).toContain("Agent 的名称的第 2 个字符是 U+009B");
			expect(await rejected(`a${code(0x202e)}b`)).toContain("Agent 的名称的第 2 个字符是 U+202E");
			expect(await rejected(`a${code(0x200b)}b`)).toContain("Agent 的名称的第 2 个字符是 U+200B");
			expect(await rejected(`${code(0x200d)}a`)).toContain("Agent 的名称的第 1 个字符是 U+200D");
			expect(await rejected(code(0x2800))).toContain("Agent 的名称的第 1 个字符是 U+2800");
			expect(await rejected("   ")).toContain("Agent 的名称里没有看得见的字符");
			const tooLong = await rejected("n".repeat(65));
			expect(tooLong).toContain("Agent 的名称不能超过 64 个字符");
			expect(tooLong).not.toMatch(/n{20}/);
			// 64 个字符照常签发，不论是几个码元：64 个 emoji 是 128 个 UTF-16 码元，路由的路径参数上限是 128
			// （解码之后的长度，默认的 100 放不下它，#691 复审）；汉字、组合表情也一样。
			for (const ok of [
				"n".repeat(64),
				code(0x1f600).repeat(64),
				"测".repeat(64),
				"测试机",
				`dev-${code(0x1f469, 0x200d, 0x1f4bb)}`,
			]) {
				await json<Issued>(await issue(encodeURIComponent(ok)), 201);
				expect((await rows(ok)).length, ok).toBe(1);
			}
			// 65 个 emoji（130 个码元）：超过路径参数的上限，在进校验之前就是 414，不签发。
			const tooManyEmoji = code(0x1f600).repeat(65);
			expect((await issue(encodeURIComponent(tooManyEmoji))).status).toBe(414);
			expect(await rows(tooManyEmoji)).toEqual([]);
		});

		it("同一台 Agent 可以有几个有效的凭据（轮换）；列出带状态、不带原值，从新到旧", async () => {
			const first = await json<Issued>(await issue("worker-1"), 201);
			// 列表按签发时间从新到旧：控制面用手动时钟，两次签发之间推进它，顺序才是确定的。
			(cp.clock as ManualClock).advance(1000);
			const second = await json<Issued>(await issue("worker-1"), 201);
			expect(first.token).not.toBe(second.token);
			const list = await json<{ credentials: Issued["credential"][] }>(
				await send("GET", "/agents/worker-1/credentials", boss),
				200,
			);
			expect(list.credentials.map((c) => c.id)).toEqual([
				second.credential.id,
				first.credential.id,
			]);
			expect(JSON.stringify(list)).not.toContain(first.token);
			expect(JSON.stringify(list)).not.toContain(second.token);
			// 别的 Agent 的凭据不混进来。
			await issue("worker-2");
			expect(
				(
					await json<{ credentials: unknown[] }>(
						await send("GET", "/agents/worker-1/credentials", boss),
						200,
					)
				).credentials,
			).toHaveLength(2);
		});

		it("签发和吊销要「管理」：编辑者、只读、项目令牌（没有管理）、会话令牌都是 403；读（列出）按「读」", async () => {
			for (const who of [editor, reader, projectToken, session]) {
				expect((await issue("worker-1", who)).status).toBe(403);
			}
			const issued = await json<Issued>(await issue("worker-1"), 201);
			for (const who of [editor, reader, projectToken, session]) {
				expect(
					(await send("DELETE", `/agents/worker-1/credentials/${issued.credential.id}`, who))
						.status,
				).toBe(403);
			}
			expect((await rows("worker-1")).filter((r) => r.revoked_at !== null)).toHaveLength(0);
			// 只读也能看到有哪些凭据（前缀、状态），看不到原值。
			expect((await send("GET", "/agents/worker-1/credentials", reader)).status).toBe(200);
		});

		it("不带任何凭据、带共享令牌：签发、列出、吊销、停用、恢复都不行（401 / 403），什么都没有发生；Agent 凭据是新这一套信任的根，不能匿名（#638 审查）", async () => {
			const issued = await json<Issued>(await issue("worker-1"), 201);
			const calls: [string, string, number][] = [
				["POST", "/agents/worker-1/credentials", 401],
				["GET", "/agents/worker-1/credentials", 401],
				["DELETE", `/agents/worker-1/credentials/${issued.credential.id}`, 401],
				["POST", "/agents/worker-1/disable", 401],
				["POST", "/agents/worker-1/enable", 401],
			];
			for (const [method, path, status] of calls) {
				const anonymous = await send(
					method,
					path,
					{},
					method === "POST" && path.endsWith("credentials") ? {} : undefined,
				);
				expect(anonymous.status, `${method} ${path}（不带凭据）`).toBe(status);
			}
			// 共享令牌：它只给 Agent 连接用，不能调这几个接口。
			const sharedToken = "shared-secret-for-agents";
			await db.query(
				"insert into agent_credentials (id, kind, project_id, agent_name, prefix, token_hash, created_at) values (gen_random_uuid(), 'shared', 'default', null, 'shared', $1, now())",
				[hashCredential(sharedToken)],
			);
			for (const [method, path] of calls) {
				const shared = await send(
					method,
					path,
					bearer(sharedToken),
					method === "POST" && path.endsWith("credentials") ? {} : undefined,
				);
				expect(shared.status, `${method} ${path}（共享令牌）`).toBe(403);
			}
			// 没有签发出新的凭据、没有吊销、没有停用。
			const state = await rows("worker-1");
			expect(state).toHaveLength(1);
			expect(state[0]?.revoked_at).toBeNull();
		});

		it("吊销：立即失效、写下吊销时间；再吊销是 204；不是这台 Agent 的凭据、不存在的 ID 是 404", async () => {
			const issued = await json<Issued>(await issue("worker-1"), 201);
			const other = await json<Issued>(await issue("worker-2"), 201);
			expect(
				(await send("DELETE", `/agents/worker-1/credentials/${issued.credential.id}`, boss)).status,
			).toBe(204);
			expect((await rows("worker-1"))[0]?.revoked_at).not.toBeNull();
			expect(
				(await send("DELETE", `/agents/worker-1/credentials/${issued.credential.id}`, boss)).status,
			).toBe(204);
			// 别的 Agent 的凭据：按这台的名字吊销不了。
			expect(
				(await send("DELETE", `/agents/worker-1/credentials/${other.credential.id}`, boss)).status,
			).toBe(404);
			expect(
				(await send("DELETE", `/agents/worker-1/credentials/${crypto.randomUUID()}`, boss)).status,
			).toBe(404);
			expect((await rows("worker-2"))[0]?.revoked_at).toBeNull();
		});
	});

	describe("我的开发 Agent", () => {
		const create = (host: unknown, headers = editor, body: Record<string, unknown> = {}) =>
			send("POST", "/projects/default/dev-agents", headers, { host, ...body });

		it("编辑者注册：名字由控制面生成 dev-<登录名>-<主机>，凭据记在他名下；库里只有哈希", async () => {
			const created = await json<{ name: string } & Issued>(await create("laptop"), 201);
			expect(created.name).toBe("dev-alice-laptop");
			expect(created.credential.user).toBe("爱丽丝");
			expect(created.token).toMatch(/^sfly_agt_/);
			const [row] = await rows("dev-alice-laptop");
			expect(row).toMatchObject({
				kind: "agent",
				project_id: "default",
				user_id: editorId,
				token_hash: hashCredential(created.token),
			});
		});

		it("名字的规则：登录名不含连字符，所以 a + b-c 和 a_b + c 不会相同；请求里带名字被拒绝", async () => {
			const aId = await accounts.user("a");
			await accounts.member("default", aId, "editor");
			const abId = await accounts.user("a_b");
			await accounts.member("default", abId, "editor");
			const a = bearer(await accounts.personalToken(aId));
			const ab = bearer(await accounts.personalToken(abId));
			expect((await json<{ name: string }>(await create("b-c", a), 201)).name).toBe("dev-a-b-c");
			expect((await json<{ name: string }>(await create("c", ab), 201)).name).toBe("dev-a_b-c");
			expect((await create("laptop", editor, { name: "dev-bob-laptop" })).status).toBe(400);
			expect((await rows("dev-bob-laptop")).length).toBe(0);
		});

		it("主机名含不允许的字符、空、太长：400；整个名字超过总长上限：400", async () => {
			for (const host of ["Laptop", "my_host", "a b", "a.b", "-x", "x-", "", "中文"]) {
				expect((await create(host)).status, JSON.stringify(host)).toBe(400);
			}
			expect((await create("x".repeat(33))).status).toBe(400);
			// 登录名很长时，主机名合规也会让整个名字超长。
			const longId = await accounts.user("u".repeat(32));
			await accounts.member("default", longId, "editor");
			const long = bearer(await accounts.personalToken(longId));
			const res = await create("h".repeat(30), long);
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ error: { code: "dev_agent_name_too_long" } });
		});

		it("同一个人在同一个项目里用同一个主机名再注册：409，提示换主机名；吊销之后他可以重新注册", async () => {
			await json(await create("laptop"), 201);
			const again = await create("laptop");
			expect(again.status).toBe(409);
			expect(await again.json()).toMatchObject({
				error: { code: "dev_agent_exists", message: expect.stringContaining("换一个主机名") },
			});
			expect(await rows("dev-alice-laptop")).toHaveLength(1);
			// 吊销之后（凭据都失效了）同一个人可以重新注册。
			expect(
				(await send("DELETE", "/projects/default/dev-agents/dev-alice-laptop", editor)).status,
			).toBe(204);
			await json(await create("laptop"), 201);
		});

		it("同名的并发注册只有一个成功", async () => {
			const results = await Promise.all(Array.from({ length: 6 }, () => create("racer")));
			expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
			expect(await rows("dev-alice-racer")).toHaveLength(1);
		});

		it("只读角色、会话令牌、项目令牌注册都被拒绝（只认有用户的人的凭据，要「编辑」）", async () => {
			for (const [who, why] of [
				[reader, "只读角色"],
				[session, "会话令牌"],
				[projectToken, "项目令牌"],
			] as const) {
				const res = await create("laptop", who);
				expect(res.status, why).toBe(403);
			}
			expect(await rows("dev-alice-laptop")).toHaveLength(0);
			expect(await rows("dev-rita-laptop")).toHaveLength(0);
		});

		it("吊销：自己的可以；别人的编辑者不行（403）；项目管理员可以；不存在的、不是开发 Agent 的是 404", async () => {
			await json(await create("laptop"), 201);
			const target = "/projects/default/dev-agents/dev-alice-laptop";
			expect((await send("DELETE", target, other)).status).toBe(403);
			expect((await rows("dev-alice-laptop"))[0]?.revoked_at).toBeNull();
			expect((await send("DELETE", target, session)).status).toBe(403);
			expect((await send("DELETE", target, reader)).status).toBe(403);
			expect((await send("DELETE", target, boss)).status).toBe(204);
			expect((await rows("dev-alice-laptop"))[0]?.revoked_at).not.toBeNull();
			expect((await send("DELETE", target, boss)).status).toBe(204);
			expect(
				(await send("DELETE", "/projects/default/dev-agents/dev-alice-nothing", boss)).status,
			).toBe(404);
			// 按台签发的（没有用户）不是开发 Agent：这个接口吊销不了它。
			await issue("worker-1");
			expect((await send("DELETE", "/projects/default/dev-agents/worker-1", boss)).status).toBe(
				404,
			);
			expect((await rows("worker-1"))[0]?.revoked_at).toBeNull();
		});

		it("所属用户被停用：他自己吊销不了（401，停用的用户只能吊销自己的登录和个人令牌）；项目管理员可以吊销", async () => {
			await json(await create("laptop"), 201);
			const target = "/projects/default/dev-agents/dev-alice-laptop";
			await db.query("update users set disabled_at = now() where id = $1", [editorId]);
			expect((await send("DELETE", target, editor)).status).toBe(401);
			expect((await rows("dev-alice-laptop"))[0]?.revoked_at).toBeNull();
			expect((await send("DELETE", target, boss)).status).toBe(204);
			expect((await rows("dev-alice-laptop"))[0]?.revoked_at).not.toBeNull();
		});

		it("不是这个项目的成员：404（不透露）；别的项目不存在也是 404", async () => {
			await accounts.project("alpha");
			expect(
				(await send("POST", "/projects/alpha/dev-agents", editor, { host: "laptop" })).status,
			).toBe(404);
			expect(
				(await send("POST", "/projects/nope/dev-agents", editor, { host: "laptop" })).status,
			).toBe(404);
		});
	});

	describe("停用和恢复", () => {
		const seed = async (name: string) => {
			await db.query(
				`insert into agents (name, project_id, info, status, registered_at, last_seen_at)
				values ($1, 'default', '{"agent_version":"1","os":"linux","arch":"x86_64","slots":1,"installed_packages":[]}', 'offline', now(), now())`,
				[name],
			);
		};
		const disabledAt = async (name: string) =>
			(await db.query("select disabled_at from agents where name = $1", [name])).rows[0]
				?.disabled_at as Date | null | undefined;

		it("停用、恢复要「管理」；停用写下时间，恢复清空；重复操作 204；没有这台 Agent 是 404", async () => {
			await seed("worker-1");
			for (const who of [editor, reader, session, projectToken]) {
				expect((await send("POST", "/agents/worker-1/disable", who)).status).toBe(403);
			}
			expect(await disabledAt("worker-1")).toBeNull();
			expect((await send("POST", "/agents/worker-1/disable", boss)).status).toBe(204);
			const stamp = await disabledAt("worker-1");
			expect(stamp).not.toBeNull();
			expect((await send("POST", "/agents/worker-1/disable", boss)).status).toBe(204);
			expect(await disabledAt("worker-1")).toEqual(stamp);
			// 列表里带着停用的时间和最近一次连接用的凭据。
			const list = await json<{
				agents: Array<{ name: string; disabled_at: string | null; auth_kind: string | null }>;
			}>(await send("GET", "/agents", boss), 200);
			expect(list.agents.find((a) => a.name === "worker-1")).toMatchObject({
				disabled_at: stamp?.toISOString(),
				auth_kind: null,
			});
			expect((await send("POST", "/agents/worker-1/enable", editor)).status).toBe(403);
			expect((await send("POST", "/agents/worker-1/enable", boss)).status).toBe(204);
			expect(await disabledAt("worker-1")).toBeNull();
			expect((await send("POST", "/agents/worker-1/enable", boss)).status).toBe(204);
			expect((await send("POST", "/agents/nobody/disable", boss)).status).toBe(404);
			expect((await send("POST", "/agents/nobody/enable", boss)).status).toBe(404);
		});
	});
});
