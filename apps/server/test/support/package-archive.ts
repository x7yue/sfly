import { strToU8, zipSync } from "fflate";

/** 一份合法的节点包元信息（sfly-package.json），可以覆盖任意字段。 */
export function packageMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "demo-checks",
		version: "1.2.0",
		requires_python: ">=3.10",
		nodes: [
			{
				name: "http_check",
				title: "HTTP 检查",
				entry: "demo_checks.http:http_check",
				inputs: {
					type: "object",
					properties: {
						url: { type: "string" },
						expect: { type: "integer", default: 200 },
					},
					required: ["url"],
				},
				outputs: { type: "object", properties: { status: { type: "integer" } } },
			},
			{
				name: "ping",
				title: "ping",
				entry: "demo_checks.http:ping_host",
				inputs: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
				outputs: { type: "object", properties: { alive: {} } },
			},
		],
		...overrides,
	};
}

/** 按 `sfly build` 的格式打包：zip 内含 sfly-package.json 和一个 wheel。 */
export function packageArchive(
	metadata: unknown = packageMetadata(),
	files: Record<string, Uint8Array> = {
		"demo_checks-1.2.0-py3-none-any.whl": strToU8("fake wheel"),
	},
): Uint8Array {
	return zipSync({ "sfly-package.json": strToU8(JSON.stringify(metadata)), ...files });
}

export function publishInit(archive: Uint8Array): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: archive,
	};
}
