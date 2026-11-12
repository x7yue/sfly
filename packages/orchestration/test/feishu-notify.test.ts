// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_OUTPUTS,
	canBeAlways,
	documentWarnings,
	feishuBotNotRegistered,
	feishuBotWarnings,
	notifyBotValue,
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

describe("飞书通知节点的三种格式的文档形态", () => {
	it("不写 format 就是文本；Markdown 卡片的字段有默认值：标题和正文为空，蓝色", () => {
		expect(doc({ bot: "ops" }).nodes[1]).toMatchObject({
			format: "text",
			title: "",
			color: "blue",
			markdown: "",
		});
		expect(doc({ bot: "ops" }).nodes[1]).not.toHaveProperty("message");
	});

	it("Markdown 卡片：标题、颜色（blue、green、orange、red、grey）和 Markdown 正文", () => {
		for (const color of ["blue", "green", "orange", "red", "grey"]) {
			expect(
				doc({ bot: "ops", format: "card", title: "完成", color, markdown: "**ok**" }).nodes[1],
			).toMatchObject({ format: "card", title: "完成", color, markdown: "**ok**" });
		}
	});

	it("原始消息：message 是任意 JSON 值，原样保存", () => {
		const message = { msg_type: "text", content: { text: "${{ params.env }}" } };
		expect(doc({ bot: "ops", format: "raw", message }).nodes[1]).toMatchObject({
			format: "raw",
			message,
		});
	});

	it("拒绝未知的格式和颜色", () => {
		expect(() => doc({ format: "post" })).toThrow();
		expect(() => doc({ format: "card", color: "purple" })).toThrow();
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

	describe("机器人只能是常量名称，或整值引用入口参数", () => {
		const unsupported = (bot: string) => [
			{
				code: "feishu_bot_reference_unsupported",
				message: `节点 notify 的飞书机器人只能是已登记的机器人名称，或整个引用入口参数（\${{ params.<参数名> }}），现在是「${bot}」`,
				node_id: "notify",
				input: "bot",
			},
		];

		it.each([
			["引用前面节点的输出", "${{ nodes.load.outputs.channel }}"],
			["引用夹在文字里", "ops-${{ params.env }}"],
			["引用后面还有文字", "${{ params.env }}-bot"],
			["两个引用连在一起", "${{ params.env }}${{ params.env }}"],
			["引用没有闭合", "${{ params.env"],
		])("%s：保存时警告，指出节点和字段", (_name, bot) => {
			expect(warnings({ bot, text: "x" })).toEqual(unsupported(bot));
		});

		it("不依赖已登记的机器人名单：画布还在加载时也警告，而且不再说「还没有登记」", () => {
			const bot = "${{ nodes.load.outputs.channel }}";
			expect(warnings({ bot }, null)).toEqual(unsupported(bot));
			expect(warnings({ bot }, new Set(["ops"]))).toEqual(unsupported(bot));
		});

		it("整值引用入口参数不警告：写不写空格都一样", () => {
			expect(warnings({ bot: "${{ params.env }}" })).toEqual([]);
			expect(warnings({ bot: "${{params.env}}" })).toEqual([]);
			expect(warnings({ bot: "${{ params.env }}" }, null)).toEqual([]);
		});

		it("notifyBotValue 把机器人字段分成常量、入口参数和不支持的写法", () => {
			expect(notifyBotValue("ops")).toEqual({ kind: "constant", name: "ops" });
			expect(notifyBotValue("${{ params.env }}")).toEqual({ kind: "param", param: "env" });
			expect(notifyBotValue("${{ nodes.a.outputs.b }}")).toEqual({ kind: "unsupported" });
			expect(notifyBotValue("a${{ params.env }}")).toEqual({ kind: "unsupported" });
		});
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

	/** 引用检查的结果：[警告码, 输入名]。 */
	const found = (notify: Record<string, unknown>) =>
		documentWarnings(doc({ bot: "ops", ...notify }), catalog, {}).map((w) => [
			w.code,
			"input" in w ? w.input : undefined,
		]);

	it("Markdown 卡片：标题和正文里的引用都检查，颜色不能写引用", () => {
		expect(
			found({
				format: "card",
				title: "${{ params.nope }}",
				markdown: "${{ nodes.entry.outputs.x }}",
			}),
		).toEqual([
			["reference_unknown_param", "title"],
			["reference_unknown_output", "markdown"],
		]);
	});

	it("原始消息：message 里每个字符串字段的引用都检查，整值引用也检查", () => {
		expect(
			found({
				format: "raw",
				message: {
					msg_type: "text",
					content: { text: "${{ params.nope }}" },
					extra: ["${{ params.alsoNope }}"],
				},
			}),
		).toEqual([
			["reference_unknown_param", "message"],
			["reference_unknown_param", "message"],
		]);
		expect(found({ format: "raw", message: "${{ params.nope }}" })).toEqual([
			["reference_unknown_param", "message"],
		]);
	});

	it("只检查当前格式的字段：切换格式后，其他格式里留着的内容不产生警告", () => {
		const stale = {
			text: "${{ params.nope }}",
			title: "${{ params.nope }}",
			markdown: "${{ params.nope }}",
			message: { a: "${{ params.nope }}" },
		};
		expect(found({ ...stale, format: "text" })).toEqual([["reference_unknown_param", "text"]]);
		expect(found({ ...stale, format: "card" })).toEqual([
			["reference_unknown_param", "title"],
			["reference_unknown_param", "markdown"],
		]);
		expect(found({ ...stale, format: "raw" })).toEqual([["reference_unknown_param", "message"]]);
	});
});
