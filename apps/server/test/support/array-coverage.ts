/**
 * 响应 JSON Schema 里的数组字段有没有被真实数据对照过：数组每次都是空的，它的元素 schema 就从来没有对过一份数据。
 *
 * 路径的写法：字段用 `.` 连，数组用 `[]`，对象当字典用的值用 `*`，例如 `agents[].queued_tasks[]`。
 * 几选一（anyOf、oneOf）的各个分支共用同一个路径。
 */
type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const join = (path: string, step: string) =>
	path === "" || step.startsWith("[") ? path + step : `${path}.${step}`;

function resolve(
	root: Schema,
	schema: Schema,
	trail: readonly string[],
): [Schema, readonly string[]] | undefined {
	const ref = schema.$ref;
	if (typeof ref !== "string" || !ref.startsWith("#")) return [schema, trail];
	if (trail.includes(ref)) return undefined;
	let node: unknown = root;
	for (const part of ref.slice(1).split("/")) {
		if (part) node = (node as Schema)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
	}
	return isSchema(node) ? [node, [...trail, ref]] : undefined;
}

/** 这个数据能不能是这个分支：只看对象、数组的外形，认不出的当作可以。 */
function mayMatch(schema: Schema, data: unknown): boolean {
	if (schema.type === "array" || isSchema(schema.items)) return Array.isArray(data);
	if (schema.type === "object" || isSchema(schema.properties)) return isSchema(data);
	return true;
}

function walk(
	root: Schema,
	schemaIn: Schema,
	data: unknown,
	path: string,
	trail: readonly string[],
	visit: (path: string, nonEmpty: boolean) => void,
): void {
	const resolved = resolve(root, schemaIn, trail);
	if (!resolved) return;
	const [schema, here] = resolved;
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			if (isSchema(branch) && (data === undefined || mayMatch(branch, data))) {
				walk(root, branch, data, path, here, visit);
			}
		}
	}
	if (schema.type === "array" || isSchema(schema.items)) {
		const at = join(path, "[]");
		const items = Array.isArray(data) ? data : undefined;
		visit(at, (items?.length ?? 0) > 0);
		if (isSchema(schema.items)) {
			if (items === undefined) walk(root, schema.items, undefined, at, here, visit);
			else for (const item of items) walk(root, schema.items, item, at, here, visit);
		}
	}
	const properties = isSchema(schema.properties) ? schema.properties : {};
	const object = isSchema(data) ? data : undefined;
	for (const [name, sub] of Object.entries(properties)) {
		if (!isSchema(sub)) continue;
		if (data === undefined) walk(root, sub, undefined, join(path, name), here, visit);
		else if (object && name in object) walk(root, sub, object[name], join(path, name), here, visit);
	}
	if (isSchema(schema.additionalProperties)) {
		const at = join(path, "*");
		if (data === undefined) walk(root, schema.additionalProperties, undefined, at, here, visit);
		else if (object) {
			for (const [name, value] of Object.entries(object)) {
				if (!(name in properties)) walk(root, schema.additionalProperties, value, at, here, visit);
			}
		}
	}
}

/** schema 里的全部数组字段的路径。 */
export function arrayPaths(schema: Schema): string[] {
	const found = new Set<string>();
	walk(schema, schema, undefined, "", [], (path) => found.add(path));
	return [...found];
}

/** 这份数据里哪些数组字段非空。 */
export function nonEmptyArrayPaths(schema: Schema, data: unknown): string[] {
	const found = new Set<string>();
	walk(schema, schema, data, "", [], (path, nonEmpty) => {
		if (nonEmpty) found.add(path);
	});
	return [...found];
}

/** 一组响应 schema 的数组字段覆盖：记下每次看到的非空数组，最后列出一次都没非空过的。 */
export class ArrayCoverage {
	readonly #schemas = new Map<string, Schema>();
	readonly #seen = new Set<string>();

	/** 登记一份 schema（`key` 是「方法 路径 response」或「方法 路径 事件名」）并记下这份数据里的非空数组。 */
	record(key: string, schema: Schema, data: unknown): void {
		this.#schemas.set(key, schema);
		for (const path of nonEmptyArrayPaths(schema, data)) this.#seen.add(`${key} ${path}`);
	}

	/** 登记过的 schema 里一次都没有非空过的数组字段，每条是「key 路径」。 */
	unseen(): string[] {
		const missing: string[] = [];
		for (const [key, schema] of this.#schemas) {
			for (const path of arrayPaths(schema)) {
				if (!this.#seen.has(`${key} ${path}`)) missing.push(`${key} ${path}`);
			}
		}
		return missing.sort();
	}
}
