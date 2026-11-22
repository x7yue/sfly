// 路径里有 apps/assistant，但它在 apps/server 里面：不是仓库根上的 apps/assistant，不是例外，照样报。
// @hit
import { createAgentSession } from "@earendil-works/pi-coding-agent";

export const start = createAgentSession;
