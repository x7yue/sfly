import type { SessionEvent } from "@sfly/schema";
import { installSessionStream, sessionView, stubSessionDetail } from "./assistant-support";
import { expect, test } from "./fixtures";

// 长会话的量法（#550，PR 里写明）：500 个工具行、每个结果 16 KB。只在设置了 SFLY_MEASURE=1 时跑（不进 CI：耗时的数字不做断言）。
//   SFLY_MEASURE=1 pnpm --filter @sfly/web exec playwright test e2e/session-long-measure.spec.ts
// 页面的会话历史是拦截的（控制面一次最多返回 200 条，500 个工具行要翻好几页；这里一次给全，量的是页面渲染它的代价）。
// 量两样：首屏渲染时间（导航开始到最后一行的结局画出来）、滚动掉帧（程序滚动整个时间线，量每一帧的间隔）。重复 N 次取中位数。
test.skip(process.env.SFLY_MEASURE !== "1", "只在设置了 SFLY_MEASURE=1 时跑");

const ROWS = Number(process.env.SFLY_MEASURE_ROWS ?? 500);
const RUNS = Number(process.env.SFLY_MEASURE_RUNS ?? 5);
const BIG = `${"x".repeat(79)}\n`.repeat((16 * 1024) / 80);

function events(rows: number): SessionEvent[] {
	const out: SessionEvent[] = [];
	let seq = 1;
	const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, seq % 50)).toISOString();
	out.push({
		type: "user_message",
		seq: seq++,
		at: at(),
		message_id: "5d1c0a7e-3b2f-4c68-9a41-000000000001",
		text: "跑一遍",
		steer: false,
		author: "alice",
		author_user_id: null,
	});
	out.push({ type: "turn_started", seq: seq++, at: at(), turn: 1 });
	for (let i = 0; i < rows; i++) {
		out.push({
			type: "tool_call",
			seq: seq++,
			at: at(),
			call_id: `c${i}`,
			tool: "command",
			title: `uv run pytest -q tests/test_${i}.py`,
		});
		out.push({
			type: "tool_result",
			seq: seq++,
			at: at(),
			call_id: `c${i}`,
			is_error: false,
			text: BIG,
			truncated: false,
			exit_code: 0,
			duration_ms: 100 + i,
		});
	}
	out.push({
		type: "turn_end",
		seq: seq++,
		at: at(),
		turn: 1,
		outcome: "completed",
		reason: "",
		duration_ms: 1000,
		steps: rows,
	} as SessionEvent);
	return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

test(`长会话：${ROWS} 个工具行，每个结果 16 KB`, async ({ page }) => {
	test.setTimeout(10 * 60_000);
	const view = sessionView({ status: "idle" });
	await installSessionStream(page);
	await stubSessionDetail(page, view, events(ROWS));
	const first: number[] = [];
	const streamed: number[] = [];
	const streamedOver: number[] = [];
	const frames: { longest: number[]; over: number[]; count: number[] } = {
		longest: [],
		over: [],
		count: [],
	};
	for (let run = 0; run < RUNS; run++) {
		const start = Date.now();
		await page.goto(`/sessions/${view.id}`);
		await expect(page.getByTestId("turn-end")).toBeVisible();
		await page.evaluate(
			() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
		);
		first.push(Date.now() - start);
		// 滚动：从底部一帧滚一屏，滚到顶再滚回底，量每一帧的间隔。
		const stat = await page.evaluate(async () => {
			const el = document.querySelector<HTMLElement>(
				'[data-testid="session-scroll"]',
			) as HTMLElement;
			const gaps: number[] = [];
			let last = performance.now();
			const step = el.clientHeight;
			const total = el.scrollHeight;
			await new Promise<void>((resolve) => {
				let position = el.scrollHeight;
				let direction = -1;
				const tick = (now: number) => {
					gaps.push(now - last);
					last = now;
					position += direction * step;
					if (position <= 0) direction = 1;
					el.scrollTop = Math.max(0, position);
					if (direction === 1 && position >= total) return resolve();
					requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
			return { gaps, nodes: document.querySelectorAll("*").length };
		});
		// 逐字出现：时间线已经有这么多行时，一帧来一段增量，量每一帧的间隔（行是 memo，只有最后那一条助手的话重新渲染）。
		const stream = await page.evaluate(async () => {
			const push = (window as unknown as { __sessionStream: { push(e: string, d: unknown): void } })
				.__sessionStream;
			const gaps: number[] = [];
			let last = performance.now();
			await new Promise<void>((resolve) => {
				let n = 0;
				const tick = (now: number) => {
					gaps.push(now - last);
					last = now;
					push.push("assistant_delta", { type: "assistant_delta", text: "新的一段话。" });
					if (++n >= 300) return resolve();
					requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
			return gaps;
		});
		streamed.push(Math.max(...stream));
		streamedOver.push(stream.filter((g) => g > 20).length);
		frames.longest.push(Math.max(...stat.gaps));
		frames.over.push(stat.gaps.filter((g) => g > 20).length);
		frames.count.push(stat.gaps.length);
		console.log(
			`run ${run}: first=${first.at(-1)}ms longestFrame=${frames.longest.at(-1)?.toFixed(1)}ms overBudget(>20ms)=${frames.over.at(-1)}/${frames.count.at(-1)} nodes=${stat.nodes}`,
		);
	}
	console.log(
		`MEDIAN streaming(300 deltas) longestFrame=${median(streamed).toFixed(1)}ms framesOver20ms=${median(streamedOver)}/300`,
	);
	console.log(
		`MEDIAN rows=${ROWS} first=${median(first)}ms longestFrame=${median(frames.longest).toFixed(1)}ms framesOver20ms=${median(frames.over)}/${median(frames.count)}`,
	);
});
