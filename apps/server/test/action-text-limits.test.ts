// 动作的名称、字段值、失败原因的长度上限由控制面执行（#583）：SDK 不知道哪些值是 secret，只在比上限多
// `ACTION_LIMITS.transportMargin` 个字符处截断（传输的保护）。上限说的是**原文的位置**：控制面只取原文的前 N 个字符，起点在 N 之前的
// 完整出现照常换成掩码，跨在 N 上的整个换成一个掩码，N 之后的不输出，再把输出截到 N 个字符；不按打码之后的长度截。
// 单元：action-text.ts 的写入函数（含随机的对照）；HTTP：假 Agent 按 SDK 的样子上报超过上限的文字。值都是明显的假值。
import { ACTION_LIMITS, actionsApi, SECRET_MASK as MASK, runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionField, actionName, actionReason } from "../src/actions/action-text.js";
import { NO_SECRETS, secretSetOf } from "../src/logs/secrets.js";
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

	it("超过上限的文字照常截断：文字里没有 secret 值时和以前一样，失败原因带「…」", () => {
		expect(actionName("n".repeat(nameChars + 30), set)).toBe("n".repeat(nameChars));
		expect(actionField("k", "v".repeat(valueChars + 30), set)[1]).toBe("v".repeat(valueChars));
		expect(actionReason("r".repeat(reasonChars + 30), set)).toBe(`${"r".repeat(reasonChars - 1)}…`);
		// 没有任何 secret 值的运行：同样
		expect(actionName("n".repeat(nameChars + 30), NO_SECRETS)).toBe("n".repeat(nameChars));
		expect(actionReason("r".repeat(reasonChars + 30), NO_SECRETS)).toBe(
			`${"r".repeat(reasonChars - 1)}…`,
		);
		expect(actionName("短名称", NO_SECRETS)).toBe("短名称");
	});
});

/** 假值：随机的、不会碰巧出现在别的文字里（只用来测，没有任何含义）。 */
let seed = 583;
const rand = (n: number): number => {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed % n;
};
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const fakeValue = (n: number): string =>
	Array.from({ length: n }, () => ALPHABET[rand(32)]).join("");
/** 6 个字符以上的任何一段留在输出里都说明值被切成了两半。 */
const pieces = (value: string, n = 6) =>
	Array.from({ length: value.length - n + 1 }, (_, i) => value.slice(i, i + n));

describe("上限按原文的位置算：打码让文字变短，不会把原文上限之后的内容拉进上限以内", () => {
	const BIG = fakeValue(4096);
	const SMALL = fakeValue(40);
	const set = secretSetOf([BIG, SMALL]);
	const leaksOf = (text: string) => pieces(SMALL).filter((piece) => text.includes(piece));
	/** SDK 发出的样子：BIG 在开头，SMALL 跨在传输上限（上限加余量）处，只剩前 20 个字符。 */
	const sent = (limit: number, fill: string) =>
		`${BIG}${fill.repeat(limit + transportMargin - BIG.length - 20)}${SMALL.slice(0, 20)}`;

	it("名称、字段的键和值：SDK 在传输上限处留下的另一个值的前半截，不会出现在存下的文字里", () => {
		const name = sent(nameChars, "n");
		const value = sent(valueChars, "v");
		expect(Array.from(name).length).toBe(nameChars + transportMargin);
		expect(Array.from(value).length).toBe(valueChars + transportMargin);
		const [key, shown] = actionField(name, value, set);
		for (const text of [actionName(name, set), key, shown]) {
			expect(leaksOf(text)).toEqual([]);
		}
		// 原文的前 N 个字符就在 BIG 里面（BIG 起点在 N 之前、终点在 N 之后）：整个换成一个掩码
		expect(actionName(name, set)).toBe(MASK);
		expect(shown).toBe(MASK);
	});

	it("失败原因：同样；SDK 截断时留下的「…」也在传输上限之后，不会进来", () => {
		const cut = `${BIG}${"r".repeat(reasonChars + transportMargin - 1 - BIG.length - 20)}${SMALL.slice(0, 20)}…`;
		expect(Array.from(cut).length).toBe(reasonChars + transportMargin);
		const shown = actionReason(cut, set);
		expect(leaksOf(shown)).toEqual([]);
		expect(Array.from(shown).length).toBeLessThanOrEqual(reasonChars);
		expect(shown).toBe(`${MASK}…`);
	});

	it("值本身不长（不超过余量的一小段）、前面有很多个：每个换成掩码让文字变短很多，上限之后的内容也不会进来", () => {
		const value = fakeValue(300);
		const small = fakeValue(40);
		const many = secretSetOf([value, small]);
		// 原文：很多个 value 夹着填充（共 12 个，每个换成六个字符的掩码，文字缩短 12 × 294），然后跨在传输上限处的 small 的前 20 个字符
		let text = "";
		while (text.length < valueChars + transportMargin - 20) text += `${value}ab`;
		text = `${text.slice(0, valueChars + transportMargin - 20)}${small.slice(0, 20)}`;
		const shown = actionField("k", text, many)[1];
		expect(pieces(small).filter((piece) => shown.includes(piece))).toEqual([]);
		expect(Array.from(shown).length).toBeLessThanOrEqual(valueChars);
	});

	it("secret 值比掩码短（1 到 5 个字符）且很多个：输出不超过上限，也只取原文的前 N 个字符", () => {
		const short = secretSetOf(["a", "bc", "def"]);
		// 每个字符都是一个值：掩码比原文长，输出被截到上限
		const text = "a".repeat(valueChars + transportMargin);
		const shown = actionField("k", text, short)[1];
		expect(Array.from(shown).length).toBe(valueChars);
		expect(shown).toBe(MASK.repeat(Math.ceil(valueChars / MASK.length)).slice(0, valueChars));
		// 原文的前 N 个字符之后的内容不输出：N 之后是另一个值也一样
		const tail = `${"x".repeat(valueChars)}bcbcbc`;
		expect(actionField("k", tail, short)[1]).toBe("x".repeat(valueChars));
	});

	it("跨在上限上的完整出现整个换成一个掩码，上限之前的完整出现照常，上限之后的不输出；多字节字符按字符算", () => {
		const value = "SECRETVALUE-0123456789";
		const one = secretSetOf([value]);
		// 上限 64：起点在第 60 个字符、终点在第 82 个字符：换成一个掩码（60 + 6 个字符，再截到 64 个字符）
		const crossing = `${"n".repeat(60)}${value}${"m".repeat(30)}`;
		expect(actionName(crossing, one)).toBe(`${"n".repeat(60)}${MASK}`.slice(0, nameChars));
		// 起点正好在上限处：不输出，也没有掩码
		const atLimit = `${"n".repeat(nameChars)}${value}`;
		expect(actionName(atLimit, one)).toBe("n".repeat(nameChars));
		// 终点正好在上限处：整个换成掩码
		const endsAtLimit = `${"n".repeat(nameChars - value.length)}${value}${"m".repeat(10)}`;
		expect(actionName(endsAtLimit, one)).toBe(`${"n".repeat(nameChars - value.length)}${MASK}`);
		// 多字节字符（汉字、辅助平面）：上限按字符算
		const wide = `${"中".repeat(nameChars - 2)}😀😀${value}`;
		expect(actionName(wide, one)).toBe(`${"中".repeat(nameChars - 2)}😀😀`);
		const widePartial = `${"中".repeat(nameChars - 3)}😀😀${value}`;
		expect(actionName(widePartial, one)).toBe(
			Array.from(`${"中".repeat(nameChars - 3)}😀😀${MASK}`)
				.slice(0, nameChars)
				.join(""),
		);
	});

	it("失败原因超不超过上限按原文算（和 SDK 一样），不按打码之后的长度算：原文超过时带「…」", () => {
		const value = "S".repeat(300);
		const one = secretSetOf([value]);
		// 原文比上限长 200 个字符，打码之后（300 个字符换成 6 个）比上限短：照样是「超过上限」
		const reason = `${"r".repeat(reasonChars - 100)}${value}`;
		expect(Array.from(reason).length).toBeGreaterThan(reasonChars);
		expect(actionReason(reason, one)).toBe(`${"r".repeat(reasonChars - 100)}${MASK}…`);
		// 原文不超过上限：不带「…」
		const fits = `${"r".repeat(reasonChars - 400)}${value}`;
		expect(actionReason(fits, one)).toBe(`${"r".repeat(reasonChars - 400)}${MASK}`);
		// 辅助平面的字符（UTF-16 里两个码元）：上限按字符算，不切开
		const emoji = "😀".repeat(reasonChars + 10);
		expect(actionReason(emoji, NO_SECRETS)).toBe(`${"😀".repeat(reasonChars - 1)}…`);
		expect(actionName("😀".repeat(nameChars + 5), one)).toBe("😀".repeat(nameChars));
		expect(actionField("k", "😀".repeat(valueChars + 5), one)[1]).toBe("😀".repeat(valueChars));
	});

	it("输出从不超过上限：值集合太大（整段盖住）、上限比掩码还短时也一样", () => {
		const huge = secretSetOf([fakeValue(2_000_000)]);
		expect(huge.maskClipped("anything", 3)).toBe(MASK.slice(0, 3));
		expect(huge.maskClipped("anything", nameChars)).toBe(MASK);
		expect(NO_SECRETS.maskClipped("abcdef", 3)).toBe("abc");
		expect(secretSetOf(["abcdef"]).maskClipped("xxabcdefyy", 4)).toBe("xx**");
	});

	it("令牌原值同样按原文的位置：跨在上限上的令牌整个换成一个掩码", () => {
		const token = `sfly_pat_${"0123456789abcdef".repeat(2)}`;
		const crossing = `${"n".repeat(nameChars - 10)}${token}${"m".repeat(40)}`;
		expect(actionName(crossing, NO_SECRETS)).toBe(`${"n".repeat(nameChars - 10)}${MASK}`);
		expect(actionName(crossing, secretSetOf(["unrelated-value"]))).toBe(
			`${"n".repeat(nameChars - 10)}${MASK}`,
		);
	});

	it("随机对照：和独立的参照实现逐字相同（只取原文的前 N 个字符、跨在 N 上的整个换成一个掩码、再截到 N 个字符）", () => {
		const limit = 40;
		for (let round = 0; round < 400; round++) {
			const values = Array.from({ length: 1 + rand(3) }, () => fakeValue(2 + rand(12)));
			const random = secretSetOf(values);
			let text = "";
			const length = rand(120);
			while (text.length < length) {
				text += rand(3) === 0 ? values[rand(values.length)] : "xyz"[rand(3)];
			}
			// 参照：每个位置上以它开头的最长的完整出现，合并重叠的，再按规则输出
			const spans: Array<[number, number]> = [];
			for (let i = 0; i < text.length; i++) {
				const end = Math.max(
					-1,
					...values.filter((v) => text.startsWith(v, i)).map((v) => i + v.length),
				);
				if (end < 0) continue;
				const last = spans[spans.length - 1];
				if (last && i < last[1]) last[1] = Math.max(last[1], end);
				else spans.push([i, end]);
			}
			let expected = "";
			let cursor = 0;
			const cut = Math.min(limit, text.length);
			let stopped = false;
			for (const [start, end] of spans) {
				if (start >= cut) break;
				expected += text.slice(cursor, start) + MASK;
				cursor = end;
				if (end >= cut) {
					stopped = true;
					break;
				}
			}
			if (!stopped) expected += text.slice(cursor, cut);
			expected = expected.slice(0, limit);
			expect(random.maskClipped(text, limit), `${round}: ${text}`).toBe(expected);
		}
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
	it("SDK 在传输上限处截断后上报的文字（名称、字段值、失败原因）：明细、摘要、运行视图里此刻在做的动作，都没有另一个值的前半截", async () => {
		const big = fakeValue(4096);
		const small = fakeValue(40);
		const leaksOf = (text: string) => pieces(small).filter((piece) => text.includes(piece));
		const sent = (limit: number, fill: string) =>
			`${big}${fill.repeat(limit + transportMargin - big.length - 20)}${small.slice(0, 20)}`;
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{
					id: "entry",
					kind: "entry",
					params: [
						{ name: "big", type: "string", secret: true },
						{ name: "small", type: "string", secret: true },
					],
				},
				{ id: "a", kind: "package", package: "stub", node: "echo" },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { stub: "1.0.0" },
		});
		const runId = await api.triggerOk(id, { big, small });
		const task = await agent.nextAssign();
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const name = sent(nameChars, "n");
		const value = sent(valueChars, "v");
		const reason = `${big}${"r".repeat(reasonChars + transportMargin - 1 - big.length - 20)}${small.slice(0, 20)}…`;
		const fields = { k: value };
		agent.actions(task, [
			agent.actionStart(1, name, t0 + 1_000, { fields }),
			agent.actionEnd(1, "failed", t0 + 2_000, { reason }),
		]);
		const end = agent.stamp(t0 + 2_000);
		const running = { id: 2, parent: null, depth: 0, name, fields, ...agent.stamp(t0 + 3_000) };
		const ended = {
			...running,
			id: 1,
			end_ts: end.ts,
			end_mono: end.mono,
			result: "failed" as const,
			reason,
		};
		agent.actionSummary(task, {
			total: 2,
			reported: 2,
			names: [{ name, total: 2, reported: 2, failed: 1, capped_ts: null, capped_mono: null }],
			running: [running],
			recent: [ended],
			recent_failed: [ended],
		});
		await agent.sync();
		let page = "";
		await eventually(async () => {
			page = await (await cp.fetch(`/tasks/${task.taskId}/actions`)).text();
			expect(actionsApi.page.response.parse(JSON.parse(page)).actions.length).toBeGreaterThan(0);
		});
		const summary = await (await cp.fetch(`/tasks/${task.taskId}/actions/summary`)).text();
		const view = runsApi.get.response.parse(await api.run(runId));
		const current = JSON.stringify(
			view.chains[0]?.nodes.find((n) => n.node_id === "a")?.attempts[0]?.current_action ?? null,
		);
		for (const [what, body] of [
			["明细", page],
			["摘要", summary],
			["此刻在做的动作", current],
		] as const) {
			expect(leaksOf(body), what).toEqual([]);
			expect(body, what).toContain(MASK);
		}
		const [first] = actionsApi.page.response.parse(JSON.parse(page)).actions;
		expect(Array.from(first?.name ?? "").length).toBeLessThanOrEqual(nameChars);
	});
});
