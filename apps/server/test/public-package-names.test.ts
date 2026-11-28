// 公共项目里的节点包名字（#501）：升级之后留在别的项目里的 sfly-std 版本由迁移挪进公共项目；之后公共项目里的名字不能在别的项目里发布，
// 别的项目里的名字也不能发布到公共项目（名字这一步仍然全局唯一，第二步在 #502）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, defaultMigrationsDir, openDatabase } from "../src/db/database.js";
import {
	createPackageRepository,
	PackageError,
	publicPackageLockKey,
} from "../src/packages/package-repository.js";
import { DEFAULT_PROJECT, type ProjectId, PUBLIC_PROJECT } from "../src/projects/project-id.js";
import { ManualClock } from "./support/manual-clock.js";
import { migrationsCopy } from "./support/migrations.js";
import { packageArchive, packageMetadata } from "./support/package-archive.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const OTHER = "other-team" as ProjectId;
const AT = "2026-01-01T00:00:00Z";
/** 加这条迁移之前的最后一个迁移（0044）。 */
const LAST_BEFORE = 44;

const archive = (name: string, version: string) =>
	packageArchive(packageMetadata({ name, version }));

describe("公共项目里的节点包名字（#501）", () => {
	let testDb: TestDatabase;
	let database: Database;
	let dataDir: string;
	let packages: ReturnType<typeof createPackageRepository>;

	beforeEach(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ($1, '项目乙', $2)",
			[OTHER, AT],
		);
		dataDir = await mkdtemp(join(tmpdir(), "sfly-public-names-"));
		packages = createPackageRepository({ db: database.db, clock: new ManualClock(), dataDir });
	});
	afterEach(async () => {
		await database.close();
		await testDb.drop();
		await rm(dataDir, { recursive: true, force: true });
	});

	const rejected = async (project: ProjectId, name: string, version = "2.0.0") => {
		const error = await packages.publish(project, archive(name, version), null).catch((e) => e);
		expect(error).toBeInstanceOf(PackageError);
		expect((error as PackageError).kind).toBe("conflict");
		return (error as PackageError).message;
	};

	it("公共项目里已有的名字，默认项目和别的项目都不能发布；发布到公共项目照常", async () => {
		await packages.publish(PUBLIC_PROJECT, archive("sfly-std", "0.4.0"), null);
		for (const project of [DEFAULT_PROJECT, OTHER]) {
			expect(await rejected(project, "sfly-std")).toContain("公共项目里已有节点包 sfly-std");
		}
		await packages.publish(PUBLIC_PROJECT, archive("sfly-std", "0.5.0"), null);
		const rows = await database.pool.query(
			"select project_id from node_packages where name = 'sfly-std' order by version",
		);
		expect(rows.rows.map((r) => r.project_id)).toEqual(["public", "public"]);
	});

	it("别的项目里已有的名字不能发布到公共项目，说明里不写是哪个项目；别的项目之间同名不受这条限制（全局唯一的检查照旧）", async () => {
		await packages.publish(OTHER, archive("team-tools", "1.0.0"), null);
		const message = await rejected(PUBLIC_PROJECT, "team-tools");
		expect(message).toContain("已经有项目发布了名为 team-tools 的节点包");
		expect(message).not.toContain(OTHER);
		// 同一个项目里发布新版本照常。
		await packages.publish(OTHER, archive("team-tools", "1.1.0"), null);
	});

	it("别的项目里发布时也先取这个名字的咨询锁：公共项目那边正在发布同名的包时等它提交，再拒绝（没有锁会两边都通过）", async () => {
		const holder = new pg.Client({ connectionString: testDb.url });
		await holder.connect();
		try {
			await holder.query("begin");
			await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
				publicPackageLockKey("racing-name"),
			]);
			await holder.query(
				`insert into node_packages (name, version, project_id, metadata, file_path, sha256, size, published_at)
				 values ('racing-name', '1.0.0', 'public', '{}'::jsonb, 'packages/racing-name/1.0.0.sflypkg', 'x', 1, now())`,
			);
			const racing = packages.publish(OTHER, archive("racing-name", "2.0.0"), null).catch((e) => e);
			const early = await Promise.race([
				racing.then(() => "done"),
				new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
			]);
			expect(early, "拿不到锁的发布要等着").toBe("waiting");
			await holder.query("commit");
			expect(((await racing) as PackageError).kind).toBe("conflict");
		} finally {
			await holder.query("rollback").catch(() => undefined);
			await holder.end();
		}
	});
});

describe("迁移：把留在别的项目里的 sfly-std 挪进公共项目（#501）", () => {
	let testDb: TestDatabase;
	let before: string;
	beforeEach(async () => {
		testDb = await createTestDatabase();
		before = await migrationsCopy({ upTo: LAST_BEFORE });
	});
	afterEach(async () => {
		await testDb.drop();
		await rm(before, { recursive: true, force: true });
	});

	it("默认项目里的 sfly-std 版本挪进公共项目，公共项目里原有的和别的包不动", async () => {
		const old = openDatabase(testDb.url, () => {}, before);
		await old.migrate();
		const insert = (name: string, version: string, project: string) =>
			old.pool.query(
				`insert into node_packages (name, version, project_id, metadata, file_path, sha256, size, published_at)
				values ($1, $2, $3, $4, $5, 'x', 1, $6)`,
				[
					name,
					version,
					project,
					JSON.stringify(packageMetadata({ name, version })),
					`packages/${name}/${version}.sflypkg`,
					AT,
				],
			);
		await insert("sfly-std", "0.3.0", "public");
		await insert("sfly-std", "0.4.0", "default");
		await insert("my-checks", "1.0.0", "default");
		await old.close();

		const current = openDatabase(testDb.url, () => {}, defaultMigrationsDir);
		await current.migrate();
		const rows = await current.pool.query(
			"select name, version, project_id from node_packages order by name, version",
		);
		await current.close();
		expect(rows.rows).toEqual([
			{ name: "my-checks", version: "1.0.0", project_id: "default" },
			{ name: "sfly-std", version: "0.3.0", project_id: "public" },
			{ name: "sfly-std", version: "0.4.0", project_id: "public" },
		]);
	});
});
