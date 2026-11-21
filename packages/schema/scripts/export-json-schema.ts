import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientExport } from "../src/client-export.js";
import { DECLARATION_RULES } from "../src/http/declarations.js";
import * as contract from "../src/index.js";
import { harvestRouteDocs } from "../src/route-docs.js";
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
// 已移除的节点种类（ADR 0028）：命令行读这一份，不再手写第二份清单。
write(
	join(sdkDir, "removed-node-kinds.json"),
	`${JSON.stringify(contract.REMOVED_NODE_KINDS, null, 2)}\n`,
);
// 已移除的场景文档顶层字段（便签 sticky_notes，ADR 0028）：命令行本地检查读这一份，不再手写第二份。
write(
	join(sdkDir, "removed-document-fields.json"),
	`${JSON.stringify(contract.REMOVED_DOCUMENT_FIELDS, null, 2)}\n`,
);
write(
	join(sdkDir, "routes.json"),
	`${JSON.stringify(
		buildRouteManifest(
			contract.httpContract,
			DECLARATION_RULES,
			harvestRouteDocs(contract.httpApis),
		),
		null,
		2,
	)}\n`,
);

const clientDir = join(here, "../../client");
for (const [file, text] of Object.entries(buildClientExport(contract.httpApis, contract))) {
	write(join(clientDir, file), text);
}
