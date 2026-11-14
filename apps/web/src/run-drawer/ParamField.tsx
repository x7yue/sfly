import type { ParamDeclView } from "@sfly/schema";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
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

/**
 * 一个入口参数的表单行：标签（名称、类型、是否敏感）与按类型渲染的控件，加上错误和帮助文字。
 * 外层是两列的网格（标签列、控件列），这一行占满整行（subgrid）。
 */
export function ParamField({
	param,
	value,
	error,
	onChange,
	onBlur,
}: {
	param: ParamDeclView;
	value: FieldValue | undefined;
	error: string | undefined;
	onChange: (value: FieldValue) => void;
	onBlur: () => void;
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

	const help = param.secret
		? "界面和日志中都会打码"
		: param.default !== undefined && param.type !== "boolean"
			? `默认 ${JSON.stringify(param.default)}`
			: null;
	const describedBy = [error ? errorId : null, help ? helpId : null].filter(Boolean).join(" ");
	const aria = {
		id,
		"aria-invalid": error ? true : undefined,
		"aria-describedby": describedBy || undefined,
		"aria-required": param.required || undefined,
	};
	const hidden = param.secret && !revealed;
	let control: React.ReactNode;
	if (param.type === "boolean") {
		control = (
			<div className="flex h-7.5 items-center gap-2">
				<Switch
					{...aria}
					aria-labelledby={labelId}
					checked={value === true}
					onCheckedChange={(checked) => onChange(checked)}
					onBlur={onBlur}
				/>
				<span className="font-mono text-xs text-fg-2">{value === true ? "true" : "false"}</span>
			</div>
		);
	} else if (param.type === "json") {
		control = (
			<Textarea
				{...aria}
				rows={3}
				spellCheck={false}
				className="font-mono text-xs"
				value={String(value ?? "")}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
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
					className={param.type === "number" || param.secret ? "font-mono" : undefined}
					value={String(value ?? "")}
					onChange={(e) => onChange(e.target.value)}
					onBlur={onBlur}
				/>
				{param.secret && (
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
			<label id={labelId} htmlFor={id} className="min-w-0 pt-1.5 text-sm wrap-anywhere text-fg-2">
				<span className="font-mono">{breakableName(param.name)}</span>
				{param.required && (
					<span aria-hidden className="ml-0.5 text-fg-2">
						*
					</span>
				)}
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
				{help && (
					<p id={helpId} className="m-0 text-xs text-fg-3">
						{help}
					</p>
				)}
			</div>
		</div>
	);
}
