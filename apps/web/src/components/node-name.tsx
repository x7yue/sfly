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
 * 页面上写运行里的节点：「显示名称（节点 ID）」，节点 ID 用等宽字体；没有显示名称时只写节点 ID。
 * 放不下时（在 flex 行里，或者比所在的块还宽）截断显示名称，括号里的节点 ID 总是完整的；截断时悬停或聚焦显示全文（`Truncate`）。
 * 放在按钮里时，由按钮用 `Truncate` 的 `render` 和 `label` 提示全文，这里只截断。
 */
export function NodeName({ node, className }: { node: RunNodeName; className?: string }) {
	const name = nameBeforeId(node.node_id, node.display_name);
	if (name === undefined) return <span className={cn("font-mono", className)}>{node.node_id}</span>;
	return (
		<span className={cn("inline-flex min-w-0 max-w-full", className)}>
			<Truncate>{name}</Truncate>
			<span className="flex-none">
				（<span className="font-mono">{node.node_id}</span>）
			</span>
		</span>
	);
}
