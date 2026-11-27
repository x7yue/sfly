import type { SessionDetailResponse, SessionEvent } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	addResult,
	addResults,
	emptyResults,
	hasResults,
	newestFirst,
	resultScenarios,
	versionsSearch,
} from "./results";
import { commitTotals, shortHash } from "./session-text";
import { applyEvent, emptyTimeline, initialTimeline, prependHistory } from "./timeline";
import { initialSession, reduceSession } from "./use-session-timeline";

// 会话页右侧的「成果」和时间线上的两行平台记录（#547）：都只由 `platform` 事件生成。助手在对话里说的不进来：模型说「运行成功了」但没有真的
// 触发，成果里没有这次运行，时间线上也没有。事件的样子取自 `@sfly/schema` 的 `PlatformEvent`（提交的形状是 #546 定的，这里用固定的事件）。

const SCENARIO = "6a1e4f3c-9b7d-4e58-a2c1-5d0f8e7b3a96";
const RUN = "e5b8a0d2-4c36-4f19-8b7a-1d2c3e4f5a6b";
const RUN_2 = "0f3a9c1e-7d52-4b86-9e0a-3c4d5e6f7a81";
let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

const commit = (seq: number, turn = 1, hash = "3f1c2ab9d0e4a5b6c7d8"): SessionEvent => ({
	type: "platform",
	kind: "commit",
	seq,
	at: at(),
	turn,
	hash,
	files: [
		{ path: "nodes/http_check.py", additions: 12, deletions: 3 },
		{ path: "assets/logo.png", additions: null, deletions: null },
		{ path: "README.md", additions: 1, deletions: 0 },
	],
	diff: "diff --git a/nodes/http_check.py b/nodes/http_check.py\n",
	truncated: false,
});
const version = (seq: number, number: number, turn = 1): SessionEvent => ({
	type: "platform",
	kind: "scenario_version",
	seq,
	at: at(),
	turn,
	scenario_id: SCENARIO,
	name: "接口巡检",
	version: number,
});
const run = (seq: number, runId = RUN, turn = 1): SessionEvent => ({
	type: "platform",
	kind: "run",
	seq,
	at: at(),
	turn,
	run_id: runId,
	scenario_name: "接口巡检",
});
const said = (seq: number, text: string): SessionEvent => ({
	type: "assistant_message",
	seq,
	at: at(),
	text,
	usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
});

describe("成果：只从 platform 事件生成", () => {
	it("提交、场景版本、运行各进自己的清单，每一项带事件的序号和轮次", () => {
		const results = addResults(emptyResults, [commit(3, 1), version(4, 3), run(5, RUN, 2)]);
		expect(results.commits).toEqual([
			{
				seq: 3,
				turn: 1,
				hash: "3f1c2ab9d0e4a5b6c7d8",
				files: expect.any(Array),
				diff: expect.stringContaining("http_check"),
				truncated: false,
			},
		]);
		expect(results.versions).toEqual([
			{ seq: 4, turn: 1, scenarioId: SCENARIO, name: "接口巡检", version: 3 },
		]);
		expect(results.runs).toEqual([{ seq: 5, turn: 2, runId: RUN, scenarioName: "接口巡检" }]);
		expect(hasResults(results)).toBe(true);
	});

	it("助手在对话里说「运行成功了」但没有触发：成果里没有运行（只有 platform 事件算）", () => {
		const results = addResults(emptyResults, [
			said(3, "运行成功了，场景已经保存为版本 3，提交是 3f1c2ab。"),
		]);
		expect(results).toEqual(emptyResults);
		expect(hasResults(results)).toBe(false);
	});

	it("真的触发了：有；同一个序号来两次（历史和事件流重叠）只算一次；先后不影响结果，清单按序号升序", () => {
		const forward = addResults(emptyResults, [run(5), run(5), run(7, RUN_2)]);
		expect(forward.runs.map((r) => [r.seq, r.runId])).toEqual([
			[5, RUN],
			[7, RUN_2],
		]);
		// 往前翻页读到更早的：插在前面。
		const older = addResult(forward, run(2, RUN_2));
		expect(older.runs.map((r) => r.seq)).toEqual([2, 5, 7]);
		// 没有变化时返回同一个对象（页面不为它重新渲染）。
		expect(addResult(older, run(5))).toBe(older);
		expect(addResult(older, said(9, "好"))).toBe(older);
	});

	it("提交的统计：改了几个文件、增删的行数（二进制文件没有行数，不算在行数里，但算一个文件）；提交号前 7 位", () => {
		const event = commit(3) as Extract<SessionEvent, { kind: "commit" }>;
		expect(commitTotals(event.files)).toEqual({ files: 3, additions: 13, deletions: 3 });
		expect(commitTotals([])).toEqual({ files: 0, additions: 0, deletions: 0 });
		expect(shortHash(event.hash)).toBe("3f1c2ab");
	});
});

describe("时间线上的平台记录：运行和场景版本各一行", () => {
	it("run、scenario_version 各一行，带事件的序号、轮次和名字；commit 是另一种行（#546）", () => {
		const state = [version(3, 2, 1), run(4, RUN, 1), commit(5)].reduce(
			applyEvent,
			emptyTimeline("running"),
		);
		// 提交（#546）是另一种行（`CommitRow`）：在前面这两行后面，不影响它们。
		expect(state.items.map((i) => i.kind)).toEqual(["version", "run", "commit"]);
		expect(state.items.slice(0, 2)).toEqual([
			{
				kind: "version",
				key: "e3",
				seq: 3,
				at: expect.any(String),
				turn: 1,
				scenarioId: SCENARIO,
				name: "接口巡检",
				version: 2,
			},
			{
				kind: "run",
				key: "e4",
				seq: 4,
				at: expect.any(String),
				turn: 1,
				runId: RUN,
				scenarioName: "接口巡检",
			},
		]);
		// 提交事件是另一种行（`CommitRow`），序号照常推进（重连时从它之后接）。
		expect(state.lastSeq).toBe(5);
	});

	it("助手说「运行成功了」但没有触发：时间线上没有运行那一行；同一个序号来两次只一行", () => {
		const said3 = [said(3, "运行成功了")].reduce(applyEvent, emptyTimeline("running"));
		expect(said3.items.map((i) => i.kind)).toEqual(["assistant"]);
		const twice = [run(4), run(4)].reduce(applyEvent, emptyTimeline("running"));
		expect(twice.items.filter((i) => i.kind === "run")).toHaveLength(1);
	});

	it("读到的历史里也有（打开页面、往前翻页），和事件流推来的一样", () => {
		const opened = initialTimeline("idle", [run(6, RUN_2), version(7, 3)], true);
		expect(opened.items.map((i) => i.kind)).toEqual(["run", "version"]);
		const older = prependHistory(opened, [version(2, 1), run(3)], false);
		expect(older.items.map((i) => [i.kind, "seq" in i ? i.seq : null])).toEqual([
			["version", 2],
			["run", 3],
			["run", 6],
			["version", 7],
		]);
	});
});

// 页面上的状态（`use-session-timeline.ts`）把三条路读到的事件各算一遍时间线和成果：打开页面时读到的历史、事件流推来的、往前翻页读到的。
// 哪一条路漏了成果，页面上那一类运行或提交就在那条路上不出现（时间线上的行还在，不会被别的测试发现）。
describe("页面上的状态：历史、事件流、往前翻页三条路都进成果和时间线", () => {
	const detail = (events: SessionEvent[], hasMore = false): SessionDetailResponse =>
		({
			id: "00000000-0000-4000-8000-0000000000aa",
			status: "idle",
			has_more: hasMore,
			queue_position: null,
			waiting_for: null,
			events,
		}) as unknown as SessionDetailResponse;
	const runsOf = (state: ReturnType<typeof initialSession>) => state.results.runs.map((r) => r.seq);
	const rowsOf = (state: ReturnType<typeof initialSession>) =>
		state.timeline.items.filter((i) => i.kind === "run" || i.kind === "version").map((i) => i.kind);

	it("打开页面时读到的最近一页历史里的运行、版本、提交", () => {
		const state = initialSession(detail([run(5, RUN), version(6, 2), commit(7)], true));
		expect(runsOf(state)).toEqual([5]);
		expect(state.results.versions.map((v) => v.seq)).toEqual([6]);
		expect(state.results.commits.map((c) => c.seq)).toEqual([7]);
		expect(rowsOf(state)).toEqual(["run", "version"]);
	});

	it("事件流推来的（打开页面之后）：进成果，也进时间线；同一个序号再来一次（重连补发）不重复", () => {
		const opened = initialSession(detail([said(2, "好")]));
		const pushed = reduceSession(opened, { type: "event", event: run(5, RUN) });
		expect(runsOf(pushed)).toEqual([5]);
		expect(rowsOf(pushed)).toEqual(["run"]);
		const again = reduceSession(pushed, { type: "event", event: run(5, RUN) });
		expect(runsOf(again)).toEqual([5]);
		expect(rowsOf(again)).toEqual(["run"]);
		const more = reduceSession(again, { type: "event", event: version(6, 2) });
		expect(more.results.versions.map((v) => v.seq)).toEqual([6]);
	});

	it("往前翻页读到的更早的事件：进成果，序号排在已有的前面；还有更早的由 has_more 说", () => {
		const opened = initialSession(detail([run(8, RUN_2)], true));
		expect(opened.timeline.hasMore).toBe(true);
		const older = reduceSession(opened, {
			type: "older",
			events: [run(3, RUN), version(4, 1), commit(5)],
			hasMore: false,
		});
		expect(runsOf(older)).toEqual([3, 8]);
		expect(older.results.versions.map((v) => v.seq)).toEqual([4]);
		expect(older.results.commits.map((c) => c.seq)).toEqual([5]);
		expect(older.timeline.hasMore).toBe(false);
	});

	it("助手的话三条路都不进成果；排队视图的更新不改成果", () => {
		const opened = initialSession(detail([said(2, "运行成功了")]));
		const pushed = reduceSession(opened, { type: "event", event: said(3, "场景已经保存") });
		const older = reduceSession(pushed, { type: "older", events: [said(1, "好")], hasMore: false });
		expect(older.results).toEqual(emptyResults);
		const queued = reduceSession(older, {
			type: "queued",
			queue: { position: 1, waitingFor: null },
			after: 3,
		});
		expect(queued.results).toBe(older.results);
	});
});

// 成果栏的三块都是「最近的在前」，场景版本按场景合并（#551）：一个场景这个会话保存过几个版本，列在同一项里，链到版本历史对比。
describe("成果栏：最近的在前；场景版本按场景合并", () => {
	const SCENARIO_2 = "2b7c5d8e-1a4f-4c63-8d90-7e6f5a4b3c21";
	const versionOf = (
		seq: number,
		scenario: string,
		name: string,
		number: number,
	): SessionEvent => ({
		type: "platform",
		kind: "scenario_version",
		seq,
		at: at(),
		turn: 1,
		scenario_id: scenario,
		name,
		version: number,
	});

	it("newestFirst：按事件序号从大到小，不改原来的清单", () => {
		const results = addResults(emptyResults, [run(5, RUN), run(9, RUN_2), run(7, RUN)]);
		expect(newestFirst(results.runs).map((r) => r.seq)).toEqual([9, 7, 5]);
		expect(results.runs.map((r) => r.seq)).toEqual([5, 7, 9]);
	});

	it("同一个场景保存过几个版本：一项，版本号从小到大列出；场景之间最近保存的在前", () => {
		const results = addResults(emptyResults, [
			versionOf(3, SCENARIO, "接口巡检", 2),
			versionOf(4, SCENARIO_2, "磁盘巡检", 1),
			versionOf(8, SCENARIO, "接口巡检", 3),
			versionOf(6, SCENARIO, "接口巡检", 5),
		]);
		expect(resultScenarios(results)).toEqual([
			{ scenarioId: SCENARIO, name: "接口巡检", versions: [2, 3, 5], lastSeq: 8 },
			{ scenarioId: SCENARIO_2, name: "磁盘巡检", versions: [1], lastSeq: 4 },
		]);
	});

	it("场景名取最近一次保存时的（场景中途改过名）；没有保存过版本时没有这一块", () => {
		const renamed = addResults(emptyResults, [
			versionOf(3, SCENARIO, "旧名字", 1),
			versionOf(5, SCENARIO, "新名字", 2),
		]);
		expect(resultScenarios(renamed)[0]?.name).toBe("新名字");
		expect(resultScenarios(emptyResults)).toEqual([]);
	});

	it("版本历史里选中哪几个版本：一个版本就选它，几个版本对比最早和最晚的", () => {
		expect(versionsSearch([3])).toEqual({ b: 3 });
		expect(versionsSearch([2, 3, 5])).toEqual({ a: 2, b: 5 });
		expect(versionsSearch([4, 4])).toEqual({ b: 4 });
	});
});
