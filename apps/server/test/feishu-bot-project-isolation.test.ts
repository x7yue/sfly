// 飞书机器人按场景（运行）所在的项目找（#621，ADR 0029）：隔离的几个方向，每条都有对照（本项目的机器人照常发）。
// 与 feishu-bot-project-scope.test.ts 分开，那份验收的是「别的项目的机器人和没登记过一样」的主线，这份守的是主线之外
// 容易被悄悄改坏的地方：
// - 整份响应逐字比较（保存、检查、局部编辑、恢复、复制、预检、两种触发，别的项目的机器人和一个从没登记过的名字，
//   把名字、ID、时间换掉之后必须一样：少一个 `node_id`、多一句话都会红）；
// - 反方向（场景和运行都在另一个项目里：触发时的参数检查、`ctx.notify`、运行通知不能固定按默认项目查）；
// - 发送队列（别的项目的消息先于退避和限速的判断被丢弃；机器人换项目、删了又在别的项目登记、请求在途时被删，
//   都不会发给别的项目的地址、不会回写到别的机器人上）；
// - 管理接口按名字操作别的项目的机器人，和不存在的整份响应相同。
// 真实控制面和数据库，假的飞书 Webhook 服务；HTTP 接口现在还只认默认项目（#488），别的项目的资源用库里的一条 `update` 造出来。
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectId } from "../src/projects/project-id.js";
import { ApiClient } from "./support/api-client.js";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { chain, node, scopeMetadata } from "./support/feishu-project-scope.js";
import type { ManualClock } from "./support/manual-clock.js";
import { packageArchive, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

// 每个机器人的 token 末尾 4 个字符各不相同：打码后的地址露出结尾 4 个字符，所以连打码的形式也能查。
const OWN = "tok-own-QWOW";
const MOVE = "tok-move-QWMV";
const RE_OLD = "tok-reold-QWRO";
const RACE_OLD = "tok-raceold-QWRA";
const FOREIGN = "tok-foreign-QZFR";
const BETA = "tok-beta-QZBT";
const RE_NEW = "tok-renew-QZRN";
const RACE_NEW = "tok-racenew-QZRC";
/** 项目 alpha 里的机器人的地址：默认项目的响应、日志、错误里一个字符都不能有（打码的也不行）。 */
const ALPHA_SECRETS = [FOREIGN, BETA, RE_NEW, RACE_NEW, "QZFR", "QZBT", "QZRN", "QZRC"];
/** 没有登记过的机器人：别的项目的机器人的响应必须和它的一样。 */
const GHOST = "ghost-bot-zz";
const FOREIGN_BOT = "ops-alpha";

const alertDoc = (bot: string, agent = "runner") =>
	chain([node("a", "alerts", "alert", { bot })], "alerts", [], agent);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
/** 把响应里的机器人名、ID、时间换成占位符，别的项目的和没登记过的才能逐字比较。 */
const norm = (text: string, bot: string) =>
	text.split(bot).join("<BOT>").replace(UUID, "<UUID>").replace(TS, "<TS>");

describe("飞书机器人按项目隔离：整份响应、反方向、发送队列、管理接口", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let accounts: TestAccounts;
	let sql: pg.Client;
	let feishu: FakeFeishu;
	const agents: FakeAgent[] = [];

	const connect = async (name: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		agents.push(agent);
		return agent;
	};
	let entries = 0;
	/** 每个跑任务的测试自己的 Agent：别的测试留在 runner 上没取走的任务不会混进来。 */
	const entryAgent = () => connect(`iso-${++entries}`);
	const moveBot = (name: string, project: string) =>
		sql.query("update feishu_bots set project_id = $2 where name = $1", [name, project]);
	const requestsTo = (token: string) =>
		feishu.requests.filter((r) => r.path === `/open-apis/bot/v2/hook/${token}`);
	const clock = () => cp.clock as ManualClock;

	/** 库里造一个运行：project 里的场景（不经过引擎）。 */
	let runs = 0;
	const fakeRun = async (project: string) => {
		const scenario = await api.orchestrationWith(
			chain([node("a", "alerts", "plain")]),
			`造 ${++runs}`,
		);
		await sql.query("update orchestrations set project_id = $2 where id = $1", [scenario, project]);
		const id = `00000000-0000-4000-8000-${String(runs).padStart(12, "0")}`;
		await sql.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at, ended_at)
			 select $1, orchestration_id, id, $3, '旧人', '{}', 'failed', now(), now()
			 from orchestration_versions where orchestration_id = $2`,
			[id, scenario, project],
		);
		return id;
	};
	const enqueue = async (
		bot: string,
		run: string | null,
		text: string,
		extra: { attempts?: number; nextAttemptAt?: Date } = {},
	) =>
		Number(
			(
				await sql.query(
					`insert into feishu_messages (bot_name, source, run_id, body, enqueued_at, attempts, next_attempt_at)
					 values ($1, 'notify', $2, $3, $4, $5, $6) returning seq`,
					[
						bot,
						run,
						JSON.stringify({ msg_type: "text", content: { text } }),
						clock().now(),
						extra.attempts ?? 0,
						extra.nextAttemptAt ?? null,
					],
				)
			).rows[0].seq,
		);
	const message = async (seq: number) =>
		(
			await sql.query("select status, last_error, attempts from feishu_messages where seq = $1", [
				seq,
			])
		).rows[0] as { status: string; last_error: string | null; attempts: number };
	const lastDelivery = async (bot: string) =>
		(
			await sql.query(
				"select last_delivery_at, last_delivery_ok, last_delivery_error, project_id from feishu_bots where name = $1",
				[bot],
			)
		).rows[0] as
			| {
					last_delivery_at: Date | null;
					last_delivery_ok: boolean | null;
					last_delivery_error: string | null;
					project_id: string;
			  }
			| undefined;
	const logs = async (taskId: string) =>
		(await api.getJson<{ lines: { source: string; text: string }[] }>(`/tasks/${taskId}/logs`))
			.lines;
	const noAlphaSecret = (label: string, text: string) => {
		for (const secret of ALPHA_SECRETS) {
			expect(text.includes(secret), `${label} 里出现了 ${secret}`).toBe(false);
		}
	};

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		accounts = new TestAccounts(cp.database.url);
		sql = new pg.Client({ connectionString: cp.database.url });
		await sql.connect();
		await accounts.project("alpha");
		feishu = await startFakeFeishu();
		for (const name of ["alerts", "alerts-alpha"]) {
			const res = await cp.fetch(
				"/projects/default/packages",
				publishInit(packageArchive(scopeMetadata(name))),
			);
			expect(res.status, name).toBe(201);
		}
		await sql.query("update node_packages set project_id = 'alpha' where name = 'alerts-alpha'");
		await api.createFeishuBot("ops", feishu.webhookUrl(OWN));
		await api.createFeishuBot(FOREIGN_BOT, feishu.webhookUrl(FOREIGN));
		await moveBot(FOREIGN_BOT, "alpha");
		await connect("runner");
	});
	afterAll(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await sql?.end();
		await accounts?.close();
		await feishu?.close();
		await cp?.close();
	});

	it("保存、检查、局部编辑（检查和保存）、恢复、复制、预检、触发（常量和入口参数）：别的项目的机器人和没有登记过的整份响应逐字相同（只换名字）", async () => {
		const record = async (bot: string) => {
			const out: Record<string, string> = {};
			const keep = async (label: string, res: Response) => {
				const text = await res.text();
				noAlphaSecret(`${label}(${bot})`, text);
				out[label] = `${res.status} ${norm(text, bot)}`;
				return text;
			};
			const id = await api.createOrchestration(`隔离 ${bot}`);
			await api.saveVersion(id, alertDoc("ops")); // v1
			const ops = [{ op: "set", node: "a", field: "inputs.bot", value: bot }];
			await keep(
				"edits/check",
				await api.post(`/orchestrations/${id}/edits/check`, { base_version: 1, operations: ops }),
			);
			await keep(
				"edits",
				await api.post(`/orchestrations/${id}/edits`, { base_version: 1, operations: ops }),
			); // v2
			await keep(
				"check",
				await api.post(`/orchestrations/${id}/check`, { base_version: 2, document: alertDoc(bot) }),
			);
			await api.saveVersion(id, alertDoc("ops")); // v3
			await keep("restore", await api.postEmpty(`/orchestrations/${id}/versions/2/restore`)); // v4
			await api.saveVersion(id, alertDoc("ops")); // v5
			await keep(
				"save",
				await api.post(`/orchestrations/${id}/versions`, {
					base_version: 5,
					document: alertDoc(bot),
				}),
			); // v6
			await keep("get", await api.get(`/orchestrations/${id}`));
			await keep("version", await api.get(`/orchestrations/${id}/versions/6`));
			await keep("preflight", await api.get(`/orchestrations/${id}/preflight`));
			await keep("trigger(常量)", await api.trigger(id));
			await keep("copy", await api.post(`/orchestrations/${id}/copy`, { name: `复制 ${bot}` }));
			const withParam = await api.orchestrationWith(
				chain([node("a", "alerts", "alert", { bot: "${{ params.bot }}" })], "alerts", [
					{ name: "bot", type: "string" },
				]),
				`参数 ${bot}`,
			);
			await keep("trigger(参数)", await api.trigger(withParam, { bot }));
			await keep("preflight(参数)", await api.get(`/orchestrations/${withParam}/preflight`));
			return out;
		};
		const ghost = await record(GHOST);
		const foreign = await record(FOREIGN_BOT);
		const differs: string[] = [];
		for (const label of Object.keys(ghost)) {
			if (ghost[label] !== foreign[label]) {
				differs.push(label);
			}
			expect(foreign[label]?.includes("alpha"), `${label} 里出现 alpha`).toBe(false);
		}
		expect(differs).toEqual([]);
		// 对照：本项目的机器人没有 feishu_bot_not_registered。
		const own = await api.post(
			`/orchestrations/${await api.createOrchestration("隔离 own")}/check`,
			{
				document: alertDoc("ops"),
			},
		);
		expect(await own.text()).not.toContain("feishu_bot_not_registered");
		expect(ghost.save).toContain("feishu_bot_not_registered");
		expect(ghost.preflight).toContain("feishu_bot_not_registered");
		expect(ghost["trigger(参数)"]).toContain("<BOT>");
	});

	it("队首是别的项目的运行发来的消息（记着退避到 30 秒以后、尝试过 2 次）：不挡住同名机器人自己项目的消息，丢弃不占限速的名额", async () => {
		await api.createFeishuBot("ops-beta", feishu.webhookUrl(BETA));
		await moveBot("ops-beta", "alpha");
		const defaultRun = await fakeRun("default");
		const alphaRun = await fakeRun("alpha");
		// 30 秒：在退避上限（60 秒）以内。超过上限的 next_attempt_at 会被当作时钟往回跳过、立即到期（isRetryDue）。
		const later = new Date(clock().now().getTime() + 30_000);
		const strays: number[] = [];
		for (let i = 0; i < 8; i++) {
			strays.push(
				await enqueue("ops-beta", defaultRun, `别的项目 ${i}`, {
					attempts: 2,
					nextAttemptAt: later,
				}),
			);
		}
		const first = await enqueue("ops-beta", alphaRun, "alpha 自己的 0");
		// 不推进时钟：丢弃要是占了限速的名额（每秒 5 个），或者队首记着的退避挡住了队列，这一条就发不出去。
		await eventually(async () => expect((await message(first)).status).toBe("delivered"));
		for (const seq of strays) {
			const m = await message(seq);
			expect(m.status).toBe("discarded");
			expect(m.attempts).toBe(2);
			noAlphaSecret("丢弃的原因", m.last_error ?? "");
		}
		expect(requestsTo(BETA).map((r) => JSON.stringify(r.json))).toEqual([
			expect.stringContaining("alpha 自己的 0"),
		]);
		// 对照：限速确实在起作用（不推进时钟时，这一秒里只能再发 4 个）。
		const more: number[] = [];
		for (let i = 1; i <= 5; i++)
			more.push(await enqueue("ops-beta", alphaRun, `alpha 自己的 ${i}`));
		await eventually(async () => expect(requestsTo(BETA).length).toBe(5));
		await new Promise((r) => setTimeout(r, 1500));
		expect(requestsTo(BETA).length).toBe(5);
		expect((await message(more[4] as number)).status).toBe("queued");
		clock().advance(1100);
		await eventually(async () =>
			expect((await message(more[4] as number)).status).toBe("delivered"),
		);
	});

	it("排着队、在等退避的消息，机器人换到别的项目：只丢弃这一条，不再发给它的地址，任务日志和没有登记过一样；新项目自己的消息照常发", async () => {
		await api.createFeishuBot("ops-move", feishu.webhookUrl(MOVE));
		const runner = await entryAgent();
		const id = await api.orchestrationWith(alertDoc("ops-move", runner.name), "机器人换项目");
		const runId = await api.triggerOk(id);
		const task: AssignedTask = await runner.nextAssign();
		feishu.replyTo(MOVE, { status: 500 });
		runner.send({
			case: "notification",
			value: {
				taskId: task.taskId,
				attempt: task.attempt,
				eventJson: JSON.stringify({
					type: "notify",
					ts: Date.UTC(2026, 0, 1),
					bot: "ops-move",
					text: "换项目之前入队",
				}),
			},
		});
		await eventually(async () => expect(requestsTo(MOVE).length).toBe(1));
		const [row] = (await sql.query("select seq from feishu_messages where run_id = $1", [runId]))
			.rows as { seq: string }[];
		const seq = Number(row?.seq);
		await eventually(async () => expect((await message(seq)).attempts).toBe(1));
		expect((await message(seq)).status).toBe("queued");
		await moveBot("ops-move", "alpha");
		clock().advance(2000);
		await eventually(async () => expect((await message(seq)).status).toBe("discarded"));
		expect(requestsTo(MOVE).length).toBe(1);
		// 丢弃先改库、再写任务日志（#discard 里 logDiscards 在 update 之后）：等日志出现。
		let lines: string[] = [];
		await eventually(async () => {
			lines = (await logs(task.taskId)).map((l) => l.text);
			expect(lines.some((l) => l.includes("已丢弃：机器人已删除"))).toBe(true);
		});
		noAlphaSecret("D2 日志", JSON.stringify(lines));
		const alphaRun = await fakeRun("alpha");
		const legit = await enqueue("ops-move", alphaRun, "alpha 的消息");
		await eventually(async () => expect((await message(legit)).status).toBe("delivered"));
		expect(requestsTo(MOVE).length).toBe(2);
		await runner.succeed(task);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
	});

	it("机器人删除后同名的在别的项目重新登记，原项目的运行留下的消息（并发入队漏掉的）：只丢弃它，新机器人自己的消息照常发，原地址和新地址都收不到它", async () => {
		await api.createFeishuBot("ops-re", feishu.webhookUrl(RE_OLD));
		expect((await api.delete("/feishu-bots/ops-re")).status).toBe(204);
		await api.createFeishuBot("ops-re", feishu.webhookUrl(RE_NEW));
		await moveBot("ops-re", "alpha");
		const defaultRun = await fakeRun("default");
		const alphaRun = await fakeRun("alpha");
		const orphan = await enqueue("ops-re", defaultRun, "原项目留下的");
		const legit = await enqueue("ops-re", alphaRun, "新项目自己的");
		await eventually(async () => expect((await message(legit)).status).toBe("delivered"));
		expect((await message(orphan)).status).toBe("discarded");
		expect(requestsTo(RE_OLD)).toEqual([]);
		expect(requestsTo(RE_NEW).map((r) => JSON.stringify(r.json))).toEqual([
			expect.stringContaining("新项目自己的"),
		]);
	});

	it("请求在途时机器人被删除、同名的在别的项目重新登记：响应回来后不回写到新机器人的「最近一次投递」，消息仍是已丢弃", async () => {
		await api.createFeishuBot("ops-race", feishu.webhookUrl(RACE_OLD));
		feishu.replyTo(RACE_OLD, { delayMs: 2500 });
		const defaultRun = await fakeRun("default");
		const seq = await enqueue("ops-race", defaultRun, "在途的消息");
		await eventually(async () => expect(requestsTo(RACE_OLD).length).toBe(1));
		expect((await api.delete("/feishu-bots/ops-race")).status).toBe(204);
		await api.createFeishuBot("ops-race", feishu.webhookUrl(RACE_NEW));
		await moveBot("ops-race", "alpha");
		await new Promise((r) => setTimeout(r, 3500));
		const m = await message(seq);
		const bot = await lastDelivery("ops-race");
		expect(m.status).toBe("discarded");
		expect(bot?.project_id).toBe("alpha");
		expect(bot?.last_delivery_at).toBeNull();
		expect(requestsTo(RACE_NEW)).toEqual([]);
	});

	it("机器人管理接口（默认项目）：别的项目的机器人和不存在的整份响应相同；列表里没有它", async () => {
		const list = await api.get("/feishu-bots");
		const listText = await list.text();
		noAlphaSecret("列表", listText);
		expect(listText).not.toContain(FOREIGN_BOT);
		const probe = async (bot: string) => {
			const out: Record<string, string> = {};
			const keep = async (label: string, res: Response) => {
				const text = await res.text();
				noAlphaSecret(`${label}(${bot})`, text);
				out[label] = `${res.status} ${norm(text, bot)}`;
			};
			const path = `/feishu-bots/${encodeURIComponent(bot)}`;
			await keep("references", await api.get(`${path}/references`));
			await keep(
				"replace",
				await api.patch(path, { webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/x" }),
			);
			await keep("test", await api.postEmpty(`${path}/test`));
			await keep("delete", await api.delete(path));
			return out;
		};
		const before = requestsTo(FOREIGN).length;
		const g = await probe(GHOST);
		const f = await probe(FOREIGN_BOT);
		expect(f).toEqual(g);
		expect(requestsTo(FOREIGN).length).toBe(before);
	});

	it("反方向：项目 alpha 里的场景和运行只认 alpha 的机器人，默认项目的机器人和没有登记过的一样（触发时的参数检查、ctx.notify、运行通知）", async () => {
		// 项目 alpha 里的 Agent：用 alpha 签发的 Agent 凭据连接（派发看的是连接的项目，不是库里登记记录的项目，#492：
		// 连上之后把登记记录改成 alpha，连接还是默认项目的，运行派不过去）。
		const name = `iso-alpha-${++entries}`;
		const credential = (await cp.current.agentCredentials.issue("alpha" as ProjectId, name)).token;
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, token: credential });
		agents.push(agent);
		const alphaScenario = async (doc: unknown, name: string) => {
			const id = await api.createOrchestration(name);
			await sql.query("update orchestrations set project_id = 'alpha' where id = $1", [id]);
			await api.saveVersion(id, doc);
			return id;
		};
		const ownBefore = requestsTo(OWN).length;
		// 触发时的参数检查
		const pid = await alphaScenario(
			chain(
				[node("a", "alerts-alpha", "alert", { bot: "${{ params.bot }}" })],
				"alerts-alpha",
				[{ name: "bot", type: "string" }],
				agent.name,
			),
			"G 参数",
		);
		const rejection = async (bot: string) => {
			const res = await api.trigger(pid, { bot });
			return `${res.status} ${norm(await res.text(), bot)}`;
		};
		const gRej = await rejection(GHOST);
		const oRej = await rejection("ops");
		expect(gRej.startsWith("400")).toBe(true);
		expect(oRej).toBe(gRej);
		const accepted = await api.triggerOk(pid, { bot: FOREIGN_BOT });
		const acceptedTask = await agent.nextAssign();
		await agent.succeed(acceptedTask);
		await eventually(async () => expect((await api.run(accepted)).status).toBe("success"));

		// ctx.notify
		const nid = await alphaScenario(
			chain(
				[
					node("pick", "alerts-alpha", "pick"),
					node("a", "alerts-alpha", "alert", { bot: "${{ nodes.pick.outputs.bot }}" }),
				],
				"alerts-alpha",
				[],
				agent.name,
			),
			"G ctx.notify",
		);
		const notifyWith = async (bot: string) => {
			const runId = await api.triggerOk(nid);
			await agent.succeed(await agent.nextAssign(), { bot });
			const task = await agent.nextAssign();
			agent.send({
				case: "notification",
				value: {
					taskId: task.taskId,
					attempt: task.attempt,
					eventJson: JSON.stringify({
						type: "notify",
						ts: Date.UTC(2026, 0, 1),
						bot,
						text: `G 发给 ${bot}`,
					}),
				},
			});
			return { runId, task };
		};
		const gN = await notifyWith(GHOST);
		const oN = await notifyWith("ops");
		const fN = await notifyWith(FOREIGN_BOT);
		const warnLine = async (taskId: string) => {
			let line = "";
			await eventually(async () => {
				line =
					(await logs(taskId)).find((l) => l.text.includes("ctx.notify 的消息没有发送"))?.text ??
					"";
				expect(line).not.toBe("");
			});
			return line;
		};
		const gLine = await warnLine(gN.task.taskId);
		expect((await warnLine(oN.task.taskId)).split("ops").join("<BOT>")).toBe(
			gLine.split(GHOST).join("<BOT>"),
		);
		await eventually(async () =>
			expect(
				requestsTo(FOREIGN).some((r) => JSON.stringify(r.json).includes(`G 发给 ${FOREIGN_BOT}`)),
			).toBe(true),
		);
		for (const n of [gN, oN, fN]) {
			await agent.succeed(n.task);
			await eventually(async () => expect((await api.run(n.runId)).status).toBe("success"));
		}

		// 运行通知
		const failing = async (bot: string) => {
			const id = await alphaScenario(
				chain([node("a", "alerts-alpha", "plain")], "alerts-alpha", [], agent.name),
				`G 通知 ${bot}`,
			);
			expect(
				(await api.patch(`/orchestrations/${id}`, { run_notification: { bot, trigger: "failed" } }))
					.status,
			).toBe(200);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "boom");
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			return runId;
		};
		const gR = (await api.run(await failing(GHOST))).run_notification;
		const oR = (await api.run(await failing("ops"))).run_notification;
		expect({ ...oR, bot: GHOST }).toEqual(gR);
		const fRun = await failing(FOREIGN_BOT);
		await eventually(async () =>
			expect((await api.run(fRun)).run_notification).toMatchObject({
				status: "delivered",
				bot: FOREIGN_BOT,
			}),
		);
		// 默认项目的机器人一条都没收到。
		expect(requestsTo(OWN).length).toBe(ownBefore);
	});
});
