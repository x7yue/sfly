// 假助手服务（support/fake-assistant.ts）按协议「一轮的状态」的表回应：控制面的会话测试都靠它，它和协议一处不同，
// 那些测试证明的就是错的。这里直接对着假助手服务发命令、读它的事件流，一格一格对表。不需要数据库。
import { randomUUID } from "node:crypto";
import type { AssistantStreamRecord } from "@sfly/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeAssistant } from "./support/fake-assistant.js";

const body = (turn: number) => ({
	turn,
	message_id: randomUUID(),
	text: `第 ${turn} 轮`,
	session: { title: "t", created_by: "alice" },
	workbench: { name: "wb", address: "10.0.0.5:7001", workdir: "/work" },
	env: {},
	secret_env: {},
});

describe("假助手服务按协议的状态表回应", () => {
	/** 每个用例一个新的会话 ID：一个用例留下的状态不影响下一个。 */
	let SESSION = randomUUID();
	let assistant: FakeAssistant;
	let lines: AssistantStreamRecord[];
	let controller: AbortController;

	const post = async (path: string, json: unknown) => {
		const res = await fetch(`${assistant.url}/sessions/${SESSION}/${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${assistant.secret}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(json),
		});
		return { status: res.status };
	};
	const prompt = async (turn: number) => (await post("prompt", body(turn))).status;
	const steer = async (turn: number, id: string = randomUUID(), text = "插话") =>
		(await post("steer", { turn, message_id: id, text })).status;
	const abort = async (turn: number) => (await post("abort", { turn })).status;
	const end = async () => (await post("end", {})).status;
	/** 事件流里这个会话的事件（`turn_end` 写成 `turn_end:<轮次>:<结局>`，其余写类型和种类）。 */
	const seen = () =>
		lines.map((line) => {
			const e = line.event;
			if (e.type === "turn_end") return `turn_end:${e.turn}:${e.outcome}`;
			if (e.type === "notice") return `${e.kind}:${e.message_id}`;
			if (e.type === "steer_queue") return `steer_queue:${e.messages.length}`;
			return e.type;
		});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
	/** 等到条件成立（事件流是异步到的，固定睡一段时间在慢的机器上会不够）。 */
	const until = async (ok: () => boolean, timeoutMs = 5000) => {
		const deadline = Date.now() + timeoutMs;
		while (!ok()) {
			if (Date.now() > deadline) throw new Error(`等不到：${JSON.stringify(seen())}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const turnEnd = (turn: number) =>
		assistant.emit(SESSION, turn, {
			type: "turn_end",
			turn,
			outcome: "completed",
			reason: "测试",
			steps: 0,
			model_calls: 0,
			duration_ms: 1,
		});

	beforeAll(async () => {
		assistant = await FakeAssistant.start({ heartbeatMs: 0 });
	});
	afterAll(async () => {
		await assistant.close();
	});
	beforeEach(async () => {
		controller?.abort();
		assistant.abortMarks.clear();
		assistant.prompts.length = 0;
		assistant.steers.length = 0;
		assistant.ends.length = 0;
		assistant.endedByAbort.length = 0;
		assistant.stopSettleMs = 0;
		assistant.strictTurns = true;
		SESSION = randomUUID();
		lines = [];
		controller = new AbortController();
		const res = await fetch(`${assistant.url}/events`, {
			headers: { authorization: `Bearer ${assistant.secret}` },
			signal: controller.signal,
		});
		void (async () => {
			let rest = "";
			try {
				for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
					rest += new TextDecoder().decode(chunk);
					const parts = rest.split("\n");
					rest = parts.pop() ?? "";
					for (const part of parts) {
						const parsed = JSON.parse(part) as AssistantStreamRecord & { type?: string };
						if (!("type" in parsed) || parsed.type === undefined) lines.push(parsed);
					}
				}
			} catch {
				// 用例结束时断开。
			}
		})();
		await assistant.connected();
	});

	it("中止记号只增不减，轮次不大于记号的 prompt 一律 202、以 stopped 结束，收到 prompt 不清掉记号，先于「在做回 409」", async () => {
		expect(await prompt(6)).toBe(202);
		// 在做的第 6 轮比 N（5）新：不动它；记号提到 5。
		expect(await abort(5)).toBe(202);
		expect(assistant.abortMarks.get(SESSION)).toBe(5);
		await settle();
		expect(seen()).toEqual([]);
		// 更早的 prompt 晚到：先看记号，不回 409，以 stopped 结束；记号还是 5。
		expect(await prompt(4)).toBe(202);
		expect(await prompt(5)).toBe(202);
		expect(await prompt(4)).toBe(202);
		await settle();
		expect(seen()).toEqual(["turn_end:4:stopped", "turn_end:5:stopped", "turn_end:4:stopped"]);
		expect(assistant.abortMarks.get(SESSION)).toBe(5);
		// 轮次比记号大的 prompt：第 6 轮在做，所以 409。
		expect(await prompt(7)).toBe(409);
		// 记号不降：abort 3 之后还是 5。
		expect(await abort(3)).toBe(202);
		expect(assistant.abortMarks.get(SESSION)).toBe(5);
		// 第 6 轮结束之后，第 7 轮照常；已经用过一次记号之后更早的 prompt 仍以 stopped 结束。
		lines.length = 0;
		turnEnd(6);
		expect(await prompt(7)).toBe(202);
		expect(await prompt(3)).toBe(202);
		await settle();
		expect(seen()).toEqual(["turn_end:6:completed", "turn_end:3:stopped"]);
		expect(assistant.abortMarks.get(SESSION)).toBe(5);
	});

	it("abort：在做的轮次不大于 N 的停下，比 N 新的不动；没有一轮时只是把记号提到 N；回应总是 202", async () => {
		expect(await abort(2)).toBe(202); // 没有一轮：只有记号
		expect(assistant.abortMarks.get(SESSION)).toBe(2);
		await settle();
		expect(seen()).toEqual([]);
		expect(await prompt(3)).toBe(202);
		expect(await abort(3)).toBe(202); // 在做的第 3 轮不大于 3：停下
		await settle();
		expect(seen()).toEqual(["turn_end:3:stopped"]);
		expect(await prompt(4)).toBe(202);
		expect(await abort(8)).toBe(202); // 比在做的第 4 轮大：停下，记号 8
		await settle();
		expect(seen().at(-1)).toBe("turn_end:4:stopped");
		expect(assistant.abortMarks.get(SESSION)).toBe(8);
	});

	it("steer：只有 turn 那一轮在做才 202（并发出含它的 steer_queue），同一个 message_id 只认一次；没有一轮、轮次对不上 409", async () => {
		expect(await steer(1)).toBe(409); // 没有一轮
		expect(await prompt(1)).toBe(202);
		expect(await steer(2)).toBe(409); // 轮次对不上
		const id = randomUUID();
		expect(await steer(1, id)).toBe(202);
		expect(await steer(1, id)).toBe(202); // 同一个 message_id 只认一次
		const other = randomUUID();
		expect(await steer(1, other, "再说一句")).toBe(202);
		await settle();
		const queues = lines.filter((l) => l.event.type === "steer_queue").map((l) => l.event);
		expect(queues.map((q) => (q.type === "steer_queue" ? q.messages.length : -1))).toEqual([
			1, 1, 2,
		]);
		// 送到：空的 steer_queue。
		assistant.deliverSteers(SESSION);
		await settle();
		expect(seen().at(-1)).toBe("steer_queue:0");
	});

	it("在停止：steer 409；新的一轮 prompt 登记着（202）等旧的一轮结束；这时再来 prompt 是 409；abort 带旧轮次不动新的一轮", async () => {
		assistant.stopSettleMs = 500;
		expect(await prompt(1)).toBe(202);
		expect(await abort(1)).toBe(202); // 在做 -> 在停止，不等 turn_end
		await settle();
		expect(assistant.stoppingTurn(SESSION)).toBe(1);
		expect(seen()).toEqual([]);
		expect(await steer(1)).toBe(409); // 在停止
		expect(await prompt(2)).toBe(202); // 在停止、第 2 轮在等
		expect(assistant.pendingTurn(SESSION)).toBe(2);
		expect(await prompt(3)).toBe(409); // 第 2 轮是「在做」
		expect(await steer(1)).toBe(409); // 不是第 2 轮
		const pendingSteer = randomUUID();
		expect(await steer(2, pendingSteer)).toBe(202); // 第 2 轮在做（还没开始）
		expect(await abort(1)).toBe(202); // 旧的轮次：不动第 2 轮
		expect(assistant.pendingTurn(SESSION)).toBe(2);
		await until(() => seen().includes("turn_end:1:stopped"));
		// 第 1 轮的 turn_end 之后第 2 轮开始（没有被中止），它的插话仍在队列里。
		expect(seen()).toContain("turn_end:1:stopped");
		expect(assistant.pendingTurn(SESSION)).toBeUndefined();
		expect(await prompt(3)).toBe(409); // 第 2 轮在做
	});

	it("在停止、第 k 轮在等：abort 带的 N 不小于 k，第 k 轮立即 stopped（它的插话各发 steer_dropped 在前），不等第 m 轮的 turn_end，状态回到在停止", async () => {
		assistant.stopSettleMs = 500;
		expect(await prompt(1)).toBe(202);
		expect(await abort(1)).toBe(202);
		expect(await prompt(2)).toBe(202);
		const id = randomUUID();
		expect(await steer(2, id)).toBe(202);
		expect(await abort(2)).toBe(202);
		await until(() => seen().includes("turn_end:2:stopped"));
		// 第 2 轮：它的插话各一条 steer_dropped，之后才是它的 stopped；第 1 轮还在停止，它的 turn_end 还没有发。
		const early = seen();
		expect(early.indexOf(`steer_dropped:${id}`)).toBeGreaterThan(-1);
		expect(early.indexOf("turn_end:2:stopped")).toBeGreaterThan(
			early.indexOf(`steer_dropped:${id}`),
		);
		expect(early).not.toContain("turn_end:1:stopped");
		expect(assistant.pendingTurn(SESSION)).toBeUndefined();
		expect(assistant.stoppingTurn(SESSION)).toBe(1); // 状态回到「在停止（第 1 轮）」
		expect(await steer(2)).toBe(409); // 第 2 轮已经结束
		await until(() => seen().includes("turn_end:1:stopped"));
		expect(await prompt(3)).toBe(202); // 第 2 轮没有在做：第 3 轮（大于记号 2）照常
	});

	it("在停止、第 k 轮在等：abort 带的 N 小于 k，第 k 轮不动，第 m 轮的 turn_end 之后它开始", async () => {
		assistant.stopSettleMs = 300;
		expect(await prompt(1)).toBe(202);
		expect(await abort(1)).toBe(202);
		expect(await prompt(3)).toBe(202); // 第 3 轮在等
		expect(await abort(2)).toBe(202); // N=2 小于 3：不动第 3 轮
		expect(assistant.pendingTurn(SESSION)).toBe(3);
		await until(() => seen().includes("turn_end:1:stopped"));
		expect(assistant.pendingTurn(SESSION)).toBeUndefined();
		expect(await prompt(4)).toBe(409); // 第 3 轮在做
	});

	it("插话的待送队列每一轮各一份：第 m 轮在停止时给等着的第 k 轮插话，不影响第 m 轮没送到的话的 steer_dropped", async () => {
		assistant.stopSettleMs = 300;
		expect(await prompt(1)).toBe(202);
		const first = randomUUID();
		expect(await steer(1, first, "给第 1 轮")).toBe(202);
		expect(await abort(1)).toBe(202); // 第 1 轮在停止，那句话还没送到
		expect(await prompt(2)).toBe(202); // 第 2 轮在等
		const second = randomUUID();
		expect(await steer(2, second, "给第 2 轮")).toBe(202);
		await until(() => seen().includes("turn_end:1:stopped"));
		const tail = seen();
		// 第 1 轮那句话的 steer_dropped 在第 1 轮的 turn_end 前面；第 2 轮的话没有被丢。
		expect(tail.indexOf(`steer_dropped:${first}`)).toBeGreaterThan(-1);
		expect(tail.indexOf("turn_end:1:stopped")).toBeGreaterThan(
			tail.indexOf(`steer_dropped:${first}`),
		);
		expect(tail).not.toContain(`steer_dropped:${second}`);
		// 第 2 轮开始了（在做），它的待送队列还在：用 emit 直接发它的 turn_end，没送到的话仍各发一条 steer_dropped 在前。
		await settle();
		lines.length = 0;
		turnEnd(2);
		await settle();
		expect(seen()).toEqual([`steer_dropped:${second}`, "turn_end:2:completed"]);
	});

	it("emit 直接发的 turn_end 也守插话的不变式：没送到的插话各发一条 steer_dropped 在前；已经送到的不发", async () => {
		expect(await prompt(1)).toBe(202);
		const lost = randomUUID();
		const delivered = randomUUID();
		expect(await steer(1, lost, "没送到")).toBe(202);
		turnEnd(1);
		await settle();
		expect(seen().slice(-3)).toEqual([
			`steer_queue:1`,
			`steer_dropped:${lost}`,
			"turn_end:1:completed",
		]);
		expect(await prompt(2)).toBe(202);
		expect(await steer(2, delivered, "送到了")).toBe(202);
		assistant.deliverSteers(SESSION); // 送到：空的 steer_queue
		await settle();
		lines.length = 0;
		turnEnd(2);
		await settle();
		expect(seen()).toEqual(["turn_end:2:completed"]);
	});

	it("在停止时送到的插话（决定结束之后、清空之前）只更新助手服务自己的记录、不再外传 steer_queue：turn_end 前既没有 steer_dropped，最后一份 steer_queue 里还列着它", async () => {
		assistant.stopSettleMs = 300;
		expect(await prompt(1)).toBe(202);
		const id = randomUUID();
		expect(await steer(1, id)).toBe(202);
		expect(await abort(1)).toBe(202);
		assistant.deliverSteers(SESSION, 1); // T0 之后送到
		await until(() => seen().includes("turn_end:1:stopped"));
		const all = seen();
		expect(all).toEqual(["steer_queue:1", "turn_end:1:stopped"]);
	});

	it("在停止的轮次有没送到的插话：停止结束时每句各一条 steer_dropped，排在 turn_end 前面", async () => {
		expect(await prompt(1)).toBe(202);
		const ids = [randomUUID(), randomUUID()];
		for (const id of ids) expect(await steer(1, id)).toBe(202);
		expect(await abort(1)).toBe(202);
		await settle();
		const tail = seen().slice(-3);
		expect(tail).toEqual([
			`steer_dropped:${ids[0]}`,
			`steer_dropped:${ids[1]}`,
			"turn_end:1:stopped",
		]);
	});

	it("end：202 收到就回；在做的一轮照停止结束、turn_end 照常发；在停止、第 k 轮在等时 k 立即 stopped；不动中止记号；助手服务不记得会话结束了", async () => {
		assistant.stopSettleMs = 800;
		expect(await prompt(1)).toBe(202);
		expect(await end()).toBe(202);
		await settle();
		expect(assistant.ends).toContain(SESSION);
		expect(seen()).toEqual([]); // 在停止：还没发 turn_end
		expect(assistant.abortMarks.get(SESSION)).toBeUndefined(); // end 不动记号
		expect(await prompt(2)).toBe(202); // 在停止、第 2 轮在等
		expect(await end()).toBe(202); // 在停止、第 2 轮在等 × end：第 2 轮立即 stopped
		await until(() => seen().includes("turn_end:2:stopped"));
		expect(seen()).not.toContain("turn_end:1:stopped");
		await until(() => seen().includes("turn_end:1:stopped"));
		// 没有一轮时 end 也是 202（重复调用无害）；助手服务不记得 end：之后轮次比记号大的 prompt 照表处理，起一轮、照常做。
		expect(await end()).toBe(202);
		lines.length = 0;
		expect(await prompt(3)).toBe(202);
		await settle();
		expect(seen()).toEqual([]);
		expect(await prompt(4)).toBe(409); // 第 3 轮在做，没有因为 end 被拒绝或结束
	});
});
