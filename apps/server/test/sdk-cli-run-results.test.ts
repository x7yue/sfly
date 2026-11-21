// sfly run show --outputs / --state、run actions、run metrics，运行编号写前缀或 latest，摘要里的「失败的动作」
// 「有异常的关注项」两段（#423）。真实的 sfly 进程对着测试控制面，运行的成功、失败、动作、指标由假 Agent 产生。
import { cp as copy, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunState } from "@sfly/schema";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { benchDocument, publishBench, putFocusItemsOk } from "./support/focus-items.js";
import { ManualClock } from "./support/manual-clock.js";
import { type OldControlPlane, startOldControlPlane } from "./support/old-control-plane.js";
import { publishPackage } from "./support/package-archive.js";
import { repoRoot, sfly } from "./support/sfly-cli.js";
import { spawnSfly } from "./support/sfly-process.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** 测试时钟的起点之后第 s 秒（Unix 秒）。 */
const at = (s: number) => T0 / 1000 + s;

type Node = Record<string, unknown> & { id: string };
const echo = (id: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	...extra,
});

describe("sfly run show --outputs / --state、run actions、run metrics → 控制面", {
	timeout: 60_000,
}, () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const clock = new ManualClock();
	let agents = 0;

	/** 入口加按顺序连成一条链的节点。 */
	const scenario = (name: string, nodes: Node[]) => {
		const all: Node[] = [{ id: "entry", kind: "entry", params: [] }, ...nodes];
		return api.orchestrationWith(
			{
				default_agent: agent.name,
				nodes: all,
				edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
				packages: { stub: "1.0.0", bench: "1.0.0" },
			},
			name,
		);
	};
	const cli = (...args: string[]) => sfly([...args, "--server", cp.httpUrl, "--nickname", "alice"]);
	const trigger = async (id: string) => {
		const res = await api.trigger(id, {}, "alice");
		return ((await res.json()) as { id: string }).id;
	};
	const assign = () => agent.nextAssign({ timeoutMs: 30_000 });
	const stamp = (ms: number) => agent.stamp(T0 + ms);
	const failedAction = (
		id: number,
		name: string,
		startMs: number,
		endMs: number,
		reason: string,
	) => ({
		id,
		parent: null,
		depth: 0,
		name,
		fields: { 订单: String(1000 + id) },
		...stamp(startMs),
		end_ts: T0 + endMs,
		end_mono: stamp(endMs).mono,
		result: "failed" as const,
		reason,
	});

	beforeAll(async () => {
		cp = await startTestControlPlane({ clock, leaseMs: 60 * 60_000 });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await publishBench(cp);
	}, 120_000);
	beforeEach(async () => {
		agent = await FakeAgent.connect(cp.grpcUrl, { name: `agent-${++agents}`, slots: 4 }, { clock });
	});
	afterEach(async () => {
		await agent.disconnect();
	});
	afterAll(async () => {
		await cp?.close();
	});

	describe("运行编号：前缀和 latest", () => {
		it("写前缀、写 latest 都读到同一次运行；不认识的前缀、太短的前缀、latest 用于取消都给出下一步", async () => {
			const runId = await trigger(await scenario("编号场景", [echo("a")]));
			await agent.succeed(await assign());

			const full = await cli("run", "show", runId, "--json");
			expect(full.code, full.stderr).toBe(0);
			for (const ref of [runId.slice(0, 8), runId.toUpperCase().slice(0, 12), "latest"]) {
				const result = await cli("run", "show", ref, "--json");
				expect(result.code, `${ref}：${result.stderr}`).toBe(0);
				expect((JSON.parse(result.stdout) as { id: string }).id).toBe(runId);
			}
			// 其他命令也认前缀和 latest。
			expect((await cli("run", "wait", runId.slice(0, 8))).stdout).toContain(`运行 ${runId}：成功`);
			expect((await cli("run", "logs", "latest")).code).toBe(0);

			const unknown = await cli("run", "show", "ffff0000", "--json");
			expect(unknown.code).toBe(2);
			expect(JSON.parse(unknown.stderr)).toEqual({
				error: {
					code: "run_not_found",
					message: "没有 id 是 ffff0000 的运行",
					next: "sfly run list",
				},
			});
			const tooShort = await cli("run", "show", runId.slice(0, 3), "--json");
			expect(JSON.parse(tooShort.stderr).error.code).toBe("run_prefix_too_short");

			const cancel = await cli("run", "cancel", "latest", "--json");
			expect(cancel.code).toBe(2);
			expect(JSON.parse(cancel.stderr).error).toMatchObject({
				code: "invalid_arguments",
				next: "sfly run list",
			});
		});

		it("latest 是自己（昵称）触发的最近一次，别人触发的不算；没有自己触发过的运行时报错", async () => {
			const id = await scenario("最近场景", [echo("a")]);
			// 手动时钟不走：前面的用例触发的运行和这次的开始时间相同，先让时间过去。
			clock.advance(60_000);
			const mine = await trigger(id);
			const theirs = ((await (await api.trigger(id, {}, "bob")).json()) as { id: string }).id;
			expect(theirs).not.toBe(mine);

			const latest = await cli("run", "show", "latest", "--json");
			expect((JSON.parse(latest.stdout) as { id: string }).id).toBe(mine);
			const bob = await sfly([
				"run",
				"show",
				"latest",
				"--json",
				"--server",
				cp.httpUrl,
				"--nickname",
				"bob",
			]);
			expect((JSON.parse(bob.stdout) as { id: string }).id).toBe(theirs);

			const stranger = await sfly([
				"run",
				"show",
				"latest",
				"--json",
				"--server",
				cp.httpUrl,
				"--nickname",
				"nobody-ran-this",
			]);
			expect(stranger.code).toBe(2);
			expect(JSON.parse(stranger.stderr).error.code).toBe("no_recent_run");
		});
	});

	describe("run show --outputs", () => {
		it("各节点的输出（节点最后一次尝试的）：文本一个节点一段，--json 是数组，--node 只看选中的", async () => {
			const runId = await trigger(
				await scenario("输出场景", [
					{ ...echo("a", { retries: 1 }), display_name: "取数" },
					echo("b"),
					echo("c"),
				]),
			);
			await agent.fail(await assign(), "第一次失败");
			await agent.succeed(await assign(), { rows: [{ id: 1 }, { id: 2 }], total: 2 });
			await agent.succeed(await assign(), { ok: true });
			await agent.fail(await assign(), "最后失败");

			const text = await cli("run", "show", runId, "--outputs");
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout).toBe(
				[
					"main:a#2「取数」  成功",
					"  {",
					'    "rows": [',
					"      {",
					'        "id": 1',
					"      },",
					"      {",
					'        "id": 2',
					"      }",
					"    ],",
					'    "total": 2',
					"  }",
					"",
					"main:b  成功",
					"  {",
					'    "ok": true',
					"  }",
					"",
				].join("\n"),
			);

			const json = await cli("run", "show", runId, "--outputs", "--json");
			const rows = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
			expect(
				rows.map((r) => [r.chain, r.node, r.status, r.attempt, r.attempts, r.outputs]),
			).toEqual([
				["main", "a", "success", 2, 2, { rows: [{ id: 1 }, { id: 2 }], total: 2 }],
				["main", "b", "success", 1, 1, { ok: true }],
			]);
			expect(rows[0]).toMatchObject({ display_name: "取数" });
			expect(typeof rows[0]?.task).toBe("string");

			const only = await cli("run", "show", runId, "--outputs", "--node", "main:b", "--json");
			expect((JSON.parse(only.stdout) as Array<{ node: string }>).map((r) => r.node)).toEqual([
				"b",
			]);
			const none = await cli("run", "show", runId, "--outputs", "--node", "main:c");
			expect(none.stdout).toBe("所选节点没有输出（没执行完、失败或被跳过的节点没有输出）\n");
			const unknown = await cli("run", "show", runId, "--outputs", "--node", "main:zzz");
			expect(unknown.code).toBe(2);
			expect(unknown.stderr).toContain("运行里没有节点 main:zzz");
		});

		it("大输出在文本里截断并写明怎么读完整的，--json 给完整的输出；节点多时 --limit 截断并提示", async () => {
			const big = "x".repeat(5000);
			const runId = await trigger(await scenario("大输出场景", [echo("a"), echo("b"), echo("c")]));
			await agent.succeed(await assign(), { text: big });
			await agent.succeed(await assign(), { n: 1 });
			await agent.succeed(await assign(), { n: 2 });

			const text = await cli("run", "show", runId, "--outputs", "--node", "main:a");
			expect(text.stdout).toContain("main:a  成功");
			expect(text.stdout).not.toContain(big);
			expect(text.stdout).toContain(
				`……（输出共 ${JSON.stringify({ text: big }, null, 2).length} 个字符，只显示前 2000 个；` +
					`完整的输出用 sfly run show ${runId} --outputs --node main:a --json）`,
			);
			const json = await cli("run", "show", runId, "--outputs", "--node", "main:a", "--json");
			expect(
				(JSON.parse(json.stdout) as Array<{ outputs: { text: string } }>)[0]?.outputs.text,
			).toBe(big);

			const limited = await cli("run", "show", runId, "--outputs", "--limit", "1", "--json");
			expect((JSON.parse(limited.stdout) as unknown[]).length).toBe(1);
			expect(limited.stderr).toContain(
				"还有 2 个节点的输出没有显示（共 3 个节点的输出），加 --limit 3 查看全部",
			);
		});

		it("--node 需要和 --outputs 一起用，--state 不能和它们一起用", async () => {
			const runId = await trigger(await scenario("选项场景", [echo("a")]));
			const a = await cli("run", "show", runId, "--node", "main:a");
			expect(a.code).toBe(2);
			expect(a.stderr).toContain("--node 要和 --outputs 一起用");
			const b = await cli("run", "show", runId, "--state", "--outputs");
			expect(b.code).toBe(2);
			expect(b.stderr).toContain("--state");
		});
	});

	describe("run show --state", () => {
		it("输出这次运行的运行状态（RunState）：一行 JSON，字段和 schema 一致，没有摘要里多出来的内容", async () => {
			const runId = await trigger(await scenario("状态场景", [echo("a"), echo("b"), echo("c")]));
			await agent.succeed(await assign());
			clock.advance(3_000);
			await agent.fail(
				await assign(),
				"ValueError: 余额不足\n\nTraceback (most recent call last):\n  x",
			);

			for (const flags of [["--state"], ["--state", "--json"]]) {
				const result = await cli("run", "show", runId, ...flags);
				expect(result.code, result.stderr).toBe(0);
				expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
				const state = RunState.parse(JSON.parse(result.stdout));
				expect(state).toMatchObject({
					run_id: runId,
					status: "failed",
					result_so_far: "failed",
					triggered_by: "alice",
					failures: ["b"],
					self: null,
					truncated: false,
				});
				expect(Object.keys(JSON.parse(result.stdout) as object).sort()).toEqual(
					Object.keys(RunState.shape).sort(),
				);
				const b = state.chains[0]?.nodes.find((n) => n.node_id === "b");
				expect(b?.error).toMatchObject({
					kind: "node_error",
					headline: "ValueError: 余额不足",
					message: "ValueError: 余额不足",
					message_truncated: false,
					location: null,
				});
				expect(state.chains[0]?.nodes.find((n) => n.node_id === "c")?.status).toBe("skipped");
			}
		});
	});

	describe("连到比命令行旧的控制面（没有运行摘要接口）", () => {
		let old: OldControlPlane;
		beforeAll(async () => {
			old = await startOldControlPlane(cp.httpUrl);
		});
		afterAll(async () => {
			await old?.close();
		});
		const viaOld = (...args: string[]) =>
			sfly([...args, "--server", old.url, "--nickname", "alice"]);
		const NOTE = "提示：控制面没有运行摘要接口（它比这个命令行旧），摘要只有状态，没有失败的任务；";

		it("run wait 一次已经失败的运行：摘要退回到只有状态，退出码仍然是运行的结果，不是「运行不存在」", async () => {
			const runId = await trigger(await scenario("旧控制面失败", [echo("a")]));
			await agent.fail(await assign(), "boom");

			const text = await viaOld("run", "wait", runId);
			expect(text.code, text.stderr).toBe(1);
			expect(text.stdout.split("\n").slice(0, 3)).toEqual([
				`运行 ${runId}：失败`,
				"耗时：0ms",
				`链接：${old.url}/runs/${runId}`,
			]);
			expect(text.stdout).toContain(
				`${NOTE}用 sfly run show ${runId}、sfly run logs ${runId} --failed 看。`,
			);
			// 没有「失败的任务」这一段（提示里的那句话不算）。
			expect(text.stdout).not.toMatch(/^失败的任务（/m);
			expect(text.stderr).not.toContain("没有 id 是");

			const json = await viaOld("run", "wait", runId, "--json");
			expect(json.code).toBe(1);
			expect(JSON.parse(json.stdout)).toMatchObject({ id: runId, status: "failed", failed: [] });
			expect(json.stderr).toContain(NOTE);
			expect(old.summaryRequests).toContain(`/runs/${runId}/summary`);
		});

		it("run start --wait：等到运行结束，退出码按运行的结果给（失败 1），不是等完了才报错退出 2", async () => {
			await scenario("旧控制面等待", [echo("a")]);
			const waiting = spawnSfly([
				"run",
				"start",
				"旧控制面等待",
				"--wait",
				"--server",
				old.url,
				"--nickname",
				"alice",
			]);
			try {
				await agent.fail(await assign(), "boom");
				const result = await waiting.exited;
				expect(result.code, result.stderr).toBe(1);
				expect(result.stdout).toContain("：失败");
				expect(result.stdout).toContain(NOTE);
			} finally {
				waiting.kill();
			}
		});

		it("run show：状态和每次尝试照旧，少两段，写明为什么；--state 要这个接口，报旧控制面；运行不存在时仍然是运行不存在", async () => {
			const runId = await trigger(await scenario("旧控制面查看", [echo("a")]));
			await agent.fail(await assign(), "boom");

			const show = await viaOld("run", "show", runId);
			expect(show.code, show.stderr).toBe(0);
			expect(show.stdout).toContain("失败或重试过的节点：");
			expect(show.stdout).not.toContain("失败的动作");
			expect(show.stdout).toContain(NOTE);

			const state = await viaOld("run", "show", runId, "--state", "--json");
			expect(state.code).toBe(2);
			expect(JSON.parse(state.stderr).error).toMatchObject({
				code: "summary_unavailable",
				message:
					"控制面没有运行摘要接口（它比这个命令行旧）：升级控制面，或用和控制面同版本的命令行",
			});

			const missing = await viaOld("run", "show", "00000000-0000-4000-8000-000000000000", "--json");
			expect(missing.code).toBe(2);
			expect(JSON.parse(missing.stderr).error.code).toBe("run_not_found");
		});
	});

	describe("run show --state 的输出喂给本地调试", () => {
		it("从一次真实运行取到的运行状态，原样放进 sfly debug --params @文件，汇总节点按它写出卡片", async () => {
			const runId = await trigger(await scenario("喂调试场景", [echo("a"), echo("b")]));
			await agent.succeed(await assign());
			clock.advance(1_000);
			await agent.fail(
				await assign(),
				"ValueError: 余额不足\n\nTraceback (most recent call last):\n  x",
			);

			const state = JSON.parse((await cli("run", "show", runId, "--state")).stdout) as unknown;
			const dir = await mkdtemp(join(tmpdir(), "sfly-state-debug-"));
			try {
				// 桩节点包复制到临时目录：本地调试在项目下写运行目录，不碰仓库里的。
				const project = join(dir, "stub");
				await copy(join(repoRoot, "testdata/stub-package"), project, { recursive: true });
				const file = join(dir, "state.json");
				await writeFile(file, JSON.stringify({ bot: "ops", run: state }));

				const result = await sfly([
					"debug",
					"run_summary",
					"--project",
					project,
					"--params",
					`@${file}`,
				]);
				expect(result.code, result.stderr).toBe(0);
				// 通知的内容写在 stderr（本地调试不发送）。
				expect(result.stderr).toContain("本地调试不发送");
				expect(result.stderr).toContain("喂调试场景：有节点失败");
				expect(result.stderr).toContain("- 失败：b：ValueError: 余额不足");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	});

	describe("run actions", () => {
		/** 一个任务：下单（5 个，1 个失败）、付款；失败的节点。 */
		const actionsRun = async () => {
			const runId = await trigger(
				await scenario("动作场景", [echo("place", { retries: 1 }), echo("pay")]),
			);
			const first = await assign();
			agent.actionSummary(first, {
				total: 3,
				reported: 3,
				names: [
					{ name: "下单", total: 3, failed: 1, reported: 3, capped_ts: null, capped_mono: null },
				],
				recent: [failedAction(3, "下单", 2_000, 2_400, "库存不足")],
				recent_failed: [failedAction(3, "下单", 2_000, 2_400, "库存不足")],
			});
			await agent.sync();
			await agent.fail(first, "下单失败");
			const second = await assign();
			agent.actionSummary(second, {
				total: 2,
				reported: 2,
				names: [
					{ name: "下单", total: 2, failed: 0, reported: 2, capped_ts: null, capped_mono: null },
				],
				recent: [
					{
						id: 1,
						parent: null,
						depth: 0,
						name: "下单",
						fields: { 订单: "1001" },
						...stamp(10_000),
						end_ts: T0 + 10_500,
						end_mono: stamp(10_500).mono,
						result: "success" as const,
						reason: null,
					},
				],
			});
			await agent.sync();
			await agent.succeed(second, { ok: true });
			const pay = await assign();
			agent.actionSummary(pay, {
				total: 1,
				reported: 1,
				names: [
					{ name: "付款", total: 1, failed: 1, reported: 1, capped_ts: null, capped_mono: null },
				],
				recent_failed: [failedAction(1, "付款", 11_000, 11_250, "余额不足 / 超时\n请重试")],
			});
			await agent.sync();
			await agent.fail(pay, "付款失败");
			return runId;
		};

		it("文本：每个有动作的任务一段（各名称的个数和失败数、最近结束的和失败的动作）；--failed 只看有失败动作的任务", async () => {
			const runId = await actionsRun();

			const all = await cli("run", "actions", runId);
			expect(all.code, all.stderr).toBe(0);
			const text = all.stdout;
			expect(text).toContain("main:place#1  任务 ");
			expect(text).toContain("：动作 3 个、标记 0 个");
			expect(text).toContain("main:place#2  任务 ");
			expect(text).toContain("main:pay  任务 ");
			expect(text).toContain("  名称  总数  失败  有明细");
			expect(text).toContain("  下单  3     1     3");
			expect(text).toContain("  最近失败的动作（1 个，最近的在前）：");
			expect(text).toContain(`    下单（失败，耗时 400ms，${iso(T0 + 2_400)} 结束）`);
			expect(text).toContain("      订单=1003");
			expect(text).toContain("      原因：库存不足");
			expect(text).toContain("  最近结束的动作（1 个，最近的在前）：");
			expect(text).toContain("      原因：余额不足 / 超时\n        请重试");

			const failed = await cli("run", "actions", runId, "--failed");
			expect(failed.stdout).toContain("main:place#1  任务 ");
			expect(failed.stdout).toContain("main:pay  任务 ");
			expect(failed.stdout).not.toContain("main:place#2");
			expect(failed.stdout).not.toContain("最近结束的动作");
			expect(failed.stdout).not.toContain("下单  2");

			const pay = await cli("run", "actions", runId, "--failed", "--node", "main:pay");
			expect(pay.stdout).toContain("main:pay  任务 ");
			expect(pay.stdout).not.toContain("main:place");
		});

		it("--json：每个任务一项，带所属节点和尝试、计数、名称、最近结束和失败的动作", async () => {
			const runId = await actionsRun();

			const json = await cli("run", "actions", runId, "--json");
			const rows = JSON.parse(json.stdout) as Array<{
				chain: string;
				node: string;
				attempt: number;
				task: string;
				total: number;
				marks: number;
				capped: boolean;
				names: Array<{ name: string; total: number; failed: number }>;
				running: unknown[];
				recent: Array<{ name: string; result: string }>;
				recent_failed: Array<{ name: string; reason: string | null; duration_ms: number }>;
			}>;
			expect(rows.map((r) => [r.chain, r.node, r.attempt, r.total, r.marks, r.capped])).toEqual([
				["main", "place", 1, 3, 0, false],
				["main", "place", 2, 2, 0, false],
				["main", "pay", 1, 1, 0, false],
			]);
			expect(rows[0]?.recent_failed).toMatchObject([
				{ name: "下单", reason: "库存不足", duration_ms: 400 },
			]);
			expect(rows[1]?.recent.map((a) => [a.name, a.result])).toEqual([["下单", "success"]]);
			expect(rows[2]?.names).toMatchObject([{ name: "付款", total: 1, failed: 1 }]);

			const failedOnly = await cli("run", "actions", runId, "--failed", "--json");
			const failed = JSON.parse(failedOnly.stdout) as Array<Record<string, unknown>>;
			expect(failed.map((r) => [r.node, r.attempt])).toEqual([
				["place", 1],
				["pay", 1],
			]);
			expect(failed[0]).not.toHaveProperty("recent");
			expect(failed[0]).not.toHaveProperty("running");
		});

		it("没有动作、没有失败的动作时说明；节点写错时列出候选；摘要被截断时写明怎么读剩下的明细", async () => {
			const runId = await trigger(await scenario("没动作场景", [echo("a")]));
			const task = await assign();
			await agent.succeed(task);
			expect((await cli("run", "actions", runId)).stdout).toBe("这次运行里没有记录过动作\n");
			expect((await cli("run", "actions", runId, "--failed")).stdout).toBe("没有失败的动作\n");
			const unknown = await cli("run", "actions", runId, "--node", "main:zzz");
			expect(unknown.code).toBe(2);
			expect(unknown.stderr).toContain("运行里没有节点 main:zzz");

			const capped = await trigger(await scenario("截断场景", [echo("a")]));
			const second = await assign();
			agent.actionSummary(second, {
				total: 9,
				reported: 5,
				capped_ts: T0 + 1_000,
				capped_mono: stamp(1_000).mono,
				names: [
					{ name: "下单", total: 9, failed: 0, reported: 5, capped_ts: null, capped_mono: null },
				],
			});
			await agent.sync();
			await agent.succeed(second);
			const result = await cli("run", "actions", capped);
			expect(result.stdout).toContain("；有动作只计数、没有明细");
			expect(result.stdout).toContain(
				"每个任务的摘要只带最近 20 个结束的、最近 5 个失败的动作，更早的、或只计数没有明细的部分，" +
					"用 sfly api GET /tasks/<任务 id>/actions（--query failed=true 只看失败的）读明细",
			);
		});
	});

	describe("run metrics", () => {
		const benchRun = async () => {
			const document = { ...benchDocument([["load", "load"]]), default_agent: agent.name };
			const id = await api.orchestrationWith(document, "指标场景");
			const runId = await trigger(id);
			const task = await assign();
			agent.metrics(task, [
				["tps", at(1), 100],
				["tps", at(2), 300],
				["tps", at(3), 200],
				["p99", at(1), 12.5],
				["p99", at(2), 40.25],
			]);
			await agent.sync();
			await agent.succeed(task);
			return { id, runId, task };
		};

		it("文本：每个任务一张表，每个指标的最后值、最大、最小、平均和点数；--json 是任务数组", async () => {
			const { runId, task } = await benchRun();

			const text = await cli("run", "metrics", runId);
			expect(text.code, text.stderr).toBe(0);
			expect(text.stdout).toBe(
				[
					`main:load  任务 ${task.taskId}`,
					"  指标  标签  最后值  最大   最小  平均    点数",
					"  p99   -     40.25   40.25  12.5  26.375  2",
					"  tps   -     200     300    100   200     3",
					"",
				].join("\n"),
			);

			const json = await cli("run", "metrics", runId, "--json");
			const rows = JSON.parse(json.stdout) as Array<{
				chain: string;
				node: string;
				attempt: number;
				task: string;
				truncated: boolean;
				metrics: Array<{ name: string; last: number; max: number; min: number; points: number }>;
			}>;
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				chain: "main",
				node: "load",
				attempt: 1,
				task: task.taskId,
				truncated: false,
			});
			expect(rows[0]?.metrics.map((m) => [m.name, m.last, m.max, m.min, m.points])).toEqual([
				["p99", 40.25, 40.25, 12.5, 2],
				["tps", 200, 300, 100, 3],
			]);
		});

		it("--node 选节点；没有指标数据时说明；序列多时 --limit 截断并写明怎么看全部", async () => {
			const { runId } = await benchRun();
			const picked = await cli("run", "metrics", runId, "--node", "main:load", "--json");
			expect((JSON.parse(picked.stdout) as unknown[]).length).toBe(1);
			const unknown = await cli("run", "metrics", runId, "--node", "main:zzz");
			expect(unknown.code).toBe(2);

			const limited = await cli("run", "metrics", runId, "--limit", "1", "--json");
			const rows = JSON.parse(limited.stdout) as Array<{ metrics: unknown[] }>;
			expect(rows[0]?.metrics).toHaveLength(1);
			expect(limited.stderr).toContain(
				"还有 1 个序列没有显示（共 2 个序列），加 --limit 2 查看全部",
			);

			const plain = await trigger(await scenario("无指标场景", [echo("a")]));
			await agent.succeed(await assign());
			expect((await cli("run", "metrics", plain)).stdout).toBe("这次运行里没有指标数据\n");
		});
	});

	describe("摘要里的「失败的动作」「有异常的关注项」", () => {
		const failedRun = async () => {
			const document = { ...benchDocument([["load", "load"]]), default_agent: agent.name };
			const id = await api.orchestrationWith(document, "摘要场景");
			await putFocusItemsOk(api, id, [{ node_id: "load", chart: "TPS" }]);
			const runId = await trigger(id);
			const task = await assign();
			agent.metrics(task, [["tps", at(1), 500]]);
			agent.actionSummary(task, {
				total: 1,
				reported: 1,
				recent_failed: [failedAction(1, "压测", 500, 900, "压测机掉线")],
			});
			await agent.sync();
			clock.advance(2_000);
			await agent.fail(task, "RuntimeError: 压测机掉线");
			return runId;
		};

		it("run wait 的摘要在失败的任务之后多出这两段，其余不变", async () => {
			const runId = await failedRun();

			const result = await cli("run", "wait", runId);
			expect(result.code, result.stderr).toBe(1);
			const ended = (await api.run(runId)).ended_at;
			const lines = result.stdout.trimEnd().split("\n");
			const at = lines.indexOf("失败的动作（1 个，最近结束的在前）：");
			expect(at).toBeGreaterThan(0);
			expect(lines.slice(0, at)).toEqual([
				`运行 ${runId}：失败`,
				"耗时：2.0s",
				`链接：${cp.httpUrl}/runs/${runId}`,
				"",
				"失败的任务（1 个）：",
				"  main:load（bench/load，第 1 次尝试）",
				"    错误：node_error：RuntimeError: 压测机掉线",
				"    没有日志",
				"",
			]);
			expect(lines.slice(at)).toEqual([
				"失败的动作（1 个，最近结束的在前）：",
				`  main:load（第 1 次尝试）  压测（耗时 400ms，${iso(T0 + 900)} 结束）`,
				"    订单=1001",
				"    原因：压测机掉线",
				"",
				"有异常的关注项（1 个）：",
				"  1. TPS  load，最新值 500 req/s",
				`     异常：来源节点失败（${ended}）：RuntimeError: 压测机掉线`,
			]);

			const json = JSON.parse((await cli("run", "wait", runId, "--json")).stdout) as {
				failed_actions: Array<{ node: string; attempt: number; name: string; reason: string }>;
				attention_items: Array<{ node: string; title: string; anomaly: { kind: string } }>;
			};
			expect(json.failed_actions).toMatchObject([
				{ node: "load", attempt: 1, name: "压测", reason: "压测机掉线" },
			]);
			expect(json.attention_items).toMatchObject([
				{ node: "load", title: "TPS", anomaly: { kind: "failed" } },
			]);
		});

		it("没有失败的动作、没有异常时摘要和以前一样，一段也不多", async () => {
			const runId = await trigger(await scenario("成功摘要场景", [echo("a")]));
			await agent.succeed(await assign());
			const result = await cli("run", "wait", runId);
			expect(result.stdout).toBe(
				[`运行 ${runId}：成功`, "耗时：0ms", `链接：${cp.httpUrl}/runs/${runId}`, ""].join("\n"),
			);
		});

		it("run show 在失败或重试过的节点之后也带这两段", async () => {
			const runId = await failedRun();
			const result = await cli("run", "show", runId);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain("失败或重试过的节点：");
			expect(result.stdout).toContain("\n失败的动作（1 个，最近结束的在前）：\n");
			expect(result.stdout).toContain("\n有异常的关注项（1 个）：\n");

			const json = JSON.parse((await cli("run", "show", runId, "--json")).stdout) as {
				failed_actions: unknown[];
				attention_items: unknown[];
			};
			expect(json.failed_actions).toHaveLength(1);
			expect(json.attention_items).toHaveLength(1);
		});
	});
});
