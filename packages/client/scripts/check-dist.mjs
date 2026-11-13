import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const problems = [];

for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
	if (Object.keys(pkg[field] ?? {}).length > 0) problems.push(`package.json 声明了 ${field}`);
}
for (const entry of ["index.js", "index.d.ts"]) {
	if (!existsSync(join(dist, entry))) problems.push(`dist 里没有 ${entry}`);
}
const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
for (const file of readdirSync(dist, { recursive: true })) {
	if (!/\.(js|d\.ts)$/.test(file)) continue;
	for (const [, spec] of readFileSync(join(dist, file), "utf8").matchAll(specifier)) {
		if (!/^\.\.?\//.test(spec)) problems.push(`${file} 导入了 ${spec}`);
		else if (!spec.endsWith(".js")) problems.push(`${file} 的相对导入 ${spec} 没有 .js 扩展名`);
	}
}

if (problems.length > 0) {
	console.error(`@sfly/client 的发布物不符合要求：\n${problems.map((p) => `- ${p}`).join("\n")}`);
	process.exit(1);
}
