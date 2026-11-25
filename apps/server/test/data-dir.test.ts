// 数据目录启动时就检查写不写得了（#651）：不存在就建、里面试写一个文件（写完删掉）、下面已经存在的子目录各试写一次。
// 写不了的写明哪个目录、当前用户和怎么改（按原因说）。用真的文件系统（临时目录、chmod、符号链接）；以 root 运行时 chmod 拦不住，那几条跳过。
// 系统报的原因里真的文件系统造不出来的（只读的挂载、磁盘满）在 data-dir-reasons.test.ts 里用钩子做。
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDirProblems } from "../src/config/data-dir.js";

const isRoot = process.getuid?.() === 0;
const SUBDIRS = ["logs", "artifacts", "packages"] as const;
const { uid, gid, username } = userInfo();

describe("dataDirProblems", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "sfly-data-dir-"));
	});
	afterEach(async () => {
		// 只读的目录要先改回来才删得掉。
		for (const path of [
			root,
			join(root, "sub"),
			join(root, "data"),
			...SUBDIRS.map((name) => join(root, name)),
			...SUBDIRS.map((name) => join(root, "data", name)),
		]) {
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
		for (const name of SUBDIRS) await mkdir(join(root, name));

		expect(await dataDirProblems(root)).toEqual([]);

		for (const name of SUBDIRS) expect(await readdir(join(root, name))).toEqual([]);
		expect((await readdir(root)).sort()).toEqual(["artifacts", "logs", "packages"]);
	});

	it.skipIf(isRoot)(
		"目录本身只读：一条说明，写明目录的完整路径、当前用户、改属主的例子（用当前用户的 uid:gid）、卷名带项目名前缀，没有堆栈",
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
			expect(message).toContain(username);
			expect(message).toContain(`uid ${uid}`);
			expect(message).toContain(`chown -R ${uid}:${gid} ${dir}`);
			expect(message).toContain("Docker");
			expect(message).toContain("项目名");
			expect(message).toContain("docker volume ls");
			expect(message).not.toMatch(/\n\s+at /);
			expect(message).not.toContain("EACCES");
		},
	);

	it.skipIf(isRoot)(
		"不存在、上级目录不可写：说明在哪个目录下面建不出、要建的目录和真正的原因（没有权限），改属主改的是上级目录",
		async () => {
			const parent = join(root, "sub");
			await mkdir(parent);
			await chmod(parent, 0o555);
			const dir = join(parent, "data");

			const problems = await dataDirProblems(dir);

			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain(`在 ${parent} 下面建不出这个目录（${dir}）`);
			expect(problems[0]).toContain("没有权限");
			expect(problems[0]).toContain(`chown -R ${uid}:${gid} ${parent}`);
		},
	);

	it.skipIf(isRoot)(
		"不存在、更上面的目录不可写、中间的目录也不存在：说在最深的那个已经存在的目录下面建不出",
		async () => {
			const parent = join(root, "sub");
			await mkdir(parent);
			await chmod(parent, 0o555);
			const dir = join(parent, "a", "b", "data");

			const problems = await dataDirProblems(dir);

			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain(`在 ${parent} 下面建不出这个目录（${dir}）`);
			expect(problems[0]).toContain("没有权限");
		},
	);

	it("路径里有一段是文件：说明是哪一段、路径里有一段是文件，改的办法不是改属主", async () => {
		await writeFile(join(root, "file"), "x");

		const problems = await dataDirProblems(join(root, "file", "data"));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`路径里的 ${join(root, "file")}`);
		expect(problems[0]).toContain("路径里有一段是文件");
		expect(problems[0]).not.toContain("chown");
		expect(problems[0]).toContain("改属主没有用");
	});

	it("数据目录本身是个文件：说明路径里有一段是文件", async () => {
		await writeFile(join(root, "file"), "x");

		const problems = await dataDirProblems(join(root, "file"));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("路径里有一段是文件");
		expect(problems[0]).not.toContain("chown");
	});

	it("路径里有一段是断掉的符号链接：说明是符号链接、指向的位置不存在，不是「没有权限」", async () => {
		await symlink(join(root, "nowhere"), join(root, "link"));

		const problems = await dataDirProblems(join(root, "link", "data"));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`路径里的 ${join(root, "link")}`);
		expect(problems[0]).toContain("符号链接");
		expect(problems[0]).toContain("指向的位置不存在");
		expect(problems[0]).not.toContain("没有权限");
		expect(problems[0]).not.toContain("chown");
	});

	it("数据目录本身是断掉的符号链接：同上", async () => {
		await symlink(join(root, "nowhere"), join(root, "link"));

		const problems = await dataDirProblems(join(root, "link"));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("符号链接");
		expect(problems[0]).toContain("指向的位置不存在");
		expect(problems[0]).not.toContain("chown");
	});

	it("数据目录是指向存在的目录的符号链接：没有问题", async () => {
		await mkdir(join(root, "real"));
		await symlink(join(root, "real"), join(root, "link"));

		expect(await dataDirProblems(join(root, "link"))).toEqual([]);
	});

	it.skipIf(isRoot).each(SUBDIRS)(
		"目录能写、下面的 %s 只读（卷里的子目录属主不一样）：一条，指名它的完整路径；别的子目录没事，也不留试写的文件",
		async (name) => {
			for (const other of SUBDIRS) await mkdir(join(root, other));
			await chmod(join(root, name), 0o555);

			const problems = await dataDirProblems(root);

			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain(`下面的 ${name} 目录里写不了文件（${join(root, name)}）`);
			expect(problems[0]).toContain("没有权限");
			expect(problems[0]).toContain(`chown -R ${uid}:${gid} ${join(root, name)}`);
			for (const other of SUBDIRS.filter((n) => n !== name)) {
				expect(problems[0]).not.toContain(join(root, other));
				expect(await readdir(join(root, other))).toEqual([]);
			}
		},
	);

	it.skipIf(isRoot)("根和三个子目录都不可写：根一条就停（子目录不再逐个查）", async () => {
		for (const name of SUBDIRS) await mkdir(join(root, name));
		await chmod(root, 0o555);

		const problems = await dataDirProblems(root);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`在这个目录里写不了文件（${root}）`);
	});

	it("下面的 artifacts 是个文件（不是目录）：一条，路径里写着它，应该是目录", async () => {
		await writeFile(join(root, "artifacts"), "x");

		const problems = await dataDirProblems(root);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(join(root, "artifacts"));
		expect(problems[0]).toContain("应该是目录");
		expect(problems[0]).not.toContain("chown");
	});

	it.each(
		SUBDIRS,
	)("下面的 %s 是断掉的符号链接：一条，说明是符号链接、指向的位置不存在（不然要到第一次写才失败）", async (name) => {
		await symlink(join(root, "nowhere"), join(root, name));

		const problems = await dataDirProblems(root);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`下面的 ${name}（${join(root, name)}）`);
		expect(problems[0]).toContain("符号链接");
		expect(problems[0]).toContain("指向的位置不存在");
		expect(problems[0]).not.toContain("chown");
	});

	it("下面的 logs 是指向存在的目录的符号链接：看它指向的目录写不写得了（可写：没有问题）", async () => {
		await mkdir(join(root, "elsewhere"));
		await symlink(join(root, "elsewhere"), join(root, "logs"));

		expect(await dataDirProblems(root)).toEqual([]);

		expect(await readdir(join(root, "elsewhere"))).toEqual([]);
	});

	it.skipIf(isRoot)("下面的 logs 是指向只读目录的符号链接：一条，指名 logs", async () => {
		await mkdir(join(root, "elsewhere"));
		await chmod(join(root, "elsewhere"), 0o555);
		await symlink(join(root, "elsewhere"), join(root, "logs"));

		try {
			const problems = await dataDirProblems(root);

			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain(`下面的 logs 目录里写不了文件（${join(root, "logs")}）`);
		} finally {
			await chmod(join(root, "elsewhere"), 0o755);
		}
	});

	describe("上次被杀留下的试写文件（.sfly-write-check-*）", () => {
		const STALE = ".sfly-write-check-12345-deadbeef";

		it("数据目录的根和已经存在的三个子目录里的清掉；别的名字不动（名字规则要完整符合）；更深一层、不存在的子目录不碰", async () => {
			for (const name of SUBDIRS.slice(0, 2)) await mkdir(join(root, name)); // packages 不存在
			await mkdir(join(root, "logs", "deeper"));
			await mkdir(join(root, "other"));
			const stale = [STALE, `logs/${STALE}`, `artifacts/${STALE}`];
			const keep = [
				// 名字规则不完全符合的
				".sfly-write-check-",
				".sfly-write-check-x",
				".sfly-write-check-12346-DEADBEEF",
				".sfly-write-check-12345-deadbeef.keep",
				".sfly-write-check-12345-deadbeef0",
				".sfly-write-check-12345-deadbee",
				"x.sfly-write-check-12345-deadbeef",
				// 不是检查的那几个目录的根
				`logs/deeper/${STALE}`,
				`other/${STALE}`,
			];
			for (const name of [...stale, ...keep]) await writeFile(join(root, name), "x");

			expect(await dataDirProblems(root)).toEqual([]);

			for (const name of stale) {
				await expect(lstat(join(root, name)), name).rejects.toMatchObject({ code: "ENOENT" });
			}
			for (const name of keep) expect(await lstat(join(root, name)), name).toBeTruthy();
			expect((await readdir(root)).includes("packages")).toBe(false);
		});

		it("名字符合规则的是个目录：不动（只清文件）", async () => {
			await mkdir(join(root, STALE));
			await writeFile(join(root, STALE, "inside"), "x");

			expect(await dataDirProblems(root)).toEqual([]);

			expect(await readdir(join(root, STALE))).toEqual(["inside"]);
		});

		it("目录不存在、由检查建出来：建出来的目录里没有试写文件", async () => {
			const dir = join(root, "new");

			expect(await dataDirProblems(dir)).toEqual([]);

			expect(await readdir(dir)).toEqual([]);
		});
	});

	it("相对路径按当前工作目录算成完整路径写进说明", async () => {
		await writeFile(join(root, "file"), "x");
		const previous = process.cwd();
		process.chdir(root);
		try {
			const problems = await dataDirProblems("file/data");

			expect(problems[0]).toContain(join(root, "file"));
		} finally {
			process.chdir(previous);
		}
	});
});
