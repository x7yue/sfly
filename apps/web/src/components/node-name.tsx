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
 *
 * `priority="name"`：宽度很紧的名称列（运行监控的时间线）反过来，先截断「（节点 ID）」（括号一起收起，不留空括号），
 * 显示名称尽量完整：读的人认的是显示名称，节点 ID 在悬停提示、读屏名称和别处都有全文。
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
		return (
			<span className={cn("inline-flex min-w-0 max-w-full", className)}>
				{/*
				 * 缩小的权重差很大：名称与 ID 一起放不下时，几乎全由 ID 让出，ID 一个字也不剩以后名称才接着缩。
				 * 缩小系数不能小于 1：几个系数加起来不到 1 时，浏览器只让它们吸收一部分超出的宽度，名称缩不到位。
				 */}
				<Truncate>{name}</Truncate>
				<span data-truncate-clip="" className="block min-w-0 shrink-[400] truncate">
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
