// 节点把一个 secret 值写出来时常见的写法（#479）：测试里让假节点把每个 secret 值用这些写法写进日志、进度、动作、输出和错误，
// 看每个出口有没有认出来。故意不用控制面里的打码代码（apps/server/src/logs/secrets.ts）算这些写法，免得测试和实现一起错。
// 值都是明显的假值。

/** Python 的 `json.dumps` 默认写法：`", "`、`": "` 分隔；`ensureAscii` 时非 ASCII 和 DEL 写成小写的 `\uXXXX`。 */
export function pythonJson(value: unknown, ensureAscii = true): string {
	const asAscii = (text: string) =>
		ensureAscii
			? text.replace(
					/[\u007f-\uffff]/g,
					(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
				)
			: text;
	const write = (v: unknown): string => {
		if (Array.isArray(v)) return `[${v.map(write).join(", ")}]`;
		if (v !== null && typeof v === "object") {
			return `{${Object.entries(v)
				.map(([k, item]) => `${asAscii(JSON.stringify(k))}: ${write(item)}`)
				.join(", ")}}`;
		}
		return typeof v === "string" ? asAscii(JSON.stringify(v)) : JSON.stringify(v);
	};
	return write(value);
}

/** Python 的 `repr` / `str` / `print`：单引号，`True`、`False`、`None`。 */
export function pythonRepr(value: unknown, sortKeys = false): string {
	const write = (v: unknown): string => {
		if (Array.isArray(v)) return `[${v.map(write).join(", ")}]`;
		if (v !== null && typeof v === "object") {
			const entries = Object.entries(v);
			if (sortKeys) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			return `{${entries.map(([k, item]) => `'${k}': ${write(item)}`).join(", ")}}`;
		}
		if (typeof v === "string") return `'${v}'`;
		if (v === null) return "None";
		if (typeof v === "boolean") return v ? "True" : "False";
		return String(v);
	};
	return write(value);
}

/** 值里的字符串叶子和数字叶子（数字写成文字）。 */
export function leavesOf(value: unknown): string[] {
	if (typeof value === "string") return value === "" ? [] : [value];
	if (typeof value === "number") return [String(value)];
	if (Array.isArray(value)) return value.flatMap(leavesOf);
	if (value !== null && typeof value === "object") return Object.values(value).flatMap(leavesOf);
	return [];
}

/**
 * 一个 secret 值在节点里可能的写法（每项是一段文字，可能带换行）：原样、`str()`/`print`、JSON 的几种写法、
 * Python `json.dumps` 默认（ASCII 转义和不转义）、缩进、排序、`repr`、`pprint`；对象和数组再加上每个叶子单独的写法。
 */
export function formsOf(value: unknown): string[] {
	const forms = new Set<string>();
	const add = (...texts: string[]) => {
		for (const text of texts) forms.add(text);
	};
	if (typeof value === "string") {
		add(
			value,
			JSON.stringify(value),
			JSON.stringify(value).slice(1, -1),
			pythonJson(value),
			pythonJson(value, false),
			pythonRepr(value),
		);
		// 多行的值日志是按行写的。
		for (const line of value.split(/\r?\n/)) if (line.trim() !== "") add(line.trim());
	} else if (typeof value === "number" || typeof value === "boolean") {
		add(String(value), JSON.stringify(value), pythonRepr(value));
	} else if (value !== null && typeof value === "object") {
		add(
			JSON.stringify(value),
			pythonJson(value),
			pythonJson(value, false),
			JSON.stringify(value, null, 2),
			JSON.stringify(sorted(value)),
			pythonRepr(value),
			pythonRepr(value, true),
			pythonJson(sorted(value)),
		);
		for (const leaf of leavesOf(value)) add(...formsOf(leaf));
	}
	return [...forms];
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, sorted(v)]),
		);
	}
	return value;
}

/** 一组 secret 值的全部写法（去重）。 */
export function allForms(values: Record<string, unknown>): string[] {
	return [...new Set(Object.values(values).flatMap(formsOf))];
}
