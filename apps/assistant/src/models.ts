import { existsSync, readFileSync } from "node:fs";

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
			// 不回显 `${}` 里的内容：写错的地方可能放着密钥本身。
			else
				refs.problems.push(
					`${where} 里有写成 \${...} 但不是合法变量名的引用（变量名只能有字母、数字、下划线；pi 会把它当成字面的文字）`,
				);
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
	} catch {
		// 不带解析器的报错：它会引用文件里的一段（可能是密钥）。
		refs.problems.push("不是合法的 JSON");
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

/** 模型端点：主机和端口（不带用户名密码、路径、参数），`tls` 是要不要握手（https）。 */
export interface ModelEndpoint {
	host: string;
	port: number;
	tls: boolean;
}

/**
 * 模型配得好不好（#548）：好了给出端点（提供方没有写 `baseUrl` 时是 null：用 pi 内置提供方的地址，助手服务不知道，也就不试连），
 * 不好时 `reason` 写明缺的是哪一项。**`reason` 里只有变量名和文件路径，没有任何值**：它会出现在 `/health`、就绪状态和页面上。
 */
export type ModelCheck =
	| { configured: true; endpoint: ModelEndpoint | null }
	| { configured: false; reason: string };

/** `SFLY_ASSISTANT_MODEL` 末尾可以带的思考强度（pi 的 `--model` 写法）。 */
const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** 一个 `baseUrl` 的主机和端口；不是 http(s) 地址时是 undefined。 */
function endpointOf(baseUrl: string): ModelEndpoint | undefined {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const tls = url.protocol === "https:";
	// `hostname` 里的 IPv6 地址带方括号：连接用的是不带括号的写法。
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (host === "") return undefined;
	return { host, port: url.port === "" ? (tls ? 443 : 80) : Number(url.port), tls };
}

/** 用文件里的哪个模型：`<提供方>/<模型>`（可以带思考强度），也认文件里唯一的、没有重名的模型 id。 */
function selectModel(
	providers: Record<string, unknown>,
	selection: string,
): { provider: Record<string, unknown>; model: Record<string, unknown> } | undefined {
	const wanted = selection.replace(THINKING_SUFFIX, "");
	const bare: Array<{ provider: Record<string, unknown>; model: Record<string, unknown> }> = [];
	for (const [providerId, provider] of Object.entries(providers)) {
		if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
		for (const model of provider.models) {
			if (!isRecord(model) || typeof model.id !== "string") continue;
			if (`${providerId}/${model.id}` === wanted) return { provider, model };
			if (model.id === wanted) bare.push({ provider, model });
		}
	}
	return bare.length === 1 ? bare[0] : undefined;
}

/**
 * 检查模型配置（#548）：模型文件在、能解析、写法认得出；`SFLY_ASSISTANT_MODEL` 选的模型在文件里；选中的提供方（和模型）
 * 引用的环境变量都有值。**不满足时不拒绝启动**：照常起，`/health` 报「模型没有配置」并写明缺什么，新的一轮在开始之前被 503 拒绝。
 * 每次调用都重新读文件（文件很小）：部署者修好了文件，不用重启助手服务（环境变量要重启才变）。
 *
 * 只看选中的提供方引用的变量：文件里别的提供方没有用到，它们的变量没有值不影响这个部署。
 */
export function checkModels(options: {
	modelsFile: string;
	model: string | undefined;
	env: NodeJS.ProcessEnv;
}): ModelCheck {
	const { modelsFile: path, model: selection, env } = options;
	if (!existsSync(path)) {
		return {
			configured: false,
			reason: `没有模型文件 ${path}（SFLY_ASSISTANT_MODELS）：挂上 pi 格式的 models.json`,
		};
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { configured: false, reason: `读不了模型文件 ${path}（SFLY_ASSISTANT_MODELS）` };
	}
	const refs = modelEnvRefs(text);
	if (refs.problems.length > 0) {
		return {
			configured: false,
			reason: `模型文件 ${path} 有认不出的写法：${refs.problems.join("；")}`,
		};
	}
	const parsed: unknown = JSON.parse(text);
	const providers = isRecord(parsed) && isRecord(parsed.providers) ? parsed.providers : undefined;
	if (providers === undefined) {
		return { configured: false, reason: `模型文件 ${path} 里没有 providers` };
	}
	if (selection === undefined) {
		return {
			configured: false,
			reason: "SFLY_ASSISTANT_MODEL 没有设置：写成 <提供方>/<模型>，和模型文件里的对上",
		};
	}
	const selected = selectModel(providers, selection);
	if (selected === undefined) {
		return {
			configured: false,
			reason: `SFLY_ASSISTANT_MODEL 选的模型不在模型文件 ${path} 里：要和文件里 providers 下的提供方、models 里的 id 对上`,
		};
	}
	const missing = modelEnvRefs(JSON.stringify({ ...selected.provider, models: [selected.model] }))
		.names.filter((name) => !env[name])
		.map((name) => `模型文件引用了环境变量 ${name}，助手服务的环境里没有值`);
	if (missing.length > 0) {
		return { configured: false, reason: missing.join("；") };
	}
	const baseUrl = selected.model.baseUrl ?? selected.provider.baseUrl;
	if (baseUrl === undefined) return { configured: true, endpoint: null };
	const endpoint = typeof baseUrl === "string" ? endpointOf(baseUrl) : undefined;
	if (endpoint === undefined) {
		return {
			configured: false,
			reason: `模型文件 ${path} 里选中的模型的 baseUrl 不是 http 或 https 地址`,
		};
	}
	return { configured: true, endpoint };
}
