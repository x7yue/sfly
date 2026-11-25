import { nodeNameWithId } from "@sfly/orchestration";
import { SECRET_MASK } from "@sfly/schema";
import type { RunPlan } from "../engine/chain.js";
import {
	type SecretSet,
	secretLimits,
	secretParamValues,
	secretSetUncached,
	secretValueChars,
} from "../logs/secrets.js";
import { type KnownParams, knownParams } from "./known-params.js";
import type { PreflightProblem } from "./preflight.js";

/**
 * 预检里 secret 参数的值太多或太长的问题的 code：这次触发里所有 secret 值的所有写法合计超过上限
 * （{@link SecretSet.oversize}，docs/SEMANTICS.md §2.1「值集合太大时」）。触发时按实际的值是阻断项（400 `invalid_params`
 * 的 `details`）；预检接口按场景里的默认值和运行预设给的是警告（触发时给了别的值就能触发）；触发时改不了的那部分值
 * 超限（{@link SecretSizeScope} 的 `fixed`）是阻断项。
 */
export const SECRET_PARAMS_TOO_LARGE = "secret_params_too_large";

/** 说明里最多列出几个占得最多的参数。 */
const LISTED = 5;
/** 小于上限的这个比例的参数不单独列出，只写「另有 N 个较小的」。 */
const LISTED_MIN_SHARE = 0.01;

/** 这份值集合是哪里来的：说明的写法据此不同。 */
export type SecretSizeScope =
	/** 这次触发的值（触发时给的、运行预设里的、默认值，子流程里触发时就知道的）。 */
	| { kind: "trigger" }
	/** 场景最新版本里 secret 参数的默认值（触发时一个都不给）；`presetIds` 是 secret 值和它完全相同的运行预设（用它们触发，用的也是这些默认值）。 */
	| { kind: "defaults"; presetIds: string[] }
	/** 用这个运行预设触发（其余参数取默认值）。 */
	| { kind: "preset"; id: string; name: string }
	/** 触发时改不了的值：子流程里由异步任务节点传的常量、子流程入口节点自己的默认值。要改场景。 */
	| { kind: "fixed" };

/** 一个数向上取整到千：说明里的大小不写确切的长度（预检只要读权限就能调，不把长度白送给只读的人）。 */
export const roundedUp = (chars: number): number => Math.ceil(chars / 1000) * 1000;

const SUM_NOTE =
	"是所有写法合计的，对象、数组会是它自身大小的好几倍，见文档「secret 参数的大小上限」";

function reason(scope: SecretSizeScope): string {
	switch (scope.kind) {
		case "trigger":
			return "这次触发的 secret 参数的值太多或太长";
		case "defaults":
			return "场景里 secret 参数的默认值太多或太长，照默认值触发会被拒绝（触发时给这些参数传更小的值就能触发）";
		case "preset":
			return `运行预设「${scope.name}」的 secret 参数的值（其余参数用默认值）太多或太长，用它触发会被拒绝`;
		case "fixed":
			return "场景里写死的 secret 值（子流程的参数由节点传常量，或用子流程入口节点自己的默认值）太多或太长，触发时给什么都改不了";
	}
}

function advice(scope: SecretSizeScope): string {
	const how =
		"不要把整份大的 JSON 或整个文件放进一个 secret 参数，只把真正要打码的字段单独做成 secret 参数，其余的做成普通参数";
	return scope.kind === "fixed"
		? `怎么办：改场景：缩短上面这些子流程参数的值（节点传的常量、子流程入口节点上的默认值）；${how}。`
		: `怎么办：缩短这些值；${how}。`;
}

/**
 * 这次触发里 secret 参数的值合计太大时的一个问题，不大时 undefined。`chains` 是触发时就知道入口参数的链
 * （{@link knownParams}：主链，和异步任务节点按参数映射传入的子流程），`secrets` 是它们汇总的值集合。
 * 判断就是运行里的判断（{@link SecretSet.oversize}：只比总长，不建自动机）：这里没有超过的，运行里也不会因为这些值超过；
 * 运行中才知道的值（子流程的参数取自前面节点的输出、调度自己的子流程一层层带进来的值）这里算不到，
 * 运行开始之后才成为 secret 的值让合计超限时，照运行里的做法整段盖住（docs/SEMANTICS.md §2.1）。
 *
 * 说明分三行：原因（合计约多少、上限多少）、占得最多的参数、怎么办。合计和各参数的大小取整到千（向上），上限写确切值；
 * 小于上限 1% 的参数不单独列。只有个数，不含任何值。
 */
export function secretSizeProblem(
	chains: readonly KnownParams[],
	scope: SecretSizeScope,
	secrets: SecretSet,
): PreflightProblem | undefined {
	if (!secrets.oversize) return undefined;
	const sources = chains
		.flatMap(({ chain, params }) =>
			chain.entry.params
				.filter((declaration) => declaration.secret === true)
				.map((declaration) => ({
					nodeId: chain.entry.id,
					label:
						chain.entry.kind === "entry"
							? `参数 ${declaration.name}`
							: `子流程 ${nodeNameWithId(chain.entry)} 的参数 ${declaration.name}`,
					chars: secretValueChars(params[declaration.name]),
				})),
		)
		.filter((source) => source.chars > 0)
		.sort((a, b) => b.chars - a.chars);
	const listed = sources
		.filter((source) => source.chars >= secretLimits.automatonChars * LISTED_MIN_SHARE)
		.slice(0, LISTED);
	const smaller = sources.length - listed.length;
	const largest = listed.map((source) => `${source.label}（约 ${roundedUp(source.chars)} 个字符）`);
	const second =
		largest.length === 0
			? `每个参数都不大，是个数多：共 ${smaller} 个 secret 参数。`
			: `占得最多的是 ${largest.join("、")}${smaller > 0 ? `，另有 ${smaller} 个较小的` : ""}。`;
	const first =
		`${reason(scope)}：所有写法合计约 ${roundedUp(secrets.chars)} 个字符（这个数${SUM_NOTE}），` +
		`超过上限 ${secretLimits.automatonChars} 个字符。` +
		`超过上限的运行里，日志、动作、运行视图里的文字会全部显示为 ${SECRET_MASK}，而且之后一直是这样，所以不让触发。`;
	return {
		code: SECRET_PARAMS_TOO_LARGE,
		message: [first, second, advice(scope)].join("\n"),
		...(scope.kind === "fixed" && listed[0] ? { node_id: listed[0].nodeId } : {}),
		...(scope.kind === "defaults"
			? { origin: { kind: "defaults" as const, preset_ids: scope.presetIds } }
			: {}),
		...(scope.kind === "preset"
			? { origin: { kind: "preset" as const, preset_id: scope.id } }
			: {}),
	};
}

/** 这几条链上 secret 参数的值（有值的），按链、按声明的顺序：预设和默认值比较「算出来的 secret 值是不是一样」用。 */
export function secretValueList(chains: readonly KnownParams[]): unknown[] {
	return chains.flatMap(({ chain, params }) => secretParamValues(chain.entry.params, params));
}

/**
 * 触发时改不了的 secret 值：子流程里由异步任务节点传的常量、子流程入口节点自己的默认值（和只由它们算出来的值）。
 * 主链的入口参数、引用了主链入口参数的映射，触发时都可以换，不在这里：算的时候主链一个参数也不给，
 * 引用了入口参数的映射就解析不出来，不算。
 */
export function fixedSecretChains(plan: RunPlan): KnownParams[] {
	return knownParams(plan, {}).filter(({ chain }) => chain !== plan.main);
}

/**
 * 触发时改不了的值自己就超限：怎么触发都被拒，所以是阻断项（预检接口和触发时都是），说明指出要改场景。
 * 不建自动机，不经过值集合的缓存（{@link secretSetUncached}）。
 */
export function fixedSecretSizeProblem(plan: RunPlan): PreflightProblem | undefined {
	const chains = fixedSecretChains(plan);
	const values = secretValueList(chains);
	if (values.length === 0) return undefined;
	return secretSizeProblem(chains, { kind: "fixed" }, secretSetUncached(values));
}
