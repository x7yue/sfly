// 产物合计的上限的配置（#477）：`SFLY_ARTIFACT_LIMIT_MB` 在控制面启动时就检查，不合法的值写明原因、不启动，
// 不留到派发时（`Infinity` 让每个包节点的任务以 config_error 失败；换算后超过 uint64 的值让下发 AssignTask 时序列化出错、
// gRPC 流断开、Agent 变成离线）。程序里直接给的选项（`startControlPlane({ artifactLimitBytes })`）检查同一个范围。
import { create, toBinary } from "@bufbuild/protobuf";
import { AssignTaskSchema } from "@sfly/proto";
import { describe, expect, it } from "vitest";
import {
	artifactLimitBytesFromMb,
	artifactLimitForWire,
	isArtifactLimitBytes,
	MAX_ARTIFACT_LIMIT_BYTES,
} from "../src/artifacts/artifact-store.js";
import { startTestControlPlane } from "./support/test-control-plane.js";

const MB = 1024 * 1024;
const MAX_UINT64 = 2n ** 64n - 1n;

describe("SFLY_ARTIFACT_LIMIT_MB 换算成字节", () => {
	it("没设置或空串：用默认值（undefined）", () => {
		expect(artifactLimitBytesFromMb(undefined)).toBeUndefined();
		expect(artifactLimitBytesFromMb("")).toBeUndefined();
	});

	it("合法的值：按 1024 × 1024 换算，可以带小数，不到整字节的部分舍去", () => {
		expect(artifactLimitBytesFromMb("1024")).toBe(1024 * MB);
		expect(artifactLimitBytesFromMb("0.5")).toBe(MB / 2);
		expect(artifactLimitBytesFromMb("1e3")).toBe(1000 * MB);
		expect(artifactLimitBytesFromMb(" 2 ")).toBe(2 * MB);
		expect(artifactLimitBytesFromMb("0.0000010000001")).toBe(1);
	});

	it("能表示的最大值可以，再大一个 MB 就不行", () => {
		const largestMb = Math.floor(MAX_ARTIFACT_LIMIT_BYTES / MB);
		expect(artifactLimitBytesFromMb(String(largestMb))).toBe(largestMb * MB);
		expect(() => artifactLimitBytesFromMb(String(largestMb + 1))).toThrow(/SFLY_ARTIFACT_LIMIT_MB/);
	});

	it.each([
		["Infinity", "Infinity"],
		["-Infinity", "-Infinity"],
		["NaN", "NaN"],
		["不是数", "abc"],
		["零", "0"],
		["负数", "-5"],
		["超过 uint64 的量级", "1e14"],
		["很大的有限数", "1e300"],
		["换算后不到 1 字节", "0.0000001"],
	])("%s：报错，写明是哪个设置和填的原文", (_, raw) => {
		expect(() => artifactLimitBytesFromMb(raw)).toThrow(
			new RegExp(
				`SFLY_ARTIFACT_LIMIT_MB 不合法[\\s\\S]*${JSON.stringify(raw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
			),
		);
	});

	it("错误信息写明合法的范围", () => {
		expect(() => artifactLimitBytesFromMb("Infinity")).toThrow(
			`1 到 ${MAX_ARTIFACT_LIMIT_BYTES} 之间的整数`,
		);
	});
});

describe("上限的范围检查", () => {
	it("1 到 2^53 − 1 之间的整数合格，其余不合格", () => {
		for (const ok of [1, 1000, 1024 * MB, MAX_ARTIFACT_LIMIT_BYTES]) {
			expect(isArtifactLimitBytes(ok), String(ok)).toBe(true);
		}
		for (const bad of [
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			MAX_ARTIFACT_LIMIT_BYTES + 1,
			1e14 * MB,
			"1000",
			null,
			undefined,
		]) {
			expect(isArtifactLimitBytes(bad), String(bad)).toBe(false);
		}
	});
});

describe("下发给 Agent 的上限夹在 uint64 以内", () => {
	it("正常的值原样下发", () => {
		expect(artifactLimitForWire(1000)).toBe(1000n);
		expect(artifactLimitForWire(MAX_ARTIFACT_LIMIT_BYTES)).toBe(BigInt(MAX_ARTIFACT_LIMIT_BYTES));
	});

	it("0、负数、不到 1 的小数、NaN、不是数的值抛出：不悄悄换成「没有上限」", () => {
		for (const bad of [0, -1, -Infinity, 0.5, Number.NaN, "1000", null, undefined]) {
			expect(() => artifactLimitForWire(bad as number), String(bad)).toThrow(/不合法/);
		}
	});

	it("Infinity、超过 uint64 的值夹到最大值：序列化 AssignTask 不会出错", () => {
		for (const wild of [Number.POSITIVE_INFINITY, 1e30, 1e14 * MB]) {
			const wire = artifactLimitForWire(wild);
			expect(wire, String(wild)).toBe(MAX_UINT64);
			expect(() =>
				toBinary(
					AssignTaskSchema,
					create(AssignTaskSchema, { taskId: "t", artifactLimitBytes: wire }),
				),
			).not.toThrow();
		}
	});
});

describe("控制面启动时检查上限的选项", () => {
	it.each([
		["Infinity", Number.POSITIVE_INFINITY],
		["超过 uint64 的量级", 1e14 * MB],
		["超过 2^53 − 1", MAX_ARTIFACT_LIMIT_BYTES + 2],
		["NaN", Number.NaN],
		["零", 0],
		["小数", 1.5],
		["负数", -1],
	])("%s：控制面不启动，写明原因", async (_, value) => {
		await expect(startTestControlPlane({ artifactLimitBytes: value })).rejects.toThrow(
			/artifactLimitBytes 不合法/,
		);
	});

	it("合法的值照常启动", async () => {
		const cp = await startTestControlPlane({ artifactLimitBytes: MAX_ARTIFACT_LIMIT_BYTES });
		await cp.close();
	});
});
