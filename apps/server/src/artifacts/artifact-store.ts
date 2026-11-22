import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, ne, sum } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { artifacts, runs, tasks } from "../db/schema.js";

/** 单个任务产物总大小的默认上限：1 GB。 */
export const DEFAULT_ARTIFACT_LIMIT_BYTES = 1024 * 1024 * 1024;

/**
 * 上限能取的最大值（字节）：能精确表示的最大整数 2^53 − 1（约 8 PiB）。再大的值没有意义（磁盘装不下），
 * 而且 `Infinity` 和超过 uint64 的值下发给 Agent 时会让派发出错（`BigInt(Infinity)` 抛异常；序列化 `AssignTask` 时
 * `invalid uint64` 让 gRPC 流断开，#477 的审查），所以启动时就拒绝，不留到派发时。
 */
export const MAX_ARTIFACT_LIMIT_BYTES = Number.MAX_SAFE_INTEGER;

/** 上限（字节）合不合格：1 到 {@link MAX_ARTIFACT_LIMIT_BYTES} 之间的整数。 */
export const isArtifactLimitBytes = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value >= 1 &&
	value <= MAX_ARTIFACT_LIMIT_BYTES;

/** 上限不合格的说明；`source` 是它的来源（环境变量名、选项名），`actual` 是写的值。 */
export const artifactLimitMessage = (source: string, actual: unknown): string =>
	`${source} 不合法：产物合计的上限换算成字节后必须是 1 到 ${MAX_ARTIFACT_LIMIT_BYTES} 之间的整数，实际是 ${String(actual)}`;

/**
 * 把 `SFLY_ARTIFACT_LIMIT_MB` 的原文（MB，可以带小数）换算成字节。没设置（或空串）时是 undefined（用默认值）；
 * 不是数、不是有限的数、换算后不到 1 字节或超过 {@link MAX_ARTIFACT_LIMIT_BYTES} 时抛出，写明原因，控制面不启动。
 */
export function artifactLimitBytesFromMb(
	raw: string | undefined,
	name = "SFLY_ARTIFACT_LIMIT_MB",
): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const bytes = Math.floor(Number(raw) * 1024 * 1024);
	if (!isArtifactLimitBytes(bytes)) {
		throw new Error(`${artifactLimitMessage(name, JSON.stringify(raw))}（换算后 ${bytes} 字节）`);
	}
	return bytes;
}

/** AssignTask.artifact_limit_bytes 是 uint64：下发时夹在能装下的范围内（上限已经在启动时检查过，这是第二道）。 */
const MAX_UINT64 = 2n ** 64n - 1n;
export const artifactLimitForWire = (limit: number): bigint =>
	Number.isFinite(limit) && limit >= 1
		? BigInt(Math.floor(limit)) < MAX_UINT64
			? BigInt(Math.floor(limit))
			: MAX_UINT64
		: MAX_UINT64;

/** 名称（产物目录内的相对路径）的最大长度。 */
const MAX_NAME_LENGTH = 1024;

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
			status: 400 | 404 | 409 | 413;
			code: "invalid_artifact_name" | "not_found" | "task_not_running" | "artifact_too_large";
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
 */
export class ArtifactStore {
	constructor(
		private readonly deps: { db: Db; clock: Clock; dataDir: string; limitBytes?: number },
	) {}

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
		const tmp = join(this.deps.dataDir, "artifacts", task.runId, taskId, `.upload-${randomUUID()}`);
		const hash = createHash("sha256");
		let size = 0;
		let tooLarge = false;
		try {
			await mkdir(dirname(tmp), { recursive: true });
			await pipeline(
				body,
				async function* (source: AsyncIterable<Buffer>) {
					for await (const chunk of source) {
						size += chunk.length;
						if (size > allowed) {
							tooLarge = true;
							throw new Error("artifact too large");
						}
						hash.update(chunk);
						yield chunk;
					}
				},
				createWriteStream(tmp),
			);
			await mkdir(dirname(file), { recursive: true });
			await rename(tmp, file);
		} catch (error) {
			await rm(tmp, { force: true });
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
		await this.deps.db
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
		return { ok: true, artifact: { ...row, file } };
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
