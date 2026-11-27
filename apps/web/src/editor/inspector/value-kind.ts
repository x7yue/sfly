import { isAgentInput, isFeishuBotInput, isRunStateInput } from "@sfly/orchestration";
import { type ReferenceChoice, wholeReference } from "./reference-completion";

/**
 * 包节点的输入用哪种控件（value-fields.tsx 的 ValueField）：由输入 schema 决定的种类，
 * 以及扩展类型（Agent、飞书机器人、运行状态）各自的规则。纯逻辑，单测覆盖。
 */
type JsonSchema = Record<string, unknown>;

export type ValueKind =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "enum"
	| "agent"
	| "feishu_bot"
	| "run_state"
	| "json";

/** 扩展输入类型（`sfly build` 在输入 schema 里标记 `x-sfly-type`）：字段上显示的类型名。 */
export const TYPE_NAMES: Partial<Record<ValueKind, string>> = {
	agent: "Agent",
	feishu_bot: "飞书机器人",
	run_state: "运行状态",
};

/**
 * 「字符串或 null」（`str | None`，`sfly build` 写成 `anyOf: [{type: string}, {type: null}]`）：按文本输入，
 * 不用写成带引号的 JSON（#404 第 6 条）。成员是别的类型、带枚举或扩展类型的不算。
 */
export function isNullableString(schema: JsonSchema): boolean {
	const members = schema.anyOf;
	if (!Array.isArray(members) || members.length !== 2) return false;
	const plain = (m: unknown, type: string) =>
		typeof m === "object" &&
		m !== null &&
		Object.keys(m).length === 1 &&
		(m as JsonSchema).type === type;
	return members.some((m) => plain(m, "string")) && members.some((m) => plain(m, "null"));
}

/** 由输入 schema 决定的控件种类。 */
export function valueKind(schema: JsonSchema): ValueKind {
	if (isAgentInput(schema)) return "agent";
	if (isFeishuBotInput(schema)) return "feishu_bot";
	if (isRunStateInput(schema)) return "run_state";
	if (Array.isArray(schema.enum)) return "enum";
	if (isNullableString(schema)) return "string";
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
 * 字段的「插入引用」和补全里列出的引用：
 * - Agent、飞书机器人（值是名称）只列入口参数（#197、#233「也可以改为引用入口参数」）：这样的值在触发前就能检查是已注册的
 *   Agent、已登记的机器人。手写的上游输出引用也允许，到派发时才检查（sdk-reference）。
 * - 运行状态只列 `${{ run.state }}`：这种输入只接它（ADR 0031），写别的值是警告。
 * - 其他类型都可以。
 */
export function choicesFor(kind: ValueKind, choices: ReferenceChoice[]): ReferenceChoice[] {
	switch (kind) {
		case "agent":
		case "feishu_bot":
			return choices.filter((c) => c.kind === "param");
		case "run_state":
			return choices.filter((c) => c.kind === "run_state");
		default:
			return choices;
	}
}

/**
 * 「运行状态」类型的输入显示成什么，完全由值决定：
 * - `reference`：整值引用（正常是 `${{ run.state }}`），显示引用标签，点 × 清掉；
 * - `empty`：没填（可选输入写的 null 也算），显示「接入运行状态」按钮；
 * - `other`：别的值（别处写进文档的常量、夹在文字里的引用），照实显示、让人看见并改掉，静态检查会警告。
 */
export function runStateShown(value: unknown): "reference" | "empty" | "other" {
	if (wholeReference(value) !== undefined) return "reference";
	return value === undefined || value === null ? "empty" : "other";
}
