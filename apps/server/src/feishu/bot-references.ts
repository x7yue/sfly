import type { FeishuBotReference, FeishuBotScenario } from "@sfly/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { orchestrations, orchestrationVersions } from "../db/schema.js";

/**
 * 引用某个飞书机器人的场景（删除机器人之前列出，ADR 0020）：场景自己的设置和最新场景版本里引用它的地方。
 * 已归档的场景不列（不能触发，恢复之后保存和触发的检查会指出）。
 *
 * 每种引用是一个来源（{@link BOT_REFERENCE_SOURCES} 里的一项）：给定机器人名称，返回引用它的地方，按场景。
 * 加一种引用（运行通知的设置、「飞书机器人」类型的输入的常量值）就是加一个来源和契约里的一个 `kind`。
 */
type BotReferenceSource = (
	db: Db,
	bot: string,
) => Promise<ReadonlyArray<{ orchestrationId: string; reference: FeishuBotReference }>>;

/** 最新场景版本里的飞书通知节点。 */
const notifyNodes: BotReferenceSource = async (db, bot) => {
	const heads = await db
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
	return heads.flatMap(({ orchestrationId, document }) =>
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
};

const BOT_REFERENCE_SOURCES: readonly BotReferenceSource[] = [notifyNodes];

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
