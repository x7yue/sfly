import { isDeepStrictEqual } from "node:util";
import { planRun } from "../engine/chain.js";
import { declaresSecrets, secretSetUncached } from "../logs/secrets.js";
import { presetProblems } from "../presets/preset-validity.js";
import { knownParams } from "./known-params.js";
import type { PreflightProblem } from "./preflight.js";
import type { RawScenario } from "./raw-scenario.js";
import { fixedSecretSizeProblem, secretSizeProblem, secretValueList } from "./secret-size.js";

/**
 * 预检里 secret 参数的值合计太大的检查（{@link secretSizeProblem}）。触发时按实际的值检查（{@link createParamsCheck}），
 * 预检接口这时还不知道触发时给什么，只能看已经知道的值，所以：
 *
 * - 触发时**改不了**的值（子流程里由异步任务节点传的常量、子流程入口节点自己的默认值）自己就超限：怎么触发都被拒，
 *   是阻断项（`problems`），说明指出要改场景；
 * - 场景最新版本里 secret 参数的默认值（触发时一个都不给），和每个还能用的运行预设（预设里的值，其余参数用默认值）各算一次，
 *   超过的给警告（`warnings`，带 `origin` 说明是哪一组）：触发时给了更小的值就能触发。
 *   预设算出来的 secret 值列表和只用默认值时完全相同的，不另给（预设固定的普通参数也可以经映射成为子流程的 secret 参数，
 *   所以不能只看预设有没有固定 secret 参数）。
 *
 * 只比总长（{@link SecretSet.oversize}），不建自动机，也不进值集合的缓存（{@link secretSetUncached}）：预检只要有读权限
 * 就能调，控制台每次打开运行抽屉都会调。预设很多、值很大时，每算一个预设让出一次事件循环，不连续占住。
 * 读原始文档和预设值（{@link RawScenario}，路由读一次传进来）。
 */
export async function secretSizePreflight({ document, presets }: RawScenario): Promise<{
	problems: PreflightProblem[];
	warnings: PreflightProblem[];
}> {
	const none = { problems: [], warnings: [] };
	if (!declaresSecrets(document)) return none;
	const plan = planRun(document);
	// 结构有问题的场景，预检的阻断项已经指出，这里不再另算。
	if ("errors" in plan) return none;

	const fixed = fixedSecretSizeProblem(plan);
	if (fixed) return { problems: [fixed], warnings: [] };

	const declarations = plan.main.entry.params;
	const defaults = Object.fromEntries(declarations.map((d) => [d.name, d.default ?? null]));
	const defaultChains = knownParams(plan, defaults);
	const defaultValues = secretValueList(defaultChains);
	// 算出来的 secret 值和只用默认值时完全相同的预设：用它们触发用的也是这些默认值，默认值的警告对它们同样适用。
	const sameAsDefaults: string[] = [];
	const fromPresets: PreflightProblem[] = [];
	for (const preset of presets) {
		// 失效的预设不能用来触发。
		if (presetProblems(preset.values, declarations).length > 0) continue;
		const chains = knownParams(plan, { ...defaults, ...preset.values });
		const values = secretValueList(chains);
		if (isDeepStrictEqual(values, defaultValues)) {
			sameAsDefaults.push(preset.id);
			continue;
		}
		const problem = secretSizeProblem(
			chains,
			{ kind: "preset", id: preset.id, name: preset.name },
			secretSetUncached(values),
		);
		if (problem) fromPresets.push(problem);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	const fromDefaults = secretSizeProblem(
		defaultChains,
		{ kind: "defaults", presetIds: sameAsDefaults },
		secretSetUncached(defaultValues),
	);
	const warnings = [...(fromDefaults ? [fromDefaults] : []), ...fromPresets];
	return { problems: [], warnings };
}
