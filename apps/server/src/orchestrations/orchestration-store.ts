import { randomUUID } from "node:crypto";
import type { OrchestrationDocument } from "@sfly/schema";
import { and, eq } from "drizzle-orm";
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
