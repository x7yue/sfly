// 控制面里不是 pi 的引入：不报。
import { SessionEvent } from "@sfly/schema";
import { other } from "@earendil-works-compat";
import { local } from "./pi/@earendil-works/local.js";
import { z } from "zod";

// 只是字符串，不是引入的来源：不报。
const name = "@earendil-works/pi-coding-agent";
const local2 = require("./local.js");
const lazy = await import("./lazy.js");
type Local = import("./types.js").Local;

console.log(SessionEvent, other, local, z, name, local2, lazy);
export type { Local };
