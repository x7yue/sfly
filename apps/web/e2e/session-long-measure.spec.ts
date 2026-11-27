import type { Page } from "@playwright/test";
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

// 逐字出现（审查 #762 指出第一版的量法会话是空闲的，`assistant_delta` 在一轮不在进行时被丢掉，量到的不是逐字出现）：这里会话是「在做」，
// 先流进 `STREAM_KB` KB 的 Markdown（标题、列表、行内代码、链接、加粗混排）建出一条长的助手的话，时间线上另有 `ROWS` 个工具行；
// 然后每帧推一小段增量（共 300 个），量**主线程每个增量真正忙多久**：用 CDP 的 CPU 采样，去掉 `(idle)`，剩下的（脚本、样式布局、垃圾回收）除以 300。
// **不量帧间隔**：每帧往 SSE 流里塞数据会让无头 Chromium 的 rAF 变成两个 vsync 一帧（约 30 毫秒），连「推一个不改变状态的事件」都是这样，
// 那个数字与页面的开销无关（试过：0 KB 也是 30 毫秒，不推事件是 16 毫秒）。
// 每一段增量都让这一条整条重新解析（`react-markdown` 不做增量解析），所以开销随这一条的长度涨；`STREAM_PARSE_INTERVAL_MS` 节流之后降下来。
/** 等到助手的话不再变长（连着两次读到一样长）：增量都显示出来了。 */
async function settled(page: Page) {
	let previous = -1;
	await expect
		.poll(async () => {
			const length = (await page.getByTestId("assistant-message").textContent())?.length ?? 0;
			const same = length === previous;
			previous = length;
			return same;
		})
		.toBe(true);
}

const STREAM_KB = Number(process.env.SFLY_MEASURE_STREAM_KB ?? 20);
const PARAGRAPH =
	"## 小结\n\n- 改了 `nodes/http_check.py`：新增参数 **timeout**（秒，默认 30）\n- 补了 [用户文档](https://example.com/docs) 里的例子\n- 两个用例通过：`tests/test_timeout.py`\n\n下一步是把场景保存成新版本，再跑两遍看结果；如果还有超时，再把默认值调大一点。\n\n";

test(`逐字出现：一条 ${STREAM_KB} KB 的助手的话，时间线上有 ${ROWS} 个工具行，主线程每个增量忙多久`, async ({
	page,
}) => {
	test.setTimeout(10 * 60_000);
	const view = sessionView({ status: "running" });
	await installSessionStream(page);
	await stubSessionDetail(
		page,
		view,
		events(ROWS).filter((e) => e.type !== "turn_end"),
	);
	const perDelta: number[] = [];
	for (let run = 0; run < RUNS; run++) {
		await page.goto(`/sessions/${view.id}`);
		await expect(page.getByTestId("user-message")).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(window as unknown as { __sessionStream: { opened: number } }).__sessionStream.opened,
				),
			)
			.toBeGreaterThan(0);
		// 先流进 STREAM_KB KB：每帧一段。
		await page.evaluate(
			async ([paragraph, kb]) => {
				const push = (
					window as unknown as { __sessionStream: { push(e: string, d: unknown): void } }
				).__sessionStream;
				let sent = 0;
				while (sent < kb * 1024) {
					push.push("assistant_delta", { type: "assistant_delta", text: paragraph });
					sent += new TextEncoder().encode(paragraph).length;
					await new Promise((r) => requestAnimationFrame(r));
				}
			},
			[PARAGRAPH, STREAM_KB] as const,
		);
		// 让页面赶上来（节流的间隔、最后一次解析都做完）：这一条的文字不再变长。
		await settled(page);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
		await cdp.send("Profiler.start");
		await page.evaluate(async () => {
			const push = (window as unknown as { __sessionStream: { push(e: string, d: unknown): void } })
				.__sessionStream;
			for (let i = 0; i < 300; i++) {
				push.push("assistant_delta", { type: "assistant_delta", text: "再多一小段话，" });
				await new Promise((r) => requestAnimationFrame(r));
			}
		});
		await settled(page);
		const { profile } = await cdp.send("Profiler.stop");
		await cdp.detach();
		const byId = new Map(profile.nodes.map((n) => [n.id, n]));
		let busy = 0;
		(profile.samples ?? []).forEach((id, i) => {
			const node = byId.get(id);
			if (node && node.callFrame.functionName !== "(idle)")
				busy += (profile.timeDeltas ?? [])[i] ?? 0;
		});
		perDelta.push(busy / 1000 / 300);
		console.log(`stream run ${run}: busy=${perDelta.at(-1)?.toFixed(2)}ms per delta`);
	}
	console.log(
		`MEDIAN stream ${STREAM_KB}KB rows=${ROWS}: mainThreadBusyPerDelta=${median(perDelta).toFixed(2)}ms（一帧 16.7 ms）`,
	);
});
