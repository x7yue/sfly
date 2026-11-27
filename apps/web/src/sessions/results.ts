import type { CommitFile, SessionEvent } from "@sfly/schema";

/**
 * 会话页右侧的「成果」（#547）：这个会话留下了什么。**只由这个会话的 `platform` 事件生成**——工作区的提交（`commit`，#546）、
 * 保存的场景版本（`scenario_version`）、触发的运行（`run`）；助手在对话里说的话不进来：模型说「运行成功了」但没有真的触发，
 * 这里就没有这一次运行。依据是控制面记下的事件（运行和场景版本记着是哪个会话的令牌做的，#616），不是模型怎么说。
 *
 * 和时间线各管各的：时间线要的是一轮一轮的先后（`timeline.ts`），这里要的是三张清单（各按事件序号升序）。同一个会话的事件会来两次
 * （先读最近一页历史、再接事件流，两边可能有重叠；往前翻页读到更早的），按序号去重，来的先后不影响结果。
 */

export interface ResultCommit {
	seq: number;
	/** 这个提交属于第几轮。 */
	turn: number;
	hash: string;
	files: CommitFile[];
	diff: string;
	/** 差异太长，只存了开头。 */
	truncated: boolean;
}

export interface ResultVersion {
	seq: number;
	turn: number;
	scenarioId: string;
	/** 保存那一刻的场景名。 */
	name: string;
	version: number;
}

export interface ResultRun {
	seq: number;
	turn: number;
	runId: string;
	/** 触发那一刻的场景名。 */
	scenarioName: string;
}

export interface SessionResults {
	commits: readonly ResultCommit[];
	versions: readonly ResultVersion[];
	runs: readonly ResultRun[];
}

export const emptyResults: SessionResults = { commits: [], versions: [], runs: [] };

/** 按序号升序放进去；这个序号已经有了就不重复。 */
function insert<T extends { seq: number }>(list: readonly T[], item: T): readonly T[] {
	if (list.some((existing) => existing.seq === item.seq)) return list;
	return [...list, item].sort((a, b) => a.seq - b.seq);
}

/** 一条事件进来：`platform` 的三种各进自己的清单，别的事件原样放过（同一个序号来第二次也不变）。 */
export function addResult(results: SessionResults, event: SessionEvent): SessionResults {
	if (event.type !== "platform") return results;
	switch (event.kind) {
		case "commit": {
			const commits = insert(results.commits, {
				seq: event.seq,
				turn: event.turn,
				hash: event.hash,
				files: event.files,
				diff: event.diff,
				truncated: event.truncated,
			});
			return commits === results.commits ? results : { ...results, commits };
		}
		case "scenario_version": {
			const versions = insert(results.versions, {
				seq: event.seq,
				turn: event.turn,
				scenarioId: event.scenario_id,
				name: event.name,
				version: event.version,
			});
			return versions === results.versions ? results : { ...results, versions };
		}
		case "run": {
			const runs = insert(results.runs, {
				seq: event.seq,
				turn: event.turn,
				runId: event.run_id,
				scenarioName: event.scenario_name,
			});
			return runs === results.runs ? results : { ...results, runs };
		}
	}
}

/** 一段事件（读到的一页历史）里的成果，接在已有的后面（去重）。 */
export function addResults(
	results: SessionResults,
	events: readonly SessionEvent[],
): SessionResults {
	return events.reduce(addResult, results);
}

/** 有没有任何成果。 */
export const hasResults = (results: SessionResults): boolean =>
	results.commits.length + results.versions.length + results.runs.length > 0;

/** 清单里最近的在前（成果栏每一块都是这个顺序）：按事件序号从大到小，不改原来的清单。 */
export const newestFirst = <T extends { seq: number }>(list: readonly T[]): T[] =>
	[...list].sort((a, b) => b.seq - a.seq);

/** 场景那一块的一项：一个场景，这个会话保存过的版本。 */
export interface ResultScenario {
	scenarioId: string;
	/** 最近一次保存时的场景名（场景中途改过名的取最新的）。 */
	name: string;
	/** 这个会话保存过的版本号，从小到大，不重复。 */
	versions: readonly number[];
	/** 最近一次保存的事件序号：场景之间按它排，最近的在前。 */
	lastSeq: number;
}

/** 场景那一块：版本按场景合并（一个场景保存过几个版本只是一项），最近保存的场景在前。 */
export function resultScenarios(results: SessionResults): ResultScenario[] {
	const byScenario = new Map<string, ResultScenario>();
	for (const version of results.versions) {
		const known = byScenario.get(version.scenarioId);
		if (known === undefined) {
			byScenario.set(version.scenarioId, {
				scenarioId: version.scenarioId,
				name: version.name,
				versions: [version.version],
				lastSeq: version.seq,
			});
			continue;
		}
		if (!known.versions.includes(version.version)) {
			known.versions = [...known.versions, version.version].sort((a, b) => a - b);
		}
		if (version.seq > known.lastSeq) {
			known.name = version.name;
			known.lastSeq = version.seq;
		}
	}
	return [...byScenario.values()].sort((a, b) => b.lastSeq - a.lastSeq);
}

/**
 * 版本历史里选中哪几个版本（版本历史页的 `a`、`b`）：只保存过一个版本就选它（`b`）；保存过几个就对比最早的和最晚的（`a`、`b`）。
 * 这个会话保存过的版本之间别人也可能保存过，所以对比的是「这个会话第一次保存的」和「最近一次保存的」，不是相邻的两个。
 */
export function versionsSearch(versions: readonly number[]): { a?: number; b: number } {
	const first = Math.min(...versions);
	const last = Math.max(...versions);
	return first === last ? { b: last } : { a: first, b: last };
}
