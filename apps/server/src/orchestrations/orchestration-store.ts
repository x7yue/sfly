import { randomUUID } from "node:crypto";
import { ensureLayout, fillMissingPositions } from "@sfly/orchestration";
import type {
	OrchestrationDocument,
	OrchestrationView,
	RunNotificationChanges,
} from "@sfly/schema";
import { and, count, desc, eq } from "drizzle-orm";
import type { Actor } from "../actor.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { orchestrations, orchestrationVersions, runs } from "../db/schema.js";
import { copyPresets } from "../presets/preset-store.js";

export type { OrchestrationView };

export interface OrchestrationVersionView {
	id: string;
	orchestration_id: string;
	number: number;
	author: string;
	/** 经哪个 AI 编程助手保存；浏览器里保存的为 null。 */
	author_via: string | null;
	created_at: string;
	document: OrchestrationDocument;
}

/** 编辑起点：最新版本；还没有版本时是只含入口节点的初始文档（number 为 0）。 */
export interface OrchestrationHeadView {
	orchestration_id: string;
	number: number;
	author: string | null;
	author_via: string | null;
	created_at: string | null;
	document: OrchestrationDocument;
}

/** 版本历史列表里的一项（不含文档内容）。 */
export interface VersionSummary {
	number: number;
	author: string;
	author_via: string | null;
	created_at: string;
}

/**
 * 保存版本的结果。`conflict`：提交的 base_version 不是当前最新版本（别人先保存了），
 * head 是当前最新版本（还没有版本时为 null）。
 */
export type SaveVersionResult =
	| { kind: "saved"; version: OrchestrationVersionView }
	| { kind: "not_found" }
	| { kind: "conflict"; head: VersionSummary | null };

/** 归档的结果。`running`：还有 count 个运行中的运行，不能归档。 */
export type ArchiveResult =
	| { kind: "archived"; orchestration: OrchestrationView }
	| { kind: "not_found" }
	| { kind: "running"; count: number };

/** 新建场景的初始文档：只有一个入口节点，位置由整理布局算法给出（与画布的「整理布局」相同）。 */
export const initialDocument = (): OrchestrationDocument =>
	ensureLayout({ nodes: [{ id: "entry", kind: "entry", params: [] }], edges: [], packages: {} });

type OrchestrationRow = typeof orchestrations.$inferSelect;
type VersionRow = typeof orchestrationVersions.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function versionRow(
	tx: Tx | Db,
	orchestrationId: string,
	number: number,
): Promise<VersionRow | undefined> {
	const [row] = await tx
		.select()
		.from(orchestrationVersions)
		.where(
			and(
				eq(orchestrationVersions.orchestrationId, orchestrationId),
				eq(orchestrationVersions.number, number),
			),
		);
	return row;
}

export const toView = (row: OrchestrationRow): OrchestrationView => ({
	id: row.id,
	name: row.name,
	description: row.description,
	head_version: row.headVersion,
	created_at: row.createdAt.toISOString(),
	archived_at: row.archivedAt ? row.archivedAt.toISOString() : null,
	run_notification: {
		bot: row.runNotifyBot,
		trigger: row.runNotifyTrigger,
		title: row.runNotifyTitle,
		note: row.runNotifyNote,
	},
});

/** 运行通知设置在场景表里的列。 */
const runNotifyColumns = (settings: RunNotificationChanges) => ({
	...(settings.bot === undefined ? {} : { runNotifyBot: settings.bot }),
	...(settings.trigger === undefined ? {} : { runNotifyTrigger: settings.trigger }),
	...(settings.title === undefined ? {} : { runNotifyTitle: settings.title }),
	...(settings.note === undefined ? {} : { runNotifyNote: settings.note }),
});

const toSummary = (
	row: Pick<VersionRow, "number" | "author" | "authorVia" | "createdAt">,
): VersionSummary => ({
	number: row.number,
	author: row.author,
	author_via: row.authorVia,
	created_at: row.createdAt.toISOString(),
});

export const toVersionView = (row: VersionRow): OrchestrationVersionView => ({
	id: row.id,
	orchestration_id: row.orchestrationId,
	number: row.number,
	author: row.author,
	author_via: row.authorVia,
	created_at: row.createdAt.toISOString(),
	document: row.document,
});

/** 编排与编排版本的存取。版本只追加、不修改。 */
export class OrchestrationStore {
	constructor(private readonly deps: { db: Db; clock: Clock }) {}

	async create(name: string, description = ""): Promise<OrchestrationView> {
		const [row] = await this.deps.db
			.insert(orchestrations)
			.values({ id: randomUUID(), name, description, createdAt: this.deps.clock.now() })
			.returning();
		return toView(row as OrchestrationRow);
	}

	/**
	 * 修改名称、说明和运行通知设置（不属于版本内容，不产生新版本；只改写提到的项）。
	 * 场景不存在时返回 undefined。
	 */
	async update(
		id: string,
		changes: {
			name?: string | undefined;
			description?: string | undefined;
			run_notification?: RunNotificationChanges | undefined;
		},
	): Promise<OrchestrationView | undefined> {
		const [row] = await this.deps.db
			.update(orchestrations)
			.set({
				...(changes.name === undefined ? {} : { name: changes.name }),
				...(changes.description === undefined ? {} : { description: changes.description }),
				...runNotifyColumns(changes.run_notification ?? {}),
			})
			.where(eq(orchestrations.id, id))
			.returning();
		return row && toView(row);
	}

	/**
	 * 归档：有运行中的运行时拒绝。加行锁后检查，与触发（engine.trigger 对同一行加共享锁后检查归档）互斥，
	 * 不会归档之后又多出一个运行中的运行。已归档的再次归档保持原来的归档时间。
	 */
	archive(id: string): Promise<ArchiveResult> {
		return this.deps.db.transaction(async (tx): Promise<ArchiveResult> => {
			const [row] = await tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, id))
				.for("update");
			if (!row) return { kind: "not_found" };
			const [running] = await tx
				.select({ n: count() })
				.from(runs)
				.where(and(eq(runs.orchestrationId, id), eq(runs.status, "running")));
			if (running && running.n > 0) return { kind: "running", count: running.n };
			if (row.archivedAt) return { kind: "archived", orchestration: toView(row) };
			const [updated] = await tx
				.update(orchestrations)
				.set({ archivedAt: this.deps.clock.now() })
				.where(eq(orchestrations.id, id))
				.returning();
			return { kind: "archived", orchestration: toView(updated as OrchestrationRow) };
		});
	}

	/** 恢复已归档的场景。场景不存在时返回 undefined。 */
	async unarchive(id: string): Promise<OrchestrationView | undefined> {
		const [row] = await this.deps.db
			.update(orchestrations)
			.set({ archivedAt: null })
			.where(eq(orchestrations.id, id))
			.returning();
		return row && toView(row);
	}

	async head(id: string): Promise<OrchestrationHeadView | undefined> {
		const orchestration = await this.get(id);
		if (!orchestration) return undefined;
		const version =
			orchestration.head_version > 0
				? await this.getVersion(id, orchestration.head_version)
				: undefined;
		return {
			orchestration_id: id,
			number: version?.number ?? 0,
			author: version?.author ?? null,
			author_via: version?.author_via ?? null,
			created_at: version?.created_at ?? null,
			document: version?.document ?? initialDocument(),
		};
	}

	/**
	 * 复制编排：新编排使用新名字，说明、运行通知设置和运行预设一起复制，源编排有版本时，以源编排最新版本的内容作为第 1 版（作者为复制的人）。
	 * 源编排不存在时返回 undefined。
	 */
	copy(sourceId: string, name: string, actor: Actor): Promise<OrchestrationView | undefined> {
		return this.deps.db.transaction(async (tx) => {
			const [source] = await tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, sourceId));
			if (!source) return undefined;
			const [head] = await tx
				.select()
				.from(orchestrationVersions)
				.where(
					and(
						eq(orchestrationVersions.orchestrationId, sourceId),
						eq(orchestrationVersions.number, source.headVersion),
					),
				);
			const now = this.deps.clock.now();
			const id = randomUUID();
			const [row] = await tx
				.insert(orchestrations)
				.values({
					id,
					name,
					description: source.description,
					headVersion: head ? 1 : 0,
					createdAt: now,
					// 运行通知设置跟着场景走：复制到另一个环境后只需要改机器人、标题和说明。
					runNotifyBot: source.runNotifyBot,
					runNotifyTrigger: source.runNotifyTrigger,
					runNotifyTitle: source.runNotifyTitle,
					runNotifyNote: source.runNotifyNote,
				})
				.returning();
			if (head) {
				await tx.insert(orchestrationVersions).values({
					id: randomUUID(),
					orchestrationId: id,
					number: 1,
					document: head.document,
					author: actor.nickname,
					authorVia: actor.via,
					createdAt: now,
				});
			}
			await copyPresets(tx, sourceId, id, actor, now);
			return toView(row as OrchestrationRow);
		});
	}

	/** 每个已保存过版本的场景的最新版本文档（统计引用与锁定用）。 */
	async headDocuments(): Promise<OrchestrationDocument[]> {
		const rows = await this.deps.db
			.select({ document: orchestrationVersions.document })
			.from(orchestrations)
			.innerJoin(
				orchestrationVersions,
				and(
					eq(orchestrationVersions.orchestrationId, orchestrations.id),
					eq(orchestrationVersions.number, orchestrations.headVersion),
				),
			);
		return rows.map((r) => r.document);
	}

	async get(id: string): Promise<OrchestrationView | undefined> {
		const [row] = await this.deps.db.select().from(orchestrations).where(eq(orchestrations.id, id));
		return row && toView(row);
	}

	/**
	 * 追加一个新版本，编号 = 当前最新版本号 + 1。
	 * baseVersion 是编辑起点的版本号（新编排的第一个版本为 0），它必须等于当前最新版本号，
	 * 否则不保存并返回 conflict（docs/ARCHITECTURE.md §6.4）。检查与追加在同一个行锁内完成。
	 * 没有位置的节点（命令行、API 上传的文档可以不写坐标）保存时用整理布局补上，已有位置的节点不动。
	 */
	saveVersion(
		orchestrationId: string,
		document: OrchestrationDocument,
		actor: Actor,
		baseVersion: number,
	): Promise<SaveVersionResult> {
		return this.deps.db.transaction(async (tx): Promise<SaveVersionResult> => {
			const [orchestration] = await tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, orchestrationId))
				.for("update");
			if (!orchestration) return { kind: "not_found" };
			if (baseVersion !== orchestration.headVersion) {
				const head = await versionRow(tx, orchestrationId, orchestration.headVersion);
				return { kind: "conflict", head: head ? toSummary(head) : null };
			}
			const laidOut = fillMissingPositions(document);
			return { kind: "saved", version: await this.#append(tx, orchestration, laidOut, actor) };
		});
	}

	/** 版本历史（不含文档内容），按版本号从新到旧。编排不存在时返回 undefined。 */
	async listVersions(orchestrationId: string): Promise<VersionSummary[] | undefined> {
		if (!(await this.get(orchestrationId))) return undefined;
		const rows = await this.deps.db
			.select({
				number: orchestrationVersions.number,
				author: orchestrationVersions.author,
				authorVia: orchestrationVersions.authorVia,
				createdAt: orchestrationVersions.createdAt,
			})
			.from(orchestrationVersions)
			.where(eq(orchestrationVersions.orchestrationId, orchestrationId))
			.orderBy(desc(orchestrationVersions.number));
		return rows.map(toSummary);
	}

	/**
	 * 恢复历史版本：用该版本的内容追加一个新版本（作者为恢复的人），不改写历史。
	 * 编排或版本不存在时返回 undefined。
	 */
	restoreVersion(
		orchestrationId: string,
		number: number,
		actor: Actor,
	): Promise<OrchestrationVersionView | undefined> {
		return this.deps.db.transaction(async (tx) => {
			const [orchestration] = await tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, orchestrationId))
				.for("update");
			if (!orchestration) return undefined;
			const source = await versionRow(tx, orchestrationId, number);
			if (!source) return undefined;
			return this.#append(tx, orchestration, source.document, actor);
		});
	}

	/** 在已加行锁的编排上追加下一个版本，并更新最新版本号。 */
	async #append(
		tx: Tx,
		orchestration: OrchestrationRow,
		document: OrchestrationDocument,
		actor: Actor,
	): Promise<OrchestrationVersionView> {
		const number = orchestration.headVersion + 1;
		const [row] = await tx
			.insert(orchestrationVersions)
			.values({
				id: randomUUID(),
				orchestrationId: orchestration.id,
				number,
				document,
				author: actor.nickname,
				authorVia: actor.via,
				createdAt: this.deps.clock.now(),
			})
			.returning();
		await tx
			.update(orchestrations)
			.set({ headVersion: number })
			.where(eq(orchestrations.id, orchestration.id));
		return toVersionView(row as VersionRow);
	}

	async getVersion(
		orchestrationId: string,
		number: number,
	): Promise<OrchestrationVersionView | undefined> {
		const row = await versionRow(this.deps.db, orchestrationId, number);
		return row && toVersionView(row);
	}
}
