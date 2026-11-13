// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { describeSchema, isAgentInput, isFeishuBotInput } from "@sfly/orchestration";
import type { AgentView, FeishuBotView } from "@sfly/schema";
import { useEffect, useId, useRef } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { draftKey, useDropFieldDraft, useFieldErrors, useParsedField } from "../field-drafts";
import { AgentSelect } from "./AgentSelect";
import { FeishuBotSelect } from "./FeishuBotSelect";
import { Field, type FieldControl } from "./fields";
import { ReferenceEditor, type ReferenceEditorHandle } from "./ReferenceEditor";
import { ReferenceChip, ReferencePicker } from "./ReferencePicker";
import { type ReferenceChoice, wholeReference } from "./reference-completion";
import { formatJson, parseJson, parseNumber } from "./value-text";
import { ReferenceActions } from "./ZoomEditor";

type JsonSchema = Record<string, unknown>;
type ValueKind =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "enum"
	| "agent"
	| "feishu_bot"
	| "json";

/** 扩展输入类型（值是名称）：字段上显示的类型名。 */
const NAME_TYPES: Partial<Record<ValueKind, string>> = { agent: "Agent", feishu_bot: "飞书机器人" };

/** 由输入 schema 决定的控件种类。 */
export function valueKind(schema: JsonSchema): ValueKind {
	if (isAgentInput(schema)) return "agent";
	if (isFeishuBotInput(schema)) return "feishu_bot";
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
 * - 数字、布尔、枚举、Agent、飞书机器人、JSON：值是整值引用时显示引用标签（点 × 回到类型控件），否则显示类型控件；
 *   旁边的「插入引用」选一个引用作为整个值。JSON 用同一个编辑器内核（多行、等宽），字符串值里可以内嵌引用。
 * - Agent（`sfly.AgentName`）：已注册的 Agent 下拉框（带在线状态），引用只能选入口参数。
 * - 飞书机器人（`sfly.FeishuBot`）：已登记的飞书机器人下拉框，引用只能选入口参数。
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
	bots = [],
	problems,
	help,
	heading,
	onChange,
}: {
	nodeId: string;
	name: string;
	/** 字段名称的显示：默认是等宽字体的 `name`（节点包的输入名）；内置节点的字段写成中文名称。 */
	heading?: string;
	label?: string;
	schema: JsonSchema;
	required: boolean;
	value: unknown;
	choices: ReferenceChoice[];
	/** 已注册的 Agent（「Agent」类型的输入的下拉框）。 */
	agents?: AgentView[];
	/** 已登记的飞书机器人（「飞书机器人」类型的输入的下拉框）。 */
	bots?: readonly FeishuBotView[];
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
	const errors = useFieldErrors(key, problems);
	const common = {
		id,
		name,
		label: fieldLabel,
		placeholder,
		errors,
		// 「Agent」「飞书机器人」类型的参数插入引用时只列入口参数（#197、#233「也可以改为引用入口参数」）：
		// 这样的值在触发前就能检查是已注册的 Agent、已登记的机器人。手写的上游输出引用也允许，到派发时才检查（sdk-reference）。
		choices: NAME_TYPES[kind] ? choices.filter((c) => c.kind === "param") : choices,
		onChange,
	};
	const field = (control: (c: FieldControl) => React.ReactNode, aside?: React.ReactNode) => (
		<Field
			id={id}
			fieldKey={key}
			label={heading ?? name}
			mono={heading === undefined}
			required={required}
			type={NAME_TYPES[kind] ?? describeSchema(schema)}
			error={errors.length > 0 ? <Problems problems={errors} /> : undefined}
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
			bots={bots}
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
	errors: string[];
	choices: ReferenceChoice[];
	value: unknown;
	onChange(value: unknown): void;
	/** 把控件和右侧的按钮放进字段的版式里。 */
	render(
		control: (control: FieldControl) => React.ReactNode,
		aside?: React.ReactNode,
	): React.ReactNode;
}

function StringValue({
	name,
	label,
	placeholder,
	errors,
	choices,
	value,
	onChange,
	render,
}: ValueProps) {
	const editor = useRef<ReferenceEditorHandle>(null);
	const text = typeof value === "string" ? value : "";
	const invalid = errors.length > 0;
	const change = (v: string) => onChange(v === "" ? undefined : v);
	return render(
		(control) => (
			<ReferenceEditor
				ref={editor}
				control={control}
				label={label}
				value={text}
				choices={choices}
				placeholder={placeholder}
				onChange={change}
			/>
		),
		<ReferenceActions
			editor={editor}
			name={name}
			label={label}
			value={text}
			choices={choices}
			placeholder={placeholder}
			invalid={invalid}
			error={<Problems problems={errors} />}
			onChange={change}
		/>,
	);
}

/** 数字、布尔、枚举、Agent、飞书机器人、JSON：整值引用显示为引用标签，否则是类型控件。 */
function TypedValue({
	id,
	fieldKey,
	kind,
	schema,
	agents,
	bots,
	name,
	label,
	placeholder,
	errors,
	choices,
	value,
	onChange,
	render,
}: ValueProps & {
	fieldKey: string;
	kind: Exclude<ValueKind, "string">;
	schema: JsonSchema;
	agents: AgentView[];
	bots: readonly FeishuBotView[];
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
			(control) => (
				<ReferenceChip
					ref={chip}
					control={control}
					label={label}
					name={name}
					value={value as string}
					onRemove={() => onChange(undefined)}
				/>
			),
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
				errors={errors}
				choices={choices}
				value={value}
				onChange={onChange}
				render={render}
			/>
		);
	}
	if (kind === "agent") {
		return render(
			(control) => (
				<AgentSelect
					control={control}
					label={label}
					value={typeof value === "string" ? value : undefined}
					agents={agents}
					emptyLabel={`（${placeholder}）`}
					slots={false}
					onChange={onChange}
				/>
			),
			picker,
		);
	}
	if (kind === "feishu_bot") {
		return render(
			(control) => (
				<FeishuBotSelect
					control={control}
					label={label}
					value={typeof value === "string" ? value : undefined}
					bots={bots}
					emptyLabel={`（${placeholder}）`}
					onChange={onChange}
				/>
			),
			picker,
		);
	}
	if (kind === "boolean" || kind === "enum") {
		return render(
			(control) => (
				<NativeSelect
					{...control}
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
				</NativeSelect>
			),
			picker,
		);
	}
	return render(
		(control) => (
			<NumberValue
				control={control}
				fieldKey={fieldKey}
				integer={kind === "integer"}
				label={label}
				placeholder={placeholder}
				value={value}
				onChange={onChange}
			/>
		),
		picker,
	);
}

export function Problems({ problems }: { problems: string[] }) {
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
	fieldKey,
	name,
	label,
	placeholder,
	errors,
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
	const hint = `${placeholder}（JSON）`;
	return render(
		(control) => (
			<ReferenceEditor
				ref={editor}
				control={control}
				label={label}
				value={field.text}
				choices={choices}
				placeholder={hint}
				minLines={3}
				onChange={field.change}
			/>
		),
		<ReferenceActions
			editor={editor}
			name={name}
			label={label}
			value={field.text}
			choices={choices}
			placeholder={hint}
			invalid={errors.length > 0}
			error={<Problems problems={errors} />}
			onChange={field.change}
			onTouch={field.blur}
		/>,
	);
}

/** 数字、整数常量：文本解析成功才写进文档。 */
function NumberValue({
	control,
	fieldKey,
	integer,
	label,
	placeholder,
	value,
	onChange,
}: {
	control: FieldControl;
	fieldKey: string;
	integer: boolean;
	label: string;
	placeholder: string;
	value: unknown;
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
			{...control}
			aria-label={label}
			inputMode="decimal"
			className="font-mono text-xs"
			placeholder={placeholder}
			value={field.text}
			onChange={(e) => field.change(e.target.value)}
		/>
	);
}
