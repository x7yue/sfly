import type { EndpointResponse, PreflightProblem, runsApi } from "@sfly/schema";

/**
 * 运行抽屉的触发前检查清单（纯逻辑，有单测）：把预检结果（GET /orchestrations/:id/preflight）整理成
 * 「结构与引用」「包版本锁定」「Agent 是否在线」几行；有阻断项的行不能触发，Agent 不在线、在准备环境只提醒（任务会排队）。
 * 预检的警告（`warnings`，不阻断触发）列在最后一行，只提醒。
 * secret 参数的值合计太大（`secret_params_too_large`）单独一行，标题写明后果（会被拒绝），不放在「不阻止触发」那一组里：
 * 触发时改不了的值（`problems` 里的，要改场景）是阻断项；默认值、运行预设的警告只显示和当前选择有关的那一条
 * （没选预设是默认值的，选了预设是这个预设的，`origin` 说明它说的是哪一组），选中的这一组没有问题时不显示。
 * 场景还没有版本、已归档时只列这一条原因；从画布打开时另外检查本地未保存的修改与画布版本是否最新。
 */

export type Preflight = EndpointResponse<typeof runsApi.preflight>;

export type CheckState = "ok" | "warn" | "blocked";

export interface CheckRow {
	key: "version" | "structure" | "packages" | "agents" | "secret-size" | "warnings";
	state: CheckState;
	title: string;
	detail?: string;
	/** 这一行的问题（带 node_id 的可以「前往」）。 */
	problems: PreflightProblem[];
}

/** 版本本身的问题：其余检查没有意义，只列这一条。 */
const VERSION_CODES = new Set(["no_version", "archived"]);
const PACKAGE_CODES = new Set([
	"package_not_locked",
	"package_version_missing",
	"unknown_node_type",
	// 锁定开发版本（包名@dev）的节点，派发到的 Agent 没有加载它。
	"dev_package_not_loaded",
]);
/** secret 参数的值合计太大：单独一行。 */
const SECRET_SIZE_CODE = "secret_params_too_large";
const AGENT_CODES = new Set([
	"agent_not_registered",
	"agent_input_not_registered",
	"sdk_version_unsatisfied",
	"agent_version_unsatisfied",
]);

/** 从画布打开时才有的本地检查。 */
export interface LocalState {
	/** 画布上有未保存的修改（本地草稿）。 */
	dirty?: boolean;
	/** 画布显示的版本（编辑起点）。 */
	baseVersion?: number;
}

const row = (
	key: CheckRow["key"],
	problems: PreflightProblem[],
	okTitle: string,
	blockedTitle: string,
	detail?: string,
): CheckRow =>
	problems.length > 0
		? { key, state: "blocked", title: blockedTitle, problems }
		: { key, state: "ok", title: okTitle, problems, ...(detail ? { detail } : {}) };

/** 抽屉里当前的选择：选中的运行预设（没选是 null）。 */
export interface Selection {
	presetId: string | null;
}

/**
 * 默认值、运行预设的警告说的那一组值，是不是现在选的：没选预设是默认值，选了预设是这个预设；
 * 选的预设没有改变 secret 值（`preset_ids`）时用的也是默认值，默认值的那一条同样适用。
 */
const matchesSelection = (problem: PreflightProblem, selection: Selection): boolean => {
	const { origin } = problem;
	if (selection.presetId === null) return origin?.kind === "defaults";
	if (origin?.kind === "preset") return origin.preset_id === selection.presetId;
	return origin?.kind === "defaults" && origin.preset_ids.includes(selection.presetId);
};

export function preflightChecks(
	preflight: Preflight,
	local: LocalState = {},
	selection: Selection = { presetId: null },
): { rows: CheckRow[]; blocked: boolean } {
	const { problems } = preflight;
	const fatal = problems.filter((p) => VERSION_CODES.has(p.code));
	if (fatal.length > 0) {
		return {
			blocked: true,
			rows: fatal.map((p) => ({
				key: "version",
				state: "blocked",
				title: p.message,
				problems: [],
			})),
		};
	}

	const rows: CheckRow[] = [];
	const stale: PreflightProblem[] = [];
	if (local.dirty) {
		stale.push({ code: "unsaved_draft", message: "画布上有未保存的修改，请先保存。" });
	}
	if (local.baseVersion !== undefined && local.baseVersion !== preflight.version) {
		stale.push({
			code: "stale_version",
			message: `最新版本是 v${preflight.version}，画布显示的是 v${local.baseVersion}（别人保存了新版本），刷新页面看过后再触发。`,
		});
	}
	if (stale.length > 0) {
		rows.push({
			key: "version",
			state: "blocked",
			title: "触发只会运行已保存的最新版本",
			problems: stale,
		});
	}

	const structure = problems.filter(
		(p) => !PACKAGE_CODES.has(p.code) && !AGENT_CODES.has(p.code) && p.code !== SECRET_SIZE_CODE,
	);
	rows.push(
		row("structure", structure, "结构与引用检查通过", `结构与引用有 ${structure.length} 个问题`),
	);

	const packages = problems.filter((p) => PACKAGE_CODES.has(p.code));
	const locked = Object.entries(preflight.packages);
	rows.push(
		row(
			"packages",
			packages,
			locked.length > 0 ? "节点包版本已锁定" : "没有用到节点包",
			`节点包版本有 ${packages.length} 个问题`,
			locked.map(([name, version]) => `${name} ${version}`).join(" · ") || undefined,
		),
	);

	const agentProblems = problems.filter((p) => AGENT_CODES.has(p.code));
	const offline = preflight.agents.filter((a) => a.status === "offline");
	const preparing = preflight.agents.filter((a) => a.preparing_since !== null);
	if (agentProblems.length === 0 && (offline.length > 0 || preparing.length > 0)) {
		if (offline.length > 0) {
			rows.push({
				key: "agents",
				state: "warn",
				title: `${offline.map((a) => a.name).join("、")} 当前不在线`,
				detail: "任务会排队，Agent 上线后再执行",
				problems: [],
			});
		}
		if (preparing.length > 0) {
			rows.push({
				key: "agents",
				state: "warn",
				title: `${preparing.map((a) => a.name).join("、")} 正在准备环境`,
				detail: "任务会等它准备好再执行",
				problems: [],
			});
		}
	} else {
		rows.push(
			row(
				"agents",
				agentProblems,
				preflight.agents.length > 0 ? "引用的 Agent 都在线" : "没有引用 Agent",
				`Agent 有 ${agentProblems.length} 个问题`,
				preflight.agents.map((a) => a.name).join(" · ") || undefined,
			),
		);
	}
	// secret 参数的值合计太大：触发时改不了的（要改场景）是阻断项；默认值、预设的警告只列现在选的那一组。
	const fixedTooLarge = problems.filter((p) => p.code === SECRET_SIZE_CODE);
	if (fixedTooLarge.length > 0) {
		rows.push({
			key: "secret-size",
			state: "blocked",
			title: "secret 参数的值太多或太长，怎么触发都会被拒绝（要改场景）",
			problems: fixedTooLarge,
		});
	} else {
		const selected = preflight.warnings.find(
			(w) => w.code === SECRET_SIZE_CODE && matchesSelection(w, selection),
		);
		if (selected) {
			const preset = preflight.presets.find((p) => p.id === selection.presetId);
			rows.push({
				key: "secret-size",
				state: "warn",
				title: !preset
					? "照默认值触发会被拒绝：secret 参数的默认值太多或太长"
					: selected.origin?.kind === "defaults"
						? `用运行预设「${preset.name}」触发会被拒绝：它没有改 secret 参数，用的是太多或太长的默认值`
						: `用运行预设「${preset.name}」触发会被拒绝：secret 参数的值太多或太长`,
				problems: [selected],
			});
		}
	}
	const warnings = preflight.warnings.filter((w) => w.code !== SECRET_SIZE_CODE);
	if (warnings.length > 0) {
		rows.push({
			key: "warnings",
			state: "warn",
			title: `有 ${warnings.length} 处配置值得留意，不阻止触发`,
			problems: warnings,
		});
	}
	return { rows, blocked: rows.some((r) => r.state === "blocked") };
}
