// 会话此刻在内存里的现场（src/sessions/live-state.ts，快照用，#545）：累积、清空、打码、按字节截断。
// 纯函数的单元测试；落到事件流里的位置和重连见 session-snapshot.test.ts。
import { SECRET_MASK, SESSION_EVENT_LIMITS, type SessionEvent } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { LiveStates, TailText, tailBytes } from "../src/sessions/live-state.js";

const LIMIT = SESSION_EVENT_LIMITS.runningToolOutputBytes;
const SESSION = "6f1c2d3e-0000-4000-8000-000000000001";
const OTHER = "6f1c2d3e-0000-4000-8000-000000000002";

/** 一枚会话令牌的样子：`sfly_ses_` 加 48 个十六进制字符（原值不会出现在任何输出里）。 */
const HEX = "0123456789abcdef0011223344556677889900aabbccddeeff".slice(0, 48);
const TOKEN = `sfly_ses_${HEX}`;

const delta = (text: string): SessionEvent => ({ type: "assistant_delta", text });
const output = (callId: string, text: string): SessionEvent => ({
	type: "tool_output",
	call_id: callId,
	text,
});
const toolCall = (callId: string, title = "sleep 600"): SessionEvent => ({
	type: "tool_call",
	call_id: callId,
	tool: "command",
	title,
	seq: 1,
	at: "2026-01-01T00:00:00.000Z",
});
const toolResult = (callId: string): SessionEvent => ({
	type: "tool_result",
	call_id: callId,
	is_error: false,
	text: "",
	truncated: false,
	duration_ms: 1,
	seq: 2,
	at: "2026-01-01T00:00:00.000Z",
});
const message = (): SessionEvent => ({
	type: "assistant_message",
	text: "整条",
	usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
	seq: 3,
	at: "2026-01-01T00:00:00.000Z",
});
const turnEnd = (): SessionEvent => ({
	type: "turn_end",
	turn: 1,
	outcome: "completed",
	reason: "",
	duration_ms: 1,
	seq: 4,
	at: "2026-01-01T00:00:00.000Z",
});
const steerQueue = (...ids: string[]): SessionEvent => ({
	type: "steer_queue",
	messages: ids.map((message_id) => ({ message_id, text: `话 ${message_id}` })),
});

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

describe("tailBytes：最后至多 N 个 UTF-8 字节，不切开字符", () => {
	it("不超过上限原样返回；超过时留最后的字节", () => {
		expect(tailBytes("abc", 10)).toBe("abc");
		expect(tailBytes("abcdef", 3)).toBe("def");
	});

	it("截断点落在多字节字符中间时，这个字符整个不要（不留 U+FFFD）", () => {
		// 「你」3 个字节：留 4 个字节只能放下最后一个「你」加一个字节的 a。
		const text = "你你你a";
		const cut = tailBytes(text, 4);
		expect(cut).toBe("你a");
		expect(cut).not.toContain("�");
		expect(utf8(cut)).toBeLessThanOrEqual(4);
		// 4 字节的字符（表情）同理。
		const emoji = tailBytes("😀😀😀", 6);
		expect(emoji).toBe("😀");
		expect(emoji).not.toContain("�");
	});

	it("每一个截断位置都不产生半个字符", () => {
		const text = "a你😀b你😀c".repeat(5);
		for (let limit = 0; limit <= utf8(text) + 2; limit++) {
			const cut = tailBytes(text, limit);
			expect(utf8(cut)).toBeLessThanOrEqual(limit);
			expect(cut, `limit ${limit}`).not.toContain("�");
			expect(text.endsWith(cut)).toBe(true);
		}
	});
});

describe("LiveStates：累积和清空", () => {
	it("上一条持久的助手消息之后的增量拼在一起；整条消息到了就清空", () => {
		const live = new LiveStates();
		live.apply(SESSION, delta("我先"));
		live.apply(SESSION, delta("看一下"));
		expect(live.parts(SESSION).partial_text).toBe("我先看一下");
		live.apply(SESSION, message());
		expect(live.parts(SESSION).partial_text).toBe("");
		live.apply(SESSION, delta("然后"));
		expect(live.parts(SESSION).partial_text).toBe("然后");
	});

	it("一轮结束、一轮开始、会话结束：整个会话的现场清空，不留一项空的", () => {
		for (const clearing of [
			turnEnd(),
			{ type: "turn_started", turn: 2, seq: 5, at: "2026-01-01T00:00:00.000Z" } as SessionEvent,
			{
				type: "session_ended",
				by: "alice",
				seq: 6,
				at: "2026-01-01T00:00:00.000Z",
			} as SessionEvent,
		]) {
			const live = new LiveStates();
			live.apply(SESSION, delta("半截"));
			live.apply(SESSION, toolCall("c1"));
			live.apply(SESSION, output("c1", "输出"));
			live.apply(SESSION, steerQueue("a"));
			expect(live.parts(SESSION).running_tool?.output).toBe("输出");
			live.apply(SESSION, clearing);
			expect(live.parts(SESSION)).toEqual({
				partial_text: "",
				running_tool: null,
				steer_queue: [],
			});
			expect(live.size, clearing.type).toBe(0);
		}
	});

	it("各个会话互不影响", () => {
		const live = new LiveStates();
		live.apply(SESSION, delta("甲"));
		live.apply(OTHER, delta("乙"));
		live.apply(SESSION, turnEnd());
		expect(live.parts(SESSION).partial_text).toBe("");
		expect(live.parts(OTHER).partial_text).toBe("乙");
	});

	it("正在跑的工具：tool_call 到 tool_result 之间，输出追加；结果到了清掉；别的调用的输出和结果不认", () => {
		const live = new LiveStates();
		expect(live.parts(SESSION).running_tool).toBeNull();
		live.apply(SESSION, toolCall("c1", "sfly run start 巡检"));
		live.apply(SESSION, output("c1", "第一段\n"));
		live.apply(SESSION, output("c9", "不是这个调用的\n"));
		live.apply(SESSION, output("c1", "第二段\n"));
		expect(live.parts(SESSION).running_tool).toEqual({
			call_id: "c1",
			tool: "command",
			title: "sfly run start 巡检",
			output: "第一段\n第二段\n",
		});
		// 别的调用的结果不清掉正在跑的这个。
		live.apply(SESSION, toolResult("c9"));
		expect(live.parts(SESSION).running_tool?.call_id).toBe("c1");
		live.apply(SESSION, toolResult("c1"));
		expect(live.parts(SESSION).running_tool).toBeNull();
		// 结果之后迟到的输出不认；没见过 tool_call（控制面重启之后）的输出也不认。
		live.apply(SESSION, output("c1", "迟到的"));
		live.apply(OTHER, output("c2", "没见过调用的"));
		expect(live.parts(SESSION).running_tool).toBeNull();
		expect(live.parts(OTHER).running_tool).toBeNull();
	});

	it("新的 tool_call 取代上一个：输出从头记", () => {
		const live = new LiveStates();
		live.apply(SESSION, toolCall("c1"));
		live.apply(SESSION, output("c1", "旧的"));
		live.apply(SESSION, toolCall("c2", "ls"));
		live.apply(SESSION, output("c2", "新的"));
		expect(live.parts(SESSION).running_tool).toMatchObject({ call_id: "c2", output: "新的" });
	});

	it("最新的 steer_queue 取代上一份；空的一份把它清掉", () => {
		const live = new LiveStates();
		live.apply(SESSION, steerQueue("a", "b"));
		expect(live.parts(SESSION).steer_queue.map((m) => m.message_id)).toEqual(["a", "b"]);
		live.apply(SESSION, steerQueue("b"));
		expect(live.parts(SESSION).steer_queue.map((m) => m.message_id)).toEqual(["b"]);
		live.apply(SESSION, steerQueue());
		expect(live.parts(SESSION).steer_queue).toEqual([]);
		expect(live.size).toBe(0);
	});

	it("取走的现场是副本：改它不影响内存里的", () => {
		const live = new LiveStates();
		live.apply(SESSION, steerQueue("a"));
		live.parts(SESSION).steer_queue.pop();
		expect(live.parts(SESSION).steer_queue).toHaveLength(1);
	});

	it("clear：会话被删，现场一起没有", () => {
		const live = new LiveStates();
		live.apply(SESSION, delta("x"));
		live.clear(SESSION);
		expect(live.size).toBe(0);
	});
});

describe("LiveStates：输出的最后一段按 UTF-8 字节截断", () => {
	it("超过上限只留最后 runningToolOutputBytes 个字节", () => {
		const live = new LiveStates();
		live.apply(SESSION, toolCall("c1"));
		const lines = Array.from({ length: 3000 }, (_, i) => `行 ${String(i).padStart(5, "0")}\n`);
		for (const line of lines) live.apply(SESSION, output("c1", line));
		const tail = live.parts(SESSION).running_tool?.output ?? "";
		expect(utf8(tail)).toBeLessThanOrEqual(LIMIT);
		// 留得满：没有因为窗口或打码少留很多。
		expect(utf8(tail)).toBeGreaterThan(LIMIT - 8);
		expect(lines.join("").endsWith(tail)).toBe(true);
		expect(tail).not.toContain("�");
	});

	it("一次进来一大段（比窗口还大）也只留最后一段", () => {
		const live = new LiveStates();
		live.apply(SESSION, toolCall("c1"));
		live.apply(SESSION, output("c1", `${"开头".repeat(100_000)}结尾`));
		const tail = live.parts(SESSION).running_tool?.output ?? "";
		expect(utf8(tail)).toBeLessThanOrEqual(LIMIT);
		expect(tail.endsWith("结尾")).toBe(true);
		expect(tail).not.toContain("�");
	});
});

describe("快照里的文字打过码：先打码、后截断", () => {
	const leaks = (text: string) =>
		text.includes(HEX) ||
		// 原值的任何一段连续 8 个字符都不能出现（半截也不行）。
		Array.from({ length: HEX.length - 7 }, (_, i) => HEX.slice(i, i + 8)).some((part) =>
			text.includes(part),
		);

	it("一条增量里的完整令牌换成掩码", () => {
		const live = new LiveStates();
		live.apply(SESSION, delta(`令牌是 ${TOKEN} 请收好`));
		const text = live.parts(SESSION).partial_text;
		expect(text).toBe(`令牌是 ${SECRET_MASK} 请收好`);
	});

	it("令牌被拆在两条增量里：前缀在上一条、后面的字符在下一条，拼起来打码，快照里没有原值", () => {
		const live = new LiveStates();
		live.apply(SESSION, delta("令牌是 sfly_ses_"));
		live.apply(SESSION, delta(`${HEX} 请收好`));
		const text = live.parts(SESSION).partial_text;
		expect(leaks(text)).toBe(false);
		expect(text).toBe(`令牌是 ${SECRET_MASK} 请收好`);
	});

	it("拆在令牌字符中间：前一条已经带着几个字符，拼起来仍然整个打码（不留后半截）", () => {
		for (const cut of [10, 17, 30, 56]) {
			const live = new LiveStates();
			live.apply(SESSION, delta(`令牌是 ${TOKEN.slice(0, cut)}`));
			// 逐条打码之后推送的是掩码加后半截（那是推送的边界，不是快照的）：这里喂的是通过校验、还没有打码的原文。
			live.apply(SESSION, delta(`${TOKEN.slice(cut)} 请收好`));
			const text = live.parts(SESSION).partial_text;
			expect(leaks(text), `cut ${cut}`).toBe(false);
			expect(text, `cut ${cut}`).toBe(`令牌是 ${SECRET_MASK} 请收好`);
		}
	});

	it("工具输出里被拆开的令牌也一样", () => {
		const live = new LiveStates();
		live.apply(SESSION, toolCall("c1"));
		live.apply(SESSION, output("c1", "export TOKEN=sfly_ses_0123456789abcdef"));
		live.apply(SESSION, output("c1", "0011223344556677889900aabbccddeeff\n"));
		const out = live.parts(SESSION).running_tool?.output ?? "";
		expect(leaks(out)).toBe(false);
		expect(out).toBe(`export TOKEN=${SECRET_MASK}\n`);
	});

	it("令牌跨在输出的截断边界上：不论令牌离结尾多远，最后一段里没有原值，也没有半截", () => {
		// 令牌后面再接 `tail` 个字符；让「最后 LIMIT 个字节」的起点、窗口的起点分别扫过令牌的每一个位置。
		const distances = new Set<number>();
		for (const base of [LIMIT, LIMIT + 1024, LIMIT * 2 + 2048]) {
			for (let delta = -70; delta <= 70; delta++) distances.add(base + delta);
		}
		for (const filler of [".", "\n", "y", "你"]) {
			for (const distance of distances) {
				const live = new LiveStates();
				live.apply(SESSION, toolCall("c1"));
				// 一次进来和分成小块进来，结果一样。
				const text = `${filler.repeat(40_000)}${TOKEN}${filler.repeat(distance)}`;
				for (let at = 0; at < text.length; at += 7000) {
					live.apply(SESSION, output("c1", text.slice(at, at + 7000)));
				}
				const out = live.parts(SESSION).running_tool?.output ?? "";
				expect(leaks(out), `filler ${JSON.stringify(filler)} distance ${distance}`).toBe(false);
				expect(utf8(out)).toBeLessThanOrEqual(LIMIT);
				expect(out).not.toContain("�");
			}
		}
	});

	it("满屏都是令牌（打码之后比上限短得多，最后一步的截断什么也不削）：窗口开头落在令牌中间也不留半截", () => {
		// 每一行一枚令牌：窗口（最后 LIMIT + 1024 个字符）打码之后只剩两千来个字节，不会再被截。结尾多接 `shift` 个字符，
		// 窗口的起点相对令牌的位置就逐位移动，扫过令牌的每一个位置。
		for (let shift = 0; shift <= TOKEN.length + 1; shift++) {
			const live = new LiveStates();
			live.apply(SESSION, toolCall("c1"));
			live.apply(SESSION, output("c1", `${`${TOKEN}\n`.repeat(2000)}${".".repeat(shift)}`));
			const out = live.parts(SESSION).running_tool?.output ?? "";
			expect(leaks(out), `shift ${shift}`).toBe(false);
			expect(utf8(out)).toBeLessThan(LIMIT / 2);
			// 窗口开头那半截令牌被削掉了：第一个字符是掩码或换行之后的内容，不是令牌的字符。
			expect(out.startsWith(SECRET_MASK) || out.startsWith("\n")).toBe(true);
		}
	});

	/**
	 * 窗口开头先有 `k` 个令牌字符、紧接着一枚完整的令牌，后面的文字打码之后明显变短（窗口比上限短，最后一步按字节的截断不会再削开头）：
	 * 以前先削开头（至多 128 个令牌字符）再打码，k 在 72 到 127 之间削进了令牌（`sfly_ses_` 前缀或十六进制），剩下的认不出，原值进了快照
	 * （#761 第一次审查）。窗口的起点正好落在令牌前 k 个字符处：总长 = 令牌前的长度 - k + 窗口大小（`TailText` 的窗口是上限加 1 KB）。
	 */
	const WINDOW = LIMIT + 1024;
	function afterFragment(k: number, filler: "lines" | "run"): string {
		const head = `${".".repeat(40_000)}${"A".repeat(300)}`;
		const tailLen = WINDOW - k - TOKEN.length;
		const shrink =
			filler === "lines"
				? `\n${TOKEN}`.repeat(Math.ceil(tailLen / (TOKEN.length + 1)))
				: `\nsfly_ses_${"z".repeat(1000)}\n${"-".repeat(tailLen)}`;
		const text = `${head}${TOKEN}${shrink.slice(0, tailLen)}`;
		const live = new LiveStates();
		live.apply(SESSION, toolCall("c1"));
		for (let at = 0; at < text.length; at += 7000) {
			live.apply(SESSION, output("c1", text.slice(at, at + 7000)));
		}
		return live.parts(SESSION).running_tool?.output ?? "";
	}

	it("窗口开头先有 k 个令牌字符、紧接一枚令牌，后面一行一枚令牌（打码后窗口比上限短）：k 从 0 到 140 逐个扫，最后一段里没有原值的任何连续 8 个字符", () => {
		for (let k = 0; k <= 140; k++) {
			const out = afterFragment(k, "lines");
			expect(leaks(out), `k=${k}：${out.slice(0, 70)}`).toBe(false);
			expect(utf8(out)).toBeLessThanOrEqual(LIMIT);
		}
	});

	it("同上，后面是一个 sfly_ses_ 连着 1000 个令牌字符（打码一次就缩短 1000 个字符）：k 从 60 到 130", () => {
		for (let k = 60; k <= 130; k++) {
			const out = afterFragment(k, "run");
			expect(leaks(out), `k=${k}：${out.slice(0, 70)}`).toBe(false);
		}
	});

	it("先整窗打码、再削开头：窗口开头落在令牌中间（剩下的是令牌的后半截、认不出）时被削掉，削掉之后的文字原样留着", () => {
		// 后面接一枚 sfly_ses_ 连着 1500 个令牌字符：打码之后整段比上限短，最后一步的按字节截断不会替「削开头」削掉开头。
		const shrink = `\nsfly_ses_${"z".repeat(1500)}\n`;
		for (const cut of [1, 10, 20, 40, 56]) {
			// 窗口的起点落在令牌里：令牌的前 `cut` 个字符在窗口外，窗口里正好是令牌的后半截接着别的文字。
			const lead = `${TOKEN.slice(cut)}\n后面的文字`;
			const body = `${lead}${shrink}${"-".repeat(WINDOW - lead.length - shrink.length)}`;
			expect(body).toHaveLength(WINDOW);
			const tail = new TailText(LIMIT);
			tail.append(`${"#".repeat(WINDOW * 3)}${body}`);
			const out = tail.read();
			expect(utf8(out), `cut ${cut}`).toBeLessThan(LIMIT);
			expect(leaks(out), `cut ${cut}`).toBe(false);
			// 削掉的是令牌的后半截，换行和后面的文字原样留着。
			expect(out.startsWith("\n后面的文字"), `cut ${cut}`).toBe(true);
		}
	});

	it("窗口的起点切在代理对中间：开头落单的低位代理不留（打码之后比上限短，最后一步的截断不会替它削）", () => {
		// 一个表情占两个字符：窗口从它的第二个字符开始。后面一枚 sfly_ses_ 连着 1500 个令牌字符，打码之后整段比上限短。
		const shrink = `\nsfly_ses_${"z".repeat(1500)}\n`;
		const tail = new TailText(LIMIT);
		tail.append(`😀${"a".repeat(WINDOW - 1 - shrink.length)}${shrink}`);
		const out = tail.read();
		expect(utf8(out)).toBeLessThan(LIMIT);
		// 开头不是落单的低位代理，整段能原样来回转成 UTF-8（落单的代理会变成 U+FFFD）。
		expect(/^[\udc00-\udfff]/.test(out)).toBe(false);
		expect(out.charCodeAt(0)).toBeLessThan(0xdc00);
		expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
	});

	it("令牌后面连着一大串令牌字符（比令牌长很多）：窗口开头落在这一串里也不留令牌的半截", () => {
		const live = new LiveStates();
		live.apply(SESSION, toolCall("c1"));
		live.apply(SESSION, output("c1", `${TOKEN}${"a".repeat(LIMIT * 3)}`));
		const out = live.parts(SESSION).running_tool?.output ?? "";
		expect(out.includes(HEX)).toBe(false);
		expect(utf8(out)).toBeLessThanOrEqual(LIMIT);
	});

	it("打码的规矩和 maskSessionTokens 一样：只看完整的令牌格式，窗口里别的文字原样留下", () => {
		const live = new LiveStates();
		live.apply(SESSION, toolCall("c1"));
		live.apply(SESSION, output("c1", `${"x".repeat(LIMIT * 4)}\nsfly_ses_\n结尾\n`));
		const out = live.parts(SESSION).running_tool?.output ?? "";
		// 单独的前缀（后面没有令牌字符）不打码。
		expect(out.endsWith("sfly_ses_\n结尾\n")).toBe(true);
	});
});

describe("TailText", () => {
	it("没有被削过的窗口（文字不到上限）原样读出，开头不动", () => {
		const tail = new TailText(LIMIT);
		tail.append("abc_def-ghi 1234\n");
		expect(tail.read()).toBe("abc_def-ghi 1234\n");
	});
});
