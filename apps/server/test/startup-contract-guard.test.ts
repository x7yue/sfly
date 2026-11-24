// 控制面启动时检查 HTTP 契约（`api.ts` 调用 `guardHttpContract`，ADR 0007、ADR 0029「一处检查」）：契约里有一条声明不合格的接口，
// 控制面起不来，不会悄悄成为没有检查的接口。`contract-route.ts` 自己的检查在 `access-scopes.test.ts`、`access-cross-project.test.ts` 里测；
// 这里测的是 `api.ts` 真的调用了它：起一个契约有问题的控制面，启动失败。去掉 `api.ts` 里的那次调用，这条就红。
import { describe, expect, it, vi } from "vitest";

vi.mock("@sfly/schema", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@sfly/schema")>();
	// 一个声明本身站得住（summary、effect、resource……）、只有访问规则不合格的接口：只读接口声明成了写。
	const readOnly = actual.httpContract.find((def) => def.resource.kind === "system");
	if (!readOnly) throw new Error("契约里没有 system 类的接口");
	const broken = {
		...readOnly,
		method: "POST",
		effect: "write",
	} as unknown as (typeof actual.httpContract)[number];
	return { ...actual, httpContract: [...actual.httpContract, broken] };
});

describe("控制面启动时检查 HTTP 契约", () => {
	it("契约里有不合格的接口：控制面不启动，说明写明哪条契约、什么问题", async () => {
		const { startTestControlPlane } = await import("./support/test-control-plane.js");
		await expect(startTestControlPlane()).rejects.toThrow(/HTTP 契约的声明有问题，控制面不启动/);
	}, 60_000);
});
