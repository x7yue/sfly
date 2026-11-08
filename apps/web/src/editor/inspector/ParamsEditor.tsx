import type { OrchestrationNode } from "@sfly/schema";
import { EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { draftKey, useClearFieldDrafts, useParsedField } from "../field-drafts";
import type { FieldError } from "../validation";

type Param = Extract<OrchestrationNode, { kind: "entry" }>["params"][number];
type ParamType = Param["type"];

/** 敏感参数的默认值临时显示的时长（用户故事 31）。 */
export const REVEAL_MS = 5000;

/**
 * 入口节点 / 子流程入口节点的参数声明：名称、类型、默认值、必填、敏感。
 * 敏感参数的默认值默认隐藏，可以临时显示 5 秒；取消「敏感」需要二次确认。
 * 名称不合法、重复（errors）与默认值解析失败（字段草稿）都会阻止保存。
 */
export function ParamsEditor({
	nodeId,
	params,
	errors,
	onChange,
}: {
	nodeId: string;
	params: Param[];
	errors: FieldError[];
	onChange(params: Param[]): void;
}) {
	const update = (index: number, patch: Partial<Param>) =>
		onChange(params.map((p, i) => (i === index ? { ...p, ...patch } : p)));
	const [confirming, setConfirming] = useState<number | null>(null);
	const clearDrafts = useClearFieldDrafts();
	const pending = confirming === null ? undefined : params[confirming];

	return (
		<div className="flex flex-col gap-2">
			{params.length === 0 && <p className="m-0 text-xs text-fg-3">还没有参数。</p>}
			{params.map((param, index) => {
				const nameError = errors.find((e) => e.field === `params.${index}.name`)?.message;
				return (
					<fieldset
						// biome-ignore lint/suspicious/noArrayIndexKey: 参数名可以编辑，没有稳定的键
						key={index}
						aria-label={`参数 ${param.name}`}
						className="m-0 flex flex-col gap-2 rounded-lg border border-border-soft bg-surface p-2.5"
					>
						<div className="flex gap-1.5">
							<Input
								aria-label="参数名称"
								aria-invalid={nameError ? true : undefined}
								className="font-mono text-xs"
								value={param.name}
								placeholder="名称"
								spellCheck={false}
								onChange={(e) => update(index, { name: e.target.value })}
							/>
							<NativeSelect
								aria-label="参数类型"
								className="w-28 flex-none"
								value={param.type}
								onChange={(e) =>
									update(index, { type: e.target.value as ParamType, default: undefined })
								}
							>
								{(["string", "number", "boolean", "json"] as const).map((t) => (
									<NativeSelectOption key={t} value={t}>
										{t}
									</NativeSelectOption>
								))}
							</NativeSelect>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`删除参数 ${param.name}`}
								onClick={() => {
									// 草稿按参数序号记录，删除后序号变了，一并清掉。
									clearDrafts(draftKey(nodeId, "params."));
									onChange(params.filter((_, i) => i !== index));
								}}
							>
								<Trash2Icon />
							</Button>
						</div>
						{nameError && <p className="m-0 text-xs text-danger-fg">{nameError}</p>}
						<DefaultValue
							// 换类型时重建输入框（旧的文本和草稿不再适用）
							key={param.type}
							fieldKey={draftKey(nodeId, `params.${index}.default`)}
							param={param}
							onChange={(value) => update(index, { default: value })}
						/>
						<div className="flex items-center gap-4 text-xs text-fg-2">
							<span className="flex items-center gap-2">
								<Switch
									aria-label="必填"
									checked={param.required}
									onCheckedChange={(required) => update(index, { required })}
								/>
								<span aria-hidden>必填</span>
							</span>
							<span className="flex items-center gap-2">
								<Switch
									aria-label="敏感"
									checked={param.secret}
									onCheckedChange={(secret) =>
										secret ? update(index, { secret }) : setConfirming(index)
									}
								/>
								<span aria-hidden>敏感</span>
							</span>
						</div>
					</fieldset>
				);
			})}
			<Button
				size="sm"
				className="self-start"
				onClick={() =>
					onChange([
						...params,
						{ name: uniqueParamName(params), type: "string", required: false, secret: false },
					])
				}
			>
				<PlusIcon />
				添加参数
			</Button>
			<Dialog open={pending !== undefined} onOpenChange={(open) => !open && setConfirming(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>取消参数 {pending?.name} 的「敏感」标记？</DialogTitle>
						<DialogDescription>
							取消后，它的默认值和每次运行传入的值会在编辑器、触发表单、运行详情和日志里明文显示。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirming(null)}>
							保持敏感
						</Button>
						<Button
							variant="danger"
							onClick={() => {
								if (confirming !== null) update(confirming, { secret: false });
								setConfirming(null);
							}}
						>
							取消敏感标记
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function uniqueParamName(params: Param[]): string {
	const names = new Set(params.map((p) => p.name));
	for (let i = 1; ; i++) {
		if (!names.has(`param_${i}`)) return `param_${i}`;
	}
}

const formatDefault = (type: ParamType) => (value: unknown) =>
	value === undefined ? "" : type === "string" ? String(value) : JSON.stringify(value);

const parseDefault =
	(type: ParamType) =>
	(raw: string): { value: unknown } | { error: string } => {
		if (raw === "") return { value: undefined };
		if (type === "string") return { value: raw };
		if (type === "number") {
			const n = Number(raw);
			return raw.trim() === "" || Number.isNaN(n) ? { error: "需要数字" } : { value: n };
		}
		try {
			return { value: JSON.parse(raw) };
		} catch {
			return { error: "不是合法的 JSON" };
		}
	};

/** 默认值：留空表示没有默认值；敏感参数默认隐藏，点眼睛图标临时显示 5 秒。 */
function DefaultValue({
	fieldKey,
	param,
	onChange,
}: {
	fieldKey: string;
	param: Param;
	onChange(value: unknown): void;
}) {
	const [revealed, setRevealed] = useState(false);
	useEffect(() => {
		if (!revealed) return;
		const timer = setTimeout(() => setRevealed(false), REVEAL_MS);
		return () => clearTimeout(timer);
	}, [revealed]);
	const field = useParsedField({
		key: fieldKey,
		value: param.default,
		format: formatDefault(param.type),
		parse: parseDefault(param.type),
		onChange,
	});

	if (param.type === "boolean") {
		return (
			<NativeSelect
				aria-label="默认值"
				value={param.default === undefined ? "" : String(param.default)}
				onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}
			>
				<NativeSelectOption value="">没有默认值</NativeSelectOption>
				<NativeSelectOption value="true">true</NativeSelectOption>
				<NativeSelectOption value="false">false</NativeSelectOption>
			</NativeSelect>
		);
	}
	const hidden = param.secret && !revealed;
	return (
		<div className="flex flex-col gap-1.25">
			<div className="flex gap-1.5">
				<Input
					aria-label="默认值"
					aria-invalid={field.error ? true : undefined}
					type={hidden ? "password" : "text"}
					autoComplete="off"
					className={param.type === "string" ? undefined : "font-mono text-xs"}
					placeholder={param.type === "json" ? "默认值（JSON，可选）" : "默认值（可选）"}
					value={field.text}
					spellCheck={false}
					onChange={(e) => field.change(e.target.value)}
				/>
				{param.secret && (
					<Button
						variant="ghost"
						size="icon"
						aria-label={revealed ? "隐藏默认值" : "临时显示默认值"}
						onClick={() => setRevealed((r) => !r)}
					>
						{revealed ? <EyeOffIcon /> : <EyeIcon />}
					</Button>
				)}
			</div>
			{field.error && <p className="m-0 text-xs text-danger-fg">{field.error}</p>}
		</div>
	);
}
