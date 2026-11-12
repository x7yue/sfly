import type { ServerMessage } from "@sfly/proto";
import type { OrchestrationNode } from "@sfly/schema";
import type { SQL } from "drizzle-orm";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Db } from "../db/database.js";
import { type chainInstances, type ErrorKind, type runs, tasks } from "../db/schema.js";
import type { ChainPlan } from "./chain.js";
import { taskId } from "./ids.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type RunRow = typeof runs.$inferSelect;
export type ChainRow = typeof chainInstances.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;

/**
 * 一次状态迁移的上下文（engine.ts 的 #step）：同一事务里推进链；事务提交后发布运行变化、
 * 发送取消指令和派发消息，再对涉及的 Agent 尝试派发。
 */
export interface Step {
	tx: Tx;
	now: Date;
	touchedAgents: Set<string>;
	/** 状态有变化的运行；提交后通知订阅者（SSE）。 */
	touchedRuns: Set<string>;
	/** 提交后发给 Agent 的取消指令（#12）。 */
	cancels: CancelOrder[];
	/** 提交后发给 Agent 的派发消息。 */
	assigns: Array<{ conn: AgentConnection; message: ServerMessage }>;
	/** 提交后写进任务日志的控制面日志行（source system）：日志文件不在事务里，事务回滚时不该留下它们。 */
	logs: Array<{ taskId: string; level: "info" | "warn"; text: string }>;
	/** 这个事务往飞书发送队列里写了消息：提交后唤醒投递（FeishuDelivery.wake）。 */
	feishuQueued: boolean;
}

export interface CancelOrder {
	agentName: string;
	taskId: string;
	attempt: number;
	force: boolean;
}

/** 任务在执行计划里的位置。 */
export interface Located {
	run: RunRow;
	chain: ChainRow;
	plan: ChainPlan;
	/** 节点在链上的下标。 */
	index: number;
	node: OrchestrationNode;
}

/**
 * 引擎提供给辅助模块（等待节点 waits.ts、租约 leases.ts）的链推进操作。
 * 调用方都已持有引擎的互斥锁，并在同一个 Step（事务）里完成迁移。
 */
export interface ChainDriver {
	/** 在锁内开一个事务处理事件（见 Engine.#event）。 */
	event<T>(handle: (step: Step) => Promise<T>): Promise<T>;
	/** 任务在执行计划里的位置。 */
	locate(tx: Tx, task: TaskRow): Promise<Located>;
	/** 从链上第 index 个节点开始推进。 */
	advance(step: Step, run: RunRow, chain: ChainRow, index: number): Promise<void>;
	/** 任务失败：按规则重试或推进链。 */
	failTask(step: Step, task: TaskRow, kind: ErrorKind, message: string): Promise<void>;
}

/** 链上第一次执行一个节点时任务行的公共字段（attempt 1）。 */
export const firstAttempt = (run: RunRow, chain: ChainRow, nodeId: string, now: Date) => ({
	id: taskId(chain.id, nodeId, 1),
	runId: run.id,
	chainInstanceId: chain.id,
	nodeId,
	attempt: 1,
	queuedAt: now,
});

/**
 * 周期扫描在拿引擎的锁之前先在锁外看一眼：没有满足条件的任务时不占用锁。
 * 锁内仍要重新查询（锁外看到的可能已经过时）。
 */
export async function anyTask(db: Db, where: SQL | undefined): Promise<boolean> {
	const [row] = await db.select({ id: tasks.id }).from(tasks).where(where).limit(1);
	return row !== undefined;
}
