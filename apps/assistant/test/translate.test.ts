// pi 的事件 → 平台的会话事件（#538 第 3.1 节的表）。夹具是假模型照剧本跑出来的 pi 原始事件（RPC 模式的 stdout）：
// pi-tools.jsonl 依次调用写、读、编辑、命令（成功、退出码 3、输出超过上限）再说一句话；pi-retry.jsonl 模型连不上、重试用尽。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantEvent } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { Redactor } from "../src/redact.js";
import { headAndTail, newPart, TurnTranslator, truncateBytes } from "../src/translate.js";

const fixture = (name: string) =>
	readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);

const run = (name: string) => {
	const translator = new TurnTranslator(new Redactor());
	const unknown: string[] = [];
	const events = fixture(name).flatMap((record) => {
		const out = translator.translate(record);
		if (out.unknown) unknown.push(out.unknown);
		return out.events;
	});
	return { translator, events, unknown };
};

describe("pi 的事件 → 会话事件", () => {
	it("四个工具和一句话：每种事件都合协议的 schema，工具名翻成平台的叫法", () => {
		const { translator, events, unknown } = run("pi-tools.jsonl");
		expect(unknown).toEqual([]);
		for (const event of events) AssistantEvent.parse(event);
		expect(events.map((e) => e.type)).toEqual([
			...["tool_call", "tool_result"],
			...["tool_call", "tool_result"],
			...["tool_call", "tool_result"],
			...["tool_call", "tool_output", "tool_output", "tool_result"],
			...["tool_call", "tool_output", "tool_result"],
			...["tool_call", "tool_output", "tool_result"],
			"assistant_delta",
			"assistant_message",
		]);
		const calls = events.flatMap((e) => (e.type === "tool_call" ? [[e.tool, e.title]] : []));
		expect(calls).toEqual([
			["write", "notes/a.txt"],
			["read", "notes/a.txt"],
			["edit", "notes/a.txt"],
			["command", "echo out; echo err >&2; printf 'line\\u2028sep\\n'"],
			["command", "echo boom; exit 3"],
			["command", "seq 1 3000"],
		]);
		const results = events.flatMap((e) => (e.type === "tool_result" ? [e] : []));
		expect(results[2]).toMatchObject({ diff: " 1 hello\n-2 world\n+2 remote" });
		expect(results[3]).toMatchObject({ is_error: false, exit_code: 0 });
		expect(results[4]).toMatchObject({ is_error: true, exit_code: 3 });
		expect(results[5]?.text).toContain("Full output: /tmp/pi-bash-");
		// pi 自己截断了命令的输出（3000 行只留了末尾 2000 行）：结果虽然没有超过事件的上限，也要标 truncated，
		// 页面据此写明只显示了一部分。没截断的都是 false。
		expect(results.map((r) => r.truncated)).toEqual([false, false, false, false, false, true]);
		expect(results.every((r) => r.duration_ms >= 0)).toBe(true);
		expect(events.at(-1)).toEqual({
			type: "assistant_message",
			text: "全部做完了。",
			usage: { input: 100, output: 10, cache_read: 0, cache_write: 0 },
		});
		expect(translator).toMatchObject({ modelCalls: 7, steps: 6, lastModelError: undefined });
		expect(translator.usage.input).toBe(700);
	});

	it("工具的输出是到目前为止的全部：只发多出来的部分", () => {
		const { events } = run("pi-tools.jsonl");
		const output = events.flatMap((e) =>
			e.type === "tool_output" && e.call_id === "call_4" ? [e.text] : [],
		);
		expect(output.join("")).toBe("out\nline\\u2028sep\nerr\n");
		expect(newPart("abc", "abcdef")).toBe("def");
		expect(newPart(`x${"y".repeat(300)}`, `${"y".repeat(300)}z`)).toBe("z");
	});

	it("模型连不上、重试用尽：重试提示，记下重试用尽和最后一条是模型出错", () => {
		const { translator, events } = run("pi-retry.jsonl");
		expect(events.map((e) => e.type === "notice" && e.kind)).toEqual([
			"retry",
			"retry",
			"retry",
			"retry_end",
		]);
		expect(events[0]).toMatchObject({
			attempt: 1,
			max_attempts: 3,
			retry_delay_ms: 2000,
			// 助手服务自己的说法：上游的原文（这里是连接的报错，带着地址）不进事件（#640）。
			message: "模型暂时不可用（连不上模型端点），正在第 1/3 次重试，2 秒后",
			error_class: "unreachable",
		});
		expect(events.at(-1)).toMatchObject({ message: "重试用尽：连不上模型端点" });
		expect(JSON.stringify(events)).not.toContain("ECONNREFUSED");
		const unreachable = {
			errorClass: "unreachable",
			label: "连不上模型端点",
			text: "连不上模型端点",
		};
		expect(translator.retriesExhausted).toEqual(unreachable);
		expect(translator.lastModelError).toEqual(unreachable);
	});

	it("上游的原文交给调用方记日志：一次模型调用失败只交一次（重试的提示、重试用尽带的是同一段原文）", () => {
		const translator = new TurnTranslator(new Redactor());
		const raws = fixture("pi-retry.jsonl").flatMap((record) => {
			const { upstreamError } = translator.translate(record);
			return upstreamError === undefined ? [] : [upstreamError];
		});
		// 剧本：第一次调用和三次重试都连不上，共四次模型调用失败。
		expect(raws).toEqual(Array(4).fill("Connection error.: connect ECONNREFUSED 127.0.0.1:8177"));
	});

	it("压缩上下文失败：原文交给调用方记日志，不进事件", () => {
		const translator = new TurnTranslator(new Redactor());
		const out = translator.translate({
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: 'Auto-compaction failed: 500: {"request_id":"req-9"}',
		});
		expect(out).toEqual({
			events: [],
			compactionError: 'Auto-compaction failed: 500: {"request_id":"req-9"}',
		});
		expect(
			translator.translate({ type: "compaction_end", reason: "threshold", aborted: true }),
		).toEqual({ events: [] });
	});

	it("认不出的 pi 事件：不抛错、不外传，交给调用方记日志", () => {
		const translator = new TurnTranslator(new Redactor());
		expect(translator.translate({ type: "something_new", x: 1 })).toEqual({
			events: [],
			unknown: "something_new",
		});
		expect(translator.translate({})).toEqual({ events: [], unknown: "（没有 type）" });
		expect(translator.translate({ type: "entry_appended" })).toEqual({ events: [] });
	});

	it("role=system 的消息（每次起 pi 会话里多一条）、用户消息、queue_update：都不翻成助手的话", () => {
		const translator = new TurnTranslator(new Redactor());
		const records = [
			{ type: "message_start", message: { role: "system", content: [] } },
			{ type: "message_end", message: { role: "system", content: [{ type: "text", text: "段" }] } },
			{ type: "message_start", message: { role: "user", content: "插话" } },
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "插话" }] } },
			// 「插话已送出」以这句插话的用户消息为准，不看 steering 变空、也不依赖两者的先后：这里一律不翻（#544 的事）。
			{ type: "queue_update", steering: [], followUp: [] },
		];
		for (const record of records) expect(translator.translate(record)).toEqual({ events: [] });
		expect(translator.usage).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
		expect(translator.lastModelError).toBeUndefined();
	});

	it("思考只发一条「在想」，不带内容", () => {
		const translator = new TurnTranslator(new Redactor());
		const thinking = (type: string) =>
			translator.translate({
				type: "message_update",
				assistantMessageEvent: { type, delta: "想法" },
			}).events;
		expect([...thinking("thinking_start"), ...thinking("thinking_delta")]).toEqual([
			{ type: "thinking" },
		]);
	});

	it("截断：标题按字节截断，结果只留头尾并标 truncated", () => {
		expect(Buffer.byteLength(truncateBytes("中".repeat(1000), 2048))).toBeLessThanOrEqual(2048);
		const long = headAndTail(`HEAD${"x".repeat(40_000)}TAIL`);
		expect(long.truncated).toBe(true);
		expect(Buffer.byteLength(long.text)).toBeLessThanOrEqual(16 * 1024);
		expect(long.text.startsWith("HEAD")).toBe(true);
		expect(long.text.endsWith("TAIL")).toBe(true);
		expect(headAndTail("short")).toEqual({ text: "short", truncated: false });
	});
});
