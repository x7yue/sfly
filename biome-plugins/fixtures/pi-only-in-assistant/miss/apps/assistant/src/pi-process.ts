// 助手服务（apps/assistant）是唯一可以依赖 pi 的代码：同样的写法在这里不报。
import type { AgentEvent } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-ai";
import { createAgentSession } from "@earendil-works/pi-coding-agent";

export { createAgentSession as start } from "@earendil-works/pi-coding-agent";
export * from "@earendil-works/pi-ai";

const lazy = await import("@earendil-works/pi-coding-agent");
const legacy = require("@earendil-works/pi-coding-agent");
type Session = import("@earendil-works/pi-coding-agent").AgentSession;

console.log(pi, createAgentSession, lazy, legacy);
export type { AgentEvent, Session };

type PiModule = typeof import("@earendil-works/pi-coding-agent");
type Wrapped = import(
	"@earendil-works/pi-coding-agent"
).AgentSession;
export type { PiModule, Wrapped };

import { createRequire } from "node:module";
const viaCreateRequire = createRequire(import.meta.url)("@earendil-works/pi-coding-agent");
const resolved = require.resolve("@earendil-works/pi-ai");
const viaModule = module.require("@earendil-works/pi-ai");
const metaResolved = import.meta.resolve("@earendil-works/pi-ai");
import legacy = require("@earendil-works/pi-ai");
console.log(viaCreateRequire, resolved, viaModule, metaResolved, legacy);
