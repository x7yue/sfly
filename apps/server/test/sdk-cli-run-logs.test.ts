// sfly run logs / artifacts：真实的 sfly 进程读测试控制面里一次运行的日志和产物。
// 假 Agent 经 gRPC 上报日志（两台 Agent 的 Agent 时间偏差不同），产物经 HTTP 上传。
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRunLogScope, logsApi, type RunLogLine, runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import {
	type AssignedTask,
	agentClock,
	FakeAgent,
	LogLevel,
	LogSource,
} from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { sfly } from "./support/sfly-cli.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 主链 entry → spawn → z（失败时重试 1 次）→ a；spawn 派发子流程「回放」sub → s（在 agent-b 上执行）。 */
const DOC = orchestration(
	[
		[{ id: "entry", kind: "entry" }, spawn("spawn"), { ...echo("z"), retries: 1 }, echo("a")],
		[
			{ id: "sub", kind: "subflow_entry", name: "回放", params: [] },
			{ ...echo("s"), agent: "agent-b" },
		],
	],
	[["spawn", "sub"]],
);

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const AGENTS = {
	"agent-a": { agentT0: T0 + 613 * DAY, m0: 5_000 },
	"agent-b": { agentT0: T0 - DAY, m0: 90_000 },
} as const;
type AgentName = keyof typeof AGENTS;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** 文本输出的一行：时间 级别 链:节点[#尝试] 内容。 */
const row = (atMs: number, level: string, label: string, text: string) =>
	`${iso(T0 + atMs)} ${level.padEnd(5)} ${label} ${text}`;

describe("sfly run logs / artifacts → 控制面", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	const agents: FakeAgent[] = [];
	const tempDirs: string[] = [];

	beforeEach(() => {
		clock = new ManualClock(iso(T0));
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
		await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
	});

	const setup = async (options: { logScanBytes?: number; logLimitBytes?: number } = {}) => {
		cp = await startTestControlPlane({ clock, leaseMs: 30 * DAY, ...options });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		const connect = async (name: AgentName) => {
			const { agentT0, m0 } = AGENTS[name];
			const agent = await FakeAgent.connect(cp.grpcUrl, { name, ...agentClock(agentT0, m0) });
			agents.push(agent);
			return agent;
		};
		const a = await connect("agent-a");
		const b = await connect("agent-b");
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		return { a, b, runId };
	};

	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl]);
	const tempDir = async () => {
		const dir = await mkdtemp(join(tmpdir(), "sfly-run-logs-"));
		tempDirs.push(dir);
		return dir;
	};

	/** 第 seq 行：Agent 在控制面时间 T0 + atMs 读到它。 */
	const line = (
		agent: FakeAgent,
		seq: number,
		atMs: number,
		text: string,
		level = LogLevel.INFO,
	) => {
		const { agentT0, m0 } = AGENTS[agent.name as AgentName];
		return {
			seq: BigInt(seq),
			timeUnixMs: BigInt(agentT0 + atMs),
			monotonicMs: BigInt(m0 + atMs),
			source: LogSource.STDOUT,
			level,
			text,
		};
	};

	const apiPage = async (runId: string, query = "") => {
		const res = await cp.fetch(`/runs/${runId}/logs${query ? `?${query}` : ""}`);
		expect(res.status, await res.clone().text()).toBe(200);
		return logsApi.runPage.response.parse(await res.json());
	};
	/** 等控制面合并结果里有 n 行（日志经 gRPC 异步送达）。 */
	const settled = async (runId: string, n: number) => {
		await eventually(async () =>
			expect((await apiPage(runId, "limit=1000")).lines).toHaveLength(n),
		);
	};
	const getRun = async (runId: string) =>
		runsApi.get.response.parse(await (await cp.fetch(`/runs/${runId}`)).json());
	const hintCursor = (stdout: string, direction: "before" | "after") => {
		const last = stdout.trimEnd().split("\n").at(-1) ?? "";
		const match = new RegExp(
			`^${direction === "before" ? "前面" : "后面"}还有日志，用 --${direction} <游标> 继续读：sfly run logs \\S+ .*--${direction} (\\S+)$`,
		).exec(last);
		expect(match, `最后一行是继续读的提示：${last}`).not.toBeNull();
		return match?.[1] as string;
	};

	/** 只有 z 的一次尝试，写 n 行：第 i 行在 1000 + 10 i 毫秒，每 50 行一个 warn、每 100 行一个 error。 */
	const longLog = async (n: number, options: { logScanBytes?: number } = {}) => {
		const { a, runId } = await setup(options);
		const z = await a.nextAssign();
		a.logs(
			z,
			Array.from({ length: n }, (_, i) =>
				line(
					a,
					i + 1,
					1_000 + 10 * (i + 1),
					`z line ${i + 1}`,
					(i + 1) % 100 === 0 ? LogLevel.ERROR : (i + 1) % 50 === 0 ? LogLevel.WARN : LogLevel.INFO,
				),
			),
		);
		await eventually(async () => {
			const own = logsApi.page.response.parse(
				await (await cp.fetch(`/tasks/${z.taskId}/logs?limit=1`)).json(),
			);
			expect(own.last_seq).toBe(n);
		});
		return { runId };
	};
	const zRow = (i: number) =>
		row(
			1_000 + 10 * i,
			i % 100 === 0 ? "error" : i % 50 === 0 ? "warn" : "info",
			"main:z",
			`z line ${i}`,
		);
	const zRows = (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, i) => zRow(from + i));

	describe("run logs：条数、截断提示、游标", () => {
		it("默认最后 200 行，前面还有日志时最后一行写明用 --before 继续读，翻到开头就不再提示", async () => {
			const { runId } = await longLog(230);

			const first = await cli("run", "logs", runId);
			expect(first.code, first.stderr).toBe(0);
			expect(first.stderr).toBe("");
			const rows = first.stdout.trimEnd().split("\n");
			expect(rows).toHaveLength(201);
			expect(rows.slice(0, 200)).toEqual(zRows(31, 230));
			const cursor = hintCursor(first.stdout, "before");

			const second = await cli("run", "logs", runId, "--before", cursor);
			expect(second.code, second.stderr).toBe(0);
			expect(second.stdout).toBe(`${zRows(1, 30).join("\n")}\n`);
		});

		it("--tail 改条数；--json 每行一个对象、字段和接口一致，提示写到 stderr", async () => {
			const { runId } = await longLog(30);

			const text = await cli("run", "logs", runId, "--tail", "5");
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout.trimEnd().split("\n").slice(0, 5)).toEqual(zRows(26, 30));
			expect(hintCursor(text.stdout, "before")).toBeTruthy();
			expect(text.stdout).toContain("--tail 5");

			const json = await cli("run", "logs", runId, "--tail", "3", "--json");
			expect(json.code, json.stderr).toBe(0);
			const objects = json.stdout
				.trimEnd()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(objects).toEqual((await apiPage(runId, "limit=3")).lines);
			expect(objects.map((o: RunLogLine) => o.text)).toEqual([
				"z line 28",
				"z line 29",
				"z line 30",
			]);
			expect(json.stderr).toContain("前面还有日志，用 --before <游标> 继续读");

			const all = await cli("run", "logs", runId, "--json");
			expect(all.stdout.trimEnd().split("\n")).toHaveLength(30);
			expect(all.stderr).toBe("");
		});

		it("--after 从游标往后读，后面还有日志时提示用 --after 继续读", async () => {
			const { runId } = await longLog(60);
			const { before } = await apiPage(runId, "limit=30");

			const first = await cli("run", "logs", runId, "--after", before, "--tail", "10");
			expect(first.code, first.stderr).toBe(0);
			expect(first.stdout.trimEnd().split("\n").slice(0, 10)).toEqual(zRows(31, 40));
			const cursor = hintCursor(first.stdout, "after");

			const rest = await cli("run", "logs", runId, "--after", cursor);
			expect(rest.code, rest.stderr).toBe(0);
			expect(rest.stdout).toBe(`${zRows(41, 60).join("\n")}\n`);
		});

		it("--level 筛选；控制面一次只扫描一小段时也翻页凑够条数", async () => {
			const { runId } = await longLog(230, { logScanBytes: 4_000 });

			const levels = await cli("run", "logs", runId, "--level", "warn,error");
			expect(levels.code, levels.stderr).toBe(0);
			expect(levels.stdout).toBe(`${[50, 100, 150, 200].map(zRow).join("\n")}\n`);

			const errors = await cli("run", "logs", runId, "--level", "error", "--tail", "1");
			expect(errors.stdout.trimEnd().split("\n")[0]).toBe(zRow(200));
			const cursor = hintCursor(errors.stdout, "before");
			expect(errors.stdout).toContain("--level error");
			const older = await cli("run", "logs", runId, "--level", "error", "--before", cursor);
			expect(older.stdout).toBe(`${zRow(100)}\n`);

			const tail = await cli("run", "logs", runId, "--tail", "40");
			expect(tail.stdout.trimEnd().split("\n").slice(0, 40)).toEqual(zRows(191, 230));

			const bad = await cli("run", "logs", runId, "--level", "loud");
			expect(bad.code).toBe(2);
			expect(bad.stderr).toContain("--level 不认识");
		});
	});

	describe("run logs：筛选、重试的尝试次数", () => {
		/** z 失败一次后重试，主链与子流程并行；z 第 2 次也失败，运行失败。 */
		const failedRun = async () => {
			const { a, b, runId } = await setup();
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			a.logs(z1, [line(a, 1, 1_000, "z1 first"), line(a, 2, 3_000, "z1 second", LogLevel.ERROR)]);
			b.logs(s, [line(b, 1, 2_000, "s first"), line(b, 2, 4_000, "s second", LogLevel.WARN)]);
			await a.fail(z1, "boom 1");
			const z2 = await a.nextAssign();
			a.logs(z2, [line(a, 1, 5_000, "z2 first"), line(a, 2, 7_000, "z2 second", LogLevel.ERROR)]);
			await b.succeed(s);
			await a.fail(z2, "boom 2");
			await settled(runId, 6);
			await eventually(async () => expect((await getRun(runId)).status).toBe("failed"));
			return { runId, z1, z2, s };
		};

		it("每行写明链、节点；重试过的节点每行都写明第几次尝试", async () => {
			const { runId } = await failedRun();
			const result = await cli("run", "logs", runId);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(
				`${[
					row(1_000, "info", "main:z#1", "z1 first"),
					row(2_000, "info", "回放:s", "s first"),
					row(3_000, "error", "main:z#1", "z1 second"),
					row(4_000, "warn", "回放:s", "s second"),
					row(5_000, "info", "main:z#2", "z2 first"),
					row(7_000, "error", "main:z#2", "z2 second"),
				].join("\n")}\n`,
			);
		});

		it("--node 只看指定节点的所有尝试，可以重复；--level 筛选；--failed 只看失败的任务", async () => {
			const { runId } = await failedRun();
			const lines = async (...args: string[]) => {
				const result = await cli("run", "logs", runId, ...args);
				expect(result.code, result.stderr).toBe(0);
				return result.stdout.trimEnd().split("\n");
			};

			expect(await lines("--node", "main:z")).toEqual([
				row(1_000, "info", "main:z#1", "z1 first"),
				row(3_000, "error", "main:z#1", "z1 second"),
				row(5_000, "info", "main:z#2", "z2 first"),
				row(7_000, "error", "main:z#2", "z2 second"),
			]);
			expect(await lines("--node", "回放:s")).toEqual([
				row(2_000, "info", "回放:s", "s first"),
				row(4_000, "warn", "回放:s", "s second"),
			]);
			expect(await lines("--node", "回放:s", "--node", "main:z", "--level", "error")).toEqual([
				row(3_000, "error", "main:z#1", "z1 second"),
				row(7_000, "error", "main:z#2", "z2 second"),
			]);
			expect(await lines("--failed")).toEqual([
				row(1_000, "info", "main:z#1", "z1 first"),
				row(3_000, "error", "main:z#1", "z1 second"),
				row(5_000, "info", "main:z#2", "z2 first"),
				row(7_000, "error", "main:z#2", "z2 second"),
			]);
			expect(await lines("--failed", "--level", "warn,error")).toEqual([
				row(3_000, "error", "main:z#1", "z1 second"),
				row(7_000, "error", "main:z#2", "z2 second"),
			]);
			expect(await lines("--failed", "--node", "回放:s")).toEqual(["没有失败的任务"]);
		});

		it("重试后成功的节点，--failed 只看失败的那一次尝试", async () => {
			const { a, runId } = await setup();
			const z1 = await a.nextAssign();
			a.logs(z1, [line(a, 1, 1_000, "z1 only")]);
			await a.fail(z1, "boom");
			const z2 = await a.nextAssign();
			a.logs(z2, [line(a, 1, 2_000, "z2 fine")]);
			await settled(runId, 2);

			const result = await cli("run", "logs", runId, "--failed");
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${row(1_000, "info", "main:z#1", "z1 only")}\n`);
			const all = await cli("run", "logs", runId, "--node", "main:z");
			expect(all.stdout).toBe(
				`${[
					row(1_000, "info", "main:z#1", "z1 only"),
					row(2_000, "info", "main:z#2", "z2 fine"),
				].join("\n")}\n`,
			);
		});

		it("没有失败的任务、没有日志、节点不存在、运行不存在时的输出", async () => {
			const { a, runId } = await setup();
			await a.nextAssign();

			const none = await cli("run", "logs", runId, "--failed");
			expect(none.code, none.stderr).toBe(0);
			expect(none.stdout).toBe("没有失败的任务\n");
			const empty = await cli("run", "logs", runId);
			expect(empty.code, empty.stderr).toBe(0);
			expect(empty.stdout).toBe("没有日志\n");
			expect((await cli("run", "logs", runId, "--json")).stdout).toBe("");

			const node = await cli("run", "logs", runId, "--node", "nope:x");
			expect(node.code).toBe(2);
			expect(node.stdout).toBe("");
			expect(node.stderr).toContain("运行里没有节点 nope:x");
			expect(node.stderr).toContain("main:z");
			expect(node.stderr).toContain("回放:s");

			const missing = await cli("run", "logs", "00000000-0000-4000-8000-000000000000");
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("没有 id 是 00000000-0000-4000-8000-000000000000 的运行");

			const both = await cli("run", "logs", runId, "--before", "x", "--after", "y");
			expect(both.code).toBe(2);
		});

		it("日志超过大小上限被截断的任务写在提示里", async () => {
			const { a, runId } = await setup({ logLimitBytes: 600 });
			const z = await a.nextAssign();
			a.logs(
				z,
				Array.from({ length: 10 }, (_, i) => line(a, i + 1, 1_000 + i * 100, `z line ${i + 1}`)),
			);
			await eventually(async () => expect((await apiPage(runId)).truncated_tasks).toHaveLength(1));

			const result = await cli("run", "logs", runId);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("main:z 日志超过 600 字节 上限，之后的内容已被截断");
			expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
				"这些任务的日志超过大小上限，被截断了：main:z#1",
			);
		});
	});

	describe("run logs --all：下载完整日志", () => {
		it("写出的文件和控制面的下载接口一致，stdout 只有路径和行数", async () => {
			const { runId } = await longLog(30);
			const dir = await tempDir();
			const target = join(dir, "logs", "all.jsonl");

			const result = await cli("run", "logs", runId, "--all", target);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toBe(`已下载 30 行日志到 ${target}\n`);
			const download = await cp.fetch(`/runs/${runId}/logs/download`);
			expect(download.status).toBe(200);
			expect(await readFile(target)).toEqual(Buffer.from(await download.arrayBuffer()));

			const json = await cli("run", "logs", runId, "--all", join(dir, "b.jsonl"), "--json");
			expect(json.code, json.stderr).toBe(0);
			expect(JSON.parse(json.stdout)).toEqual({ path: join(dir, "b.jsonl"), lines: 30 });
		});

		it("--node、--failed 限定范围，和带同样范围的下载接口一致；不能和翻页、级别选项一起用", async () => {
			const { a, b, runId } = await setup();
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			a.logs(z1, [line(a, 1, 1_000, "z1")]);
			b.logs(s, [line(b, 1, 2_000, "s1"), line(b, 2, 3_000, "s2")]);
			await a.fail(z1, "boom");
			const z2 = await a.nextAssign();
			a.logs(z2, [line(a, 1, 4_000, "z2")]);
			await settled(runId, 4);
			const run = await getRun(runId);
			const subflow = run.chains.find((c) => c.name === "回放")?.id as string;
			const dir = await tempDir();

			const byNode = join(dir, "s.jsonl");
			expect((await cli("run", "logs", runId, "--node", "回放:s", "--all", byNode)).stdout).toBe(
				`已下载 2 行日志到 ${byNode}\n`,
			);
			const scope = encodeRunLogScope([{ chain_instance_id: subflow, node_id: "s" }]);
			const download = await cp.fetch(
				`/runs/${runId}/logs/download?nodes=${encodeURIComponent(scope)}`,
			);
			expect(await readFile(byNode)).toEqual(Buffer.from(await download.arrayBuffer()));

			const failed = join(dir, "failed.jsonl");
			expect((await cli("run", "logs", runId, "--failed", "--all", failed)).stdout).toBe(
				`已下载 1 行日志到 ${failed}\n`,
			);
			const rows = (await readFile(failed, "utf8")).trimEnd().split("\n");
			expect(rows.map((r) => JSON.parse(r))).toMatchObject([
				{ task_id: z1.taskId, node_id: "z", attempt: 1, text: "z1" },
			]);

			for (const extra of [
				["--level", "error"],
				["--tail", "5"],
				["--before", "x"],
			]) {
				const conflict = await cli("run", "logs", runId, "--all", join(dir, "x.jsonl"), ...extra);
				expect(conflict.code, extra.join(" ")).toBe(2);
				expect(conflict.stderr).toContain("--all");
			}
		});
	});

	describe("run artifacts", () => {
		const upload = (task: AssignedTask, name: string, body: string | Buffer) =>
			fetch(`${task.artifactUploadUrl}${name.split("/").map(encodeURIComponent).join("/")}`, {
				method: "PUT",
				headers: { "content-type": "application/octet-stream" },
				body,
			});

		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254]);
		const artifactRun = async () => {
			const { a, b, runId } = await setup();
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			expect((await upload(z1, "report.txt", "attempt one")).status).toBe(201);
			expect((await upload(s, "out/回放.log", "replayed")).status).toBe(201);
			await a.fail(z1, "boom");
			const z2 = await a.nextAssign();
			expect((await upload(z2, "report.txt", "attempt two")).status).toBe(201);
			expect((await upload(z2, "图/截图.png", png)).status).toBe(201);
			return { runId, z1, z2, s };
		};

		it("列出各任务的产物（名称、大小、sha256），重试过的节点写明第几次尝试", async () => {
			const { runId, z1, z2, s } = await artifactRun();

			const result = await cli("run", "artifacts", runId);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			const cells = result.stdout
				.trimEnd()
				.split("\n")
				.map((l) => l.split(/ {2,}/));
			expect(cells).toEqual([
				["任务", "名称", "大小", "sha256"],
				["main:z#1", "report.txt", "11 字节", sha256("attempt one")],
				["main:z#2", "report.txt", "11 字节", sha256("attempt two")],
				["main:z#2", "图/截图.png", `${png.length} 字节`, sha256(png)],
				["回放:s", "out/回放.log", "8 字节", sha256("replayed")],
			]);

			const json = await cli("run", "artifacts", runId, "--json");
			expect(json.code, json.stderr).toBe(0);
			expect(JSON.parse(json.stdout)).toMatchObject([
				{ task_id: z1.taskId, chain: "main", node: "z", attempt: 1, name: "report.txt" },
				{ task_id: z2.taskId, attempt: 2, name: "report.txt", size: 11 },
				{ task_id: z2.taskId, name: "图/截图.png", sha256: sha256(png) },
				{ task_id: s.taskId, chain: "回放", node: "s", attempt: 1, name: "out/回放.log" },
			]);
		});

		it("--task 按任务 id、链:节点、链:节点#尝试选择", async () => {
			const { runId, z1, z2 } = await artifactRun();
			const names = async (...args: string[]) => {
				const result = await cli("run", "artifacts", runId, "--json", ...args);
				expect(result.code, result.stderr).toBe(0);
				return (JSON.parse(result.stdout) as Array<{ task_id: string; name: string }>).map((r) => [
					r.task_id,
					r.name,
				]);
			};

			expect(await names("--task", z1.taskId)).toEqual([[z1.taskId, "report.txt"]]);
			expect(await names("--task", "main:z#2")).toEqual([
				[z2.taskId, "report.txt"],
				[z2.taskId, "图/截图.png"],
			]);
			expect(await names("--task", "main:z")).toHaveLength(3);
			expect(await names("--task", "main:z#1", "--task", "回放:s")).toHaveLength(2);

			const missing = await cli("run", "artifacts", runId, "--task", "main:nope");
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("运行里没有任务 main:nope");
			expect(missing.stderr).toContain("main:z#1");
		});

		it("--download 下载到 <目录>/<任务 id>/<名称>，下载后文件的 sha256 和列表里的一致", async () => {
			const { runId, z1, z2, s } = await artifactRun();
			const dir = join(await tempDir(), "产物");

			const result = await cli("run", "artifacts", runId, "--download", dir, "--json");
			expect(result.code, result.stderr).toBe(0);
			const rows = JSON.parse(result.stdout) as Array<{
				task_id: string;
				name: string;
				sha256: string;
				size: number;
				path: string;
			}>;
			expect(rows.map((r) => r.path)).toEqual([
				join(dir, z1.taskId, "report.txt"),
				join(dir, z2.taskId, "report.txt"),
				join(dir, z2.taskId, "图", "截图.png"),
				join(dir, s.taskId, "out", "回放.log"),
			]);
			for (const r of rows) {
				const data = await readFile(r.path);
				expect(sha256(data), r.name).toBe(r.sha256);
				expect(data.length).toBe(r.size);
			}
			expect(await readFile(join(dir, z2.taskId, "图", "截图.png"))).toEqual(png);

			const text = await cli("run", "artifacts", runId, "--task", "回放:s", "--download", dir);
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout).toContain("保存到");
			expect(text.stdout).toContain(join(dir, s.taskId, "out", "回放.log"));
		});

		it("没有产物、运行不存在时的输出", async () => {
			const { a, runId } = await setup();
			await a.nextAssign();

			const none = await cli("run", "artifacts", runId);
			expect(none.code, none.stderr).toBe(0);
			expect(none.stdout).toBe("这次运行没有产物\n");
			expect((await cli("run", "artifacts", runId, "--json")).stdout).toBe("[]\n");

			const missing = await cli("run", "artifacts", "00000000-0000-4000-8000-000000000000");
			expect(missing.code).toBe(2);
			expect(missing.stderr).toContain("没有 id 是");
		});
	});
});
