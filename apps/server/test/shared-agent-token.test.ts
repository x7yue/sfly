// 共享令牌登记成默认项目的旧式 Agent 凭据（ADR 0029「迁移与过渡」，规格 #487）：配了 SFLY_AGENT_TOKEN 就登记它的哈希，
// 没配则不登记；这一步还不改变任何接口的行为，Hello 和上传产物照旧比较环境变量里的值。
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSharedAgentToken } from "../src/agents/shared-agent-token.js";
import { hashCredential } from "../src/auth/credential-hash.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane } from "./support/test-control-plane.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("凭据哈希", () => {
	it("存 SHA-256 的小写十六进制，原值查不回", () => {
		expect(hashCredential("sfly_pat_secret")).toBe(sha256("sfly_pat_secret"));
		expect(hashCredential("sfly_pat_secret")).toMatch(/^[0-9a-f]{64}$/);
		expect(hashCredential("a")).not.toBe(hashCredential("b"));
	});
});

describe("控制面启动时登记共享令牌", () => {
	let testDb: TestDatabase;
	let database: Database;
	const clock = new ManualClock();

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
	});
	afterAll(async () => {
		await database.close();
		await testDb.drop();
	});

	const credentials = async () =>
		(
			await database.pool.query(
				`select kind, project_id, agent_name, prefix, user_id, token_hash, revoked_at is not null as revoked
				from agent_credentials order by created_at, token_hash`,
			)
		).rows;

	it("没配共享令牌就不登记", async () => {
		await registerSharedAgentToken(database.db, clock, undefined);
		await registerSharedAgentToken(database.db, clock, "");
		expect(await credentials()).toEqual([]);
	});

	it("配了就登记它的哈希：默认项目、旧式、不限名字；重复启动只有一条，原值不在库里", async () => {
		await registerSharedAgentToken(database.db, clock, "shared-secret");
		await registerSharedAgentToken(database.db, clock, "shared-secret");

		expect(await credentials()).toEqual([
			{
				kind: "shared",
				project_id: "default",
				agent_name: null,
				prefix: null,
				user_id: null,
				token_hash: sha256("shared-secret"),
				revoked: false,
			},
		]);
		const stored = JSON.stringify(
			(await database.pool.query("select * from agent_credentials")).rows,
		);
		expect(stored).not.toContain("shared-secret");
	});

	it("管理员吊销过的这一条不会因为重启又恢复有效", async () => {
		await database.pool.query("update agent_credentials set revoked_at = now()");
		await registerSharedAgentToken(database.db, clock, "shared-secret");
		expect((await credentials()).map((c) => c.revoked)).toEqual([true]);
		await database.pool.query("update agent_credentials set revoked_at = null");
	});

	it("共享令牌换成新值：之前登记的那条随之吊销，新值登记为有效的", async () => {
		await registerSharedAgentToken(database.db, clock, "rotated-secret");
		const revoked = Object.fromEntries((await credentials()).map((c) => [c.token_hash, c.revoked]));
		expect(revoked).toEqual({
			[sha256("shared-secret")]: true,
			[sha256("rotated-secret")]: false,
		});
	});
});

describe("经控制面启动登记", () => {
	it("配了共享令牌的控制面启动后，库里有这一条；没有共享令牌时没有，Agent 照旧能连", async () => {
		const withToken = await startTestControlPlane({ agentToken: "startup-secret" });
		const without = await startTestControlPlane();
		try {
			const read = async (url: string) => {
				const client = new pg.Client({ connectionString: url });
				await client.connect();
				try {
					return (await client.query("select kind, project_id, token_hash from agent_credentials"))
						.rows;
				} finally {
					await client.end();
				}
			};
			expect(await read(withToken.database.url)).toEqual([
				{ kind: "shared", project_id: "default", token_hash: sha256("startup-secret") },
			]);
			expect(await read(without.database.url)).toEqual([]);

			// 重启控制面：仍是一条。Agent 用共享令牌连接的行为没有变。
			await withToken.restart();
			expect(await read(withToken.database.url)).toHaveLength(1);
			const agent = await FakeAgent.connect(withToken.grpcUrl, {
				name: "agent-a",
				token: "startup-secret",
			});
			await agent.disconnect();
			await expect(
				FakeAgent.connect(withToken.grpcUrl, { name: "agent-b", token: "wrong" }),
			).rejects.toThrow();
		} finally {
			await withToken.close();
			await without.close();
		}
	});
});
