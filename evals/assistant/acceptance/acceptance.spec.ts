// 骨架验收（#553）：对着正式部署形态（compose 起的控制面、助手、工作台，假的模型端点照剧本回复），按「一句话之后的十分钟」
// 逐行核对页面。每行的结论和证据（截图、采样）追加到 $ACCEPT_OUT/results.jsonl，一行一个 JSON：
// { row, ok, detail, evidence }。重启、停掉容器由宿主上的 accept.sh 代做：这里在 $ACCEPT_CTL 里写一个请求文件、等它写回结果。
// 运行器来自 apps/web 的依赖（这个目录不在 pnpm 工作区里），所以按相对路径引用。
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	test,
} from "../../../apps/web/node_modules/@playwright/test/index.mjs";

const OUT = process.env.ACCEPT_OUT ?? "/out";
const CTL = process.env.ACCEPT_CTL ?? "/ctl";
const PROJECT = process.env.ACCEPT_PROJECT ?? "default";
const WORKBENCH = process.env.ACCEPT_WORKBENCH ?? "workbench";
const ADMIN = {
	login: process.env.ACCEPT_ADMIN_LOGIN ?? "",
	password: process.env.ACCEPT_ADMIN_PASSWORD ?? "",
};
const EDITOR = {
	login: process.env.ACCEPT_EDITOR_LOGIN ?? "",
	password: process.env.ACCEPT_EDITOR_PASSWORD ?? "",
};
const COPY = "demo 巡检-联调-验收";
const SESSION_URL = /\/sessions\/[0-9a-f-]{36}$/;
const TURN = 5 * 60_000;

mkdirSync(join(OUT, "shots"), { recursive: true });
mkdirSync(join(OUT, "samples"), { recursive: true });

/** 这一行的结论：证据是相对结果目录的路径。 */
function record(row: string, ok: boolean, detail: string, evidence: string[]): void {
	appendFileSync(join(OUT, "results.jsonl"), `${JSON.stringify({ row, ok, detail, evidence })}\n`);
}

/** 核对一行：通过、失败都记下；失败时截一张当时的图，再抛出去让这个用例失败。 */
async function row(page: Page, name: string, check: (evidence: string[]) => Promise<string>) {
	const evidence: string[] = [];
	try {
		record(name, true, await check(evidence), evidence);
	} catch (error) {
		evidence.push(await shot(page, `失败-${name}`));
		record(name, false, stripVTControlCharacters(String(error)).slice(0, 2000), evidence);
		throw error;
	}
}

let shots = 0;
async function shot(page: Page, name: string): Promise<string> {
	shots += 1;
	const file = `shots/${String(shots).padStart(2, "0")}-${name.replace(/[^\p{L}\p{N}-]+/gu, "_")}.png`;
	await page.screenshot({ path: join(OUT, file), fullPage: true });
	return file;
}

function sample(name: string, data: unknown): string {
	const file = `samples/${name}.json`;
	writeFileSync(join(OUT, file), `${JSON.stringify(data, null, 2)}\n`);
	return file;
}

let requests = 0;
/** 请宿主做一件事（compose 的 stop、start、restart，或换助手的模型设置），等它做完。 */
async function ctl(action: string, service: string): Promise<void> {
	requests += 1;
	const base = join(CTL, String(requests).padStart(3, "0"));
	writeFileSync(`${base}.tmp`, `${action} ${service}\n`);
	renameSync(`${base}.tmp`, `${base}.req`);
	const deadline = Date.now() + 10 * 60_000;
	while (!existsSync(`${base}.done`)) {
		if (Date.now() > deadline) throw new Error(`宿主没有做完 ${action} ${service}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	const code = readFileSync(`${base}.done`, "utf8").trim();
	if (code !== "0") throw new Error(`宿主做 ${action} ${service} 失败（退出码 ${code}）`);
}

async function signIn(browser: Browser, who: { login: string; password: string }) {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto("/login");
	await page.getByLabel("登录名").fill(who.login);
	await page.getByLabel("密码").fill(who.password);
	await page.getByRole("button", { name: "登录" }).click();
	await page.waitForURL((url) => !url.pathname.startsWith("/login"));
	return { context, page };
}

const readiness = (page: Page) => page.getByTestId("readiness");

async function waitReady(page: Page) {
	await expect
		.poll(
			async () => {
				await page.goto("/sessions");
				return await readiness(page).getAttribute("data-ready", { timeout: 15_000 });
			},
			{ timeout: 5 * 60_000, intervals: [3000] },
		)
		.toBe("true");
}

/** 在助手页说一句话开始一个会话，回到会话页；返回从点「开始」到会话页出现的毫秒数。 */
async function start(page: Page, text: string): Promise<number> {
	await waitReady(page);
	await page.getByRole("textbox", { name: "要做什么？" }).fill(text);
	const clicked = Date.now();
	await page.getByRole("button", { name: "开始" }).click();
	await page.waitForURL(SESSION_URL);
	return Date.now() - clicked;
}

const turnEnds = (page: Page) => page.getByTestId("turn-end");
const toolRow = (page: Page, text: string) =>
	page.getByTestId("tool-row").filter({ hasText: text });

/** 展开一行命令，看它的实时输出。 */
async function openLive(row: Locator): Promise<Locator> {
	await row.getByRole("button").first().click();
	return row.getByTestId("tool-output");
}

const lineCount = async (output: Locator) =>
	(await output.textContent())?.split("\n").filter((line) => line.trim() !== "").length ?? 0;

/** 每隔 ms 毫秒读一次，读 times 次。 */
async function every<T>(ms: number, times: number, read: () => Promise<T>): Promise<T[]> {
	const values: T[] = [];
	for (let i = 0; i < times; i++) {
		values.push(await read());
		await new Promise((resolve) => setTimeout(resolve, ms));
	}
	return values;
}

const increasing = (values: number[]) =>
	values.every((value, i) => i === 0 || value >= (values[i - 1] ?? 0)) &&
	(values.at(-1) ?? 0) > (values[0] ?? 0);

/** 发一句话（空闲时是接着说，在做时是插话）。 */
async function say(page: Page, text: string) {
	const box = page.getByRole("textbox", { name: /接着说|插话/ });
	await box.fill(text);
	await page.getByRole("button", { name: /^发送(插话)?$/ }).click();
}

/** 控制面接口（页面同一个登录），只读，做第二视角。 */
async function api<T>(page: Page, path: string): Promise<T> {
	const response = await page.request.get(`/api${path}`);
	expect(response.status(), path).toBe(200);
	return (await response.json()) as T;
}

/** 会话的持久事件（`GET /sessions/:id`，按 `before` 往前翻到第一条），序号升序。 */
type SessionEvent = { seq: number; type: string; at: string; [field: string]: unknown };
async function sessionEvents(page: Page, sessionId: string): Promise<SessionEvent[]> {
	const events: SessionEvent[] = [];
	let before: number | undefined;
	for (;;) {
		const query = before === undefined ? "" : `?before=${before}`;
		const chunk = await api<{ events: SessionEvent[]; has_more: boolean }>(
			page,
			`/sessions/${sessionId}${query}`,
		);
		events.unshift(...chunk.events);
		const first = chunk.events[0];
		if (!chunk.has_more || first === undefined) return events;
		before = first.seq;
	}
}

const sessionIdOf = (page: Page) => page.url().split("/").at(-1) ?? "";

type RunRow = { id: string; status: string };
/** 这个会话触发的运行（`GET /projects/:project/runs?session_id=`）。 */
async function sessionRuns(page: Page, sessionId: string): Promise<RunRow[]> {
	const { runs } = await api<{ runs: RunRow[] }>(
		page,
		`/projects/${PROJECT}/runs?session_id=${sessionId}`,
	);
	return runs.map(({ id, status }) => ({ id, status }));
}

/** 这个场景里经这个会话保存的版本号（`GET /orchestrations/:id/versions` 的 `session`），升序。 */
async function versionsSavedBy(page: Page, scenarioId: string, sessionId: string) {
	const { versions } = await api<{ versions: { number: number; session?: { id: string } }[] }>(
		page,
		`/orchestrations/${scenarioId}/versions`,
	);
	return versions
		.filter((v) => v.session?.id === sessionId)
		.map((v) => v.number)
		.sort((a, b) => a - b);
}

/**
 * 一轮从排队到开始等了几秒：那句话写进去（`user_message`，排队时照常写，页面随即显示「排在第 n 位」）到这一轮开始
 * （`turn_started`）。两个时刻都是控制面记的，不含这一轮自己做事的时间。
 */
async function queueWait(page: Page, sessionId: string, turn: number) {
	const events = await sessionEvents(page, sessionId);
	const started = events.find((e) => e.type === "turn_started" && e.turn === turn);
	if (started === undefined) throw new Error(`会话 ${sessionId} 没有第 ${turn} 轮的 turn_started`);
	const said = events.filter((e) => e.type === "user_message" && e.seq < started.seq).at(-1);
	if (said === undefined) throw new Error(`会话 ${sessionId} 第 ${turn} 轮之前没有用户的话`);
	return {
		seconds: (Date.parse(started.at) - Date.parse(said.at)) / 1000,
		said: said.at,
		started: started.at,
	};
}

let admin: { context: BrowserContext; page: Page };

test.beforeAll(async ({ browser }) => {
	admin = await signIn(browser, ADMIN);
});

test.afterAll(async () => {
	await admin.context.close();
});

test("提交前：就绪状态，和缺东西时写明缺什么", async () => {
	const { page } = admin;
	await row(page, "提交前：就绪", async (evidence) => {
		await waitReady(page);
		await expect(readiness(page)).toHaveText(`可以用 · 工作台 ${WORKBENCH} 在线`);
		evidence.push(await shot(page, "就绪"));
		return `「可以用 · 工作台 ${WORKBENCH} 在线」`;
	});
	// 助手服务启动时试连一次模型、之后每 5 分钟一次（apps/assistant/src/model-health.ts）：停掉模型端点之后重启助手容器，让它马上试连。
	const cases: [string, [string, string][], [string, string][]][] = [
		["workbench_offline", [["stop", "sfly-workbench"]], [["start", "sfly-workbench"]]],
		["assistant_unreachable", [["stop", "sfly-assistant"]], [["start", "sfly-assistant"]]],
		[
			"model_unreachable",
			[
				["stop", "fake-model"],
				["restart", "sfly-assistant"],
			],
			[["start", "fake-model"]],
		],
		["model_not_configured", [["no-model", "sfly-assistant"]], [["model", "sfly-assistant"]]],
	];
	for (const [kind, downs, ups] of cases) {
		await row(page, `提交前：缺东西（${kind}）`, async (evidence) => {
			for (const [action, service] of downs) await ctl(action, service);
			let kinds: string[] = [];
			await expect
				.poll(
					async () => {
						await page.goto("/sessions");
						kinds = await page
							.getByTestId("readiness-problem")
							.evaluateAll((items) => items.map((item) => item.getAttribute("data-kind") ?? ""));
						return kinds;
					},
					{ timeout: 3 * 60_000, intervals: [3000] },
				)
				.toContain(kind);
			const text = (await readiness(page).textContent()) ?? "";
			await expect(page.getByRole("button", { name: "开始" })).toBeDisabled();
			evidence.push(await shot(page, `缺-${kind}`));
			for (const [action, service] of ups) await ctl(action, service);
			await waitReady(page);
			return `问题 ${kinds.join("、")}：${text.slice(0, 300)}；「开始」不可用；恢复后又是「可以用」`;
		});
	}
});

test("一句话之后的十分钟（主流程）", async ({ browser }) => {
	const { page } = admin;
	let elapsed = 0;
	let firstHint = "";
	await row(page, "0–3 秒：跳到会话页、自己的话在最上面、「思考中」", async (evidence) => {
		elapsed = await start(
			page,
			"写一个探测 http://sut:9000/health 的节点并调通，加到「demo 巡检」里跑通。AEVAL-SCRIPT:accept-main",
		);
		const clicked = Date.now() - elapsed;
		await expect(page.getByTestId("user-message").first()).toContainText("demo 巡检");
		const ownMessage = Date.now() - clicked;
		await expect(page.getByTestId("waiting-model").or(page.getByTestId("thinking"))).toBeVisible();
		firstHint =
			(await page.getByTestId("waiting-model").or(page.getByTestId("thinking")).textContent()) ??
			"";
		const hintAt = Date.now() - clicked;
		await expect(page.getByTestId("thinking")).toHaveText("思考中", { timeout: 60_000 });
		const thinkingAt = Date.now() - clicked;
		evidence.push(await shot(page, "思考中"));
		evidence.push(sample("first-seconds", { elapsed, ownMessage, hintAt, firstHint, thinkingAt }));
		expect(elapsed, "点「开始」到会话页").toBeLessThanOrEqual(3000);
		expect(ownMessage, "点「开始」到自己的话出现").toBeLessThanOrEqual(3000);
		expect(hintAt, "点「开始」到「思考中」或「等模型回复」").toBeLessThanOrEqual(3000);
		return `会话页 ${elapsed} 毫秒、自己的话 ${ownMessage} 毫秒、第一句提示「${firstHint}」${hintAt} 毫秒、「思考中」${thinkingAt} 毫秒`;
	});
	await row(page, "工具行：读 skill、写 probe.py", async (evidence) => {
		await expect(toolRow(page, "probe-pkg/.agents/skills/sfly-node-dev/SKILL.md")).toBeVisible({
			timeout: TURN,
		});
		await expect(toolRow(page, "probe-pkg/probe.py")).toBeVisible({ timeout: 60_000 });
		evidence.push(await shot(page, "工具行"));
		const titles = await page.getByTestId("tool-row").allTextContents();
		return titles.map((title) => title.slice(0, 120)).join(" | ");
	});
	const pytest = toolRow(page, "uv run pytest");
	await row(page, "命令在跑：转圈和已用时，展开后输出实时滚动", async (evidence) => {
		await expect(pytest).toHaveAttribute("data-state", "running", { timeout: 60_000 });
		const output = await openLive(pytest);
		await expect(output).toBeVisible();
		const counts = await every(1000, 6, () => lineCount(output));
		const status = (await pytest.getByRole("button").first().textContent()) ?? "";
		evidence.push(sample("live-output", counts), await shot(page, "命令输出"));
		expect(increasing(counts), `输出的行数应当增加：${counts}`).toBe(true);
		expect(status).toMatch(/在做\s*\d+s/);
		return `状态「${status.slice(-20)}」，每秒的行数 ${counts.join("、")}`;
	});
	await row(page, "刷新：看到的一样，进行中的一步接着滚", async (evidence) => {
		const before = await page.getByTestId("tool-row").count();
		await page.reload();
		await expect(page.getByTestId("tool-row")).toHaveCount(before);
		const output = await openLive(pytest);
		const counts = await every(1000, 4, () => lineCount(output));
		evidence.push(sample("refresh-output", counts), await shot(page, "刷新之后"));
		expect(increasing(counts), `刷新后输出应当接着增加：${counts}`).toBe(true);
		return `刷新前后都是 ${before} 行工具调用；刷新后每秒的行数 ${counts.join("、")}`;
	});
	await row(page, "换一个浏览器打开：看到的一样，接着滚", async (evidence) => {
		const other = await signIn(browser, ADMIN);
		try {
			await other.page.goto(page.url());
			const mine = await page.getByTestId("tool-row").count();
			await expect(other.page.getByTestId("tool-row")).toHaveCount(mine);
			const otherRow = toolRow(other.page, "uv run pytest");
			await expect(otherRow).toHaveAttribute("data-state", "running");
			const output = await openLive(otherRow);
			const counts = await every(1000, 4, () => lineCount(output));
			const last = async (p: Page) =>
				((await toolRow(p, "uv run pytest").getByTestId("tool-output").textContent()) ?? "")
					.trim()
					.split("\n")
					.at(-1);
			const ends = [await last(page), await last(other.page)];
			evidence.push(
				sample("other-browser-output", { counts, ends }),
				await shot(other.page, "另一个浏览器"),
			);
			expect(increasing(counts), `另一个浏览器里输出应当接着增加：${counts}`).toBe(true);
			return `另一个浏览器上下文里同样 ${mine} 行工具调用，这条命令的输出每秒 ${counts.join("、")} 行，两边最后一行「${ends[0]}」「${ends[1]}」`;
		} finally {
			await other.context.close();
		}
	});
	await row(
		page,
		"平台记录和运行卡片：保存了场景版本、触发了运行，卡片状态实时变",
		async (evidence) => {
			await expect(page.getByTestId("record-version").first()).toContainText(COPY, {
				timeout: TURN,
			});
			const cards = page.getByTestId("record-run").getByTestId("run-card");
			await expect(cards.first()).toBeVisible({ timeout: TURN });
			const seen: string[] = [];
			const deadline = Date.now() + TURN;
			while (Date.now() < deadline) {
				const statuses = await cards.evaluateAll((items) =>
					items.map((item) => item.getAttribute("data-status") ?? ""),
				);
				const line = statuses.join(",");
				if (seen.at(-1) !== line) seen.push(line);
				if (statuses.length >= 2 && statuses.at(-1) === "success") break;
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			evidence.push(sample("run-card-statuses", seen), await shot(page, "运行卡片"));
			expect(seen.at(-1)).toBe("failed,success");
			expect(
				seen.some((line) => line.split(",").includes("running")),
				`应当看到运行中：${seen}`,
			).toBe(true);
			await expect(cards.first().getByTestId("run-card-failure")).toBeVisible();
			// 两条「触发了运行」的平台记录，各对着接口按会话读回的一次运行，卡片的状态和接口一致。
			const sessionId = sessionIdOf(page);
			const runs = await sessionRuns(page, sessionId);
			const runRecords = await page.getByTestId("record-run").evaluateAll((items) =>
				items.map((item) => {
					const card = item.querySelector('[data-testid="run-card"]');
					return {
						text: item.textContent ?? "",
						link: item.querySelector('[data-slot="run-id"]')?.getAttribute("href") ?? "",
						run: card?.getAttribute("data-run") ?? "",
						status: card?.getAttribute("data-status") ?? "",
					};
				}),
			);
			// 保存场景版本的平台记录：每条写「保存了场景「副本」的版本 N」，版本号和版本历史里经这个会话保存的一致。
			const versionRecords = await page.getByTestId("record-version").evaluateAll((items) =>
				items.map((item) => ({
					text: item.textContent ?? "",
					link: item.querySelector('a[href*="/orchestrations/"]')?.getAttribute("href") ?? "",
				})),
			);
			evidence.push(sample("platform-records", { runs, runRecords, versionRecords }));
			expect(runRecords, "两次触发各一条平台记录").toHaveLength(2);
			for (const record of runRecords) {
				expect(record.text).toContain("触发了运行");
				expect(record.text).toContain(`场景「${COPY}」`);
				expect(record.link, "记录里的运行编号链到卡片的那次运行").toBe(`/runs/${record.run}`);
				expect(record.status, `运行 ${record.run} 的状态`).toBe(
					runs.find((run) => run.id === record.run)?.status,
				);
			}
			expect(runRecords.map((r) => r.run).sort()).toEqual(runs.map((r) => r.id).sort());
			expect(runRecords.map((r) => r.status)).toEqual(["failed", "success"]);
			expect(versionRecords.length, "至少一条保存版本的记录").toBeGreaterThan(0);
			const scenarioId =
				/\/orchestrations\/([0-9a-f-]{36})\//.exec(versionRecords[0]?.link ?? "")?.[1] ?? "";
			expect(scenarioId, "版本记录链到场景的版本历史").not.toBe("");
			const recorded = versionRecords.map((record) => {
				expect(record.text).toContain(`保存了场景「${COPY}」的`);
				return Number(/版本 (\d+)/.exec(record.text)?.[1]);
			});
			expect(recorded).toEqual(await versionsSavedBy(page, scenarioId, sessionId));
			return `卡片状态的变化：${seen.join(" → ")}；平台记录「触发了运行」${runRecords.map((r) => `${r.run.slice(0, 8)} ${r.status}`).join("、")}，「保存了场景版本」${recorded.join("、")}，和接口按会话读回的一致`;
		},
	);
	await row(page, "逐字出现：模型的总结一段一段出来", async (evidence) => {
		const message = page.getByTestId("assistant-message").last();
		await expect(message).toContainText("做完了", { timeout: TURN });
		const lengths = await every(200, 10, async () => ((await message.textContent()) ?? "").length);
		evidence.push(sample("streaming", lengths));
		expect(increasing(lengths), `长度应当增加：${lengths}`).toBe(true);
		return `每 200 毫秒的长度 ${lengths.join("、")}`;
	});
	await row(page, "9–10 分：总结、这一轮改了几个文件、成果栏", async (evidence) => {
		await expect(turnEnds(page).last()).toContainText("这一轮完成", { timeout: TURN });
		const summary = page.getByTestId("commit-summary").first();
		await expect(summary).toContainText("这一轮改了", { timeout: 60_000 });
		await summary.click();
		await expect(page.getByTestId("commit-file").first()).toBeVisible();
		const files = await page.getByTestId("commit-file").allTextContents();
		await expect(page.getByTestId("result-run")).toHaveCount(2);
		await expect(page.getByTestId("result-commit").first()).toBeVisible();
		const scenario = page.getByTestId("result-scenario").filter({ hasText: COPY });
		await expect(scenario).toHaveCount(1);
		evidence.push(await shot(page, "成果栏"));
		// 成果栏的每一项和接口读回来的逐项相等：场景版本（版本历史里经这个会话保存的）、运行（按会话读回的）、
		// 工作区的提交（会话事件里的 commit）。
		const sessionId = sessionIdOf(page);
		const scenarioId = (await scenario.getAttribute("data-scenario")) ?? "";
		const savedHere = await versionsSavedBy(page, scenarioId, sessionId);
		const shownVersions = (await scenario.getByTestId("result-version").allTextContents())
			.map((text) => Number(text.trim().replace(/^v/, "")))
			.sort((x, y) => x - y);
		const runs = await sessionRuns(page, sessionId);
		const shownRuns = await page.getByTestId("result-run").evaluateAll((items) =>
			items.map((item) => ({
				id: item.getAttribute("data-run") ?? "",
				status: item.querySelector('[data-testid="run-card"]')?.getAttribute("data-status") ?? "",
			})),
		);
		type Commit = {
			turn: number;
			hash: string;
			files: { additions: number | null; deletions: number | null }[];
		};
		const commits = (await sessionEvents(page, sessionId)).filter(
			(e) => e.type === "platform" && e.kind === "commit",
		) as unknown as Commit[];
		const sum = (c: Commit, key: "additions" | "deletions") =>
			c.files.reduce((n, f) => n + (f[key] ?? 0), 0);
		const expectedCommits = [...commits].reverse().map((c) => ({
			hash: c.hash,
			turn: `第 ${c.turn} 轮`,
			stat: `${c.files.length} 个文件 +${sum(c, "additions")} −${sum(c, "deletions")}`,
		}));
		const shownCommits = await page.getByTestId("result-commit").evaluateAll((items) =>
			items.map((item) => ({
				hash: item.querySelector('[data-testid="result-commit-hash"]')?.getAttribute("title") ?? "",
				turn: item.querySelector('[data-testid="result-commit-turn"]')?.textContent ?? "",
				stat: item.querySelector('[data-testid="result-commit-stat"]')?.textContent ?? "",
			})),
		);
		evidence.push(
			sample("results-readback", {
				scenarioId,
				versions: { api: savedHere, shown: shownVersions },
				runs: { api: runs, shown: shownRuns },
				commits: { api: expectedCommits, shown: shownCommits },
			}),
		);
		expect(savedHere.length, "这个会话保存过版本").toBeGreaterThan(0);
		expect(shownVersions, "成果栏的版本号").toEqual(savedHere);
		expect(runs.map((r) => r.status).sort()).toEqual(["failed", "success"]);
		expect(shownRuns.map((r) => r.id).sort(), "成果栏的运行就是这个会话触发的").toEqual(
			runs.map((r) => r.id).sort(),
		);
		for (const shown of shownRuns) {
			expect(shown.status, `运行 ${shown.id} 的状态`).toBe(
				runs.find((run) => run.id === shown.id)?.status,
			);
		}
		expect(commits.length, "会话事件里有工作区的提交").toBeGreaterThan(0);
		expect(shownCommits, "成果栏的提交（最近的在前）").toEqual(expectedCommits);
		expect(files.length, "「这一轮改了」列出的文件").toBe(commits[0]?.files.length);
		return `改了 ${files.length} 个文件（${files.join("、").slice(0, 200)}）；成果栏和接口逐项相等：版本 ${shownVersions.map((v) => `v${v}`).join("、")}，运行 ${shownRuns.map((r) => `${r.id.slice(0, 8)} ${r.status}`).join("、")}，提交 ${shownCommits.map((c) => `${c.hash.slice(0, 7)}（${c.turn}，${c.stat}）`).join("、")}`;
	});
	await row(page, "点运行卡片进运行监控、点版本看对比", async (evidence) => {
		const card = page.getByTestId("record-run").getByTestId("run-card").last();
		const href = await card.getAttribute("href");
		await card.click();
		await page.waitForURL(/\/runs\//);
		evidence.push(await shot(page, "运行监控"));
		await page.goBack();
		await page.waitForURL(SESSION_URL);
		const compare = page.getByTestId("result-compare").first();
		await expect(compare).toBeVisible();
		await compare.click();
		evidence.push(await shot(page, "版本对比"));
		return `卡片链接 ${href}，对比打开 ${page.url()}`;
	});
});

test("停止之后接着说", async () => {
	const { page } = admin;
	await row(page, "停止之后接着说", async (evidence) => {
		await start(page, "AEVAL-SCRIPT:accept-stop 跑一条很长的命令");
		await expect(toolRow(page, "sleep 300")).toHaveAttribute("data-state", "running", {
			timeout: TURN,
		});
		await page.getByRole("button", { name: "停止", exact: true }).click();
		await expect(turnEnds(page).last()).toContainText("已停止", { timeout: 60_000 });
		evidence.push(await shot(page, "已停止"));
		await say(page, "停下来了，接着说");
		await expect(turnEnds(page)).toHaveCount(2, { timeout: TURN });
		await expect(turnEnds(page).last()).toContainText("这一轮完成");
		await expect(page.getByTestId("assistant-message").last()).toContainText("停下来了，接着说");
		evidence.push(await shot(page, "接着说"));
		return "「已停止」之后说一句，新的一轮完成，回复里带着这句话";
	});
});

test("插话", async () => {
	const { page } = admin;
	await row(page, "插话：标「插话」，先等待送达后已送到，模型收到原文", async (evidence) => {
		await start(page, "AEVAL-SCRIPT:accept-steer 跑一条二十秒的命令");
		await expect(toolRow(page, "seq 1 20")).toHaveAttribute("data-state", "running", {
			timeout: TURN,
		});
		await say(page, "顺便看一下 /work 下面有什么");
		const steer = page.getByTestId("user-message").last();
		await expect(steer.getByTestId("message-role")).toHaveText("插话");
		const first = (await steer.getByTestId("message-delivery").textContent()) ?? "";
		evidence.push(await shot(page, "插话"));
		await expect(steer.getByTestId("message-delivery")).toHaveText("已送到", { timeout: TURN });
		await expect(turnEnds(page).last()).toContainText("这一轮完成", { timeout: TURN });
		await expect(page.getByTestId("assistant-message").last()).toContainText(
			"顺便看一下 /work 下面有什么",
		);
		evidence.push(await shot(page, "插话送到"));
		return `插话先是「${first}」，后是「已送到」；模型的回复里带着插话的原文`;
	});
});

test("一轮进行中重启控制面：不打断", async () => {
	const { page } = admin;
	await row(page, "重启控制面：不打断，页面重连后接着滚", async (evidence) => {
		await start(page, "AEVAL-SCRIPT:accept-long 跑一条一分钟的命令");
		const long = toolRow(page, "seq 1 60");
		await expect(long).toHaveAttribute("data-state", "running", { timeout: TURN });
		const output = await openLive(long);
		await expect(output).toContainText("第 5 行", { timeout: 60_000 });
		await ctl("restart", "sfly");
		const counts = await every(2000, 5, () => lineCount(output).catch(() => 0));
		await expect(turnEnds(page).last()).toContainText("这一轮完成", { timeout: TURN });
		evidence.push(sample("restart-control-plane", counts), await shot(page, "重启控制面之后"));
		const sessionId = page.url().split("/").at(-1) ?? "";
		const detail = await api<{ events: { seq: number; type: string }[] }>(
			page,
			`/sessions/${sessionId}`,
		);
		const seqs = detail.events.map((e) => e.seq);
		expect(seqs).toEqual(
			[...seqs].sort((a, b) => a - b).filter((s, i, all) => all.indexOf(s) === i),
		);
		expect(detail.events.filter((e) => e.type === "turn_end")).toHaveLength(1);
		return `重启后每 2 秒的行数 ${counts.join("、")}；这一轮完成，只有一个结局；持久事件序号 ${seqs[0]}–${seqs.at(-1)} 不重复`;
	});
});

test("一轮进行中重启助手容器：写明被打断，说一句接着做", async () => {
	const { page } = admin;
	await row(page, "重启助手容器：写明被打断，说一句接着做", async (evidence) => {
		await start(page, "AEVAL-SCRIPT:accept-interrupt 跑一条四十秒的命令");
		await expect(toolRow(page, "seq 1 40")).toHaveAttribute("data-state", "running", {
			timeout: TURN,
		});
		await ctl("restart", "sfly-assistant");
		await expect(turnEnds(page).last()).toContainText("中断", { timeout: TURN });
		const note = (await turnEnds(page).last().textContent()) ?? "";
		evidence.push(await shot(page, "被打断"));
		await waitReadyOn(page);
		await say(page, "接着做");
		await expect(turnEnds(page)).toHaveCount(2, { timeout: TURN });
		await expect(turnEnds(page).last()).toContainText("这一轮完成");
		evidence.push(await shot(page, "接着做"));
		return `结局「${note.slice(0, 200)}」；说一句之后新的一轮完成`;
	});
});

test("一轮进行中模型端点不通：重试、写明原因，恢复后接着做", async () => {
	const { page } = admin;
	await row(page, "模型端点不通：第 n 次重试，最后写明原因和已做的步骤", async (evidence) => {
		await start(page, "AEVAL-SCRIPT:accept-model-down 跑一条十五秒的命令");
		await expect(toolRow(page, "seq 1 15")).toHaveAttribute("data-state", "running", {
			timeout: TURN,
		});
		await ctl("stop", "fake-model");
		const retries = page.locator('[data-testid="notice"][data-kind="retry"]');
		await expect(retries.first()).toBeVisible({ timeout: TURN });
		evidence.push(await shot(page, "重试"));
		await expect(turnEnds(page).last()).toContainText("模型不可用", { timeout: TURN });
		evidence.push(await shot(page, "模型不可用"));
		const events = await sessionEvents(page, sessionIdOf(page));
		const end = events.find((e) => e.type === "turn_end" && e.turn === 1) as
			| { outcome: string; reason: string; steps?: number }
			| undefined;
		const retryEvents = events.filter((e) => e.type === "notice" && e.kind === "retry");
		const shownRetries = await retries.allTextContents();
		const exhausted =
			(await page.locator('[data-testid="notice"][data-kind="retry_end"]').last().textContent()) ??
			"";
		const endText = (await turnEnds(page).last().textContent()) ?? "";
		evidence.push(sample("model-down", { shownRetries, retryEvents, exhausted, endText, end }));
		// 每次重试一行「正在第 n/3 次重试」，n 从 1 起逐次加一，到 3 为止，和事件里的 attempt 一致。
		const attempts = shownRetries.map((text) => {
			const found = /正在第 (\d+)\/(\d+) 次重试/.exec(text);
			expect(found, `重试的提示要写第几次：${text}`).not.toBeNull();
			return { n: Number(found?.[1]), max: Number(found?.[2]) };
		});
		expect(attempts.map((a) => a.n)).toEqual([1, 2, 3]);
		expect(attempts.map((a) => a.max)).toEqual([3, 3, 3]);
		expect(retryEvents.map((e) => e.attempt)).toEqual([1, 2, 3]);
		// 结局：原因（连不上模型端点）和这一轮已经做了的步骤（只有那一条命令）。
		expect(end?.outcome).toBe("model_unavailable");
		expect(end?.reason).toContain("连不上模型端点");
		expect(end?.steps, "这一轮做了一步：那条命令").toBe(1);
		expect(exhausted).toBe(`重试用尽：${end?.reason}`);
		expect(endText).toContain(
			`模型不可用：${end?.reason}。这一轮做了 1 步，都在上面；工作区的改动已经提交，已触发的运行不受影响。`,
		);
		await expect(toolRow(page, "seq 1 15")).toHaveAttribute("data-state", "done");
		await ctl("start", "fake-model");
		await waitReadyOn(page);
		await say(page, "模型好了，接着做");
		await expect(turnEnds(page)).toHaveCount(2, { timeout: TURN });
		await expect(turnEnds(page).last()).toContainText("这一轮完成");
		return `重试的提示 ${attempts.map((a) => `${a.n}/${a.max}`).join("、")}（「${shownRetries.at(-1)?.slice(0, 80)}」）；「${exhausted.slice(0, 80)}」；结局「${endText.slice(0, 300)}」；恢复后接着做完`;
	});
});

test("两个账号交替说话：排队提示和等待时间", async ({ browser }) => {
	const a = admin.page;
	const b = await signIn(browser, EDITOR);
	try {
		await row(a, "两个账号交替：排第几、在等谁，记下等待时间", async (evidence) => {
			const waits: {
				who: string;
				seconds: number;
				said: string;
				started: string;
				status: string;
			}[] = [];
			await start(a, "AEVAL-SCRIPT:accept-queue 甲的事");
			const sessionA = a.url();
			await expect(toolRow(a, "seq 1 20")).toHaveAttribute("data-state", "running", {
				timeout: TURN,
			});
			await b.page.goto("/sessions");
			await b.page
				.getByRole("textbox", { name: "要做什么？" })
				.fill("AEVAL-SCRIPT:accept-queue 乙的事");
			await b.page.getByRole("button", { name: "开始" }).click();
			await b.page.waitForURL(SESSION_URL);
			const statusB = b.page.getByTestId("session-status");
			await expect(statusB).toContainText("排在第 1 位", { timeout: 60_000 });
			const waitingB = b.page.getByTestId("composer-blocked");
			await expect(waitingB).toContainText(`（${ADMIN.login}）正在做`);
			const shownB = `${await statusB.textContent()}；${await waitingB.textContent()}`;
			evidence.push(await shot(b.page, "乙排队"));
			await expect(toolRow(b.page, "seq 1 20")).toBeVisible({ timeout: TURN });
			waits.push({
				who: "乙",
				...(await queueWait(b.page, sessionIdOf(b.page), 1)),
				status: shownB,
			});
			await a.goto(sessionA);
			await expect(turnEnds(a).last()).toContainText("这一轮完成", { timeout: TURN });
			await say(a, "甲再说一句");
			const statusA = a.getByTestId("session-status");
			await expect(statusA).toContainText("排在第 1 位", { timeout: 60_000 });
			const waitingA = a.getByTestId("composer-blocked");
			await expect(waitingA).toContainText("（乙）正在做");
			const shownA = `${await statusA.textContent()}；${await waitingA.textContent()}`;
			evidence.push(await shot(a, "甲排队"));
			await expect(turnEnds(a)).toHaveCount(2, { timeout: TURN });
			waits.push({ who: "甲", ...(await queueWait(a, sessionIdOf(a), 2)), status: shownA });
			await expect(turnEnds(b.page).last()).toContainText("这一轮完成", { timeout: TURN });
			await expect(turnEnds(a).last()).toContainText("这一轮完成", { timeout: TURN });
			evidence.push(sample("queue-waits", waits));
			for (const wait of waits) {
				expect(
					wait.seconds,
					`${wait.who}从排队到开始（${wait.said} → ${wait.started}）`,
				).toBeGreaterThan(0);
			}
			return waits
				.map((w) => `${w.who}排队 ${w.seconds.toFixed(1)} 秒，写着「${w.status.slice(0, 160)}」`)
				.join("；");
		});
	} finally {
		await b.context.close();
	}
});

/** 会话页上等助手重新可以用（重启助手、恢复模型端点之后）。 */
async function waitReadyOn(page: Page) {
	const url = page.url();
	await waitReady(page);
	await page.goto(url);
	await expect(page.getByRole("textbox", { name: /接着说/ })).toBeEnabled({ timeout: 60_000 });
}

test.afterAll(() => {
	sample("project", { project: PROJECT });
});
