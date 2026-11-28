// 控制面里没有指名工作台的环境变量了（#549）：哪台 Agent 是工作台是项目上的一列，由项目管理员登记
// （`PUT /projects/:project/workbench`，test/project-workbench-http.test.ts）。骨架期间的 `SFLY_WORKBENCH_AGENT`
// （控制面读它、compose 和 .env.example 里传它）删干净：控制面的源码、部署的文件、评测环境和冒烟脚本里都不能再出现，
// 也不能留一个换了名字、实际还是环境变量的选项（`workbenchAgent`）。工作台容器自己的名字是它自己的变量 `SFLY_WORKBENCH_NAME`
// （`deploy/workbench/entrypoint.sh`），控制面不读。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "..");

/** 目录下的全部文件（递归，跳过 node_modules 和隐藏的目录，保留 `.env.example` 这样的隐藏文件）。 */
function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (name === "node_modules" || name === "__pycache__" || name === ".venv") return [];
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

const read = (path: string) => readFileSync(path, "utf8");
const relative = (path: string) => path.slice(root.length + 1);

describe("没有指名工作台的环境变量", () => {
	const scanned = [
		...files(join(root, "apps/server/src")),
		...files(join(root, "deploy")),
		...files(join(root, "evals/assistant/aeval")),
		...files(join(root, "scripts/release")),
	];

	it("控制面的源码、部署的文件（compose、.env.example、工作台入口）、评测环境和冒烟脚本里都没有 SFLY_WORKBENCH_AGENT", () => {
		expect(scanned.length).toBeGreaterThan(50);
		const hits = scanned.filter((path) => read(path).includes("SFLY_WORKBENCH_AGENT"));
		expect(hits.map(relative)).toEqual([]);
	});

	it("控制面的选项里也没有换了名字的同一个东西（workbenchAgent）：工作台只从库里取", () => {
		const hits = files(join(root, "apps/server/src")).filter((path) =>
			/\bworkbenchAgent\b/.test(read(path)),
		);
		// `projects.workbenchAgent` 是库里的那一列（schema.ts、project-workbench.ts、探测时读登记的工作台的 workbench-exposure.ts），不是选项。
		expect(hits.map(relative).sort()).toEqual([
			"apps/server/src/db/schema.ts",
			"apps/server/src/projects/project-workbench.ts",
			"apps/server/src/sessions/workbench-exposure.ts",
		]);
		for (const path of hits) {
			expect(read(path), relative(path)).not.toMatch(/options\.workbenchAgent|workbenchAgent\?:/);
		}
	});

	it("工作台容器的入口脚本读的是自己的名字变量 SFLY_WORKBENCH_NAME", () => {
		expect(read(join(root, "deploy/workbench/entrypoint.sh"))).toContain("SFLY_WORKBENCH_NAME");
		expect(read(join(root, "deploy/docker-compose.yml"))).toContain("SFLY_WORKBENCH_NAME");
	});
});
