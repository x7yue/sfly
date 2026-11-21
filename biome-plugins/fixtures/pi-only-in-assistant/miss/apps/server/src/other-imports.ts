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

// 不是 pi 的模块：不报。
import { createRequire } from "node:module";
const local3 = createRequire(import.meta.url)("./local.js");
const resolvedLocal = require.resolve("./local.js");
const viaModule = module.require("./local.js");
const metaResolved = import.meta.resolve("./local.js");
import legacy = require("zod");
console.log(local3, resolvedLocal, viaModule, metaResolved, legacy);
