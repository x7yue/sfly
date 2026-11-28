import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newestVersion } from "@sfly/orchestration";
import {
	hasSessionBuildTag,
	isSessionBuildOf,
	PackageMetadata,
	type SessionBuildView,
	sessionBuildTag,
} from "@sfly/schema";
import { and, asc, desc, eq, inArray, isNull, not, or, type SQL, sql } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import type { Clock } from "../clock.js";
import type { Db, Tx } from "../db/database.js";
import { nodePackages, sessions } from "../db/schema.js";
import { type ProjectId, PUBLIC_PROJECT, readableProjects } from "../projects/project-id.js";
import { type NodeTypeView, packageWithDefaultCharts } from "./default-charts.js";
import { sameVersion } from "./pep440.js";

/** 节点包归档内的元信息文件名（与 sfly CLI 一致）。 */
export const METADATA_FILE = "sfly-package.json";

export type PackageErrorKind = "invalid_package" | "conflict" | "session_ended";

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
	/** 在公共项目里（#501）。 */
	public: boolean;
	/** 最新版本：按版本号比较，不是发布时间（@sfly/orchestration 的 `newestVersion`，#434）。 */
	latest_version: string;
	/** 按发布时间从新到旧。 */
	versions: PackageVersionSummary[];
}

/** 一个节点包的摘要：各版本按发布时间从新到旧（调用方排好），最新版本按版本号。 */
function summaryOf(name: string, rows: readonly Row[]): PackageSummary {
	const versions = rows.map(toSummary);
	return {
		name,
		public: rows.some((r) => r.projectId === PUBLIC_PROJECT),
		latest_version: newestVersion(versions.map((v) => v.version)) ?? "",
		versions,
	};
}

/** 发布人（ADR 0029）：显示名、用户 ID、经哪个令牌（令牌的名称）；没有带凭据的发布没有（升级之前发布不要任何身份）。 */
export interface Publisher {
	name: string;
	userId: string | null;
	token: string | null;
}

/**
 * 按场景版本找它锁定的节点包版本时看得到哪些（#795）：正式版本，加上这个会话的会话构建（会话没有结束时）。
 * `session` 是场景版本所属的会话（`orchestration_versions.session_id`），不属于会话的版本是 null，只看得到正式版本。
 * `"any"`：已经存在的运行读它用的版本（派发、下载归档、运行页上的节点类型），会话构建在回收之前都看得到。
 */
export type BuildScope = { session: string | null } | "any";

/** {@link BuildScope} 写成查询条件。 */
function buildScopeCondition(scope: BuildScope): SQL | undefined {
	if (scope === "any") return undefined;
	if (scope.session === null) return isNull(nodePackages.sessionId);
	return or(
		isNull(nodePackages.sessionId),
		and(
			eq(nodePackages.sessionId, scope.session),
			sql`exists (select 1 from ${sessions} where ${sessions.id} = ${scope.session} and ${sessions.status} <> 'ended')`,
		),
	);
}

/** 登记会话构建（`sessionBuilds`）时的会话：它的 ID，版本号的标签要是它的。 */
export interface BuildSession {
	id: string;
}

/**
 * 版本号的本地标签和会话构建对不对得上：正式版本不能带会话构建的标签（ADR 0029「会话构建和正式版本走两个接口」），
 * 会话构建要带这个会话的标签（`s<会话 ID 去掉连字符>.<序号>`）。
 */
function sessionTagProblem(version: string, session: BuildSession | undefined): string | undefined {
	if (session === undefined) {
		return hasSessionBuildTag(version)
			? `版本号 ${version} 带着会话构建的标签：会话构建用 sfly publish --session-build 登记到会话下，正式版本的版本号不能带它`
			: undefined;
	}
	return isSessionBuildOf(version, session.id)
		? undefined
		: `会话构建的版本号要带这个会话的标签：<基础版本>+${sessionBuildTag(session.id)}.<序号>（序号是不带前导零的整数），收到 ${version}`;
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

/** 公共项目里发布同一个名字的咨询锁的键（测试要拿同一把锁来排出确定的先后，所以导出）。 */
export const publicPackageLockKey = (name: string) => `sfly:public-package:${name}`;

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
		sql`select pg_advisory_xact_lock(hashtextextended(${publicPackageLockKey(name)}, 0))`,
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
 * 公共项目里的名字不和别的项目里的名字重（#501；名字这一步仍然全局唯一，第二步在 #502）：场景按名字引用节点包，同名时
 * 先找本项目还是公共项目说不清。往别的项目发布公共项目里已有的名字、往公共项目发布别的项目里已有的名字都拒绝；
 * 后一种不说是哪个项目。同一个名字的发布排队（和 {@link rejectEquivalentVersion} 同一把咨询锁），不会两边同时通过。
 */
async function rejectNameAcrossPublic(tx: Tx, project: ProjectId, name: string): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${publicPackageLockKey(name)}, 0))`,
	);
	const inPublic = eq(nodePackages.projectId, PUBLIC_PROJECT);
	const [clash] = await tx
		.select({ projectId: nodePackages.projectId })
		.from(nodePackages)
		.where(and(eq(nodePackages.name, name), project === PUBLIC_PROJECT ? not(inPublic) : inPublic))
		.limit(1);
	if (clash === undefined) return;
	throw new PackageError(
		"conflict",
		project === PUBLIC_PROJECT
			? `已经有项目发布了名为 ${name} 的节点包：公共项目里不能发布和别的项目同名的包，换一个名字`
			: `公共项目里已有节点包 ${name}（任何项目都能直接用它）：别的项目里不能发布同名的包，换一个名字；发布它的新版本要发布到公共项目（只有平台管理员能发布）`,
	);
}

/**
 * 节点包仓库：元信息存 PostgreSQL，归档文件存控制面磁盘。每个节点包版本属于一个项目（ADR 0029）：
 * 发布、列表、按名字取、取归档都要传项目，别的项目的包和不存在一样；公共项目里的包（标准节点包）任何项目都读得到
 * （{@link readableProjects}）。`名字@版本` 仍然全局唯一（主键不变，第二步改成项目内唯一，#502），所以磁盘上的路径
 * （`packages/<名>/<版本>.sflypkg`）暂时不分项目。公共项目里的名字不能在别的项目里发布，反过来也一样
 * （{@link rejectNameAcrossPublic}，#501），所以一个名字要么在公共项目里，要么在别的项目里（同一个名字的不同版本可以分属
 * 别的几个项目）：按名字取时本项目和公共项目里的版本合在一起，不会两边都有。
 */
export function createPackageRepository({ db, clock, dataDir }: PackageRepositoryDeps) {
	return {
		/**
		 * 发布节点包到这个项目；`包名@版本` 已存在（第一步：不论哪个项目里已有）时抛出 conflict，已发布的文件不会被覆盖。
		 * 带 `session` 时是登记这个会话的会话构建（#795）：版本号要带这个会话的标签，会话已结束时抛出 session_ended；
		 * 不带时版本号不能带会话构建的标签。
		 */
		async publish(
			project: ProjectId,
			archive: Uint8Array,
			publisher: Publisher | null,
			session?: BuildSession,
		): Promise<PackageVersion> {
			const metadata = readPackageArchive(archive);
			const tagProblem = sessionTagProblem(metadata.version, session);
			if (tagProblem) throw new PackageError("invalid_package", tagProblem);
			const sha256 = createHash("sha256").update(archive).digest("hex");
			// 版本格式由 schema 约束（不含路径分隔符），可以直接用作文件名。
			const filePath = join("packages", metadata.name, `${metadata.version}.sflypkg`);

			return db.transaction(async (tx) => {
				if (session) {
					const [row] = await tx
						.select({ status: sessions.status })
						.from(sessions)
						.where(eq(sessions.id, session.id));
					if (row?.status === "ended") {
						throw new PackageError("session_ended", "会话已经结束，不能再登记会话构建");
					}
				}
				await rejectNameAcrossPublic(tx, project, metadata.name);
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
						sessionId: session?.id ?? null,
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

		/** 这个项目读得到的节点包：本项目发布的，加上公共项目里的。会话构建不在里面（#795）。 */
		async list(project: ProjectId): Promise<PackageSummary[]> {
			const rows = await db
				.select()
				.from(nodePackages)
				.where(
					and(
						inArray(nodePackages.projectId, readableProjects(project)),
						isNull(nodePackages.sessionId),
					),
				)
				.orderBy(asc(nodePackages.name), desc(nodePackages.publishedAt));
			const byName = new Map<string, Row[]>();
			for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
			return [...byName].map(([name, versions]) => summaryOf(name, versions));
		},

		/** 这个项目里按名字取节点包的各个版本（本项目的或公共项目的，不含会话构建）；不存在或属于别的项目时返回 undefined。 */
		async get(project: ProjectId, name: string): Promise<PackageSummary | undefined> {
			const rows = await db
				.select()
				.from(nodePackages)
				.where(
					and(
						inArray(nodePackages.projectId, readableProjects(project)),
						eq(nodePackages.name, name),
						isNull(nodePackages.sessionId),
					),
				)
				.orderBy(desc(nodePackages.publishedAt));
			return rows.length ? summaryOf(name, rows) : undefined;
		},

		/** 这个项目读得到的一个节点包版本（不含会话构建）；不存在或属于别的项目时返回 undefined。 */
		async getVersion(
			project: ProjectId,
			name: string,
			version: string,
		): Promise<PackageVersion | undefined> {
			const row = await findRow(db, name, version, project, { session: null });
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

		/** 一个会话登记的会话构建（#795），按登记时间从新到旧；已经回收的不在里面。 */
		async sessionBuilds(sessionId: string): Promise<SessionBuildView[]> {
			const rows = await db
				.select()
				.from(nodePackages)
				.where(eq(nodePackages.sessionId, sessionId))
				.orderBy(desc(nodePackages.publishedAt), asc(nodePackages.name));
			return rows.map((row) => ({
				name: row.name,
				version: row.version,
				sha256: row.sha256,
				size: row.size,
				registered_at: row.publishedAt.toISOString(),
			}));
		},

		/** 归档文件在磁盘上的位置（供下载，会话构建回收之前也在）；不存在或属于别的项目时返回 undefined。 */
		async archive(
			project: ProjectId,
			name: string,
			version: string,
		): Promise<StoredArchive | undefined> {
			const row = await findRow(db, name, version, project, "any");
			return row && { path: join(dataDir, row.filePath), sha256: row.sha256, size: row.size };
		},
	};
}

export type PackageRepository = ReturnType<typeof createPackageRepository>;

/**
 * 这个项目读得到的一个节点包版本（本项目发布的，或公共项目里的）；别的项目里发布的和不存在一样。
 * 场景文档里按名字引用的包（保存时的静态检查、局部编辑、触发前的预检）只带名字和版本，解析它们用的是
 * 和包的列表、详情、归档下载同一个范围（{@link readableProjects}）：这一个函数，不另写。
 * 数据库由调用方传：在事务里读时传事务对象，不要另从连接池取连接。
 */
export async function findPackageVersion(
	db: Db | Tx,
	project: ProjectId,
	name: string,
	version: string,
	scope: BuildScope,
): Promise<PackageVersion | undefined> {
	const row = await findRow(db, name, version, project, scope);
	return row && toVersion(row);
}

/**
 * 同 {@link findPackageVersion}（同一个范围），返回库里存的原始元信息，没有加平台生成的默认图表：
 * 节点类型的声明（指标、图表、超时）读它，默认图表由读它的人按需加（`nodeTypeView`）。
 */
export async function findPackageMetadata(
	db: Db | Tx,
	project: ProjectId,
	name: string,
	version: string,
	scope: BuildScope,
): Promise<PackageMetadata | undefined> {
	return (await findRow(db, name, version, project, scope))?.metadata;
}

async function findRow(
	db: Db | Tx,
	name: string,
	version: string,
	project: ProjectId,
	scope: BuildScope,
): Promise<Row | undefined> {
	const [row] = await db
		.select()
		.from(nodePackages)
		.where(
			and(
				eq(nodePackages.name, name),
				eq(nodePackages.version, version),
				inArray(nodePackages.projectId, readableProjects(project)),
				buildScopeCondition(scope),
			),
		);
	return row;
}
