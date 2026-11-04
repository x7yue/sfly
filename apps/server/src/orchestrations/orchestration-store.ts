import { randomUUID } from "node:crypto";
import type { OrchestrationDocument } from "@sfly/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { orchestrations, orchestrationVersions } from "../db/schema.js";

export interface OrchestrationView {
	id: string;
	name: string;
	head_version: number;
	created_at: string;
}

export interface OrchestrationVersionView {
	id: string;
	orchestration_id: string;
	number: number;
	author: string;
	created_at: string;
	document: OrchestrationDocument;
}

/** 编辑起点：最新版本；还没有版本时是只含入口节点的初始文档（number 为 0）。 */
export interface OrchestrationHeadView {
	orchestration_id: string;
	number: number;
	author: string | null;
	created_at: string | null;
	document: OrchestrationDocument;
}

/** 新建编排的初始文档：只有一个入口节点。 */
export const initialDocument = (): OrchestrationDocument => ({
	nodes: [{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } }],
	edges: [],
	packages: {},
});

type OrchestrationRow = typeof orchestrations.$inferSelect;
type VersionRow = typeof orchestrationVersions.$inferSelect;

const toView = (row: OrchestrationRow): OrchestrationView => ({
	id: row.id,
	name: row.name,
	head_version: row.headVersion,
	created_at: row.createdAt.toISOString(),
});

export const toVersionView = (row: VersionRow): OrchestrationVersionView => ({
	id: row.id,
	orchestration_id: row.orchestrationId,
	number: row.number,
	author: row.author,
	created_at: row.createdAt.toISOString(),
	document: row.document,
});

/** 编排与编排版本的存取。版本只追加、不修改。 */
export class OrchestrationStore {
	constructor(private readonly deps: { db: Db; clock: Clock }) {}

	async create(name: string): Promise<OrchestrationView> {
		const [row] = await this.deps.db
			.insert(orchestrations)
			.values({ id: randomUUID(), name, createdAt: this.deps.clock.now() })
			.returning();
		return toView(row as OrchestrationRow);
	}

	/** 全部编排，按新建时间从新到旧。 */
	async list(): Promise<OrchestrationView[]> {
		const rows = await this.deps.db
			.select()
			.from(orchestrations)
			.orderBy(desc(orchestrations.createdAt), asc(orchestrations.name));
		return rows.map(toView);
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
			created_at: version?.created_at ?? null,
			document: version?.document ?? initialDocument(),
		};
	}

	/**
	 * 复制编排：新编排使用新名字，源编排有版本时，以源编排最新版本的内容作为第 1 版（作者为复制的人）。
	 * 源编排不存在时返回 undefined。
	 */
	copy(sourceId: string, name: string, author: string): Promise<OrchestrationView | undefined> {
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
				.values({ id, name, headVersion: head ? 1 : 0, createdAt: now })
				.returning();
			if (head) {
				await tx.insert(orchestrationVersions).values({
					id: randomUUID(),
					orchestrationId: id,
					number: 1,
					document: head.document,
					author,
					createdAt: now,
				});
			}
			return toView(row as OrchestrationRow);
		});
	}

	async get(id: string): Promise<OrchestrationView | undefined> {
		const [row] = await this.deps.db.select().from(orchestrations).where(eq(orchestrations.id, id));
		return row && toView(row);
	}

	/** 追加一个新版本，编号 = 当前最新版本号 + 1。编排不存在时返回 undefined。 */
	saveVersion(
		orchestrationId: string,
		document: OrchestrationDocument,
		author: string,
	): Promise<OrchestrationVersionView | undefined> {
		return this.deps.db.transaction(async (tx) => {
			const [orchestration] = await tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, orchestrationId))
				.for("update");
			if (!orchestration) return undefined;
			const number = orchestration.headVersion + 1;
			const [row] = await tx
				.insert(orchestrationVersions)
				.values({
					id: randomUUID(),
					orchestrationId,
					number,
					document,
					author,
					createdAt: this.deps.clock.now(),
				})
				.returning();
			await tx
				.update(orchestrations)
				.set({ headVersion: number })
				.where(eq(orchestrations.id, orchestrationId));
			return toVersionView(row as VersionRow);
		});
	}

	async getVersion(
		orchestrationId: string,
		number: number,
	): Promise<OrchestrationVersionView | undefined> {
		const [row] = await this.deps.db
			.select()
			.from(orchestrationVersions)
			.where(
				and(
					eq(orchestrationVersions.orchestrationId, orchestrationId),
					eq(orchestrationVersions.number, number),
				),
			);
		return row && toVersionView(row);
	}
}
