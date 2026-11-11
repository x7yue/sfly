// 单元：Agent 消息里的 NUL 换成 U+FFFD（src/gateway/storable.ts，#207）。
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AgentMessageSchema, TaskStatus } from "@sfly/proto";
import { describe, expect, it } from "vitest";
import { storable } from "../src/gateway/storable.js";

const message = (body: MessageInitShape<typeof AgentMessageSchema>["body"]) =>
	create(AgentMessageSchema, { body });

const result = (outputsJson: string) =>
	message({
		case: "result",
		value: { taskId: "t", attempt: 1, status: TaskStatus.SUCCESS, outputsJson },
	});

const outputsOf = (m: ReturnType<typeof message>) =>
	m.body.case === "result" ? m.body.value.outputsJson : undefined;

describe("storable", () => {
	it("不含 NUL 的消息原样返回，不复制（包括每个指标点和它的标签）", () => {
		const metrics = message({
			case: "metrics",
			value: {
				taskId: "t",
				attempt: 1,
				points: [
					{ name: "tps", value: 1 },
					{ name: "conn", labels: { host: "db-1" }, value: 2 },
				],
			},
		});
		expect(storable(metrics)).toBe(metrics);
		const logs = message({
			case: "logs",
			value: { taskId: "t", attempt: 1, lines: [{ seq: 1n, text: "a\u0000b" }] },
		});
		expect(storable(logs)).toBe(logs);
		const ok = result('{"v":"a"}');
		expect(storable(ok)).toBe(ok);
	});

	it("只替换含 NUL 的点，其他点保持同一个对象", () => {
		const original = message({
			case: "metrics",
			value: {
				taskId: "t",
				attempt: 1,
				points: [
					{ name: "conn", labels: { host: "db-1" }, value: 1 },
					{ name: "conn", labels: { host: "db\u00002" }, value: 2 },
				],
			},
		});
		const cleaned = storable(original);
		if (cleaned.body.case !== "metrics" || original.body.case !== "metrics") throw new Error();
		expect(cleaned.body.value.points[0]).toBe(original.body.value.points[0]);
		expect(cleaned.body.value.points[1]?.labels).toEqual({ host: "db\uFFFD2" });
		expect(original.body.value.points[1]?.labels).toEqual({ host: "db\u00002" });
	});

	it("JSON 文本里的 \\u0000 转义：键和值都替换；字面的 \\\\u0000 与不合法的 JSON 原样保留", () => {
		expect(outputsOf(storable(result('{"k\\u0000":["\\u0000",{"x":"a\\u0000"}],"n":1}')))).toBe(
			'{"k\uFFFD":["\uFFFD",{"x":"a\uFFFD"}],"n":1}',
		);
		const literal = result('{"v":"\\\\u0000"}');
		expect(JSON.parse(outputsOf(storable(literal)) ?? "")).toEqual({ v: "\\u0000" });
		const invalid = result('{"v":"\\u0000"');
		expect(outputsOf(storable(invalid))).toBe('{"v":"\\u0000"');
	});
});
