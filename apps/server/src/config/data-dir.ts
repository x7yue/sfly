// 数据目录（`SFLY_DATA_DIR`：节点包文件、任务日志、产物、初始化码）启动时就检查（#651）。
//
// 以前目录不可写（Docker 卷的属主不对是最常见的情况）时控制面照常启动，要到第一次写文件（上传产物、写任务日志、存节点包）才报错：
// 使用者看到的是某一次运行里的失败，离原因很远。现在两步：
// 1. {@link dataDirFromEnv}（纯字符串，和别的环境变量一起在 `readEnvSettings` 里检查）：没设置（或空串）用默认的 `./data`，去前后空白；
//    写成地址（`postgres://…`）的不合法，说明里不回显填的值（误填别的变量的值，带着凭据）。
// 2. {@link dataDirProblems}（碰文件系统，`main.ts` 在读完环境变量之后、起控制面之前做）：目录建得出来（不存在时建）、里面能写（试写一个文件，
//    写完删掉，不留东西）；目录下控制面会写的子目录（`logs`、`artifacts`、`packages`）已经存在的，各试写一次（卷里的子目录属主不一样）。
//    写不了的写明哪个目录、当前用户和怎么改，退出码 1，不打印堆栈，和别的启动检查一起报。
// 这一步在控制面的任何启动动作之前（包括启动时清理上传的临时文件，artifacts/.uploading）：先看写不写得了，再清。
import { randomBytes } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { isUnset } from "./decimal.js";

/** 没设置时的数据目录。 */
export const DEFAULT_DATA_DIR = "./data";

/** 数据目录下控制面会写的子目录（`logs/<运行>`、`artifacts/<运行>`、`packages/<名>`）。 */
const SUBDIRS = ["logs", "artifacts", "packages"] as const;

/** 看起来是个地址（`协议://…`），不是目录的路径。 */
const LOOKS_LIKE_ADDRESS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * 把环境变量 `SFLY_DATA_DIR` 的原文变成数据目录（去前后空白）；没设置（或空串）时是 {@link DEFAULT_DATA_DIR}。
 * 写成地址的抛出，说明是固定的文字，**不回显填的值**。
 */
export function dataDirFromEnv(raw: string | undefined): string {
	if (isUnset(raw)) return DEFAULT_DATA_DIR;
	const text = raw.trim();
	if (LOOKS_LIKE_ADDRESS.test(text)) {
		throw new Error(
			"SFLY_DATA_DIR 不合法：要写成目录的路径（例如 /data 或 ./data），不是地址（带 :// 的）。没有回显填的值",
		);
	}
	return text;
}

/** 当前用户（说明里写，改属主时要对得上）。 */
const currentUser = (): string => {
	try {
		const { username, uid, gid } = userInfo();
		return `${username}（uid ${uid}、gid ${gid}）`;
	} catch {
		return `uid ${process.getuid?.() ?? "?"}、gid ${process.getgid?.() ?? "?"}`;
	}
};

const REASONS: Readonly<Record<string, string>> = {
	EACCES: "没有权限",
	EPERM: "没有权限",
	EROFS: "文件系统是只读的",
	ENOSPC: "磁盘满了",
	ENOTDIR: "路径里有一段是文件，不是目录",
	EEXIST: "路径里有一段是文件，不是目录",
	ENOENT: "上级目录不存在",
	EISDIR: "这个位置上是目录",
};

const HOW_TO_FIX =
	"怎么改：让这个用户对它有写权限（chown 或 chmod）；Docker 的命名卷第一次用时沿用镜像里 /data 的属主（node，uid 1000），卷是别人建的、或者用 `user:` 换了运行用户时，属主要对得上（例如 docker run --rm -v <卷名>:/data alpine chown -R 1000:1000 /data）；挂载宿主机目录的话在宿主机上改它的属主";

/** 一条说明：哪个目录（`what`）、什么原因；带当前用户和怎么改。 */
const problem = (what: string, path: string, error: NodeJS.ErrnoException): string =>
	`SFLY_DATA_DIR 指的数据目录不可写：${what}（${path}）${REASONS[error.code ?? ""] ?? `出错了（${error.code ?? "未知"}）`}。当前用户是 ${currentUser()}。${HOW_TO_FIX}`;

/** 在目录里试写一个文件（写完删掉）；写不了返回错误。 */
async function probeWrite(dir: string): Promise<NodeJS.ErrnoException | undefined> {
	const file = join(dir, `.sfly-write-check-${process.pid}-${randomBytes(4).toString("hex")}`);
	try {
		const handle = await open(file, "wx", 0o600);
		try {
			await handle.write("x");
		} finally {
			await handle.close();
		}
	} catch (error) {
		await unlink(file).catch(() => {});
		return error as NodeJS.ErrnoException;
	}
	await unlink(file).catch(() => {});
	return undefined;
}

/**
 * 检查数据目录写得了：不存在就建、建不出来是问题；里面试写一个文件；下面已经存在的子目录各试写一次。返回问题的说明（没有问题是空数组），
 * 每条写明目录、当前用户和怎么改。目录建出来、试写的文件删掉，不留东西。
 */
export async function dataDirProblems(dataDir: string): Promise<string[]> {
	const dir = resolve(dataDir);
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		return [problem("建不出这个目录", dir, error as NodeJS.ErrnoException)];
	}
	const failed = await probeWrite(dir);
	if (failed) return [problem("在这个目录里写不了文件", dir, failed)];
	const problems: string[] = [];
	for (const name of SUBDIRS) {
		const sub = join(dir, name);
		const info = await stat(sub).catch(() => undefined);
		if (!info) continue; // 还没有：第一次用到时由控制面建（上面的目录写得了，它就建得出来）
		if (!info.isDirectory()) {
			problems.push(
				problem(
					`下面的 ${name} 应该是目录`,
					sub,
					Object.assign(new Error("not a directory"), { code: "ENOTDIR" }),
				),
			);
			continue;
		}
		const subFailed = await probeWrite(sub);
		if (subFailed) problems.push(problem(`下面的 ${name} 目录里写不了文件`, sub, subFailed));
	}
	return problems;
}
