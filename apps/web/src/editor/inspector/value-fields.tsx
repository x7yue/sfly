// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { describeSchema, isAgentInput } from "@sfly/orchestration";
import type { AgentView } from "@sfly/schema";
import { useEffect, useId, useRef } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { draftKey, useDropFieldDraft, useFieldDraftError, useParsedField } from "../field-drafts";
import { AgentSelect } from "./AgentSelect";
import { Field } from "./fields";
import { ReferenceEditor, type ReferenceEditorHandle } from "./ReferenceEditor";
import { ReferenceChip, ReferencePicker } from "./ReferencePicker";
import { type ReferenceChoice, wholeReference } from "./reference-completion";
import { formatJson, parseJson, parseNumber } from "./value-text";
import { ReferenceActions } from "./ZoomEditor";

type JsonSchema = Record<string, unknown>;
type ValueKind = "string" | "number" | "integer" | "boolean" | "enum" | "agent" | "json";

/** 由输入 schema 决定的控件种类。 */
export function valueKind(schema: JsonSchema): ValueKind {
	if (isAgentInput(schema)) return "agent";
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

/**
 * 一个可以写常量或引用的值（包节点的输入）。没有「模式」：显示什么完全由值决定。
 * - 字符串：一个输入框（ReferenceEditor），文字和引用混写；整个值恰好是一个引用就是整值引用。
 * - 数字、布尔、枚举、Agent、JSON：值是整值引用时显示引用标签（点 × 回到类型控件），否则显示类型控件；
 *   旁边的「插入引用」选一个引用作为整个值。JSON 用同一个编辑器内核（多行、等宽），字符串值里可以内嵌引用。
 * - Agent（`sfly.AgentName`）：已注册的 Agent 下拉框（带在线状态），引用只能选入口参数。
 * - 字符串和 JSON 字段有「放大编辑」。
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
	agents = [],
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
	/** 已注册的 Agent（「Agent」类型的输入的下拉框）。 */
	agents?: AgentView[];
	/** 静态检查对这个字段的警告（不阻止保存）。 */
	problems: string[];
	help?: string;
	onChange(value: unknown): void;
}) {
	const id = useId();
	const kind = valueKind(schema);
	const placeholder =
		schema.default !== undefined
			? `默认 ${JSON.stringify(schema.default)}`
			: required
				? "必填"
				: "可选";
	const fieldLabel = label ?? `输入 ${name}`;
	const key = draftKey(nodeId, `value.${name}`);
	const common = {
		id,
		name,
		label: fieldLabel,
		placeholder,
		problems,
		// Agent 只能是常量或入口参数（ADR 0019）：触发前才能检查它是已注册的 Agent。
		choices: kind === "agent" ? choices.filter((c) => c.kind === "param") : choices,
		onChange,
	};
	const field = (control: React.ReactNode, aside?: React.ReactNode) => (
		<Field
			label={<span className="font-mono">{name}</span>}
			htmlFor={id}
			required={required}
			type={kind === "agent" ? "Agent" : describeSchema(schema)}
			error={<ParsedError fieldKey={key} problems={problems} />}
			help={help}
			aside={aside}
		>
			{control}
		</Field>
	);
	if (kind === "string") return <StringValue {...common} value={value} render={field} />;
	return (
		<TypedValue
			{...common}
			fieldKey={key}
			kind={kind}
			schema={schema}
			agents={agents}
			value={value}
			render={field}
		/>
	);
}

interface ValueProps {
	id: string;
	name: string;
	label: string;
	placeholder: string;
	problems: string[];
	choices: ReferenceChoice[];
	value: unknown;
	onChange(value: unknown): void;
	/** 把控件和右侧的按钮放进字段的版式里。 */
	render(control: React.ReactNode, aside?: React.ReactNode): React.ReactNode;
}

function StringValue({
	id,
	name,
	label,
	placeholder,
	problems,
	choices,
	value,
	onChange,
	render,
}: ValueProps) {
	const editor = useRef<ReferenceEditorHandle>(null);
	const text = typeof value === "string" ? value : "";
	const invalid = problems.length > 0;
	const change = (v: string) => onChange(v === "" ? undefined : v);
	return render(
		<ReferenceEditor
			ref={editor}
			id={id}
			label={label}
			value={text}
			choices={choices}
			placeholder={placeholder}
			invalid={invalid}
			onChange={change}
		/>,
		<ReferenceActions
			editor={editor}
			name={name}
			label={label}
			value={text}
			choices={choices}
			placeholder={placeholder}
			invalid={invalid}
			error={<Problems problems={problems} />}
			onChange={change}
		/>,
	);
}

/** 数字、布尔、枚举、Agent、JSON：整值引用显示为引用标签，否则是类型控件。 */
function TypedValue({
	id,
	fieldKey,
	kind,
	schema,
	agents,
	name,
	label,
	placeholder,
	problems,
	choices,
	value,
	onChange,
	render,
}: ValueProps & {
	fieldKey: string;
	kind: Exclude<ValueKind, "string">;
	schema: JsonSchema;
	agents: AgentView[];
}) {
	const dropDraft = useDropFieldDraft();
	const chip = useRef<HTMLButtonElement>(null);
	const referenced = wholeReference(value) !== undefined;
	// 值在引用和常量之间变了（选了引用、点了 ×）：控件换了一个，把焦点带过去，键盘操作不断。
	const previous = useRef(referenced);
	useEffect(() => {
		if (previous.current === referenced) return;
		previous.current = referenced;
		if (referenced) chip.current?.focus();
		else document.getElementById(id)?.focus();
	}, [referenced, id]);
	const invalid = problems.length > 0;
	const picker = (
		<ReferencePicker
			name={name}
			choices={choices}
			onPick={(choice) => {
				// 没生效的输入（如整数框里的 abc）被引用整个换掉。
				dropDraft(fieldKey);
				onChange(choice.text);
			}}
		/>
	);
	if (referenced) {
		return render(
			<ReferenceChip
				ref={chip}
				label={label}
				name={name}
				value={value as string}
				invalid={invalid}
				onRemove={() => onChange(undefined)}
			/>,
			picker,
		);
	}
	if (kind === "json") {
		return (
			<JsonValue
				id={id}
				fieldKey={fieldKey}
				name={name}
				label={label}
				placeholder={placeholder}
				problems={problems}
				choices={choices}
				value={value}
				onChange={onChange}
				render={render}
			/>
		);
	}
	if (kind === "agent") {
		return render(
			<AgentSelect
				id={id}
				label={label}
				value={typeof value === "string" ? value : undefined}
				agents={agents}
				emptyLabel={`（${placeholder}）`}
				slots={false}
				invalid={invalid}
				onChange={onChange}
			/>,
			picker,
		);
	}
	if (kind === "boolean" || kind === "enum") {
		return render(
			<NativeSelect
				id={id}
				aria-label={label}
				value={value === undefined ? "" : JSON.stringify(value)}
				onChange={(e) => onChange(e.target.value === "" ? undefined : JSON.parse(e.target.value))}
			>
				<NativeSelectOption value="">（{placeholder}）</NativeSelectOption>
				{(kind === "boolean" ? [true, false] : (schema.enum as unknown[])).map((c) => (
					<NativeSelectOption key={JSON.stringify(c)} value={JSON.stringify(c)}>
						{JSON.stringify(c)}
					</NativeSelectOption>
				))}
			</NativeSelect>,
			picker,
		);
	}
	return render(
		<NumberValue
			id={id}
			fieldKey={fieldKey}
			integer={kind === "integer"}
			label={label}
			placeholder={placeholder}
			value={value}
			invalid={invalid}
			onChange={onChange}
		/>,
		picker,
	);
}

/** 字段下方的错误：先是不合法的输入（阻止保存），再是静态检查的警告。 */
export function ParsedError({ fieldKey, problems }: { fieldKey: string; problems: string[] }) {
	const error = useFieldDraftError(fieldKey);
	return <Problems problems={[...(error ? [error] : []), ...problems]} />;
}

function Problems({ problems }: { problems: string[] }) {
	if (problems.length === 0) return null;
	return (
		<>
			{problems.map((m) => (
				<span key={m} className="block">
					{m}
				</span>
			))}
		</>
	);
}

/**
 * JSON 常量：与字符串字段同一个编辑器（多行、等宽、补全与引用高亮），文本解析成功才写进文档。
 * 「插入引用」把引用插在光标处（JSON 的字符串值里可以内嵌引用）；整个文本恰好是一个引用时就是整值引用，显示为引用标签。
 */
function JsonValue({
	id,
	fieldKey,
	name,
	label,
	placeholder,
	problems,
	choices,
	value,
	onChange,
	render,
}: ValueProps & { fieldKey: string }) {
	const editor = useRef<ReferenceEditorHandle>(null);
	const field = useParsedField<unknown>({
		key: fieldKey,
		value,
		format: formatJson,
		parse: parseJson,
		onChange,
	});
	const invalid = problems.length > 0 || field.error !== undefined;
	const hint = `${placeholder}（JSON）`;
	return render(
		<ReferenceEditor
			ref={editor}
			id={id}
			label={label}
			value={field.text}
			choices={choices}
			placeholder={hint}
			invalid={invalid}
			minLines={3}
			onChange={field.change}
		/>,
		<ReferenceActions
			editor={editor}
			name={name}
			label={label}
			value={field.text}
			choices={choices}
			placeholder={hint}
			invalid={invalid}
			error={<ParsedError fieldKey={fieldKey} problems={problems} />}
			onChange={field.change}
		/>,
	);
}

/** 数字、整数常量：文本解析成功才写进文档。 */
function NumberValue({
	id,
	fieldKey,
	integer,
	label,
	placeholder,
	value,
	invalid,
	onChange,
}: {
	id: string;
	fieldKey: string;
	integer: boolean;
	label: string;
	placeholder: string;
	value: unknown;
	invalid: boolean;
	onChange(value: unknown): void;
}) {
	const field = useParsedField<unknown>({
		key: fieldKey,
		value,
		format: (v) => (v === undefined ? "" : String(v)),
		parse: parseNumber(integer),
		onChange,
	});
	return (
		<Input
			id={id}
			aria-label={label}
			aria-invalid={invalid || field.error !== undefined || undefined}
			inputMode="decimal"
			className="font-mono text-xs"
			placeholder={placeholder}
			value={field.text}
			onChange={(e) => field.change(e.target.value)}
		/>
	);
}
