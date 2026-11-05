import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { strToU8, zipSync } from "fflate";

/** 本地 PyPI 镜像桩（PEP 503 simple index），随机端口，不访问外网。 */
export interface PypiStub {
	/** 传给 Agent 的 `--index-url`。 */
	readonly indexUrl: string;
	/** 收到的请求路径（按到达顺序）。 */
	readonly requests: string[];
	close(): Promise<void>;
}

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** 启动镜像，`wheels` 是镜像里的全部 wheel：[项目名, 文件名, 内容]。 */
export async function startPypiStub(
	wheels: Array<[project: string, filename: string, body: Uint8Array]>,
): Promise<PypiStub> {
	const files = new Map(wheels.map(([, filename, body]) => [`/files/${filename}`, body]));
	const pages = new Map<string, string>();
	for (const [project, filename] of wheels) {
		const path = `/simple/${normalize(project)}/`;
		pages.set(path, `${pages.get(path) ?? ""}<a href="/files/${filename}">${filename}</a><br/>\n`);
	}
	const requests: string[] = [];
	const server = createServer((req, res) => {
		const path = (req.url ?? "/").split(/[?#]/)[0] ?? "/";
		requests.push(path);
		const page = pages.get(path);
		const file = files.get(path);
		if (page !== undefined) {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(`<!DOCTYPE html><html><body>\n${page}</body></html>\n`);
		} else if (file) {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end(file);
		} else {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		indexUrl: `http://127.0.0.1:${port}/simple/`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** 只含一个空模块的纯 Python wheel（第三方依赖的桩）：[项目名, 文件名, 内容]。 */
export function dependencyWheel(
	name: string,
	version: string,
): [project: string, filename: string, body: Uint8Array] {
	const dist = name.replace(/-/g, "_");
	const info = `${dist}-${version}.dist-info`;
	const entries: Record<string, string> = {
		[`${dist}/__init__.py`]: `VERSION = ${JSON.stringify(version)}\n`,
		[`${info}/METADATA`]: `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`,
		[`${info}/WHEEL`]:
			"Wheel-Version: 1.0\nGenerator: sfly-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
	};
	const record = `${[...Object.keys(entries), `${info}/RECORD`].map((p) => `${p},,`).join("\n")}\n`;
	entries[`${info}/RECORD`] = record;
	const zip = zipSync(Object.fromEntries(Object.entries(entries).map(([p, c]) => [p, strToU8(c)])));
	return [name, `${dist}-${version}-py3-none-any.whl`, zip];
}
