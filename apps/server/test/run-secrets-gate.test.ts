// 删除运行的加密副本和上报的准入、写入互斥（#505，#862 第 1 轮审查）：每个运行一道闸门，上报（准入加写入）共享，删除副本独占。
// 删除不会插在一条上报的准入和写入之间：进行中的上报先写完、删除再开始；删除进行中到达的上报等它做完，丢弃并计数。
// 用控制面之外的一个 `RunSecrets`（同一个库）一步一步地排出交错，不靠时机。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { SECRET_MASK as MASK } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import type { RunSecrets } from "../src/secrets/run-secrets.js";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, param } from "./support/chains.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { runSecretsOf } from "./support/run-secrets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "fake-token-7c1d9e30";

const SCENARIO = orchestration(
	[
		[
			{ id: "entry", kind: "entry", params: [param("token", { secret: true })] },
			echo("a", { text: "${{ params.token }}" }),
		],
	],
	[],
);

/** 可以从外面放行的一个等待。 */
function gateOpen() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** 让已经能跑的异步步骤都跑完（闸门放行是同步的；没放行时怎么等都不会开始）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("删除副本和上报的准入、写入互斥", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;
	let database: ReturnType<typeof openDatabase>;

	/** 一个还在运行（副本还在）的写入时打码的运行。 */
	const freshRun = async () => {
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(SCENARIO), { token: TOKEN });
		await agent.nextAssign();
		return runId;
	};
	const dropped = async (runId: string) =>
		(
			await database.pool.query<{ n: number }>(
				"select late_reports_dropped as n from runs where id = $1",
				[runId],
			)
		).rows[0]?.n;
	const remove = (secrets: RunSecrets, runId: string) =>
		database.db.transaction((tx) => secrets.deleteIn(tx, runId, new Date()));

	beforeAll(async () => {
		cp = await startTestControlPlane();
		await publishPackage(cp, "stub", "1.0.0", { echo: ["out"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 8 });
		database = openDatabase(cp.database.url, () => {});
	});
	afterAll(async () => {
		await agent?.disconnect();
		await database?.close();
		await cp?.close();
	});

	it("删除赶上一条在准入和写入之间的上报：删除等它写完才开始，之后的上报丢弃并计数", async () => {
		const runId = await freshRun();
		const secrets = await runSecretsOf(cp.dataDir);
		const between = gateOpen();
		const report = secrets.admitted(database.db, runId, async (set) => {
			await between.opened; // 准入之后、写入之前停在这里
			return set.mask(`late ${TOKEN}`);
		});
		await settle();
		let started = false;
		const deletion = secrets.deleting(runId, () => {
			started = true;
			return remove(secrets, runId);
		});
		await settle();
		expect(started).toBe(false);

		between.open();
		expect(await report).toBe(`late ${MASK}`);
		expect(await deletion).toBe(true);
		expect(await secrets.admitted(database.db, runId, async () => "写了")).toBeUndefined();
		expect(await dropped(runId)).toBe(1);
	});

	it("删除进行中到达的上报：等删除做完，丢弃并计数，写入不执行", async () => {
		const runId = await freshRun();
		const secrets = await runSecretsOf(cp.dataDir);
		const inside = gateOpen();
		const deletion = secrets.deleting(runId, async () => {
			await inside.opened; // 删除拿着闸门，事务还没提交
			return remove(secrets, runId);
		});
		await settle();
		let wrote = false;
		const report = secrets.admitted(database.db, runId, async () => {
			wrote = true;
		});
		await settle();
		expect(wrote).toBe(false);

		inside.open();
		expect(await deletion).toBe(true);
		expect(await report).toBeUndefined();
		expect(wrote).toBe(false);
		expect(await dropped(runId)).toBe(1);
	});

	it("排着队的删除优先：它之后到达的上报不插到它前面，等它做完再丢弃", async () => {
		const runId = await freshRun();
		const secrets = await runSecretsOf(cp.dataDir);
		const first = gateOpen();
		const report = secrets.admitted(database.db, runId, async () => {
			await first.opened;
			return "第一条";
		});
		await settle();
		const deletion = secrets.deleting(runId, () => remove(secrets, runId));
		await settle();
		let secondWrote = false;
		const second = secrets.admitted(database.db, runId, async () => {
			secondWrote = true;
		});
		await settle();
		expect(secondWrote).toBe(false);

		first.open();
		expect(await report).toBe("第一条");
		expect(await deletion).toBe(true);
		expect(await second).toBeUndefined();
		expect(secondWrote).toBe(false);
		expect(await dropped(runId)).toBe(1);
	});

	it("删除失败（事务回滚）时副本还在：之后的上报照常写", async () => {
		const runId = await freshRun();
		const secrets = await runSecretsOf(cp.dataDir);
		await expect(
			secrets.deleting(runId, () =>
				database.db.transaction(async (tx) => {
					await secrets.deleteIn(tx, runId, new Date());
					throw new Error("中途失败");
				}),
			),
		).rejects.toThrow("中途失败");
		expect(await secrets.admitted(database.db, runId, async (set) => set.mask(TOKEN))).toBe(MASK);
		expect(await dropped(runId)).toBe(0);
	});
});
