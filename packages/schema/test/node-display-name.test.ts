import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX, OrchestrationDocument, toJsonSchema } from "../src/index.js";

// 节点的显示名称 display_name（#307）：除子流程入口外所有节点种类都有的可选一行文字，最长 40 个字符。

const EMOJI = "😀";

/** 每个能写 display_name 的节点种类的最小写法。 */
const nodes = {
	entry: { id: "n", kind: "entry" },
	async: { id: "n", kind: "async" },
	timer: { id: "n", kind: "timer", at: "09:30:00" },
	sleep: { id: "n", kind: "sleep", duration: "30s" },
	stop_subflow: { id: "n", kind: "stop_subflow" },
	feishu_notify: { id: "n", kind: "feishu_notify" },
	package: { id: "n", kind: "package", package: "std", node: "shell" },
} as const;

const documentOf = (node: Record<string, unknown>) => ({ nodes: [node] });
const withName = (kind: keyof typeof nodes, display_name: string) =>
	documentOf({ ...nodes[kind], display_name });

describe("节点的显示名称 display_name", () => {
	it("上限是 40 个字符", () => {
		expect(DISPLAY_NAME_MAX).toBe(40);
	});

	it.each(
		Object.keys(nodes) as (keyof typeof nodes)[],
	)("%s 节点：可以不写；写了去掉首尾空白后保存", (kind) => {
		expect(OrchestrationDocument.parse(documentOf(nodes[kind])).nodes[0]).not.toHaveProperty(
			"display_name",
		);
		const parsed = OrchestrationDocument.parse(withName(kind, "  创建测试用户 "));
		expect(parsed.nodes[0]).toMatchObject({ display_name: "创建测试用户" });
	});

	it("子流程入口节点没有这个字段：它的名称就是子流程名称（name）", () => {
		const result = OrchestrationDocument.safeParse(
			documentOf({ id: "s", kind: "subflow_entry", name: "监控", display_name: "x" }),
		);
		expect(result.success).toBe(false);
	});

	it("空白的显示名称不保存", () => {
		const document = OrchestrationDocument.parse(withName("package", "   "));
		expect(JSON.stringify(document)).not.toContain("display_name");
	});

	it("最长 40 个字符：40 个中文、40 个 emoji 放得下，41 个放不下；错误指向这个字段", () => {
		for (const text of ["创".repeat(40), EMOJI.repeat(40)]) {
			expect(OrchestrationDocument.safeParse(withName("package", text)).success).toBe(true);
		}
		for (const text of ["创".repeat(41), EMOJI.repeat(41)]) {
			const result = OrchestrationDocument.safeParse(withName("package", text));
			expect(result.success).toBe(false);
			expect(result.error?.issues.map((i) => [i.path, i.message])).toEqual([
				[["nodes", 0, "display_name"], "最多 40 个字符"],
			]);
		}
	});

	it("只能写一行", () => {
		const result = OrchestrationDocument.safeParse(withName("sleep", "第一行\n第二行"));
		expect(result.success).toBe(false);
		expect(result.error?.issues.map((i) => i.message)).toEqual(["只能写一行"]);
	});

	it("名称可以重复", () => {
		const document = {
			nodes: [
				{ ...nodes.package, id: "a", display_name: "创建测试用户" },
				{ ...nodes.package, id: "b", display_name: "创建测试用户" },
			],
		};
		expect(OrchestrationDocument.safeParse(document).success).toBe(true);
	});
});

describe("显示名称：导出的文档 JSON Schema 与 zod 判断一致", () => {
	const validate = new Ajv2020({ strict: false }).compile(toJsonSchema(OrchestrationDocument));

	it.each([
		["package", "创建测试用户", true],
		["sleep", EMOJI.repeat(40), true],
		["sleep", EMOJI.repeat(41), false],
		["timer", "创".repeat(41), false],
		["async", "第一行\n第二行", false],
		["feishu_notify", "  ", true],
	] as const)("%s 节点写 %j：%s", (kind, text, ok) => {
		const document = withName(kind, text);
		expect(validate(document)).toBe(ok);
		expect(OrchestrationDocument.safeParse(document).success).toBe(ok);
	});

	it("子流程入口节点写 display_name：两边都拒绝", () => {
		const document = documentOf({
			id: "s",
			kind: "subflow_entry",
			name: "监控",
			display_name: "x",
		});
		expect(validate(document)).toBe(false);
		expect(OrchestrationDocument.safeParse(document).success).toBe(false);
	});
});
