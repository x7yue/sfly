import type { SessionEvent } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	addResult,
	addResults,
	commitStat,
	emptyResults,
	hasResults,
	shortCommit,
} from "./results";
import { applyEvent, emptyTimeline, initialTimeline, prependHistory } from "./timeline";

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
		expect(commitStat(event.files)).toEqual({ files: 3, additions: 13, deletions: 3 });
		expect(commitStat([])).toEqual({ files: 0, additions: 0, deletions: 0 });
		expect(shortCommit(event.hash)).toBe("3f1c2ab");
	});
});

describe("时间线上的平台记录：运行和场景版本各一行", () => {
	it("run、scenario_version 各一行，带事件的序号、轮次和名字；commit 不在这里渲染（#546）", () => {
		const state = [version(3, 2, 1), run(4, RUN, 1), commit(5)].reduce(
			applyEvent,
			emptyTimeline("running"),
		);
		expect(state.items).toEqual([
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
		// 提交事件不渲染，但序号照常推进（重连时从它之后接）。
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
