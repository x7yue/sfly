import { Checkbox } from "@/components/ui/checkbox";
import type { Repair } from "./invalid-preset";

/** 值在列表里怎么写：字符串原样，其余按 JSON。 */
const valueText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * 编辑失效的运行预设时，已不存在的预设参数（参数被删除或改名）单独列在这里：和别的预设参数一样有「预设」勾选框，
 * 取消勾选之后保存，它们就不再属于这个预设。`error` 是提交时还勾选着它们的提示。
 */
export function GoneParams({
	repair,
	error,
	onKeep,
}: {
	repair: Repair;
	error?: string | undefined;
	onKeep: (name: string, keep: boolean) => void;
}) {
	if (repair.gone.length === 0) return null;
	return (
		<section
			aria-label="已不存在的预设参数"
			className="flex flex-col gap-2 rounded-lg border border-warn-line bg-warn-soft px-3 py-2"
		>
			<p className="m-0 text-xs text-warn-fg">
				这些预设参数在入口参数里已经没有了（参数被删除或改名）。取消勾选，保存之后它们就不再属于这个预设。
			</p>
			<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
				{repair.gone.map(({ name, value }) => {
					const kept = repair.kept.includes(name);
					return (
						<li key={name} className="flex items-center gap-2.5 text-sm">
							<Checkbox
								aria-label={`预设 ${name}`}
								aria-invalid={error && kept ? true : undefined}
								checked={kept}
								onChange={(e) => onKeep(name, e.target.checked)}
							/>
							<span className="font-mono text-fg-2">{name}</span>
							<span className="min-w-0 font-mono text-xs wrap-anywhere text-fg-3">
								= {valueText(value)}
							</span>
						</li>
					);
				})}
			</ul>
			{error && (
				<p role="alert" className="m-0 text-xs text-danger-fg">
					{error}
				</p>
			)}
		</section>
	);
}
