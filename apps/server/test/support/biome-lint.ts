// 在测试里跑 biome 时的重试：Biome 2.4.x 偶发的工作区竞态（#582）。
//
// CPU 紧张时（并行的测试、CI 的 runner），`biome lint` 偶尔在文件上报
// `internalError/fs: The file does not exist in the workspace.`，文件其实在、也没人动它：Biome 自己的工作区
// 状态里扫描和检查的线程之间的竞态（上游有同类的未修复报告：biomejs/biome#10268）。查原因时的结果：
// - 单个 biome 进程、一次只跑一个、同时有 24 个空转循环占着 CPU 时 600 次里出现 1 次；
// - 和规则无关：不加载任何规则也会出现；和哪个目录无关；每个进程一份样例的副本、换工作目录、改成逐个文件传参都照样出现；
// - 样例的文件和目录越多越容易碰上（7 个文件 16 个目录的样例 1000 次里 4 次，2 个文件 7 个目录的 1600 次里 0 次）。
// 出现时这个文件没有被检查，所以重跑一次就是干净的结果。只认这一种内部错误：真正的诊断（规则命中、语法错误）、
// 别的内部错误都原样返回，不重试，规则写坏了不会被重试盖住。

export interface BiomeDiagnostic {
	category: string;
	message: string;
}

/** 是不是上面说的那个竞态报出的诊断。 */
export const isWorkspaceRace = (d: BiomeDiagnostic): boolean =>
	d.category === "internalError/fs" && d.message.includes("does not exist in the workspace");

/** 重试的次数上限（含第一次）：竞态的概率是千分之几，连续碰上五次的概率可以忽略；碰上了就是别的问题，要报出来。 */
export const WORKSPACE_RACE_ATTEMPTS = 5;

/**
 * 跑 `run`，结果里没有竞态的诊断就返回；有就重跑，最多 `attempts` 次。次数用完还是这个错误时抛出，写明重试过。
 */
export function retryOnWorkspaceRace<T extends { diagnostics: BiomeDiagnostic[] }>(
	run: () => T,
	attempts = WORKSPACE_RACE_ATTEMPTS,
): T {
	let last: T | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		last = run();
		if (!last.diagnostics.some(isWorkspaceRace)) return last;
	}
	throw new Error(
		`biome 连续 ${attempts} 次报 internalError/fs（文件不在工作区里）：偶发的竞态不会连着碰上这么多次，` +
			`这次是别的原因（样例文件被删了、磁盘或权限问题）。最后一次的诊断：\n` +
			JSON.stringify(last?.diagnostics, null, 2),
	);
}
