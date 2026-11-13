import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const destination = process.argv[2];
if (!destination) {
	console.error("用法：pnpm --filter @sfly/client run tarball <输出目录>");
	process.exit(2);
}
const root = join(import.meta.dirname, "..");
const pnpm = (...args) =>
	execFileSync("pnpm", args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });

mkdirSync(destination, { recursive: true });
pnpm("build");
pnpm("pack", "--pack-destination", resolve(destination));
