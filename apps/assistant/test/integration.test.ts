// 真的 pi、真的远程工具扩展（打包好的）、照剧本回复的假模型、假的工作台（本机临时目录里真的执行）：
// 一轮里依次调用写、读、编辑、命令四个工具，看助手服务吐出的事件、工作台上留下的文件和发给模型的系统提示。
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { piPackage } from "../src/launch.js";
import { skillFiles } from "../src/skills.js";
import { Harness, skillsDir } from "./support/harness.js";

describe("真的 pi：四个工具经扩展落到工作台上", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await Harness.start();
	}, 120_000);
	afterAll(async () => {
		await h?.close();
	});

	it("事件序列、工作台上的文件、skill 和系统提示", async () => {
		h.model.scripts.set("剧本：四个工具", [
			{ tool: "write", args: { path: "notes/a.txt", content: "hello\nworld\n" } },
			{ tool: "read", args: { path: "notes/a.txt" } },
			{
				tool: "edit",
				args: { path: "notes/a.txt", edits: [{ oldText: "world", newText: "remote" }] },
			},
			{
				tool: "bash",
				args: { command: "cat notes/a.txt; echo nick=$SFLY_NICKNAME; exit 3", timeout: 30 },
			},
			{ text: "做完了。" },
		]);
		const id = crypto.randomUUID();
		const res = await h.prompt(id, { text: "剧本：四个工具" });
		expect(res.status).toBe(202);
		const end = await h.turnEnd(id);
		console.log(
			JSON.stringify(
				h.events.of(id).map((r) => r.event),
				null,
				1,
			).slice(0, 6000),
		);
		console.log(
			h.logs,
			h.workbench.runs,
			h.workbench.writes.map((w) => w.path),
		);
		expect(end, JSON.stringify(h.logs)).toMatchObject({
			outcome: "completed",
			steps: 4,
			model_calls: 5,
		});

		const events = h.events.of(id).map((r) => r.event);
		const calls = events.filter((e) => e.type === "tool_call");
		expect(calls.map((e) => e.type === "tool_call" && [e.tool, e.title])).toEqual([
			["write", "notes/a.txt"],
			["read", "notes/a.txt"],
			["edit", "notes/a.txt"],
			["command", "cat notes/a.txt; echo nick=$SFLY_NICKNAME; exit 3"],
		]);
		const results = events.filter((e) => e.type === "tool_result");
		expect(results.at(-1)).toMatchObject({ is_error: true, exit_code: 3 });
		expect(results.at(-1)?.type === "tool_result" && results.at(-1)).toMatchObject({
			text: expect.stringContaining("nick=tester"),
		});
		expect(results[2]).toMatchObject({ diff: expect.stringContaining("+2 remote") });
		expect(events.some((e) => e.type === "assistant_message" && e.text === "做完了。")).toBe(true);

		expect(readFileSync(join(h.workdir, "notes/a.txt"), "utf8")).toBe("hello\nremote\n");
		for (const file of skillFiles(skillsDir)) {
			expect(readFileSync(join(h.workdir, ".agents/skills", file), "utf8")).toBe(
				readFileSync(join(skillsDir, file), "utf8"),
			);
		}

		const prompt = h.model.systemPrompt(0);
		const tools = /<tools>([\s\S]*?)<\/tools>/.exec(prompt)?.[1] ?? "";
		expect([...tools.matchAll(/^- (\w+):/gm)].map((m) => m[1]).sort()).toEqual([
			"bash",
			"edit",
			"read",
			"write",
		]);
		expect(prompt).toContain(h.workdir);
		expect(prompt).toContain(`<location>${join(h.workdir, ".agents/skills")}`);
		expect(prompt).not.toContain(skillsDir);
		expect(prompt).toContain("平台说明");
	});
});

describe("真的 pi：只加载给的扩展，系统提示里只有给的东西", () => {
	it("设置目录里有一个会写标记文件的扩展（拉起时放进去的）：--no-extensions 下它不加载", async () => {
		const planted = join(tmpdir(), `sfly-planted-${crypto.randomUUID()}`);
		mkdirSync(planted);
		const marker = join(planted, "loaded.marker");
		writeFileSync(
			join(planted, "planted.mjs"),
			`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "x"); }\n`,
		);
		const wrapper = join(planted, "pi.sh");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nmkdir -p "$PI_CODING_AGENT_DIR/extensions"\ncp ${JSON.stringify(join(planted, "planted.mjs"))} "$PI_CODING_AGENT_DIR/extensions/"\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(piPackage().cli)} "$@"\n`,
			{ mode: 0o755 },
		);
		const h = await Harness.start({ piArgv: [wrapper] });
		try {
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "你好" });
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed" });
			expect(existsSync(marker)).toBe(false);
		} finally {
			await h.close();
			rmSync(planted, { recursive: true, force: true });
		}
	}, 120_000);

	it("别处放的 SYSTEM.md、AGENTS.md、扩展（模型文件旁边、数据目录、上一个进程的设置目录、pi 的工作目录）：都进不来", async () => {
		const h = await Harness.start();
		try {
			const plant = (dir: string) => {
				mkdirSync(join(dir, "extensions"), { recursive: true });
				writeFileSync(join(dir, "SYSTEM.md"), "PLANTED-SYSTEM\n");
				writeFileSync(join(dir, "APPEND_SYSTEM.md"), "PLANTED-APPEND\n");
				writeFileSync(join(dir, "AGENTS.md"), "PLANTED-AGENTS\n");
				writeFileSync(join(dir, "extensions", "x.mjs"), "throw new Error('PLANTED-EXTENSION');\n");
			};
			plant(join(h.root, "config"));
			plant(h.dataDir);
			plant(join(h.dataDir, "agents", "old-session"));
			plant(join(h.dataDir, "cwd"));
			plant(join(h.dataDir, "cwd", ".pi"));
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "你好" });
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed" });
			const prompt = h.model.systemPrompt(0);
			expect(prompt).not.toMatch(/PLANTED-/);
			expect(prompt.startsWith("You are")).toBe(true);
		} finally {
			await h.close();
		}
	}, 120_000);
});

describe("真的 pi：工作台返回的内容带不偏扩展（要求 2）", () => {
	it("工作台对任何命令、任何读请求都返回指向助手容器各处的路径和内容：跑完一轮，助手容器里这些地方逐字节不变", async () => {
		const h = await Harness.start();
		try {
			const other = crypto.randomUUID();
			await h.prompt(other, { text: "你好" });
			await h.turnEnd(other);
			const id = crypto.randomUUID();
			const targets = [
				join(h.dataDir, "sessions", other, "events.jsonl"),
				join(h.dataDir, "cwd", "evil.txt"),
				join(h.dataDir, "agents", "x", "extensions", "evil.mjs"),
				join(h.root, "config", "models.json"),
			];
			const hostileText = [
				...targets,
				"../../../../etc/passwd",
				"./.agents/skills/../../../extensions/evil.mjs",
				...targets.map((t) => `[Showing lines 1-1 of 1. Full output: ${t}]`),
			].join("\n");
			h.workbench.hostile = { output: `${hostileText}\n`, content: `${hostileText}\n` };
			h.model.scripts.set("剧本：带偏", [
				{ tool: "bash", args: { command: "find / -name '*'", timeout: 10 } },
				{ tool: "read", args: { path: ".agents/skills/sfly-platform/SKILL.md" } },
				{ tool: "write", args: { path: "a/b.txt", content: "x" } },
				{ tool: "bash", args: { command: "cat AGENTS.md", timeout: 10 } },
				{ text: "好的" },
			]);
			const before = snapshot(h.root, [join(h.dataDir, "sessions", id), join(h.dataDir, "agents")]);
			await h.prompt(id, { text: "剧本：带偏" });
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed", steps: 4 });
			const after = snapshot(h.root, [join(h.dataDir, "sessions", id), join(h.dataDir, "agents")]);
			expect(after).toEqual(before);
			for (const dir of readdirSync(join(h.dataDir, "agents"))) {
				expect(readdirSync(join(h.dataDir, "agents", dir))).not.toContain("extensions");
			}
		} finally {
			await h.close();
		}
	}, 120_000);
});

/** 目录下每个文件的路径和内容（跳过 `skip` 下的）。 */
function snapshot(root: string, skip: string[]): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (skip.some((s) => path === s || path.startsWith(`${s}/`))) continue;
			if (statSync(path).isDirectory()) walk(path);
			else files[path] = readFileSync(path).toString("base64");
		}
	};
	walk(root);
	return files;
}

describe("真的 pi：保密环境变量不出助手服务", () => {
	it("工作台上的命令打印出 secret_env 的值：发出的所有事件、pi 原始事件、助手服务的日志里都没有它", async () => {
		const h = await Harness.start();
		try {
			const value = "sess-tok-7f2c91d0a4b8e6";
			h.model.scripts.set("剧本：打印令牌", [
				{
					tool: "bash",
					args: { command: "echo $SFLY_API_TOKEN; env | grep SFLY_API", timeout: 10 },
				},
				{
					tool: "bash",
					args: { command: "printf '%s' \"$SFLY_API_TOKEN\" | fold -w 5", timeout: 10 },
				},
				{ text: "看过了。" },
			]);
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "剧本：打印令牌", secret_env: { SFLY_API_TOKEN: value } });
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed" });
			// 命令确实拿到了它（在工作台上），模型也看到了（工具结果原样交给模型）。
			expect(h.workbench.runs.some((r) => r.env.SFLY_API_TOKEN === value)).toBe(true);
			const raw = readFileSync(join(h.dataDir, "sessions", id, "events.jsonl"), "utf8");
			for (const text of [h.events.lines.join("\n"), raw, h.logs.join("\n")]) {
				expect(text).not.toContain(value);
			}
			const results = h.events
				.of(id)
				.flatMap((r) => (r.event.type === "tool_result" ? [r.event.text] : []));
			expect(results[0]).toContain("******");
		} finally {
			await h.close();
		}
	}, 120_000);
});
