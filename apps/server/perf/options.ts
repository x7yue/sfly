import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { INGEST_SECONDS } from "./targets.js";

/** `pnpm perf` 与 `pnpm perf:soak`（--soak）的命令行参数。 */
export interface PerfOptions {
	/** 只运行这些项（按给定顺序）；null 表示全部。 */
	only: string[] | null;
	/** 临时目录（数据库之外的全部临时文件：数据目录、Agent 工作目录、venv、TMPDIR）。 */
	tmpDir: string;
	/** 结果目录：每次运行写到它下面的 `<时间>/`，对比也在这里找上一次。 */
	outDir: string;
	/** 运行前构建 release Agent 与打包控制面；`--no-build` 时直接用已有的产物。 */
	build: boolean;
	/** 只列出可用的项。 */
	list: boolean;
	/** 长时负载测试（`--soak`）的时长（秒）；null 表示运行 `pnpm perf` 的各项。 */
	soakSeconds: number | null;
}

/** 长时负载测试的默认时长：1 小时（ARCHITECTURE §7.6）。 */
export const DEFAULT_SOAK_SECONDS = INGEST_SECONDS;

/** 控制面接收指标这一项（control-plane-metrics）的持续时间（秒）。 */
export const CONTROL_PLANE_SECONDS_ENV = "SFLY_PERF_CONTROL_PLANE_SECONDS";
/** Agent 断线这一项（agent-disconnect）里控制面停掉的时长（秒）。 */
export const DISCONNECT_SECONDS_ENV = "SFLY_PERF_DISCONNECT_SECONDS";

export const USAGE = `用法：pnpm perf [--only <项>[,<项>...]] [--tmp-dir <目录>] [--out-dir <目录>] [--no-build] [--list]
      pnpm perf:soak [--duration <时长>] [--tmp-dir <目录>] [--out-dir <目录>] [--no-build]
  --only      只运行指定的项（可重复，或用逗号分隔）；--list 列出全部项
  --duration  长时负载测试的时长，默认 1h；写成 300（秒）、90s、30m、2h、1h30m 这样
  --tmp-dir   临时目录，默认 out/perf/tmp（也可以用环境变量 SFLY_PERF_TMPDIR）；不要放在很小的 /tmp 上
  --out-dir   结果目录，默认 out/perf（perf:soak 为 out/perf/soak）；报告写到 <结果目录>/<时间>/report.{md,json}
  --no-build  不重新构建 release Agent 与打包控制面，直接用上次构建的产物
环境变量（秒数）：
  ${CONTROL_PLANE_SECONDS_ENV}  control-plane-metrics 的持续时间，默认 60（1 小时的目标由 perf:soak 覆盖）
  ${DISCONNECT_SECONDS_ENV}     agent-disconnect 里控制面停掉的时长，默认 45、至少 30；300 即 §7.6 的断线 5 分钟
相对路径按仓库根目录解析。perf:soak 中途按 Ctrl-C 会停止负载，已采集的数据照常写进报告。`;

/**
 * 环境变量 name 里的秒数：没设或为空时用 fallback；不是正数时报错并指出变量名，给了 min 时短于它也报错。
 * 某一项要缩短或加长时用（见 {@link USAGE}），在这一项运行时读取。
 */
export function secondsFromEnv(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	min?: { seconds: number; reason: string },
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`${name} 应为正的秒数，实际为 ${JSON.stringify(raw)}`);
	}
	if (min && seconds < min.seconds) {
		throw new Error(`${name} 至少 ${min.seconds} 秒（${min.reason}）：${seconds}`);
	}
	return seconds;
}

const DURATION = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/;

/** 解析时长：秒数，或数字加单位 h、m、s 的组合（按这个顺序，例如 `1h30m`、`90s`）。返回秒数。 */
export function parseDuration(text: string): number {
	const invalid = () =>
		new Error(`无效的时长 ${JSON.stringify(text)}：写成 300（秒）、90s、30m、2h、1h30m 这样`);
	let seconds: number;
	if (/^\d+(?:\.\d+)?$/.test(text)) {
		seconds = Number(text);
	} else {
		const match = DURATION.exec(text);
		if (!text || !match) throw invalid();
		const [h, m, s] = match.slice(1).map((v) => Number(v ?? 0)) as [number, number, number];
		seconds = h * 3600 + m * 60 + s;
	}
	if (!(seconds > 0)) throw invalid();
	return seconds;
}

/** 解析命令行参数；相对路径按仓库根目录 `root` 解析。不认识的参数抛出错误。 */
export function parseOptions(
	argv: string[],
	env: Record<string, string | undefined>,
	root: string,
): PerfOptions {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		allowPositionals: false,
		options: {
			only: { type: "string", multiple: true },
			"tmp-dir": { type: "string" },
			"out-dir": { type: "string" },
			"no-build": { type: "boolean" },
			list: { type: "boolean" },
			soak: { type: "boolean" },
			duration: { type: "string" },
		},
	});
	const only = values.only?.flatMap((v) => v.split(",").map((s) => s.trim())).filter(Boolean);
	const soak = values.soak ?? false;
	if (values.duration !== undefined && !soak) {
		throw new Error("--duration 只用于长时负载测试（pnpm perf:soak）");
	}
	if (soak && only && only.length > 0) {
		throw new Error("长时负载测试（pnpm perf:soak）只有一项，不能用 --only");
	}
	// 长时负载测试的结果单独放：对比只找同类的上一次，pnpm perf 也不会拿它当上一次。
	const outDir = resolve(root, values["out-dir"] ?? (soak ? "out/perf/soak" : "out/perf"));
	return {
		only: only && only.length > 0 ? only : null,
		tmpDir: resolve(root, values["tmp-dir"] ?? env.SFLY_PERF_TMPDIR ?? "out/perf/tmp"),
		outDir,
		build: !values["no-build"],
		list: values.list ?? false,
		soakSeconds: soak
			? values.duration === undefined
				? DEFAULT_SOAK_SECONDS
				: parseDuration(values.duration)
			: null,
	};
}
