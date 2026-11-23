// 把助手服务组装成镜像的构建上下文 out/assistant/（apps/assistant/Dockerfile 只复制它，没有 RUN）：
//
//   main.mjs, main.mjs.map    助手服务（@sfly/schema、@sfly/proto、connect 都打进去；pi 不打进去）
//   package.json              名字、版本（/health 报的助手服务版本）
//   platform-prompt.md        平台说明的模板（--append-system-prompt）
//   dist/extension.mjs        远程工具扩展（pi 用 -e 加载）
//   skills/                   docs/guide/skills/ 下的两份 skill（跟随软链接复制，和 sfly init 放进节点包的是同一份）
//   node_modules/             按锁文件装好的 pi 和它的依赖（pnpm deploy --prod：运行时只依赖 pi）
//
// 产物与 CPU 架构无关：pi 的依赖里按平台分发的原生文件（pi-tui 的 prebuilds）各平台的都带着，助手服务不用它们。
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };
import { buildExtension } from "./build-extension.js";

const appDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appDir, "../..");
const outDir = join(repoRoot, "out", "assistant");
const nodeMajor = (await readFile(join(repoRoot, ".node-version"), "utf8")).trim();

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
	entryPoints: [join(appDir, "src", "main.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: `node${nodeMajor}`,
	external: ["@earendil-works/pi-coding-agent"],
	outfile: join(outDir, "main.mjs"),
	sourcemap: true,
	legalComments: "external",
	logLevel: "warning",
});
await buildExtension(join(outDir, "dist", "extension.mjs"));
await cp(join(appDir, "src", "platform-prompt.md"), join(outDir, "platform-prompt.md"));
await cp(join(repoRoot, "docs", "guide", "skills"), join(outDir, "skills"), {
	recursive: true,
	dereference: true,
});
await writeFile(
	join(outDir, "package.json"),
	`${JSON.stringify({ name: packageJson.name, version: packageJson.version, type: "module", private: true }, null, "\t")}\n`,
);

// pi 和它的依赖按锁文件装好（只有运行时依赖：package.json 的 dependencies 只有 pi）。
const deployed = join(repoRoot, "out", "assistant-deploy");
await rm(deployed, { recursive: true, force: true });
execFileSync("pnpm", ["--filter", packageJson.name, "deploy", "--prod", "--legacy", deployed], {
	cwd: repoRoot,
	stdio: "inherit",
});
await cp(join(deployed, "node_modules"), join(outDir, "node_modules"), {
	recursive: true,
	verbatimSymlinks: true,
});
await rm(deployed, { recursive: true, force: true });
// pnpm 的元数据文件和 .bin 下的启动脚本里有构建机器上的绝对路径（带用户名），运行时用不到（pi 用
// `node <命令行入口>` 拉起），不进镜像。
await rm(join(outDir, "node_modules", ".modules.yaml"), { force: true });
for (const entry of await readdir(join(outDir, "node_modules"), {
	recursive: true,
	withFileTypes: true,
})) {
	if (entry.isDirectory() && entry.name === ".bin") {
		await rm(join(entry.parentPath, entry.name), { recursive: true, force: true });
	}
}
console.log(outDir);
