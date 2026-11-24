// 负载：运行视图的大小有上界（docs/ARCHITECTURE.md §7.6「运行视图」，#633）。
// 以前运行视图一次返回这次运行所有任务的输入和输出，个数没有上限（每个本来有 1 MiB 的上限）：60 个任务各有接近上限的输出时，
// 一次响应 172 MB，读一次 1.15 秒，事件循环一次被占住 338 毫秒，事件流每次状态变化再推一份。现在单个超过 16 KiB 的只给大小，
// 整份视图内联的合计不超过 1 MiB。这一项在独立的数据库和以 `main.ts` 运行的控制面上量这件事（不需要 release Agent 和打包产物）：
// 直接写库种一个运行（60 个任务，每个任务的输入、输出各是 1000000 个字符），再读它。
// 硬性断言：响应体不超过 2 MiB（内联上限 1 MiB 加上视图本身），事件流里第一条 `run` 事件也是；被省略的内容用 `GET /tasks/:id/io`
// 取回来和种进去的一样。
// 只记录：读一次的耗时、读的过程中同时发出的小请求的最长等待（事件循环被占住多久，控制面是单独的进程，探测的请求自己不受影响）、
// 控制面的内存增长。
import { randomUUID } from "node:crypto";
import pg from "pg";
import { startSourceServer } from "../../test/support/source-server.js";
import { createTestDatabase } from "../../test/support/test-database.js";
import { definePerfItem, hard, type ItemRun, target } from "../item.js";
import { distribution } from "../latency.js";
import { CONTROL_PLANE, usageMeasurements } from "../measure.js";
import type { Measurement } from "../report.js";
import { sampleProcess, sleep } from "../stack.js";

const TASKS = 60;
/** 每个任务的输入、输出各多少个字符（接近每个值 1 MiB 的上限）。 */
const VALUE_CHARS = 1_000_000;
const READS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 种一个已经结束的运行：`tasks` 个节点各有一次成功的尝试，输入、输出各是 `chars` 个字符。 */
async function seedRun(databaseUrl: string, tasks: number, chars: number): Promise<string> {
	const scenario = randomUUID();
	const version = randomUUID();
	const run = randomUUID();
	const chain = randomUUID();
	const at = "2026-01-01T00:00:00Z";
	const nodes = [
		{ id: "entry", kind: "entry", params: [] },
		...Array.from({ length: tasks }, (_, i) => ({
			id: `n${i + 1}`,
			kind: "package",
			package: "stub",
			node: "echo",
		})),
	];
	const document = {
		nodes,
		edges: nodes
			.slice(1)
			.map((n, i) => ({ from: (nodes[i] as { id: string }).id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
		annotations: [],
	};
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		await client.query(
			`insert into agents (name, project_id, info, status, registered_at, last_seen_at)
			values ('agent-a', 'default', '{"agent_version":"0.5.0","os":"linux","arch":"x86_64","slots":2}', 'offline', $1, $1)
			on conflict (name) do nothing`,
			[at],
		);
		await client.query(
			"insert into orchestrations (id, project_id, name, description, head_version, created_at) values ($1, 'default', '运行视图大小', '', 1, $2)",
			[scenario, at],
		);
		await client.query(
			`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
			values ($1, $2, 1, $3, '性能测试', $4)`,
			[version, scenario, JSON.stringify(document), at],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at, ended_at)
			values ($1, $2, $3, 'default', '性能测试', '{}', 'success', $4, $4)`,
			[run, scenario, version, at],
		);
		await client.query(
			`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at, ended_at)
			values ($1, $2, 'entry', 0, '{}', 'success', $3, $3)`,
			[chain, run, at],
		);
		await client.query(
			`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, agent_name, status, queued_at, started_at, ended_at, inputs, outputs)
			select gen_random_uuid(), $1, $2, 'n' || g, 1, 'agent-a', 'success', $3::timestamptz, $3::timestamptz, $3::timestamptz,
				jsonb_build_object('text', repeat('x', $4::int)), jsonb_build_object('text', repeat('y', $4::int))
			from generate_series(1, $5::int) g`,
			[run, chain, at, chars, tasks],
		);
	} finally {
		await client.end();
	}
	return run;
}

export default definePerfItem({
	id: "run-view-size",
	title: "运行视图的大小有上界（60 个任务各有 1 MiB 的输入输出）",
	scope: "运行视图",
	needsArtifacts: false,
	async run(ctx): Promise<ItemRun> {
		ctx.log("启动被测对象：独立的数据库与以 main.ts 运行的控制面");
		const database = await createTestDatabase("sfly_perf");
		ctx.defer(() => database.drop());
		const server = await startSourceServer({ databaseUrl: database.url });
		ctx.defer(() => server.stop());
		const big = await seedRun(database.url, TASKS, VALUE_CHARS);
		const small = await seedRun(database.url, 1, 100);
		ctx.log(`种了一个运行：${TASKS} 个任务，输入、输出各 ${VALUE_CHARS} 个字符`);

		// 预热。
		await (await server.fetch(`/runs/${big}`)).arrayBuffer();
		const serverSampler = sampleProcess(server.child.pid as number);

		const times: number[] = [];
		const stalls: number[] = [];
		let bodyBytes = 0;
		for (let i = 0; i < READS; i++) {
			// 读大的视图的同时，每 5 毫秒发一个小请求：它的等待就是控制面的事件循环被占住的时间。
			let reading = true;
			const probes: number[] = [];
			const prober = (async () => {
				while (reading) {
					const started = performance.now();
					await (await server.fetch(`/runs/${small}`)).arrayBuffer();
					probes.push(performance.now() - started);
					await sleep(5);
				}
			})();
			const started = performance.now();
			const body = await (await server.fetch(`/runs/${big}`)).arrayBuffer();
			times.push(performance.now() - started);
			reading = false;
			await prober;
			bodyBytes = Math.max(bodyBytes, body.byteLength);
			stalls.push(Math.max(...probes));
		}

		// 事件流里的第一条 `run`：连上时推送一整份视图。
		const stream = await server.fetch(`/runs/${big}/events`, {
			headers: { accept: "text/event-stream" },
		});
		let streamed = "";
		const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !/\n\n/.test(streamed)) {
			const { value, done } = await reader.read();
			if (done) break;
			streamed += decoder.decode(value, { stream: true });
		}
		await reader.cancel();
		const firstEvent = streamed.slice(0, streamed.indexOf("\n\n") + 2);

		// 被省略的内容取回来和种进去的一样（第一个、最后一个任务）。
		const view = (await (await server.fetch(`/runs/${big}`)).json()) as {
			chains: Array<{
				nodes: Array<{
					attempts: Array<{
						task_id: string;
						outputs: unknown;
						outputs_omitted_bytes: number | null;
					}>;
				}>;
			}>;
		};
		const attempts = (view.chains[0]?.nodes ?? []).flatMap((n) => n.attempts);
		const omitted = attempts.filter((a) => a.outputs_omitted_bytes !== null);
		let mismatched = 0;
		for (const attempt of [omitted[0], omitted.at(-1)]) {
			if (!attempt) {
				mismatched++;
				continue;
			}
			const io = (await (await server.fetch(`/tasks/${attempt.task_id}/io`)).json()) as {
				outputs: { text?: string } | null;
			};
			if (io.outputs?.text !== "y".repeat(VALUE_CHARS)) mismatched++;
		}

		const read = distribution(times);
		const usage = usageMeasurements(await serverSampler.stop(), CONTROL_PLANE, {
			rssMb: 20,
			cpuPercent: 5,
		});
		const measurements: Measurement[] = [
			{
				id: "body_bytes",
				label: `运行视图的响应体（${TASKS} 个任务各有 ${VALUE_CHARS} 个字符的输入、输出）`,
				value: bodyBytes,
				unit: "B",
				check: hard("<=", MAX_BODY_BYTES),
			},
			{
				id: "first_event_bytes",
				label: "事件流连上时的第一条 run 事件",
				value: Buffer.byteLength(firstEvent),
				unit: "B",
				check: hard("<=", MAX_BODY_BYTES),
			},
			{
				id: "omitted_mismatch",
				label: "被省略的输出用 /tasks/:id/io 取回来和种进去的不一样的个数",
				value: mismatched,
				unit: "个",
				check: hard("<=", 0),
			},
			{
				id: "omitted_tasks",
				label: "被省略输出的任务数（至少有一个，否则没有量到省略）",
				value: omitted.length,
				unit: "个",
				check: hard(">=", 1),
			},
			{
				id: "read_p95_ms",
				label: "读一次运行视图的耗时（p95）",
				value: read?.p95 ?? 0,
				unit: "ms",
				noise: 50,
				check: target("<=", 300),
			},
			{
				id: "max_stall_ms",
				label: "读运行视图时同时发出的小请求的最长等待（事件循环被占住多久）",
				value: Math.max(...stalls),
				unit: "ms",
				noise: 20,
				check: target("<=", 100),
			},
			usage.peak,
			usage.growth,
		];
		return {
			measurements,
			notes: [
				`读 ${READS} 次，响应体最大 ${(bodyBytes / 1048576).toFixed(2)} MiB；改之前同样的运行是 172 MB、读一次 1.15 秒、事件循环一次被占住 338 毫秒（#633）。`,
			],
		};
	},
});
