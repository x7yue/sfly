import type { ParamDeclView } from "@sfly/schema";
import { cn } from "cn";
import { EyeIcon, EyeOffIcon, LockIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { FieldValue } from "./trigger-form";

/** 敏感参数临时显示的时长。 */
const REVEAL_MS = 5000;

/** 只在下划线后断行，不在单词中间断开；用 <wbr>，它不进读屏名称与复制的文字。 */
const breakableName = (name: string) =>
	name.split("_").map((part, i, parts) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: 参数名按下划线切成的片段，位置就是身份
		<span key={i}>
			{part}
			{i < parts.length - 1 && (
				<>
					_<wbr />
				</>
			)}
		</span>
	));

const defaultHelp = (param: ParamDeclView): string | null =>
	param.secret
		? "界面和日志中都会打码"
		: param.default !== undefined && param.type !== "boolean"
			? `默认 ${JSON.stringify(param.default)}`
			: null;

/**
 * 一个入口参数的表单行：标签（名称、类型、是否敏感）与按类型渲染的控件，加上错误和帮助文字。
 * 运行抽屉和运行预设的编辑表单共用。外层是网格，这一行占满整行（subgrid）：标签列、控件列，
 * 给了 `leading` 时最前面再多一列，外层网格要按列数排好。
 */
export function ParamField({
	param,
	value,
	error,
	onChange,
	onBlur,
	lockedBy,
	disabled = false,
	help = defaultHelp(param),
	leading,
	kept = false,
	onReplace,
}: {
	param: ParamDeclView;
	value: FieldValue | undefined;
	error?: string | undefined;
	onChange?: (value: FieldValue) => void;
	onBlur?: () => void;
	/** 由这个运行预设固定：控件只读、标签带锁的图标，帮助文字写「由预设 <名称> 固定」。 */
	lockedBy?: string | undefined;
	/** 不能编辑（预设编辑表单里没有勾选的参数）。 */
	disabled?: boolean;
	/** 代替默认的帮助文字（默认值或打码说明）；null 不显示。 */
	help?: string | null;
	/** 标签前面的一格，例如预设编辑表单的「预设」勾选框。 */
	leading?: React.ReactNode;
	/** 沿用预设里原来的 secret 值（预设编辑表单）：控件显示「已填写」，点「替换」（`onReplace`）才重新输入。 */
	kept?: boolean;
	onReplace?: () => void;
}) {
	const id = useId();
	const labelId = `${id}-label`;
	const helpId = `${id}-help`;
	const errorId = `${id}-error`;
	const [revealed, setRevealed] = useState(false);
	useEffect(() => {
		if (!revealed) return;
		const timer = setTimeout(() => setRevealed(false), REVEAL_MS);
		return () => clearTimeout(timer);
	}, [revealed]);
	// 点「替换」之后控件换成输入框：焦点跟过去，直接输入新值。
	const wasKept = useRef(kept);
	useEffect(() => {
		if (wasKept.current && !kept) document.getElementById(id)?.focus();
		wasKept.current = kept;
	}, [kept, id]);

	const locked = lockedBy !== undefined;
	const helpText = locked ? `由预设 ${lockedBy} 固定` : help;
	const describedBy = [error ? errorId : null, helpText ? helpId : null].filter(Boolean).join(" ");
	const aria = {
		id,
		"aria-invalid": error ? true : undefined,
		"aria-describedby": describedBy || undefined,
		"aria-required": (!locked && param.required) || undefined,
	};
	// 锁定的值只看不改：去掉输入框的底色，和能填写的字段区分开。
	const lockedLook = locked ? "border-border-soft bg-transparent text-fg-2" : undefined;
	const change = (next: FieldValue) => onChange?.(next);
	const blur = () => onBlur?.();
	const hidden = param.secret && !revealed;
	// 锁定的 secret 参数拿到的已经是打码后的值，不论类型都显示成一个只读的密码框。
	const masked = locked && param.secret;
	let control: React.ReactNode;
	if (kept) {
		control = (
			<div className="flex gap-1.5">
				<Input
					{...aria}
					value="已填写"
					readOnly
					className="border-border-soft bg-transparent text-fg-2"
				/>
				<Button
					variant="ghost"
					size="sm"
					aria-label={`替换 ${param.name}`}
					onClick={() => onReplace?.()}
				>
					替换
				</Button>
			</div>
		);
	} else if (param.type === "boolean" && !masked) {
		control = (
			<div className="flex h-7.5 items-center gap-2">
				<Switch
					{...aria}
					aria-labelledby={labelId}
					checked={value === true}
					readOnly={locked}
					disabled={disabled}
					onCheckedChange={(checked) => change(checked)}
					onBlur={blur}
				/>
				<span className="font-mono text-xs text-fg-2">{value === true ? "true" : "false"}</span>
			</div>
		);
	} else if (param.type === "json" && !masked) {
		control = (
			<Textarea
				{...aria}
				rows={3}
				spellCheck={false}
				className={cn("font-mono text-xs", lockedLook)}
				value={String(value ?? "")}
				readOnly={locked}
				disabled={disabled}
				onChange={(e) => change(e.target.value)}
				onBlur={blur}
			/>
		);
	} else {
		control = (
			<div className="flex gap-1.5">
				<Input
					{...aria}
					type={hidden ? "password" : "text"}
					inputMode={param.type === "number" ? "decimal" : undefined}
					autoComplete="off"
					spellCheck={false}
					className={cn((param.type === "number" || param.secret) && "font-mono", lockedLook)}
					value={String(value ?? "")}
					readOnly={locked}
					disabled={disabled}
					onChange={(e) => change(e.target.value)}
					onBlur={blur}
				/>
				{param.secret && !locked && !disabled && (
					<Button
						variant="ghost"
						size="icon"
						aria-label={revealed ? `隐藏 ${param.name}` : `临时显示 ${param.name} 5 秒`}
						title={revealed ? "隐藏" : "临时显示 5 秒"}
						onClick={() => setRevealed((r) => !r)}
					>
						{revealed ? <EyeOffIcon /> : <EyeIcon />}
					</Button>
				)}
			</div>
		);
	}
	return (
		<div className="col-span-full grid grid-cols-subgrid items-start">
			{leading}
			<label id={labelId} htmlFor={id} className="min-w-0 pt-1.5 text-sm wrap-anywhere text-fg-2">
				<span className="font-mono">{breakableName(param.name)}</span>
				{param.required && !locked && (
					<span aria-hidden className="ml-0.5 text-fg-2">
						*
					</span>
				)}
				{locked && <LockIcon aria-hidden className="ml-1 inline size-3 align-baseline text-fg-3" />}
				<span className="block font-mono text-xs text-fg-3">
					{param.type}
					{param.secret && " · 敏感"}
				</span>
			</label>
			<div className="flex min-w-0 flex-col gap-1.25">
				{control}
				{error && (
					<p id={errorId} className="m-0 text-xs text-danger-fg">
						{error}
					</p>
				)}
				{helpText && (
					<p id={helpId} className="m-0 text-xs text-fg-3">
						{helpText}
					</p>
				)}
			</div>
		</div>
	);
}
