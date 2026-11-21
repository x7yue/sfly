// 路径里只是含有 apps/assistant 这几个字（legacy-apps/assistant）：不是 apps/assistant 目录，照样报。
// @hit
import { createAgentSession } from "@earendil-works/pi-coding-agent";

export const start = createAgentSession;
