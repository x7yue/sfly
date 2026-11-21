import type { RunState, RunStateChain, RunStateNode } from "./http/run-summary.js";
import { errorHeadline, failuresInOrder } from "./run-failures.js";

/**
 * 运行状态（`RunState`，契约见 http/run-summary.ts）的投影：从运行的读取结果（控制面的 `readRuns`，
 * apps/server/src/runs/run-read.ts）得到一份 `RunState`。纯函数，不读库、不看时间：运行摘要接口和节点的输入
 * `${{ run.state }}` 共用它，所以两处看到的结构和取法一样，只有限制不同（{@link RunStateLimits}）。
 *
 * 输入 {@link RunStateSource} 是读取结果里投影需要的那部分，写成普通的 JSON（时间是 ISO 字符串），
 * 两端共跑的用例表 `testdata/run-state-cases.json` 用的就是这个形状。读取结果里的用户内容在读取时已经按这次运行的保密参数的值打码，
 * 这里不再打码。
 */

/** 节点最近一次尝试里投影要用的字段。 */
export interface RunStateSourceAttempt {
	/** 这次尝试的序号。 */
	attempt: number;
	started_at: string | null;
	ended_at: string | null;
	/**
	 * 这次尝试的错误（错误类型和错误信息原文：异常信息加堆栈，已打码）；没有时为 null。`location` 是节点代码里出错的位置
	 * （存在任务上的，#471）：没有位置时为 null，也可以不给。
	 */
	error: { kind: string; message: string; location?: string | null } | null;
}

export interface RunStateSourceNode {
	node_id: string;
	display_name: string | null;
	kind: string;
	/** 最近一次尝试的状态（含占位）；还没有任务行时为 `pending`。 */
	status: RunStateNode["status"];
	/** 真正的尝试（不含被跳过、没开始就被取消或停止的占位），按序号升序。 */
	attempts: readonly RunStateSourceAttempt[];
	/**
	 * 最后一行任务是没开始就被取消或停止的占位（节点的第一次尝试，或重试在排队时）时，那一行的结束时间；不是占位时不给。
	 * 节点的状态取最后一行，起止时间也要取同一行：这时 `started_at` 为空（没开始），`ended_at` 是取消或停止的时间，
	 * 不能还是上一次真正执行过的尝试的时间（那会让读的人以为它是执行中被取消的）。被跳过的节点不算（没有时间）。
	 */
	placeholder?: { ended_at: string | null } | null;
}

export interface RunStateSourceChain {
	id: string;
	chain_id: string;
	name: string | null;
	depth: number;
	parent_chain_instance_id: string | null;
	async_node_id: string | null;
	status: RunStateChain["status"];
	started_at: string;
	ended_at: string | null;
	nodes: readonly RunStateSourceNode[];
}

export interface RunStateSource {
	run: {
		id: string;
		scenario: { id: string; name: string; version: number };
		status: RunState["status"];
		triggered_by: string;
		triggered_via: string | null;
		started_at: string;
		ended_at: string | null;
		cancel: RunState["cancel"];
	};
	/** 运行里已经创建的全部链实例，按层数、开始时间、ID 排序；每个链实例的节点按链上的顺序。 */
	chains: readonly RunStateSourceChain[];
}

/**
 * 投影的限制。不给就是不限（运行摘要接口）；节点的输入用 {@link RUN_STATE_LIMITS}。
 * 字符数按 Unicode 字符（码点）算，和 Python 一致。
 */
export interface RunStateLimits {
	/** `error.headline` 最长多少个字符。 */
	headline?: number;
	/** `error.message` 最长多少个字符。 */
	message?: number;
	/** 整份状态（JSON，UTF-8）最大多少字节。 */
	bytes?: number;
}

/** 节点输入里的运行状态的限制（docs/SEMANTICS.md「运行状态」）。 */
export const RUN_STATE_LIMITS = {
	headline: 300,
	message: 2000,
	bytes: 256 * 1024,
} as const satisfies RunStateLimits;

export interface ProjectRunStateOptions {
	/** 节点拿到这份状态时，引用它的节点；运行摘要接口不给。 */
	self?: { chain_instance_id: string; node_id: string };
	limits?: RunStateLimits;
}

/**
 * 错误信息里堆栈的开头：独占一行、顶格的 `Traceback (most recent call last):`（Python 的 `format_exc()` 写出的第一行），
 * 或异常组（`asyncio.TaskGroup` 一类）的堆栈开头 `  + Exception Group Traceback (most recent call last):`。
 */
const STACK_START =
	/^(?:Traceback \(most recent call last\):| {2}\+ Exception Group Traceback \(most recent call last\):)/m;

/**
 * 把存下的错误信息拆成异常信息本身和堆栈。执行器的失败结果里它们是分开的字段，Agent 上报时拼成
 * 「异常信息 + 空行 + 堆栈」存下（agent/src/executor.rs），所以从第一个堆栈开头的那一行（{@link STACK_START}）拆开：
 * 之前是异常信息（去掉末尾的空白），之后（含这一行）是堆栈。没有堆栈（配置错误、超时、Agent 掉线等控制面自己写的错误）时整段是
 * 异常信息，`stack` 为空串。
 *
 * 执行器异常退出、没有写出结果时，Agent 写的是「执行器异常退出（状态），没有写出结果」加标准错误的尾部
 * （agent/src/executor.rs）：标准错误里堆栈前面的行（例如一行警告）留在异常信息里，堆栈从它自己的那一行起算；
 * 标准错误里没有堆栈（被信号杀掉、段错误）时，标准错误整段都在异常信息里。异常信息本身带着堆栈开头的那一行
 * （例如它转述了子进程的堆栈）时，在那里就拆开了：之后的部分算进堆栈，失败原因一行（第一行）不受影响。
 */
export function splitErrorText(text: string): { message: string; stack: string } {
	const found = STACK_START.exec(text);
	if (!found) return { message: text.trimEnd(), stack: "" };
	return { message: text.slice(0, found.index).trimEnd(), stack: text.slice(found.index) };
}

/** 截到最多 `limit` 个字符（码点）：超过时截成 `limit` 个，最后一个是「…」。 */
export function truncateChars(text: string, limit: number | undefined): string {
	if (limit === undefined) return text;
	// 不转成数组：绝大多数文字远没到上限，先用 UTF-16 长度挡掉。
	if (text.length <= limit) return text;
	const chars = Array.from(text);
	return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

const lastOf = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

function nodeOf(source: RunStateSourceNode, limits: RunStateLimits): RunStateNode {
	const last = lastOf(source.attempts);
	let error: RunStateNode["error"] = null;
	if (source.status === "failed") {
		const stored = last?.error ?? null;
		const { message } = splitErrorText(stored?.message ?? "");
		const shown = truncateChars(message, limits.message);
		error = {
			kind: stored?.kind ?? "unknown",
			headline: truncateChars(errorHeadline(message), limits.headline),
			message: shown,
			message_truncated: shown !== message,
			location: stored?.location ?? null,
		};
	}
	const closed = source.placeholder ?? null;
	return {
		node_id: source.node_id,
		display_name: source.display_name,
		kind: source.kind,
		status: source.status,
		attempts: source.attempts.length,
		started_at: closed ? null : (last?.started_at ?? null),
		ended_at: closed ? closed.ended_at : (last?.ended_at ?? null),
		error,
	};
}

/** 到此刻为止的结果（见 `RunState.result_so_far`）。 */
function resultSoFar(source: RunStateSource, failed: boolean): RunState["result_so_far"] {
	const { status, cancel } = source.run;
	if (status !== "running") return status;
	if (cancel !== null) return "cancelled";
	return failed ? "failed" : "success";
}

/**
 * JSON 序列化之后的 UTF-8 字节数。不用 `TextEncoder`：这个包在没有 DOM 和 Node 类型的环境里也要能编译
 * （场景编排的包引用了它）；落单的代理项编码成 U+FFFD，和 `TextEncoder` 一样占 3 个字节。
 */
export function runStateBytes(value: unknown): number {
	let bytes = 0;
	for (const char of JSON.stringify(value)) {
		const code = char.codePointAt(0) ?? 0;
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}

/**
 * 整份状态超过大小上限时，从 `failures` 的末尾开始去掉 `error.message`，直到放得下。就地修改。
 * 去掉全部之后仍然放不下的，这里不再裁剪（那会让节点悄悄拿到不全的数据）：由调用方判断（节点的输入见 `runStateForDispatch`）。
 */
function fitBytes(state: RunState, maxBytes: number): void {
	if (runStateBytes(state) <= maxBytes) return;
	const nodes = new Map(
		state.chains.flatMap((chain) => chain.nodes.map((node) => [node.node_id, node] as const)),
	);
	state.truncated = true;
	for (const id of [...state.failures].reverse()) {
		if (runStateBytes(state) <= maxBytes) return;
		const error = nodes.get(id)?.error;
		if (!error || error.message === "") continue;
		error.message = "";
		error.message_truncated = true;
	}
}

/** 投影出一份运行状态。 */
export function projectRunState(
	source: RunStateSource,
	options: ProjectRunStateOptions = {},
): RunState {
	const limits = options.limits ?? {};
	const { run } = source;
	const chains = source.chains.map(
		(chain): RunStateChain => ({
			id: chain.id,
			chain_id: chain.chain_id,
			name: chain.name,
			depth: chain.depth,
			parent_chain_instance_id: chain.parent_chain_instance_id,
			async_node_id: chain.async_node_id,
			status: chain.status,
			started_at: chain.started_at,
			ended_at: chain.ended_at,
			nodes: chain.nodes.map((node) => nodeOf(node, limits)),
		}),
	);
	const failures = failuresInOrder(source.chains, (node) => {
		const ended = lastOf(node.attempts)?.ended_at;
		return ended ? Date.parse(ended) : null;
	}).map(({ node }) => node.node_id);
	const failed = failures.length > 0 || source.chains.some((chain) => chain.status === "failed");
	const state: RunState = {
		run_id: run.id,
		scenario: run.scenario,
		status: run.status,
		result_so_far: resultSoFar(source, failed),
		triggered_by: run.triggered_by,
		triggered_via: run.triggered_via,
		started_at: run.started_at,
		ended_at: run.ended_at,
		cancel: run.cancel,
		failures,
		self: options.self ?? null,
		truncated: false,
		chains,
	};
	if (limits.bytes !== undefined) fitBytes(state, limits.bytes);
	return state;
}
