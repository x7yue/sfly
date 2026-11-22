// 控制面里引用 pi：各种引入写法都要报。要命中的那一行是模块来源所在的那一行（多行的 import 是 `} from "…"` 那一行）。
// @hit
import { createAgentSession } from "@earendil-works/pi-coding-agent";
// @hit
import type { AgentEvent } from "@earendil-works/pi-ai";
// @hit
import * as pi from "@earendil-works/pi-ai";
// @hit
import defaultPi from "@earendil-works/pi-ai";
// @hit
import "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	registerTool,
	// @hit
} from "@earendil-works/pi-coding-agent";

// @hit
export { createAgentSession as start } from "@earendil-works/pi-coding-agent";
// @hit
export * from "@earendil-works/pi-ai";
// @hit
export * as piTypes from "@earendil-works/pi-ai";
// @hit
export type { AgentEvent as PiEvent } from "@earendil-works/pi-ai";

// @hit
const lazy = await import("@earendil-works/pi-coding-agent");
// @hit
const legacy = require("@earendil-works/pi-coding-agent");
// @hit
const quoted = require('@earendil-works/pi-coding-agent');
// @hit
type Session = import("@earendil-works/pi-coding-agent").AgentSession;
// @hit
type PiModule = typeof import("@earendil-works/pi-coding-agent");
// @hit
type PiEntry = typeof import("@earendil-works/pi-coding-agent").createAgentSession;
// 类型里的 import() 跨行写也要报：命中的行是 `import(` 所在的那一行。
// @hit
type Wrapped = import(
	"@earendil-works/pi-coding-agent"
).AgentSession;
// @hit
type WrappedGeneric = import(
	"@earendil-works/pi-ai"
).Message<
	string
>;

console.log(createAgentSession, pi, defaultPi, registerTool, lazy, legacy, quoted);
export type { ExtensionAPI, PiEntry, PiModule, Session, Wrapped, WrappedGeneric };
