import { type ParamDeclaration, SECRET_MASK, type StoredOrchestrationDocument } from "@sfly/schema";
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/database.js";
import { orchestrations, orchestrationVersions } from "../db/schema.js";
import { agentFor, planRun, type RunPlan } from "../engine/chain.js";
import { fillParams, placeholderParams, withPresetValues } from "../engine/params.js";
import type { RunRow } from "../engine/step.js";
import { findPreset, PRESET_NOT_FOUND } from "../presets/preset-store.js";
import { describePresetProblems, presetProblems } from "../presets/preset-validity.js";
import { presetParamNames } from "../presets/preset-view.js";
import type { ProjectId } from "../projects/project-id.js";
import { isUuid } from "../util/uuid.js";
import type { ParamsCheck, Preflight } from "./preflight.js";
import {
	planFor,
	SECRETS_WITHHELD,
	withheldProblems,
	withoutSecretValues,
} from "./withheld-secrets.js";

/** 触发请求：入口参数的取值，和可选的运行预设（它的 ID）。 */
export interface TriggerRequest {
	params: Record<string, unknown>;
	preset?: string | undefined;
	/** 不解析 secret 参数（会话令牌触发、会话没勾选「联调时可以使用项目密钥」，#497）：内嵌的默认值和预设里的值当作没有提供。 */
	withholdSecrets?: boolean;
}

/** 不能触发：HTTP 状态码、错误码和原因；`details` 是逐条的问题（预检、参数、预设的问题清单）。 */
export interface TriggerRejection {
	ok: false;
	status: 400 | 404 | 409;
	code: string;
	message: string;
	details?: unknown;
	/** 预检因为版本冲突（`package_version_in_use`）阻断时，要记下的拒绝（不进响应，`engine.ts` 的 trigger 写进库）。 */
	versionConflicts?: VersionConflict[];
}

/** 预检阻断的一次版本冲突：哪个项目、哪台 Agent、哪个节点包的哪个版本，和给用户的说明。 */
export interface VersionConflict {
	projectId: ProjectId;
	agentName: string;
	package: string;
	version: string;
	message: string;
}

/** 可以触发：运行用什么版本、什么计划、什么入口参数，以及运行上记下的预设。 */
export interface AdmittedTrigger {
	ok: true;
	/** 场景所在的项目：运行属于它（`runs.project_id` 冗余存这一份）。 */
	projectId: ProjectId;
	/** 场景此刻的名称：会话令牌触发的运行，会话里的平台记录写它（#547）。 */
	scenarioName: string;
	/** 场景的最新版本。 */
	version: { id: string; document: StoredOrchestrationDocument };
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

/** 预检的问题里版本冲突的那些：按问题指到的节点得出 Agent、节点包和版本（`preflight.ts` 的 `versionsInUseProblems`）。 */
function versionConflicts(
	projectId: ProjectId,
	doc: StoredOrchestrationDocument,
	problems: readonly { code: string; message: string; node_id?: string }[],
): VersionConflict[] {
	return problems.flatMap((p) => {
		const node = doc.nodes.find((n) => n.id === p.node_id);
		if (p.code !== "package_version_in_use" || node?.kind !== "package") return [];
		return [
			{
				projectId,
				agentName: agentFor(doc, node),
				package: node.package,
				version: doc.packages[node.package] ?? "",
				message: p.message,
			},
		];
	});
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
	// 不解析 secret 参数时预设里的 secret 值当作没有提供：先去掉再看预设还能不能用，旧的 secret 值类型不对不该挡住这次触发。
	const values = request.withholdSecrets
		? withoutSecretValues(preset.values, declarations)
		: preset.values;
	const invalid = presetProblems(values, declarations);
	if (invalid.length > 0) {
		return reject(
			409,
			"preset_invalid",
			`运行预设「${preset.name}」已失效，不能用来触发：${describePresetProblems(invalid, declarations)}`,
			invalid,
		);
	}
	const fixed = withPresetValues(request.params, values, declarations);
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
			presetParams: presetParamNames(values, declarations),
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

		const problems = await checks.preflight(
			tx,
			orchestration.projectId,
			version.document,
			version.sessionId,
		);
		if (problems.length > 0) {
			return {
				...invalidOrchestration(problems),
				versionConflicts: versionConflicts(orchestration.projectId, version.document, problems),
			};
		}
		const plan = planRun(version.document);
		if ("errors" in plan) {
			return invalidOrchestration(
				plan.errors.map((message) => ({ code: "not_supported", message })),
			);
		}

		// 这次运行用的计划（不解析 secret 参数时去掉了默认值和常量，`planFor`）：入口参数、参数检查都按它。
		const effective = planFor(plan, request.withholdSecrets ?? false);
		const declarations = effective.main.entry.params;
		const applied = await applyPreset(tx, orchestrationId, request, declarations);
		if (!applied.ok) return applied;
		if (request.withholdSecrets) {
			const withheld = withheldProblems(plan, applied.params);
			if (withheld.length > 0) return reject(400, SECRETS_WITHHELD, withheld.join("; "), withheld);
		}
		// 请求里 secret 参数的值是读取接口打的码 ******：它不是值，不能当成值传给节点（预设固定的值不在 request.params 里）。
		const placeholders = placeholderParams(declarations, request.params);
		if (placeholders.length > 0) {
			const errors = placeholders.map(
				(name) =>
					`参数 ${name} 的值是 ${SECRET_MASK}：这是读取时给 secret 参数打的码，不是值。不传这个参数就用默认值，要用别的值就传真正的值`,
			);
			return reject(400, "invalid_params", errors.join("; "), errors);
		}
		const filled = fillParams(declarations, applied.params);
		if ("errors" in filled) {
			return reject(400, "invalid_params", filled.errors.join("; "), filled.errors);
		}
		const { presetName, presetParams } = applied.runPreset;
		const paramProblems = await checks.paramsCheck(
			tx,
			orchestration.projectId,
			version.document,
			version.sessionId,
			effective,
			filled.params,
			{
				preset:
					presetName === null ? null : { name: presetName, params: new Set(presetParams ?? []) },
				given: new Set(Object.keys(request.params)),
			},
		);
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
			scenarioName: orchestration.name,
			version: { id: version.id, document: version.document },
			plan,
			params: filled.params,
			runPreset: applied.runPreset,
		};
	};
}
