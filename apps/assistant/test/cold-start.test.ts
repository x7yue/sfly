// 冷启动要多久（控制面发 prompt 只等 10 秒，所以助手服务先回应再拉起 pi）：真的 pi、打包好的扩展、假的工作台，
// 量「收到这句话 → 新起的 pi 接受它」（写 skill、起进程、加载扩展）。只记下来（耗时不作断言区间），PR 里贴这几个数。
import { afterAll, beforeAll, expect, it } from "vitest";
import { Harness } from "./support/harness.js";

let h: Harness;
beforeAll(async () => {
	h = await Harness.start();
}, 120_000);
afterAll(async () => {
	await h?.close();
});

it("prompt 立刻回应 202，冷启动的用时写进日志", async () => {
	const samples: number[] = [];
	for (let i = 0; i < 3; i++) {
		const id = crypto.randomUUID();
		const sent = Date.now();
		const res = await h.prompt(id, { text: "你好" });
		const replied = Date.now() - sent;
		expect(res.status).toBe(202);
		// 回应不等 pi 起来：只作上限（远小于控制面等的 10 秒）。
		expect(replied).toBeLessThan(2000);
		await h.turnEnd(id);
		const line = h.logs.find((l) => l.includes(id) && l.includes("冷启动"));
		samples.push(Number(/冷启动 (\d+) 毫秒/.exec(line ?? "")?.[1]));
	}
	expect(samples.every((ms) => Number.isFinite(ms))).toBe(true);
	console.log(`冷启动（毫秒）：${samples.join("、")}`);
}, 120_000);
