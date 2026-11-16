import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActionSummary } from "./use-task-actions";

/**
 * 测试环境没有 DOM：挂载的组件不渲染任何节点，React 只用 `window` 取当前事件、用容器和它的 document 注册事件，请求层从 `localStorage` 读昵称。
 * TanStack Query 在加载时就按 `window` 是否存在判断是不是服务端，所以这个替身要在导入之前放好。
 */
const dom = vi.hoisted(() => {
	const listeners = { addEventListener() {}, removeEventListener() {} };
	const document = { nodeType: 9, activeElement: null, body: null, ...listeners };
	class HTMLIFrameElement {}
	Object.assign(globalThis, {
		window: {
			event: undefined,
			document,
			HTMLIFrameElement,
			localStorage: { getItem: () => null },
			...listeners,
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	return () => ({ nodeType: 1, tagName: "DIV", ownerDocument: document, ...listeners });
});

const emptySummary = {
	total: 0,
	marks: 0,
	reported: 0,
	capped: false,
	capped_at: null,
	agent_capped_at: null,
	names: [],
	running: [],
	running_complete: true,
	recent: [],
	recent_failed: [],
};

function Probe({ taskId, pollMs }: { taskId: string; pollMs: number | false }) {
	useActionSummary(taskId, pollMs);
	return null;
}

let reads: string[];

beforeEach(() => {
	reads = [];
	vi.useFakeTimers();
	vi.stubGlobal("fetch", async (url: string) => {
		reads.push(url);
		return Response.json(emptySummary);
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** 挂载 `useActionSummary`，返回按新的参数重新渲染、推进时间和卸载的函数。 */
async function mount(taskId: string, pollMs: number | false) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const root = createRoot(dom() as unknown as Element, {
		onUncaughtError: (error) => {
			throw error;
		},
	});
	const render = (next: { taskId: string; pollMs: number | false }) =>
		act(async () => {
			root.render(createElement(QueryClientProvider, { client }, createElement(Probe, next)));
			await vi.advanceTimersByTimeAsync(0);
		});
	await render({ taskId, pollMs });
	return {
		render,
		advance: (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms)),
		unmount: () => act(() => root.unmount()),
	};
}

describe("useActionSummary", () => {
	it("pollMs 从 1000 变成 false 时，正好再读一次，之后不再读", async () => {
		const view = await mount("t1", 1000);
		await view.advance(3000);
		const whilePolling = reads.length;
		expect(whilePolling).toBeGreaterThan(1);

		await view.render({ taskId: "t1", pollMs: false });
		expect(reads).toHaveLength(whilePolling + 1);

		await view.advance(10_000);
		expect(reads).toHaveLength(whilePolling + 1);
		await view.unmount();
	});

	it("一直不轮询（false）时，除了第一次读取不再读", async () => {
		const view = await mount("t1", false);
		await view.advance(10_000);
		expect(reads).toHaveLength(1);

		await view.render({ taskId: "t1", pollMs: false });
		expect(reads).toHaveLength(1);
		await view.unmount();
	});

	it("换了一个任务不算结束：只读新任务自己的第一次", async () => {
		const view = await mount("t1", 1000);
		await view.advance(3000);
		reads.length = 0;

		await view.render({ taskId: "t2", pollMs: false });
		expect(reads).toEqual(["/api/tasks/t2/actions/summary"]);
		await view.unmount();
	});
});
