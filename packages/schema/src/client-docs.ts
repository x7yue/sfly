/**
 * 契约源码里的注释：zod 在运行时不保留 JSDoc，TypeScript 的类型检查器保留。`z.output<typeof RunView>`
 * 解析出的对象类型的属性仍指向契约里写的属性（经过 pick、extend、展开也一样），注释随之可读。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ITEM, memberSegment, VALUE } from "./client-emit.js";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface DocRequest {
	/** 契约模块（相对 packages/schema 的路径，要导出 `httpApis`）；默认是真正的契约，测试里换成一份小的。 */
	contract?: string;
	roots: ReadonlyMap<string, string>;
	stopAt: ReadonlySet<string>;
	/** 某个 root 最多读到第几层字段（路径长度）；不给就读到底。路由清单只要响应的顶层字段，不用把整份文档类型走一遍。 */
	maxDepth?: (root: string) => number | undefined;
}

export interface Docs {
	/**
	 * 某个 root 里一个字段的说明。`path` 里联合的内联对象成员多一段（`|` 开头，见 client-emit.ts 的 `memberSegment`）：
	 * 同名的字段在联合的不同成员里说明可以不同，各取各的。
	 */
	field(root: string, path: readonly string[]): string | undefined;
	/** 某个 root 里走过的联合成员的路径（`path.join(".")`）：生成的一边认出的成员要和它一致，见 client-export.ts。 */
	members(root: string): ReadonlySet<string>;
	routes: ReadonlyMap<string, string>;
	exports: ReadonlyMap<string, string>;
}

/**
 * 核对一个 root 里联合的成员：生成的一边（JSON Schema）和读注释的一边（TypeScript 的类型）各自认出的成员路径要一样。
 * 不一样时字段的说明会按错的路径查，悄悄丢掉或者挂错（比如一边把可选的字面量字段算作取值固定、另一边不算）。
 */
export function checkMembers(
	root: string,
	read: Iterable<string>,
	emitted: Iterable<string>,
): void {
	const a = [...new Set(read)].sort();
	const b = [...new Set(emitted)].sort();
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(
			`${root}：联合的成员，读到的注释和生成的类型认出的不一致（读注释：${a.join(" ")}；生成：${b.join(" ")}）`,
		);
	}
}

export function harvestDocs(request: DocRequest): Docs {
	const keys = [...request.roots.keys()];
	const entry = join(schemaDir, "__client_docs__.ts");
	const text = [
		'import type { z } from "zod";',
		`import type * as C from ${JSON.stringify(request.contract ?? "./src/index.js")};`,
		"export type Apis = typeof C.httpApis;",
		...keys.map((key, i) => `export type Root${i} = ${request.roots.get(key)};`),
	].join("\n");

	const config = ts.getParsedCommandLineOfConfigFile(join(schemaDir, "tsconfig.json"), undefined, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (d) => {
			throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
		},
	});
	if (!config) throw new Error("packages/schema/tsconfig.json 读取失败");
	const options = { ...config.options, noEmit: true };
	const host = ts.createCompilerHost(options);
	const getSourceFile = host.getSourceFile;
	host.getSourceFile = (fileName, language, ...rest) =>
		fileName === entry
			? ts.createSourceFile(fileName, text, language)
			: getSourceFile.call(host, fileName, language, ...rest);
	const fileExists = host.fileExists;
	host.fileExists = (fileName) => fileName === entry || fileExists.call(host, fileName);

	const program = ts.createProgram([entry], options, host);
	const source = program.getSourceFile(entry) as ts.SourceFile;
	const errors = ts.getPreEmitDiagnostics(program, source);
	if (errors.length > 0) {
		const message = ts.flattenDiagnosticMessageText(errors[0]?.messageText, "\n");
		throw new Error(`读取契约注释的入口没有通过类型检查：${message}`);
	}
	const checker = program.getTypeChecker();
	const aliases = new Map<string, ts.Type>();
	let contract: ts.Symbol | undefined;
	for (const statement of source.statements) {
		if (ts.isTypeAliasDeclaration(statement)) {
			aliases.set(statement.name.text, checker.getTypeFromTypeNode(statement.type));
		} else if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings) {
			if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
				contract = checker.getSymbolAtLocation(statement.moduleSpecifier);
			}
		}
	}
	const comment = (symbol: ts.Symbol) =>
		ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();

	const rootType = (key: string) => aliases.get(`Root${keys.indexOf(key)}`) as ts.Type;
	const stopAt = new Set([...request.stopAt].map(rootType));
	const fieldKey = (root: string, path: readonly string[]) => `${root}:${path.join(".")}`;
	const fields = new Map<string, string>();
	const members = new Map<string, Set<string>>(keys.map((key) => [key, new Set()]));
	/** 联合的一个成员里取值固定（字面量）的字段，`名=值`：可选的字段去掉 undefined 再看。 */
	const fixedFields = (type: ts.Type): string[] => {
		const fixed: string[] = [];
		for (const property of type.getProperties()) {
			let value = checker.getTypeOfSymbol(property);
			if (value.isUnion()) {
				const rest = value.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
				if (rest.length === 1) value = rest[0] as ts.Type;
			}
			if (value.isStringLiteral() || value.isNumberLiteral()) {
				fixed.push(`${property.name}=${JSON.stringify(value.value)}`);
			} else if (value.flags & ts.TypeFlags.BooleanLiteral) {
				fixed.push(`${property.name}=${checker.typeToString(value)}`);
			}
		}
		return fixed;
	};
	/** 联合里内联的对象成员（`$ref` 指向的、有自己的 root 的类型不算；数组、元组不算）。 */
	const isInlineObject = (type: ts.Type) =>
		(type.flags & ts.TypeFlags.Object) !== 0 &&
		!checker.isArrayType(type) &&
		!checker.isTupleType(type) &&
		!stopAt.has(type);
	/** `depth` 是字段的层数：联合成员的那一段不算一层（`maxDepth` 按字段数）。 */
	const walk = (root: string, type: ts.Type, path: readonly string[], depth: number): void => {
		if (depth > 24) return;
		const limit = request.maxDepth?.(root);
		if (limit !== undefined && depth >= limit) return;
		// 有自己的 root 的类型（生成的类型里是 `$ref`）：它的字段说明在它自己的 root 里，不在这里读（联合类型也一样）
		if (depth > 0 && stopAt.has(type)) return;
		if (type.isUnion()) {
			// 内联的对象成员不止一个才各多一段路径（和 client-emit.ts 的 `unionMembers` 一致）；有自己的 root 的成员不在这里读
			const several = type.types.filter(isInlineObject).length >= 2;
			for (const member of type.types) {
				if (stopAt.has(member)) continue;
				if (!several || !isInlineObject(member)) {
					walk(root, member, path, depth);
					continue;
				}
				const at = [...path, memberSegment(fixedFields(member))];
				(members.get(root) as Set<string>).add(at.join("."));
				walk(root, member, at, depth);
			}
			return;
		}
		if (checker.isArrayType(type)) {
			const [item] = checker.getTypeArguments(type as ts.TypeReference);
			if (item) walk(root, item, [...path, ITEM], depth + 1);
			return;
		}
		if (!(type.flags & ts.TypeFlags.Object)) return;
		const index = type.getStringIndexType();
		if (index) walk(root, index, [...path, VALUE], depth + 1);
		for (const property of type.getProperties()) {
			const at = [...path, property.name];
			const key = fieldKey(root, at);
			const text = comment(property);
			// 同一个位置读到两份不同的说明（联合里认不出的成员，或者不同成员的数组元素）：不选一个，生成失败，让契约里写清楚
			if (fields.has(key) && fields.get(key) !== text) {
				throw new Error(
					`${root} 的 ${at.join(".")}：联合的几个成员在同一个位置有不同的字段说明，生成的类型认不出是哪个成员的；给成员一个取值固定的字段（如 type: z.literal("…")）`,
				);
			}
			fields.set(key, text);
			walk(root, checker.getTypeOfSymbol(property), at, depth + 1);
		}
	};
	for (const key of keys) walk(key, rootType(key), [], 0);

	const routes = new Map<string, string>();
	for (const domain of (aliases.get("Apis") as ts.Type).getProperties()) {
		for (const route of checker.getTypeOfSymbol(domain).getProperties()) {
			const text = comment(route);
			if (text) routes.set(`${domain.name}.${route.name}`, text);
		}
	}

	const exports = new Map<string, string>();
	for (const symbol of contract ? checker.getExportsOfModule(contract) : []) {
		const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
		const text = comment(target);
		if (text) exports.set(symbol.name, text);
	}
	return {
		// 空说明不是说明：和没有一样
		field: (root, path) => fields.get(fieldKey(root, path)) || undefined,
		members: (root) => members.get(root) ?? new Set(),
		routes,
		exports,
	};
}
