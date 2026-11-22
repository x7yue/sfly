import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PackageMetadata } from "@sfly/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import type { Clock } from "../clock.js";
import type { Db, Tx } from "../db/database.js";
import { nodePackages } from "../db/schema.js";
import { type ProjectId, PUBLIC_PROJECT, readableProjects } from "../projects/project-id.js";
import { type NodeTypeView, packageWithDefaultCharts } from "./default-charts.js";
import { sameVersion } from "./pep440.js";

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

/** 发布人（ADR 0029）：显示名、用户 ID、经哪个令牌（令牌的名称）；没有带凭据的发布没有（升级之前发布不要任何身份）。 */
export interface Publisher {
	name: string;
	userId: string | null;
	token: string | null;
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

/**
 * 公共项目里同一个名字的版本，按 PEP 440 规范化之后相同的（`0.9` 和 `0.9.0`）只能有一个：控制面的包索引（#556）对同一个
 * 版本只列最早发布的那个，后发布的归档会被悄悄丢在索引外，所以发布时就拒绝，报错写明已有的是哪个，索引里的去重只剩防御作用
 * （升级迁移、手工改库留下的数据）。同一个名字的并发发布排队（咨询锁，随事务释放），不会两个都通过检查。
 * 一模一样的版本（`名字@版本` 相同）由插入时的主键冲突拒绝，信息不同。
 */
async function rejectEquivalentVersion(
	tx: Tx,
	{ name, version }: { name: string; version: string },
): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`sfly:public-package:${name}`}, 0))`,
	);
	const existing = await tx
		.select({ version: nodePackages.version })
		.from(nodePackages)
		.where(and(eq(nodePackages.projectId, PUBLIC_PROJECT), eq(nodePackages.name, name)));
	const same = existing.find((row) => row.version !== version && sameVersion(row.version, version));
	if (same) {
		throw new PackageError(
			"conflict",
			`节点包 ${name}@${version} 和公共项目里已有的 ${name}@${same.version} 是同一个版本（按 PEP 440 规范化之后相同），不能再发布；已发布的版本不能覆盖`,
		);
	}
}

/**
 * 节点包仓库：元信息存 PostgreSQL，归档文件存控制面磁盘。每个节点包版本属于一个项目（ADR 0029）：
 * 发布、列表、按名字取、取归档都要传项目，别的项目的包和不存在一样；公共项目里的包（标准节点包）任何项目都读得到
 * （{@link readableProjects}）。`名字@版本` 仍然全局唯一（主键不变，第二步改成项目内唯一，#502），所以磁盘上的路径
 * （`packages/<名>/<版本>.sflypkg`）暂时不分项目。同一个名字的不同版本可以分属两个项目（例如升级前发布的 `sfly-std`
 * 在公共项目里，之后经默认项目发布的新版本在默认项目里）：按名字取时各版本合在一起。「先找本项目、再找公共项目」的优先顺序
 * （场景和 Agent 下载归档，#501）不在这里。
 */
export function createPackageRepository({ db, clock, dataDir }: PackageRepositoryDeps) {
	return {
		/** 发布节点包到这个项目；`包名@版本` 已存在（第一步：不论哪个项目里已有）时抛出 conflict，已发布的文件不会被覆盖。 */
		async publish(
			project: ProjectId,
			archive: Uint8Array,
			publisher: Publisher | null,
		): Promise<PackageVersion> {
			const metadata = readPackageArchive(archive);
			const sha256 = createHash("sha256").update(archive).digest("hex");
			// 版本格式由 schema 约束（不含路径分隔符），可以直接用作文件名。
			const filePath = join("packages", metadata.name, `${metadata.version}.sflypkg`);

			return db.transaction(async (tx) => {
				if (project === PUBLIC_PROJECT) await rejectEquivalentVersion(tx, metadata);
				const [row] = await tx
					.insert(nodePackages)
					.values({
						name: metadata.name,
						version: metadata.version,
						projectId: project,
						metadata,
						filePath,
						sha256,
						size: archive.byteLength,
						publishedAt: clock.now(),
						publishedBy: publisher?.name ?? null,
						publishedByUserId: publisher?.userId ?? null,
						publishedToken: publisher?.token ?? null,
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

		/** 这个项目读得到的节点包：本项目发布的，加上公共项目里的。 */
		async list(project: ProjectId): Promise<PackageSummary[]> {
			const rows = await db
				.select()
				.from(nodePackages)
				.where(inArray(nodePackages.projectId, readableProjects(project)))
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

		/** 这个项目里按名字取节点包的各个版本（本项目的或公共项目的）；不存在或属于别的项目时返回 undefined。 */
		async get(project: ProjectId, name: string): Promise<PackageSummary | undefined> {
			const rows = await db
				.select()
				.from(nodePackages)
				.where(
					and(
						inArray(nodePackages.projectId, readableProjects(project)),
						eq(nodePackages.name, name),
					),
				)
				.orderBy(desc(nodePackages.publishedAt));
			return rows.length ? { name, versions: rows.map(toSummary) } : undefined;
		},

		/** 这个项目读得到的一个节点包版本；不存在或属于别的项目时返回 undefined。 */
		async getVersion(
			project: ProjectId,
			name: string,
			version: string,
		): Promise<PackageVersion | undefined> {
			const row = await findRow(db, name, version, project);
			return row && toVersion(row);
		},

		/**
		 * 一个项目自己发布的、某个名字的全部版本的归档（按发布时间从旧到新）。只看这个项目，不含公共项目的包
		 * （和 {@link readableProjects} 的范围不同）：控制面的包索引用它列出公共项目里平台自己的包。
		 */
		async archivesIn(
			project: ProjectId,
			name: string,
		): Promise<Array<StoredArchive & { version: string; requiresPython: string }>> {
			const rows = await db
				.select()
				.from(nodePackages)
				.where(and(eq(nodePackages.projectId, project), eq(nodePackages.name, name)))
				.orderBy(asc(nodePackages.publishedAt), asc(nodePackages.version));
			return rows.map((row) => ({
				version: row.version,
				path: join(dataDir, row.filePath),
				sha256: row.sha256,
				size: row.size,
				requiresPython: row.metadata.requires_python,
			}));
		},

		/** 归档文件在磁盘上的位置（供下载）；不存在或属于别的项目时返回 undefined。 */
		async archive(
			project: ProjectId,
			name: string,
			version: string,
		): Promise<StoredArchive | undefined> {
			const row = await findRow(db, name, version, project);
			return row && { path: join(dataDir, row.filePath), sha256: row.sha256, size: row.size };
		},
	};
}

export type PackageRepository = ReturnType<typeof createPackageRepository>;

/**
 * 一个节点包版本，不看它属于哪个项目：场景文档里按名字引用的包（保存时的静态检查、预检、派发）只带名字和版本，
 * 名字现在全局唯一，按名字找就够；改成「本项目、再公共项目」的解析之后（#501、#502）这里要带项目。
 * 数据库由调用方传：在事务里读时传事务对象，不要另从连接池取连接。
 */
export async function findPackageVersion(
	db: Db | Tx,
	name: string,
	version: string,
): Promise<PackageVersion | undefined> {
	const row = await findRow(db, name, version);
	return row && toVersion(row);
}

async function findRow(
	db: Db | Tx,
	name: string,
	version: string,
	project?: ProjectId,
): Promise<Row | undefined> {
	const [row] = await db
		.select()
		.from(nodePackages)
		.where(
			and(
				eq(nodePackages.name, name),
				eq(nodePackages.version, version),
				...(project === undefined
					? []
					: [inArray(nodePackages.projectId, readableProjects(project))]),
			),
		);
	return row;
}
