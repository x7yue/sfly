// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import {
	type NodeTypeIo,
	type OrchestrationWarning,
	orderedInputs,
	type ReferenceOption,
} from "@sfly/orchestration";
import { useState } from "react";
import { ReferenceInput } from "./ReferenceInput";

type JsonSchema = Record<string, unknown>;
type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

/** 由输入 schema 决定的控件种类。 */
function fieldKind(schema: JsonSchema): FieldKind {
	if (Array.isArray(schema.enum)) return "enum";
	switch (schema.type) {
		case "string":
			return "string";
		case "integer":
			return "integer";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		default:
			return "json";
	}
}

const typeLabel = (schema: JsonSchema): string => {
	if (Array.isArray(schema.enum)) return "enum";
	if (typeof schema.type === "string") return schema.type;
	if (Array.isArray(schema.anyOf)) return "any of";
	return "any";
};

const isReference = (v: unknown) => typeof v === "string" && v.includes("${{");

/**
 * 包节点的参数表单：由节点类型的输入 schema 生成。每个输入可以填常量，也可以填引用；
 * 字符串输入里可以内嵌引用。不填时使用节点类型的默认值。
 */
export function InputsForm({
	type,
	inputs,
	options,
	warnings,
	onChange,
}: {
	/** null：找不到节点类型；undefined：还在加载。 */
	type: NodeTypeIo | null | undefined;
	inputs: Record<string, unknown>;
	options: ReferenceOption[];
	warnings: OrchestrationWarning[];
	onChange(inputs: Record<string, unknown>): void;
}) {
	if (type === undefined) return <p className="sf-hint">加载节点类型…</p>;
	const set = (name: string, value: unknown) => {
		const { [name]: _old, ...rest } = inputs;
		onChange(value === undefined ? rest : { ...rest, [name]: value });
	};
	// 按函数参数顺序（元信息的 order），JSONB 存储后对象键顺序不可靠。
	const properties = type ? orderedInputs(type.inputs) : [];
	const required = new Set(type?.inputs.required ?? []);
	const undeclared = Object.keys(inputs).filter((k) => !type?.inputs.properties[k]);

	return (
		<div className="space-y-3">
			{type === null && (
				<p className="sf-warn-item">找不到这个节点类型的元信息，不能生成参数表单。</p>
			)}
			{type && properties.length === 0 && <p className="sf-hint">这个节点类型没有输入。</p>}
			{properties.map(([name, schema]) => (
				<InputField
					key={name}
					name={name}
					schema={schema}
					required={required.has(name)}
					value={inputs[name]}
					options={options}
					warnings={warnings.filter((w) => "input" in w && w.input === name)}
					onChange={(v) => set(name, v)}
				/>
			))}
			{undeclared.map((name) => (
				<div key={name} className="sf-warn-item flex items-center gap-2">
					<span className="min-w-0 flex-1">
						输入 <code>{name}</code> 没有在节点类型中声明
					</span>
					<button type="button" className="sf-link" onClick={() => set(name, undefined)}>
						移除
					</button>
				</div>
			))}
		</div>
	);
}

function InputField({
	name,
	schema,
	required,
	value,
	options,
	warnings,
	onChange,
}: {
	name: string;
	schema: JsonSchema;
	required: boolean;
	value: unknown;
	options: ReferenceOption[];
	warnings: OrchestrationWarning[];
	onChange(value: unknown): void;
}) {
	const kind = fieldKind(schema);
	const [mode, setMode] = useState<"constant" | "reference">(
		kind !== "string" && isReference(value) ? "reference" : "constant",
	);
	const placeholder =
		schema.default !== undefined
			? `默认 ${JSON.stringify(schema.default)}`
			: required
				? "必填"
				: "可选";
	const label = `输入 ${name}`;

	return (
		<div>
			<div className="mb-1 flex items-center gap-2">
				<code className="text-[12.5px] text-[var(--sf-text)]">{name}</code>
				{required && <span className="text-[var(--sf-warn)]">*</span>}
				<span className="text-[11.5px] text-[var(--sf-text-3)]">{typeLabel(schema)}</span>
				{kind !== "string" && (
					<fieldset className="sf-seg ml-auto" aria-label={`${name} 的取值方式`}>
						{(["constant", "reference"] as const).map((m) => (
							<button
								key={m}
								type="button"
								aria-pressed={mode === m}
								onClick={() => {
									if (m === mode) return;
									setMode(m);
									onChange(undefined);
								}}
							>
								{m === "constant" ? "常量" : "引用"}
							</button>
						))}
					</fieldset>
				)}
			</div>
			{kind === "string" || mode === "reference" ? (
				<ReferenceInput
					label={label}
					value={typeof value === "string" ? value : ""}
					options={options}
					placeholder={kind === "string" ? placeholder : "${{ params.<名称> }}"}
					invalid={warnings.length > 0}
					onChange={(v) => onChange(v === "" ? undefined : v)}
				/>
			) : (
				<ConstantInput
					kind={kind}
					schema={schema}
					value={value}
					label={label}
					placeholder={placeholder}
					onChange={onChange}
				/>
			)}
			{warnings.map((w) => (
				<p key={w.message} className="sf-err">
					{w.message}
				</p>
			))}
		</div>
	);
}

function ConstantInput({
	kind,
	schema,
	value,
	label,
	placeholder,
	onChange,
}: {
	kind: Exclude<FieldKind, "string">;
	schema: JsonSchema;
	value: unknown;
	label: string;
	placeholder: string;
	onChange(value: unknown): void;
}) {
	const [text, setText] = useState(() =>
		value === undefined ? "" : kind === "json" ? JSON.stringify(value, null, 2) : String(value),
	);
	const [error, setError] = useState<string | null>(null);

	if (kind === "boolean" || kind === "enum") {
		const choices = kind === "boolean" ? [true, false] : (schema.enum as unknown[]);
		const current = value === undefined ? "" : JSON.stringify(value);
		return (
			<select
				aria-label={label}
				className="sf-inp sf-inp--mono"
				value={current}
				onChange={(e) => onChange(e.target.value === "" ? undefined : JSON.parse(e.target.value))}
			>
				<option value="">（{placeholder}）</option>
				{choices.map((c) => (
					<option key={JSON.stringify(c)} value={JSON.stringify(c)}>
						{JSON.stringify(c)}
					</option>
				))}
			</select>
		);
	}

	const parse = (raw: string) => {
		setText(raw);
		if (raw.trim() === "") {
			setError(null);
			onChange(undefined);
			return;
		}
		if (kind === "json") {
			try {
				onChange(JSON.parse(raw));
				setError(null);
			} catch {
				setError("不是合法的 JSON");
			}
			return;
		}
		const n = Number(raw);
		if (Number.isNaN(n) || (kind === "integer" && !Number.isInteger(n))) {
			setError(kind === "integer" ? "需要整数" : "需要数字");
			return;
		}
		setError(null);
		onChange(n);
	};

	return (
		<div>
			{kind === "json" ? (
				<textarea
					aria-label={label}
					className={`sf-inp sf-inp--mono ${error ? "sf-inp--bad" : ""}`}
					placeholder={`${placeholder}（JSON）`}
					value={text}
					spellCheck={false}
					onChange={(e) => parse(e.target.value)}
				/>
			) : (
				<input
					aria-label={label}
					inputMode="decimal"
					className={`sf-inp sf-inp--mono ${error ? "sf-inp--bad" : ""}`}
					placeholder={placeholder}
					value={text}
					onChange={(e) => parse(e.target.value)}
				/>
			)}
			{error && <p className="sf-err">{error}</p>}
		</div>
	);
}
