import type { Annotation } from "@sfly/schema";
import { cn } from "cn";
import { ChevronRightIcon, PanelLeftCloseIcon, SearchIcon, StickyNoteIcon } from "lucide-react";
import { useState } from "react";
import { KIND_META } from "#/components/canvas/node-display";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Truncate } from "@/components/ui/truncate";
import type { CanvasOutline, OutlineNode } from "./outline";

/** 大纲面板的宽度（画布适配视图、定位节点时避开它）。 */
export const OUTLINE_WIDTH = 248;

/**
 * 画布左侧的大纲（outline.ts）：不在注释框里的节点在最前，每个注释框一组（可以收起）；按名称、节点 ID、
 * 注释框标题搜索；点节点选中并定位到它，点注释框的标题定位到框（编辑模式下同时选中它）。
 * 面板放在小地图上方，和右侧的检查器一样是浮在画布上的面板，按钮都在 Tab 顺序里。它常常压在节点上，
 * 所以底色不透明（检查器是 94%），后面卡片上的字不会透出来。
 */
export function OutlinePanel({
	outline,
	query,
	onQuery,
	selected,
	onLocateNode,
	onLocateAnnotation,
	onLocateSticky,
	onCollapse,
}: {
	outline: CanvasOutline;
	query: string;
	onQuery(query: string): void;
	/** 选中的节点、注释框和便签（高亮对应的行）。 */
	selected: { nodes: readonly string[]; annotation: string | null; sticky: string | null };
	onLocateNode(id: string): void;
	onLocateAnnotation(id: string): void;
	onLocateSticky(id: string): void;
	onCollapse(): void;
}) {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const toggle = (id: string) =>
		setCollapsed((c) => {
			const next = new Set(c);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const empty =
		outline.loose.length === 0 && outline.groups.length === 0 && outline.stickies.length === 0;
	return (
		<aside
			aria-label="大纲"
			className="absolute top-15.5 bottom-36 left-3 z-10 flex flex-col overflow-hidden rounded-xl border border-border-soft bg-surface shadow-float"
			style={{ width: OUTLINE_WIDTH }}
		>
			<div className="flex flex-none items-center gap-1 border-b border-border-soft py-1.5 pr-1.5 pl-3.5">
				<h2 className="m-0 flex-1 text-base font-semibold text-fg-1">大纲</h2>
				<Button variant="ghost" size="icon-sm" aria-label="收起大纲" onClick={onCollapse}>
					<PanelLeftCloseIcon />
				</Button>
			</div>
			<div className="relative flex-none px-2.5 pt-2.5 pb-1.5">
				<SearchIcon
					aria-hidden
					className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-[calc(50%-2px)] text-fg-3"
				/>
				<Input
					type="search"
					aria-label="搜索节点或注释框"
					placeholder="搜索节点或注释框"
					value={query}
					onChange={(e) => onQuery(e.target.value)}
					className="pl-8"
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
				{empty ? (
					<p className="m-0 px-2 py-3 text-xs text-fg-3">
						{query.trim() ? "没有匹配的节点或注释框" : "画布上还没有节点"}
					</p>
				) : (
					<>
						{outline.loose.length > 0 && (
							<section aria-label="不在注释框里的节点">
								{outline.groups.length > 0 && (
									<h3 className="m-0 px-2 pt-2 pb-1 text-xs font-normal text-fg-3">不在注释框里</h3>
								)}
								<NodeList nodes={outline.loose} selected={selected.nodes} onLocate={onLocateNode} />
							</section>
						)}
						{outline.groups.map(({ annotation, nodes }) => (
							<Group
								key={annotation.id}
								annotation={annotation}
								count={nodes.length}
								open={!collapsed.has(annotation.id) || query.trim() !== ""}
								selected={selected.annotation === annotation.id}
								onToggle={() => toggle(annotation.id)}
								onLocate={() => onLocateAnnotation(annotation.id)}
							>
								<NodeList nodes={nodes} selected={selected.nodes} onLocate={onLocateNode} />
							</Group>
						))}
						{outline.stickies.length > 0 && (
							<section aria-label="便签" className="mt-1">
								<h3 className="m-0 px-2 pt-2 pb-1 text-xs font-normal text-fg-3">便签</h3>
								<ul className="m-0 list-none p-0">
									{outline.stickies.map((s) => {
										const isSelected = selected.sticky === s.id;
										return (
											<li key={s.id}>
												<button
													type="button"
													onClick={() => onLocateSticky(s.id)}
													aria-current={isSelected || undefined}
													className={cn(
														"flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 hover:bg-raised hover:text-fg-1",
														isSelected && "selected-row text-fg-1 hover:bg-selected-bg",
													)}
												>
													<StickyNoteIcon aria-hidden className="size-3.5 flex-none text-fg-3" />
													<Truncate className="flex-1">{s.label}</Truncate>
												</button>
											</li>
										);
									})}
								</ul>
							</section>
						)}
					</>
				)}
			</div>
		</aside>
	);
}

function Group({
	annotation,
	count,
	open,
	selected,
	onToggle,
	onLocate,
	children,
}: {
	annotation: Annotation;
	count: number;
	open: boolean;
	selected: boolean;
	onToggle(): void;
	onLocate(): void;
	children: React.ReactNode;
}) {
	return (
		<section aria-label={`注释框 ${annotation.title}`} className="mt-1">
			<div
				className={cn(
					"flex items-center gap-0.5 rounded-md hover:bg-raised",
					selected && "selected-row hover:bg-selected-bg",
				)}
			>
				<button
					type="button"
					aria-label={open ? `收起 ${annotation.title}` : `展开 ${annotation.title}`}
					aria-expanded={open}
					onClick={onToggle}
					className="grid size-6 flex-none cursor-pointer place-items-center rounded-sm text-fg-3 hover:text-fg-1"
				>
					<ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
				</button>
				<button
					type="button"
					onClick={onLocate}
					aria-current={selected || undefined}
					className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 pr-2 text-left text-sm font-semibold text-fg-1"
				>
					<span
						data-annotation-color={annotation.color ?? "gray"}
						aria-hidden
						className="size-2.5 flex-none rounded-full bg-canvas-annotation-swatch forced-color-adjust-none"
					/>
					<Truncate className="flex-1">{annotation.title}</Truncate>
					<span className="flex-none font-mono text-xs font-normal text-fg-3">{count}</span>
				</button>
			</div>
			{open && <div className="pl-4">{children}</div>}
		</section>
	);
}

function NodeList({
	nodes,
	selected,
	onLocate,
}: {
	nodes: readonly OutlineNode[];
	selected: readonly string[];
	onLocate(id: string): void;
}) {
	return (
		<ul className="m-0 list-none p-0">
			{nodes.map((n) => {
				const Icon = KIND_META[n.kind as keyof typeof KIND_META]?.icon;
				const isSelected = selected.includes(n.id);
				return (
					<li key={n.id}>
						<button
							type="button"
							onClick={() => onLocate(n.id)}
							aria-current={isSelected || undefined}
							className={cn(
								"flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 hover:bg-raised hover:text-fg-1",
								isSelected && "selected-row text-fg-1 hover:bg-selected-bg",
							)}
						>
							{Icon && <Icon aria-hidden className="size-3.5 flex-none text-fg-3" />}
							<Truncate className="flex-1">{n.title}</Truncate>
							{n.title !== n.id && (
								<span className="max-w-[40%] flex-none truncate font-mono text-xs text-fg-3">
									{n.id}
								</span>
							)}
						</button>
					</li>
				);
			})}
		</ul>
	);
}
