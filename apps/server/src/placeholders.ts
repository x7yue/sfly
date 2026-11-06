/**
 * 占位符：控制面返回的文本模板（用户文档 ADR 0013、install.sh ADR 0011）里用 `{{名称}}`（允许两侧空格）
 * 表示返回时才知道的值。每种模板登记自己可用的名称；读取模板时检查（出现未登记的名称时控制面启动失败，
 * 拼错的占位符不会原样漏给用户），返回时替换。
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export interface Placeholders<N extends string> {
	/** 检查模板里的占位符都已登记；`where` 用在错误信息里（例如文件名）。 */
	check(where: string, template: string): void;
	/** 把占位符替换成取值（经过 `quote`）。 */
	render(template: string, values: Record<N, string>): string;
}

/** 登记一组占位符名称；`quote` 把取值转成模板所在语境的写法（默认原样）。 */
export function placeholders<N extends string>(
	names: readonly N[],
	quote: (value: string) => string = (value) => value,
): Placeholders<N> {
	const known: ReadonlySet<string> = new Set(names);
	return {
		check(where, template) {
			for (const [, name] of template.matchAll(PLACEHOLDER)) {
				if (!(name && known.has(name))) {
					throw new Error(`${where}: 未知的占位符 {{${name}}}（可用：${names.join("、")}）`);
				}
			}
		},
		render(template, values) {
			return template.replace(PLACEHOLDER, (_, name: N) => quote(values[name]));
		},
	};
}
