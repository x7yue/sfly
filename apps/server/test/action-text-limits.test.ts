// 动作的名称、字段值、失败原因的长度上限由控制面执行（#583）：SDK 不知道哪些值是 secret，只在比上限多
// `ACTION_LIMITS.transportMargin` 个字符处截断，控制面先把 secret 值打码、再截到上限，所以一个正好跨在上限处的 secret 值
// 整个被换成掩码，不会留下前半截。单元：action-text.ts 的写入函数；HTTP：假 Agent 按 SDK 的样子上报超过上限的文字。
// 值都是明显的假值。
import { ACTION_LIMITS, actionsApi, SECRET_MASK as MASK } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionField, actionName, actionReason } from "../src/actions/action-text.js";
import { secretSetOf } from "../src/logs/secrets.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const { nameChars, valueChars, reasonChars, transportMargin } = ACTION_LIMITS;
const SECRET = "ZEBRA-secret-token-0123456789";
/** secret 值里每一段 4 个字符：任何一段留在输出里都说明值被切成了两半。 */
const FRAGMENTS = Array.from({ length: SECRET.length - 3 }, (_, i) => SECRET.slice(i, i + 4));
const leaks = (text: string) => FRAGMENTS.filter((piece) => text.includes(piece));

describe("名称、字段值、失败原因：先打码再截到上限", () => {
	const set = secretSetOf([SECRET]);

	it("secret 值正好跨在上限处：SDK 发来的整段文字先打码，再截到上限，没有留下前半截", () => {
		const name = `${"n".repeat(nameChars - 10)}${SECRET}`;
		const value = `${"v".repeat(valueChars - 10)}${SECRET}`;
		const reason = `${"r".repeat(reasonChars - 10)}${SECRET}`;

		expect(actionName(name, set)).toBe(`${"n".repeat(nameChars - 10)}${MASK}`.slice(0, nameChars));
		const [key, shown] = actionField(name, value, set);
		expect(key).toBe(actionName(name, set));
		expect(shown).toBe(`${"v".repeat(valueChars - 10)}${MASK}`.slice(0, valueChars));
		const cut = actionReason(reason, set);
		expect(Array.from(cut).length).toBeLessThanOrEqual(reasonChars);
		for (const text of [actionName(name, set), key, shown, cut]) {
			expect(leaks(text), text.slice(-40)).toEqual([]);
		}
	});

	it("SDK 能发来的最长的文字（上限加余量）里的 secret 值同样整个认出来：跨在上限处、跨在余量处之前", () => {
		const name = `${"n".repeat(nameChars + transportMargin - SECRET.length)}${SECRET}`;
		expect(name.length).toBe(nameChars + transportMargin);
		expect(leaks(actionName(name, set))).toEqual([]);
		const value = `${"v".repeat(valueChars - 1)}${SECRET}`;
		expect(leaks(actionField("k", value, set)[1])).toEqual([]);
	});

	it("超过上限的文字照常截断：没有 secret 值时和以前一样，失败原因带「…」", () => {
		const plain = new Set(["x"]);
		expect(plain.size).toBe(1);
		expect(actionName("n".repeat(nameChars + 30), set)).toBe("n".repeat(nameChars));
		expect(actionField("k", "v".repeat(valueChars + 30), set)[1]).toBe("v".repeat(valueChars));
		expect(actionReason("r".repeat(reasonChars + 30), set)).toBe(`${"r".repeat(reasonChars - 1)}…`);
	});
});

describe("假 Agent 按 SDK 的样子上报超过上限的文字", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	it("明细和摘要：名称、字段的键和值、失败原因里跨在上限处的 secret 值整个被打码，接口读出来没有任何一段", async () => {
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "token", type: "string", secret: true }] },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { stub: "1.0.0" },
		});
		await api.triggerOk(id, { token: SECRET });
		const task = await agent.nextAssign();

		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const name = `${"n".repeat(nameChars - 10)}${SECRET}`;
		const key = `${"k".repeat(nameChars - 10)}${SECRET}`;
		const value = `${"v".repeat(valueChars - 10)}${SECRET}`;
		const reason = `${"r".repeat(reasonChars - 10)}${SECRET}`;
		const fields = { [key]: value };
		agent.actions(task, [
			agent.actionStart(1, name, t0 + 1_000, { fields }),
			agent.actionEnd(1, "failed", t0 + 2_000, { reason }),
		]);
		const end = agent.stamp(t0 + 2_000);
		const zero = { reported: 1, capped_ts: null, capped_mono: null, failed: 0 };
		const running = { id: 2, parent: null, depth: 0, name, fields, ...agent.stamp(t0 + 3_000) };
		agent.actionSummary(task, {
			total: 2,
			reported: 2,
			names: [{ name, total: 2, ...zero, failed: 1 }],
			running: [running],
			recent: [
				{
					...running,
					id: 1,
					end_ts: end.ts,
					end_mono: end.mono,
					result: "failed" as const,
					reason,
				},
			],
			recent_failed: [
				{
					...running,
					id: 1,
					end_ts: end.ts,
					end_mono: end.mono,
					result: "failed" as const,
					reason,
				},
			],
		});
		await agent.sync();

		let page = "";
		await eventually(async () => {
			const res = await cp.fetch(`/tasks/${task.taskId}/actions`);
			page = await res.text();
			expect(actionsApi.page.response.parse(JSON.parse(page)).actions.length).toBeGreaterThan(0);
		});
		const summary = await (await cp.fetch(`/tasks/${task.taskId}/actions/summary`)).text();
		for (const [what, body] of [
			["明细", page],
			["摘要", summary],
		] as const) {
			expect(leaks(body), `${what}：不能留下 secret 值的任何一段`).toEqual([]);
			expect(body, what).toContain(MASK);
		}
		const [detail] = actionsApi.page.response.parse(JSON.parse(page)).actions;
		expect(detail?.name).toBe(`${"n".repeat(nameChars - 10)}${MASK}`.slice(0, nameChars));
		const reasonShown = detail?.kind === "action" ? (detail.reason ?? "") : "";
		expect(Array.from(reasonShown).length).toBeLessThanOrEqual(reasonChars);
		expect(reasonShown.length).toBeGreaterThan(0);
	});
});
