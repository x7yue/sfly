// 真的 pi、真的远程工具扩展（打包好的）、照剧本回复的假模型、假的工作台（本机临时目录里真的执行）：
// 一轮里依次调用写、读、编辑、命令四个工具，看助手服务吐出的事件、工作台上留下的文件和发给模型的系统提示。
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OUTPUT_LIMIT_BYTES } from "../src/extension/extension.js";
import { piPackage } from "../src/launch.js";
import { skillFiles } from "../src/skills.js";
import { eventually } from "./support/eventually.js";
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
	// pi 只自动发现 extensions/ 下的 *.ts、*.js（.mjs 带不带 --no-extensions 都不加载，放它测不到东西）。
	it("设置目录里有会写标记文件的扩展（.ts、.js，拉起时放进去的）：--no-extensions 下它们不加载", async () => {
		const planted = join(tmpdir(), `sfly-planted-${crypto.randomUUID()}`);
		mkdirSync(planted);
		const marker = join(planted, "loaded.marker");
		writeFileSync(
			join(planted, "planted.ts"),
			`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "x"); }\n`,
		);
		const wrapper = join(planted, "pi.sh");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nmkdir -p "$PI_CODING_AGENT_DIR/extensions"\ncp ${JSON.stringify(join(planted, "planted.ts"))} "$PI_CODING_AGENT_DIR/extensions/"\ncp ${JSON.stringify(join(planted, "planted.ts"))} "$PI_CODING_AGENT_DIR/extensions/planted2.js"\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(piPackage().cli)} "$@"\n`,
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
		const markers: string[] = [];
		try {
			const plant = (dir: string) => {
				mkdirSync(join(dir, "extensions"), { recursive: true });
				writeFileSync(join(dir, "SYSTEM.md"), "PLANTED-SYSTEM\n");
				writeFileSync(join(dir, "APPEND_SYSTEM.md"), "PLANTED-APPEND\n");
				writeFileSync(join(dir, "AGENTS.md"), "PLANTED-AGENTS\n");
				for (const ext of ["ts", "js"]) {
					const marker = join(h.root, `loaded-${markers.length}.marker`);
					markers.push(marker);
					writeFileSync(
						join(dir, "extensions", `x.${ext}`),
						`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "x"); }\n`,
					);
				}
			};
			plant(join(h.root, "config"));
			plant(h.dataDir);
			plant(join(h.dataDir, "agents", "old-session"));
			// pi 的工作目录就是工作区（两边路径相同），和它的上级目录。
			plant(h.workdir);
			plant(join(h.workdir, ".pi"));
			plant(join(h.workdir, ".."));
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "你好" });
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed" });
			const prompt = h.model.systemPrompt(0);
			expect(prompt).not.toMatch(/PLANTED-/);
			expect(prompt.startsWith("You are")).toBe(true);
			for (const marker of markers) expect(existsSync(marker), marker).toBe(false);
		} finally {
			await h.close();
		}
	}, 120_000);

	it("--no-prompt-templates：设置目录里的提示模板不展开，以 /名字 开头的话原样发给模型", async () => {
		const planted = realpathSync(mkdtempSync(join(tmpdir(), "sfly-tpl-")));
		const wrapper = join(planted, "pi.sh");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nmkdir -p "$PI_CODING_AGENT_DIR/prompts"\nprintf -- '---\\ndescription: x\\n---\\nPLANTED-TEMPLATE-BODY\\n' > "$PI_CODING_AGENT_DIR/prompts/planted.md"\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(piPackage().cli)} "$@"\n`,
			{ mode: 0o755 },
		);
		const h = await Harness.start({ piArgv: [wrapper] });
		try {
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "/planted" });
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed" });
			const users = (h.model.requests[0]?.messages ?? []).filter((m) => m.role === "user");
			expect(JSON.stringify(users)).not.toContain("PLANTED-TEMPLATE-BODY");
			expect(JSON.stringify(users)).toContain("/planted");
		} finally {
			await h.close();
			rmSync(planted, { recursive: true, force: true });
		}
	}, 120_000);
});

describe("真的 pi：上游的错误原文不外传（#640）", () => {
	// 上游返回的错误体里可能有供应商的名字、账户、请求 ID、内部主机名：事件（控制面存下、页面显示的就是它们）里
	// 只有助手服务自己的说法，原文只在助手服务的日志里。
	const MARKER = "UPSTREAM-ERROR-BODY-7f3c provider-acme account-42 host-internal-9";
	const body = JSON.stringify({ error: { message: MARKER, type: "x", code: "y" } });

	it("上游出错一次、重试后成了：重试提示是自己的说法，带类别和状态码；原文在日志里", async () => {
		const h = await Harness.start();
		try {
			h.model.failures = [{ status: 502, body }];
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "说一句话" });
			expect(await h.turnEnd(id, 1, 60_000)).toMatchObject({ outcome: "completed" });
			const events = h.events.of(id).map((r) => r.event);
			expect(events.find((e) => e.type === "notice" && e.kind === "retry")).toMatchObject({
				message: "上游出错（上游返回 502），正在重试第 1 次",
				error_class: "upstream",
			});
			expect(h.events.lines.join("\n")).not.toContain("UPSTREAM-ERROR-BODY");
			expect(h.events.lines.join("\n")).not.toContain("provider-acme");
			expect(h.logs.join("\n")).toContain(MARKER);
		} finally {
			await h.close();
		}
	}, 90_000);

	it("上游拒绝了密钥：model_unavailable，原因是自己的说法、不带「模型不可用」前缀；原文在日志里", async () => {
		const h = await Harness.start();
		try {
			h.model.failures = Array.from({ length: 5 }, () => ({ status: 401, body }));
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "说一句话" });
			const end = await h.turnEnd(id, 1, 60_000);
			expect(end).toMatchObject({
				outcome: "model_unavailable",
				error_class: "auth",
				reason: "上游拒绝了密钥（上游返回 401）",
			});
			expect(h.events.lines.join("\n")).not.toContain("UPSTREAM-ERROR-BODY");
			expect(h.logs.join("\n")).toContain(MARKER);
		} finally {
			await h.close();
		}
	}, 90_000);
});

describe("真的 pi：工作台不回话、输出很大", () => {
	it("命令进行中工作台不回话（之后连 describe 也不回）：这一轮在期限内以「工作台连不上」失败，不等到用时上限", async () => {
		const h = await Harness.start();
		try {
			h.workbench.hang = { marker: "SILENT-NOW", thenSilent: true };
			h.model.scripts.set("剧本：工作台不回话", [
				{ tool: "bash", args: { command: "echo SILENT-NOW", timeout: 1 } },
				{ text: "不该走到这里" },
			]);
			const id = crypto.randomUUID();
			const started = Date.now();
			await h.prompt(id, { text: "剧本：工作台不回话" });
			const end = await h.turnEnd(id, 1, 60_000);
			expect(end).toMatchObject({ outcome: "failed" });
			expect(end.reason).toContain("工作台连不上");
			// 原因是助手服务自己的说法（工具结果里那一行可能是命令的输出），写明是它又探了一次。
			expect(end.reason).toContain("助手服务又探了一次");
			// 写工作台的名字，不写它的地址（#640）；工具结果里也没有地址。
			expect(end.reason).toContain("fake-workbench");
			expect(h.events.lines.join("\n")).not.toContain(h.workbench.address);
			// 命令的超时 1 秒 + 余量 20 秒 + 探测 5 秒，远小于 20 分钟的上限。
			expect(Date.now() - started).toBeLessThan(40_000);
		} finally {
			h.workbench.silent = false;
			await h.close();
		}
	}, 90_000);

	it("命令自己打出「工作台连不上」、退出码不是 0：助手服务自己探工作台，探得通就是普通的工具错误，这一轮照常往下走", async () => {
		const h = await Harness.start();
		try {
			h.model.scripts.set("剧本：字面的连不上", [
				{
					tool: "bash",
					args: { command: "printf '构建失败：工作台连不上 redis\\n'; exit 1", timeout: 10 },
				},
				{ tool: "bash", args: { command: "echo 第二步", timeout: 10 } },
				{ text: "看完了。" },
			]);
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "剧本：字面的连不上" });
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed", steps: 2, model_calls: 3 });
			// 写 skill 一次、整理工作区一次、探工作台一次、提交一次，用完都关了（不留下空闲的连接一直 ping）。
			await eventually(() => expect(h.connections).toEqual({ opened: 4, closed: 4 }));
		} finally {
			await h.close();
		}
	}, 120_000);

	it("输出超过上限：结果写明丢了多少；events.jsonl 不存每一次的输出快照；一轮结束时助手容器里的临时文件清掉", async () => {
		const h = await Harness.start();
		try {
			const bytes = OUTPUT_LIMIT_BYTES + 2 * 1024 * 1024;
			h.model.scripts.set("剧本：大输出", [
				{
					tool: "bash",
					args: { command: `head -c ${bytes} /dev/zero | tr '\\0' a; echo`, timeout: 120 },
				},
				{ text: "看完了。" },
			]);
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "剧本：大输出" });
			expect(await h.turnEnd(id, 1, 120_000)).toMatchObject({ outcome: "completed" });
			const result = h.events.of(id).find((r) => r.event.type === "tool_result");
			expect(result?.event).toMatchObject({
				text: expect.stringContaining("字节丢掉了"),
				// 页面靠它写明只显示了一部分。
				truncated: true,
			});
			const raw = await h.rawSettled(id);
			expect(raw).not.toContain('"tool_execution_update"');
			expect(raw.length).toBeLessThan(2 * 1024 * 1024);
			const tmp = join(h.root, "tmp");
			for (const dir of readdirSync(tmp)) expect(readdirSync(join(tmp, dir))).toEqual([]);
			const uploaded = h.workbench.writes.find((w) => /pi-bash-[0-9a-f]+\.log$/.test(w.path));
			expect(uploaded?.content.length).toBeLessThan(OUTPUT_LIMIT_BYTES + 4096);
		} finally {
			await h.close();
		}
	}, 180_000);
});

describe("真的 pi：设置目录里没有 SYSTEM.md 时（默认系统提示，助手服务走的路径）", () => {
	it("默认位置的 AGENTS.md、CLAUDE.md、skill、提示模板都不进系统提示，给的 skill 和平台说明在", async () => {
		const planted = realpathSync(mkdtempSync(join(tmpdir(), "sfly-planted-")));
		const skill = (dir: string, name: string) => {
			mkdirSync(join(dir, name), { recursive: true });
			writeFileSync(
				join(dir, name, "SKILL.md"),
				`---\nname: ${name}\ndescription: PLANTED-SKILL-${name}\n---\n\nPLANTED-SKILL-${name}\n`,
			);
		};
		const template = (dir: string, name: string) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${name}.md`), `---\ndescription: PLANTED-TPL-${name}\n---\nx\n`);
		};
		// 设置目录（每次启动新建，只能在拉起时放）：AGENTS.md、skill、提示模板、设置文件里配置的 skill 和模板，
		// 以及 HOME 下的 ~/.agents/skills（HOME 就是设置目录）。不放 SYSTEM.md。
		skill(join(planted, "configured", "skills"), "configured");
		template(join(planted, "configured", "prompts"), "configured");
		const wrapper = join(planted, "pi.sh");
		writeFileSync(
			wrapper,
			[
				"#!/bin/sh",
				'd="$PI_CODING_AGENT_DIR"',
				'echo PLANTED-AGENT-DIR-AGENTS > "$d/AGENTS.md"',
				// APPEND_SYSTEM.md 只是被 --append-system-prompt 盖掉（#539 第 3 题），这里也放上，钉住它进不来。
				'echo PLANTED-AGENT-DIR-APPEND > "$d/APPEND_SYSTEM.md"',
				'mkdir -p "$d/skills/agent-dir" "$d/prompts" "$HOME/.agents/skills/home"',
				`printf -- '---\nname: agent-dir\ndescription: PLANTED-SKILL-agent-dir\n---\nx\n' > "$d/skills/agent-dir/SKILL.md"`,
				`printf -- '---\nname: home\ndescription: PLANTED-SKILL-home\n---\nx\n' > "$HOME/.agents/skills/home/SKILL.md"`,
				`printf -- '---\ndescription: PLANTED-TPL-agent-dir\n---\nx\n' > "$d/prompts/agent-dir.md"`,
				`printf '%s' ${JSON.stringify(JSON.stringify({ skills: [join(planted, "configured", "skills")], prompts: [join(planted, "configured", "prompts")] }))} > "$d/settings.json"`,
				`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(piPackage().cli)} "$@"`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const h = await Harness.start({ piArgv: [wrapper] });
		try {
			// 工作区（pi 的工作目录）和它的上级目录：上下文文件、项目的 skill 和提示模板。
			writeFileSync(join(h.workdir, "AGENTS.md"), "PLANTED-WORKDIR-AGENTS\n");
			writeFileSync(join(h.workdir, "..", "CLAUDE.md"), "PLANTED-PARENT-CLAUDE\n");
			skill(join(h.workdir, ".pi", "skills"), "project");
			skill(join(h.workdir, "..", ".agents", "skills"), "parent");
			skill(join(h.workdir, ".agents", "skills"), "stale");
			template(join(h.workdir, ".pi", "prompts"), "project");
			writeFileSync(join(h.workdir, ".pi", "APPEND_SYSTEM.md"), "PLANTED-PROJECT-APPEND\n");
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "你好" });
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed" });
			const prompt = h.model.systemPrompt(0);
			expect(prompt.startsWith("You are")).toBe(true);
			expect(prompt.match(/PLANTED-[\w-]+/g) ?? []).toEqual([]);
			expect(prompt).toContain("平台说明");
			for (const name of readdirSync(skillsDir)) expect(prompt).toContain(`<name>${name}</name>`);
			// 工作区里原来的 .agents/skills 被换成镜像里的那份（不留镜像之外的东西）。
			expect(existsSync(join(h.workdir, ".agents", "skills", "stale"))).toBe(false);
		} finally {
			await h.close();
			rmSync(planted, { recursive: true, force: true });
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
			// events.jsonl 是异步写的，turn_end 不等它落盘（#684）：等它写完再拍「之前」的快照，不然它自己会在两张快照之间变。
			await h.rawSettled(other);
			const id = crypto.randomUUID();
			const targets = [
				join(h.dataDir, "sessions", other, "events.jsonl"),
				join(h.dataDir, "evil.txt"),
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

describe("真的 pi：一轮进行中被结束，工作台上的命令不留下，会话接着说", () => {
	/** 剧本：在工作台上起一个长命令，它把自己的进程号写进文件（`exec` 之后还是同一个进程）。 */
	const longCommand = (h: Harness, key: string) => {
		h.model.scripts.set(key, [
			{ tool: "bash", args: { command: "echo $$ > running.pid; exec sleep 60", timeout: 120 } },
			{ text: "接着说完了。" },
		]);
	};
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	/** 等工作台上的命令起来，返回它的进程号（断言结束之前它确实在跑）。 */
	const running = async (h: Harness): Promise<number> => {
		let pid = 0;
		await eventually(() => {
			pid = Number(readFileSync(join(h.workdir, "running.pid"), "utf8"));
			expect(pid).toBeGreaterThan(0);
		}, 30_000);
		expect(alive(pid)).toBe(true);
		return pid;
	};
	/** 下一轮发给模型的请求：前一轮的话、带工具调用的助手消息、工具结果、这一句；没有内容为空的助手消息。 */
	const expectResumed = (h: Harness, previous: string, before: number) => {
		const request = h.model.requests.slice(before).at(0);
		const messages = request?.messages ?? [];
		const roles = messages.map((m) => m.role);
		expect(roles).toEqual(["system", "user", "assistant", "tool", "user"]);
		const text = (c: unknown) =>
			typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "";
		expect(text(messages[1]?.content)).toBe(previous);
		expect(messages[2]?.tool_calls).toBeDefined();
		expect(text(messages[4]?.content)).toBe("接着说");
		const empty = messages.filter(
			(m) => m.role === "assistant" && !text(m.content) && !m.tool_calls,
		);
		expect(empty).toEqual([]);
	};

	it("停止（先 clear_queue、abort，pi 停下，进程留着）：命令结束之前在跑、之后不在了；下一轮用同一个 pi 进程，发给模型的请求里没有空的助手消息", async () => {
		const h = await Harness.start();
		try {
			longCommand(h, "剧本：长命令");
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "剧本：长命令" });
			const pid = await running(h);
			const pi = h.sessions.pid(id);
			expect(pi).toBeDefined();
			expect((await h.abort(id)).status).toBe(202);
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "stopped" });
			await eventually(() => expect(alive(pid)).toBe(false), 10_000);
			expect(h.sessions.pid(id)).toBe(pi);
			const before = h.model.requests.length;
			await h.prompt(id, { turn: 2, text: "接着说" });
			expect(await h.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
			expect(h.sessions.pid(id)).toBe(pi);
			expectResumed(h, "剧本：长命令", before);
		} finally {
			await h.close();
		}
	}, 120_000);

	it("stdin 开着、pi 只收到 SIGTERM：这一轮以 interrupted 结束，命令不留下，会话文件完整，下一轮照常", async () => {
		const h = await Harness.start();
		try {
			longCommand(h, "剧本：只发信号");
			const id = crypto.randomUUID();
			await h.prompt(id, { text: "剧本：只发信号" });
			const pid = await running(h);
			const pi = h.sessions.pid(id);
			expect(pi).toBeDefined();
			process.kill(pi as number, "SIGTERM");
			expect(await h.turnEnd(id)).toMatchObject({ outcome: "interrupted" });
			await eventually(() => expect(alive(pid)).toBe(false), 10_000);
			const sessionDir = join(h.dataDir, "sessions", id, "pi-session");
			for (const file of readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))) {
				const lines = readFileSync(join(sessionDir, file), "utf8").trimEnd().split("\n");
				expect(() => JSON.parse(lines.at(-1) ?? "")).not.toThrow();
			}
			const before = h.model.requests.length;
			await h.prompt(id, { turn: 2, text: "接着说" });
			expect(await h.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
			expectResumed(h, "剧本：只发信号", before);
		} finally {
			await h.close();
		}
	}, 120_000);
});

describe("真的 pi：secret 环境变量不出助手服务", () => {
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
			const raw = await h.rawSettled(id);
			// 扩展在源头打码：pi 自己的会话文件里也是打过码的。
			const sessionDir = join(h.dataDir, "sessions", id, "pi-session");
			const piSession = readdirSync(sessionDir)
				.map((f) => readFileSync(join(sessionDir, f), "utf8"))
				.join("\n");
			expect(piSession).toContain("******");
			for (const text of [h.events.lines.join("\n"), raw, h.logs.join("\n"), piSession]) {
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
