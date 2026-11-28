// 数据目录写不了时，「怎么改」按系统报的原因说（#651 的审查）：只读的挂载不能让人改属主，磁盘满不能让人改属主，
// 路径里有一段是文件也不能；递归建目录失败时 Node 报的是「不存在」（不是真正的原因），要看路径上最深的那个已经存在的位置到底是什么。
// 这几种原因真的文件系统（临时目录）造不出来：把 `open`（试写）、`mkdir` 换成按路径抛出指定错误码的钩子，别的照常做。
// 真的文件系统能造出来的（权限、路径里有一段是文件、断掉的符号链接）在 data-dir.test.ts。
import { mkdir as realMkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "./support/temp-dir.js";

/** 钩子：按路径抛出错误（抛出的错误的 `message` 里带着不该出现在说明里的原文）。 */
const hooks = vi.hoisted(() => ({
	open: undefined as ((path: string) => void) | undefined,
	mkdir: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const open = async (path: string, flags?: string, mode?: number) => {
		hooks.open?.(String(path));
		return actual.open(path, flags, mode);
	};
	const mkdir = async (path: string, options?: Parameters<typeof actual.mkdir>[1]) => {
		hooks.mkdir?.(String(path));
		return actual.mkdir(path, options);
	};
	return { ...actual, default: { ...actual, open, mkdir }, open, mkdir };
});

const { dataDirProblems } = await import("../src/config/data-dir.js");

const ERROR_TEXT = "底层错误的原文 Zq9-never-echo";
const fail = (code: string): never => {
	throw Object.assign(new Error(`${code}: ${ERROR_TEXT}`), { code });
};
const isProbe = (path: string): boolean => path.includes(".sfly-write-check-");

describe("数据目录：按原因说怎么改", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeTempDir("sfly-data-dir-reasons-");
	});
	afterEach(async () => {
		hooks.open = undefined;
		hooks.mkdir = undefined;
		await rm(root, { recursive: true, force: true });
	});

	it.each([
		["EROFS", "文件系统是只读的", "只读挂载的", true],
		["ENOSPC", "磁盘满了", "腾出磁盘空间", true],
		["EDQUOT", "磁盘配额用完了", "腾出磁盘空间", true],
		["EACCES", "没有权限", "chown -R", false],
		["EPERM", "没有权限", "chown -R", false],
	])("目录里试写时系统报 %s：原因写「%s」，怎么改写「%s」；只读、磁盘满的不让人改属主，也不说成没有权限", async (code, reason, advice, noChown) => {
		hooks.open = (path) => {
			if (isProbe(path)) fail(code);
		};

		const problems = await dataDirProblems(root);

		expect(problems).toHaveLength(1);
		const [message] = problems as [string];
		expect(message).toContain(`在这个目录里写不了文件（${root}）：${reason}`);
		expect(message).toContain(advice);
		if (noChown) {
			expect(message).not.toContain("chown");
			expect(message).not.toContain("没有权限");
			expect(message).toContain("改属主没有用");
		} else {
			expect(message).toContain("没有权限");
		}
		// 系统的错误码和错误的原文都不进说明。
		expect(message).not.toContain(code);
		expect(message).not.toContain(ERROR_TEXT);
	});

	it.each([
		"logs",
		"artifacts",
		"packages",
	])("只有 %s 里试写时报只读：一条，指名它，别的不受影响；不让人改属主", async (name) => {
		await realMkdir(join(root, "logs"));
		await realMkdir(join(root, "artifacts"));
		await realMkdir(join(root, "packages"));
		hooks.open = (path) => {
			if (isProbe(path) && path.startsWith(join(root, name))) fail("EROFS");
		};

		const problems = await dataDirProblems(root);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(
			`下面的 ${name} 目录里写不了文件（${join(root, name)}）：文件系统是只读的`,
		);
		expect(problems[0]).not.toContain("chown");
		expect(problems[0]).not.toContain("没有权限");
	});

	it("建目录失败（Node 递归建目录报的是「不存在」），最深的已存在的上级是只读的：说「在那个目录下面建不出」和只读，不说「不存在」", async () => {
		const dir = join(root, "a", "b", "data");
		hooks.mkdir = (path) => {
			if (path === dir) fail("ENOENT");
		};
		hooks.open = (path) => {
			if (isProbe(path) && path.startsWith(root)) fail("EROFS");
		};

		const problems = await dataDirProblems(dir);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`在 ${root} 下面建不出这个目录（${dir}）：文件系统是只读的`);
		expect(problems[0]).not.toContain("没有权限");
		expect(problems[0]).not.toContain("chown");
		expect(problems[0]).not.toContain("ENOENT");
		expect(problems[0]).not.toContain(ERROR_TEXT);
	});

	it("建目录失败、最深的已存在的上级里试写却成功：用建目录报的原因（磁盘满）", async () => {
		const dir = join(root, "data");
		hooks.mkdir = (path) => {
			if (path === dir) fail("ENOSPC");
		};

		const problems = await dataDirProblems(dir);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`在 ${root} 下面建不出这个目录（${dir}）：磁盘满了`);
		expect(problems[0]).not.toContain("chown");
	});

	it("不认识的错误码：写出错误码，说明里没有错误的原文；错误码不像错误码（任意文字）的写「未知」", async () => {
		hooks.open = (path) => {
			if (isProbe(path)) fail("EWEIRD");
		};
		const known = await dataDirProblems(root);
		hooks.open = (path) => {
			if (isProbe(path)) fail("secret value here");
		};

		const unknown = await dataDirProblems(root);

		expect(known[0]).toContain("出错了（EWEIRD）");
		expect(known[0]).toContain("看错误码 EWEIRD");
		expect(unknown[0]).toContain("出错了（未知）");
		for (const message of [known[0], unknown[0]]) {
			expect(message).not.toContain(ERROR_TEXT);
			expect(message).not.toContain("secret value here");
		}
	});
});
