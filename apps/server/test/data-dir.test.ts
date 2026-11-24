// 数据目录启动时就检查写不写得了（#651）：不存在就建、里面试写一个文件（写完删掉）、下面已经存在的子目录各试写一次。
// 写不了的写明哪个目录、当前用户和怎么改。用真的文件系统（临时目录、chmod）；以 root 运行时 chmod 拦不住，那几条跳过。
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDirProblems } from "../src/config/data-dir.js";

const isRoot = process.getuid?.() === 0;

describe("dataDirProblems", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "sfly-data-dir-"));
	});
	afterEach(async () => {
		// 只读的目录要先改回来才删得掉。
		for (const path of [root, join(root, "sub"), join(root, "data"), join(root, "data", "logs")]) {
			await chmod(path, 0o755).catch(() => {});
		}
		await rm(root, { recursive: true, force: true });
	});

	it("可写的目录：没有问题，也不留试写的文件（目录里原来有什么还有什么）", async () => {
		await writeFile(join(root, "keep.txt"), "x");

		expect(await dataDirProblems(root)).toEqual([]);

		expect(await readdir(root)).toEqual(["keep.txt"]);
	});

	it("不存在、能建出来：没有问题，目录建出来了，里面没有试写的文件", async () => {
		const dir = join(root, "a", "b", "data");

		expect(await dataDirProblems(dir)).toEqual([]);

		expect(await readdir(dir)).toEqual([]);
	});

	it("已经存在的子目录（logs、artifacts、packages）都写得了：没有问题，也不留试写的文件", async () => {
		for (const name of ["logs", "artifacts", "packages"]) await mkdir(join(root, name));

		expect(await dataDirProblems(root)).toEqual([]);

		for (const name of ["logs", "artifacts", "packages"]) {
			expect(await readdir(join(root, name))).toEqual([]);
		}
		expect((await readdir(root)).sort()).toEqual(["artifacts", "logs", "packages"]);
	});

	it.skipIf(isRoot)(
		"目录本身只读：一条说明，写明目录的完整路径、当前用户、怎么改，没有堆栈",
		async () => {
			const dir = join(root, "data");
			await mkdir(dir);
			await chmod(dir, 0o555);

			const problems = await dataDirProblems(dir);

			expect(problems).toHaveLength(1);
			const [message] = problems as [string];
			expect(message).toContain("SFLY_DATA_DIR");
			expect(message).toContain(dir);
			expect(message).toContain("没有权限");
			expect(message).toContain(userInfo().username);
			expect(message).toContain(`uid ${userInfo().uid}`);
			expect(message).toContain("chown");
			expect(message).toContain("Docker");
			expect(message).not.toMatch(/\n\s+at /);
			expect(message).not.toContain("EACCES");
		},
	);

	it.skipIf(isRoot)(
		"不存在、上级目录不可写：建不出来，写明要建的目录、原因和当前用户",
		async () => {
			const parent = join(root, "sub");
			await mkdir(parent);
			await chmod(parent, 0o555);
			const dir = join(parent, "data");

			const problems = await dataDirProblems(dir);

			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain("建不出这个目录");
			expect(problems[0]).toContain(dir);
			expect(problems[0]).toContain("没有权限");
		},
	);

	it("路径里有一段是文件：建不出来，说明是路径里有一段是文件", async () => {
		await writeFile(join(root, "file"), "x");

		const problems = await dataDirProblems(join(root, "file", "data"));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("路径里有一段是文件");
	});

	it.skipIf(isRoot)(
		"目录能写、下面的 logs 只读（卷里的子目录属主不一样）：一条，指名 logs 的完整路径；别的子目录没事",
		async () => {
			await mkdir(join(root, "logs"));
			await mkdir(join(root, "artifacts"));
			await chmod(join(root, "logs"), 0o555);

			const problems = await dataDirProblems(root);

			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain(join(root, "logs"));
			expect(problems[0]).toContain("logs");
			expect(problems[0]).not.toContain(join(root, "artifacts"));
			expect(await readdir(join(root, "artifacts"))).toEqual([]);
		},
	);

	it("下面的 artifacts 是个文件（不是目录）：一条", async () => {
		await writeFile(join(root, "artifacts"), "x");

		const problems = await dataDirProblems(root);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(join(root, "artifacts"));
		expect(problems[0]).toContain("应该是目录");
	});

	it("相对路径按当前工作目录算成完整路径写进说明", async () => {
		await writeFile(join(root, "file"), "x");
		const previous = process.cwd();
		process.chdir(root);
		try {
			const problems = await dataDirProblems("file/data");

			expect(problems[0]).toContain(join(root, "file", "data"));
		} finally {
			process.chdir(previous);
		}
	});
});
