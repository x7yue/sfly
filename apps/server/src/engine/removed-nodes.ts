import { isRemovedNodeKind, REMOVED_NODE_KINDS, removedKindLabel } from "@sfly/schema";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { tasks } from "../db/schema.js";
import { anyTask, type ChainDriver } from "./step.js";

/**
 * 已移除种类的节点（ADR 0028）在引擎里的处理：引擎不再执行它们。只有升级前开始、还没跑完的运行会遇到：
 * 版本里留着这样的节点，走到它时按配置错误失败（不重试），这条链后面的节点按失败的规则推进。
 */

/** 节点按配置错误失败时写的说明：哪个节点、哪种类型已移除、怎么替换。 */
export const removedNodeFailure = (node: { id: string; kind: keyof typeof REMOVED_NODE_KINDS }) =>
	`节点 ${node.id} 的类型（${removedKindLabel(node.kind)}）已移除，不能执行：${REMOVED_NODE_KINDS[node.kind].replacement}`;

/**
 * 控制面启动时（Engine.recover）：升级前正在等待（waiting）的任务里，节点是已移除种类的（定时、Sleep 节点，
 * 它们的唤醒由已经删掉的周期扫描负责）没人会再唤醒，按配置错误失败，链继续推进。停止子流程节点也是 waiting，
 * 它不是已移除的种类，不动。返回失败的任务数。
 */
export async function failRemovedWaits(driver: ChainDriver, db: Db): Promise<number> {
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
			const { node } = await driver.locate(step.tx, task);
			if (!isRemovedNodeKind(node.kind)) continue;
			await driver.failTask(
				step,
				task,
				"config_error",
				removedNodeFailure({ ...node, kind: node.kind }),
			);
			failed++;
		}
		return failed;
	});
}
