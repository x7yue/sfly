// 真的 pi、假的模型、手动推进的时钟（#545 P 块）：
// 1. 闲置回收之后 pi 进程不在了，再说一句：发给模型的内容里带着之前的对话（pi 从会话文件恢复）；
// 2. pi 恢复不了（会话文件读不了、坏了、目录没了、工作目录对不上）：pi 1.6.0 不报错退出，而是悄悄开一个空会话——时间线上有 context_reset，
//    模型收到的第一句里有之前对话的摘要，摘要和对话原文不进发出去的事件和日志。
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IDLE_RECLAIM_MS } from "../src/sessions.js";
import { eventually } from "./support/eventually.js";
import { Harness } from "./support/harness.js";
import { ManualClock } from "./support/manual-clock.js";

let current: Harness | undefined;
afterEach(async () => {
	await current?.close();
	current = undefined;
});

const USER_MARK = "USERMARK-蓝鲸-7731";
const ASSIST_MARK = "ASSISTMARK-海豚-5520";
const FIRST = `第一句话：请记住 ${USER_MARK}`;
const SUMMARY_HEAD = "【平台说明】";
const BOUNDARY = "【以上是之前的对话；下面是用户这一次说的话】";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const text = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((p) => (p as { text?: string })?.text ?? "").join("")
			: "";
const notices = (h: Harness, id: string, turn?: number) =>
	h.events
		.of(id)
		.filter((r) => r.event.type === "notice" && (turn === undefined || r.turn === turn));

/** 第 1 轮做完（假模型回 ASSIST_MARK），15 分钟没有命令、pi 进程被回收；返回会话 ID 和时钟。 */
async function reclaimed() {
	const clock = new ManualClock();
	const h = await Harness.start({ clock });
	current = h;
	h.model.fallback = [{ text: `${ASSIST_MARK}：记住了。` }];
	const id = crypto.randomUUID();
	expect((await h.prompt(id, { turn: 1, text: FIRST })).status).toBe(202);
	expect(await h.turnEnd(id, 1)).toMatchObject({ outcome: "completed" });
	const pid = h.sessions.pid(id) as number;
	expect(alive(pid)).toBe(true);
	clock.advance(IDLE_RECLAIM_MS);
	await eventually(() => expect(alive(pid)).toBe(false), 15_000);
	await eventually(() => expect(h.sessions.activeProcesses).toBe(0));
	// 之后的几轮：假模型回别的话（第 2 轮的事件里不该有第 1 轮助手说的话，除非它是摘要漏出来的）。
	h.model.fallback = [{ text: "好的，接着做。" }];
	return { h, id, clock, pid };
}

/** 假模型收到的第 `n` 个请求之后的下一个请求（这一轮发出的第一个请求）的消息。 */
const firstRequestAfter = (h: Harness, before: number) =>
	h.model.requests.slice(before).at(0)?.messages ?? [];

describe("真的 pi：闲置回收之后接着说", () => {
	it("到时间后 pi 进程不在了；再说一句，发给模型的内容里带着之前的对话（从会话文件恢复，没有 context_reset、没有摘要）", async () => {
		const { h, id, pid } = await reclaimed();
		expect(alive(pid)).toBe(false);
		expect(h.sessions.pid(id)).toBeUndefined();
		const before = h.model.requests.length;
		expect((await h.prompt(id, { turn: 2, text: "第二句话" })).status).toBe(202);
		expect(await h.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		const messages = firstRequestAfter(h, before);
		expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(text(messages[1]?.content)).toBe(FIRST);
		expect(text(messages[2]?.content)).toContain(ASSIST_MARK);
		expect(text(messages[3]?.content)).toBe("第二句话");
		expect(notices(h, id)).toEqual([]);
		expect(h.sessions.pid(id)).not.toBe(pid);
	}, 120_000);
});

describe("真的 pi：恢复不了时换新的会话、放摘要", () => {
	/** 每种「恢复不了」：怎么弄坏、第 2 轮用哪个工作区。 */
	const cases: Array<{
		name: string;
		spoil: (h: Harness, id: string) => void;
		workdir?: (h: Harness) => string;
		skip?: boolean;
	}> = [
		{
			name: "会话文件被写成乱码",
			spoil: (h, id) => {
				const dir = join(h.dataDir, "sessions", id, "pi-session");
				for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "这不是 JSON\n半截{\n");
			},
		},
		{
			name: "会话文件是空的",
			spoil: (h, id) => {
				const dir = join(h.dataDir, "sessions", id, "pi-session");
				for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "");
			},
		},
		{
			name: "会话文件读不了（权限）",
			spoil: (h, id) => {
				const dir = join(h.dataDir, "sessions", id, "pi-session");
				for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o000);
			},
			// root 不受权限限制：读得了，就不是恢复不了。
			skip: process.getuid?.() === 0,
		},
		{
			name: "会话目录没了",
			spoil: (h, id) => rmSync(join(h.dataDir, "sessions", id, "pi-session"), { recursive: true }),
		},
		{
			name: "会话文件好好的，但这一轮的工作区和会话文件头里记的不是同一个（pi 按工作目录找会话）",
			spoil: () => {},
			workdir: (h) => {
				const other = join(h.root, "workbench", "other");
				mkdirSync(other, { recursive: true });
				return other;
			},
		},
	];

	for (const c of cases) {
		it.skipIf(c.skip)(
			c.name,
			async () => {
				const { h, id } = await reclaimed();
				c.spoil(h, id);
				const before = h.model.requests.length;
				const workdir = c.workdir?.(h);
				// 换了工作区的那种：之后的几轮都在新的工作区里（pi 按工作目录找会话，再换回去又是另一个工作目录）。
				const where = workdir && {
					workbench: { name: "fake-workbench", address: h.workbench.address, workdir },
				};
				const second = "第二句话：接着做";
				expect((await h.prompt(id, { turn: 2, text: second, ...where })).status).toBe(202);
				expect(await h.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });

				// 时间线上有 context_reset；说明里只有条数，没有话。
				const found = notices(h, id, 2);
				expect(found).toHaveLength(1);
				expect(found[0]?.event).toMatchObject({ type: "notice", kind: "context_reset" });

				// 模型收到的第一句：之前对话的摘要在前，这一轮的话在最后；新会话里没有之前的助手消息（只有这一句）。
				const messages = firstRequestAfter(h, before);
				expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
				const first = text(messages[1]?.content);
				expect(first.startsWith(SUMMARY_HEAD)).toBe(true);
				expect(first).toContain(`用户：${FIRST}`);
				expect(first).toContain(`助手：${ASSIST_MARK}：记住了。`);
				expect(first.endsWith(`${BOUNDARY}\n${second}`)).toBe(true);

				// 对话原文和摘要不进发出去的事件、不进日志。
				const turn2 = JSON.stringify(h.events.of(id).filter((r) => r.turn === 2));
				for (const needle of [USER_MARK, ASSIST_MARK, SUMMARY_HEAD, BOUNDARY]) {
					expect(turn2, needle).not.toContain(needle);
					expect(h.logs.join("\n"), needle).not.toContain(needle);
				}
				// 事件流上的每一行（控制面收到的全部）里也没有用户的话。
				expect(h.events.lines.join("\n")).not.toContain(USER_MARK);

				// 之后照常恢复：新的会话文件接得上，没有第二条 context_reset、没有摘要；pi 的上下文是摘要那句、回答、新的一句。
				const mid = h.model.requests.length;
				expect((await h.prompt(id, { turn: 3, text: "第三句话", ...where })).status).toBe(202);
				expect(await h.turnEnd(id, 3)).toMatchObject({ outcome: "completed" });
				const third = firstRequestAfter(h, mid);
				expect(third.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
				expect(text(third[3]?.content)).toBe("第三句话");
				expect(notices(h, id, 3)).toEqual([]);
			},
			120_000,
		);
	}

	it("回收之后再被弄坏第二次：摘要里是全部的话（第 1、2 轮各一份），没有套着上一份摘要", async () => {
		const { h, id, clock } = await reclaimed();
		const dir = join(h.dataDir, "sessions", id, "pi-session");
		for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "坏了\n");
		expect((await h.prompt(id, { turn: 2, text: "第二句话" })).status).toBe(202);
		expect(await h.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		clock.advance(IDLE_RECLAIM_MS);
		await eventually(() => expect(h.sessions.activeProcesses).toBe(0), 15_000);
		const again = join(h.dataDir, "sessions", id, "pi-session");
		for (const f of readdirSync(again)) writeFileSync(join(again, f), "又坏了\n");
		const before = h.model.requests.length;
		expect((await h.prompt(id, { turn: 3, text: "第三句话" })).status).toBe(202);
		expect(await h.turnEnd(id, 3)).toMatchObject({ outcome: "completed" });
		const first = text(firstRequestAfter(h, before)[1]?.content);
		expect(first.split(SUMMARY_HEAD)).toHaveLength(2);
		expect(first).toContain(`用户：${FIRST}`);
		expect(first).toContain("用户：第二句话");
		expect(first.endsWith(`${BOUNDARY}\n第三句话`)).toBe(true);
		expect(notices(h, id, 3)).toHaveLength(1);
	}, 120_000);
});
