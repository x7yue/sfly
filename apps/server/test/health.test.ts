import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("控制面健康检查", () => {
	let cp: TestControlPlane | undefined;
	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it("在全新的数据库上启动后报告健康，并使用注入的时钟", async () => {
		const clock = new ManualClock("2026-03-04T05:06:07.000Z");
		cp = await startTestControlPlane({ clock });

		const res = await cp.fetch("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: "ok",
			database: "ok",
			time: "2026-03-04T05:06:07.000Z",
		});

		clock.advance(60_000);
		const later = (await (await cp.fetch("/health")).json()) as { time: string };
		expect(later.time).toBe("2026-03-04T05:07:07.000Z");
	});

	it("在同一个数据库上重启时迁移不会重复执行", async () => {
		cp = await startTestControlPlane();
		await cp.restart();
		const res = await cp.fetch("/health");
		expect(res.status).toBe(200);
	});

	it("数据库不可用时返回 503", async () => {
		cp = await startTestControlPlane();
		await cp.database.drop();

		const res = await cp.fetch("/health");
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ status: "unavailable", database: "unavailable" });
	});
});
