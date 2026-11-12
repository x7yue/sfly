// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_OUTPUTS,
	canBeAlways,
	documentWarnings,
	feishuBotNotRegistered,
	feishuBotWarnings,
	type PackageCatalog,
	referenceOptions,
	resolveInputs,
} from "../src/index.js";

const catalog: PackageCatalog = new Map();

/** 入口（参数 env）→ 飞书通知节点 notify；node 里的字段覆盖默认值。 */
const doc = (notify: Record<string, unknown>) =>
	OrchestrationDocument.parse({
		nodes: [
			{ id: "entry", kind: "entry", params: [{ name: "env", type: "string" }] },
			{ id: "notify", kind: "feishu_notify", ...notify },
		],
		edges: [{ from: "entry", to: "notify", kind: "chain" }],
	});

describe("飞书通知节点的文档形态", () => {
	it("只写机器人和文本即可：不是 always，不@所有人，没有输出", () => {
		const parsed = doc({ bot: "ops", text: "压测开始" });
		expect(parsed.nodes[1]).toMatchObject({
			kind: "feishu_notify",
			bot: "ops",
			text: "压测开始",
			always: false,
			at_all: false,
		});
		expect(BUILTIN_OUTPUTS.feishu_notify).toEqual([]);
	});

	it("机器人和文本都可以暂时不填（画布上刚添加的节点）", () => {
		expect(() => doc({})).not.toThrow();
	});

	it("拒绝未知字段", () => {
		expect(
			OrchestrationDocument.safeParse({
				nodes: [{ id: "n", kind: "feishu_notify", bot: "ops", webhook: "http://x" }],
			}).success,
		).toBe(false);
	});

	it("可以设为 always", () => {
		expect(canBeAlways("feishu_notify")).toBe(true);
		expect(doc({ always: true }).nodes[1]).toMatchObject({ always: true });
	});
});

describe("机器人必须已登记的静态检查", () => {
	const registered = new Set(["ops", "dev"]);
	/** bots 为 null：还不知道已登记的机器人。 */
	const warnings = (
		notify: Record<string, unknown>,
		bots: ReadonlySet<string> | null = registered,
	) =>
		documentWarnings(doc(notify), catalog, bots ? { feishuBots: bots } : {}).filter((w) =>
			w.code.startsWith("feishu_"),
		);

	it("常量不是已登记的机器人：警告，指出节点和字段", () => {
		expect(warnings({ bot: "ghost", text: "x" })).toEqual([
			{
				code: "feishu_bot_not_registered",
				message: "节点 notify 选择的飞书机器人「ghost」还没有登记",
				node_id: "notify",
				input: "bot",
			},
		]);
		expect(feishuBotNotRegistered("notify", "ghost")).toBe(
			"节点 notify 选择的飞书机器人「ghost」还没有登记",
		);
		expect(feishuBotNotRegistered("n", "ghost", "channel")).toBe(
			"节点 n 的输入 channel 选择的飞书机器人「ghost」还没有登记",
		);
	});

	it("已登记的机器人不警告", () => {
		expect(warnings({ bot: "ops", text: "x" })).toEqual([]);
	});

	it("引用入口参数时保存不检查（触发时按实际值检查）", () => {
		expect(warnings({ bot: "${{ params.env }}", text: "x" })).toEqual([]);
	});

	it("还不知道已登记的机器人时（画布还在加载）不检查登记情况", () => {
		expect(warnings({ bot: "ghost" }, null)).toEqual([]);
	});

	it("没有选择机器人：警告", () => {
		expect(warnings({ text: "x" }, null)).toEqual([
			{
				code: "feishu_bot_unset",
				message: "节点 notify 没有选择飞书机器人",
				node_id: "notify",
				input: "bot",
			},
		]);
	});

	it("feishuBotWarnings 只看飞书通知节点", () => {
		const plain = OrchestrationDocument.parse({
			nodes: [{ id: "entry", kind: "entry", params: [] }],
		});
		expect(feishuBotWarnings(plain, registered)).toEqual([]);
	});
});

describe("飞书通知节点里的引用", () => {
	it("按引用规则检查：文本里引用不存在的参数、没有声明的输出都警告", () => {
		const found = documentWarnings(
			doc({
				bot: "ops",
				text: "${{ params.nope }} ${{ nodes.entry.outputs.x }}",
			}),
			catalog,
			{},
		);
		expect(found.map((w) => [w.code, "input" in w ? w.input : undefined])).toEqual([
			["reference_unknown_param", "text"],
			["reference_unknown_output", "text"],
		]);
	});

	it("机器人可以引用入口参数，引用补全里能选到它", () => {
		const found = documentWarnings(doc({ bot: "${{ params.nope }}" }), catalog, {});
		expect(found.map((w) => w.code)).toEqual(["reference_unknown_param"]);
		const options = referenceOptions(doc({ bot: "ops" }), "notify", catalog);
		expect(options.map((o) => o.expression)).toEqual(["params.env"]);
	});

	it("引用一律按 always 节点的规则解析：缺失的输出取 null，内嵌在文字里显示为 null", () => {
		const resolved = resolveInputs(
			{ text: "耗时 ${{ nodes.load.outputs.ms }}" },
			{
				params: {},
				earlierOutputs: new Map([["load", {}]]),
				missingAsNull: true,
			},
		);
		expect(resolved).toEqual({ text: "耗时 null" });
	});
});
