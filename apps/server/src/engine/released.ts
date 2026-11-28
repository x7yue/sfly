// 一次尝试什么时候离开了 Agent 之手（#505，ADR 0029「密钥」）：结果已被 Ack；重连时 Hello 里没有列出它；或者控制面在 Welcome 里
// 告诉 Agent 放弃它、之后这条连接的心跳里不再列出它。租约过期不算。运行结束、每次尝试都离手之后删除运行的加密副本：
// 在那一步提交之后另起一个事务，拿着这个运行的闸门做（`RunSecrets.deleting`），不插在一条上报的准入和写入之间。
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db, Tx } from "../db/database.js";
import { chainInstances, runs, tasks } from "../db/schema.js";
import type { RunSecrets } from "../secrets/run-secrets.js";
import { isUuid } from "../util/uuid.js";
import type { Step, TaskRow } from "./step.js";

interface AttemptRef {
	taskId: string;
	attempt: number;
}

const keyOf = (t: AttemptRef) => `${t.taskId}:${t.attempt}`;

/** 这次尝试已经离开 Agent 之手：从没派发出去（没有租约），或者记下了离手的时刻。 */
export function attemptReleased(row: Pick<TaskRow, "leaseExpiresAt" | "releasedAt">): boolean {
	return row.leaseExpiresAt === null || row.releasedAt !== null;
}

/** 运行已经结束，并且它的每次尝试都已离开 Agent 之手（{@link attemptReleased}，同一个判断写成 SQL）。 */
export async function runReleased(tx: Tx, runId: string): Promise<boolean> {
	const [run] = await tx.select({ endedAt: runs.endedAt }).from(runs).where(eq(runs.id, runId));
	if (!run?.endedAt) return false;
	const [held] = await tx
		.select({ id: tasks.id })
		.from(tasks)
		.innerJoin(chainInstances, eq(chainInstances.id, tasks.chainInstanceId))
		.where(
			and(
				eq(chainInstances.runId, runId),
				isNotNull(tasks.leaseExpiresAt),
				isNull(tasks.releasedAt),
			),
		)
		.limit(1);
	return held === undefined;
}

/** 记下离手、在运行结束而且全都离手时删除加密副本；引擎在已有的那一步事务里调用。 */
export class Releases {
	/** 还没做完的删除（关闭控制面时等它们，{@link idle}）。 */
	readonly #deleting = new Set<Promise<void>>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			secrets: RunSecrets;
			/** 删除副本的事务失败（保留期清理会再删）。 */
			onError: (what: string, error: unknown) => void;
		},
	) {}

	/** 等还没做完的删除做完。 */
	async idle(): Promise<void> {
		while (this.#deleting.size > 0) await Promise.all([...this.#deleting]);
	}

	/** 结果已被 Ack（被接受的，和被忽略、照样 Ack 的旧尝试）：副本已经删除时，这条结果算一条迟到的上报。 */
	async acked(step: Step, agentName: string, ref: AttemptRef): Promise<void> {
		if (!isUuid(ref.taskId)) return;
		const released = await step.tx
			.update(tasks)
			.set({ releasedAt: step.now })
			.where(
				and(
					eq(tasks.id, ref.taskId),
					eq(tasks.attempt, ref.attempt),
					eq(tasks.agentName, agentName),
					isNull(tasks.releasedAt),
				),
			)
			.returning({ runId: tasks.runId });
		if (released.length > 0) {
			await this.#settle(step, released);
			return;
		}
		const [row] = await step.tx
			.select({ runId: tasks.runId, masked: runs.maskedOnWrite })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.where(and(eq(tasks.id, ref.taskId), eq(tasks.attempt, ref.attempt)));
		if (row?.masked && (await this.deps.secrets.deleted(step.tx, row.runId))) {
			await this.deps.secrets.countDropped(step.tx, row.runId);
		}
	}

	/** 重连（Hello）：列出的、被放弃的尝试记下放弃的时刻；这台 Agent 名下没列出的尝试已经不在它手上。 */
	async hello(
		step: Step,
		agentName: string,
		held: readonly AttemptRef[],
		abandoned: readonly AttemptRef[],
	): Promise<void> {
		for (const ref of abandoned.filter((a) => isUuid(a.taskId))) {
			await step.tx
				.update(tasks)
				.set({ abandonedAt: step.now })
				.where(
					and(
						eq(tasks.id, ref.taskId),
						eq(tasks.attempt, ref.attempt),
						eq(tasks.agentName, agentName),
						isNull(tasks.releasedAt),
					),
				);
		}
		await this.#releaseUnlisted(step, agentName, held, false);
	}

	/** 心跳：被放弃、这条连接的心跳里不再列出的尝试离手了。 */
	heartbeat(step: Step, agentName: string, held: readonly AttemptRef[]): Promise<void> {
		return this.#releaseUnlisted(step, agentName, held, true);
	}

	/** 运行刚结束：每次尝试都已离手就删除副本。 */
	async runEnded(step: Step, runId: string): Promise<void> {
		await this.#settle(step, [{ runId }]);
	}

	async #releaseUnlisted(
		step: Step,
		agentName: string,
		held: readonly AttemptRef[],
		onlyAbandoned: boolean,
	): Promise<void> {
		const listed = new Set(held.map(keyOf));
		const candidates = await step.tx
			.select({ id: tasks.id, attempt: tasks.attempt })
			.from(tasks)
			.where(
				and(
					eq(tasks.agentName, agentName),
					isNotNull(tasks.leaseExpiresAt),
					isNull(tasks.releasedAt),
					onlyAbandoned ? isNotNull(tasks.abandonedAt) : undefined,
				),
			);
		const gone = candidates.filter((t) => !listed.has(keyOf({ taskId: t.id, attempt: t.attempt })));
		if (gone.length === 0) return;
		const released = await step.tx
			.update(tasks)
			.set({ releasedAt: step.now })
			.where(
				inArray(
					tasks.id,
					gone.map((t) => t.id),
				),
			)
			.returning({ runId: tasks.runId });
		await this.#settle(step, released);
	}

	async #settle(step: Step, released: ReadonlyArray<{ runId: string }>): Promise<void> {
		for (const runId of new Set(released.map((r) => r.runId))) {
			const [run] = await step.tx
				.select({ masked: runs.maskedOnWrite, deletedAt: runs.vaultDeletedAt })
				.from(runs)
				.where(eq(runs.id, runId));
			if (!run?.masked || run.deletedAt !== null) continue;
			if (await runReleased(step.tx, runId)) step.afterCommit.push(() => this.#deleteLater(runId));
		}
	}

	/**
	 * 删除副本：在这一步提交之后另起一个事务，拿着闸门做（不在引擎的事务里拿闸门：拿着行锁等闸门、上报拿着闸门等行锁就等死了）。
	 * 事务里再确认一次全都离手（提交之后到这里之间运行不会再有新的尝试，确认是防御）。失败时副本留着，保留期清理会删。
	 */
	#deleteLater(runId: string): void {
		const { db, clock, secrets } = this.deps;
		const done = secrets
			.deleting(runId, () =>
				db.transaction(async (tx) =>
					(await runReleased(tx, runId)) ? secrets.deleteIn(tx, runId, clock.now()) : false,
				),
			)
			.then(
				() => undefined,
				(error) => this.deps.onError(`删除运行 ${runId} 的加密副本失败：`, error),
			);
		this.#deleting.add(done);
		void done.then(() => this.#deleting.delete(done));
	}
}
