import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, ne, sum } from "drizzle-orm";
import type { Clock } from "../clock.js";
import {
	byteLimitBytesFromMb,
	byteLimitMessage,
	isByteLimit,
	MAX_BYTE_LIMIT,
} from "../config/byte-limit.js";
import type { Db } from "../db/database.js";
import { artifacts, runs, tasks } from "../db/schema.js";

/** 单个任务产物总大小的默认上限：1 GB。 */
export const DEFAULT_ARTIFACT_LIMIT_BYTES = 1024 * 1024 * 1024;

/**
 * 上限能取的最大值（字节）：能精确表示的最大整数 2^53 − 1（约 8 PiB）。再大的值没有意义（磁盘装不下），
 * 而且 `Infinity` 和超过 uint64 的值下发给 Agent 时会让派发出错（`BigInt(Infinity)` 抛异常；序列化 `AssignTask` 时
 * `invalid uint64` 让 gRPC 流断开，#477 的审查），所以启动时就拒绝，不留到派发时。
 */
export const MAX_ARTIFACT_LIMIT_BYTES = MAX_BYTE_LIMIT;

/** 上限（字节）合不合格：1 到 {@link MAX_ARTIFACT_LIMIT_BYTES} 之间的整数。 */
export const isArtifactLimitBytes = isByteLimit;

/** 上限不合格的说明；`source` 是它的来源（环境变量名、选项名），`actual` 是写的值。 */
export const artifactLimitMessage = (source: string, actual: unknown): string =>
	byteLimitMessage(source, "产物合计的上限", actual);

/**
 * 把 `SFLY_ARTIFACT_LIMIT_MB` 的原文（MB，可以带小数）换算成字节。没设置（或空串）时是 undefined（用默认值）；
 * 不是数、不是有限的数、换算后不到 1 字节或超过 {@link MAX_ARTIFACT_LIMIT_BYTES} 时抛出，写明原因，控制面不启动。
 */
export function artifactLimitBytesFromMb(
	raw: string | undefined,
	name = "SFLY_ARTIFACT_LIMIT_MB",
): number | undefined {
	return byteLimitBytesFromMb(name, "产物合计的上限", raw);
}

/**
 * AssignTask.artifact_limit_bytes 是 uint64：下发时的换算（上限已经在启动时检查过，这是第二道）。
 * - `Infinity` 和超过 uint64 的值夹在最大值：控制面的 `ArtifactStore` 对它们也是「没有上限」，两边一致，序列化不会出错；
 * - 0、负数、小数不到 1、`NaN`、不是数的值**抛出**：下发时 0 的意思是「不知道上限」（旧版本控制面没带），把它们悄悄
 *   换成最大值，就等于把一个坏值变成「没有上限」，而控制面自己的检查对同一个值的处理不是这样（0 是什么都存不下）。
 */
const MAX_UINT64 = 2n ** 64n - 1n;
export function artifactLimitForWire(limit: number): bigint {
	if (typeof limit !== "number" || Number.isNaN(limit) || limit < 1) {
		throw new Error(artifactLimitMessage("产物合计的上限", limit));
	}
	if (!Number.isFinite(limit)) return MAX_UINT64;
	const bytes = BigInt(Math.floor(limit));
	return bytes < MAX_UINT64 ? bytes : MAX_UINT64;
}

/** 名称（产物目录内的相对路径）的最大长度。 */
const MAX_NAME_LENGTH = 1024;

/**
 * 上传的临时文件放在 `<数据目录>/artifacts/.uploading/`（#649）：产物在 `artifacts/<运行 ID>/…` 下，运行 ID 是 UUID，
 * 不会和这个名字重名；和产物在同一个文件系统里，写完用 `rename` 挪过去。临时文件不放在任务的产物目录里：产物的名字可以是
 * 任何合规矩的相对路径，包括 `.upload-…`，启动时清理临时文件不能把它们当成临时文件删掉。
 */
const UPLOAD_TEMP_DIR = ".uploading";

/** 写入流关闭了（文件描述符已经还给系统，文件如果要建已经建出来了）；已经关闭的立即返回。 */
function closed(stream: Writable): Promise<void> {
	// destroy 可以重复调用；管道出错时已经销毁了它，这里是没有销毁的情况（出错不在管道里）也保证能关上。
	stream.destroy();
	if (stream.closed) return Promise.resolve();
	return new Promise((resolve) => stream.once("close", () => resolve()));
}

/**
 * 上传读请求体时，这么久没有收到任何数据就以明确的错误结束（408 `upload_idle_timeout`，不存、不留临时文件、放开这个任务的队列）：
 * 60 秒。一份上传卡住（连着、不发数据，网络断了而断开的信号没传到）时，同一个任务别的上传排在它后面；没有这个时限，Agent
 * 自己的重试就排在后面永远没有响应，任务收不了尾（#588）。是常量，不做成配置；排队的不另设时限：轮到哪一份，哪一份开始计时。
 */
export const UPLOAD_IDLE_TIMEOUT_MS = 60_000;

export interface ArtifactRow {
	taskId: string;
	name: string;
	/** 绝对路径。 */
	file: string;
	size: number;
	sha256: string;
	/** 上传时间（控制面时间）。 */
	createdAt: Date;
	/** 文件在 Agent 上的修改时间（Agent 时间）；没有上报时为 null。 */
	agentModifiedAt: Date | null;
}

export type SaveOutcome =
	| { ok: true; artifact: ArtifactRow }
	| {
			ok: false;
			status: 400 | 404 | 408 | 409 | 413;
			code:
				| "invalid_artifact_name"
				| "not_found"
				| "task_not_running"
				| "artifact_too_large"
				| "upload_idle_timeout";
			message: string;
			/** 请求体一个字节也没读就拒绝了（按声明的长度）：调用方不用也不该把它读完，回响应后关掉连接。 */
			unread?: true;
	  };

/**
 * 产物（#18）：任务结束后、上报结果之前，Agent 把产物目录里的文件逐个上传到这里。
 *
 * - 名称是产物目录内的相对路径（`/` 分隔），每段非空、不是 `.` / `..`、不含 `\` 和控制字符。
 * - 只接受状态为 running 的任务（Agent 先上传、再上报结果）；同名覆盖。
 *   例外：因取消（#12）终止、且已经派发给 Agent 开始执行（started_at 非空）的任务也接受——强制取消时控制面先把任务记为
 *   cancelled，Agent 杀掉进程后才上传产物、报结果。运行已被保留期清理时不再接受。
 * - 单个任务的产物总大小不超过 `limitBytes`（默认 1 GB），超出时整个文件被拒绝（413）：请求带了长度（`declaredBytes`）时
 *   在读请求体之前就拒绝，没带长度时读到超过为止。上限随任务下发给 Agent（AssignTask.artifact_limit_bytes，#477）。
 * - 文件在 Agent 上的修改时间（Agent 时间，ADR 0018）原样保存，不做范围检查，也不参与任何判断；可以为空。
 * - 文件在 `<数据目录>/artifacts/<run_id>/<task_id>/<name>`，按运行分目录，保留期清理整目录删除（src/retention）。
 * - **同一个任务的上传一个接一个做**（#588）：「这个任务的合计还剩多少」的检查和写入、记账在同一段互斥里，并发上传时合计不会
 *   超过上限，超出的那一份得到和顺序上传时同样的拒绝。互斥在进程里：控制面是单进程设计（同一个数据库只能运行一个实例）。
 *   **任务状态也是轮到时才查**：同一个任务排在别的上传后面的那一份，轮到它时任务已经成功或失败结束了，被拒绝（409），和任务
 *   结束之后才到的上传一样；取消的任务（已经开始执行）仍然收下。真实的 Agent 先传完再报结果，碰不到。
 *   不同任务互不影响；中途断开的上传出错结束，轮到下一份，它没有记账，不占额度。**请求体发完了、没等响应就断开的上传**，
 *   以前会存下来，现在轮到它时请求已经断开、不存（客户端已经不要结果了）。
 * - **卡住的上传有空闲时限**（{@link UPLOAD_IDLE_TIMEOUT_MS}，60 秒）：读请求体时这么久没有收到任何数据，以 408
 *   `upload_idle_timeout` 结束（不存、不留临时文件），放开这个任务的队列；排在后面的不另设时限，轮到哪一份、哪一份开始计时。
 *   一直在慢慢发数据的上传（每次间隔小于时限）不受影响。没有它，同一个任务排在卡住的那份后面的 Agent 重试永远没有响应。
 */
export class ArtifactStore {
	/** 每个任务一条队列：队尾是最后一份排队的上传结束时才完成的 promise；队列空了就删掉。 */
	readonly #queues = new Map<string, Promise<void>>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			dataDir: string;
			limitBytes?: number;
			/** 上传的空闲时限（毫秒），默认 {@link UPLOAD_IDLE_TIMEOUT_MS}；部署者不能改，只有测试和嵌入时给。 */
			uploadIdleMs?: number;
		},
	) {}

	/** 现在有几个任务的上传在做或者排队（队列用完就删，空闲时是 0）：给测试看队列的条目有没有删干净。 */
	get pendingTasks(): number {
		return this.#queues.size;
	}

	/**
	 * 清掉上次进程留下的上传临时文件（被杀、断电时来不及删），返回清掉了几个。只在控制面开始监听之前调用：这时没有上传在做，
	 * 目录里的都是上一次留下的（构造函数里不做：测试里几个 `ArtifactStore` 共用一个数据目录）。
	 * 在升级之前留在任务产物目录里的（`artifacts/<运行>/<任务>/.upload-…`）不在这里找：那要走遍每个任务的目录，而且产物的名字
	 * 也可以是 `.upload-…`；它们随所属运行的保留期清理一起删除。
	 */
	async sweepUploadTemp(): Promise<number> {
		const dir = join(this.deps.dataDir, "artifacts", UPLOAD_TEMP_DIR);
		// 数个数只是为了写日志：读不了（不存在、这个位置上是个文件、没有权限……）就当作 0 个，**照样删这个路径**：这个位置上不是目录的话，
		// 留着它，之后每次上传都在建临时目录时失败（500）。`rm` 不跟着符号链接走：目录里的符号链接只删链接本身。
		const names = await readdir(dir).catch(() => [] as string[]);
		await rm(dir, { recursive: true, force: true });
		return names.length;
	}

	/** 校验产物名称；合法时返回 undefined，否则返回原因。 */
	static invalidName(name: string): string | undefined {
		if (name.length === 0 || name.length > MAX_NAME_LENGTH)
			return `name must be 1-${MAX_NAME_LENGTH} characters`;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: 名称里不允许控制字符
		if (/[\\\u0000-\u001f\u007f]/.test(name))
			return "name must not contain \\ or control characters";
		for (const segment of name.split("/")) {
			if (segment === "" || segment === "." || segment === "..")
				return "name must be a relative path without empty, '.' or '..' segments";
		}
		return undefined;
	}

	/** 每个任务的产物合计上限（字节）：随任务下发给 Agent，上传时按它拒绝。 */
	get limitBytes(): number {
		return this.#limit;
	}

	/**
	 * 把请求体流式写成任务的一个产物；`agentModifiedAt` 是文件在 Agent 上的修改时间，没有上报时为 null；
	 * `declaredBytes` 是请求声明的请求体长度（Content-Length），没有时为 undefined。
	 */
	async save(
		taskId: string,
		name: string,
		body: Readable,
		agentModifiedAt: Date | null = null,
		declaredBytes?: number,
	): Promise<SaveOutcome> {
		const invalid = ArtifactStore.invalidName(name);
		if (invalid) return { ok: false, status: 400, code: "invalid_artifact_name", message: invalid };
		return this.#exclusive(taskId, () =>
			this.#save(taskId, name, body, agentModifiedAt, declaredBytes),
		);
	}

	/** 同一个任务的 `fn` 一个接一个做（按调用的顺序）；`fn` 抛出也轮到下一个。 */
	async #exclusive<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(taskId) ?? Promise.resolve();
		let release: () => void = () => {};
		const mine = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => mine);
		this.#queues.set(taskId, tail);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (this.#queues.get(taskId) === tail) this.#queues.delete(taskId);
		}
	}

	async #save(
		taskId: string,
		name: string,
		body: Readable,
		agentModifiedAt: Date | null,
		declaredBytes: number | undefined,
	): Promise<SaveOutcome> {
		const [task] = await this.deps.db
			.select({
				runId: tasks.runId,
				status: tasks.status,
				agentName: tasks.agentName,
				startedAt: tasks.startedAt,
				purgedAt: runs.purgedAt,
			})
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.where(eq(tasks.id, taskId));
		if (!task) return { ok: false, status: 404, code: "not_found", message: "task not found" };
		const accepting =
			task.agentName !== null &&
			task.purgedAt === null &&
			// dispatched 也接受：TaskStarted（gRPC）可能比产物上传（HTTP）晚到。
			(task.status === "dispatched" ||
				task.status === "running" ||
				(task.status === "cancelled" && task.startedAt !== null));
		if (!accepting) {
			return {
				ok: false,
				status: 409,
				code: "task_not_running",
				message:
					"artifacts can only be uploaded while the task is running (or after it was cancelled)",
			};
		}
		const [others] = await this.deps.db
			.select({ bytes: sum(artifacts.size) })
			.from(artifacts)
			.where(and(eq(artifacts.taskId, taskId), ne(artifacts.name, name)));
		const uploaded = Number(others?.bytes ?? 0);
		const allowed = this.#limit - uploaded;
		// 声明的长度已经放不下：不读请求体就拒绝。
		if (declaredBytes !== undefined && declaredBytes > allowed) {
			return {
				ok: false,
				status: 413,
				code: "artifact_too_large",
				message: this.#tooLarge(name, uploaded, declaredBytes),
				unread: true,
			};
		}

		const relative = join("artifacts", task.runId, taskId, ...name.split("/"));
		const file = join(this.deps.dataDir, relative);
		const tmp = join(this.deps.dataDir, "artifacts", UPLOAD_TEMP_DIR, `.upload-${randomUUID()}`);
		let out: Writable | undefined;
		/** 改名（临时文件换成产物）做过了、事务里的记账还没成：出错时要把已经放到产物位置的文件删掉。 */
		let renamed = false;
		/** 这个产物名以前上传过：改名是覆盖。覆盖过的文件出错时删不得（旧的已经没了，删掉等于什么都没有）。 */
		let replaced = false;
		/** 事务里核对到这个运行已经被保留期清理了：不改名、不记账。 */
		let purged = false;
		const hash = createHash("sha256");
		let size = 0;
		let tooLarge = false;
		let idle = false;
		const idleMs = this.deps.uploadIdleMs ?? UPLOAD_IDLE_TIMEOUT_MS;
		try {
			await mkdir(dirname(tmp), { recursive: true });
			out = createWriteStream(tmp);
			await pipeline(
				body,
				async function* (source: AsyncIterable<Buffer>) {
					// 每读一块之前起一个计时器：idleMs 毫秒还没有数据就以空闲超时结束；写盘的时间不算（计时器只在等客户端发数据时开着）。
					// 请求体只能是字节流（上传的路由只按原始字节收，#665）：记的大小、哈希、写进磁盘的是同一份字节；
					// 不是字节的块（字符串）按字符数记会和写盘的字节数不一致，守不住上限，所以拒绝，不悄悄接受。
					const iterator = source[Symbol.asyncIterator]();
					let timer: NodeJS.Timeout | undefined;
					try {
						for (;;) {
							const timeout = new Promise<"idle">((resolve) => {
								timer = setTimeout(() => resolve("idle"), idleMs);
							});
							const next = await Promise.race([iterator.next(), timeout]);
							clearTimeout(timer);
							if (next === "idle") {
								idle = true;
								throw new Error("upload idle timeout");
							}
							if (next.done) return;
							const chunk = next.value as unknown;
							if (!(chunk instanceof Uint8Array)) {
								throw new TypeError("artifact body must be a byte stream");
							}
							size += chunk.length;
							if (size > allowed) {
								tooLarge = true;
								throw new Error("artifact too large");
							}
							hash.update(chunk);
							yield chunk;
						}
					} finally {
						clearTimeout(timer);
					}
				},
				out,
			);
			// 改名和记账在同一个事务里，事务先锁住运行这一行（`FOR KEY SHARE`）并核对它没有被保留期清理（#649 的审查）：
			// 保留期清理（`Retention`）在 `FOR UPDATE` 的锁下删文件、删产物行、标记已清理，所以两边不会交错——要么上传先拿到锁、
			// 改名和记账提交之后清理才删（文件和行一起没了），要么清理先拿到锁、提交之后这里读到「已清理」、不改名也不记账。
			// 不然上传进行中运行被清理时，文件会落进已经清理过的运行目录、库里多一行，之后没有人再删。
			// `KEY SHARE` 只和 `FOR UPDATE` 冲突：引擎对运行行的普通更新（`UPDATE`、`FOR NO KEY UPDATE`）不等它，插产物行的外键本来就要
			// 在运行行和任务行上拿这把锁，所以没有新增的等待关系。
			const row = {
				id: randomUUID(),
				taskId,
				runId: task.runId,
				name,
				path: relative,
				size,
				sha256: hash.digest("hex"),
				createdAt: this.deps.clock.now(),
				agentModifiedAt,
			};
			await this.deps.db.transaction(async (tx) => {
				const [run] = await tx
					.select({ purgedAt: runs.purgedAt })
					.from(runs)
					.where(eq(runs.id, task.runId))
					.for("key share");
				if (!run || run.purgedAt !== null) {
					purged = true;
					return;
				}
				const [previous] = await tx
					.select({ id: artifacts.id })
					.from(artifacts)
					.where(and(eq(artifacts.taskId, taskId), eq(artifacts.name, name)));
				replaced = previous !== undefined;
				await mkdir(dirname(file), { recursive: true });
				await rename(tmp, file);
				renamed = true;
				await tx
					.insert(artifacts)
					.values(row)
					.onConflictDoUpdate({
						target: [artifacts.taskId, artifacts.name],
						set: {
							path: row.path,
							size: row.size,
							sha256: row.sha256,
							createdAt: row.createdAt,
							agentModifiedAt: row.agentModifiedAt,
						},
					});
			});
			if (purged) {
				await rm(tmp, { force: true });
				return {
					ok: false,
					status: 409,
					code: "task_not_running",
					message:
						"artifacts can only be uploaded while the task is running (or after it was cancelled)",
				};
			}
			return { ok: true, artifact: { ...row, file } };
		} catch (error) {
			// 先等写入流关闭、再删临时文件（#649）：文件是写入流异步 open 出来的，出错得早（第一块就超限、空闲超时）时流被销毁了它
			// 还没建出文件，这时先删就删了个不存在的文件，open 随后完成、文件才出现，留下一个零字节的临时文件。
			// 等关闭要等 open 返回：open 慢（文件系统慢）时被拒绝的请求也跟着慢，排在它后面的同一个任务的上传更慢；open 一直不返回时这个任务
			// 的上传队列一直卡着，但那时文件系统已经不能用了，成功的路径同样卡在它上面，所以不另设时限。
			if (out) await closed(out);
			await rm(tmp, { force: true });
			// 改名之后事务没成（记账失败、提交失败）：已经放到产物位置的文件没有行，删掉；覆盖的不删（见 replaced）。
			if (renamed && !replaced) await rm(file, { force: true });
			if (idle) {
				return {
					ok: false,
					status: 408,
					code: "upload_idle_timeout",
					message: `产物 ${name} 的上传 ${idleMs / 1000} 秒没有收到数据，已经放弃（没有存）；重新上传`,
					unread: true,
				};
			}
			if (tooLarge) {
				return {
					ok: false,
					status: 413,
					code: "artifact_too_large",
					message: this.#tooLarge(name, uploaded),
				};
			}
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOTDIR" || code === "EISDIR" || code === "EEXIST") {
				return {
					ok: false,
					status: 400,
					code: "invalid_artifact_name",
					message: "name conflicts with another artifact's directory",
				};
			}
			throw error;
		}
	}

	/** 任务的产物（按名称排序）；任务不存在时为 undefined。 */
	async list(
		taskId: string,
	): Promise<{ runId: string; expired: boolean; artifacts: ArtifactRow[] } | undefined> {
		const [task] = await this.deps.db
			.select({ runId: tasks.runId, purgedAt: runs.purgedAt })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.where(eq(tasks.id, taskId));
		if (!task) return undefined;
		const rows = await this.deps.db.select().from(artifacts).where(eq(artifacts.taskId, taskId));
		return {
			runId: task.runId,
			expired: task.purgedAt !== null,
			artifacts: rows
				.map((r) => this.#view(r))
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
		};
	}

	/** 某个产物；不存在时为 undefined，所属运行已过保留期被清理时为 "expired"。 */
	async get(taskId: string, name: string): Promise<ArtifactRow | "expired" | undefined> {
		const [row] = await this.deps.db
			.select({ artifact: artifacts, purgedAt: runs.purgedAt })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.leftJoin(artifacts, and(eq(artifacts.taskId, tasks.id), eq(artifacts.name, name)))
			.where(eq(tasks.id, taskId));
		if (!row) return undefined;
		if (row.purgedAt !== null) return "expired";
		return row.artifact ? this.#view(row.artifact) : undefined;
	}

	get #limit(): number {
		return this.deps.limitBytes ?? DEFAULT_ARTIFACT_LIMIT_BYTES;
	}

	/** 超限的错误信息：这个文件多大（读完才知道时不写）、这个任务已经上传了多少、上限多少、是哪个设置、怎么办。 */
	#tooLarge(name: string, uploaded: number, size?: number): string {
		const file = size === undefined ? "超过这个任务还能上传的大小" : `大小 ${size} 字节`;
		return (
			`产物 ${name} ${file}，这个任务已上传 ${uploaded} 字节，加起来超过每个任务的产物合计上限 ${this.#limit} 字节` +
			"（部署者用 SFLY_ARTIFACT_LIMIT_MB 设置；大文件留在 Agent 上，在节点的输出里给出它在哪台 Agent 的哪个路径）"
		);
	}

	#view(row: typeof artifacts.$inferSelect): ArtifactRow {
		return {
			taskId: row.taskId,
			name: row.name,
			file: join(this.deps.dataDir, row.path),
			size: row.size,
			sha256: row.sha256,
			createdAt: row.createdAt,
			agentModifiedAt: row.agentModifiedAt,
		};
	}
}

/** 任务产物的上传 / 下载地址前缀（以 / 结尾），后面接按路径段编码的产物名称。 */
export function artifactBaseUrl(publicHttpUrl: string, taskId: string): string {
	return `${publicHttpUrl}/tasks/${taskId}/artifacts/`;
}

/** 某个产物的下载地址（也是 SDK 返回给节点的产物引用）。 */
export function artifactUrl(publicHttpUrl: string, taskId: string, name: string): string {
	return artifactBaseUrl(publicHttpUrl, taskId) + name.split("/").map(encodeURIComponent).join("/");
}
