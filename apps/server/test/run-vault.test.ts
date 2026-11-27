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

	it("截断的副本（没有完整的 IV 和认证标签、只剩 IV 和标签、少了最后一个字节）：同样是 RunVaultError", () => {
		const sealed = sealRunVault(key, run, VAULT);
		for (const length of [0, 5, 12, 27, 28, sealed.length - 1]) {
			expect(() => openRunVault(key, run, sealed.subarray(0, length)), `长度 ${length}`).toThrow(
				expect.objectContaining({
					name: "RunVaultError",
					message: expect.stringContaining("截断"),
				}),
			);
		}
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

	it("存、改、读、删：每次写之后，库里每张表的文字和副本的原始字节里都没有写过的任何一个原值", async () => {
		// 原值集合、对象里的口令、链实例参数、原样输出、更新时才加进来的值：各自一个标记，每次写之后都查一遍写过的全部。
		const first: RunVault = {
			values: ["mark-set-7f3a91", { password: "mark-nested-c41e" }],
			params: { "chain-1": { token: "mark-param-90bd" } },
			outputs: { "task-1": { url: "https://x.test/?t=mark-output-5a2f" } },
		};
		const written = ["mark-set-7f3a91", "mark-nested-c41e", "mark-param-90bd", "mark-output-5a2f"];
		const leaked = async () => {
			const text = await databaseText(cp.database.url);
			return written.filter((m) =>
				[m, Buffer.from(m).toString("hex"), Buffer.from(m).toString("base64")].some((form) =>
					text.includes(form),
				),
			);
		};
		expect(await db.db.transaction((tx) => vaults.get(tx, run))).toBeUndefined();
		await db.db.transaction((tx) => vaults.put(tx, run, first));
		expect(await leaked()).toEqual([]);
		const grown: RunVault = {
			values: [...first.values, "mark-update-e88c"],
			params: { ...first.params, "chain-2": { key: "mark-update-param-13d0" } },
			outputs: first.outputs,
		};
		written.push("mark-update-e88c", "mark-update-param-13d0");
		await db.db.transaction((tx) => vaults.put(tx, run, grown));
		expect(await leaked()).toEqual([]);
		expect(await db.db.transaction((tx) => vaults.get(tx, run))).toEqual(grown);
		await db.db.transaction((tx) => vaults.delete(tx, run));
		expect(await db.db.transaction((tx) => vaults.get(tx, run))).toBeUndefined();
		expect(await leaked()).toEqual([]);
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
