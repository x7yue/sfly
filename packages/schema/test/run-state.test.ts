import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type ProjectRunStateOptions,
	projectRunState,
	RUN_STATE_LIMITS,
	RunState,
	type RunStateSource,
	splitErrorText,
	truncateChars,
} from "../src/index.js";

/** 运行状态的用例表：SDK（#452）读同一份。 */
interface Case {
	name: string;
	comment: string;
	source: RunStateSource;
	options?: {
		self?: { chain_instance_id: string; node_id: string };
		limits?: { headline?: number; message?: number; bytes?: number };
	};
	expected: RunState;
}
const cases: Case[] = JSON.parse(
	readFileSync(new URL("../../../testdata/run-state-cases.json", import.meta.url), "utf8"),
).cases;

describe("运行状态的投影（共用用例表 testdata/run-state-cases.json）", () => {
	it("用例表自己是合法的：每个期望值都通过 RunState 的 schema", () => {
		expect(cases.length).toBeGreaterThanOrEqual(15);
		for (const c of cases) expect(RunState.safeParse(c.expected).success, c.name).toBe(true);
	});

	it.each(cases)("$name", ({ source, options, expected }) => {
		const given: ProjectRunStateOptions = { self: options?.self, limits: options?.limits };
		expect(projectRunState(source, given)).toEqual(expected);
	});

	it("投影不改输入", () => {
		for (const c of cases) {
			const before = JSON.stringify(c.source);
			projectRunState(c.source, { limits: c.options?.limits });
			expect(JSON.stringify(c.source), c.name).toBe(before);
		}
	});

	it("投影出的结果可以原样序列化再解析：所有字段都在、没有 undefined", () => {
		for (const c of cases) {
			const state = projectRunState(c.source, { limits: c.options?.limits });
			expect(JSON.parse(JSON.stringify(state)), c.name).toEqual(state);
		}
	});
});

describe("错误信息拆成异常信息和堆栈", () => {
	const stack = 'Traceback (most recent call last):\n  File "a.py", line 1, in f\nValueError: x';

	it("异常信息和堆栈之间隔一个空行：从那里拆开", () => {
		expect(splitErrorText(`ValueError: x\n\n${stack}`)).toEqual({
			message: "ValueError: x",
			stack,
		});
	});

	it("异常信息有好几行也完整保留（SyntaxError 一类）", () => {
		const message = '  File "n.py", line 3\n    def (:\n        ^\nSyntaxError: invalid syntax';
		expect(splitErrorText(`${message}\n\n${stack}`)).toEqual({ message, stack });
	});

	it("没有堆栈（配置错误、超时、Agent 掉线）：整段是异常信息", () => {
		expect(splitErrorText("任务超时")).toEqual({ message: "任务超时", stack: "" });
		expect(splitErrorText("")).toEqual({ message: "", stack: "" });
	});

	it("只有堆栈：异常信息是空的", () => {
		expect(splitErrorText(stack)).toEqual({ message: "", stack });
	});

	it("异常链（During handling…）：异常信息是最后抛出的那个，整条链在堆栈里", () => {
		const chained = `${stack}\n\nDuring handling of the above exception, another exception occurred:\n\n${stack}`;
		expect(splitErrorText(`KeyError: 'k'\n\n${chained}`)).toEqual({
			message: "KeyError: 'k'",
			stack: chained,
		});
	});

	it("异常信息自己带着堆栈的标记时在那里拆开：失败原因一行（第一行）不变", () => {
		const text = `RuntimeError: 子进程失败\n\n${stack}\n\n${stack}`;
		expect(splitErrorText(text).message).toBe("RuntimeError: 子进程失败");
	});

	it("不是空行隔开的「Traceback」不拆（引用别处的文字）", () => {
		expect(splitErrorText("见 Traceback (most recent call last): 之后的内容")).toEqual({
			message: "见 Traceback (most recent call last): 之后的内容",
			stack: "",
		});
	});
});

describe("按字符截断", () => {
	it("不超过上限时原样；超过时截成上限个字符，最后一个是「…」", () => {
		expect(truncateChars("abc", 3)).toBe("abc");
		expect(truncateChars("abcd", 3)).toBe("ab…");
		expect(truncateChars("abcd", undefined)).toBe("abcd");
	});

	it("按码点算，不拆开代理对（表情）", () => {
		expect(truncateChars("😀😀😀😀", 3)).toBe("😀😀…");
		expect(Array.from(truncateChars("😀".repeat(2000), 2000)).length).toBe(2000);
		expect(Array.from(truncateChars("😀".repeat(2001), 2000)).length).toBe(2000);
	});
});

describe("节点输入里的运行状态的限制", () => {
	it("失败原因一行最长 300、异常信息最长 2000 个字符，整份最大 256 KB", () => {
		expect(RUN_STATE_LIMITS).toEqual({ headline: 300, message: 2000, bytes: 256 * 1024 });
	});

	it("30 个节点、6 个链实例、3 个失败的运行，用这些限制投影出来小于 16 KB", () => {
		// 失败原因写得比上限还长（英文的异常信息，上限里每个字符一个字节）：三个失败的节点各占满 headline 和 message 的上限。
		const message = `ValueError: ${"x".repeat(3000)}`;
		const chains = Array.from({ length: 6 }, (_, c) => ({
			id: `c${c}`,
			chain_id: `s${c}`,
			name: c === 0 ? null : `子流程${c}`,
			depth: c === 0 ? 0 : 1,
			parent_chain_instance_id: c === 0 ? null : "c0",
			async_node_id: c === 0 ? null : `spawn${c}`,
			status: "running" as const,
			started_at: "2026-01-01T00:00:00.000Z",
			ended_at: null,
			nodes: Array.from({ length: 5 }, (_, n) => {
				const failed = c < 3 && n === 2;
				return {
					node_id: `c${c}n${n}`,
					display_name: `第 ${c} 条链的第 ${n} 个节点`,
					kind: "package",
					status: failed ? ("failed" as const) : ("success" as const),
					attempts: [
						{
							attempt: 1,
							started_at: "2026-01-01T00:00:01.000Z",
							ended_at: "2026-01-01T00:00:02.000Z",
							error: failed ? { kind: "node_error", message } : null,
						},
					],
				};
			}),
		}));
		const state = projectRunState(
			{
				run: {
					id: "r",
					scenario: { id: "s", name: "巡检", version: 1 },
					status: "running",
					triggered_by: "小明",
					triggered_via: null,
					started_at: "2026-01-01T00:00:00.000Z",
					ended_at: null,
					cancel: null,
				},
				chains,
			},
			{ limits: RUN_STATE_LIMITS },
		);
		expect(state.failures).toHaveLength(3);
		expect(state.chains.flatMap((chain) => chain.nodes)).toHaveLength(30);
		expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThan(16 * 1024);
		expect(state.truncated).toBe(false);
		for (const chain of state.chains) {
			for (const node of chain.nodes) {
				if (node.error) {
					expect(Array.from(node.error.message).length).toBe(2000);
					expect(node.error.message_truncated).toBe(true);
				}
			}
		}
	});
});
