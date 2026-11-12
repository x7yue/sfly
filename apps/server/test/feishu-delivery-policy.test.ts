// 投递的限速和退避的取值（#230，ADR 0020）。控制面 HTTP 测试（feishu-delivery.test.ts）只能证明「该发的发了」，
// 证明不了「不该发的没有发」（那要等一段时间才能确认没有动静），所以「不超过」这一半在这里用纯函数直接断言。
import { describe, expect, it } from "vitest";
import { isRetryDue, retryDelayMs, SendRateLimiter } from "../src/feishu/delivery-policy.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("退避间隔", () => {
	it("从 1 秒起逐次翻倍，最长 60 秒", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => retryDelayMs(n) / SECOND)).toEqual([
			1, 2, 4, 8, 16, 32, 60, 60, 60,
		]);
		expect(retryDelayMs(10_000)).toBe(MINUTE);
	});
});

describe("下一次尝试到点了吗", () => {
	const now = Date.UTC(2026, 0, 1);

	it("没排过、或排的时间已到就是到点了，没到就等", () => {
		expect(isRetryDue(null, now)).toBe(true);
		expect(isRetryDue(new Date(now), now)).toBe(true);
		expect(isRetryDue(new Date(now - 5 * SECOND), now)).toBe(true);
		expect(isRetryDue(new Date(now + 1), now)).toBe(false);
		expect(isRetryDue(new Date(now + MINUTE), now)).toBe(false);
	});

	it("排的时间比现在晚得超过最长的退避间隔：控制面时间往回跳了，不等", () => {
		expect(isRetryDue(new Date(now + MINUTE + 1), now)).toBe(true);
	});
});

describe("发送限速", () => {
	const t0 = Date.UTC(2026, 0, 1);

	/** 在 now 这一刻要发一个请求，请求瞬间就有了响应：能发就记下并返回 0，不能发返回还要等多少毫秒。 */
	const send = (limiter: SendRateLimiter, bot: string, now: number) => {
		const wait = limiter.waitMs(bot, now);
		if (wait === 0) limiter.record(bot, now);
		return wait;
	};

	/** 在 now 这一刻连续要发 count 条（每条瞬间有响应），返回其中放行了几条。 */
	const sendBurst = (limiter: SendRateLimiter, bot: string, now: number, count: number) => {
		let sent = 0;
		for (let i = 0; i < count; i++) if (send(limiter, bot, now) === 0) sent++;
		return sent;
	};

	it("每秒最多 5 条：同一时刻放行 5 条，第 6 条要等到最早的一条满 1 秒", () => {
		const limiter = new SendRateLimiter();
		expect(sendBurst(limiter, "ops", t0, 20)).toBe(5);
		expect(send(limiter, "ops", t0)).toBe(SECOND);
		expect(send(limiter, "ops", t0 + 400)).toBe(600);
		expect(send(limiter, "ops", t0 + SECOND - 1)).toBe(1);
		expect(sendBurst(limiter, "ops", t0 + SECOND, 20)).toBe(5);
	});

	it("窗口是滑动的：不同时刻发的，各自满 1 秒后才让出名额", () => {
		const limiter = new SendRateLimiter();
		for (const offset of [0, 200, 400, 600, 800]) expect(send(limiter, "ops", t0 + offset)).toBe(0);
		expect(send(limiter, "ops", t0 + 900)).toBe(100);
		expect(send(limiter, "ops", t0 + SECOND)).toBe(0);
		expect(send(limiter, "ops", t0 + SECOND)).toBe(200);
	});

	it("每分钟最多 100 条：第 101 条要等到最早的一条满 1 分钟，即使这一秒还有名额", () => {
		const limiter = new SendRateLimiter();
		let sent = 0;
		for (let second = 0; second < 25; second++)
			sent += sendBurst(limiter, "ops", t0 + second * SECOND, 5);
		expect(sent).toBe(100);
		expect(send(limiter, "ops", t0 + 25 * SECOND)).toBe(35 * SECOND);
		expect(send(limiter, "ops", t0 + MINUTE - 1)).toBe(1);
		expect(send(limiter, "ops", t0 + MINUTE)).toBe(0);
	});

	it("按响应回来的时刻计数：第 1 个请求 0.6 秒后才有响应，第 6 个要等到那之后满 1 秒", () => {
		const limiter = new SendRateLimiter();
		expect(limiter.waitMs("ops", t0)).toBe(0);
		limiter.record("ops", t0 + 600);
		expect(sendBurst(limiter, "ops", t0 + 600, 4)).toBe(4);
		expect(limiter.waitMs("ops", t0 + SECOND)).toBe(600);
		expect(limiter.waitMs("ops", t0 + 1600 - 1)).toBe(1);
		expect(limiter.waitMs("ops", t0 + 1600)).toBe(0);
	});

	it("只查不记：反复查询不占名额，发出去的请求有了结果才记", () => {
		const limiter = new SendRateLimiter();
		for (let i = 0; i < 20; i++) expect(limiter.waitMs("ops", t0)).toBe(0);
	});

	it.each([
		0, 40, 300, 700,
	])("请求一个接一个、每个耗时 %i 毫秒：飞书收到请求的时刻，不论落在发出到响应之间的哪里，都不超过每秒 5 个、每分钟 100 个", (duration) => {
		const limiter = new SendRateLimiter();
		const requests: Array<{ start: number; end: number }> = [];
		let now = t0;
		while (requests.length < 250) {
			const wait = limiter.waitMs("ops", now);
			if (wait > 0) {
				now += wait;
				continue;
			}
			const end = now + duration;
			limiter.record("ops", end);
			requests.push({ start: now, end });
			now = end;
		}

		// 最坏的情况：第 k 个在响应回来时才被飞书收到，后面第 5 个（第 100 个）一发出就被收到。
		for (const [k, request] of requests.entries()) {
			const fifth = requests[k + 5];
			if (fifth) expect(fifth.start - request.end).toBeGreaterThanOrEqual(SECOND);
			const hundredth = requests[k + 100];
			if (hundredth) expect(hundredth.start - request.end).toBeGreaterThanOrEqual(MINUTE);
		}
	});

	it("不同机器人各算各的", () => {
		const limiter = new SendRateLimiter();
		expect(sendBurst(limiter, "a", t0, 10)).toBe(5);
		expect(sendBurst(limiter, "b", t0, 10)).toBe(5);
	});

	it("没放行的请求不占名额", () => {
		const limiter = new SendRateLimiter();
		sendBurst(limiter, "ops", t0, 50);
		expect(sendBurst(limiter, "ops", t0 + SECOND, 50)).toBe(5);
	});

	it("控制面时间往回跳时，比现在还晚的记录作废，不会因此长时间发不出去", () => {
		const limiter = new SendRateLimiter();
		expect(sendBurst(limiter, "ops", t0 + 10 * MINUTE, 5)).toBe(5);
		expect(sendBurst(limiter, "ops", t0, 5)).toBe(5);
	});
});
