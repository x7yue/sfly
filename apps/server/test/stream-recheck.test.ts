// 打开着的事件流定期重新检查凭据（src/sse/stream-recheck.ts）的一处竞态（#596）：重新检查先拿「现在打开着的流」的凭据去查库，
// 查询是异步的，等它回来的这段时间里新打开的流（凭据不在这次查的名单里）不能被当成「凭据已失效」关掉。
// 不起 HTTP 服务、不连数据库：流和存储都是假的，查询的结果由测试放行，竞态的时机由测试定。
import { describe, expect, it } from "vitest";
import type { AccessStore } from "../src/auth/access-store.js";
import type { Sse, StreamIdentity } from "../src/sse/sse.js";
import { recheckStreams } from "../src/sse/stream-recheck.js";

/** 一组打开着的流：只实现重新检查用到的两个方法。 */
class FakeSse {
	readonly streams: Array<{ name: string; identity: StreamIdentity; closed: boolean }> = [];
	open(name: string, identity: Partial<StreamIdentity>): void {
		this.streams.push({
			name,
			identity: { userId: null, loginId: null, tokenId: null, ...identity },
			closed: false,
		});
	}
	identities(): StreamIdentity[] {
		return this.streams.filter((s) => !s.closed).map((s) => s.identity);
	}
	closeWhere(predicate: (identity: StreamIdentity) => boolean): number {
		let closed = 0;
		for (const stream of this.streams) {
			if (!stream.closed && predicate(stream.identity)) {
				stream.closed = true;
				closed++;
			}
		}
		return closed;
	}
	get closedNames(): string[] {
		return this.streams.filter((s) => s.closed).map((s) => s.name);
	}
}

/** 一次查询由测试放行：`release` 给出这次查询的结果。 */
function gatedStore() {
	const queries: Array<{ loginIds: string[]; tokenIds: string[] }> = [];
	const pending: Array<(live: { loginIds: string[]; tokenIds: string[] }) => void> = [];
	const store = {
		liveCredentials(ids: { loginIds: readonly string[]; tokenIds: readonly string[] }) {
			queries.push({ loginIds: [...ids.loginIds], tokenIds: [...ids.tokenIds] });
			return new Promise<{ loginIds: Set<string>; tokenIds: Set<string> }>((resolve) => {
				pending.push((live) =>
					resolve({ loginIds: new Set(live.loginIds), tokenIds: new Set(live.tokenIds) }),
				);
			});
		},
	} as unknown as AccessStore;
	return {
		store,
		queries,
		release: (live: { loginIds: string[]; tokenIds: string[] }) => pending.shift()?.(live),
	};
}

const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
const run = (sse: FakeSse, store: AccessStore) =>
	recheckStreams({ sse: sse as unknown as Sse, store, clock });
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("重新检查打开着的流的凭据", () => {
	it("查询期间新打开的流（凭据不在这次查的名单里）不会被误关，下一次检查才查它", async () => {
		const sse = new FakeSse();
		const { store, queries, release } = gatedStore();
		sse.open("早就打开的", { loginId: "login-a" });
		const checking = run(sse, store);
		await settle();
		// 查询还没回来：另一个用户的流打开了（登录 b 有效，但不在这次查的名单里）。
		expect(queries).toEqual([{ loginIds: ["login-a"], tokenIds: [] }]);
		sse.open("刚打开的", { loginId: "login-b" });
		release({ loginIds: ["login-a"], tokenIds: [] });
		expect(await checking).toBe(0);
		expect(sse.closedNames).toEqual([]);
		// 下一次检查：两条都在名单里，都有效，都不关。
		const second = run(sse, store);
		await settle();
		expect(queries[1]).toEqual({ loginIds: ["login-a", "login-b"], tokenIds: [] });
		release({ loginIds: ["login-a", "login-b"], tokenIds: [] });
		expect(await second).toBe(0);
	});

	it("令牌的流也一样：查询期间新打开的令牌的流不会被误关", async () => {
		const sse = new FakeSse();
		const { store, release } = gatedStore();
		sse.open("早就打开的", { tokenId: "token-a" });
		const checking = run(sse, store);
		await settle();
		sse.open("刚打开的", { tokenId: "token-b" });
		release({ loginIds: [], tokenIds: ["token-a"] });
		expect(await checking).toBe(0);
		expect(sse.closedNames).toEqual([]);
	});

	it("查出已经失效的登录和令牌，关掉用它们的流；有效的、没查的都不动", async () => {
		const sse = new FakeSse();
		const { store, release } = gatedStore();
		sse.open("登录失效", { loginId: "login-dead" });
		sse.open("登录有效", { loginId: "login-live" });
		sse.open("令牌失效", { tokenId: "token-dead" });
		sse.open("令牌有效", { tokenId: "token-live" });
		sse.open("同一个失效登录的另一条流", { loginId: "login-dead" });
		const checking = run(sse, store);
		await settle();
		sse.open("查询期间打开的，登录已经失效", { loginId: "login-dead-late" });
		release({ loginIds: ["login-live"], tokenIds: ["token-live"] });
		expect(await checking).toBe(3);
		expect(sse.closedNames.sort()).toEqual(
			["令牌失效", "登录失效", "同一个失效登录的另一条流"].sort(),
		);
		// 查询期间才打开的、登录已经失效的那条：这次不查它，下一次检查关掉。
		const second = run(sse, store);
		await settle();
		release({ loginIds: ["login-live"], tokenIds: ["token-live"] });
		expect(await second).toBe(1);
		expect(sse.closedNames).toContain("查询期间打开的，登录已经失效");
	});

	it("没有带凭据的流：不查库", async () => {
		const sse = new FakeSse();
		const { store, queries } = gatedStore();
		sse.open("没有身份的", {});
		expect(await run(sse, store)).toBe(0);
		expect(queries).toEqual([]);
	});
});
