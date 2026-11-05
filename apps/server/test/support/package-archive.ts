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

/**
 * 按 `sfly build` 的格式打包：zip 内含 sfly-package.json 和一个 wheel。
 * 文件时间固定，同样的内容总是得到同样的字节（sha256 稳定，前端视觉回归依赖这一点）。
 */
export function packageArchive(
	metadata: unknown = packageMetadata(),
	files: Record<string, Uint8Array> = {
		"demo_checks-1.2.0-py3-none-any.whl": strToU8("fake wheel"),
	},
): Uint8Array {
	return zipSync(
		{ "sfly-package.json": strToU8(JSON.stringify(metadata)), ...files },
		{ mtime: new Date("2026-01-01T00:00:00Z") },
	);
}

export function publishInit(archive: Uint8Array): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		// zipSync 返回的 Uint8Array 总是基于 ArrayBuffer；DOM 的 BodyInit 类型要求写明。
		body: archive as Uint8Array<ArrayBuffer>,
	};
}

/** 节点类型的输入 schema（JSON Schema，type=object）。 */
export type InputsSchema = {
	properties: Record<string, Record<string, unknown>>;
	required?: string[];
};

/**
 * 发布一个只有元信息的节点包：nodes 是节点类型名 → 声明的输出键（输入不限），
 * 或 `{ outputs, inputs }`（inputs 是输入 schema，派发前按它校验已解析的输入）。
 * 触发运行前的预检要求编排锁定的包版本已经发布、引用的输出键已经声明。
 */
export async function publishPackage(
	cp: { fetch(path: string, init?: RequestInit): Promise<Response> },
	name: string,
	version: string,
	nodes: Record<string, readonly string[] | { outputs: readonly string[]; inputs: InputsSchema }>,
): Promise<void> {
	const archive = packageArchive(
		packageMetadata({
			name,
			version,
			nodes: Object.entries(nodes).map(([node, spec]) => {
				const outputs = "outputs" in spec ? spec.outputs : spec;
				const inputs = "inputs" in spec ? spec.inputs : { properties: {} };
				return {
					name: node,
					title: node,
					entry: `${name.replace(/-/g, "_")}.nodes:${node}`,
					inputs: { type: "object", ...inputs },
					outputs: { type: "object", properties: Object.fromEntries(outputs.map((k) => [k, {}])) },
				};
			}),
		}),
		{ [`${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`]: strToU8("wheel") },
	);
	const res = await cp.fetch("/packages", publishInit(archive));
	if (res.status !== 201) throw new Error(`publish ${name}@${version}: ${await res.text()}`);
}
