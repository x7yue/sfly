import { nodeNameWithId } from "@sfly/orchestration";
import { isRemovedNodeKind, REMOVED_NODE_KINDS, removedKindLabel } from "@sfly/schema";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { tasks } from "../db/schema.js";
import { anyTask, type ChainDriver } from "./step.js";

/**
 * 已移除种类的节点（ADR 0028）在引擎里的处理：引擎不再执行它们。只有升级前开始、还没跑完的运行会遇到：
 * 版本里留着这样的节点，走到它时按配置错误失败（不重试），这条链后面的节点按失败的规则推进。
 */

/**
 * 节点按配置错误失败时写的说明：哪个节点、哪种类型已移除、怎么替换。`waitingAtUpgrade`：升级时它已经停在等待上
 * （定时、Sleep 节点），用户看到的是一次在等待中途失败的运行，说明里写明原因是平台升级。
 */
export const removedNodeFailure = (
	node: {
		id: string;
		kind: keyof typeof REMOVED_NODE_KINDS;
		display_name?: string | undefined;
	},
	options: { waitingAtUpgrade?: boolean } = {},
) =>
	`节点 ${nodeNameWithId(node)} 的类型（${removedKindLabel(node.kind)}）已移除，不能执行${options.waitingAtUpgrade ? "（控制面升级时它正在等待，没有人会再唤醒它）" : ""}：${REMOVED_NODE_KINDS[node.kind].replacement}`;

/**
 * 控制面启动时（Engine.recover）：升级前正在等待（waiting）的任务里，节点是已移除种类的（定时、Sleep 节点，
 * 它们的唤醒由已经删掉的周期扫描负责）没人会再唤醒，按配置错误失败，链继续推进。停止子流程节点也是 waiting，
 * 它不是已移除的种类，不动。返回失败的任务数。
 *
 * - 一个运行里可以有几个这样的任务：处理前一个时，链往后推进可能已经把后一个停掉（总是执行的停止子流程节点
 *   停止它所在的子流程），所以每个任务失败之前重新读它的状态，不再是 waiting 就跳过，不能把「已停止」改写成失败。
 * - 排不出某个运行的计划（`driver.locate` 抛错）时跳过这个任务并交给 `onError`，不让一个历史运行挡住整个控制面启动。
 */
export async function failRemovedWaits(
	driver: ChainDriver,
	db: Db,
	onError: (error: unknown) => void = () => {},
): Promise<number> {
	const waiting = eq(tasks.status, "waiting");
	if (!(await anyTask(db, waiting))) return 0;
	return driver.event(async (step) => {
		const rows = await step.tx
			.select()
			.from(tasks)
			.where(waiting)
			.orderBy(asc(tasks.seq))
			.for("update");
		let failed = 0;
		for (const task of rows) {
			try {
				const [current] = await step.tx
					.select({ status: tasks.status })
					.from(tasks)
					.where(eq(tasks.id, task.id));
				if (current?.status !== "waiting") continue;
				const { node } = await driver.locate(step.tx, task);
				if (!isRemovedNodeKind(node.kind)) continue;
				await driver.failTask(
					step,
					task,
					"config_error",
					removedNodeFailure({ ...node, kind: node.kind }, { waitingAtUpgrade: true }),
				);
				failed++;
			} catch (error) {
				onError(error);
			}
		}
		return failed;
	});
}
