import {
	describeSchema,
	nodeNameWithId,
	PARAM_PATH,
	typeProblem,
	WHOLE_REFERENCE,
} from "@sfly/orchestration";
import type { PackageMetadata } from "@sfly/schema";
import type { ChainPlan } from "../engine/chain.js";
import { jsonText, maskSecrets, SECRET_MASK } from "../logs/secrets.js";
import { type KnownParams, resolved, secretTexts } from "./known-params.js";
import type { PreflightProblem } from "./preflight.js";

/**
 * 主链的入口参数的值从哪来（写进问题的说明）：触发请求里给的、运行预设固定的、都没有就是声明的默认值。
 * 子流程的参数不在这里：它们的来源是 {@link KnownParams.source}。
 */
export interface ParamOrigins {
	/** 这次触发用的运行预设和它固定的参数；没有用预设时为 null。 */
	preset: { name: string; params: ReadonlySet<string> } | null;
	/** 这次触发请求里给了值的参数。 */
	given: ReadonlySet<string>;
}

/** 值恰好是一个入口参数的整值引用（`${{ params.x }}`）时返回参数名；其他写法（常量、夹在文字里、引用节点输出）没有。 */
function wholeParamReference(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const path = WHOLE_REFERENCE.exec(value)?.[1];
	return path === undefined ? undefined : PARAM_PATH.exec(path)?.[1];
}

/** 命令行触发时给这个参数的写法：整数输入写 `<整数>`，其他类型写 `<类型 类型的值>`。 */
const commandHint = (name: string, expected: string): string =>
	`sfly run start <场景> --param ${name}=${expected === "integer" ? "<整数>" : `<${expected} 类型的值>`}`;

/** 这个值是哪来的，以及去哪里改（主链按触发时的取值来源，子流程按异步任务节点传入的）。 */
function whereAndNext(
	{ chain, source }: KnownParams,
	main: ChainPlan,
	name: string,
	expected: string,
	origins: ParamOrigins,
): { where: string; next: string } {
	if (chain !== main) {
		return {
			where: source,
			next: `请改这个异步任务节点的参数映射，让传给 ${name} 的值是 ${expected} 类型的值`,
		};
	}
	const { preset } = origins;
	if (preset?.params.has(name)) {
		return {
			where: `运行预设「${preset.name}」里的值`,
			next: `请在场景列表的「运行预设…」里把运行预设「${preset.name}」里 ${name} 的值改成 ${expected} 类型的值（命令行用 sfly api --list presets 列出修改预设的接口）`,
		};
	}
	if (origins.given.has(name)) {
		return {
			where: "触发时给的值",
			next: `请把 ${name} 改成 ${expected} 类型的值再触发，例如：${commandHint(name, expected)}`,
		};
	}
	return {
		where: "声明的默认值",
		next: `请触发时给 ${name} 传值，例如：${commandHint(name, expected)}；或者在场景的入口节点里把 ${name} 的默认值改成 ${expected} 类型的值`,
	};
}

/**
 * 整个引用入口参数的节点输入，按触发时知道的实际值检查类型（触发时给的值、运行预设里的值、默认值，
 * 子流程里则是异步任务节点按参数映射传入的值）：值不符合输入的类型时，派发到这个节点才会以 config_error 失败
 * （「输入 x 应为 integer，实际是 8.5」），触发前就拒绝，并写明是哪个参数、接到哪个节点的哪个输入。
 *
 * 判断和派发时是同一个（`typeProblem`，和 `inputProblems` 共用），不另写一份：8 和 8.0 都是 JSON 数值 8，是整数；8.5 不是。
 * secret 参数的值不写进说明，写掩码（secret 属性按值传播，经参数映射进了子流程的也一样）。
 * 没有值（null，可选参数没给）的不在这里查，派发时照常检查；值不知道的（取自前面节点的输出）、
 * 夹在文字里的引用、常量（保存时就由静态检查指出）都不在这里。
 * 节点包版本在控制面没有元信息（开发版本）的节点不检查。
 */
export function paramInputTypeProblems(
	main: ChainPlan,
	chains: readonly KnownParams[],
	locked: ReadonlyMap<string, Pick<PackageMetadata, "nodes">>,
	origins: ParamOrigins,
): PreflightProblem[] {
	const problems: PreflightProblem[] = [];
	const secrets = secretTexts(chains);
	for (const known of chains) {
		for (const node of known.chain.nodes) {
			if (node.kind !== "package") continue;
			const io = locked.get(node.package)?.nodes.find((n) => n.name === node.node)?.inputs;
			if (!io) continue;
			for (const [input, value] of Object.entries(node.inputs)) {
				const name = wholeParamReference(value);
				if (name === undefined) continue;
				const actual = resolved(value, known.params);
				if (actual === undefined || actual === null) continue;
				const found = typeProblem(io, input, actual);
				if (found === undefined) continue;
				const expected = describeSchema(io.properties[input] ?? {});
				// secret 的值不出现在说明里：判断照旧，只是把「实际是 …」里的值换成掩码。整个值就是 secret 值时写成 ******；
				// secret 值夹在文字里、放在对象里经参数映射传进来时，值只是一部分，按子串打码（和机器人、Agent 名称的说明一致）。
				const problem = secrets.includes(jsonText(actual))
					? `输入 ${input} 应为 ${expected}，实际是 ${SECRET_MASK}`
					: maskSecrets(found, secrets);
				const { where, next } = whereAndNext(known, main, name, expected, origins);
				problems.push({
					code: "param_input_type_mismatch",
					message: `节点 ${nodeNameWithId(node)} 的${problem}（入口参数 ${name}，${where}）：${next}`,
					node_id: node.id,
				});
			}
		}
	}
	return problems;
}
