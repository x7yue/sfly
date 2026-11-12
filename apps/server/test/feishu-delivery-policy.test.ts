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

	/** 在 now 这一刻连续要发 count 条，返回其中放行了几条。 */
	const sendBurst = (limiter: SendRateLimiter, bot: string, now: number, count: number) => {
		let sent = 0;
		for (let i = 0; i < count; i++) if (limiter.acquire(bot, now) === 0) sent++;
		return sent;
	};

	it("每秒最多 5 条：同一时刻放行 5 条，第 6 条要等到最早的一条满 1 秒", () => {
		const limiter = new SendRateLimiter();
		expect(sendBurst(limiter, "ops", t0, 20)).toBe(5);
		expect(limiter.acquire("ops", t0)).toBe(SECOND);
		expect(limiter.acquire("ops", t0 + 400)).toBe(600);
		expect(limiter.acquire("ops", t0 + SECOND - 1)).toBe(1);
		expect(sendBurst(limiter, "ops", t0 + SECOND, 20)).toBe(5);
	});

	it("窗口是滑动的：不同时刻发的，各自满 1 秒后才让出名额", () => {
		const limiter = new SendRateLimiter();
		for (const offset of [0, 200, 400, 600, 800])
			expect(limiter.acquire("ops", t0 + offset)).toBe(0);
		expect(limiter.acquire("ops", t0 + 900)).toBe(100);
		expect(limiter.acquire("ops", t0 + SECOND)).toBe(0);
		expect(limiter.acquire("ops", t0 + SECOND)).toBe(200);
	});

	it("每分钟最多 100 条：第 101 条要等到最早的一条满 1 分钟，即使这一秒还有名额", () => {
		const limiter = new SendRateLimiter();
		let sent = 0;
		for (let second = 0; second < 25; second++)
			sent += sendBurst(limiter, "ops", t0 + second * SECOND, 5);
		expect(sent).toBe(100);
		expect(limiter.acquire("ops", t0 + 25 * SECOND)).toBe(35 * SECOND);
		expect(limiter.acquire("ops", t0 + MINUTE - 1)).toBe(1);
		expect(limiter.acquire("ops", t0 + MINUTE)).toBe(0);
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
