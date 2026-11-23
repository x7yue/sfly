import { existsSync, readFileSync } from "node:fs";
import { ConfigError } from "./config.js";

/**
 * 模型文件（pi 的 `models.json`）里引用的环境变量。pi 解析 `apiKey`、`headers` 的值时照它自己的模板规则
 * （`resolve-config-value`）：`$NAME`、`${NAME}` 换成环境变量的值，可以夹在别的文字里（`"Bearer $KEY"`）；`$$`、`$!`
 * 是字面的 `$`、`!`。助手服务只把这些引用到的变量交给 pi（别的环境都不给），所以照同一条规则找出来。
 *
 * 认不出、不支持的写法在启动时报出来，不等到一轮失败：
 * - 以 `!` 开头的值是 pi 要执行的命令：命令在 pi 的环境里跑，而这个环境只有上面那几项，助手服务不支持；
 * - `${...}` 里不是合法的变量名：pi 会把它当成字面的文字，多半是写错了。
 */
export interface ModelEnvRefs {
	/** 引用到的变量名，排好序。 */
	names: string[];
	/** 认不出、不支持的写法（每条一句话）。 */
	problems: string[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

/** 一个值里引用的变量（照 pi 的模板规则）；认不出的写法记进 `problems`。 */
function templateRefs(value: string, where: string, refs: ModelEnvRefs): void {
	if (value.startsWith("!")) {
		refs.problems.push(
			`${where} 是要执行的命令（以 ! 开头），助手服务不支持：改成 "$变量名" 引用环境变量`,
		);
		return;
	}
	for (let i = value.indexOf("$"); i !== -1; i = value.indexOf("$", i + 1)) {
		const next = value[i + 1];
		if (next === "$" || next === "!") {
			i += 1;
			continue;
		}
		if (next === "{") {
			const end = value.indexOf("}", i + 2);
			if (end < 0) continue;
			const name = value.slice(i + 2, end);
			if (NAME.test(name)) refs.names.push(name);
			else
				refs.problems.push(`${where} 里的 \${${name}} 不是合法的变量名（pi 会把它当成字面的文字）`);
			i = end;
			continue;
		}
		const match = NAME_PREFIX.exec(value.slice(i + 1));
		if (match) {
			refs.names.push(match[0]);
			i += match[0].length;
		}
	}
}

/** 模型文件里 `apiKey`、`headers` 的值引用的环境变量（提供方和模型两层都看）。 */
export function modelEnvRefs(modelsJson: string): ModelEnvRefs {
	const refs: ModelEnvRefs = { names: [], problems: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(modelsJson);
	} catch (error) {
		refs.problems.push(
			`不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
		);
		return refs;
	}
	const walk = (value: unknown, path: string) => {
		if (Array.isArray(value)) {
			for (const [i, item] of value.entries()) walk(item, `${path}[${i}]`);
			return;
		}
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(value)) {
			const where = `${path}.${key}`;
			if (key === "apiKey" && typeof item === "string") templateRefs(item, where, refs);
			else if (key === "headers" && item && typeof item === "object" && !Array.isArray(item)) {
				for (const [header, v] of Object.entries(item)) {
					if (typeof v === "string") templateRefs(v, `${where}.${header}`, refs);
				}
			} else walk(item, where);
		}
	};
	walk(parsed, "");
	refs.names = [...new Set(refs.names)].sort();
	return refs;
}

/**
 * 启动时检查模型文件：没有这个文件、写法认不出时抛 {@link ConfigError}（拒绝启动，不等到先回 202 再失败）；
 * 引用的变量在助手服务的环境里没有时返回提醒（pi 用到这个提供方时会失败，结局是模型不可用）。
 */
export function checkModelsFile(path: string, env: NodeJS.ProcessEnv): string[] {
	if (!existsSync(path)) {
		throw new ConfigError(
			`没有模型文件 ${path}（SFLY_ASSISTANT_MODELS）：挂上 pi 格式的 models.json`,
		);
	}
	const refs = modelEnvRefs(readFileSync(path, "utf8"));
	if (refs.problems.length > 0) {
		throw new ConfigError(`模型文件 ${path} 有认不出的写法：${refs.problems.join("；")}`);
	}
	return refs.names
		.filter((name) => !env[name])
		.map((name) => `模型文件引用了环境变量 ${name}，助手服务的环境里没有`);
}
