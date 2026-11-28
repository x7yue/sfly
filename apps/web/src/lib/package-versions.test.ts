import type { PackageSummary } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { latestVersion } from "./package-versions";

const pkg = (name: string, latest: string, versions: string[]): PackageSummary => ({
	name,
	latest_version: latest,
	versions: versions.map((version) => ({
		version,
		sha256: "0".repeat(64),
		size: 1,
		published_at: "2026-01-01T00:00:00.000Z",
		nodes: [],
		locked_orchestrations: 0,
	})),
});

describe("节点包的最新版本（#434）", () => {
	it("用控制面标出的 latest_version，不再自己按版本号或发布时间算", () => {
		// 列表按发布时间从新到旧：1.9.1 是最近发布的，最新版本是 1.10.0。
		const packages = [pkg("bench", "1.10.0", ["1.9.1", "1.10.0"])];
		expect(latestVersion(packages, "bench")).toBe("1.10.0");
		expect(latestVersion(packages, "nope")).toBeUndefined();
		expect(latestVersion(undefined, "bench")).toBeUndefined();
	});
});
