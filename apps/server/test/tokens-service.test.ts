// 令牌服务和访问存储的两处边界（规格 #491 的变异检查发现 HTTP 层的测试够不着它们）：
// - 项目令牌的范围不能超过签发人的范围：现在只有项目管理员能签（他有全部范围），超出的情况走不到，
//   所以在服务层直接给一个范围更窄的签发人（以后加「只管理令牌、不能运行」这类角色就是这样）；
// - 「最后使用时间」每分钟最多写一次，「到没到时间」放在更新语句的条件里：并发的请求里只有一个写成功，
//   不靠进程里的表。HTTP 层的测试里访问检查先在内存里判断过一遍，数据库这一条条件拿掉也看不出来，所以直接测存储。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbAccessStore } from "../src/auth/access-store.js";
import { hashCredential } from "../src/auth/credential-hash.js";
import { RevocationBus } from "../src/auth/revocations.js";
import { TokenService } from "../src/auth/tokens.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { apiTokens } from "../src/db/schema.js";
import { parseProjectId } from "../src/projects/project-id.js";
import { ManualClock } from "./support/manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const DEFAULT = parseProjectId("default");
const MINUTE = 60_000;

describe("令牌服务和访问存储", () => {
	let testDb: TestDatabase;
	let database: Database;
	let clock: ManualClock;
	let tokens: TokenService;

	beforeEach(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		clock = new ManualClock();
		tokens = new TokenService({ db: database.db, clock, revocations: new RevocationBus() });
	});
	afterEach(async () => {
		await database?.close();
		await testDb?.drop();
	});

	const project = () => {
		if (DEFAULT === undefined) throw new Error("默认项目的标识写不对");
		return DEFAULT;
	};
	/** 签发人：库里要有这个用户（令牌行的签发人是指向用户的外键）。 */
	let issuer: { id: string; displayName: string };
	beforeEach(async () => {
		const id = crypto.randomUUID();
		await database.pool.query(
			`insert into users (id, login_name, display_name, password_hash, is_platform_admin, created_at)
			values ($1, 'issuer', '签发人', 'scrypt$placeholder', false, now())`,
			[id],
		);
		issuer = { id, displayName: "签发人" };
	});

	describe("签发项目令牌：范围不超过签发人此刻的范围，也不能带「管理」", () => {
		it("签发人的范围比要的窄：scope_exceeds_role，说明超出了哪些、签发人能有哪些；没有签出令牌", async () => {
			// 签发人有「管理」（才能签项目令牌）和「读」，没有「运行」「编辑」。
			const result = await tokens.issueProject(
				project(),
				{ name: "自动化", scopes: ["read", "run", "edit"] },
				["read", "manage"],
				issuer,
			);
			expect(result).toEqual({
				ok: false,
				reason: "scope_exceeds_role",
				excess: ["run", "edit"],
				allowed: ["read"],
			});
			expect(await database.db.select().from(apiTokens)).toHaveLength(0);
		});

		it("没超过：签出；签发人的「管理」不会被带进项目令牌", async () => {
			const result = await tokens.issueProject(
				project(),
				{ name: "只读", scopes: ["read"] },
				["read", "run", "manage"],
				issuer,
			);
			expect(result.ok).toBe(true);
			const [row] = await database.db.select().from(apiTokens);
			expect(row?.scopes).toEqual(["read"]);
		});

		it("要「管理」：即使签发人有，也是 manage_scope_not_allowed（成员和角色的管理只能由人做）", async () => {
			const result = await tokens.issueProject(
				project(),
				{ name: "想管理", scopes: ["read", "manage"] },
				["read", "run", "edit", "session_build", "publish", "manage"],
				issuer,
			);
			expect(result).toEqual({ ok: false, reason: "manage_scope_not_allowed" });
			expect(await database.db.select().from(apiTokens)).toHaveLength(0);
		});
	});

	describe("项目令牌记着签发人", () => {
		it("记在令牌行上，列出时带显示名；个人令牌不记；签发人之后被停用，令牌照样有效、签发人还在", async () => {
			const result = await tokens.issueProject(
				project(),
				{ name: "ci", scopes: ["read"] },
				["read", "manage"],
				issuer,
			);
			if (!result.ok) throw new Error(`签发失败：${result.reason}`);
			expect(result.issued.view.issued_by).toBe("签发人");
			const [row] = await database.db.select().from(apiTokens);
			expect(row?.issuedByUserId).toBe(issuer.id);
			expect(row?.userId).toBeNull();
			const listed = await tokens.listProject(project());
			expect(listed.map((t) => [t.name, t.issued_by])).toEqual([["ci", "签发人"]]);
			// 签发人被停用：项目令牌不随他失效（属于项目），记录还在，列出时仍然看得到是谁签的。
			await database.pool.query("update users set disabled_at = now() where id = $1", [issuer.id]);
			const store = new DbAccessStore(database.db);
			const found = await store.tokenByHash(hashCredential(result.issued.token));
			expect(found?.kind).toBe("project");
			expect(found?.revokedAt).toBeNull();
			expect((await tokens.listProject(project()))[0]?.issued_by).toBe("签发人");
		});
	});

	describe("最后使用时间（AccessStore.touchToken）：条件在更新语句里", () => {
		async function aToken() {
			const result = await tokens.issueProject(
				project(),
				{ name: "节流", scopes: ["read"] },
				["read", "manage"],
				issuer,
			);
			if (!result.ok) throw new Error(`签发失败：${result.reason}`);
			return result.issued.view.id;
		}
		const lastUsed = async (id: string) => {
			const rows = await database.db.select().from(apiTokens);
			return rows.find((row) => row.id === id)?.lastUsedAt ?? null;
		};

		it("从没用过：写；一个间隔之内再来：不写（返回 false，值不变）；满一个间隔：写", async () => {
			const store = new DbAccessStore(database.db);
			const id = await aToken();
			const t0 = clock.now();
			expect(await store.touchToken(id, t0, MINUTE)).toBe(true);
			expect(await lastUsed(id)).toEqual(t0);
			const early = new Date(t0.getTime() + MINUTE - 1);
			expect(await store.touchToken(id, early, MINUTE)).toBe(false);
			expect(await lastUsed(id)).toEqual(t0);
			const due = new Date(t0.getTime() + MINUTE);
			expect(await store.touchToken(id, due, MINUTE)).toBe(true);
			expect(await lastUsed(id)).toEqual(due);
		});

		it("并发的请求同时到点：只有一个写成功，其余返回 false（不靠进程里的表）", async () => {
			const store = new DbAccessStore(database.db);
			const id = await aToken();
			await store.touchToken(id, clock.now(), MINUTE);
			const later = new Date(clock.now().getTime() + 5 * MINUTE);
			const results = await Promise.all(
				Array.from({ length: 12 }, () => store.touchToken(id, later, MINUTE)),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
			expect(await lastUsed(id)).toEqual(later);
		});

		it("没有这个令牌：返回 false，不报错", async () => {
			const store = new DbAccessStore(database.db);
			expect(
				await store.touchToken("00000000-0000-4000-8000-000000000000", clock.now(), MINUTE),
			).toBe(false);
		});
	});
});
