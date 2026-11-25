import { randomUUID } from "node:crypto";
import pg from "pg";
import { ApiClient } from "./api-client.js";
import type { TestControlPlane } from "./test-control-plane.js";

/** 种进去的一次尝试：输入、输出（没给或 null 就是数据库里的 NULL）。 */
export interface SeedAttempt {
	inputs?: Record<string, unknown> | null;
	outputs?: Record<string, unknown> | null;
}

/** 种进去的一个节点：它的各次尝试（按尝试序号 1、2、……）。 */
export interface SeedNode {
	id: string;
	attempts: SeedAttempt[];
	/** 给了就是「停止子流程」节点，要停止的子流程（子流程入口的节点 ID）；不给是 stub 包的 echo 节点。 */
	stopSubflow?: string;
}

/**
 * 直接写库种一个已经结束的运行（不经过引擎和 Agent）：主链 entry → 各节点按顺序，每个节点有 `attempts` 里的各次尝试
 * （都是成功的），输入、输出是给定的 JSON。要的是「运行里有这样大小的输入输出」，不是真的把它跑起来。
 * `entryParams`、`secretParams` 给运行的入口参数（`secretParams` 里的名字声明成 secret），读取时它们的值要打码。
 * 需要 `stub` 包已经发布（`publishPackage(cp, "stub", "1.0.0", { echo: ["text"] })`）。
 */
export async function seedRunIo(
	cp: TestControlPlane,
	nodes: SeedNode[],
	options: {
		secretParam?: { name: string; value: string };
		/** 子流程实例上声明的 secret 参数（入口之外的 secret：读取时的打码要把它也算进去）。 */
		subflowSecret?: { name: string; value: string };
	} = {},
): Promise<{ run: string; tasks: Record<string, string[]> }> {
	const api = new ApiClient(cp);
	const params = options.secretParam
		? [{ name: options.secretParam.name, type: "string", secret: true }]
		: [];
	const document = {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params },
			...nodes.map((n) =>
				n.stopSubflow
					? { id: n.id, kind: "stop_subflow", subflow: n.stopSubflow }
					: { id: n.id, kind: "package", package: "stub", node: "echo" },
			),
			...(options.subflowSecret
				? [
						{
							id: "secret_sub",
							kind: "subflow_entry",
							name: "有秘密的子流程",
							params: [{ name: options.subflowSecret.name, type: "string", secret: true }],
						},
					]
				: []),
			// 「停止子流程」节点要停止的子流程（没有节点的空子流程）。
			...[...new Set(nodes.flatMap((n) => (n.stopSubflow ? [n.stopSubflow] : [])))].map((id) => ({
				id,
				kind: "subflow_entry",
				name: "回放",
				params: [],
			})),
		],
		edges: nodes.map((n, i) => ({
			from: i === 0 ? "entry" : (nodes[i - 1] as SeedNode).id,
			to: n.id,
			kind: "chain",
		})),
		packages: { stub: "1.0.0" },
	};
	const scenario = await api.orchestrationWith(document);
	const run = randomUUID();
	const chain = randomUUID();
	const at = "2026-01-01T00:00:00Z";
	const chainParams = options.secretParam
		? { [options.secretParam.name]: options.secretParam.value }
		: {};
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	const taskIds: Record<string, string[]> = {};
	try {
		await client.query(
			`insert into agents (name, project_id, info, status, registered_at, last_seen_at)
			values ('agent-a', 'default', '{"agent_version":"0.5.0","os":"linux","arch":"x86_64","slots":2}', 'offline', $1, $1)
			on conflict (name) do nothing`,
			[at],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at, ended_at)
			select $1, orchestration_id, id, 'default', '测试', $4::jsonb, 'success', $2, $2
			from orchestration_versions where orchestration_id = $3`,
			[run, at, scenario, JSON.stringify(chainParams)],
		);
		await client.query(
			`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at, ended_at)
			values ($1, $2, 'entry', 0, $4::jsonb, 'success', $3, $3)`,
			[chain, run, at, JSON.stringify(chainParams)],
		);
		if (options.subflowSecret) {
			// 主链派发出来的子流程实例：它的参数里有 secret 值，但它的节点一个也没有（要的是读取时认得出这个值）。
			await client.query(
				`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at, ended_at, parent_chain_instance_id, async_node_id)
				values ($1, $2, 'secret_sub', 1, $4::jsonb, 'success', $3, $3, $5, 'entry')`,
				[
					randomUUID(),
					run,
					at,
					JSON.stringify({ [options.subflowSecret.name]: options.subflowSecret.value }),
					chain,
				],
			);
		}
		for (const node of nodes) {
			taskIds[node.id] = [];
			for (const [i, attempt] of node.attempts.entries()) {
				const id = randomUUID();
				taskIds[node.id]?.push(id);
				await client.query(
					`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, agent_name, status, queued_at, started_at, ended_at, inputs, outputs)
					values ($1, $2, $3, $4, $5, 'agent-a', 'success', $6, $6, $6, $7::jsonb, $8::jsonb)`,
					[
						id,
						run,
						chain,
						node.id,
						i + 1,
						at,
						attempt.inputs == null ? null : JSON.stringify(attempt.inputs),
						attempt.outputs == null ? null : JSON.stringify(attempt.outputs),
					],
				);
			}
		}
	} finally {
		await client.end();
	}
	return { run, tasks: taskIds };
}

/**
 * 一个只有 `text` 一个键的 JSON 值，数据库里存着的 JSON 文本（`jsonb` 的文本，冒号后面有一个空格）正好是 `bytes` 个字节：
 * `{"text": "` 加内容加 `"}` 共 12 个字节，内容用 ASCII 字符凑。
 */
export function storedAs(bytes: number): { text: string } {
	if (bytes < 12) throw new Error("最小的是 12 个字节");
	return { text: "x".repeat(bytes - 12) };
}

/** 一个值写进响应的字节数（紧凑的 JSON：冒号后面没有空格）。 */
export const writtenBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
