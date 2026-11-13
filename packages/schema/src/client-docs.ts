/**
 * 契约源码里的注释：zod 在运行时不保留 JSDoc，TypeScript 的类型检查器保留。`z.output<typeof RunView>`
 * 解析出的对象类型的属性仍指向契约里写的属性（经过 pick、extend、展开也一样），注释随之可读。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ITEM, VALUE } from "./client-emit.js";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface DocRequest {
	roots: ReadonlyMap<string, string>;
	stopAt: ReadonlySet<string>;
}

export interface Docs {
	field(root: string, path: readonly string[]): string | undefined;
	routes: ReadonlyMap<string, string>;
	exports: ReadonlyMap<string, string>;
}

export function harvestDocs(request: DocRequest): Docs {
	const keys = [...request.roots.keys()];
	const entry = join(schemaDir, "__client_docs__.ts");
	const text = [
		'import type { z } from "zod";',
		'import type * as C from "./src/index.js";',
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
	const walk = (root: string, type: ts.Type, path: readonly string[]): void => {
		if (path.length > 24) return;
		if (type.isUnion()) {
			for (const member of type.types) walk(root, member, path);
			return;
		}
		if (checker.isArrayType(type)) {
			const [item] = checker.getTypeArguments(type as ts.TypeReference);
			if (item) walk(root, item, [...path, ITEM]);
			return;
		}
		if (!(type.flags & ts.TypeFlags.Object)) return;
		if (path.length > 0 && stopAt.has(type)) return;
		const index = type.getStringIndexType();
		if (index) walk(root, index, [...path, VALUE]);
		for (const property of type.getProperties()) {
			const at = [...path, property.name];
			const text = comment(property);
			if (text) fields.set(fieldKey(root, at), text);
			walk(root, checker.getTypeOfSymbol(property), at);
		}
	};
	for (const key of keys) walk(key, rootType(key), []);

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
	return { field: (root, path) => fields.get(fieldKey(root, path)), routes, exports };
}
