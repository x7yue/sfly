import { nodeNameWithId } from "@sfly/orchestration";
import { SECRET_MASK } from "@sfly/schema";
import { type SecretSet, secretLimits, secretValueChars } from "../logs/secrets.js";
import { type KnownParams, secretTexts } from "./known-params.js";
import type { PreflightProblem } from "./preflight.js";

/**
 * 预检里 secret 参数的值太多或太长的问题的 code：这次触发里所有 secret 值的所有写法合计超过上限
 * （{@link SecretSet.oversize}，docs/SEMANTICS.md §2.1「值集合太大时」）。触发时按实际的值是阻断项（400 `invalid_params`
 * 的 `details`），预检接口按场景里的默认值和运行预设给的是警告（{@link SecretSizeScope}）。
 */
export const SECRET_PARAMS_TOO_LARGE = "secret_params_too_large";

/** 说明里最多列出几个占得最多的参数。 */
const LISTED = 5;

/** 这份值集合是哪里来的：说明的开头据此不同。 */
export type SecretSizeScope =
	/** 这次触发的值（触发时给的、运行预设里的、默认值）。 */
	| { kind: "trigger" }
	/** 场景最新版本里 secret 参数的默认值（触发时一个都不给）。 */
	| { kind: "defaults" }
	/** 用这个运行预设触发（其余参数取默认值）。 */
	| { kind: "preset"; name: string };

function lead(scope: SecretSizeScope): string {
	switch (scope.kind) {
		case "trigger":
			return "这次触发的 secret 参数的值太多或太长";
		case "defaults":
			return "场景里 secret 参数的默认值太多或太长，照默认值触发会被拒绝（触发时给这些参数传更小的值就能触发）";
		case "preset":
			return `运行预设「${scope.name}」的 secret 参数的值（其余参数用默认值）太多或太长，用它触发会被拒绝`;
	}
}

/**
 * 这次触发里 secret 参数的值合计太大时的一个问题，不大时 undefined。`chains` 是触发时就知道入口参数的链
 * （{@link knownParams}：主链，和异步任务节点按参数映射传入的子流程），`secrets` 是它们汇总的值集合（{@link secretTexts}，
 * 和运行里用的是同一份）。判断就是运行里的判断（{@link SecretSet.oversize}）：这里没有超过的，运行里也不会因为这些值超过；
 * 运行中才知道的值（子流程的参数取自前面节点的输出）这里算不到，运行开始之后才成为 secret 的值让合计超限时，
 * 照运行里的做法整段盖住（docs/SEMANTICS.md §2.1）。
 *
 * 说明写明合计多少、上限多少、占得最多的是哪几个参数（各自单独算），和怎么办；只有个数，不含任何值。
 */
export function secretSizeProblem(
	chains: readonly KnownParams[],
	scope: SecretSizeScope,
	secrets: SecretSet = secretTexts(chains),
): PreflightProblem | undefined {
	if (!secrets.oversize) return undefined;
	const sources = chains
		.flatMap(({ chain, params }) =>
			chain.entry.params
				.filter((declaration) => declaration.secret === true)
				.map((declaration) => ({
					label:
						chain.entry.kind === "entry"
							? `参数 ${declaration.name}`
							: `子流程 ${nodeNameWithId(chain.entry)} 的参数 ${declaration.name}`,
					chars: secretValueChars(params[declaration.name]),
				})),
		)
		.filter((source) => source.chars > 0)
		.sort((a, b) => b.chars - a.chars);
	const largest = sources
		.slice(0, LISTED)
		.map((source) => `${source.label}（${source.chars} 个字符）`)
		.join("、");
	const more = sources.length > LISTED ? `，另有 ${sources.length - LISTED} 个` : "";
	return {
		code: SECRET_PARAMS_TOO_LARGE,
		message:
			`${lead(scope)}：所有写法合计 ${secrets.chars} 个字符，超过上限 ${secretLimits.automatonChars} 个字符。` +
			`超过上限的运行里，日志、动作、运行视图里的文字会全部显示为 ${SECRET_MASK}，而且之后一直是这样。` +
			`占得最多的是 ${largest}${more}。` +
			"怎么办：缩短这些值；不要把整份大的 JSON 或整个文件放进一个 secret 参数，" +
			"只把真正要保密的字段单独做成 secret 参数，其余的做成普通参数。",
	};
}
