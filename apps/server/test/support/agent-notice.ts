import { agentUnavailableReason } from "./agent-binary.js";

/** vitest 的 globalSetup：用不了 Agent 时，在整轮测试结束后打一行提示，告诉开发者被跳过的文件怎么运行。 */
export default function setup() {
	const reason = agentUnavailableReason();
	if (reason) {
		return () =>
			console.warn(
				`\n${reason}。依赖 Agent 的测试文件已跳过，要运行它们：pnpm linux pnpm --filter @sfly/server test\n`,
			);
	}
}
