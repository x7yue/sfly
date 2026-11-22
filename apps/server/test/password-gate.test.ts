// 密码验证的并发闸（PR #555 的独立审查：scrypt 走 libuv 的线程池，一阵并发的登录会把文件读写拖慢十几秒）。
import { describe, expect, it } from "vitest";
import { PasswordGate, PasswordGateAborted, PasswordGateBusy } from "../src/auth/password-gate.js";

/** 一个手动放行的任务：测试里数着同时有几个在跑。 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("密码验证的并发闸", () => {
	it("同时最多算 concurrency 个，其余排队，先到先得；一个算完下一个才开始", async () => {
		const gate = new PasswordGate({ concurrency: 2, maxQueue: 10 });
		const started: number[] = [];
		const finishers = Array.from({ length: 5 }, () => deferred<number>());
		const results = finishers.map((finisher, i) =>
			gate.run(async () => {
				started.push(i);
				return finisher.promise;
			}),
		);
		await tick();
		expect(started).toEqual([0, 1]);
		expect(gate.active).toBe(2);
		expect(gate.waiting).toBe(3);
		finishers[0]?.resolve(10);
		await tick();
		expect(started).toEqual([0, 1, 2]);
		expect(gate.active).toBe(2);
		finishers[1]?.resolve(11);
		finishers[2]?.resolve(12);
		await tick();
		expect(started).toEqual([0, 1, 2, 3, 4]);
		finishers[3]?.resolve(13);
		finishers[4]?.resolve(14);
		expect(await Promise.all(results)).toEqual([10, 11, 12, 13, 14]);
		expect(gate.active).toBe(0);
		expect(gate.waiting).toBe(0);
	});

	it("在算的和排队的都满了：再来的直接拒绝（PasswordGateBusy，带建议的等待时间），不运行任务；空下来之后又能进", async () => {
		const gate = new PasswordGate({ concurrency: 1, maxQueue: 2, retryAfterMs: 3000 });
		const blockers = [deferred<void>(), deferred<void>(), deferred<void>()];
		let ran = 0;
		const accepted = blockers.map((blocker) =>
			gate.run(async () => {
				ran += 1;
				await blocker.promise;
			}),
		);
		await tick();
		expect([gate.active, gate.waiting]).toEqual([1, 2]);
		let refusedRan = false;
		const refused = gate.run(async () => {
			refusedRan = true;
		});
		await expect(refused).rejects.toBeInstanceOf(PasswordGateBusy);
		await expect(refused).rejects.toMatchObject({ retryAfterMs: 3000 });
		expect(refusedRan).toBe(false);
		for (const blocker of blockers) blocker.resolve();
		await Promise.all(accepted);
		expect(ran).toBe(3);
		expect(await gate.run(async () => "又能进了")).toBe("又能进了");
	});

	it("任务抛错也释放名额；错误原样抛给调用方", async () => {
		const gate = new PasswordGate({ concurrency: 1, maxQueue: 1 });
		await expect(
			gate.run(async () => {
				throw new Error("scrypt 出错");
			}),
		).rejects.toThrow("scrypt 出错");
		expect(gate.active).toBe(0);
		expect(await gate.run(async () => 1)).toBe(1);
		// 排队的那个：前面的抛错，它照常轮到。
		const first = deferred<void>();
		const failing = gate.run(() => first.promise);
		const queued = gate.run(async () => "轮到我了");
		first.reject(new Error("前一个失败"));
		await expect(failing).rejects.toThrow("前一个失败");
		expect(await queued).toBe("轮到我了");
	});

	it("maxQueue 是 0：只有空闲的名额能进，没有排队", async () => {
		const gate = new PasswordGate({ concurrency: 1, maxQueue: 0 });
		const hold = deferred<void>();
		const running = gate.run(() => hold.promise);
		await tick();
		await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(PasswordGateBusy);
		hold.resolve();
		await running;
	});

	it("默认值：同时 2 个，最多排 16 个", async () => {
		const gate = new PasswordGate();
		const hold = deferred<void>();
		const all = Array.from({ length: 18 }, () => gate.run(() => hold.promise));
		await tick();
		expect([gate.active, gate.waiting]).toEqual([2, 16]);
		await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(PasswordGateBusy);
		hold.resolve();
		await Promise.all(all);
	});

	// PR #555 的差异复审：客户端断开之后，排队的请求不该继续占着闸。
	describe("客户端断开（中止信号）", () => {
		it("进闸时信号已经中止：直接抛 PasswordGateAborted，不运行任务，不占名额也不占队列", async () => {
			const gate = new PasswordGate({ concurrency: 1, maxQueue: 1 });
			const controller = new AbortController();
			controller.abort();
			let ran = false;
			await expect(
				gate.run(async () => {
					ran = true;
				}, controller.signal),
			).rejects.toBeInstanceOf(PasswordGateAborted);
			expect(ran).toBe(false);
			expect([gate.active, gate.waiting]).toEqual([0, 0]);
		});

		it("排队时信号中止：马上退出队列（队列腾出位置，后来的不被 503），任务一直不运行", async () => {
			const gate = new PasswordGate({ concurrency: 1, maxQueue: 2 });
			const hold = deferred<void>();
			const running = gate.run(() => hold.promise);
			const controllers = [new AbortController(), new AbortController()];
			const ran: number[] = [];
			const queued = controllers.map((controller, i) =>
				gate.run(async () => {
					ran.push(i);
				}, controller.signal),
			);
			const settled = queued.map((promise) =>
				promise.then(
					() => "ran",
					(e: unknown) => e,
				),
			);
			await tick();
			expect([gate.active, gate.waiting]).toEqual([1, 2]);
			// 队列满了：再来一个正常的请求被拒绝。
			await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(PasswordGateBusy);

			for (const controller of controllers) controller.abort();
			const outcomes = await Promise.all(settled);
			expect(outcomes.every((e) => e instanceof PasswordGateAborted)).toBe(true);
			// 断开的请求马上让出了队列：现在能排进来，而且轮到它时不用等断开的那些。
			expect([gate.active, gate.waiting]).toEqual([1, 0]);
			const next = gate.run(async () => "后来的");
			await tick();
			expect(gate.waiting).toBe(1);
			hold.resolve();
			await running;
			expect(await next).toBe("后来的");
			expect(ran).toEqual([]);
			expect([gate.active, gate.waiting]).toEqual([0, 0]);
		});

		it("排队的 16 个都断开：后面一个正常的请求在前一个算完之后立刻轮到，不用等那 16 个", async () => {
			const gate = new PasswordGate({ concurrency: 1, maxQueue: 16 });
			const hold = deferred<void>();
			const running = gate.run(() => hold.promise);
			const controller = new AbortController();
			const dropped = Array.from({ length: 16 }, () =>
				gate.run(() => new Promise<void>((resolve) => setTimeout(resolve, 50)), controller.signal),
			);
			const swallowed = dropped.map((promise) => promise.catch(() => undefined));
			await tick();
			const started: string[] = [];
			const normal = gate
				.run(async () => {
					started.push("正常的请求");
				})
				.catch((error: unknown) => error);
			// 队列已满（16 个），正常的请求本来要被拒绝；断开之后才有位置。
			expect(await normal).toBeInstanceOf(PasswordGateBusy);
			controller.abort();
			await Promise.all(swallowed);
			const later = gate.run(async () => {
				started.push("断开之后的请求");
			});
			hold.resolve();
			await running;
			await later;
			// 前一个一算完它就轮到，中间没有再跑任何一个断开的任务。
			expect(started).toEqual(["断开之后的请求"]);
		});

		it("已经在算的那一个不被打断：中止信号只管还没开始的，算完的结果照常返回", async () => {
			const gate = new PasswordGate({ concurrency: 1, maxQueue: 1 });
			const controller = new AbortController();
			const finish = deferred<string>();
			const running = gate.run(() => finish.promise, controller.signal);
			await tick();
			controller.abort();
			finish.resolve("算完了");
			expect(await running).toBe("算完了");
			expect(gate.active).toBe(0);
		});

		it("轮到它的那一刻之前信号才中止、之后的排队顺序不乱：断开的只让出自己的位置，其余先到先得", async () => {
			const gate = new PasswordGate({ concurrency: 1, maxQueue: 5 });
			const hold = deferred<void>();
			const running = gate.run(() => hold.promise);
			const controller = new AbortController();
			const order: string[] = [];
			const first = gate.run(async () => {
				order.push("a");
			});
			const dropped = gate
				.run(async () => {
					order.push("b");
				}, controller.signal)
				.catch(() => undefined);
			const third = gate.run(async () => {
				order.push("c");
			});
			await tick();
			controller.abort();
			await dropped;
			hold.resolve();
			await Promise.all([running, first, third]);
			expect(order).toEqual(["a", "c"]);
		});
	});
});
