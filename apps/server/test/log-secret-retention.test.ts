// 值集合的内存归它的缓存管（#517）：值集合连同它的自动机最多约 16 MiB 一份，缓存按字节数限住大小（secrets.ts 的 SET_CACHE_MAX_BYTES）；
// 缓存之外任何长期存在的东西（例如每个任务的日志状态）攥着一份，那一份就脱离了缓存的上限，进程里的堆外内存是「缓存的上限加上
// 这些攥着的」。这里用真实的控制面和假 Agent：很多个运行各一份不同的值集合，每个任务写日志、报进度，缓存的上限调到只放得下一份，
// 写完之后被缓存挤出去的值集合不再被任何地方引用（WeakRef 加回收）。值都是明显的假值。
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { LogLineView } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSecretSetCache } from "../src/logs/secrets.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { publishBench } from "./support/focus-items.js";
import { withSecretLimits } from "./support/secret-limits.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 控制面里取到过的值集合（有内容的），只留弱引用：`secretValues` 每次返回的对象。 */
const seen = vi.hoisted(() => ({ refs: [] as WeakRef<object>[], known: new WeakSet<object>() }));
vi.mock("../src/logs/secrets.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/logs/secrets.js")>();
	return {
		...original,
		secretValues: (...args: Parameters<typeof original.secretValues>) => {
			const set = original.secretValues(...args);
			if (set.texts.length > 0 && !seen.known.has(set)) {
				seen.known.add(set);
				seen.refs.push(new WeakRef(set));
			}
			return set;
		},
	};
});

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
/** 让出几次事件循环再回收（WeakRef 的目标在当前这一轮里不会被回收）。 */
const settle = async () => {
	for (let i = 0; i < 4; i++) {
		await new Promise((resolve) => setTimeout(resolve, 30));
		gc();
	}
};
const alive = () => seen.refs.filter((ref) => ref.deref() !== undefined).length;

describe("值集合不被缓存之外的东西攥着", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		seen.refs.length = 0;
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	it("几个运行各一份不同的值集合，每个任务写日志、报进度：缓存只放得下一份时，被挤出去的值集合没有别处引用，缓存清掉之后一份都不剩", async () => {
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "cfg", type: "json", secret: true }] },
				{ id: "sa", kind: "package", package: "bench", node: "load" },
			],
			edges: [{ from: "entry", to: "sa", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
		const RUNS = 6;
		await withSecretLimits({ cacheBytes: 1 }, async () => {
			for (let r = 0; r < RUNS; r++) {
				const values = Array.from(
					{ length: 50 },
					(_, i) => `fake-retention-${r}-${i}-${"v".repeat(40)}`,
				);
				await api.triggerOk(id, { cfg: values });
				const task = await agent.nextAssign();
				agent.logs(task, [
					{
						seq: 1n,
						timeUnixMs: BigInt(Date.UTC(2026, 0, 1)),
						source: LogSource.STDOUT,
						level: LogLevel.INFO,
						text: `run ${r} hello ${values[3]}`,
					},
				]);
				agent.progress(task, 1, 2, `step ${r}`);
				await eventually(async () => {
					const page = await api.getJson<{ lines: LogLineView[] }>(`/tasks/${task.taskId}/logs`);
					expect(page.lines.map((l) => l.text)).toEqual([`run ${r} hello ******`]);
				});
				await agent.succeed(task);
			}
			expect(seen.refs.length, "每个运行取到过自己的值集合").toBeGreaterThanOrEqual(RUNS);
			await settle();
			// 缓存最多留最新的一份：别的都被挤出去了，不能再被任务的日志状态之类的东西留着
			expect(alive()).toBeLessThanOrEqual(1);
			clearSecretSetCache();
			await settle();
			expect(alive()).toBe(0);
		});
	}, 120_000);
});
