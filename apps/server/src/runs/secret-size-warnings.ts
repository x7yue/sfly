import { asc, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { runPresets } from "../db/schema.js";
import { planRun } from "../engine/chain.js";
import { declaresSecrets } from "../logs/secrets.js";
import { presetProblems } from "../presets/preset-validity.js";
import { rawHeadDocument } from "./head-document.js";
import { knownParams } from "./known-params.js";
import type { PreflightProblem } from "./preflight.js";
import { secretSizeProblem } from "./secret-size.js";

/**
 * 预检的警告：secret 参数的值合计太大（所有写法合计超过上限，{@link secretSizeProblem}）。
 * 触发时按实际的值是阻断项（{@link createParamsCheck}），预检接口这时还不知道触发时给什么，只能看已经知道的值：
 * 场景最新版本里 secret 参数的默认值（触发时一个都不给），和每个还能用的运行预设（预设里的值，其余参数用默认值）。
 * 触发时给了别的值就能触发，所以这里只是警告，写明按这些值触发会被拦下。
 *
 * 读原始文档，所以在这里读库，不经过打码的读取函数（{@link rawHeadDocument}）。
 */
export async function secretSizeWarnings(
	db: Db | Tx,
	orchestrationId: string,
): Promise<PreflightProblem[]> {
	const document = await rawHeadDocument(db, orchestrationId);
	if (!document || !declaresSecrets(document)) return [];
	const plan = planRun(document);
	// 结构有问题的场景，预检的阻断项已经指出，这里不再另算。
	if ("errors" in plan) return [];
	const declarations = plan.main.entry.params;
	const defaults = Object.fromEntries(declarations.map((d) => [d.name, d.default ?? null]));
	const warnings: PreflightProblem[] = [];
	const fromDefaults = secretSizeProblem(knownParams(plan, defaults), { kind: "defaults" });
	if (fromDefaults) warnings.push(fromDefaults);

	const secretNames = new Set(declarations.filter((d) => d.secret).map((d) => d.name));
	const presets = await db
		.select({ name: runPresets.name, values: runPresets.values })
		.from(runPresets)
		.where(eq(runPresets.orchestrationId, orchestrationId))
		.orderBy(asc(runPresets.name));
	for (const preset of presets) {
		// 失效的预设不能用来触发；没有固定 secret 参数的预设和只用默认值是同一份值，上面已经算过。
		if (presetProblems(preset.values, declarations).length > 0) continue;
		if (!Object.keys(preset.values).some((name) => secretNames.has(name))) continue;
		const problem = secretSizeProblem(knownParams(plan, { ...defaults, ...preset.values }), {
			kind: "preset",
			name: preset.name,
		});
		if (problem) warnings.push(problem);
	}
	return warnings;
}
