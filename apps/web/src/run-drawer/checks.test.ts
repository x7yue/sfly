import { describe, expect, it } from "vitest";
import { type Preflight, preflightChecks } from "./checks";

const passed: Preflight = {
	version: 3,
	params: [],
	problems: [],
	packages: { "demo-checks": "1.2.0", stub: "0.1.0" },
	agents: [
		{ name: "agent-a", default: true, status: "online", preparing_since: null },
		{ name: "agent-b", default: false, status: "online", preparing_since: null },
	],
};

const summary = (p: Preflight, local?: Parameters<typeof preflightChecks>[1]) =>
	preflightChecks(p, local).rows.map((r) => [r.key, r.state, r.title, r.detail]);

describe("触发前检查清单", () => {
	it("全部通过：结构与引用、包版本锁定、Agent 在线各一行", () => {
		const checks = preflightChecks(passed);
		expect(checks.blocked).toBe(false);
		expect(summary(passed)).toEqual([
			["structure", "ok", "结构与引用检查通过", undefined],
			["packages", "ok", "节点包版本已锁定", "demo-checks 1.2.0 · stub 0.1.0"],
			["agents", "ok", "引用的 Agent 都在线", "agent-a · agent-b"],
		]);
	});

	it("Agent 不在线只是提醒（任务会排队），不阻止触发", () => {
		const p: Preflight = {
			...passed,
			agents: [
				{ name: "agent-a", default: true, status: "offline", preparing_since: null },
				{ name: "agent-b", default: false, status: "online", preparing_since: null },
			],
		};
		expect(preflightChecks(p).blocked).toBe(false);
		expect(summary(p)[2]).toEqual([
			"agents",
			"warn",
			"agent-a 当前不在线",
			"任务会排队，Agent 上线后再执行",
		]);
	});

	it("Agent 在准备环境只是提醒（任务会等它准备好），不阻止触发；同时有不在线的 Agent 时两条都给", () => {
		const preparing: Preflight = {
			...passed,
			agents: [
				{
					name: "agent-a",
					default: true,
					status: "online",
					preparing_since: "2026-01-01T00:00:00Z",
				},
				{ name: "agent-b", default: false, status: "online", preparing_since: null },
			],
		};
		expect(preflightChecks(preparing).blocked).toBe(false);
		expect(summary(preparing).slice(2)).toEqual([
			["agents", "warn", "agent-a 正在准备环境", "任务会等它准备好再执行"],
		]);

		const both: Preflight = {
			...passed,
			agents: [
				{
					name: "agent-a",
					default: true,
					status: "online",
					preparing_since: "2026-01-01T00:00:00Z",
				},
				{ name: "agent-b", default: false, status: "offline", preparing_since: null },
			],
		};
		expect(preflightChecks(both).blocked).toBe(false);
		expect(summary(both).slice(2)).toEqual([
			["agents", "warn", "agent-b 当前不在线", "任务会排队，Agent 上线后再执行"],
			["agents", "warn", "agent-a 正在准备环境", "任务会等它准备好再执行"],
		]);
	});

	it("问题按类别归到对应的行，任何一行有问题都不能触发", () => {
		const p: Preflight = {
			...passed,
			problems: [
				{ code: "orphan_node", message: "节点 lonely 不在任何链上", node_id: "lonely" },
				{ code: "package_version_missing", message: "stub 0.1.0 不存在", node_id: "c" },
				{ code: "agent_not_registered", message: "Agent ghost 还没有注册过", node_id: "b" },
				{ code: "not_supported", message: "只支持一条主链" },
			],
			agents: [{ name: "ghost", default: true, status: "unknown", preparing_since: null }],
		};
		const checks = preflightChecks(p);
		expect(checks.blocked).toBe(true);
		expect(checks.rows.map((r) => [r.key, r.state, r.problems.map((x) => x.code)])).toEqual([
			["structure", "blocked", ["orphan_node", "not_supported"]],
			["packages", "blocked", ["package_version_missing"]],
			["agents", "blocked", ["agent_not_registered"]],
		]);
		expect(checks.rows.map((r) => r.title)).toEqual([
			"结构与引用有 2 个问题",
			"节点包版本有 1 个问题",
			"Agent 有 1 个问题",
		]);
	});

	it("「Agent」类型的输入选的 Agent 没有注册过时归到 Agent 一行，不能触发", () => {
		const p: Preflight = {
			...passed,
			problems: [
				{
					code: "agent_input_not_registered",
					message: "节点 c 的输入 source 选择的 Agent ghost 还没有注册过",
					node_id: "c",
				},
			],
		};
		const checks = preflightChecks(p);
		expect(checks.blocked).toBe(true);
		expect(checks.rows.find((r) => r.key === "agents")?.problems.map((x) => x.node_id)).toEqual([
			"c",
		]);
	});

	it("控制面版本（即 Agent 执行时的版本）不满足节点包需要的 SDK 版本时归到 Agent 一行，不能触发", () => {
		const p: Preflight = {
			...passed,
			problems: [
				{
					code: "sdk_version_unsatisfied",
					message:
						"节点 a：节点包 sfly-std@0.2.0 需要 SDK >=0.0.5，控制面的版本是 0.0.4：Agent 会先自更新到控制面的版本再执行任务，请升级控制面",
					node_id: "a",
				},
			],
		};
		const checks = preflightChecks(p);
		expect(checks.blocked).toBe(true);
		expect(checks.rows.find((r) => r.state === "blocked")?.key).toBe("agents");
	});

	it("Agent 版本不满足节点包需要的 Agent 版本时归到 Agent 一行，不能触发", () => {
		const p: Preflight = {
			...passed,
			problems: [
				{
					code: "agent_version_unsatisfied",
					message:
						"节点 c：节点包 logs@1.0.0 需要 Agent >=0.2.0，参数 source 选的 Agent a-01 的版本是 0.1.3：请升级 Agent a-01",
					node_id: "c",
				},
			],
		};
		const checks = preflightChecks(p);
		expect(checks.blocked).toBe(true);
		expect(checks.rows.map((r) => [r.key, r.state])).toEqual([
			["structure", "ok"],
			["packages", "ok"],
			["agents", "blocked"],
		]);
		expect(checks.rows.find((r) => r.key === "agents")?.problems.map((x) => x.node_id)).toEqual([
			"c",
		]);
	});

	it("场景还没有版本或已归档时只列出这一条原因", () => {
		const p: Preflight = {
			version: 0,
			params: [],
			problems: [{ code: "no_version", message: "场景还没有保存过版本" }],
			packages: {},
			agents: [],
		};
		expect(summary(p)).toEqual([["version", "blocked", "场景还没有保存过版本", undefined]]);
	});

	it("画布上有未保存的修改或显示的不是最新版本时，额外列出版本一行", () => {
		const checks = preflightChecks(passed, { dirty: true, baseVersion: 2 });
		expect(checks.blocked).toBe(true);
		expect(checks.rows[0]).toMatchObject({
			key: "version",
			state: "blocked",
			title: "触发只会运行已保存的最新版本",
		});
		expect(checks.rows[0]?.problems.map((p) => p.code)).toEqual(["unsaved_draft", "stale_version"]);
		expect(checks.rows).toHaveLength(4);
	});

	it("没有用到节点包、没有引用 Agent 时也说明", () => {
		const p: Preflight = { ...passed, packages: {}, agents: [] };
		expect(summary(p).slice(1)).toEqual([
			["packages", "ok", "没有用到节点包", undefined],
			["agents", "ok", "没有引用 Agent", undefined],
		]);
	});
});
