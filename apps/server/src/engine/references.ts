/**
 * 引用解析（docs/SEMANTICS.md §2）：派发前把节点输入里的 `${{ ... }}` 替换成实际值。
 *
 * - `${{ params.<name> }}`：本链的入口参数；
 * - `${{ nodes.<id>.outputs.<key> }}`：本链上排在前面的节点的输出；
 * - 整值引用（输入值恰好是一个引用）保持原类型；
 * - 内嵌引用只允许标量（字符串、数字、布尔、null），按字符串拼接；
 * - 对象和数组里的字符串同样解析。
 */

export interface ReferenceScope {
	/** 本链的入口参数（已填充默认值）。 */
	params: Record<string, unknown>;
	/** 本链上当前节点之前的节点 ID → 输出；只能引用这里面的节点。 */
	earlierOutputs: ReadonlyMap<string, Record<string, unknown>>;
	/**
	 * always 节点（§2.4）：前面的节点可能失败或被跳过，缺失的输出解析为 null 而不是报错。
	 * 前面的节点都要放进 earlierOutputs（没有输出的放空对象）。
	 */
	missingAsNull?: boolean;
}

export class InvalidReferenceError extends Error {}

const REFERENCE = /\$\{\{\s*(.*?)\s*\}\}/g;
const WHOLE_REFERENCE = /^\$\{\{\s*(.*?)\s*\}\}$/;
const PARAM_PATH = /^params\.([A-Za-z_][A-Za-z0-9_]*)$/;
const OUTPUT_PATH = /^nodes\.([^.\s]+)\.outputs\.([^.\s]+)$/;

function lookup(path: string, scope: ReferenceScope): unknown {
	const param = PARAM_PATH.exec(path);
	if (param) {
		const name = param[1] as string;
		if (!Object.hasOwn(scope.params, name)) {
			throw new InvalidReferenceError(
				`\${{ ${path} }}: params.${name} is not declared by the chain entry`,
			);
		}
		return scope.params[name];
	}
	const output = OUTPUT_PATH.exec(path);
	if (output) {
		const [, nodeId, key] = output as unknown as [string, string, string];
		const outputs = scope.earlierOutputs.get(nodeId);
		if (!outputs) {
			throw new InvalidReferenceError(
				`\${{ ${path} }}: nodes.${nodeId} is not an earlier node on this chain`,
			);
		}
		if (!Object.hasOwn(outputs, key)) {
			if (scope.missingAsNull) return null;
			throw new InvalidReferenceError(
				`\${{ ${path} }}: output '${key}' of nodes.${nodeId} is missing`,
			);
		}
		return outputs[key];
	}
	throw new InvalidReferenceError(
		`\${{ ${path} }}: invalid reference, expected params.<name> or nodes.<id>.outputs.<key>`,
	);
}

function resolveString(value: string, scope: ReferenceScope): unknown {
	const whole = WHOLE_REFERENCE.exec(value);
	if (whole && !whole[1]?.includes("}}")) return lookup(whole[1] as string, scope);
	return value.replace(REFERENCE, (_match, path: string) => {
		const resolved = lookup(path, scope);
		if (resolved !== null && typeof resolved === "object") {
			throw new InvalidReferenceError(
				`\${{ ${path} }}: embedded references must resolve to a scalar, got ${Array.isArray(resolved) ? "array" : "object"}`,
			);
		}
		return String(resolved);
	});
}

function resolveValue(value: unknown, scope: ReferenceScope): unknown {
	if (typeof value === "string") return resolveString(value, scope);
	if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, scope)]));
	}
	return value;
}

/** 解析一个节点的全部输入；引用无效时抛出 InvalidReferenceError（任务以 config_error 失败）。 */
export function resolveInputs(
	inputs: Record<string, unknown>,
	scope: ReferenceScope,
): Record<string, unknown> {
	return resolveValue(inputs, scope) as Record<string, unknown>;
}
