// 每一轮结束由平台提交工作区（#546），工作台是真的 Agent（Rust，只用它的能力端口）：一轮里改了文件，结束后工作台上多一个提交，
// platform 事件在 turn_end 之前；模型布下的陷阱在真的 Agent 上也不被执行；第一轮之前 /work 变成仓库。
// 只能在 Linux 上跑（Agent 只能在 Linux 上编译）：`pnpm linux pnpm --filter @sfly/assistant exec vitest run test/commit-real-agent.test.ts`，
// macOS 上整组跳过（假工作台的同样用例在 commit.test.ts，本机真的执行 git）。
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantEvent } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, log, plantTraps, safeGit } from "./support/git.js";
import { Harness } from "./support/harness.js";
import {
	agentBinary,
	agentUnavailableReason,
	startWorkbenchAgent,
	type WorkbenchAgent,
} from "./support/real-agent.js";

const FAKE_PI = [process.execPath, join(import.meta.dirname, "support", "fake-pi.mjs")];
const SESSION = { title: "给 http_check 加超时", created_by: "alice" };

describe.skipIf(agentUnavailableReason() !== undefined)("真的 Agent 当工作台：提交工作区", () => {
	let agent: WorkbenchAgent;
	let h: Harness;

	beforeAll(async () => {
		agent = await startWorkbenchAgent(agentBinary());
		h = await Harness.start({ piArgv: FAKE_PI });
	}, 900_000);
	afterAll(async () => {
		await h?.close();
		await agent?.close();
	});

	const prompt = (id: string, text: string, turn = 1) =>
		h.prompt(id, {
			turn,
			session: SESSION,
			text,
			workbench: { name: "commit-test-agent", address: agent.address, workdir: h.workdir },
		});
	const commits = (id: string) =>
		h.events
			.of(id)
			.map((r) => r.event)
			.filter((e): e is Extract<AssistantEvent, { type: "platform" }> => e.type === "platform");

	it("第一轮之前 /work 变成 git 仓库：有 .gitignore 和初次提交（含已有的文件），节点包里的 .venv/ 没被提交；一轮里改了文件，结束后多一个提交，说明里有会话和第几轮，事件里有文件和差异", async () => {
		writeFileSync(join(h.workdir, "README.md"), "已有的\n");
		const id = crypto.randomUUID();
		expect(
			(
				await prompt(
					id,
					"run:mkdir -p pkg/.venv && echo v > pkg/.venv/x && printf 'a\\nb\\n' > pkg/node.py;;settle",
				)
			).status,
		).toBe(202);
		expect(await h.turnEnd(id)).toMatchObject({ outcome: "completed" });

		expect(log(h.workdir)).toEqual([
			`alice | sfly | ${SESSION.title}（会话 ${id.slice(0, 8)}）第 1 轮`,
			"sfly | sfly | 初始化工作区",
		]);
		const tree = (rev: string) =>
			safeGit(h.workdir, "ls-tree", "-r", "--name-only", rev).split("\n").filter(Boolean);
		expect(tree("HEAD~1")).toEqual([".gitignore", "README.md"]);
		expect(tree("HEAD")).toEqual([".gitignore", "README.md", "pkg/node.py"]);
		const [commit] = commits(id);
		expect(commits(id)).toHaveLength(1);
		expect(commit).toMatchObject({
			kind: "commit",
			turn: 1,
			hash: safeGit(h.workdir, "rev-parse", "HEAD").trim(),
			files: [{ path: "pkg/node.py", additions: 2, deletions: 0 }],
			truncated: false,
		});
		expect(commit?.diff).toContain("+++ b/pkg/node.py");
		const types = h.events.of(id).map((r) => r.event.type);
		expect(types.at(-2)).toBe("platform");
		expect(types.at(-1)).toBe("turn_end");
	}, 120_000);

	it("模型布下的陷阱（钩子、fsmonitor、过滤器、textconv、外部 diff、gpg、include）：真的 Agent 上提交也不执行，标记文件都不存在", async () => {
		const id = crypto.randomUUID();
		await prompt(id, "settle");
		await h.turnEnd(id);
		const traps = plantTraps(h.workdir);
		await prompt(id, "run:echo changed > a.txt;;settle", 2);
		expect(await h.turnEnd(id, 2)).toMatchObject({ outcome: "completed" });
		expect(commits(id).map((c) => c.turn)).toEqual([2]);
		expect(traps.ran()).toEqual([]);
		expect(existsSync(join(h.workdir, "a.txt"))).toBe(true);
		expect(log(h.workdir)[0]).toContain("第 2 轮");
		// 对照：不经平台的 git add 会触发它们（陷阱是真的布好了；过滤器只处理新写的文件）。
		writeFileSync(join(h.workdir, "after.txt"), "不经平台\n");
		try {
			git(h.workdir, "add", "-A");
		} catch {
			// 有的陷阱让命令失败也没关系：标记文件已经留下。
		}
		expect(traps.ran()).toContain("filter");
	}, 120_000);
});
