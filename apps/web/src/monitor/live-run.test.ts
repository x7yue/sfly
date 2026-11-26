import type { RunView } from "@sfly/schema";
import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_POLL_MS } from "#/lib/polling";
import { runStatusQuery, runViewQuery } from "./live-run";

/**
 * TanStack Query 在加载时按 `window` 是否存在判断是不是服务端，服务端不定时重新读：测试环境没有 DOM，这个替身要在导入之前放好
 * （同 `actions/use-task-actions.test.ts`）。
 */
vi.hoisted(() => {
	const listeners = { addEventListener() {}, removeEventListener() {} };
	Object.assign(globalThis, {
		window: { document: { visibilityState: "visible", ...listeners }, ...listeners },
	});
});

// 会话页「成果」栏里每个运行的状态（#547）：**不开运行事件流**，在跑的定时重新读，结束了就不读。一个会话可以有很多运行，
// 每个在跑的运行开一条事件流的话，五个就占满浏览器对同源的 6 条连接，页面自己的发送、停止、结束会话排不上队。

const RUN = "00000000-0000-4000-8000-000000000001";
const view = (status: RunView["status"]): RunView => ({
	id: RUN,
	orchestration_id: "00000000-0000-4000-8000-0000000000f1",
	orchestration_version: 1,
	status,
	triggered_by: "tester",
	triggered_via: null,
	params: {},
	started_at: "2026-01-01T00:00:00.000Z",
	ended_at: status === "running" ? null : "2026-01-01T00:00:05.000Z",
	cancel: null,
	preset: null,
	run_notification: null,
	chains: [],
});

let reads: number;
let current: () => Promise<RunView>;
let sources: unknown[];
let client: QueryClient;

beforeEach(() => {
	reads = 0;
	sources = [];
	current = async () => view("running");
	vi.useFakeTimers();
	// 运行事件流是 EventSource：开了一条就记下来。
	vi.stubGlobal(
		"EventSource",
		class {
			constructor(...args: unknown[]) {
				sources.push(args);
			}
			close() {}
		},
	);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// 窗口焦点、网络状态的监听是挂载时接上的（页面上由 `QueryClientProvider` 挂载）。
	client.mount();
});

afterEach(() => {
	client.unmount();
	client.clear();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** 订阅一个运行的状态查询（和 `useRunStatus` 用同一份选项，请求换成计数的假的）。 */
function watch() {
	const observer = new QueryObserver(client, {
		...runStatusQuery(RUN),
		queryFn: () => {
			reads++;
			return current();
		},
	});
	const unsubscribe = observer.subscribe(() => {});
	return {
		status: () => observer.getCurrentResult().data?.status,
		stop: unsubscribe,
	};
}
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("成果栏里运行的状态：定时重新读，不开事件流", () => {
	it("和运行监控、运行抽屉是同一份缓存（同一个 query key）", () => {
		expect(runStatusQuery(RUN).queryKey).toEqual(runViewQuery(RUN).queryKey);
	});

	it("在跑的运行每 STATUS_POLL_MS 重新读一次，状态变了就跟着变；结束之后不再读", async () => {
		const run = watch();
		await advance(0);
		expect(reads).toBe(1);
		expect(run.status()).toBe("running");

		await advance(STATUS_POLL_MS);
		expect(reads).toBe(2);
		await advance(STATUS_POLL_MS);
		expect(reads).toBe(3);

		// 运行结束：下一次读到最终状态，之后不再读。
		current = async () => view("success");
		await advance(STATUS_POLL_MS);
		expect(reads).toBe(4);
		expect(run.status()).toBe("success");
		await advance(STATUS_POLL_MS * 10);
		expect(reads).toBe(4);
		run.stop();
	});

	it("没有开任何运行事件流：几个运行同时在跑也只是定时的请求", async () => {
		const watchers = [watch(), watch(), watch()];
		await advance(STATUS_POLL_MS * 3);
		expect(reads).toBeGreaterThan(0);
		expect(sources).toEqual([]);
		for (const w of watchers) w.stop();
	});

	it("第一次没读到（出错）时按间隔再读，读到之前不当作结束", async () => {
		let fail = true;
		current = async () => {
			if (fail) throw new Error("连不上");
			return view("running");
		};
		const run = watch();
		await advance(0);
		expect(run.status()).toBeUndefined();
		fail = false;
		await advance(STATUS_POLL_MS);
		expect(run.status()).toBe("running");
		run.stop();
	});

	it("结束了的运行不随挂载和窗口焦点重新读；在跑的会", async () => {
		const running = watch();
		await advance(0);
		expect(reads).toBe(1);
		focusManager.setFocused(false);
		focusManager.setFocused(true);
		await advance(0);
		expect(reads).toBe(2);

		current = async () => view("failed");
		await advance(STATUS_POLL_MS);
		expect(running.status()).toBe("failed");
		const done = reads;
		running.stop();

		// 页面再挂载一次（切换页签回来）、窗口重新获得焦点：缓存里是结束了的运行，不再读。
		const again = watch();
		await advance(0);
		focusManager.setFocused(false);
		focusManager.setFocused(true);
		await advance(STATUS_POLL_MS * 3);
		expect(reads).toBe(done);
		expect(again.status()).toBe("failed");
		again.stop();
	});
});
