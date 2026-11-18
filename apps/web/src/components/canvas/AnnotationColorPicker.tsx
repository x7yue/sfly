import { ANNOTATION_COLORS, type AnnotationColor } from "@sfly/schema";
import { cn } from "cn";
import { CheckIcon } from "lucide-react";
import { ANNOTATION_COLOR_LABEL } from "#/lib/copy";

/**
 * 注释框的颜色选择（ADR 0025）：一排六个色块，下面写颜色名，当前的带对勾和描边；按钮用 aria-pressed，和 `Segmented` 一样。
 * 色块的颜色由 `data-annotation-color` 算出（tokens.css），和画布上的注释框同一套。强制颜色模式下保留色块的颜色，
 * 当前项另有系统高亮的描边（app.css）。整组的名称由使用方给：`aria-label`，或 `aria-labelledby` 指向字段名称。
 */
export function AnnotationColorPicker({
	value,
	onChange,
	className,
	...group
}: {
	value: AnnotationColor;
	onChange(color: AnnotationColor): void;
	className?: string;
	id?: string;
	"aria-label"?: string;
	"aria-labelledby"?: string;
}) {
	return (
		<fieldset {...group} className={cn("m-0 flex gap-1 border-0 p-0", className)}>
			{ANNOTATION_COLORS.map((color) => (
				<button
					key={color}
					type="button"
					aria-pressed={color === value}
					onClick={() => onChange(color)}
					className="group flex w-8 cursor-pointer flex-col items-center gap-1 rounded-md py-1 text-xs text-fg-3 hover:text-fg-1 aria-pressed:text-fg-1"
				>
					<span
						data-annotation-color={color}
						className="grid size-5.5 place-items-center rounded-full bg-canvas-annotation-swatch text-primary-foreground outline-offset-2 forced-color-adjust-none group-aria-pressed:outline-[1.5px] group-aria-pressed:outline-selected group-aria-pressed:outline-solid [&_svg]:size-3.5"
					>
						{color === value && <CheckIcon aria-hidden />}
					</span>
					{ANNOTATION_COLOR_LABEL[color]}
				</button>
			))}
		</fieldset>
	);
}
