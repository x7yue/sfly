import { nameBeforeId, nameWithId } from "@sfly/orchestration";
import { cn } from "cn";
import { Truncate } from "@/components/ui/truncate";

/** 运行里的节点：节点 ID 和控制面从运行绑定的场景版本里补上的显示名称（子流程入口节点是子流程名称）。 */
export interface RunNodeName {
	node_id: string;
	display_name?: string | undefined;
}

/** 「显示名称（节点 ID）」，没有显示名称时只写节点 ID：用在一句话里、悬停提示和读屏名称里。 */
export const runNodeName = (node: RunNodeName): string =>
	nameWithId(node.node_id, node.display_name);

/**
 * 行内的「显示名称（节点 ID）」：节点 ID 等宽，名称和 ID 都在一段文字里，不单独截断（顶栏的失败摘要整句截断，
 * 概览的失败区域整段折行）。没有显示名称时只写节点 ID。
 */
export function NodeNameInline({ node }: { node: RunNodeName }) {
	const name = nameBeforeId(node.node_id, node.display_name);
	if (name === undefined) return <span className="font-mono">{node.node_id}</span>;
	return (
		<>
			{name}（<span className="font-mono">{node.node_id}</span>）
		</>
	);
}

/**
 * 页面上写运行里的节点：「显示名称（节点 ID）」，节点 ID 用等宽字体；没有显示名称时只写节点 ID。
 * 放不下时（在 flex 行里，或者比所在的块还宽）截断显示名称，括号里的节点 ID 总是完整的；截断时悬停或聚焦显示全文（`Truncate`）。
 * 放在按钮里时，由按钮用 `Truncate` 的 `render` 和 `label` 提示全文，这里只截断。
 *
 * `priority="name"`：宽度很紧的名称列（运行监控的时间线）反过来，显示名称优先：名称和「（节点 ID）」一行放得下才一起显示，
 * 放不下时「（节点 ID）」整个收起（不留半截 ID、不留空括号），名称占满整行、还放不下才截断在末尾。读的人认的是显示名称，
 * 节点 ID 在悬停提示、读屏名称和别处都有全文。
 */
export function NodeName({
	node,
	className,
	priority = "id",
}: {
	node: RunNodeName;
	className?: string;
	priority?: "id" | "name";
}) {
	const name = nameBeforeId(node.node_id, node.display_name);
	if (name === undefined) return <span className={cn("font-mono", className)}>{node.node_id}</span>;
	if (priority === "name") {
		// 一行高、超出的裁掉、允许换行：「（节点 ID）」放不下时换到看不见的第二行，名称独占第一行，不在名称后面截成半截。
		// 外层的 `Truncate`（按钮）靠 `data-truncate-wrap` 知道有内容被收起了，悬停时给出全文。
		return (
			<span
				data-truncate-wrap=""
				className={cn(
					"inline-flex h-[1lh] min-w-0 max-w-full flex-wrap overflow-hidden",
					className,
				)}
			>
				<Truncate>{name}</Truncate>
				<span className="flex-none whitespace-nowrap">
					（<span className="font-mono">{node.node_id}</span>）
				</span>
			</span>
		);
	}
	return (
		<span className={cn("inline-flex min-w-0 max-w-full", className)}>
			<Truncate>{name}</Truncate>
			<span className="flex-none">
				（<span className="font-mono">{node.node_id}</span>）
			</span>
		</span>
	);
}
