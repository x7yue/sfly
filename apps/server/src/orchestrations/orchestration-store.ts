import { randomUUID } from "node:crypto";
import { ensureLayout, fillMissingPositions } from "@sfly/orchestration";
import type {
	FocusItemInput,
	OrchestrationBase,
	OrchestrationDocument,
	OrchestrationView,
	RunNotificationChanges,
	SecretDefaultProblem,
	SessionRef,
	StoredOrchestrationDocument,
	VersionCheckView,
} from "@sfly/schema";
import { withoutRemovedFields } from "@sfly/schema";
import { and, count, desc, eq } from "drizzle-orm";
import type { Actor } from "../actor.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { orchestrations, orchestrationVersions, runs } from "../db/schema.js";
import type { FocusRejection } from "../focus/focus-list.js";
import { copiedFocus, focusFields, replaceFocusItems } from "../focus/focus-settings.js";
import { copyPresets } from "../presets/preset-store.js";
import type { ProjectId } from "../projects/project-id.js";
import { sessionRefs, withSession } from "../sessions/session-ref.js";
import { limitSessionWriteLockWait, type SessionStore } from "../sessions/session-store.js";
import { maskSecretDefaults, restoreSecretDefaults } from "./secret-defaults.js";
import { newWarnings, versionCheck } from "./version-check.js";

export type { OrchestrationView };

/**
 * 一个场景版本的视图：场景文档离开存储层的唯一一处（{@link toVersionView}），secret 参数的默认值在这里打码
 * （secret-defaults.ts），所以经它的接口默认就是打码的；需要原值的地方（引擎、触发准入、预检的实际值检查）在自己的事务里读库。
 */
export interface OrchestrationVersionView {
	id: string;
	orchestration_id: string;
	number: number;
	author: string;
	/** 经哪个 AI 编程助手保存；浏览器里保存的为 null。 */
	author_via: string | null;
	created_at: string;
	document: StoredOrchestrationDocument;
}

/** 编辑起点：最新版本；还没有版本时是只含入口节点的初始文档（number 为 0）。 */
export interface OrchestrationHeadView {
	orchestration_id: string;
	number: number;
	author: string | null;
	author_via: string | null;
	created_at: string | null;
	document: StoredOrchestrationDocument;
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
	/** `previous` 是新版本的上一个版本的文档（打码的；第一个版本没有），算会失效的运行预设要用。 */
	| {
			kind: "saved";
			version: OrchestrationVersionView;
			previous: StoredOrchestrationDocument | undefined;
	  }
	| { kind: "not_found" }
	| { kind: "conflict"; head: VersionSummary | null }
	/** 文档里 secret 参数的默认值是占位符，却没有可以沿用的上一个版本的值（见 {@link restoreSecretDefaults}）。 */
	| { kind: "secret_default_unresolved"; problems: SecretDefaultProblem[] }
	/** 带 `strict` 保存，这次改动新带进来了警告：没有保存，`check` 和检查的结果一样。 */
	| { kind: "strict_rejected"; check: VersionCheckView };

/**
 * 检查一份文档的结果（{@link OrchestrationStore.checkVersion}）：和保存的结果一一对应，只是不追加版本。
 * `checked` 时 `check` 是带标记的警告和差异（契约的 VersionCheckView），`document` 是保存之后会存成的文档，
 * `previous` 是最新版本的文档（还没有版本时没有），都打码。
 */
export type CheckVersionResult =
	| {
			kind: "checked";
			check: VersionCheckView;
			document: StoredOrchestrationDocument;
			previous: StoredOrchestrationDocument | undefined;
	  }
	| Exclude<SaveVersionResult, { kind: "saved" | "strict_rejected" }>;

/**
 * 保存之前对上传的文档做的处理，保存和检查共用：收下的已移除字段（空的 `sticky_notes`，ADR 0028）不存进新版本；
 * secret 参数默认值的占位符换回 `previous`（编辑起点，也就是最新版本的原始文档）里的原值（{@link restoreSecretDefaults}，
 * 沿用不了时返回问题清单）；没有坐标的节点按整理布局补上（命令行和 API 上传的节点可以不写坐标）。
 */
export function prepareDocument(
	previous: StoredOrchestrationDocument | undefined,
	document: OrchestrationDocument,
): { document: OrchestrationDocument } | { problems: SecretDefaultProblem[] } {
	const restored = restoreSecretDefaults(previous, withoutRemovedFields(document));
	if ("problems" in restored) return restored;
	return { document: fillMissingPositions(restored.document) };
}

/** 归档的结果。`running`：还有 count 个运行中的运行，不能归档。 */
export type ArchiveResult =
	| { kind: "archived"; orchestration: OrchestrationView }
	| { kind: "not_found" }
	| { kind: "running"; count: number };

/** 修改场景设置的结果。`rejected`：关注项不合格（{@link FocusRejection}），什么都没有改。 */
export type UpdateResult =
	| { kind: "updated"; orchestration: OrchestrationView }
	| { kind: "not_found" }
	| { kind: "rejected"; rejection: FocusRejection };

/** 新建场景的初始文档：只有一个入口节点，位置由整理布局算法给出（与画布的「整理布局」相同）。 */
export const initialDocument = (): OrchestrationDocument =>
	ensureLayout({
		nodes: [{ id: "entry", kind: "entry", params: [] }],
		edges: [],
		packages: {},
		annotations: [],
	});

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

/** 编辑起点不是最新版本：返回最新版本（还没有版本时为 null）。 */
async function conflict(
	db: Tx | Db,
	orchestration: OrchestrationRow,
): Promise<{ kind: "conflict"; head: VersionSummary | null }> {
	const head = await versionRow(db, orchestration.id, orchestration.headVersion);
	return {
		kind: "conflict",
		head: head ? toSummary(head, await sessionOfVersion(db, head)) : null,
	};
}

/** 场景的基本信息（场景列表用）；场景视图在它之上加了对照最新版本才能得出的关注项，见 {@link OrchestrationStore}。 */
export const toBase = (row: OrchestrationRow): OrchestrationBase => ({
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
	session?: SessionRef,
): VersionSummary => ({
	number: row.number,
	author: row.author,
	author_via: row.authorVia,
	...withSession(session),
	created_at: row.createdAt.toISOString(),
});

export const toVersionView = (row: VersionRow, session?: SessionRef): OrchestrationVersionView => ({
	id: row.id,
	orchestration_id: row.orchestrationId,
	number: row.number,
	author: row.author,
	author_via: row.authorVia,
	...withSession(session),
	created_at: row.createdAt.toISOString(),
	document: maskSecretDefaults(row.document),
});

/** 一个版本上记的会话（会话令牌保存的版本）：会话的 ID 和标题；不是会话保存的为 undefined。 */
async function sessionOfVersion(db: Db | Tx, row: VersionRow): Promise<SessionRef | undefined> {
	if (row.sessionId === null) return undefined;
	return (await sessionRefs(db, [row.sessionId])).get(row.sessionId);
}

/**
 * 编排与编排版本的存取。版本只追加、不修改。每个场景属于一个项目（ADR 0029）：新建要传项目，按项目取（`getInProject`）
 * 和列最新版本文档（`rawHeadDocuments`）要传项目。按场景 ID 的其余方法不传项目：ID 全库唯一，项目从场景本身得出
 * （契约路由的检查，#489），场景属于哪个项目由检查负责。
 */
/** 会话令牌的写在提交之后要做的：发布平台记录（交给会话的链，不等它）。 */
interface AfterCommit {
	announce: Array<() => void>;
}

export class OrchestrationStore {
	constructor(private readonly deps: { db: Db; clock: Clock; sessions: SessionStore }) {}

	/**
	 * 会话令牌的写（保存、恢复、复制）：事务里等行锁有上限（超时回滚、HTTP 503），不让没想到的等待变成永远卡住。
	 * 放在事务的第一条语句。不是会话令牌的写什么都不做。
	 */
	async #limitLockWait(tx: Tx, actor: Actor): Promise<void> {
		if (actor.sessionId !== null) await limitSessionWriteLockWait(tx);
	}

	/**
	 * 会话令牌保存的版本：在记下版本的同一个事务里给会话写一条平台记录（`scenario_version`，#547）。**要放在事务的最后**：
	 * 先做慢的（场景那一行的锁、版本的写入），最后才给会话那一行加锁、分配序号、写记录，然后提交；事务里不等任何进程里的锁
	 * （{@link SessionStore.recordPlatform}）。`after.announce` 里放的收尾在事务提交之后调用（推送，不等它）；
	 * 不是会话保存的什么都不做。
	 */
	async #recordForSession(
		tx: Tx,
		actor: Actor,
		scenario: { id: string; name: string },
		version: number,
		after: AfterCommit,
	): Promise<void> {
		const { sessionId } = actor;
		if (sessionId === null) return;
		const event = await this.deps.sessions.recordPlatform(tx, sessionId, {
			kind: "scenario_version",
			scenario_id: scenario.id,
			name: scenario.name,
			version,
		});
		after.announce.push(() => this.deps.sessions.announce(sessionId, event));
	}

	/**
	 * 场景视图：基本信息，加上关注项和它们在最新版本里的状态（{@link focusFields}）。
	 * `db` 必须传：在事务里是 `tx`（事务已经占着一个连接，不能再去连接池里另取一个），不在事务里是 `this.deps.db`。
	 */
	async #view(row: OrchestrationRow, db: Db | Tx): Promise<OrchestrationView> {
		return { ...toBase(row), ...(await focusFields(db, row)) };
	}

	async create(project: ProjectId, name: string, description = ""): Promise<OrchestrationView> {
		const [row] = await this.deps.db
			.insert(orchestrations)
			.values({
				id: randomUUID(),
				projectId: project,
				name,
				description,
				createdAt: this.deps.clock.now(),
			})
			.returning();
		return this.#view(row as OrchestrationRow, this.deps.db);
	}

	/**
	 * 修改名称、说明、运行通知设置和关注项（不属于版本内容，不产生新版本；只改写提到的项）。
	 * 关注项是整份替换，校验和「最后修改」见 {@link replaceFocusItems}；同时修改时后写的生效。
	 * 加行锁后读出旧列表再比较，同一个场景的关注项修改依次进行。
	 */
	async update(
		id: string,
		changes: {
			name?: string | undefined;
			description?: string | undefined;
			run_notification?: RunNotificationChanges | undefined;
			focus_items?: readonly FocusItemInput[] | undefined;
		},
		actor: Actor,
	): Promise<UpdateResult> {
		const outcome = await this.deps.db.transaction(
			async (
				tx,
			): Promise<{ row: OrchestrationRow } | Exclude<UpdateResult, { kind: "updated" }>> => {
				const [row] = await tx
					.select()
					.from(orchestrations)
					.where(eq(orchestrations.id, id))
					.for("update");
				if (!row) return { kind: "not_found" };
				const focus =
					changes.focus_items === undefined
						? undefined
						: await replaceFocusItems(tx, row, changes.focus_items, actor, this.deps.clock.now());
				if (focus?.kind === "rejected") return focus;
				const set = {
					...(changes.name === undefined ? {} : { name: changes.name }),
					...(changes.description === undefined ? {} : { description: changes.description }),
					...runNotifyColumns(changes.run_notification ?? {}),
					...(focus?.kind === "replaced" ? focus.columns : {}),
				};
				if (Object.keys(set).length === 0) return { row };
				const [updated] = await tx
					.update(orchestrations)
					.set(set)
					.where(eq(orchestrations.id, id))
					.returning();
				return { row: updated as OrchestrationRow };
			},
		);
		return "row" in outcome
			? { kind: "updated", orchestration: await this.#view(outcome.row, this.deps.db) }
			: outcome;
	}

	/**
	 * 归档：有运行中的运行时拒绝。加行锁后检查，与触发（触发准入对同一行加共享锁后检查归档，runs/trigger-admission.ts）互斥，
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
			if (row.archivedAt) return { kind: "archived", orchestration: await this.#view(row, tx) };
			const [updated] = await tx
				.update(orchestrations)
				.set({ archivedAt: this.deps.clock.now() })
				.where(eq(orchestrations.id, id))
				.returning();
			return {
				kind: "archived",
				orchestration: await this.#view(updated as OrchestrationRow, tx),
			};
		});
	}

	/** 恢复已归档的场景。场景不存在时返回 undefined。 */
	async unarchive(id: string): Promise<OrchestrationView | undefined> {
		const [row] = await this.deps.db
			.update(orchestrations)
			.set({ archivedAt: null })
			.where(eq(orchestrations.id, id))
			.returning();
		return row && this.#view(row, this.deps.db);
	}

	async head(id: string): Promise<OrchestrationHeadView | undefined> {
		const orchestration = await this.#row(id);
		if (!orchestration) return undefined;
		const version =
			orchestration.headVersion > 0
				? await this.getVersion(id, orchestration.headVersion)
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
	 * 复制编排：新编排使用新名字，说明、运行通知设置、运行预设和关注项一起复制，源编排有版本时，以源编排最新版本的内容作为第 1 版（作者为复制的人）。
	 * 关注项的最后修改记为复制的人（{@link copiedFocus}）。源编排不存在时返回 undefined。
	 */
	async copy(sourceId: string, name: string, actor: Actor): Promise<OrchestrationView | undefined> {
		const pending: AfterCommit = { announce: [] };
		const copied = await this.deps.db.transaction(async (tx) => {
			await this.#limitLockWait(tx, actor);
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
					// 副本和源场景在同一个项目里。
					projectId: source.projectId,
					name,
					description: source.description,
					headVersion: head ? 1 : 0,
					createdAt: now,
					// 运行通知设置跟着场景走：复制到另一个环境后只需要改机器人、标题和说明。
					runNotifyBot: source.runNotifyBot,
					runNotifyTrigger: source.runNotifyTrigger,
					runNotifyTitle: source.runNotifyTitle,
					runNotifyNote: source.runNotifyNote,
					...copiedFocus(source, actor, now),
				})
				.returning();
			if (head) {
				await tx.insert(orchestrationVersions).values({
					id: randomUUID(),
					orchestrationId: id,
					number: 1,
					document: head.document,
					author: actor.nickname,
					authorUserId: actor.userId,
					authorVia: actor.via,
					authorToken: actor.token,
					sessionId: actor.sessionId,
					createdAt: now,
				});
			}
			await copyPresets(tx, sourceId, id, actor, now);
			// 平台记录放在事务的最后（会话那一行的锁是最后拿的一把）。
			if (head) await this.#recordForSession(tx, actor, { id, name }, 1, pending);
			return row as OrchestrationRow;
		});
		for (const announce of pending.announce) announce();
		return copied && this.#view(copied, this.deps.db);
	}

	/**
	 * 这个项目里每个已保存过版本的场景的最新版本文档（统计引用与锁定用）。**原始文档，secret 参数的默认值没有打码**（名字里的 raw）：
	 * 只在控制面内部统计用，不能原样交给调用方（biome-plugins/raw-version-document.grit）。
	 */
	async rawHeadDocuments(project: ProjectId): Promise<StoredOrchestrationDocument[]> {
		const rows = await this.deps.db
			.select({ document: orchestrationVersions.document })
			.from(orchestrations)
			.innerJoin(
				orchestrationVersions,
				and(
					eq(orchestrationVersions.orchestrationId, orchestrations.id),
					eq(orchestrationVersions.number, orchestrations.headVersion),
				),
			)
			.where(eq(orchestrations.projectId, project));
		return rows.map((r) => r.document);
	}

	async #row(id: string, project?: ProjectId): Promise<OrchestrationRow | undefined> {
		const [row] = await this.deps.db
			.select()
			.from(orchestrations)
			.where(
				and(
					eq(orchestrations.id, id),
					...(project === undefined ? [] : [eq(orchestrations.projectId, project)]),
				),
			);
		return row;
	}

	async get(id: string): Promise<OrchestrationView | undefined> {
		const row = await this.#row(id);
		return row && this.#view(row, this.deps.db);
	}

	/** 按 ID 取这个项目里的场景；不存在或属于别的项目时返回 undefined（和不存在一样）。 */
	async getInProject(project: ProjectId, id: string): Promise<OrchestrationView | undefined> {
		const row = await this.#row(id, project);
		return row && this.#view(row, this.deps.db);
	}

	/**
	 * 追加一个新版本，编号 = 当前最新版本号 + 1。
	 * baseVersion 是编辑起点的版本号（新编排的第一个版本为 0），它必须等于当前最新版本号，
	 * 否则不保存并返回 conflict（docs/ARCHITECTURE.md §6.4）。检查与追加在同一个行锁内完成。
	 * 没有位置的节点（命令行、API 上传的文档可以不写坐标）保存时用整理布局补上，已有位置的节点不动。
	 * secret 参数的默认值是占位符（读出来的文档原样存回来）时沿用上一个版本里同名参数的值（{@link restoreSecretDefaults}）：
	 * 上一个版本就是 base_version，在冲突检查通过之后、同一个行锁内读取。
	 * `strict`：这次改动新带进来了警告时不保存（{@link versionCheck}，同一个事务里判断），返回 `strict_rejected`。
	 */
	async saveVersion(
		orchestrationId: string,
		document: OrchestrationDocument,
		actor: Actor,
		baseVersion: number,
		options: { strict?: boolean } = {},
	): Promise<SaveVersionResult> {
		const pending: AfterCommit = { announce: [] };
		const result = await this.deps.db.transaction(async (tx): Promise<SaveVersionResult> => {
			await this.#limitLockWait(tx, actor);
			const [orchestration] = await tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, orchestrationId))
				.for("update");
			if (!orchestration) return { kind: "not_found" };
			if (baseVersion !== orchestration.headVersion) {
				return conflict(tx, orchestration);
			}
			const previous =
				orchestration.headVersion > 0
					? await versionRow(tx, orchestrationId, orchestration.headVersion)
					: undefined;
			const prepared = prepareDocument(previous?.document, document);
			if ("problems" in prepared) {
				return { kind: "secret_default_unresolved", problems: prepared.problems };
			}
			const masked = previous && maskSecretDefaults(previous.document);
			if (options.strict) {
				// 在同一个事务（同一个行锁）里检查：检查和追加之间，别的请求改不了这次判断用到的东西。
				const check = await versionCheck(
					tx,
					orchestrationId,
					maskSecretDefaults(prepared.document),
					masked,
					masked ?? initialDocument(),
				);
				if (newWarnings(check).length > 0) return { kind: "strict_rejected", check };
			}
			return {
				kind: "saved",
				version: await this.#append(tx, orchestration, prepared.document, actor, pending),
				previous: masked,
			};
		});
		for (const announce of pending.announce) announce();
		return result;
	}

	/**
	 * 检查一份文档，不保存：和 {@link saveVersion} 走同样的步骤（编辑起点的冲突检查、{@link prepareDocument}），
	 * 只是不追加版本、不加锁；返回带标记的警告和差异（{@link versionCheck}）。`baseVersion` 不给时对照最新版本，不报冲突。
	 */
	async checkVersion(
		orchestrationId: string,
		document: OrchestrationDocument,
		baseVersion: number | undefined,
	): Promise<CheckVersionResult> {
		const orchestration = await this.#row(orchestrationId);
		if (!orchestration) return { kind: "not_found" };
		if (baseVersion !== undefined && baseVersion !== orchestration.headVersion) {
			return conflict(this.deps.db, orchestration);
		}
		const previous =
			orchestration.headVersion > 0
				? await versionRow(this.deps.db, orchestrationId, orchestration.headVersion)
				: undefined;
		const prepared = prepareDocument(previous?.document, document);
		if ("problems" in prepared) {
			return { kind: "secret_default_unresolved", problems: prepared.problems };
		}
		const checked = maskSecretDefaults(prepared.document);
		const masked = previous && maskSecretDefaults(previous.document);
		return {
			kind: "checked",
			check: await versionCheck(
				this.deps.db,
				orchestrationId,
				checked,
				masked,
				masked ?? initialDocument(),
			),
			document: checked,
			previous: masked,
		};
	}

	/** 版本历史（不含文档内容），按版本号从新到旧。编排不存在时返回 undefined。 */
	async listVersions(orchestrationId: string): Promise<VersionSummary[] | undefined> {
		if (!(await this.#row(orchestrationId))) return undefined;
		const rows = await this.deps.db
			.select({
				number: orchestrationVersions.number,
				author: orchestrationVersions.author,
				authorVia: orchestrationVersions.authorVia,
				sessionId: orchestrationVersions.sessionId,
				createdAt: orchestrationVersions.createdAt,
			})
			.from(orchestrationVersions)
			.where(eq(orchestrationVersions.orchestrationId, orchestrationId))
			.orderBy(desc(orchestrationVersions.number));
		const refs = await sessionRefs(
			this.deps.db,
			rows.map((row) => row.sessionId),
		);
		return rows.map((row) =>
			toSummary(row, row.sessionId === null ? undefined : refs.get(row.sessionId)),
		);
	}

	/**
	 * 恢复历史版本：用该版本的内容追加一个新版本（作者为恢复的人），不改写历史。
	 * 编排或版本不存在时返回 undefined。
	 */
	async restoreVersion(
		orchestrationId: string,
		number: number,
		actor: Actor,
	): Promise<
		| { version: OrchestrationVersionView; previous: StoredOrchestrationDocument | undefined }
		| undefined
	> {
		const pending: AfterCommit = { announce: [] };
		const result = await this.deps.db.transaction(async (tx) => {
			await this.#limitLockWait(tx, actor);
			const [orchestration] = await tx
				.select()
				.from(orchestrations)
				.where(eq(orchestrations.id, orchestrationId))
				.for("update");
			if (!orchestration) return undefined;
			const source = await versionRow(tx, orchestrationId, number);
			if (!source) return undefined;
			const previous = await versionRow(tx, orchestrationId, orchestration.headVersion);
			return {
				version: await this.#append(tx, orchestration, source.document, actor, pending),
				previous: previous && maskSecretDefaults(previous.document),
			};
		});
		for (const announce of pending.announce) announce();
		return result;
	}

	/** 在已加行锁的编排上追加下一个版本，并更新最新版本号。 */
	async #append(
		tx: Tx,
		orchestration: OrchestrationRow,
		document: StoredOrchestrationDocument,
		actor: Actor,
		pending: AfterCommit,
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
				authorUserId: actor.userId,
				authorVia: actor.via,
				authorToken: actor.token,
				sessionId: actor.sessionId,
				createdAt: this.deps.clock.now(),
			})
			.returning();
		await tx
			.update(orchestrations)
			.set({ headVersion: number })
			.where(eq(orchestrations.id, orchestration.id));
		const view = toVersionView(row as VersionRow, await sessionOfVersion(tx, row as VersionRow));
		// 平台记录放在事务的最后（会话那一行的锁是最后拿的一把）。
		await this.#recordForSession(tx, actor, orchestration, number, pending);
		return view;
	}

	async getVersion(
		orchestrationId: string,
		number: number,
	): Promise<OrchestrationVersionView | undefined> {
		const row = await versionRow(this.deps.db, orchestrationId, number);
		return row && toVersionView(row, await sessionOfVersion(this.deps.db, row));
	}
}
