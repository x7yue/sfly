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

	describe("Hello 里 Agent 自己报的版本、系统、架构（#670）", () => {
		const hello = (fields: { agentVersion?: string; os?: string; arch?: string; name?: string }) =>
			message({ case: "hello", value: { name: "agent-a", ...fields } });
		const fieldsOf = (m: ReturnType<typeof message>) =>
			m.body.case === "hello"
				? { agentVersion: m.body.value.agentVersion, os: m.body.value.os, arch: m.body.value.arch }
				: undefined;
		// 字符都用码位造出来，不把看不见的字符直接写在源码里。
		const code = (...points: number[]) => String.fromCodePoint(...points);

		it("正常的值原样返回，不复制", () => {
			const ok = hello({ agentVersion: "0.5.0", os: "linux", arch: "x86_64" });
			expect(storable(ok)).toBe(ok);
		});

		it("含控制字符、8 位的控制序列、双向控制字符、零宽空格、标签字符、孤立的代理码元的，整段换成空串；别的字段不受牵连", () => {
			for (const bad of [
				`0.5.0${code(0x1b)}[2J`,
				`0.5.0${code(0x9b)}2J`,
				`0.5.0${code(0x85)}`,
				`0.5.0${code(0x202e)}`,
				`0.5.0${code(0x200b)}`,
				`0.5.0${code(0xe0067)}`,
				`0.5.0${code(0xd800)}`,
				`0.5.0${code(0x2800)}`,
				"0.5.0\n下一行",
			]) {
				expect(
					fieldsOf(storable(hello({ agentVersion: bad, os: "linux", arch: bad }))),
					JSON.stringify(bad),
				).toEqual({ agentVersion: "", os: "linux", arch: "" });
			}
		});

		it("超过 64 个字符的整段换成空串，正好 64 个的保留", () => {
			expect(fieldsOf(storable(hello({ os: "a".repeat(64) })))?.os).toBe("a".repeat(64));
			expect(fieldsOf(storable(hello({ os: "a".repeat(65) })))?.os).toBe("");
			// 按字符数算：64 个补充平面的字符（每个两个 UTF-16 码元）也是 64 个。
			const emoji = code(0x1f600).repeat(64);
			expect(fieldsOf(storable(hello({ os: emoji })))?.os).toBe(emoji);
		});

		it("正常的非 ASCII 文字和带零宽连接符的组合表情不受影响", () => {
			const ok = hello({ agentVersion: "0.5.0 测试版", os: code(0x1f469, 0x200d, 0x1f4bb) });
			expect(storable(ok)).toBe(ok);
		});
	});
});
