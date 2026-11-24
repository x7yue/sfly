/**
 * 会出现在「经 …」、作者、命令行和日志里的名字（令牌的名称、用户的显示名、写操作的昵称、初始管理员的显示名）能有哪些字符。
 *
 * **目标只有一个：名字不能在控制台和终端里倒着显示、藏字、换行。** 「藏字」包括往 AI 助手的上下文里塞看不见的话：名字会经命令行
 * 的输出进到助手读到的内容里。不承诺「看起来一模一样的名字不能同时有效」：同一个字的预组合和分解写法、西里尔字母冒充拉丁字母这类
 * 看得见的字符，都不在这里拦（要拦得做规范化、唯一约束、处理已有的数据，不是这个检查的事）。
 *
 * **拒绝的是下面这张明确的表（写成码位范围，不依赖运行时的 Unicode 版本），不是某个 Unicode 类别**：
 * - C0 控制字符（U+0000–U+001F：NUL、制表、换行、回车、转义序列 ESC……）、DEL（U+007F）、C1 控制字符（U+0080–U+009F）：
 *   会把终端和日志弄乱；
 * - 行分隔符、段分隔符（U+2028、U+2029）：换行；
 * - **孤立的代理码元**（U+D800–U+DFFF，不成对的）：不是合法的文字，进了数据库和 JSON 之后各处的表现不一致；
 * - **盲文空白 U+2800**：看起来是空的，只由它组成的名字和空名字一样；
 * - **默认可忽略的码位**（Unicode 的 `Default_Ignorable_Code_Point`，含其中未分配的）：渲染时看不见，包括零宽空格（U+200B）、
 *   词连接符和不可见的运算符（U+2060–U+2064）、软连字符（U+00AD）、字节顺序标记（U+FEFF）、双向文字的控制字符（嵌入和覆盖
 *   U+202A–U+202E、隔离 U+2066–U+2069、方向标记 U+200E、U+200F、U+061C：让名字倒着显示）、各种填充符（U+115F、U+1160、
 *   U+3164、U+FFA0）、蒙古文的自由变体选择符（U+180B–U+180F）、**标签字符（U+E0000–U+E007F：能在名字后面拼出一整句看不见的
 *   英文）和补充的变体选择符（U+E0100–U+E01EF：能逐字节编码任意数据）**，等等。完整的范围见 {@link REJECTED_NAME_CHARACTER}；
 *
 * **三种例外**（也是默认可忽略的码位，但正常的文字和表情要用它们），**必须紧跟在一个看得见的字符后面**，这样名字不会因为它们
 * 变成一串看不见的东西：
 * - 零宽连接符（U+200D）、零宽不连字符（U+200C）：波斯文、僧伽罗文、印地文，带零宽连接符的组合表情（👩‍💻）。它前面紧挨着的
 *   必须是一个不在拒绝表里、也不是这三种例外的字符（不能在名字开头，不能连着出现）；表情里它前面可以是一个变体选择符
 *   （🏳️‍🌈、❤️‍🔥 是「字符 + 变体选择符 + 零宽连接符」），变体选择符本身要紧跟在字符后面；
 * - 变体选择符 U+FE00–U+FE0F（表情的呈现方式）：同样必须紧跟在一个这样的字符后面，一个字符后面最多一个。
 *
 * **名字去掉首尾空白之后至少要有一个看得见的字符**（不在拒绝表里、不是三种例外、不是空白）：只由空白和例外组成的名字看起来是空的。
 *
 * **代价**：标签字符和补充的变体选择符一律拒绝，所以英格兰、苏格兰这类子区域旗（靠标签字符拼出来）和少数靠补充的变体选择符区分
 * 写法的汉字，名字里用不了；有真实的使用者提出来再放开。
 */

/**
 * 一个字符就拒绝的那张表：`\p{Cc}` 是 C0（U+0000–U+001F）、DEL（U+007F）、C1（U+0080–U+009F）；其余是行分隔符、段分隔符，
 * 和 `Default_Ignorable_Code_Point` 去掉三种例外（U+200C、U+200D、U+FE00–U+FE0F）：
 * U+00AD、U+034F、U+061C、U+115F–U+1160、U+17B4–U+17B5、U+180B–U+180F、U+200B、U+200E–U+200F、U+202A–U+202E、
 * U+2060–U+206F（含未分配的 U+2065）、U+2800（盲文空白）、U+3164、U+FEFF、U+FFA0、U+FFF0–U+FFF8（未分配）、U+1BCA0–U+1BCA3、
 * U+1D173–U+1D17A、U+E0000–U+E0FFF（标签字符、补充的变体选择符和中间未分配的）、U+D800–U+DFFF（孤立的代理码元；成对的在 `for…of` 里是一个字符，不算）。
 */
export const REJECTED_NAME_CHARACTER =
	// biome-ignore lint/suspicious/noMisleadingCharacterClass: 表里是一个一个的码位（含组合用的 U+034F），每个单独就拒绝，不是想匹配「字符加组合符」
	/[\p{Cc}\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B\u200E-\u200F\u2028-\u2029\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF0-\uFFF8\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}\uD800-\uDFFF]/u;

const ZERO_WIDTH_JOINER = 0x200d;
const ZERO_WIDTH_NON_JOINER = 0x200c;
const isVariationSelector = (codePoint: number): boolean =>
	codePoint >= 0xfe00 && codePoint <= 0xfe0f;
const isJoiner = (codePoint: number): boolean =>
	codePoint === ZERO_WIDTH_JOINER || codePoint === ZERO_WIDTH_NON_JOINER;
const WHITE_SPACE = /^\p{White_Space}$/u;

/** 名字里第一个不合格的地方（序号从 1 起，按字符数，不是 UTF-16 的个数）。 */
export type NameProblem =
	| { kind: "rejected"; position: number; codePoint: number }
	| { kind: "misplaced"; position: number; codePoint: number }
	| { kind: "no_visible" };

/** 字符的状态：下一个字符是例外时看它。 */
type Previous = "start" | "base" | "joiner" | "variation" | "variation_of_base";

/**
 * 名字里第一个不合格的地方；没有问题时为 undefined。名字不含任何字符（空串）时没有问题（「不能为空」由各处自己的长度检查说）。
 * 先看每个字符在不在拒绝表里（{@link REJECTED_NAME_CHARACTER}），再看三种例外的位置，最后看有没有看得见的字符。
 */
export function nameProblem(text: string): NameProblem | undefined {
	let position = 0;
	let previous: Previous = "start";
	let visible = false;
	for (const character of text) {
		position++;
		const codePoint = character.codePointAt(0) as number;
		if (REJECTED_NAME_CHARACTER.test(character)) {
			return { kind: "rejected", position, codePoint };
		}
		if (isJoiner(codePoint)) {
			// 前面是一个字符，或者是紧跟在字符后面的一个变体选择符（❤️‍🔥）：不能在开头，不能连着出现。
			if (previous !== "base" && previous !== "variation_of_base") {
				return { kind: "misplaced", position, codePoint };
			}
			previous = "joiner";
		} else if (isVariationSelector(codePoint)) {
			// 紧跟在一个字符后面，一个字符后面最多一个。
			if (previous !== "base") return { kind: "misplaced", position, codePoint };
			previous = "variation_of_base";
		} else {
			previous = "base";
			if (!WHITE_SPACE.test(character)) visible = true;
		}
	}
	if (position > 0 && !visible) return { kind: "no_visible" };
	return undefined;
}

/** `U+200B` 这样写的码位。 */
export const codePointLabel = (codePoint: number): string =>
	`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * 名字不合格时给调用方看的说明（令牌的名称、显示名、昵称、初始管理员的显示名共用同一句）；`what` 是「令牌的名称」「显示名」「昵称」，
 * 没有问题时为 undefined。被拒的几乎都看不见，所以说出是第几个字符、是哪个码位：使用者才知道要删什么。
 */
export function unsafeNameProblem(what: string, text: string): string | undefined {
	const problem = nameProblem(text);
	return problem === undefined ? undefined : describeNameProblem(what, problem);
}

/** 名字的规则，不指具体的名字（导出的接口说明里写这一句；真正拒绝时说的是 {@link unsafeNameProblem}，带第几个字符、哪个码位）。 */
export const nameRule = (what: string): string =>
	`${what}里不能有控制字符（换行、转义序列等）、双向文字的控制字符和零宽空格这类看不见的字符；零宽连接符、零宽不连字符和变体选择符只能紧跟在一个看得见的字符后面；要有至少一个看得见的字符`;

/**
 * zod 的 `refine` 的第二个参数：不合格时的说明带第几个字符、哪个码位（{@link unsafeNameProblem}）；导出的接口说明里没有具体的名字，写规则
 * （{@link nameRule}）。`refine((name) => nameProblem(name) === undefined, nameRefinement("显示名"))`。
 */
export const nameRefinement = (what: string) => ({
	error: (issue: { input?: unknown }): string =>
		(typeof issue.input === "string" ? unsafeNameProblem(what, issue.input) : undefined) ??
		nameRule(what),
});

/** {@link nameProblem} 找到的问题写成给调用方看的一句话（{@link unsafeNameProblem} 用它；要自己加说明的调用方先取问题再用它）。 */
export function describeNameProblem(what: string, problem: NameProblem): string {
	if (problem.kind === "no_visible") return `${what}里没有看得见的字符`;
	const where = `${what}的第 ${problem.position} 个字符是 ${codePointLabel(problem.codePoint)}`;
	return problem.kind === "rejected"
		? `${where}：名字里不能有控制字符、双向文字的控制字符和零宽空格这类看不见的字符`
		: `${where}：零宽连接符、零宽不连字符和变体选择符只能紧跟在一个看得见的字符后面（不能在名字开头，不能连着出现）`;
}
