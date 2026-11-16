import { QueryClient, QueryClientProvider, useQueries } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRefetchWhenPollingStops } from "./use-refetch-when-polling-stops";

/** 测试环境没有 DOM：同 `use-task-actions.test.ts`，挂载的组件不渲染任何节点，替身要在导入之前放好。 */
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

const key = (id: string) => ["item", id] as const;

/** 读一组项目，`polling` 里的每 1 秒重新读，并在它们不再轮询时再读一次。 */
function Probe({ ids, polling }: { ids: readonly string[]; polling: readonly string[] }) {
	useQueries({
		queries: ids.map((id) => ({
			queryKey: key(id),
			queryFn: async () => {
				reads.push(id);
				return id;
			},
			refetchInterval: polling.includes(id) ? 1000 : (false as const),
		})),
	});
	useRefetchWhenPollingStops(polling.map(key));
	return null;
}

let reads: string[];

beforeEach(() => {
	reads = [];
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function mount(next: { ids: readonly string[]; polling: readonly string[] }) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const root = createRoot(dom() as unknown as Element, {
		onUncaughtError: (error) => {
			throw error;
		},
	});
	const render = (props: typeof next) =>
		act(async () => {
			root.render(createElement(QueryClientProvider, { client }, createElement(Probe, props)));
			await vi.advanceTimersByTimeAsync(0);
		});
	await render(next);
	return {
		render,
		advance: (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms)),
		unmount: () => act(() => root.unmount()),
	};
}

describe("useRefetchWhenPollingStops", () => {
	it("几个在轮询的查询里一个不再轮询：只再读那一个一次，之后不再读它", async () => {
		const view = await mount({ ids: ["a", "b"], polling: ["a", "b"] });
		await view.advance(3000);
		const count = (id: string) => reads.filter((r) => r === id).length;
		const [a, b] = [count("a"), count("b")];
		expect(a).toBeGreaterThan(1);

		await view.render({ ids: ["a", "b"], polling: ["b"] });
		expect(count("a")).toBe(a + 1);
		expect(count("b")).toBe(b);

		await view.advance(10_000);
		expect(count("a")).toBe(a + 1);
		expect(count("b")).toBeGreaterThan(b);
		await view.unmount();
	});

	it("一直没有在轮询的查询，不再读", async () => {
		const view = await mount({ ids: ["a"], polling: [] });
		await view.advance(10_000);
		expect(reads).toEqual(["a"]);
		await view.render({ ids: ["a"], polling: [] });
		expect(reads).toEqual(["a"]);
		await view.unmount();
	});
});
