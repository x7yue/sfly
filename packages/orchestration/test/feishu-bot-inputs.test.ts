// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	documentWarnings,
	feishuBotInputs,
	isFeishuBotInput,
	type NodeTypeIo,
	type PackageCatalog,
	packageKey,
	referencedFeishuBots,
} from "../src/index.js";

/** alert(bot: FeishuBot, backup: FeishuBot | None = None, text: str = "")，sfly build 生成的输入 schema。 */
const alertType: NodeTypeIo = {
	name: "alert",
	inputs: {
		type: "object",
		properties: {
			bot: { type: "string", "x-sfly-type": "feishu_bot" },
			backup: {
				anyOf: [{ type: "string", "x-sfly-type": "feishu_bot" }, { type: "null" }],
				default: null,
			},
			text: { type: "string", default: "" },
		},
		required: ["bot"],
		order: ["bot", "backup", "text"],
	},
	outputs: { type: "object", properties: {} },
};

describe("「飞书机器人」类型的输入", () => {
	it("按 sfly build 的标记识别，可选的也算；「Agent」类型不算", () => {
		expect(isFeishuBotInput({ type: "string", "x-sfly-type": "feishu_bot" })).toBe(true);
		expect(isFeishuBotInput({ type: "string", "x-sfly-type": "agent" })).toBe(false);
		expect(isFeishuBotInput({ type: "string" })).toBe(false);
		expect(feishuBotInputs(alertType.inputs)).toEqual(["bot", "backup"]);
	});

	it("引用的机器人是这些输入里不为空的字符串，其他输入不算", () => {
		expect(
			referencedFeishuBots(alertType.inputs, { bot: "ops", backup: null, text: "dev" }),
		).toEqual([{ input: "bot", bot: "ops" }]);
		expect(referencedFeishuBots(alertType.inputs, { bot: "ops", backup: "dev" })).toEqual([
			{ input: "bot", bot: "ops" },
			{ input: "backup", bot: "dev" },
		]);
		expect(referencedFeishuBots(alertType.inputs, { bot: "" })).toEqual([]);
	});
});

describe("「飞书机器人」类型的输入的静态检查", () => {
	const catalog: PackageCatalog = new Map([[packageKey("demo", "1.0.0"), [alertType]]]);
	const doc = (inputs: Record<string, unknown>) =>
		OrchestrationDocument.parse({
			default_agent: "a",
			packages: { demo: "1.0.0" },
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "channel", type: "string" }] },
				{ id: "c", kind: "package", package: "demo", node: "alert", inputs },
			],
			edges: [{ from: "entry", to: "c", kind: "chain" }],
		});
	const registered = new Set(["ops", "dev"]);
	/** bots 为 null：还不知道已登记的机器人。 */
	const warnings = (
		inputs: Record<string, unknown>,
		bots: ReadonlySet<string> | null = registered,
	) =>
		documentWarnings(doc(inputs), catalog, bots ? { feishuBots: bots } : {}).filter((w) =>
			w.code.startsWith("feishu_"),
		);

	it("常量不是已登记的机器人时警告，指出节点和参数", () => {
		expect(warnings({ bot: "ghost", backup: "dev" })).toEqual([
			{
				code: "feishu_bot_not_registered",
				message: "节点 c 的输入 bot 选择的飞书机器人「ghost」还没有登记",
				node_id: "c",
				input: "bot",
			},
		]);
		expect(warnings({ bot: "ops", backup: "ghost" })).toMatchObject([
			{ node_id: "c", input: "backup" },
		]);
	});

	it("已登记的机器人、引用入口参数、没有填写的可选参数都不警告", () => {
		expect(warnings({ bot: "ops" })).toEqual([]);
		expect(warnings({ bot: "${{ params.channel }}", backup: null })).toEqual([]);
	});

	it("不知道已登记的机器人时不检查", () => {
		expect(warnings({ bot: "ghost" }, null)).toEqual([]);
	});

	it("不是「飞书机器人」类型的输入不检查登记情况", () => {
		expect(warnings({ bot: "ops", text: "ghost" })).toEqual([]);
	});

	it("节点类型未知时跳过（包版本检查会指出）", () => {
		const unknown = OrchestrationDocument.parse({
			default_agent: "a",
			packages: { demo: "1.0.0" },
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "c", kind: "package", package: "demo", node: "alert", inputs: { bot: "ghost" } },
			],
			edges: [{ from: "entry", to: "c", kind: "chain" }],
		});
		expect(
			documentWarnings(unknown, new Map(), { feishuBots: registered }).filter((w) =>
				w.code.startsWith("feishu_"),
			),
		).toEqual([]);
	});
});
