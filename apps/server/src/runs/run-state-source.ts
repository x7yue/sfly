import {
	projectRunState,
	RUN_STATE_LIMITS,
	type RunState,
	type RunStateLimits,
	type RunStateSource,
	runStateBytes,
} from "@sfly/schema";
import type { Db, Tx } from "../db/database.js";
import { type RunAttemptState, type RunRead, readRuns } from "./run-read.js";

/*
 * 运行状态（`RunState`，GLOSSARY「运行状态」）在控制面里的取法：从运行的读取结果（`readRuns`）换成投影的输入
 * （`runStateSource`），再用 `@sfly/schema` 的纯函数投影（`projectRunState`）。运行摘要接口（`GET /runs/:id/summary`）和
 * 节点输入里的 `${{ run.state }}`（派发时，`runStateForDispatch`）都走这里，所以两处看到的结构和取法一样。
 */

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** 引用运行状态的节点：它所在的链实例和节点 ID。 */
export interface SelfNode {
	chain_instance_id: string;
	node_id: string;
}

/**
 * 读取结果里投影运行状态要用的部分（写成普通 JSON，见 `RunStateSource`）。
 *
 * `self` 是派发这个节点的任务时的引用者：读取发生在把这次尝试记为「准备中」的那个事务里、写入之前，读到的它还是排队中；
 * 引用者在状态里总是 `dispatched`（和这个事务提交之后别人读到的一致，docs/SEMANTICS.md §2.7），所以这里把它的状态换成
 * `dispatched`。别的节点都是读到的样子。
 */
export function runStateSource(read: RunRead<RunAttemptState>, self?: SelfNode): RunStateSource {
	const { run, version, scenario } = read;
	return {
		run: {
			id: run.id,
			scenario: { id: run.orchestrationId, name: scenario.name, version: version.number },
			status: run.status,
			triggered_by: run.triggeredBy,
			triggered_via: run.triggeredVia,
			started_at: run.startedAt.toISOString(),
			ended_at: iso(run.endedAt),
			cancel: run.cancelRequestedAt
				? {
						requested_by: run.cancelRequestedBy ?? "",
						requested_via: run.cancelRequestedVia,
						requested_at: run.cancelRequestedAt.toISOString(),
						forced_at: iso(run.cancelForcedAt),
					}
				: null,
		},
		chains: read.chains.map((chain) => ({
			id: chain.id,
			chain_id: chain.chain_id,
			name: chain.subflow_name ?? null,
			depth: chain.depth,
			parent_chain_instance_id: chain.parent_chain_instance_id,
			async_node_id: chain.async_node_id,
			status: chain.status,
			started_at: chain.startedAt.toISOString(),
			ended_at: iso(chain.endedAt),
			nodes: chain.nodes.map((node) => ({
				node_id: node.node_id,
				display_name: node.display_name ?? null,
				kind: node.kind,
				status:
					self && chain.id === self.chain_instance_id && node.node_id === self.node_id
						? "dispatched"
						: node.status,
				placeholder: node.closedWhileQueued && { ended_at: iso(node.closedWhileQueued.endedAt) },
				attempts: node.attempts.map((attempt) => ({
					attempt: attempt.attempt,
					started_at: iso(attempt.startedAt),
					ended_at: iso(attempt.endedAt),
					// 错误里带着出错的位置（`error.location`，存在任务上，#513）：原样交给投影。
					error: attempt.error,
				})),
			})),
		})),
	};
}

/**
 * 这个任务拿不到合法的运行状态（读取出错，或整份太大）：引擎让这个任务以 config_error 失败、不派发（engine.ts 的
 * `#assignContent`），不让一个节点的问题卡住这台 Agent 上别的任务。`message` 写进任务的错误信息。
 */
export class RunStateError extends Error {}

const kb = (bytes: number): string => (bytes / 1024).toFixed(1);

/**
 * 派发包节点的任务时，节点输入里 `${{ run.state }}` 的值：这次运行此刻的状态，`self` 是引用它的节点；
 * 错误信息有长度限制，整份有大小限制（{@link RUN_STATE_LIMITS}）：太大时从 `failures` 的末尾起去掉错误信息，
 * 去掉全部之后仍然超过上限的，抛出 {@link RunStateError}（任务以 config_error 失败，写明有多大、上限多少、有多少个节点），
 * 不再做第二层裁剪：那会让汇总节点悄悄拿到不全的数据。在派发的事务里读（`tx`），一条接一条地执行；
 * 只多读状态和错误（`readRuns` 的 `state`），不读输入、输出，查询次数与运行里的节点数无关。
 * `limits` 只给测试用。
 */
export async function runStateForDispatch(
	tx: Db | Tx,
	runId: string,
	self: SelfNode,
	limits: RunStateLimits = RUN_STATE_LIMITS,
): Promise<RunState> {
	const read = (await readRuns(tx, [runId], "state")).get(runId);
	if (!read) throw new Error(`run ${runId} not found while resolving run.state`);
	const state = projectRunState(runStateSource(read, self), { self, limits });
	const bytes = runStateBytes(state);
	if (limits.bytes !== undefined && bytes > limits.bytes) {
		const nodes = state.chains.reduce((total, chain) => total + chain.nodes.length, 0);
		throw new RunStateError(
			`解析 \${{ run.state }} 失败：运行状态有 ${kb(bytes)} KB（${nodes} 个节点、${state.chains.length} 个链实例），去掉全部错误信息之后仍然超过上限 ${kb(limits.bytes)} KB。运行里的节点太多了：把场景拆小，或者这个节点不用 \${{ run.state }}`,
		);
	}
	return state;
}
