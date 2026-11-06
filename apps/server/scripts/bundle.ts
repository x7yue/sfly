// 把控制面打包成用 node 直接运行的单文件（ADR 0010），连同运行时需要的文件组装到 out/server/：
//
//   main.mjs, main.mjs.map   控制面（含全部 npm 依赖；用 `node --enable-source-maps main.mjs` 运行）
//   main.mjs.LEGAL.txt       打进去的依赖的许可证声明
//   drizzle/                 数据库迁移
//   web/                     前端构建产物（apps/web/dist）
//   sdk/                     与本版本一致的 SDK 运行时 wheel（apps/server/dist/sdk）
//
// 需要先构建前端和 SDK wheel；根目录的 `pnpm bundle:server` 会依次完成这两步和打包。
// 产物与 CPU 架构无关（依赖都是纯 JS），镜像直接复制这个目录（apps/server/Dockerfile）。
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };

const serverDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(serverDir, "../..");
const outDir = join(repoRoot, "out", "server");
const webDist = join(repoRoot, "apps", "web", "dist");
const sdkDist = join(serverDir, "dist", "sdk");
const { version } = packageJson;
/** 运行时的 Node 主版本：仓库根目录的 .node-version（镜像的基础镜像也由它决定）。 */
const nodeMajor = (await readFile(join(repoRoot, ".node-version"), "utf8")).trim();

const fail = (message: string): never => {
	console.error(`bundle: ${message}`);
	process.exit(1);
};

const webFiles = await readdir(webDist).catch(() => [] as string[]);
if (!webFiles.includes("index.html")) {
	fail(`${webDist}/index.html 不存在，先运行 pnpm --filter @sfly/web build`);
}
const wheel = `sfly-${version}-py3-none-any.whl`;
const sdkFiles = await readdir(sdkDist).catch(() => [] as string[]);
if (!sdkFiles.includes(wheel)) {
	fail(
		`${sdkDist}/${wheel} 不存在（版本须与控制面 ${version} 一致），先运行 pnpm --filter @sfly/server build`,
	);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "sdk"), { recursive: true });

await build({
	entryPoints: [join(serverDir, "src", "main.ts")],
	outfile: join(outDir, "main.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: `node${nodeMajor}`,
	// pg 的可选原生绑定，我们不用。
	external: ["pg-native"],
	// 依赖里有 CommonJS 模块会调用 require；ESM 输出里没有 require，需要补上。
	banner: {
		js: 'import { createRequire as __sflyCreateRequire } from "node:module";\nconst require = __sflyCreateRequire(import.meta.url);',
	},
	define: { SFLY_BUNDLED: "true" },
	sourcemap: "linked",
	sourcesContent: false,
	legalComments: "external",
	logLevel: "warning",
});
await cp(join(serverDir, "drizzle"), join(outDir, "drizzle"), { recursive: true });
await cp(webDist, join(outDir, "web"), { recursive: true });
await cp(join(sdkDist, wheel), join(outDir, "sdk", wheel));

console.log(`bundle: sfly control plane ${version} -> ${relative(repoRoot, outDir)}`);
