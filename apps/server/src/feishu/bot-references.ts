import {
	type NodeTypeIo,
	nodeTypeOf,
	packageKey,
	referencedFeishuBots,
	referencesIn,
} from "@sfly/orchestration";
import type { FeishuBotReference, FeishuBotScenario, OrchestrationDocument } from "@sfly/schema";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { nodePackages, orchestrations, orchestrationVersions } from "../db/schema.js";

/**
 * 引用某个飞书机器人的场景（删除机器人之前列出，ADR 0020）：场景自己的设置（运行通知）和最新场景版本里引用它的地方。
 * 已归档的场景不列（不能触发，恢复之后保存和触发的检查会指出）。
 *
 * 每种引用是一个来源（{@link BOT_REFERENCE_SOURCES} 里的一项）：给定机器人名称，返回引用它的地方，按场景。
 * 加一种引用就是加一个来源和契约里的一个 `kind`。
 */
type BotReferenceSource = (
	db: Db,
	bot: string,
) => Promise<ReadonlyArray<{ orchestrationId: string; reference: FeishuBotReference }>>;

/** 没有归档的场景的最新版本文档。 */
async function headDocuments(
	db: Db,
): Promise<{ orchestrationId: string; document: OrchestrationDocument }[]> {
	return db
		.select({ orchestrationId: orchestrations.id, document: orchestrationVersions.document })
		.from(orchestrations)
		.innerJoin(
			orchestrationVersions,
			and(
				eq(orchestrationVersions.orchestrationId, orchestrations.id),
				eq(orchestrationVersions.number, orchestrations.headVersion),
			),
		)
		.where(isNull(orchestrations.archivedAt));
}

/** 最新场景版本里的飞书通知节点。 */
const notifyNodes: BotReferenceSource = async (db, bot) =>
	(await headDocuments(db)).flatMap(({ orchestrationId, document }) =>
		document.nodes.flatMap((node) =>
			node.kind === "feishu_notify" && node.bot === bot
				? [
						{
							orchestrationId,
							reference: { kind: "feishu_notify_node" as const, node_id: node.id },
						},
					]
				: [],
		),
	);

/** 最新场景版本里「飞书机器人」类型的输入的常量值（要按文档锁定的节点包版本的元信息认出这种输入）。 */
const botInputs: BotReferenceSource = async (db, bot) => {
	const heads = await headDocuments(db);
	const locked = new Map<string, { name: string; version: string }>();
	for (const { document } of heads) {
		if (!document.nodes.some((n) => n.kind === "package")) continue;
		for (const [name, version] of Object.entries(document.packages)) {
			locked.set(packageKey(name, version), { name, version });
		}
	}
	const rows =
		locked.size === 0
			? []
			: await db
					.select({
						name: nodePackages.name,
						version: nodePackages.version,
						metadata: nodePackages.metadata,
					})
					.from(nodePackages)
					.where(
						or(
							...[...locked.values()].map((p) =>
								and(eq(nodePackages.name, p.name), eq(nodePackages.version, p.version)),
							),
						),
					);
	// 开发版本和已不存在的版本没有元信息，认不出这种输入。
	const catalog = new Map<string, readonly NodeTypeIo[]>(
		rows.map((row) => [packageKey(row.name, row.version), row.metadata.nodes]),
	);
	return heads.flatMap(({ orchestrationId, document }) =>
		document.nodes.flatMap((node) => {
			if (node.kind !== "package") return [];
			const type = nodeTypeOf(document, node, catalog);
			if (!type) return [];
			return referencedFeishuBots(type.inputs, node.inputs)
				.filter((r) => r.bot === bot && referencesIn(r.bot).length === 0)
				.map(({ input }) => ({
					orchestrationId,
					reference: { kind: "feishu_bot_input" as const, node_id: node.id, input },
				}));
		}),
	);
};

/** 场景设置里的运行通知选了这个机器人（场景自己的设置，没有保存过版本的场景也在）。 */
const runNotifications: BotReferenceSource = async (db, bot) =>
	(
		await db
			.select({ orchestrationId: orchestrations.id })
			.from(orchestrations)
			.where(and(eq(orchestrations.runNotifyBot, bot), isNull(orchestrations.archivedAt)))
	).map(({ orchestrationId }) => ({
		orchestrationId,
		reference: { kind: "run_notification" as const },
	}));

const BOT_REFERENCE_SOURCES: readonly BotReferenceSource[] = [
	notifyNodes,
	botInputs,
	runNotifications,
];

/** 引用这个机器人的场景（按场景名排序）和场景里引用它的地方。 */
export async function scenariosReferencingBot(db: Db, bot: string): Promise<FeishuBotScenario[]> {
	const found = (await Promise.all(BOT_REFERENCE_SOURCES.map((source) => source(db, bot)))).flat();
	if (found.length === 0) return [];
	const names = await db
		.select({ id: orchestrations.id, name: orchestrations.name })
		.from(orchestrations)
		.orderBy(asc(orchestrations.name), asc(orchestrations.id));
	return names.flatMap(({ id, name }) => {
		const references = found.filter((f) => f.orchestrationId === id).map((f) => f.reference);
		return references.length === 0
			? []
			: [
					{
						orchestration_id: id,
						name,
						references: references as [FeishuBotReference, ...FeishuBotReference[]],
					},
				];
	});
}
