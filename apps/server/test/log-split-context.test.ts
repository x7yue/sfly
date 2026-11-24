// Agent 把超过 64 KiB 的一行标准输出 / 标准错误拆成几段时，每一段带两小段只用来打码的上下文（`LogLine.before` / `after`，#622）：
// 一个 secret 值正好跨在拆分处时，控制面在「上下文 + 这一段」上认出它，前一段里是一个掩码，后一段里它的剩余部分去掉，几段接起来和不拆时
// 一样；上下文不显示、不保存；旧版本的 Agent 不带上下文，行为和以前一样；超过上限的上下文按没带处理，不报错不断流。
// 真实的控制面和假 Agent；值都是明显的假值。
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogLineView } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPLIT_CONTEXT_MAX_CHARS } from "../src/logs/secrets.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { publishBench } from "./support/focus-items.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MASK = "******";
const VALUE = "FAKE-SECRET-VALUE-0123";
const FIRST_HALF = VALUE.slice(0, 11);
const SECOND_HALF = VALUE.slice(11);

interface Page {
	lines: LogLineView[];
}
const texts = (lines: ReadonlyArray<{ text: string }>) => lines.map((l) => l.text);

/** 数据目录里所有文件的内容里有没有这段文字。 */
async function dataDirContains(dir: string, needle: string): Promise<boolean> {
	for (const name of await readdir(dir)) {
		const path = join(dir, name);
		if ((await stat(path)).isDirectory()) {
			if (await dataDirContains(path, needle)) return true;
		} else if ((await readFile(path)).includes(needle)) {
			return true;
		}
	}
	return false;
}

describe("被拆开的超长行：上下文让跨在拆分处的值认得出", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const line = (
		seq: number,
		text: string,
		extra: { before?: string; after?: string } = {},
		level = LogLevel.INFO,
	) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(Date.UTC(2026, 0, 1)),
		source: LogSource.STDOUT,
		level,
		text,
		...extra,
	});

	/** 入口参数 cfg 是 secret（值一开始就知道，写入时就打码）；返回运行和任务。 */
	const start = async () => {
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "cfg", type: "string", secret: true }] },
				{ id: "sa", kind: "package", package: "bench", node: "load" },
			],
			edges: [{ from: "entry", to: "sa", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
		const runId = await api.triggerOk(id, { cfg: VALUE });
		return { runId, task: await agent.nextAssign() };
	};
	const waitLines = (taskId: string, count: number) =>
		eventually(async () => {
			const page = await api.getJson<Page>(`/tasks/${taskId}/logs`);
			expect(page.lines).toHaveLength(count);
		});
	const readAll = async (taskId: string, runId: string) => {
		const page = await api.getJson<Page>(`/tasks/${taskId}/logs`);
		const jsonl = (body: string) =>
			body
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as LogLineView);
		const download = jsonl(await (await cp.fetch(`/tasks/${taskId}/logs/download`)).text());
		const merged = jsonl(await (await cp.fetch(`/runs/${runId}/logs/download`)).text());
		const mergedPage = await api.getJson<Page>(`/runs/${runId}/logs`);
		return {
			page: texts(page.lines),
			download: texts(download),
			merged: texts(merged),
			mergedPage: texts(mergedPage.lines),
		};
	};

	it("值正好跨在拆分处（两段，各带对方的一部分作上下文）：前一段里是一个掩码，后一段里剩余部分去掉；几段接起来和不拆时一样，读日志、下载、按运行合并读都一样；文件里没有任何一半", async () => {
		const { runId, task } = await start();
		const head = `head ${FIRST_HALF}`;
		const tail = `${SECOND_HALF} tail`;
		agent.logs(task, [line(1, head, { after: tail }), line(2, tail, { before: head })]);
		await waitLines(task.taskId, 2);
		const expected = [`head ${MASK}`, " tail"];
		const got = await readAll(task.taskId, runId);
		expect(got.page).toEqual(expected);
		expect(got.download).toEqual(expected);
		expect(got.merged).toEqual(expected);
		expect(got.mergedPage).toEqual(expected);
		expect(got.page.join("")).toBe(`head ${MASK} tail`);
		expect(await dataDirContains(cp.dataDir, FIRST_HALF)).toBe(false);
		expect(await dataDirContains(cp.dataDir, SECOND_HALF)).toBe(false);
	});

	it("三段（值在第一、二段之间，另一个在第二、三段之间）：每一段只用自己的上下文，每个值一个掩码", async () => {
		const { runId, task } = await start();
		const p1 = `a ${FIRST_HALF}`;
		const p2 = `${SECOND_HALF} mid ${FIRST_HALF}`;
		const p3 = `${SECOND_HALF} z`;
		agent.logs(task, [
			line(1, p1, { after: p2.slice(0, 20) }),
			line(2, p2, { before: p1, after: p3 }),
			line(3, p3, { before: p2.slice(-20) }),
		]);
		await waitLines(task.taskId, 3);
		const got = await readAll(task.taskId, runId);
		expect(got.page).toEqual([`a ${MASK}`, ` mid ${MASK}`, " z"]);
		expect(got.page.join("")).toBe(`a ${MASK} mid ${MASK} z`);
	});

	it("上下文不显示、不保存：数据目录里、读出来的日志里都没有只出现在上下文里的文字", async () => {
		const { runId, task } = await start();
		agent.logs(task, [
			line(1, "first piece", { after: "CTX-ONLY-AFTER-MARKER" }),
			line(2, "second piece", { before: "CTX-ONLY-BEFORE-MARKER" }),
		]);
		await waitLines(task.taskId, 2);
		const got = await readAll(task.taskId, runId);
		for (const rows of [got.page, got.download, got.merged, got.mergedPage]) {
			expect(rows).toEqual(["first piece", "second piece"]);
		}
		for (const marker of ["CTX-ONLY-AFTER-MARKER", "CTX-ONLY-BEFORE-MARKER"]) {
			expect(await dataDirContains(cp.dataDir, marker)).toBe(false);
		}
	});

	it("旧版本的 Agent（不带上下文）：跨在拆分处的值两半都认不出，和以前一样；新的控制面不因此出错", async () => {
		const { runId, task } = await start();
		agent.logs(task, [line(1, `head ${FIRST_HALF}`), line(2, `${SECOND_HALF} tail`)]);
		await waitLines(task.taskId, 2);
		const got = await readAll(task.taskId, runId);
		expect(got.page).toEqual([`head ${FIRST_HALF}`, `${SECOND_HALF} tail`]);
		// 完整的值照常打码
		agent.logs(task, [line(3, `again ${VALUE}`)]);
		await waitLines(task.taskId, 3);
		expect((await readAll(task.taskId, runId)).page[2]).toBe(`again ${MASK}`);
	});

	it("上下文超过上限（不是正常的 Agent 发的）：按没带处理，不报错、不断流，后面的行照常写入", async () => {
		const { runId, task } = await start();
		const huge = "x".repeat(SPLIT_CONTEXT_MAX_CHARS + 1);
		agent.logs(task, [
			line(1, `head ${FIRST_HALF}`, { after: `${SECOND_HALF}${huge}` }),
			line(2, `${SECOND_HALF} tail`, { before: huge }),
			line(3, "later line"),
		]);
		await waitLines(task.taskId, 3);
		const got = await readAll(task.taskId, runId);
		// 没带上下文：和旧版本的 Agent 一样，两半留着；上下文本身不在任何地方
		expect(got.page).toEqual([`head ${FIRST_HALF}`, `${SECOND_HALF} tail`, "later line"]);
		expect(await dataDirContains(cp.dataDir, huge)).toBe(false);
		// 恰好在上限以内的上下文照常用
		agent.logs(task, [
			line(4, `head ${FIRST_HALF}`, { after: SECOND_HALF.padEnd(SPLIT_CONTEXT_MAX_CHARS, "y") }),
		]);
		await waitLines(task.taskId, 4);
		expect((await readAll(task.taskId, runId)).page[3]).toBe(`head ${MASK}`);
	});

	it("重发同一段（Agent 断线重连后重发）：按序号去重，文件不变；上下文不影响去重", async () => {
		const { runId, task } = await start();
		const head = `head ${FIRST_HALF}`;
		const tail = `${SECOND_HALF} tail`;
		const pieces = [line(1, head, { after: tail }), line(2, tail, { before: head })];
		agent.logs(task, pieces);
		await waitLines(task.taskId, 2);
		const before = await readAll(task.taskId, runId);
		agent.logs(task, pieces);
		agent.logs(task, [line(3, "after resend")]);
		await waitLines(task.taskId, 3);
		const after = await readAll(task.taskId, runId);
		expect(after.page.slice(0, 2)).toEqual(before.page);
		expect(after.page[2]).toBe("after resend");
	});

	it("日志类异常（ERROR 级别的一段）：关注项里的说明也是打了码的，没有任何一半", async () => {
		const { task } = await start();
		const head = `failed ${FIRST_HALF}`;
		const tail = `${SECOND_HALF} end`;
		agent.logs(task, [
			line(1, head, { after: tail }, LogLevel.ERROR),
			line(2, tail, { before: head }, LogLevel.ERROR),
		]);
		await waitLines(task.taskId, 2);
		const page = await api.getJson<Page>(`/tasks/${task.taskId}/logs`);
		expect(texts(page.lines)).toEqual([`failed ${MASK}`, " end"]);
		expect(page.lines.every((l) => l.level === "error")).toBe(true);
	});
});
