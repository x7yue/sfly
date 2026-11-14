import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PackageMetadata } from "@sfly/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { nodePackages } from "../db/schema.js";
import { type NodeTypeView, packageWithDefaultCharts } from "./default-charts.js";

/** 节点包归档内的元信息文件名（与 sfly CLI 一致）。 */
export const METADATA_FILE = "sfly-package.json";

export type PackageErrorKind = "invalid_package" | "conflict";

export class PackageError extends Error {
	constructor(
		readonly kind: PackageErrorKind,
		message: string,
	) {
		super(message);
	}
}

export interface PackageVersion {
	name: string;
	version: string;
	sha256: string;
	size: number;
	published_at: string;
	/** 元信息；节点类型的图表含为未被引用的指标生成的默认图表。 */
	metadata: Omit<PackageMetadata, "nodes"> & { nodes: NodeTypeView[] };
}

export interface PackageVersionSummary {
	version: string;
	sha256: string;
	size: number;
	published_at: string;
	nodes: { name: string; title: string; description?: string }[];
}

export interface PackageSummary {
	name: string;
	/** 按发布时间从新到旧。 */
	versions: PackageVersionSummary[];
}

export interface StoredArchive {
	path: string;
	sha256: string;
	size: number;
}

type Row = typeof nodePackages.$inferSelect;

const toVersion = (row: Row): PackageVersion => ({
	name: row.name,
	version: row.version,
	sha256: row.sha256,
	size: row.size,
	published_at: row.publishedAt.toISOString(),
	metadata: packageWithDefaultCharts(row.metadata),
});

const toSummary = (row: Row): PackageVersionSummary => ({
	version: row.version,
	sha256: row.sha256,
	size: row.size,
	published_at: row.publishedAt.toISOString(),
	nodes: row.metadata.nodes.map((n) => ({
		name: n.name,
		title: n.title,
		...(n.description !== undefined && { description: n.description }),
	})),
});

/** 解析并校验节点包归档：根目录下恰好一个 sfly-package.json 和一个 wheel。 */
export function readPackageArchive(archive: Uint8Array): PackageMetadata {
	const wheels: string[] = [];
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(archive, {
			filter: (file) => {
				if (!file.name.includes("/") && file.name.endsWith(".whl")) wheels.push(file.name);
				return file.name === METADATA_FILE;
			},
		});
	} catch {
		throw new PackageError("invalid_package", "节点包不是有效的 zip 归档");
	}

	const raw = entries[METADATA_FILE];
	if (!raw) throw new PackageError("invalid_package", `节点包缺少 ${METADATA_FILE}`);
	if (wheels.length !== 1) {
		throw new PackageError(
			"invalid_package",
			`节点包必须恰好包含一个 wheel，实际 ${wheels.length} 个`,
		);
	}

	let json: unknown;
	try {
		json = JSON.parse(strFromU8(raw));
	} catch {
		throw new PackageError("invalid_package", `${METADATA_FILE} 不是合法的 JSON`);
	}
	const parsed = PackageMetadata.safeParse(json);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`);
		throw new PackageError("invalid_package", `元信息校验失败：${issues.join("；")}`);
	}
	const seen = new Set<string>();
	for (const node of parsed.data.nodes) {
		if (seen.has(node.name)) {
			throw new PackageError("invalid_package", `节点名 ${node.name} 重复`);
		}
		seen.add(node.name);
	}
	return parsed.data;
}

export interface PackageRepositoryDeps {
	db: Db;
	clock: Clock;
	/** 控制面数据目录；节点包文件存放在其下的 packages/。 */
	dataDir: string;
}

/** 节点包仓库：元信息存 PostgreSQL，归档文件存控制面磁盘。 */
export function createPackageRepository({ db, clock, dataDir }: PackageRepositoryDeps) {
	return {
		/** 发布节点包；`包名@版本` 已存在时抛出 conflict，已发布的文件不会被覆盖。 */
		async publish(archive: Uint8Array): Promise<PackageVersion> {
			const metadata = readPackageArchive(archive);
			const sha256 = createHash("sha256").update(archive).digest("hex");
			// 版本格式由 schema 约束（不含路径分隔符），可以直接用作文件名。
			const filePath = join("packages", metadata.name, `${metadata.version}.sflypkg`);

			return db.transaction(async (tx) => {
				const [row] = await tx
					.insert(nodePackages)
					.values({
						name: metadata.name,
						version: metadata.version,
						metadata,
						filePath,
						sha256,
						size: archive.byteLength,
						publishedAt: clock.now(),
					})
					.onConflictDoNothing()
					.returning();
				if (!row) {
					throw new PackageError(
						"conflict",
						`节点包 ${metadata.name}@${metadata.version} 已存在，不能覆盖已发布的版本`,
					);
				}
				// 先写临时文件再改名；事务提交前失败会回滚记录。
				const target = join(dataDir, filePath);
				const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
				await mkdir(dirname(target), { recursive: true });
				try {
					await writeFile(tmp, archive);
					await rename(tmp, target);
				} catch (error) {
					await rm(tmp, { force: true });
					throw error;
				}
				return toVersion(row);
			});
		},

		async list(): Promise<PackageSummary[]> {
			const rows = await db
				.select()
				.from(nodePackages)
				.orderBy(asc(nodePackages.name), desc(nodePackages.publishedAt));
			const byName = new Map<string, PackageSummary>();
			for (const row of rows) {
				let pkg = byName.get(row.name);
				if (!pkg) {
					pkg = { name: row.name, versions: [] };
					byName.set(row.name, pkg);
				}
				pkg.versions.push(toSummary(row));
			}
			return [...byName.values()];
		},

		async get(name: string): Promise<PackageSummary | undefined> {
			const rows = await db
				.select()
				.from(nodePackages)
				.where(eq(nodePackages.name, name))
				.orderBy(desc(nodePackages.publishedAt));
			return rows.length ? { name, versions: rows.map(toSummary) } : undefined;
		},

		async getVersion(name: string, version: string): Promise<PackageVersion | undefined> {
			const row = await findRow(db, name, version);
			return row && toVersion(row);
		},

		/** 归档文件在磁盘上的位置（供下载）。 */
		async archive(name: string, version: string): Promise<StoredArchive | undefined> {
			const row = await findRow(db, name, version);
			return row && { path: join(dataDir, row.filePath), sha256: row.sha256, size: row.size };
		},
	};
}

export type PackageRepository = ReturnType<typeof createPackageRepository>;

async function findRow(db: Db, name: string, version: string): Promise<Row | undefined> {
	const [row] = await db
		.select()
		.from(nodePackages)
		.where(and(eq(nodePackages.name, name), eq(nodePackages.version, version)));
	return row;
}
