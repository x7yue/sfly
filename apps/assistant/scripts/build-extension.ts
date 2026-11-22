// 把远程工具扩展（src/extension/extension.ts）打包成一个 dist/extension.mjs：依赖都打进去，只有 pi 自己
// （`@earendil-works/pi-coding-agent`）留给加载它的 pi 提供。助手服务拉起 pi 时用 `-e` 加载它。
import { resolve } from "node:path";
import { build } from "esbuild";

const appDir = resolve(import.meta.dirname, "..");

export async function buildExtension(
	outfile = resolve(appDir, "dist", "extension.mjs"),
): Promise<string> {
	await build({
		entryPoints: [resolve(appDir, "src", "extension", "extension.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node26",
		external: ["@earendil-works/pi-coding-agent"],
		outfile,
		logLevel: "warning",
	});
	return outfile;
}

if (import.meta.main) {
	console.log(await buildExtension());
}
