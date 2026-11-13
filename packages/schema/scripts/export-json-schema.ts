import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientExport } from "../src/client-export.js";
import * as contract from "../src/index.js";
import { buildRouteManifest } from "../src/route-manifest.js";

const here = dirname(fileURLToPath(import.meta.url));

const write = (file: string, text: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	console.log(`wrote ${file}`);
};

const sdkDir = join(here, "../../../sdk/python/src/sfly/schemas");
for (const [name, schema] of Object.entries(contract.exportedSchemas)) {
	write(
		join(sdkDir, `${name}.schema.json`),
		`${JSON.stringify(contract.toJsonSchema(schema), null, 2)}\n`,
	);
}
write(
	join(sdkDir, "routes.json"),
	`${JSON.stringify(buildRouteManifest(contract.httpContract), null, 2)}\n`,
);

const clientDir = join(here, "../../client");
for (const [file, text] of Object.entries(buildClientExport(contract.httpApis, contract))) {
	write(join(clientDir, file), text);
}
