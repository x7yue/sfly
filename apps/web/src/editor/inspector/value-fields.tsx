// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { describeSchema } from "@sfly/orchestration";
import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { draftKey, useFieldDraftError, useParsedField } from "../field-drafts";
import {
	Field,
	type ReferenceChoice,
	ReferenceTextInput,
	Segmented,
	wholeReference,
} from "./fields";

type JsonSchema = Record<string, unknown>;
type ValueKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

/** 由输入 schema 决定的控件种类。 */
export function valueKind(schema: JsonSchema): ValueKind {
	if (Array.isArray(schema.enum)) return "enum";
	switch (schema.type) {
		case "string":
		case "number":
		case "integer":
		case "boolean":
			return schema.type;
		default:
			return "json";
	}
}

const MODES = [
	["constant", "常量"],
	["reference", "引用"],
] as const;

/**
 * 一个可以写常量或引用的值（包节点的输入、异步任务节点的子流程参数映射）：右侧切换常量 / 引用。
 * 常量按类型给出控件（字符串里也可以内嵌 `${{ … }}`）；引用模式的补全按入口参数 / 前序节点分组。
 * 不合法的常量（abc 填进整数）只记为字段草稿，不写进文档，并阻止保存（field-drafts.tsx）。
 */
export function ValueField({
	nodeId,
	name,
	label,
	schema,
	required,
	value,
	choices,
	problems,
	help,
	onChange,
}: {
	nodeId: string;
	name: string;
	label?: string;
	schema: JsonSchema;
	required: boolean;
	value: unknown;
	choices: ReferenceChoice[];
	/** 静态检查对这个字段的警告（不阻止保存）。 */
	problems: string[];
	help?: string;
	onChange(value: unknown): void;
}) {
	const id = useId();
	const kind = valueKind(schema);
	const [mode, setMode] = useState<"constant" | "reference">(
		wholeReference(value) !== undefined ? "reference" : "constant",
	);
	const placeholder =
		schema.default !== undefined
			? `默认 ${JSON.stringify(schema.default)}`
			: required
				? "必填"
				: "可选";
	const fieldLabel = label ?? `输入 ${name}`;
	const key = draftKey(nodeId, `value.${name}`);
	return (
		<Field
			label={<span className="font-mono">{name}</span>}
			htmlFor={id}
			required={required}
			type={describeSchema(schema)}
			error={<ParsedError fieldKey={key} problems={problems} />}
			help={help}
			aside={
				<Segmented
					label={`${name} 的取值方式`}
					value={mode}
					options={MODES}
					onChange={(m) => {
						if (m === mode) return;
						setMode(m);
						onChange(undefined);
					}}
				/>
			}
		>
			{mode === "reference" ? (
				<ReferenceTextInput
					id={id}
					whole
					label={fieldLabel}
					value={typeof value === "string" ? value : ""}
					choices={choices}
					placeholder="输入 params. 或 nodes. 搜索"
					invalid={problems.length > 0}
					onChange={(v) => onChange(v === "" ? undefined : v)}
				/>
			) : kind === "string" ? (
				<ReferenceTextInput
					id={id}
					label={fieldLabel}
					value={typeof value === "string" ? value : ""}
					choices={choices}
					placeholder={placeholder}
					invalid={problems.length > 0}
					onChange={(v) => onChange(v === "" ? undefined : v)}
				/>
			) : kind === "boolean" || kind === "enum" ? (
				<NativeSelect
					id={id}
					aria-label={fieldLabel}
					value={value === undefined ? "" : JSON.stringify(value)}
					onChange={(e) => onChange(e.target.value === "" ? undefined : JSON.parse(e.target.value))}
				>
					<NativeSelectOption value="">（{placeholder}）</NativeSelectOption>
					{(kind === "boolean" ? [true, false] : (schema.enum as unknown[])).map((c) => (
						<NativeSelectOption key={JSON.stringify(c)} value={JSON.stringify(c)}>
							{JSON.stringify(c)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			) : (
				<ParsedConstant
					id={id}
					fieldKey={key}
					kind={kind}
					label={fieldLabel}
					placeholder={placeholder}
					value={value}
					invalid={problems.length > 0}
					onChange={onChange}
				/>
			)}
		</Field>
	);
}

/** 字段下方的错误：先是不合法的输入（阻止保存），再是静态检查的警告。 */
export function ParsedError({ fieldKey, problems }: { fieldKey: string; problems: string[] }) {
	const error = useFieldDraftError(fieldKey);
	const messages = [...(error ? [error] : []), ...problems];
	if (messages.length === 0) return null;
	return (
		<>
			{messages.map((m) => (
				<span key={m} className="block">
					{m}
				</span>
			))}
		</>
	);
}

const parseNumber =
	(integer: boolean) =>
	(raw: string): { value: number | undefined } | { error: string } => {
		if (raw.trim() === "") return { value: undefined };
		const n = Number(raw);
		if (Number.isNaN(n) || (integer && !Number.isInteger(n))) {
			return { error: integer ? "需要整数" : "需要数字" };
		}
		return { value: n };
	};

const parseJson = (raw: string): { value: unknown } | { error: string } => {
	if (raw.trim() === "") return { value: undefined };
	try {
		return { value: JSON.parse(raw) };
	} catch {
		return { error: "不是合法的 JSON" };
	}
};

/** 需要解析的常量：数字、整数、JSON。 */
function ParsedConstant({
	id,
	fieldKey,
	kind,
	label,
	placeholder,
	value,
	invalid,
	onChange,
}: {
	id: string;
	fieldKey: string;
	kind: "number" | "integer" | "json";
	label: string;
	placeholder: string;
	value: unknown;
	invalid: boolean;
	onChange(value: unknown): void;
}) {
	const field = useParsedField<unknown>({
		key: fieldKey,
		value,
		format: (v) =>
			v === undefined ? "" : kind === "json" ? JSON.stringify(v, null, 2) : String(v),
		parse: kind === "json" ? parseJson : parseNumber(kind === "integer"),
		onChange,
	});
	const bad = invalid || field.error !== undefined;
	if (kind === "json") {
		return (
			<textarea
				id={id}
				aria-label={label}
				aria-invalid={bad || undefined}
				spellCheck={false}
				className="min-h-16 w-full rounded-md border border-border bg-sunk px-2.25 py-1.5 font-mono text-xs text-fg-1 outline-none placeholder:text-fg-3 focus:border-signal focus:shadow-[0_0_0_3px_var(--signal-soft)] aria-invalid:border-danger"
				placeholder={`${placeholder}（JSON）`}
				value={field.text}
				onChange={(e) => field.change(e.target.value)}
			/>
		);
	}
	return (
		<Input
			id={id}
			aria-label={label}
			aria-invalid={bad || undefined}
			inputMode="decimal"
			className="font-mono text-xs"
			placeholder={placeholder}
			value={field.text}
			onChange={(e) => field.change(e.target.value)}
		/>
	);
}
