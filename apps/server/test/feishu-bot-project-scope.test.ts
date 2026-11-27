// 运行通知、`ctx.notify`、保存和预检的检查、引用列表、投递，按名字找飞书机器人只看场景（运行）所在的项目（#621，ADR 0029）：
// 别的项目的机器人和没有登记过一样，说明是同一句，通知不会发给它的 Webhook。和 #610（按名字找 Agent 和节点包）同一类。
//
// 真实控制面和数据库，假的飞书 Webhook 服务。请求都发在默认项目的路径下（建项目的接口在 #499），所以别的项目的资源
// 用库里的一条 `update` 造出来：机器人先登记，再改到项目 `alpha`。每条断言都有对照：同样的做法用本项目的机器人，照常发。
import { feishuBotsApi } from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { chain, node, type Problem, scopeMetadata } from "./support/feishu-project-scope.js";
import { packageArchive, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const OWN = "tok-own-6b1f0d2e";
const FOREIGN = "tok-foreign-93c4a7b5";
/** 没有登记过的机器人：别的项目的机器人的说明必须和它的一样。 */
const NOBODY = "nobody";

describe("按项目找飞书机器人（保存、检查、预检、运行通知、ctx.notify、引用列表、投递）", () => {
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
	/** 每个跑任务的测试自己的 Agent：别的测试留在 runner 上没取走的任务不会混进来。 */
	let entries = 0;
	const entryAgent = () => connect(`entry-${++entries}`);
	const move = (table: string, name: string, project: string) =>
		sql.query(`update ${table} set project_id = $2 where name = $1`, [name, project]);
	const saveWarnings = async (id: string, doc: unknown): Promise<Problem[]> => {
		const res = await api.post(`/orchestrations/${id}/versions`, {
			base_version: await api.headVersion(id),
			document: doc,
		});
		expect(res.status, await res.clone().text()).toBe(201);
		return ((await res.json()) as { warnings: Problem[] }).warnings;
	};
	const scenario = async (
		doc: unknown,
		name = `场景 ${Math.random().toString(36).slice(2, 8)}`,
	) => {
		const id = await api.createOrchestration(name);
		return { id, warnings: await saveWarnings(id, doc) };
	};
	const botWarnings = (warnings: Problem[]) =>
		warnings.filter((w) => w.code === "feishu_bot_not_registered");

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
		await api.createFeishuBot("ops-alpha", feishu.webhookUrl(FOREIGN));
		await move("feishu_bots", "ops-alpha", "alpha");
		await connect("runner");
	});
	afterAll(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await sql?.end();
		await accounts?.close();
		await feishu?.close();
		await cp?.close();
	});

	const alertDoc = (bot: string, pkg = "alerts") => chain([node("a", pkg, "alert", { bot })], pkg);

	it("保存和检查：「飞书机器人」类型的输入选了别的项目的机器人，警告和没有登记过的一样（同一种、同一个位置、同一句话）；本项目的不警告", async () => {
		expect(botWarnings((await scenario(alertDoc("ops"))).warnings)).toEqual([]);
		const ghost = botWarnings((await scenario(alertDoc(NOBODY))).warnings);
		expect(ghost).toMatchObject([{ code: "feishu_bot_not_registered", node_id: "a" }]);

		const { id, warnings } = await scenario(alertDoc("ops-alpha"));
		const foreign = botWarnings(warnings);
		expect(foreign.map(({ code, node_id }) => ({ code, node_id }))).toEqual(
			ghost.map(({ code, node_id }) => ({ code, node_id })),
		);
		expect(foreign[0]?.message).toBe(ghost[0]?.message.replace(NOBODY, "ops-alpha"));
		// 检查和保存是同一段校验。
		const check = await api.post(`/orchestrations/${id}/check`, {
			base_version: await api.headVersion(id),
			document: alertDoc("ops-alpha"),
		});
		expect(check.status).toBe(200);
		const same = ({ code, message, node_id }: Problem) => ({ code, message, node_id });
		expect(
			botWarnings(((await check.json()) as { warnings: Problem[] }).warnings).map(same),
		).toEqual(foreign.map(same));

		// 反过来：项目 alpha 里的场景，本项目（alpha）的机器人不警告，默认项目的是别人的。
		const alphaScenario = async (bot: string) => {
			const created = await api.createOrchestration(`alpha ${bot}`);
			await sql.query("update orchestrations set project_id = 'alpha' where id = $1", [created]);
			return botWarnings(await saveWarnings(created, alertDoc(bot, "alerts-alpha")));
		};
		expect(await alphaScenario("ops-alpha")).toEqual([]);
		expect(await alphaScenario("ops")).toMatchObject([{ code: "feishu_bot_not_registered" }]);
	});

	it("预检和触发时按入口参数的实际值检查：参数是别的项目的机器人，和没有登记过的一样被拒绝，说明相同", async () => {
		const doc = chain([node("a", "alerts", "alert", { bot: "${{ params.bot }}" })], "alerts", [
			{ name: "bot", type: "string" },
		]);
		const { id } = await scenario(doc);
		const rejection = async (bot: string) => {
			const res = await api.trigger(id, { bot });
			expect(res.status, bot).toBe(400);
			return (
				(await res.json()) as { error: { code: string; message: string; details: Problem[] } }
			).error;
		};
		const ghost = await rejection(NOBODY);
		expect(ghost.code).toBe("invalid_params");
		const foreign = await rejection("ops-alpha");
		expect(foreign.code).toBe("invalid_params");
		expect(foreign.details.map((d) => d.code)).toEqual(ghost.details.map((d) => d.code));
		expect(foreign.message).toBe(ghost.message.replace(NOBODY, "ops-alpha"));
		expect((await api.trigger(id, { bot: "ops" })).status).toBe(201);
	});

	it("引用列表只列本项目的：别的项目的场景选了同名机器人不列；别的项目发布的包里的「飞书机器人」类型的输入认不出", async () => {
		const references = async (bot: string) =>
			feishuBotsApi.references.response.parse(
				await api.getJson(`/projects/default/feishu-bots/${encodeURIComponent(bot)}/references`),
			).scenarios;
		const own = await scenario(alertDoc("ops"), "引用列表：本项目的包");
		// 默认项目的场景锁定了别的项目发布的包：认不出它的「飞书机器人」类型的输入，不列。
		await scenario(alertDoc("ops", "alerts-alpha"), "引用列表：别的项目的包");
		// 别的项目（alpha）里的场景：运行通知选了默认项目里的机器人的名字，不列。
		const alphaOwn = await api.createOrchestration("引用列表：alpha 的场景");
		await sql.query("update orchestrations set project_id = 'alpha' where id = $1", [alphaOwn]);
		await api.patch(`/orchestrations/${alphaOwn}`, { run_notification: { bot: "ops" } });

		const found = await references("ops");
		expect(found.map((s) => s.orchestration_id)).toContain(own.id);
		expect(found.map((s) => s.name)).not.toContain("引用列表：别的项目的包");
		expect(found.map((s) => s.name)).not.toContain("引用列表：alpha 的场景");
		expect(found.every((s) => s.name !== "引用列表：别的项目的包")).toBe(true);
	});

	describe("运行通知", () => {
		const failingRun = async (settings: { bot: string }) => {
			const agent = await entryAgent();
			const { id } = await scenario(
				chain([node("a", "alerts", "plain")], "alerts", [], agent.name),
			);
			const patched = await api.patch(`/orchestrations/${id}`, {
				run_notification: { ...settings, trigger: "failed" },
			});
			expect(patched.status, await patched.clone().text()).toBe(200);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "boom");
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			return runId;
		};

		it("运行结束时场景设置里选的机器人是别的项目的：不发通知，运行详情里是「未发送：机器人已删除」，和没有登记过的一样；本项目的照常发", async () => {
			const before = feishu.requests.length;
			const ghostRun = await failingRun({ bot: NOBODY });
			const foreignRun = await failingRun({ bot: "ops-alpha" });
			const ghost = (await api.run(ghostRun)).run_notification;
			expect(ghost).toEqual({ status: "not_sent", bot: NOBODY, reason: "机器人已删除" });
			expect((await api.run(foreignRun)).run_notification).toEqual({
				...ghost,
				bot: "ops-alpha",
			});
			// 别的项目的 Webhook 没有收到任何请求。
			expect(feishu.requests.length).toBe(before);

			const ownRun = await failingRun({ bot: "ops" });
			await eventually(async () =>
				expect((await api.run(ownRun)).run_notification).toMatchObject({
					status: "delivered",
					bot: "ops",
				}),
			);
			expect(feishu.requests.slice(before).map((r) => r.path)).toEqual([
				`/open-apis/bot/v2/hook/${OWN}`,
			]);
		});
	});

	describe("ctx.notify", () => {
		const notify = (agent: FakeAgent, task: AssignedTask, bot: string, text: string) =>
			agent.send({
				case: "notification",
				value: {
					taskId: task.taskId,
					attempt: task.attempt,
					eventJson: JSON.stringify({ type: "notify", ts: Date.UTC(2026, 0, 1), bot, text }),
				},
			});
		const logs = async (taskId: string) =>
			(await api.getJson<{ lines: { source: string; text: string }[] }>(`/tasks/${taskId}/logs`))
				.lines;

		it("任务引用的机器人是别的项目的（值取自前面节点的输出，派发时不检查）：通知不发送，任务日志里是「还没有登记或已被删除」，和没有登记过的一样；本项目的照常发", async () => {
			const before = feishu.requests.length;
			// 值来自入口常量：保存时已经警告，这里用运行时才知道的值：把 pick 的输出换成别的项目的机器人。
			const runner = await entryAgent();
			const foreignScenario = await scenario(
				chain(
					[
						node("pick", "alerts", "pick"),
						node("a", "alerts", "alert", { bot: "${{ nodes.pick.outputs.bot }}" }),
					],
					"alerts",
					[],
					runner.name,
				),
			);
			const runWith = async (bot: string) => {
				const runId = await api.triggerOk(foreignScenario.id);
				await runner.succeed(await runner.nextAssign(), { bot });
				const task = await runner.nextAssign();
				return { runId, task };
			};

			const ghost = await runWith(NOBODY);
			notify(runner, ghost.task, NOBODY, "来自没有登记的机器人");
			const foreign = await runWith("ops-alpha");
			notify(runner, foreign.task, "ops-alpha", "发给别的项目的机器人");
			const warn = async (taskId: string, bot: string) => {
				let text = "";
				await eventually(async () => {
					text =
						(await logs(taskId)).find((l) => l.text.includes("ctx.notify 的消息没有发送"))?.text ??
						"";
					expect(text).not.toBe("");
				});
				expect(text).toContain(`飞书机器人「${bot}」还没有登记或已被删除`);
				return text;
			};
			const ghostText = await warn(ghost.task.taskId, NOBODY);
			expect(await warn(foreign.task.taskId, "ops-alpha")).toBe(
				ghostText.replace(NOBODY, "ops-alpha"),
			);
			expect(feishu.requests.length).toBe(before);

			const own = await runWith("ops");
			notify(runner, own.task, "ops", "发给本项目的机器人");
			await eventually(() => expect(feishu.requests.length).toBe(before + 1));
			expect(feishu.requests.at(-1)?.path).toBe(`/open-apis/bot/v2/hook/${OWN}`);
		});
	});

	describe("投递", () => {
		it("发送队列里已经排着的、发给别的项目的机器人的消息（升级前排上队的，和入队之后机器人才换了项目的）：只丢弃这一条，和机器人已删除一样；同一个名字的机器人自己项目的消息照常发", async () => {
			// 默认项目里的一次运行：它的消息不能发给 alpha 里的机器人 ops-alpha。
			const runner = await entryAgent();
			const { id: scenarioId } = await scenario(
				chain([node("a", "alerts", "plain")], "alerts", [], runner.name),
			);
			const runId = await api.triggerOk(scenarioId);
			await runner.succeed(await runner.nextAssign());
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			// alpha 里的一次运行（库里造）：它的消息发给 ops-alpha 是应该的。
			const alphaScenario = await api.orchestrationWith(
				chain([node("a", "alerts", "plain")], "alerts"),
				"alpha 的场景",
			);
			await sql.query("update orchestrations set project_id = 'alpha' where id = $1", [
				alphaScenario,
			]);
			const alphaRun = "00000000-0000-4000-8000-0000000000b1";
			await sql.query(
				`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at, ended_at)
				 select $1, orchestration_id, id, 'alpha', '旧人', '{}', 'failed', now(), now()
				 from orchestration_versions where orchestration_id = $2`,
				[alphaRun, alphaScenario],
			);
			// seq 是 bigserial，pg 以字符串返回。
			const enqueue = async (run: string | null, text: string) =>
				Number(
					(
						await sql.query(
							`insert into feishu_messages (bot_name, source, run_id, body, enqueued_at)
							 values ('ops-alpha', 'notify', $1, $2, now()) returning seq`,
							[run, JSON.stringify({ msg_type: "text", content: { text } })],
						)
					).rows[0].seq,
				);
			const stray = await enqueue(runId, "默认项目的运行发给别的项目的机器人");
			const legit = await enqueue(alphaRun, "alpha 的运行发给 alpha 的机器人");
			const before = feishu.requests.length;

			await cp.restart();

			// 启动时队列里的消息被投递循环处理：别的项目的运行发来的丢弃，alpha 自己的送达。
			await eventually(async () => {
				const rows = (
					await sql.query("select seq, status from feishu_messages where seq = any($1)", [
						[stray, legit],
					])
				).rows as { seq: number; status: string }[];
				const by = new Map(rows.map((r) => [Number(r.seq), r.status]));
				expect(by.get(stray)).toBe("discarded");
				expect(by.get(legit)).toBe("delivered");
			});
			const sent = feishu.requests.slice(before);
			expect(sent.map((r) => r.path)).toEqual([`/open-apis/bot/v2/hook/${FOREIGN}`]);
			expect(JSON.stringify(sent.map((r) => r.json))).toContain("alpha 的运行发给 alpha 的机器人");
			expect(JSON.stringify(sent.map((r) => r.json))).not.toContain("默认项目的运行");
		});
	});
});
