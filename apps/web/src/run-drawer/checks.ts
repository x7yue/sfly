import type { EndpointResponse, PreflightProblem, runsApi } from "@sfly/schema";

/**
 * 运行抽屉的触发前检查清单（纯逻辑，有单测）：把预检结果（GET /orchestrations/:id/preflight）整理成
 * 「结构与引用」「包版本锁定」「Agent 是否在线」几行；有阻断项的行不能触发，Agent 不在线只提醒（任务会排队）。
 * 场景还没有版本、已归档时只列这一条原因；从画布打开时另外检查本地未保存的修改与画布版本是否最新。
 */

export type Preflight = EndpointResponse<typeof runsApi.preflight>;

export type CheckState = "ok" | "warn" | "blocked";

export interface CheckRow {
	key: "version" | "structure" | "packages" | "agents";
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
]);
const AGENT_CODES = new Set([
	"agent_not_registered",
	"agent_input_not_registered",
	"sdk_version_unsatisfied",
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

export function preflightChecks(
	preflight: Preflight,
	local: LocalState = {},
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

	const structure = problems.filter((p) => !PACKAGE_CODES.has(p.code) && !AGENT_CODES.has(p.code));
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
	if (agentProblems.length === 0 && offline.length > 0) {
		rows.push({
			key: "agents",
			state: "warn",
			title: `${offline.map((a) => a.name).join("、")} 当前不在线`,
			detail: "任务会排队，Agent 上线后再执行",
			problems: [],
		});
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
	return { rows, blocked: rows.some((r) => r.state === "blocked") };
}
