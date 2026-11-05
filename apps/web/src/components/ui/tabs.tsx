import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "cn";

/**
 * 页签（shadcn/ui base-nova 拉取后按设计体系改写，只保留原型 `.tabs` 的下划线样式）：
 * 选中的页签白色文字 + 2px 白色下划线（中性高亮），其余二级文字。
 */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />
	);
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			className={cn("flex flex-none gap-0.5 border-b border-border-soft px-2.5", className)}
			{...props}
		/>
	);
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
	return (
		<TabsPrimitive.Tab
			data-slot="tabs-trigger"
			className={cn(
				"-mb-px inline-flex cursor-pointer items-center gap-1 border-b-2 border-transparent px-2.5 pt-2.25 pb-2 text-sm whitespace-nowrap text-fg-2 hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40 data-active:border-primary data-active:text-fg-1",
				className,
			)}
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
	return (
		<TabsPrimitive.Panel
			data-slot="tabs-content"
			className={cn("min-h-0 flex-1 text-sm", className)}
			{...props}
		/>
	);
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
