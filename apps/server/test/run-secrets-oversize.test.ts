// 保密值太多的运行，整个运行看得到原因（#657）：运行视图（`GET /runs/:id`）和运行摘要（`GET /runs/:id/summary`）有 `secrets_oversize`：
// 为 true 时这次运行里要打码的内容整段盖住，使用者据此知道为什么看到的全是 `******`；不含任何值。真实的控制面和假 Agent；值都是假值。
import { SECRET_MASK as MASK } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishBench } from "./support/focus-items.js";
import { withSecretLimits } from "./support/secret-limits.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("运行视图和运行摘要里的 secrets_oversize", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const scenario = (secret: boolean) => ({
		default_agent: "agent-a",
		nodes: [
			{
				id: "entry",
				kind: "entry",
				params: [{ name: "cfg", type: "json", ...(secret ? { secret: true } : {}) }],
			},
			{ id: "sa", kind: "package", package: "bench", node: "load" },
		],
		edges: [{ from: "entry", to: "sa", kind: "chain" }],
		packages: { bench: "1.0.0" },
	});
	const summaryOf = (runId: string) =>
		api.getJson<{ secrets_oversize?: boolean; failed_tasks: unknown[] }>(`/runs/${runId}/summary`);

	it("保密值的所有写法合计超过上限：两个接口都是 true；不太大的、没有保密参数的运行是 false；整段盖住的内容不含值", async () => {
		const bigValues = Array.from({ length: 50 }, (_, i) => `fake-oversize-${i}-${"p".repeat(100)}`);
		const bigId = await api.orchestrationWith(scenario(true));
		const plainId = await api.orchestrationWith(scenario(false));
		// 触发时值集合已经太大会被拒绝（#632），所以先触发，再把上限调小：和值集合在运行中才变大（子流程创建之后）是同一个状态
		const bigRun = await api.triggerOk(bigId, { cfg: bigValues });
		const smallRun = await api.triggerOk(bigId, { cfg: ["fake-small-secret-1"] });
		const plainRun = await api.triggerOk(plainId, { cfg: bigValues });
		await withSecretLimits({ automatonChars: 3000 }, async () => {
			expect((await api.run(bigRun)).secrets_oversize).toBe(true);
			expect((await api.run(smallRun)).secrets_oversize).toBe(false);
			expect((await api.run(plainRun)).secrets_oversize).toBe(false);
			expect((await summaryOf(bigRun)).secrets_oversize).toBe(true);
			expect((await summaryOf(smallRun)).secrets_oversize).toBe(false);
			expect((await summaryOf(plainRun)).secrets_oversize).toBe(false);
			// 运行视图里的保密参数照旧读成掩码，字段本身不含任何值
			const view = JSON.stringify(await api.run(bigRun));
			expect(view).not.toContain("fake-oversize");
			expect(view).toContain(MASK);
		});
	}, 60_000);
});
