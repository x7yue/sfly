// `deploy/.env.example` 列的变量和 `deploy/docker-compose.yml` 的 `environment` 对得上（#650）。
//
// 用 compose 部署的人按 `.env.example` 在 `.env` 里写 `SFLY_TRUST_PROXY`，compose 的 `environment` 里没有它，写了传不进容器：
// 控制面放在反向代理后面时登录限速看到的来源地址一直是代理的，所有人共用一个来源（和 #577 修的「写了也不生效」同一类）。
// 这条守住这件事：`.env.example` 里列的变量（写着的、注释掉当例子的都算），要么是 compose 的 `environment` 里的一项（传进容器），
// 要么是 compose 自己用的（镜像标签、宿主机端口的映射：控制面看不到），要么在下面一张写明理由的例外清单里；反过来，传进容器的每个
// 变量也要在 `.env.example` 里有一处说明（不然部署的人不知道有它）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const deployDir = join(import.meta.dirname, "..", "..", "..", "deploy");
const composeText = readFileSync(join(deployDir, "docker-compose.yml"), "utf8");
const envExampleText = readFileSync(join(deployDir, ".env.example"), "utf8");

/** `.env.example` 里列的变量名：`NAME=…` 和注释掉的例子 `# NAME=…` 都算。 */
const listedInEnvExample = (): Set<string> =>
	new Set(
		[...envExampleText.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string),
	);

/**
 * compose 里每个服务的 `environment` 取自 `.env` 的变量名（缩进 6 个空格的 `NAME: 值`，值里的 `${变量…}`）。
 * 控制面和 assistant profile 里的助手、工作台（#549）都算：写在 `.env` 里要传得进它们。
 * 值是固定写死的项（`SFLY_WORKBENCH_URL: http://sfly:8080`）不取自 `.env`，不算。
 */
const composeEnvironment = (): Set<string> => {
	const names = new Set<string>();
	for (const line of composeText.split("\n")) {
		const item = /^ {6}[A-Z][A-Z0-9_]*:\s*(.*)$/.exec(line);
		if (!item) continue;
		for (const match of (item[1] as string).matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}?-]/g))
			names.add(match[1] as string);
	}
	return names;
};

/** compose 自己用到的变量（`${NAME…}` 出现在镜像标签、端口映射里），不传进容器。 */
const usedByComposeItself = (): Set<string> => {
	const lines = composeText.split("\n");
	const names = new Set<string>();
	for (const line of lines) {
		if (/^ {6}[A-Z]/.test(line)) continue; // environment 里的项：传进容器的，另算
		for (const match of line.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}?-]/g))
			names.add(match[1] as string);
	}
	return names;
};

/**
 * `.env.example` 里列了、但不传进容器的变量，和理由。新加一条要写明理由（compose 自己用的不用写在这里，下面单独认）。
 * 现在没有：`.env.example` 里列的、控制面会读的变量都传进了容器。
 */
const NOT_PASSED: Readonly<Record<string, string>> = {};

describe("deploy/.env.example 和 deploy/docker-compose.yml 的环境变量", () => {
	it("能读出东西来（解析没有悄悄失效）", () => {
		expect(listedInEnvExample().size).toBeGreaterThan(10);
		expect(composeEnvironment().size).toBeGreaterThan(10);
		expect(usedByComposeItself()).toEqual(
			new Set(["SFLY_VERSION", "SFLY_HTTP_PORT", "SFLY_GRPC_PORT", "SFLY_ASSISTANT_MODELS_FILE"]),
		);
	});

	it(".env.example 里列的每个变量：传进容器了，或者是 compose 自己用的，或者在写明理由的例外清单里", () => {
		const passed = composeEnvironment();
		const own = usedByComposeItself();
		const missing = [...listedInEnvExample()].filter(
			(name) => !passed.has(name) && !own.has(name) && !(name in NOT_PASSED),
		);

		expect(
			missing,
			`${missing.join("、")}：.env.example 里列了，但 docker-compose.yml 的 environment 里没有，写在 .env 里传不进容器`,
		).toEqual([]);
	});

	it("例外清单里的变量都真的在 .env.example 里、而且确实没有传进容器（清单不留过期的条目）", () => {
		const listed = listedInEnvExample();
		const passed = composeEnvironment();
		for (const [name, reason] of Object.entries(NOT_PASSED)) {
			expect(reason.length, name).toBeGreaterThan(5);
			expect(listed.has(name), `${name} 不在 .env.example 里`).toBe(true);
			expect(passed.has(name), `${name} 已经传进容器了，从例外清单里去掉`).toBe(false);
		}
	});

	it("传进容器的每个变量，.env.example 里都有一处说明", () => {
		const listed = listedInEnvExample();
		const undocumented = [...composeEnvironment()].filter((name) => !listed.has(name));

		expect(
			undocumented,
			`${undocumented.join("、")}：传进了容器，但 .env.example 里没有写（部署的人不知道有它）`,
		).toEqual([]);
	});

	it("SFLY_TRUST_PROXY 和 SFLY_PUBLIC_GRPC_URL 传进容器（#650 的现象）", () => {
		const passed = composeEnvironment();

		expect(passed.has("SFLY_TRUST_PROXY")).toBe(true);
		expect(passed.has("SFLY_PUBLIC_GRPC_URL")).toBe(true);
	});

	it("传进容器时值留空等于没设置：写法是 ${NAME:-}（不是必填，也不是别的默认值）", () => {
		for (const name of ["SFLY_TRUST_PROXY", "SFLY_PUBLIC_GRPC_URL"]) {
			expect(composeText, name).toMatch(new RegExp(`^ {6}${name}: \\$\\{${name}:-\\}\\s*$`, "m"));
		}
	});
});
