// 引入 pi 的其他写法：都要报。
import { createRequire } from "node:module";

// @hit
const viaCreateRequire = createRequire(import.meta.url)("@earendil-works/pi-coding-agent");
// @hit
const resolved = require.resolve("@earendil-works/pi-ai");
// @hit
const viaModule = module.require("@earendil-works/pi-ai");
// @hit
const metaResolved = import.meta.resolve("@earendil-works/pi-ai");
// @hit
import legacy = require("@earendil-works/pi-ai");

console.log(viaCreateRequire, resolved, viaModule, metaResolved, legacy);
