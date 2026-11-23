import { describe, expect, test } from "vitest";
import { type TokenState, tokenState } from "./state";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const token = (revoked_at: string | null, expires_at: string | null) => ({
	revoked_at,
	expires_at,
});

describe("tokenState：控制面认的是吊销和过期，列表照这两条给出状态", () => {
	test.each<[string, ReturnType<typeof token>, TokenState]>([
		["没有吊销、没有过期时间：有效", token(null, null), "active"],
		["过期时间还没到：有效", token(null, "2026-11-21T12:00:01Z"), "active"],
		[
			"过期时间正好是此刻：已过期（和控制面一样，到点就失效）",
			token(null, "2026-11-21T12:00:00Z"),
			"expired",
		],
		["过期时间已过：已过期", token(null, "2026-11-01T00:00:00Z"), "expired"],
		["已吊销：已吊销", token("2026-11-20T00:00:00Z", null), "revoked"],
		[
			"既吊销又过期：已吊销（吊销是人做的决定，优先说）",
			token("2026-11-20T00:00:00Z", "2026-11-01T00:00:00Z"),
			"revoked",
		],
	])("%s", (_name, view, expected) => {
		expect(tokenState(view, NOW)).toBe(expected);
	});
});
