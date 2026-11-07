import { resolve } from "node:path";
import { parseArgs } from "node:util";

/** `pnpm perf` 的命令行参数。 */
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
}

export const USAGE = `用法：pnpm perf [--only <项>[,<项>...]] [--tmp-dir <目录>] [--out-dir <目录>] [--no-build] [--list]
  --only      只运行指定的项（可重复，或用逗号分隔）；--list 列出全部项
  --tmp-dir   临时目录，默认 out/perf/tmp（也可以用环境变量 SFLY_PERF_TMPDIR）；不要放在很小的 /tmp 上
  --out-dir   结果目录，默认 out/perf；报告写到 <结果目录>/<时间>/report.{md,json}
  --no-build  不重新构建 release Agent 与打包控制面，直接用上次构建的产物
相对路径按仓库根目录解析。`;

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
		},
	});
	const only = values.only?.flatMap((v) => v.split(",").map((s) => s.trim())).filter(Boolean);
	const outDir = resolve(root, values["out-dir"] ?? "out/perf");
	return {
		only: only && only.length > 0 ? only : null,
		tmpDir: resolve(root, values["tmp-dir"] ?? env.SFLY_PERF_TMPDIR ?? "out/perf/tmp"),
		outDir,
		build: !values["no-build"],
		list: values.list ?? false,
	};
}
