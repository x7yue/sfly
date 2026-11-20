import type { OrchestrationDocument, ParamDeclaration } from "@sfly/schema";
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/database.js";
import { orchestrations, orchestrationVersions } from "../db/schema.js";
import { planRun, type RunPlan } from "../engine/chain.js";
import { fillParams, withPresetValues } from "../engine/params.js";
import type { RunRow } from "../engine/step.js";
import { findPreset, PRESET_NOT_FOUND } from "../presets/preset-store.js";
import { describePresetProblems, presetProblems } from "../presets/preset-validity.js";
import { presetParamNames } from "../presets/preset-view.js";
import type { ProjectId } from "../projects/project-id.js";
import { isUuid } from "../util/uuid.js";
import type { ParamsCheck, Preflight } from "./preflight.js";

/** 触发请求：入口参数的取值，和可选的运行预设（它的 ID）。 */
export interface TriggerRequest {
	params: Record<string, unknown>;
	preset?: string | undefined;
}

/** 不能触发：HTTP 状态码、错误码和原因；`details` 是逐条的问题（预检、参数、预设的问题清单）。 */
export interface TriggerRejection {
	ok: false;
	status: 400 | 404 | 409;
	code: string;
	message: string;
	details?: unknown;
}

/** 可以触发：运行用什么版本、什么计划、什么入口参数，以及运行上记下的预设。 */
export interface AdmittedTrigger {
	ok: true;
	/** 场景所在的项目：运行属于它（`runs.project_id` 冗余存这一份）。 */
	projectId: ProjectId;
	/** 场景的最新版本。 */
	version: { id: string; document: OrchestrationDocument };
	plan: RunPlan;
	/** 套用预设、补上默认值之后的入口参数。 */
	params: Record<string, unknown>;
	/** `runs` 里记运行预设的三列（预设的 ID、名称和预设参数的名单）；没有用预设时都是 null。 */
	runPreset: Pick<RunRow, "presetId" | "presetName" | "presetParams">;
}

/**
 * 触发准入：场景现在能不能触发、用什么参数触发。读场景、版本和运行预设用调用方的事务 `tx`：
 * 场景行加共享锁，与归档互斥；预设在这个事务里读，预设失效就拒绝（ADR 0024）。
 * 预检读库同样传 `tx`（#380）。只读，不写库；创建运行是调用方的事。
 */
export type TriggerAdmission = (
	tx: Tx,
	orchestrationId: string,
	request: TriggerRequest,
) => Promise<AdmittedTrigger | TriggerRejection>;

const NO_PRESET: AdmittedTrigger["runPreset"] = {
	presetId: null,
	presetName: null,
	presetParams: null,
};

function reject(
	status: TriggerRejection["status"],
	code: string,
	message: string,
	details?: unknown,
): TriggerRejection {
	return details === undefined
		? { ok: false, status, code, message }
		: { ok: false, status, code, message, details };
}

const invalidOrchestration = (problems: readonly { message: string }[]) =>
	reject(400, "invalid_orchestration", problems.map((p) => p.message).join("; "), problems);

/**
 * 请求带了运行预设时用它的值填入预设参数（docs/SEMANTICS.md §6「运行预设」）：预设不存在或不属于这个场景返回 404，
 * 已失效返回 409 `preset_invalid`，请求里给预设参数传了值返回 400 `preset_param_locked`。没带预设时原样返回请求的参数。
 */
async function applyPreset(
	tx: Tx,
	orchestrationId: string,
	request: TriggerRequest,
	declarations: ParamDeclaration[],
): Promise<
	| { ok: true; params: Record<string, unknown>; runPreset: AdmittedTrigger["runPreset"] }
	| TriggerRejection
> {
	if (request.preset === undefined)
		return { ok: true, params: request.params, runPreset: NO_PRESET };
	const preset = isUuid(request.preset)
		? await findPreset(tx, orchestrationId, request.preset)
		: undefined;
	if (!preset) return { ok: false, ...PRESET_NOT_FOUND };
	const invalid = presetProblems(preset.values, declarations);
	if (invalid.length > 0) {
		return reject(
			409,
			"preset_invalid",
			`运行预设「${preset.name}」已失效，不能用来触发：${describePresetProblems(invalid, declarations)}`,
			invalid,
		);
	}
	const fixed = withPresetValues(request.params, preset.values, declarations);
	if ("locked" in fixed) {
		return reject(
			400,
			"preset_param_locked",
			`参数 ${fixed.locked} 由运行预设「${preset.name}」固定，请求里不要给它传值`,
			{ param: fixed.locked, preset: preset.name },
		);
	}
	return {
		ok: true,
		params: fixed.params,
		runPreset: {
			presetId: preset.id,
			presetName: preset.name,
			presetParams: presetParamNames(preset.values, declarations),
		},
	};
}

/** 按顺序过各道检查：场景和版本、触发前的预检、运行预设、入口参数、按参数实际值做的检查；先不通过的先返回。 */
export function createTriggerAdmission(checks: {
	preflight: Preflight;
	paramsCheck: ParamsCheck;
}): TriggerAdmission {
	return async (tx, orchestrationId, request) => {
		const [orchestration] = await tx
			.select()
			.from(orchestrations)
			.where(eq(orchestrations.id, orchestrationId))
			// 与归档（OrchestrationStore.archive 加排他锁后检查运行中的运行）互斥。
			.for("share");
		if (!orchestration) return reject(404, "not_found", "orchestration not found");
		if (orchestration.archivedAt) {
			return reject(409, "archived", "orchestration is archived; restore it before triggering");
		}
		const [version] = await tx
			.select()
			.from(orchestrationVersions)
			.where(
				and(
					eq(orchestrationVersions.orchestrationId, orchestrationId),
					eq(orchestrationVersions.number, orchestration.headVersion),
				),
			);
		if (!version) return reject(400, "no_version", "orchestration has no saved version");

		const problems = await checks.preflight(tx, version.document);
		if (problems.length > 0) return invalidOrchestration(problems);
		const plan = planRun(version.document);
		if ("errors" in plan) {
			return invalidOrchestration(
				plan.errors.map((message) => ({ code: "not_supported", message })),
			);
		}

		const declarations = plan.main.entry.params;
		const applied = await applyPreset(tx, orchestrationId, request, declarations);
		if (!applied.ok) return applied;
		const filled = fillParams(declarations, applied.params);
		if ("errors" in filled) {
			return reject(400, "invalid_params", filled.errors.join("; "), filled.errors);
		}
		const { presetName, presetParams } = applied.runPreset;
		const paramProblems = await checks.paramsCheck(tx, version.document, plan, filled.params, {
			preset:
				presetName === null ? null : { name: presetName, params: new Set(presetParams ?? []) },
			given: new Set(Object.keys(request.params)),
		});
		if (paramProblems.length > 0) {
			return reject(
				400,
				"invalid_params",
				paramProblems.map((p) => p.message).join("; "),
				paramProblems,
			);
		}
		return {
			ok: true,
			projectId: orchestration.projectId,
			version: { id: version.id, document: version.document },
			plan,
			params: filled.params,
			runPreset: applied.runPreset,
		};
	};
}
