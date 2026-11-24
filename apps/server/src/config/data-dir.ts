// 数据目录（`SFLY_DATA_DIR`：节点包文件、任务日志、产物、初始化码）启动时就检查（#651）。
//
// 以前目录不可写（Docker 卷的属主不对是最常见的情况）时控制面照常启动，要到第一次写文件（上传产物、写任务日志、存节点包）才报错：
// 使用者看到的是某一次运行里的失败，离原因很远。现在两步：
// 1. {@link dataDirFromEnv}（纯字符串，和别的环境变量一起在 `readEnvSettings` 里检查）：没设置（或空串）用默认的 `./data`，去前后空白；
//    写成地址（`postgres://…`）的不合法，说明里不回显填的值（误填别的变量的值，带着凭据）。
// 2. {@link dataDirProblems}（碰文件系统，`main.ts` 在读完环境变量之后、起控制面之前做）：目录建得出来（不存在时建）、里面能写（试写一个文件，
//    写完删掉，不留东西）；目录下控制面会写的子目录（`logs`、`artifacts`、`packages`）已经存在的，各试写一次（卷里的子目录属主不一样）；
//    子目录是断掉的符号链接的也是问题（不然要到第一次写才失败）。写不了的写明哪个目录（完整的路径）、原因、当前用户和怎么改
//    （按原因说：权限不对才让人改属主，只读、磁盘满、路径里有一段是文件各说各的），退出码 1，不打印堆栈，和别的启动检查一起报。
//    进程在试写和删除之间被杀会留下 `.sfly-write-check-*`：下次检查时顺手清掉（只清检查的那几个目录的根，按完整的名字规则认）。
// 这一步在控制面的任何启动动作之前（包括启动时清理上传的临时文件，artifacts/.uploading）：先看写不写得了，再清。
//
// **说明里写数据目录的完整路径，这是「报错里不回显填的值」的一个写明的例外**（echo.ts 文件头）：路径不写，说明没法用（相对路径解析到哪、
// 是哪个子目录）；以后任何一次写文件失败，系统的报错里本来就带着它，拦不住。所以不按形状猜哪些路径「像凭据」（带 `@`、`:` 的路径是合法的）；
// 写成地址（带 `://`）的、`~` 开头的（没有人展开它）在检查字符串那一步就拒绝了，不会走到这里。
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isUnset } from "./decimal.js";

/** 没设置时的数据目录。 */
export const DEFAULT_DATA_DIR = "./data";

/** 数据目录下控制面会写的子目录（`logs/<运行>`、`artifacts/<运行>`、`packages/<名>`）。 */
const SUBDIRS = ["logs", "artifacts", "packages"] as const;

/** 看起来是个地址（`协议://…`），不是目录的路径。 */
const LOOKS_LIKE_ADDRESS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * 把环境变量 `SFLY_DATA_DIR` 的原文变成数据目录（去前后空白）；没设置（或空串）时是 {@link DEFAULT_DATA_DIR}。
 * 写成地址（带 `://`）的、`~` 开头的（`~`、`~/…`）抛出，说明是固定的文字，**不回显填的值**。
 * 环境变量里的 `~` 没有人展开（shell 不会，容器里更不会）：当相对路径用的话会在当前目录下建出一个叫 `~` 的目录；
 * 以 `~` 开头的相对路径几乎不会是本意，所以拒绝，让人写绝对路径。
 */
export function dataDirFromEnv(raw: string | undefined): string {
	if (isUnset(raw)) return DEFAULT_DATA_DIR;
	const text = raw.trim();
	if (LOOKS_LIKE_ADDRESS.test(text)) {
		throw new Error(
			"SFLY_DATA_DIR 不合法：要写成目录的路径（例如 /data 或 ./data），不是地址（带 :// 的）。没有回显填的值",
		);
	}
	if (text.startsWith("~")) {
		throw new Error(
			"SFLY_DATA_DIR 不合法：环境变量里的 ~ 没有人展开（会在当前目录下建出一个叫 ~ 的目录），要写绝对路径（例如 /data）。没有回显填的值",
		);
	}
	return text;
}

/** 当前用户的 uid 和 gid（改属主的例子用它们）。 */
const ids = (): { uid: string; gid: string } => {
	try {
		const { uid, gid } = userInfo();
		return { uid: String(uid), gid: String(gid) };
	} catch {
		return { uid: String(process.getuid?.() ?? "?"), gid: String(process.getgid?.() ?? "?") };
	}
};

/** 当前用户（说明里写，改属主时要对得上）。 */
const currentUser = (): string => {
	try {
		const { username, uid, gid } = userInfo();
		return `${username}（uid ${uid}、gid ${gid}）`;
	} catch {
		return `uid ${process.getuid?.() ?? "?"}、gid ${process.getgid?.() ?? "?"}`;
	}
};

/** 符号链接指向的位置不存在（不是系统的错误码，下面的说明按它分开）。 */
const BROKEN_LINK = "BROKEN_LINK";

const REASONS: Readonly<Record<string, string>> = {
	EACCES: "没有权限",
	EPERM: "没有权限",
	EROFS: "文件系统是只读的",
	ENOSPC: "磁盘满了",
	EDQUOT: "磁盘配额用完了",
	ENOTDIR: "路径里有一段是文件，不是目录",
	EEXIST: "路径里有一段是文件，不是目录",
	EISDIR: "这个位置上是目录",
	[BROKEN_LINK]: "是符号链接，指向的位置不存在",
};

/** 怎么改：按原因说（权限不对才让人改属主；只读、磁盘满、路径里有一段是文件各说各的）。 */
function howToFix(code: string, path: string): string {
	const { uid, gid } = ids();
	switch (code) {
		case "EACCES":
		case "EPERM":
			return `怎么改：让这个用户对它有写权限（chmod，或者改属主：chown -R ${uid}:${gid} ${path}，uid、gid 用上面当前用户的）；Docker 的命名卷第一次用时沿用镜像里 /data 的属主（node，uid 1000），卷是别人建的、或者用 \`user:\` 换了运行用户时，属主要对得上（compose 建出的卷名带项目名的前缀，docker volume ls 看；例如 docker run --rm -v <卷名>:/data alpine chown -R ${uid}:${gid} /data）；挂载宿主机目录的话在宿主机上改它的属主`;
		case "EROFS":
			return "怎么改：这个位置是只读挂载的（docker 的 `:ro`、`read_only: true`、只读的卷）：去掉只读，或者换一个可写的位置；改属主没有用";
		case "ENOSPC":
		case "EDQUOT":
			return "怎么改：腾出磁盘空间（或配额），或者换一个有空间的位置；改属主没有用";
		case "ENOTDIR":
		case "EEXIST":
			return "怎么改：路径里有一段是文件、不是目录：把那个文件挪走，或者换一个路径；改属主没有用";
		case BROKEN_LINK:
			return "怎么改：让符号链接指向存在的目录，或者换一个路径；改属主没有用";
		default:
			return `怎么改：看错误码 ${code}，先确认当前用户能不能在这个位置建文件`;
	}
}

/** 一条说明：哪个目录出了什么问题（`what`，里面有完整的路径）、原因；带当前用户和怎么改。`path` 是改属主、改权限的那个目录。 */
const problem = (what: string, path: string, code: string): string =>
	`SFLY_DATA_DIR 指的数据目录不可写：${what}：${REASONS[code] ?? `出错了（${code}）`}。当前用户是 ${currentUser()}。${howToFix(code, path)}`;

const codeOf = (error: unknown): string => {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : "未知";
};

/** 试写的文件名：`.sfly-write-check-<进程号>-<8 位十六进制>`。 */
const PROBE_PREFIX = ".sfly-write-check-";
const STALE_PROBE = /^\.sfly-write-check-\d+-[0-9a-f]{8}$/;

/** 在目录里试写一个文件（写完删掉）；写不了返回错误。 */
async function probeWrite(dir: string): Promise<NodeJS.ErrnoException | undefined> {
	const file = join(dir, `${PROBE_PREFIX}${process.pid}-${randomBytes(4).toString("hex")}`);
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
 * 清掉上次留下的试写文件（进程在试写和删除之间被杀）：只看 `dir` 这一层，名字完全符合试写文件的名字规则的才删，自己（这个进程）的不动。
 * 读不了、删不掉都不管（接下来的试写会把真正的问题说出来）。
 */
async function removeStaleProbes(dir: string): Promise<void> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const own = `${PROBE_PREFIX}${process.pid}-`;
	for (const name of names) {
		if (STALE_PROBE.test(name) && !name.startsWith(own))
			await unlink(join(dir, name)).catch(() => {});
	}
}

/**
 * 建不出数据目录时的说明：递归建目录失败时系统报的是「不存在」，不是真正的原因（只读的挂载、权限不对、路径里有一段是文件、符号链接断了
 * 都是），所以找出路径上最深的那个已经存在的位置，看它是什么、试着在它里面写一个文件，说真正的原因。
 */
async function cannotCreate(dir: string, error: NodeJS.ErrnoException): Promise<string> {
	let at = dir;
	for (;;) {
		const found = await lstat(at).catch(() => undefined);
		if (found) {
			const resolved = found.isSymbolicLink() ? await stat(at).catch(() => undefined) : found;
			if (resolved === undefined) {
				return problem(`建不出这个目录（${dir}）：路径里的 ${at}`, at, BROKEN_LINK);
			}
			if (!resolved.isDirectory()) {
				return problem(`建不出这个目录（${dir}）：路径里的 ${at}`, at, "ENOTDIR");
			}
			const failed = await probeWrite(at);
			return problem(`在 ${at} 下面建不出这个目录（${dir}）`, at, codeOf(failed ?? error));
		}
		const parent = dirname(at);
		if (parent === at) return problem(`建不出这个目录（${dir}）`, dir, codeOf(error));
		at = parent;
	}
}

/**
 * 检查数据目录写得了：不存在就建、建不出来是问题；里面试写一个文件；下面已经存在的子目录各试写一次（断掉的符号链接、不是目录的也是问题）。
 * 返回问题的说明（没有问题是空数组），每条写明目录的完整路径、原因、当前用户和怎么改。目录建出来、试写的文件删掉，不留东西
 * （上次被杀留下的试写文件也清掉）。
 */
export async function dataDirProblems(dataDir: string): Promise<string[]> {
	const dir = resolve(dataDir);
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		return [await cannotCreate(dir, error as NodeJS.ErrnoException)];
	}
	await removeStaleProbes(dir);
	const failed = await probeWrite(dir);
	if (failed) return [problem(`在这个目录里写不了文件（${dir}）`, dir, codeOf(failed))];
	const problems: string[] = [];
	for (const name of SUBDIRS) {
		const sub = join(dir, name);
		const found = await lstat(sub).catch(() => undefined);
		if (!found) continue; // 还没有：第一次用到时由控制面建（上面的目录写得了，它就建得出来）
		const info = found.isSymbolicLink() ? await stat(sub).catch(() => undefined) : found;
		if (info === undefined) {
			problems.push(problem(`下面的 ${name}（${sub}）`, sub, BROKEN_LINK));
			continue;
		}
		if (!info.isDirectory()) {
			problems.push(problem(`下面的 ${name}（${sub}）应该是目录`, sub, "ENOTDIR"));
			continue;
		}
		await removeStaleProbes(sub);
		const subFailed = await probeWrite(sub);
		if (subFailed) {
			problems.push(problem(`下面的 ${name} 目录里写不了文件（${sub}）`, sub, codeOf(subFailed)));
		}
	}
	return problems;
}
