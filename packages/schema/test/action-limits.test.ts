import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_LIMITS } from "../src/index.js";

const sdk = readFileSync(
	join(import.meta.dirname, "../../../sdk/python/src/sfly/actions.py"),
	"utf8",
);

/** SDK 里的同名常量。 */
const SDK_NAME: Record<keyof typeof ACTION_LIMITS, string> = {
	nameChars: "MAX_NAME_CHARS",
	valueChars: "MAX_VALUE_CHARS",
	reasonChars: "MAX_REASON_CHARS",
	fields: "MAX_FIELDS",
	perName: "MAX_PER_NAME",
	total: "MAX_TOTAL",
	running: "RUNNING_LIMIT",
	recent: "RECENT_LIMIT",
	recentFailed: "RECENT_FAILED_LIMIT",
};

const sdkConstant = (name: string): number | undefined => {
	const value = new RegExp(`^${name} = ([\\d_]+)$`, "m").exec(sdk)?.[1];
	return value === undefined ? undefined : Number(value.replaceAll("_", ""));
};

describe("动作的上限", () => {
	it("和 SDK 的常量一致", () => {
		for (const [key, name] of Object.entries(SDK_NAME)) {
			expect(sdkConstant(name), name).toBe(ACTION_LIMITS[key as keyof typeof ACTION_LIMITS]);
		}
	});
});
