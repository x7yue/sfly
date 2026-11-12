// 把 zod schema 导出为 JSON Schema、把 HTTP 契约导出为路由清单，写入 Python SDK 的包数据目录。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportedSchemas, httpContract, toJsonSchema } from "../src/index.js";
import { buildRouteManifest } from "../src/route-manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../../sdk/python/src/sfly/schemas");
mkdirSync(outDir, { recursive: true });

for (const [name, schema] of Object.entries(exportedSchemas)) {
	const file = join(outDir, `${name}.schema.json`);
	writeFileSync(file, `${JSON.stringify(toJsonSchema(schema), null, 2)}\n`);
	console.log(`wrote ${file}`);
}

const routesFile = join(outDir, "routes.json");
writeFileSync(routesFile, `${JSON.stringify(buildRouteManifest(httpContract), null, 2)}\n`);
console.log(`wrote ${routesFile}`);
