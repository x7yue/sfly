import { cn } from "cn";

/**
 * 运行抽屉表单里一节的小标题（运行预设、入口参数、触发前检查）：`first` 是表单里的第一节，上面不留空。
 * 标题右侧的说明或操作写成 `ml-auto` 的子元素。
 */
export function SectionTitle({ children, first }: { children: React.ReactNode; first?: boolean }) {
	return (
		<h3
			className={cn(
				"mb-2.5 flex items-center text-xs font-semibold tracking-wide text-fg-2",
				first ? "mt-0" : "mt-4.5",
			)}
		>
			{children}
		</h3>
	);
}
