// 切入点 A：控制面统一配置镜像，在 Welcome 里下发给所有 Agent（ADR 0012）。
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "./support/fake-agent.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("镜像配置", () => {
	let cp: TestControlPlane | undefined;
	const agents: FakeAgent[] = [];

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
		cp = undefined;
	});

	it("配置了镜像时 Welcome 带上 PyPI 镜像和 GitHub Release 镜像", async () => {
		cp = await startTestControlPlane({
			pypiMirror: "https://mirrors.ustc.edu.cn/pypi/simple",
			githubReleaseMirror: "https://mirrors.ustc.edu.cn/github-release",
		});
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-mirrors" });
		agents.push(agent);
		expect(agent.welcome).toMatchObject({
			pypiMirror: "https://mirrors.ustc.edu.cn/pypi/simple",
			githubReleaseMirror: "https://mirrors.ustc.edu.cn/github-release",
		});
	});

	it("Welcome 总是带上控制面的包索引地址（对外地址加 /simple/），不用配置，和镜像无关（#556）", async () => {
		cp = await startTestControlPlane();
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-index" });
		agents.push(agent);
		expect(agent.welcome.packageIndexUrl).toBe(`${cp.httpUrl}/simple/`);
	});

	it("Welcome 里的包索引地址直接回答 sfly-std 的项目页：200，带标记头（Agent 装依赖之前检查的就是这个，#556）", async () => {
		cp = await startTestControlPlane();
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-index-marker" });
		agents.push(agent);

		const res = await fetch(`${agent.welcome.packageIndexUrl}sfly-std/`, { redirect: "manual" });

		expect(res.status).toBe(200);
		expect(res.headers.get("x-sfly-package-index")).toBeTruthy();
	});

	it("包索引地址跟着配置的对外地址走（反向代理后面带路径前缀时也是）", async () => {
		cp = await startTestControlPlane({ publicHttpUrl: "https://sfly.example.com/base" });
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-index-proxied" });
		agents.push(agent);
		expect(agent.welcome.packageIndexUrl).toBe("https://sfly.example.com/base/simple/");
	});

	it("未配置镜像时两个字段为空", async () => {
		cp = await startTestControlPlane();
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-no-mirrors" });
		agents.push(agent);
		expect(agent.welcome).toMatchObject({ pypiMirror: "", githubReleaseMirror: "" });
	});
});
