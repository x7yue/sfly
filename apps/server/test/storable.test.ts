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

	// 逐个字段的归类：短的标识类（含表里的字符或超长，整段换成空串）、长的自由文字（表里的字符写成 \\uXXXX，超长截断）。
	describe("Hello 里别的自报字段（#670）", () => {
		const code = (...points: number[]) => String.fromCodePoint(...points);
		const BAD = `x${code(0x9b)}2J${code(0x202e)}`;
		const helloWith = (fields: Record<string, unknown>) =>
			message({ case: "hello", value: { name: "agent-a", ...fields } } as never);
		const helloOf = (m: ReturnType<typeof message>) => {
			if (m.body.case !== "hello") throw new Error("not hello");
			return m.body.value;
		};

		it("短的标识类：已安装节点包的名字和版本、开发包的名字、能力名、对外地址：含表里的字符整段换成空串，超长整段换成空串，正常的原样", () => {
			const cleaned = helloOf(
				storable(
					helloWith({
						installedPackages: [
							{ name: BAD, version: "1.0.0" },
							{ name: "pkg-ok", version: BAD },
							{ name: "a".repeat(129), version: "1.0.0" },
							{ name: "a".repeat(128), version: "1".repeat(65) },
						],
						devPackages: [{ name: BAD, source: "/src", metadataJson: "{}" }],
						capabilities: [
							{ name: BAD, version: 1 },
							{ name: "files", version: 2 },
						],
						peer: { port: 1, publicAddress: BAD, listenError: "" },
					}),
				),
			);
			expect(cleaned.installedPackages.map((p) => [p.name, p.version])).toEqual([
				["", "1.0.0"],
				["pkg-ok", ""],
				["", "1.0.0"],
				["a".repeat(128), ""],
			]);
			expect(cleaned.devPackages[0]?.name).toBe("");
			expect(cleaned.capabilities.map((c) => c.name)).toEqual(["", "files"]);
			expect(cleaned.peer?.publicAddress).toBe("");
			// 正常的（含 IPv6 的地址和中文的包名）原样，不复制。
			const ok = helloWith({
				installedPackages: [{ name: "节点包", version: "1.0.0" }],
				capabilities: [{ name: "files", version: 1 }],
				peer: { port: 1, publicAddress: "[::1]:8080", listenError: "" },
			});
			expect(storable(ok)).toBe(ok);
		});

		it("长的自由文字：开发包的来源、对外监听失败的原因：表里的字符写成 \\uXXXX（换行和制表符保留），超长截断；不丢整段", () => {
			const cleaned = helloOf(
				storable(
					helloWith({
						devPackages: [
							{ name: "dev-pkg", source: `/src/${BAD}\n第二行\t缩进`, metadataJson: "{}" },
						],
						peer: {
							port: 1,
							publicAddress: "h:1",
							listenError: `端口被占用${code(0x1b)}[2J${code(0xe0067)}`,
						},
					}),
				),
			);
			expect(cleaned.devPackages[0]?.source).toBe("/src/x\\u009b2J\\u202e\n第二行\t缩进");
			expect(cleaned.peer?.listenError).toBe("端口被占用\\u001b[2J\\u{e0067}");
			const long = helloOf(
				storable(
					helloWith({ peer: { port: 1, publicAddress: "h:1", listenError: "错".repeat(3000) } }),
				),
			);
			expect(long.peer?.listenError).toBe(`${"错".repeat(2048)}…`);
			// 正好 2048 个字符（按字符数，补充平面的一个算一个）不截断。
			for (const exact of ["错".repeat(2048), code(0x1f600).repeat(2048)]) {
				const same = helloOf(
					storable(helloWith({ peer: { port: 1, publicAddress: "h:1", listenError: exact } })),
				);
				expect(same.peer?.listenError).toBe(exact);
			}
		});

		it("开发包的元信息（JSON 文本）里的字符串（键和值）按长的自由文字处理；没变化时原样返回；不是合法 JSON 时原样返回", () => {
			const metadata = JSON.stringify({
				nodes: [{ name: "n", description: `描述${code(0x202e)}倒着${code(0x200b)}零宽` }],
				[`键${code(0x85)}`]: 1,
			});
			const cleaned = helloOf(
				storable(
					helloWith({ devPackages: [{ name: "dev-pkg", source: "/src", metadataJson: metadata }] }),
				),
			);
			const parsed = JSON.parse(cleaned.devPackages[0]?.metadataJson ?? "") as Record<
				string,
				unknown
			>;
			expect(parsed).toEqual({
				nodes: [{ name: "n", description: "描述\\u202e倒着\\u200b零宽" }],
				"键\\u0085": 1,
			});
			// JSON 转义写出来的也一样（解析之后才是那个字符）。
			const escaped = '{"d":"x\\u202ey"}';
			const again = helloOf(
				storable(
					helloWith({ devPackages: [{ name: "dev-pkg", source: "/src", metadataJson: escaped }] }),
				),
			);
			expect(JSON.parse(again.devPackages[0]?.metadataJson ?? "")).toEqual({ d: "x\\u202ey" });
			// 没有变化、不是合法 JSON：原样。
			const clean = helloWith({
				devPackages: [{ name: "dev-pkg", source: "/src", metadataJson: '{"d":"正常"}' }],
			});
			expect(storable(clean)).toBe(clean);
			const invalid = helloWith({
				devPackages: [{ name: "dev-pkg", source: "/src", metadataJson: "{坏的" }],
			});
			expect(storable(invalid)).toBe(invalid);
		});
	});
});
