import { cn } from "cn";
import { BracesIcon, XIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { ACTION } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import type { FieldControl } from "./fields";
import { ReferenceList } from "./ReferenceList";
import { completionGroups, moveActive, type ReferenceChoice } from "./reference-completion";

/**
 * 非字符串参数（数字、布尔、枚举、JSON）旁的「插入引用」按钮：点它弹出引用补全，选中的引用成为整个值（整值引用）。
 * 键盘：焦点在按钮上时 ↑ ↓ 选择，Enter 确认，Esc 关闭。补全列表与 ReferenceEditor 用的是同一个，
 * 定位在最近的 relative 祖先（Field）里、控件的正下方。
 */
export function ReferencePicker({
	name,
	choices,
	onPick,
}: {
	/** 字段名，用在无障碍名称里。 */
	name: string;
	choices: readonly ReferenceChoice[];
	onPick(choice: ReferenceChoice): void;
}) {
	const listId = useId();
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const { groups, ordered } = useMemo(() => completionGroups(choices, ""), [choices]);
	const pick = (choice: ReferenceChoice) => {
		setOpen(false);
		onPick(choice);
	};
	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				className="flex-none"
				aria-label={`在 ${name} 中${ACTION.insertReference}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				title={ACTION.insertReference}
				onClick={() => {
					setActive(0);
					setOpen((o) => !o);
				}}
				onBlur={() => setOpen(false)}
				onKeyDown={(e) => {
					if (!open) return;
					if (e.key === "Escape") {
						// 只关掉补全：不让检查器把这次 Esc 当成离开。
						e.preventDefault();
						e.stopPropagation();
						setOpen(false);
					} else if (ordered.length === 0) {
						return;
					} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						setActive((a) => moveActive(a, e.key === "ArrowDown" ? 1 : -1, ordered.length));
					} else if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						const choice = ordered[active];
						if (choice) pick(choice);
					}
				}}
			>
				<BracesIcon />
			</Button>
			{open && (
				<ReferenceList
					id={listId}
					className="top-8.5"
					choices={choices}
					groups={groups}
					ordered={ordered}
					active={active}
					onChoose={pick}
				/>
			)}
		</>
	);
}

/**
 * 引用标签：非字符串参数的值是整值引用时，代替类型控件显示；点 × 清掉引用，回到类型控件。
 * 外观与 ReferenceEditor 里高亮的引用一致。
 */
export function ReferenceChip({
	ref,
	control,
	label,
	name,
	value,
	onRemove,
}: {
	/** × 按钮（引用刚生成时把焦点放到这里）。 */
	ref?: React.Ref<HTMLButtonElement>;
	control?: FieldControl;
	/** 无障碍名称（与类型控件相同，如「输入 expect」）。 */
	label: string;
	name: string;
	/** 完整的引用 `${{ 表达式 }}`。 */
	value: string;
	onRemove(): void;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: 一个值和它的移除按钮，不是表单分组
		<div
			id={control?.id}
			aria-describedby={control?.["aria-describedby"]}
			data-field-key={control?.["data-field-key"]}
			role="group"
			aria-label={label}
			data-slot="reference-chip"
			data-invalid={control?.["aria-invalid"]}
			className={cn(
				"flex h-7.5 min-w-0 items-center gap-1 rounded-md border border-border-strong bg-raised-2 pr-0.5 pl-2 data-invalid:border-danger",
			)}
		>
			<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-1" title={value}>
				{value}
			</span>
			<Button
				ref={ref}
				variant="ghost"
				size="icon-sm"
				className="flex-none"
				aria-label={`移除 ${name} 的引用`}
				title="移除引用"
				onClick={onRemove}
			>
				<XIcon />
			</Button>
		</div>
	);
}
