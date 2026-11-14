import type { Annotation } from "@sfly/schema";
import {
	ContextMenuItem,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { hasMember, memberCount } from "./annotations";

/** 节点菜单里和注释框有关的操作（编辑模式）。 */
export interface AnnotationMenuActions {
	annotations: readonly Annotation[];
	/** 新建只含这个节点的注释框。 */
	onAdd(): void;
	onJoin(annotationId: string): void;
	onLeave(annotationId: string): void;
}

function AnnotationLabel({ annotation }: { annotation: Annotation }) {
	return (
		<>
			<span className="min-w-0 truncate">{annotation.title}</span>
			<span className="ml-auto flex-none pl-4 font-mono text-xs text-fg-3">{annotation.id}</span>
		</>
	);
}

/**
 * 节点菜单的「添加注释框」「加入注释框 ▸」「移出注释框 ▸」。加入列出还不包含这个节点的注释框；
 * 移出列出包含它的注释框，它是唯一的成员时不能移出（注释框不能没有成员，要删掉注释框用检查器）。
 */
export function AnnotationMenuItems({
	nodeId,
	actions,
}: {
	nodeId: string;
	actions: AnnotationMenuActions;
}) {
	const joinable = actions.annotations.filter((a) => !hasMember(a, nodeId));
	const containing = actions.annotations.filter((a) => hasMember(a, nodeId));
	return (
		<>
			<ContextMenuItem onClick={actions.onAdd}>添加注释框</ContextMenuItem>
			<ContextMenuSub>
				<ContextMenuSubTrigger disabledReason={joinable.length > 0 ? null : "没有可以加入的注释框"}>
					加入注释框
				</ContextMenuSubTrigger>
				<ContextMenuSubContent aria-label="加入注释框">
					{joinable.map((a) => (
						<ContextMenuItem key={a.id} onClick={() => actions.onJoin(a.id)}>
							<AnnotationLabel annotation={a} />
						</ContextMenuItem>
					))}
				</ContextMenuSubContent>
			</ContextMenuSub>
			<ContextMenuSub>
				<ContextMenuSubTrigger
					disabledReason={containing.length > 0 ? null : "这个节点不在注释框里"}
				>
					移出注释框
				</ContextMenuSubTrigger>
				<ContextMenuSubContent aria-label="移出注释框">
					{containing.map((a) => (
						<ContextMenuItem
							key={a.id}
							disabledReason={memberCount(a) === 1 ? "它是这个注释框唯一的成员" : null}
							onClick={() => actions.onLeave(a.id)}
						>
							<AnnotationLabel annotation={a} />
						</ContextMenuItem>
					))}
				</ContextMenuSubContent>
			</ContextMenuSub>
		</>
	);
}
