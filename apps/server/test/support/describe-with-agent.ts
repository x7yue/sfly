import { describe } from "vitest";
import { agentUnavailableReason } from "./agent-binary.js";

/** 依赖真实 Agent 的测试文件用它代替 `describe`：这台机器上用不了 Agent 时整组跳过（原因见 `agentUnavailableReason`）。 */
export const describeWithAgent = describe.skipIf(agentUnavailableReason() !== undefined);
