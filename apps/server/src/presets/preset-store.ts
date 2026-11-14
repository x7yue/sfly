import { randomUUID } from "node:crypto";
import type { ParamDeclaration, PresetChanges, PresetParamInput, PresetView } from "@sfly/schema";
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

/** 预设的写入没有成功的原因；`not_found` 是场景或预设不存在（预设不属于这个场景也算）。 */
type PresetRejection =
	| { kind: "not_found" }
	| { kind: "invalid"; issues: PresetIssue[] }
	| { kind: "name_taken" };

export type CreatePresetResult = { kind: "created"; preset: PresetView } | PresetRejection;
export type UpdatePresetResult = { kind: "updated"; preset: PresetView } | PresetRejection;
export type CopyPresetResult = { kind: "copied"; preset: PresetView } | PresetRejection;

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

/**
 * 一个场景的运行预设；不存在或不属于这个场景时为 undefined。触发在自己的事务里用它读预设；
 * `lock` 给预设行加排他锁，修改它的事务用，同时修改同一个预设的请求依次执行。
 */
export async function findPreset(
	tx: Tx | Db,
	orchestrationId: string,
	presetId: string,
	{ lock = false }: { lock?: boolean } = {},
): Promise<PresetRow | undefined> {
	const query = tx
		.select()
		.from(runPresets)
		.where(and(eq(runPresets.id, presetId), eq(runPresets.orchestrationId, orchestrationId)));
	const [row] = await (lock ? query.for("update") : query);
	return row;
}

/**
 * 加共享锁读场景和它最新版本的入口参数声明，与保存版本（加排他锁）互斥：预设对照的就是写入那一刻的最新版本。
 * 场景不存在时返回 undefined。
 */
async function lockedHead(
	tx: Tx,
	orchestrationId: string,
): Promise<{ declarations: Declaration[] } | undefined> {
	const [orchestration] = await tx
		.select()
		.from(orchestrations)
		.where(eq(orchestrations.id, orchestrationId))
		.for("share");
	return orchestration && { declarations: await headDeclarations(tx, orchestration) };
}

/** 名称在场景内唯一（`run_presets_name`）：已有别的预设用了这个名称时，写入违反唯一约束。 */
function isNameTaken(error: unknown): boolean {
	for (let e: unknown = error; e instanceof Error; e = e.cause) {
		const { code, constraint } = e as { code?: unknown; constraint?: unknown };
		if (code === "23505" && constraint === "run_presets_name") return true;
	}
	return false;
}

/** 插入一个预设；名称已被场景里的另一个预设占用时返回 undefined。 */
async function insertPreset(
	tx: Tx,
	preset: typeof runPresets.$inferInsert,
): Promise<PresetRow | undefined> {
	const [row] = await tx
		.insert(runPresets)
		.values(preset)
		.onConflictDoNothing({ target: [runPresets.orchestrationId, runPresets.name] })
		.returning();
	return row;
}

/**
 * 复制场景时在同一个事务里复制全部预设（ADR 0023）：新的 ID，名称、说明和值（包括 secret 的值）不变，
 * 最后修改人记为复制的人。预设对照最新版本的入口参数，新场景的最新版本就是源场景的最新版本。
 */
export async function copyPresets(
	tx: Tx,
	sourceId: string,
	targetId: string,
	actor: Actor,
	now: Date,
): Promise<void> {
	const rows = await tx.select().from(runPresets).where(eq(runPresets.orchestrationId, sourceId));
	if (rows.length === 0) return;
	await tx.insert(runPresets).values(
		rows.map((row) => ({
			id: randomUUID(),
			orchestrationId: targetId,
			name: row.name,
			description: row.description,
			values: row.values,
			createdAt: now,
			updatedAt: now,
			updatedBy: actor.nickname,
		})),
	);
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
	 * 检查用的就是写入那一刻的最新版本（{@link lockedHead}）。
	 */
	create(
		orchestrationId: string,
		input: { name: string; description: string; params: readonly PresetParamInput[] },
		actor: Actor,
	): Promise<CreatePresetResult> {
		return this.deps.db.transaction(async (tx): Promise<CreatePresetResult> => {
			const head = await lockedHead(tx, orchestrationId);
			if (!head) return { kind: "not_found" };
			const checked = checkPresetParams(input.params, head.declarations);
			if ("issues" in checked) return { kind: "invalid", issues: checked.issues };
			const now = this.deps.clock.now();
			const row = await insertPreset(tx, {
				id: randomUUID(),
				orchestrationId,
				name: input.name,
				description: input.description,
				values: checked.values,
				createdAt: now,
				updatedAt: now,
				updatedBy: actor.nickname,
			});
			if (!row) return { kind: "name_taken" };
			return { kind: "created", preset: toPresetView(row, head.declarations) };
		});
	}

	/**
	 * 修改运行预设：没有 `params` 时只改名称和说明（失效的预设也可以改名）；给了 `params` 时它是预设参数的完整清单，
	 * 和新建时按同样的规则对照最新版本检查，secret 参数的 `keep` 沿用预设现在保存的值（它在预设行加锁之后才读，
	 * 同时修改的请求依次执行）。后保存的覆盖先保存的，只记下最后修改人和时间（ADR 0023）。
	 */
	async update(
		orchestrationId: string,
		presetId: string,
		changes: PresetChanges,
		actor: Actor,
	): Promise<UpdatePresetResult> {
		try {
			return await this.deps.db.transaction(async (tx): Promise<UpdatePresetResult> => {
				const head = await lockedHead(tx, orchestrationId);
				const saved = head && (await findPreset(tx, orchestrationId, presetId, { lock: true }));
				if (!head || !saved) return { kind: "not_found" };
				let values: Record<string, unknown> | undefined;
				if (changes.params !== undefined) {
					const checked = checkPresetParams(changes.params, head.declarations, saved.values);
					if ("issues" in checked) return { kind: "invalid", issues: checked.issues };
					values = checked.values;
				}
				const [row] = await tx
					.update(runPresets)
					.set({
						...(changes.name === undefined ? {} : { name: changes.name }),
						...(changes.description === undefined ? {} : { description: changes.description }),
						...(values === undefined ? {} : { values }),
						updatedAt: this.deps.clock.now(),
						updatedBy: actor.nickname,
					})
					.where(eq(runPresets.id, presetId))
					.returning();
				return { kind: "updated", preset: toPresetView(row as PresetRow, head.declarations) };
			});
		} catch (error) {
			if (isNameTaken(error)) return { kind: "name_taken" };
			throw error;
		}
	}

	/** 复制运行预设：新的 ID 和新名称，说明和值（包括 secret 的值）不变，最后修改人记为复制的人。 */
	copy(
		orchestrationId: string,
		presetId: string,
		name: string,
		actor: Actor,
	): Promise<CopyPresetResult> {
		return this.deps.db.transaction(async (tx): Promise<CopyPresetResult> => {
			const head = await lockedHead(tx, orchestrationId);
			const source = head && (await findPreset(tx, orchestrationId, presetId));
			if (!head || !source) return { kind: "not_found" };
			const now = this.deps.clock.now();
			const row = await insertPreset(tx, {
				id: randomUUID(),
				orchestrationId,
				name,
				description: source.description,
				values: source.values,
				createdAt: now,
				updatedAt: now,
				updatedBy: actor.nickname,
			});
			if (!row) return { kind: "name_taken" };
			return { kind: "copied", preset: toPresetView(row, head.declarations) };
		});
	}

	/** 删除运行预设；已有运行上记下的预设 ID、名称和预设参数的名单不受影响。预设不存在时返回 false。 */
	async remove(orchestrationId: string, presetId: string): Promise<boolean> {
		const removed = await this.deps.db
			.delete(runPresets)
			.where(and(eq(runPresets.id, presetId), eq(runPresets.orchestrationId, orchestrationId)))
			.returning({ id: runPresets.id });
		return removed.length > 0;
	}
}
