// 切入点 A：`sfly init` 从控制面读取写进新项目 pyproject.toml 的配置——控制面版本、sfly 简单索引地址，
// 以及控制面统一配置的镜像（ADR 0012：改一处对所有 Agent 和新项目生效）。
import { afterEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("新项目配置", () => {
	let cp: TestControlPlane | undefined;

	afterEach(async () => {
		await cp?.close();
		cp = undefined;
	});

	it("配置了镜像时给出 PyPI 镜像和 Python 下载镜像", async () => {
		cp = await startTestControlPlane({
			version: "1.2.3",
			publicHttpUrl: "http://sfly.internal:8080",
			pypiMirror: "https://mirrors.ustc.edu.cn/pypi/simple",
			githubReleaseMirror: "https://mirrors.ustc.edu.cn/github-release/",
		});
		const res = await cp.fetch("/sdk/project-settings");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			version: "1.2.3",
			sfly_index_url: "http://sfly.internal:8080/simple/",
			pypi_mirror: "https://mirrors.ustc.edu.cn/pypi/simple",
			python_install_mirror:
				"https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/",
		});
	});

	it("未配置镜像时两个镜像为 null", async () => {
		cp = await startTestControlPlane({ version: "1.2.3" });
		const res = await cp.fetch("/sdk/project-settings");
		expect(await res.json()).toEqual({
			version: "1.2.3",
			sfly_index_url: `${cp.httpUrl}/simple/`,
			pypi_mirror: null,
			python_install_mirror: null,
		});
	});
});
