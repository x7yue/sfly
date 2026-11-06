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

	it("未配置镜像时两个字段为空", async () => {
		cp = await startTestControlPlane();
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-no-mirrors" });
		agents.push(agent);
		expect(agent.welcome).toMatchObject({ pypiMirror: "", githubReleaseMirror: "" });
	});
});
