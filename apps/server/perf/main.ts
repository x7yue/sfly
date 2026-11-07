// 本地性能测试入口（ARCHITECTURE §7.6）：根目录 `pnpm perf` 与 `pnpm perf:soak`（--soak）。只在本地开发环境运行，不进 CI。
//
// 1. 构建 release Agent 与打包后的控制面（--no-build 跳过）；
// 2. 依次运行 perf/items/ 下的各项（--only 只运行指定项；--soak 只运行 soak.ts 的长时负载测试），
//    每项用独立的数据库、临时目录和进程，结束（包括失败与 Ctrl-C）后清理；被 Ctrl-C 中断时，
//    正在运行的项交出已采集的数据，报告照常写出并标为被中断；
// 3. 把报告写到 out/perf/<时间>/report.{json,md}，与本机上一次结果对比，标出变化超过 20% 的数值；
// 4. 有硬性断言不满足或某项出错时以退出码 1 结束，并列出是哪一项、哪个数值。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, hostname, release, totalmem, type } from "node:os";
import { join, relative, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import type { Artifacts, PerfContext, PerfItem } from "./item.js";
import { parseOptions, USAGE } from "./options.js";
import { loadItems, selectItems } from "./registry.js";
import {
	buildReport,
	type ItemOutcome,
	type MachineInfo,
	pickPrevious,
	renderMarkdown,
	type VersionInfo,
} from "./report.js";
import { soak } from "./soak.js";
import { buildArtifacts, existingArtifacts } from "./stack.js";
import { parseTargets } from "./targets.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const log = (message: string) => console.log(`[perf] ${message}`);

function machineInfo(): MachineInfo {
	let raw: string;
	try {
		raw = readFileSync("/etc/machine-id", "utf8").trim();
	} catch {
		raw = hostname();
	}
	return {
		id: createHash("sha256").update(raw).digest("hex").slice(0, 12),
		hostname: hostname(),
		cpus: cpus().length,
		cpuModel: cpus()[0]?.model.trim() ?? "unknown",
		memoryBytes: totalmem(),
		os: `${type()} ${release()}`,
	};
}

function versionInfo(): VersionInfo {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
	try {
		return {
			sfly: packageJson.version,
			commit: git("rev-parse", "--short", "HEAD"),
			dirty: git("status", "--porcelain") !== "",
		};
	} catch {
		return { sfly: packageJson.version, commit: "unknown", dirty: false };
	}
}

/** out/perf 下已有的结果（`<时间>/report.json`）。 */
async function existingReports(outDir: string) {
	const dirs = await readdir(outDir, { withFileTypes: true }).catch(() => []);
	const reports: Array<{ dir: string; report: unknown }> = [];
	for (const entry of dirs) {
		if (!entry.isDirectory()) continue;
		const dir = join(outDir, entry.name);
		try {
			reports.push({ dir, report: JSON.parse(await readFile(join(dir, "report.json"), "utf8")) });
		} catch {
			// 不是结果目录（例如 tmp、server），或者报告不完整。
		}
	}
	return reports;
}

/** 运行一项：独立的临时目录（同时作为 TMPDIR），结束后按相反顺序执行登记的清理并删除临时目录。 */
async function runItem(
	item: PerfItem,
	parentTmp: string,
	artifacts: Artifacts,
	signal: AbortSignal,
	target: string | null,
): Promise<ItemOutcome> {
	// 目录名尽量短：Agent 在工作目录里建 Unix socket，路径超过 108 字节就建不了（只是少了 sfly dev）。
	const tmpDir = await mkdtemp(join(parentTmp, "i"));
	const cleanups: Array<() => unknown> = [];
	const ctx: PerfContext = {
		tmpDir,
		repoRoot,
		artifacts,
		signal,
		defer: (cleanup) => cleanups.push(cleanup),
		log: (message) => log(`${item.id}：${message}`),
	};
	const previousTmp = process.env.TMPDIR;
	process.env.TMPDIR = tmpDir;
	const started = Date.now();
	const base = { id: item.id, title: item.title, scope: item.scope, target };
	try {
		const result = await item.run(ctx);
		return { ...base, durationMs: Date.now() - started, ...result };
	} catch (error) {
		const message = signal.aborted
			? "被中断"
			: error instanceof Error
				? (error.stack ?? error.message)
				: String(error);
		return { ...base, durationMs: Date.now() - started, measurements: [], error: message };
	} finally {
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup();
			} catch (error) {
				log(`${item.id}：清理失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		process.env.TMPDIR = previousTmp;
		await rm(tmpDir, { recursive: true, force: true });
	}
}

async function main(): Promise<number> {
	let options: ReturnType<typeof parseOptions>;
	try {
		options = parseOptions(process.argv.slice(2), process.env, repoRoot);
	} catch (error) {
		console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	const all = options.soakSeconds === null ? await loadItems() : [soak(options.soakSeconds)];
	if (options.list) {
		for (const item of all) console.log(`${item.id}\t${item.title}`);
		return 0;
	}
	let items: PerfItem[];
	try {
		items = selectItems(all, options.only);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (options.soakSeconds !== null) {
		log(
			`长时负载测试：持续 ${options.soakSeconds} 秒（中途按 Ctrl-C 停止，已采集的数据照常写进报告）`,
		);
	}

	const abort = new AbortController();
	// 终端的 Ctrl-C 发给整个进程组（Agent、控制面也会收到），pnpm 还会把它收到的 SIGINT 转发给本进程（几毫秒后）、
	// 也可能再发 SIGTERM。所以中断之后：1 秒内的 SIGINT 算同一次 Ctrl-C，SIGTERM 忽略，都不打断清理与写报告；
	// 隔 1 秒以上再按一次 Ctrl-C 才立即退出。也因此 package.json 用 `node --import tsx` 启动：
	// tsx 命令行会转发信号，本进程忙时它会重发信号、最后 SIGKILL。
	let firstSigint: number | undefined;
	const onSignal = (signal: NodeJS.Signals) => {
		if (signal === "SIGINT") {
			if (firstSigint !== undefined && Date.now() - firstSigint > 1000) process.exit(130);
			firstSigint ??= Date.now();
		}
		if (abort.signal.aborted) return;
		log("收到中断：停止当前项并清理，写出已采集的数据（再按一次 Ctrl-C 立即退出，不清理）");
		abort.abort(new Error("被中断"));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const startedAt = new Date().toISOString();
	await mkdir(options.tmpDir, { recursive: true });
	const runTmp = await mkdtemp(join(options.tmpDir, "r"));
	const outcomes: ItemOutcome[] = [];
	try {
		// 构建过程（cargo、vite、uv）的临时文件也放在临时目录里。
		process.env.TMPDIR = runTmp;
		let artifacts: Artifacts = { agentBin: "", bundleDir: "" };
		if (items.some((i) => i.needsArtifacts)) {
			artifacts = options.build ? await buildArtifacts(repoRoot, log) : existingArtifacts(repoRoot);
		}
		const targets = parseTargets(await readFile(join(repoRoot, "docs/ARCHITECTURE.md"), "utf8"));
		for (const item of items) {
			if (abort.signal.aborted) break;
			log(`开始：${item.title}（${item.id}）`);
			const outcome = await runItem(
				item,
				runTmp,
				artifacts,
				abort.signal,
				item.scope === null ? null : (targets.get(item.scope) ?? null),
			);
			log(`结束：${item.title}${outcome.error ? "（出错）" : ""}`);
			outcomes.push(outcome);
		}
	} finally {
		await rm(runTmp, { recursive: true, force: true });
	}
	if (outcomes.length === 0) return abort.signal.aborted ? 130 : 1;

	const machine = machineInfo();
	const previous = pickPrevious(await existingReports(options.outDir), machine.id, startedAt);
	const report = buildReport({
		startedAt,
		finishedAt: new Date().toISOString(),
		machine,
		version: versionInfo(),
		only: options.only,
		interrupted: abort.signal.aborted,
		items: outcomes,
		previous: previous && { dir: relative(repoRoot, previous.dir), report: previous.report },
	});
	const dir = join(options.outDir, startedAt.replace(/\.\d+Z$/, "").replace(/:/g, "-"));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
	await writeFile(join(dir, "report.md"), renderMarkdown(report));

	log(`报告：${relative(repoRoot, dir)}/report.md`);
	log(report.comparison ? `已与 ${report.comparison.dir} 对比` : "本机没有更早的结果，不对比");
	for (const c of report.changes) log(`变化超过 20%：${c.title} / ${c.label}`);
	if (report.interrupted) {
		log("结论：被中断（已采集的数据照常写进报告）");
		for (const failure of report.failures) log(`  ${failure}`);
	} else if (report.ok) {
		log("结论：通过");
	} else {
		log("结论：不通过");
		for (const failure of report.failures) log(`  ${failure}`);
	}
	if (abort.signal.aborted) return 130;
	return report.ok ? 0 : 1;
}

// 显式退出：万一某项留下了句柄（定时器、连接），也不让命令挂住。
process.exit(await main());
