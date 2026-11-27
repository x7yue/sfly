import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/database.js";
import { vaultKey } from "../src/db/vault-schema.js";
import { RunVaults } from "../src/secrets/run-vault.js";
import { openVaultKey, VAULT_KEY_FILE, VaultKeyError } from "../src/secrets/vault-key.js";
import { seedTask } from "./support/seed-task.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

describe("钥匙文件（#505）：首次启动时生成，之后和库里记的指纹对照", () => {
	let database: TestDatabase;
	let opened: Database;
	let dataDir: string;

	beforeAll(async () => {
		database = await createTestDatabase();
		opened = openDatabase(database.url, () => {});
		await opened.migrate();
	});
	afterAll(async () => {
		await opened.close();
		await database.drop();
	});
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "sfly-vault-key-"));
		await opened.db.delete(vaultKey);
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});
	const file = () => join(dataDir, VAULT_KEY_FILE);
	const refused = (pattern: RegExp) =>
		expect(openVaultKey(dataDir, opened.db)).rejects.toThrow(
			expect.objectContaining({ name: "VaultKeyError", message: expect.stringMatching(pattern) }),
		);

	it("第一次：生成 32 字节、只有属主可读写的文件；再打开拿到同一把钥匙", async () => {
		const key = await openVaultKey(dataDir, opened.db);
		expect(key).toHaveLength(32);
		expect((await stat(file())).mode & 0o777).toBe(0o600);
		expect(await readFile(file())).toEqual(key);
		expect(await openVaultKey(dataDir, opened.db)).toEqual(key);
		const [row] = await opened.db.select().from(vaultKey);
		expect(row?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
	});

	it("文件不见了：拒绝，说明写明文件和怎么恢复，不悄悄生成一把新的", async () => {
		await openVaultKey(dataDir, opened.db);
		await rm(file());
		await refused(/secrets\.key 不见了.*从备份放回原来的钥匙文件/);
		await expect(stat(file())).rejects.toThrow(expect.objectContaining({ code: "ENOENT" }));
	});

	it("文件换了一把：拒绝", async () => {
		await openVaultKey(dataDir, opened.db);
		await writeFile(file(), randomBytes(32), { mode: 0o600 });
		await refused(/secrets\.key 被换过/);
	});

	it("别的用户也能读：拒绝，写明 chmod 600", async () => {
		await openVaultKey(dataDir, opened.db);
		await chmod(file(), 0o644);
		await refused(/权限 644.*chmod 600/);
	});

	it("长度不对：拒绝", async () => {
		await openVaultKey(dataDir, opened.db);
		await writeFile(file(), randomBytes(16), { mode: 0o600 });
		await refused(/不是 32 字节（是 16 字节）/);
	});

	it("有文件、库里没记、也没有加密的副本：记下它的指纹，照常启动", async () => {
		const key = randomBytes(32);
		await writeFile(file(), key, { mode: 0o600 });
		expect(await openVaultKey(dataDir, opened.db)).toEqual(key);
		expect(await opened.db.select().from(vaultKey)).toHaveLength(1);
	});

	it("拒绝的说明是 VaultKeyError：控制面的入口按它只打印说明，不打印堆栈", async () => {
		await openVaultKey(dataDir, opened.db);
		await rm(file());
		await expect(openVaultKey(dataDir, opened.db)).rejects.toBeInstanceOf(VaultKeyError);
	});
});

describe("控制面启动时检查钥匙文件", () => {
	let cp: TestControlPlane;
	beforeEach(async () => {
		cp = await startTestControlPlane();
	});
	afterEach(async () => {
		await cp.close();
	});

	it("钥匙文件不见了：重启失败，不带着读不出的副本接着跑", async () => {
		const file = join(cp.dataDir, VAULT_KEY_FILE);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		await expect(cp.restart(() => rm(file))).rejects.toThrow(/secrets\.key 不见了/);
	});

	it("库里有加密的副本、没记钥匙（数据库和数据目录不是同一套）：重启失败", async () => {
		const { run } = await seedTask(cp, { agent: "agent-a", status: "running" });
		const file = join(cp.dataDir, VAULT_KEY_FILE);
		const vaults = new RunVaults(await readFile(file));
		const opened = openDatabase(cp.database.url, () => {});
		try {
			await opened.db.transaction((tx) =>
				vaults.put(tx, run, { values: ["s3cr3t"], params: {}, outputs: {} }),
			);
			await opened.db.delete(vaultKey);
		} finally {
			await opened.close();
		}
		await expect(cp.restart()).rejects.toThrow(/secrets\.key 和数据库对不上/);
	});
});
