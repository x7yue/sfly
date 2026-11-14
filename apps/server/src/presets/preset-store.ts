import { randomUUID } from "node:crypto";
import type { ParamDeclaration, PresetParamInput, PresetView } from "@sfly/schema";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Actor } from "../actor.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { orchestrations, orchestrationVersions, runPresets } from "../db/schema.js";
import type { Tx } from "../engine/step.js";
import { checkPresetParams, type PresetIssue } from "./preset-input.js";
import { entryParams } from "./preset-validity.js";
import { type PresetRow, toPresetView } from "./preset-view.js";

type Declaration = z.infer<typeof ParamDeclaration>;

export type CreatePresetResult =
	| { kind: "created"; preset: PresetView }
	| { kind: "not_found" }
	| { kind: "invalid"; issues: PresetIssue[] }
	| { kind: "name_taken" };

/** 场景最新版本入口节点的参数声明；还没有版本时为空。 */
async function headDeclarations(
	tx: Tx | Db,
	orchestration: Pick<typeof orchestrations.$inferSelect, "id" | "headVersion">,
): Promise<Declaration[]> {
	if (orchestration.headVersion === 0) return [];
	const [version] = await tx
		.select({ document: orchestrationVersions.document })
		.from(orchestrationVersions)
		.where(
			and(
				eq(orchestrationVersions.orchestrationId, orchestration.id),
				eq(orchestrationVersions.number, orchestration.headVersion),
			),
		);
	return version ? entryParams(version.document) : [];
}

/** 一个场景的运行预设；不存在或不属于这个场景时为 undefined。触发在自己的事务里用它读预设。 */
export async function findPreset(
	tx: Tx | Db,
	orchestrationId: string,
	presetId: string,
): Promise<PresetRow | undefined> {
	const [row] = await tx
		.select()
		.from(runPresets)
		.where(and(eq(runPresets.id, presetId), eq(runPresets.orchestrationId, orchestrationId)));
	return row;
}

/**
 * 运行预设的存取（ADR 0023）：预设是场景的设置，不属于版本；视图对照场景最新版本的入口参数。
 * 后保存的覆盖先保存的，不做乐观锁，只记下最后修改人和时间。
 */
export class PresetStore {
	constructor(private readonly deps: { db: Db; clock: Clock }) {}

	/** 场景的运行预设，按名称排序，对照给出的入口参数声明（预检传入它这次检查用的最新版本）。 */
	async viewsFor(
		orchestrationId: string,
		declarations: readonly Declaration[],
	): Promise<PresetView[]> {
		const rows = await this.deps.db
			.select()
			.from(runPresets)
			.where(eq(runPresets.orchestrationId, orchestrationId))
			.orderBy(asc(runPresets.name));
		return rows.map((row) => toPresetView(row, declarations));
	}

	/** 场景的运行预设，对照最新版本；场景不存在时返回 undefined。 */
	async list(orchestrationId: string): Promise<PresetView[] | undefined> {
		const [orchestration] = await this.deps.db
			.select()
			.from(orchestrations)
			.where(eq(orchestrations.id, orchestrationId));
		if (!orchestration) return undefined;
		return this.viewsFor(orchestrationId, await headDeclarations(this.deps.db, orchestration));
	}

	/**
	 * 新建运行预设：对照最新版本检查预设参数（{@link checkPresetParams}），名称在场景内唯一。
	 * 对场景行加共享锁，与保存版本（加排他锁）互斥：检查用的就是写入那一刻的最新版本。
	 */
	create(
		orchestrationId: string,
		input: { name: string; description: string; params: readonly PresetParamInput[] },
		actor: Actor,
	): Promise<CreatePresetResult> {
		return this.deps.db.transaction(async (tx): Promise<CreatePresetResult> => {
			const [orchestration] = await tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, orchestrationId))
				.for("share");
			if (!orchestration) return { kind: "not_found" };
			const declarations = await headDeclarations(tx, orchestration);
			const checked = checkPresetParams(input.params, declarations);
			if ("issues" in checked) return { kind: "invalid", issues: checked.issues };
			const now = this.deps.clock.now();
			const [row] = await tx
				.insert(runPresets)
				.values({
					id: randomUUID(),
					orchestrationId,
					name: input.name,
					description: input.description,
					values: checked.values,
					createdAt: now,
					updatedAt: now,
					updatedBy: actor.nickname,
				})
				.onConflictDoNothing({ target: [runPresets.orchestrationId, runPresets.name] })
				.returning();
			if (!row) return { kind: "name_taken" };
			return { kind: "created", preset: toPresetView(row, declarations) };
		});
	}
}
