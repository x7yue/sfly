import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { openRunVault, type RunVault, RunVaults, sealRunVault } from "../src/secrets/run-vault.js";
import { seedTask } from "./support/seed-task.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECRET = "tok-9f2c4a81e7";
const VAULT: RunVault = {
	values: [SECRET, { password: "hunter2-long" }],
	params: { "chain-1": { token: SECRET } },
	outputs: { "task-1": { url: `https://x.test/?t=${SECRET}` } },
};

describe("运行的加密副本：加密和解开（#505）", () => {
	const key = randomBytes(32);
	const run = randomUUID();

	it("同一把钥匙、同一个运行解得开，内容原样", () => {
		expect(openRunVault(key, run, sealRunVault(key, run, VAULT))).toEqual(VAULT);
	});

	it("每次加密的结果都不一样（随机 IV），密文里没有原值", () => {
		const a = sealRunVault(key, run, VAULT);
		const b = sealRunVault(key, run, VAULT);
		expect(a.equals(b)).toBe(false);
		expect(a.includes(SECRET)).toBe(false);
		expect(a.toString("base64")).not.toContain(Buffer.from(SECRET).toString("base64"));
	});

	it("换了钥匙、挪到别的运行上、改过一个字节：都解不开", () => {
		const sealed = sealRunVault(key, run, VAULT);
		const tampered = Buffer.from(sealed);
		tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
		for (const [k, r, s] of [
			[randomBytes(32), run, sealed],
			[key, randomUUID(), sealed],
			[key, run, tampered],
		] as const) {
			expect(() => openRunVault(k, r, s)).toThrow(
				expect.objectContaining({
					name: "RunVaultError",
					message: expect.stringContaining("解不开"),
				}),
			);
		}
	});
});

describe("运行的加密副本：存在库里", () => {
	let cp: TestControlPlane;
	let run: string;
	let db: ReturnType<typeof openDatabase>;
	const vaults = new RunVaults(randomBytes(32));

	beforeAll(async () => {
		cp = await startTestControlPlane();
		({ run } = await seedTask(cp, { agent: "agent-a", status: "running" }));
		db = openDatabase(cp.database.url, () => {});
	});
	afterAll(async () => {
		await db.close();
		await cp.close();
	});

	it("存、改、读、删；库里任何一张表的文字里都没有原值", async () => {
		expect(await db.db.transaction((tx) => vaults.get(tx, run))).toBeUndefined();
		await db.db.transaction((tx) => vaults.put(tx, run, VAULT));
		const grown = { ...VAULT, values: [...VAULT.values, "second-value-77"] };
		await db.db.transaction((tx) => vaults.put(tx, run, grown));
		expect(await db.db.transaction((tx) => vaults.get(tx, run))).toEqual(grown);
		expect(await databaseText(cp.database.url)).not.toContain(SECRET);
		await db.db.transaction((tx) => vaults.delete(tx, run));
		expect(await db.db.transaction((tx) => vaults.get(tx, run))).toBeUndefined();
	});

	it("运行删了，副本跟着删", async () => {
		await db.db.transaction((tx) => vaults.put(tx, run, VAULT));
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query(
				"delete from tasks where chain_instance_id in (select id from chain_instances where run_id = $1)",
				[run],
			);
			await client.query("delete from chain_instances where run_id = $1", [run]);
			await client.query("delete from runs where id = $1", [run]);
			const { rows } = await client.query("select count(*)::int as n from run_vaults");
			expect(rows[0].n).toBe(0);
		} finally {
			await client.end();
		}
	});
});

/** 库里 public 下每张表每一行的文字，加上 `run_vaults.sealed` 的原始字节（当作文字读）。 */
async function databaseText(url: string): Promise<string> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const { rows: tables } = await client.query<{ name: string }>(
			"select tablename as name from pg_tables where schemaname = 'public'",
		);
		const parts: string[] = [];
		for (const { name } of tables) {
			const { rows } = await client.query<{ row: string }>(
				`select t::text as row from "${name}" t`,
			);
			parts.push(...rows.map((r) => r.row));
		}
		const { rows: sealed } = await client.query<{ sealed: Buffer }>(
			"select sealed from run_vaults",
		);
		parts.push(...sealed.map((r) => r.sealed.toString("latin1")));
		return parts.join("\n");
	} finally {
		await client.end();
	}
}
