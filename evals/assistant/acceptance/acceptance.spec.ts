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
			return `卡片状态的变化：${seen.join(" → ")}`;
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
		await expect(page.getByTestId("results-scenarios")).toContainText(COPY);
		evidence.push(await shot(page, "成果栏"));
		const sessionId = page.url().split("/").at(-1) ?? "";
		const runs = await api<{ runs: { id: string; status: string; session?: { id: string } }[] }>(
			page,
			`/runs?session_id=${sessionId}`,
		);
		evidence.push(
			sample(
				"session-runs",
				runs.runs.map(({ id, status }) => ({ id, status })),
			),
		);
		expect(runs.runs.map((r) => r.status).sort()).toEqual(["failed", "success"]);
		const shown = await page.getByTestId("result-run").allTextContents();
		return `改了 ${files.length} 个文件（${files.join("、").slice(0, 200)}）；成果栏 2 次运行，接口按会话读回 ${runs.runs.map((r) => r.status).join("、")}；${shown.join(" | ").slice(0, 200)}`;
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
		const notice = page.getByTestId("notice").filter({ hasText: "重试" }).first();
		await expect(notice).toBeVisible({ timeout: TURN });
		const retry = (await notice.textContent()) ?? "";
		evidence.push(await shot(page, "重试"));
		await expect(turnEnds(page).last()).toContainText("模型不可用", { timeout: TURN });
		const end = (await turnEnds(page).last().textContent()) ?? "";
		evidence.push(await shot(page, "模型不可用"));
		await ctl("start", "fake-model");
		await waitReadyOn(page);
		await say(page, "模型好了，接着做");
		await expect(turnEnds(page)).toHaveCount(2, { timeout: TURN });
		await expect(turnEnds(page).last()).toContainText("这一轮完成");
		return `重试的提示「${retry.slice(0, 120)}」；结局「${end.slice(0, 300)}」；恢复后接着做完`;
	});
});

test("两个账号交替说话：排队提示和等待时间", async ({ browser }) => {
	const a = admin.page;
	const b = await signIn(browser, EDITOR);
	try {
		await row(a, "两个账号交替：排第几、在等谁，记下等待时间", async (evidence) => {
			const waits: { who: string; seconds: number; status: string }[] = [];
			await start(a, "AEVAL-SCRIPT:accept-queue 甲的事");
			const sessionA = a.url();
			await expect(toolRow(a, "seq 1 20")).toHaveAttribute("data-state", "running", {
				timeout: TURN,
			});
			let queuedAt = Date.now();
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
			waits.push({ who: "乙", seconds: (Date.now() - queuedAt) / 1000, status: shownB });
			await a.goto(sessionA);
			await expect(turnEnds(a).last()).toContainText("这一轮完成", { timeout: TURN });
			queuedAt = Date.now();
			await say(a, "甲再说一句");
			const statusA = a.getByTestId("session-status");
			await expect(statusA).toContainText("排在第 1 位", { timeout: 60_000 });
			const waitingA = a.getByTestId("composer-blocked");
			await expect(waitingA).toContainText("（乙）正在做");
			const shownA = `${await statusA.textContent()}；${await waitingA.textContent()}`;
			evidence.push(await shot(a, "甲排队"));
			await expect(turnEnds(a)).toHaveCount(2, { timeout: TURN });
			waits.push({ who: "甲", seconds: (Date.now() - queuedAt) / 1000, status: shownA });
			await expect(turnEnds(b.page).last()).toContainText("这一轮完成", { timeout: TURN });
			await expect(turnEnds(a).last()).toContainText("这一轮完成", { timeout: TURN });
			evidence.push(sample("queue-waits", waits));
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
