import { cn } from "cn";

/**
 * 分段选择（原型 `.seg`）：一组互斥的按钮（fieldset，role=group），当前项为中性高亮（raised-2 底），用 aria-pressed 表示。
 * 用于筛选（全部 / 运行中 / 失败…）和视图切换；只有图标的选项必须给 label 作为 aria-label。
 *
 *   <Segmented label="最近运行" value={status} onChange={setStatus}
 *     options={[{ value: "all", label: "全部" }, { value: "running", label: "运行中" }]} />
 */
export interface SegmentedOption<V extends string> {
	value: V;
	label: string;
	/** 只显示图标时传入，label 作为 aria-label。 */
	icon?: React.ReactNode;
}

export function Segmented<V extends string>({
	label,
	value,
	onChange,
	options,
	className,
}: {
	/** 整组的名称（role=group 的 aria-label）。 */
	label: string;
	value: V;
	onChange: (value: V) => void;
	options: readonly SegmentedOption<V>[];
	className?: string;
}) {
	return (
		<fieldset
			aria-label={label}
			className={cn(
				"inline-flex h-7.5 items-center gap-0.5 rounded-md border border-border bg-sunk p-0.5",
				className,
			)}
		>
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					aria-pressed={o.value === value}
					aria-label={o.icon ? o.label : undefined}
					title={o.icon ? o.label : undefined}
					onClick={() => onChange(o.value)}
					className="inline-flex h-full cursor-pointer items-center gap-1 rounded-sm px-2.25 text-xs text-fg-2 transition-colors hover:text-fg-1 aria-pressed:bg-raised-2 aria-pressed:text-fg-1 [&_svg]:size-3.5"
				>
					{o.icon ?? o.label}
				</button>
			))}
		</fieldset>
	);
}
