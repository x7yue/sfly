// 模型文件：引用的环境变量照 pi 的模板规则找（只把这些交给 pi），认不出的写法报出来；启动时的检查（#548）不拒绝启动，
// 结果写明缺哪一项：只有变量名和文件路径，没有任何值。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkModels, modelEnvRefs } from "../src/models.js";

const models = (provider: Record<string, unknown>) =>
	JSON.stringify({ providers: { p: { baseUrl: "http://x/$NOT_A_REF", ...provider } } });

describe("模型文件引用的环境变量", () => {
	it("整串的 $NAME、${NAME}、夹在文字里的（Bearer $KEY），apiKey 和 headers 两处，提供方和模型两层", () => {
		const refs = modelEnvRefs(
			models({
				apiKey: "$KEY_A",
				headers: { Authorization: "Bearer $KEY_B", "X-Org": "${ORG}-x", "X-Lit": "$$LITERAL $!x" },
				models: [{ id: "m", headers: { "X-M": "${KEY_C}" } }],
			}),
		);
		expect(refs.names).toEqual(["KEY_A", "KEY_B", "KEY_C", "ORG"]);
		expect(refs.problems).toEqual([]);
		// 每一处引用带着它在文件里的位置。
		expect(refs.located).toEqual([
			{ name: "KEY_A", where: ".providers.p.apiKey" },
			{ name: "KEY_B", where: ".providers.p.headers.Authorization" },
			{ name: "ORG", where: ".providers.p.headers.X-Org" },
			{ name: "KEY_C", where: ".providers.p.models[0].headers.X-M" },
		]);
	});

	it("要执行的命令（! 开头）、${} 里不是变量名：认不出，报出来；说明里没有 ${} 里写的东西", () => {
		const refs = modelEnvRefs(
			models({ apiKey: "!cat /secret", headers: { X: "${sk-live-do-not-echo}" } }),
		);
		expect(refs.names).toEqual([]);
		expect(refs.problems).toHaveLength(2);
		expect(refs.problems[0]).toContain("要执行的命令");
		expect(refs.problems.join("\n")).not.toContain("do-not-echo");
	});

	it("不是 JSON：说明里没有文件里的内容（解析器的报错会引用一段）", () => {
		const refs = modelEnvRefs('{"apiKey": "sk-do-not-echo-me",');
		expect(refs.problems).toEqual(["不是合法的 JSON"]);
	});
});

describe("启动时检查模型配置（#548）：不满足时不拒绝，写明缺哪一项", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "sfly-models-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	/** 写一份模型文件，返回路径。 */
	const file = (name: string, content: string) => {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	};
	const provider = (extra: Record<string, unknown> = {}, model: Record<string, unknown> = {}) =>
		JSON.stringify({
			providers: {
				acme: {
					baseUrl: "https://llm.example.com:8443/v1/chat?key=do-not-echo",
					api: "openai-completions",
					apiKey: "$ACME_KEY",
					models: [{ id: "big", ...model }],
					...extra,
				},
			},
		});
	const check = (path: string, model: string | undefined, env: NodeJS.ProcessEnv = {}) =>
		checkModels({ modelsFile: path, model, env });

	it("都对：配好了，端点只有主机和端口（不带用户名密码、路径、参数）", () => {
		const path = file(
			"ok.json",
			provider({ baseUrl: "https://user:do-not-echo@llm.example.com:8443/v1?key=do-not-echo" }),
		);
		expect(check(path, "acme/big", { ACME_KEY: "k" })).toEqual({
			configured: true,
			endpoint: { host: "llm.example.com", port: 8443, tls: true },
		});
	});

	it("端口默认：http 80、https 443；IPv6 地址不带方括号；模型自己的 baseUrl 盖过提供方的", () => {
		const env = { ACME_KEY: "k" };
		expect(
			check(file("p80.json", provider({ baseUrl: "http://gw.internal/v1" })), "acme/big", env),
		).toEqual({ configured: true, endpoint: { host: "gw.internal", port: 80, tls: false } });
		expect(
			check(file("p443.json", provider({ baseUrl: "https://gw.internal/v1" })), "acme/big", env),
		).toEqual({ configured: true, endpoint: { host: "gw.internal", port: 443, tls: true } });
		expect(
			check(file("v6.json", provider({ baseUrl: "http://[::1]:9000/v1" })), "acme/big", env),
		).toEqual({ configured: true, endpoint: { host: "::1", port: 9000, tls: false } });
		expect(
			check(
				file("own.json", provider({}, { baseUrl: "http://own.internal:1234/v1" })),
				"acme/big",
				env,
			),
		).toEqual({ configured: true, endpoint: { host: "own.internal", port: 1234, tls: false } });
	});

	it("选的写法：带思考强度、只写模型 id（文件里没有重名时）；提供方没写 baseUrl 时不知道端点", () => {
		const env = { ACME_KEY: "k" };
		const path = file("sel.json", provider());
		expect(check(path, "acme/big:high", env)).toMatchObject({ configured: true });
		expect(check(path, "big", env)).toMatchObject({ configured: true });
		const builtin = file(
			"builtin.json",
			JSON.stringify({ providers: { acme: { apiKey: "$ACME_KEY", models: [{ id: "big" }] } } }),
		);
		expect(check(builtin, "acme/big", env)).toEqual({ configured: true, endpoint: null });
	});

	it("没有模型文件：写明文件路径", () => {
		const path = join(dir, "missing.json");
		expect(check(path, "acme/big")).toEqual({
			configured: false,
			reason: expect.stringContaining(path),
		});
	});

	it("文件读不了（是个目录）、不是 JSON、没有 providers、有不支持的写法：各说各的", () => {
		expect(check(dir, "acme/big")).toMatchObject({
			configured: false,
			reason: expect.stringContaining("读不了模型文件"),
		});
		const broken = check(file("broken.json", '{"apiKey": "sk-do-not-echo-me",'), "acme/big");
		expect(broken).toMatchObject({
			configured: false,
			reason: expect.stringContaining("不是合法的 JSON"),
		});
		expect(JSON.stringify(broken)).not.toContain("do-not-echo");
		expect(check(file("empty.json", "{}"), "acme/big")).toMatchObject({
			configured: false,
			reason: expect.stringContaining("没有 providers"),
		});
		const command = check(file("cmd.json", provider({ apiKey: "!cat /secret" })), "acme/big");
		expect(command).toMatchObject({
			configured: false,
			reason: expect.stringContaining("要执行的命令"),
		});
	});

	it("SFLY_ASSISTANT_MODEL 没设、选的模型不在文件里：写明变量名，不回显选的值", () => {
		const path = file("model.json", provider());
		const unset = check(path, undefined, { ACME_KEY: "k" });
		expect(unset).toMatchObject({
			configured: false,
			reason: expect.stringContaining("SFLY_ASSISTANT_MODEL 没有设置"),
		});
		const absent = check(path, "acme/not-there-do-not-echo", { ACME_KEY: "k" });
		expect(absent).toMatchObject({
			configured: false,
			reason: expect.stringContaining("SFLY_ASSISTANT_MODEL 选的模型不在模型文件"),
		});
		expect(JSON.stringify(absent)).not.toContain("do-not-echo");
		// 只写模型 id、文件里有两个提供方都有它：认不出是哪个。
		const twice = file(
			"twice.json",
			JSON.stringify({
				providers: {
					a: { baseUrl: "http://a/v1", models: [{ id: "same" }] },
					b: { baseUrl: "http://b/v1", models: [{ id: "same" }] },
				},
			}),
		);
		expect(check(twice, "same")).toMatchObject({ configured: false });
		expect(check(twice, "b/same")).toMatchObject({ configured: true });
	});

	it("引用的环境变量没有值（含空串）：只写变量名；只看选中的提供方，别的提供方的变量不管", () => {
		const path = file(
			"vars.json",
			JSON.stringify({
				providers: {
					acme: {
						baseUrl: "http://a/v1",
						apiKey: "$ACME_KEY",
						headers: { "X-Org": "${ACME_ORG}" },
						models: [{ id: "big", headers: { "X-M": "$ACME_MODEL_HEADER" } }],
					},
					other: { baseUrl: "http://o/v1", apiKey: "$OTHER_KEY", models: [{ id: "x" }] },
				},
			}),
		);
		const missing = check(path, "acme/big", { ACME_KEY: "", ACME_ORG: "org" });
		expect(missing).toEqual({
			configured: false,
			reason:
				"模型文件里 providers.acme.apiKey 引用了环境变量 ACME_KEY，助手服务的环境里没有值；模型文件里 providers.acme.models[0].headers.X-M 引用了环境变量 ACME_MODEL_HEADER，助手服务的环境里没有值",
		});
		expect(
			check(path, "acme/big", { ACME_KEY: "k", ACME_ORG: "o", ACME_MODEL_HEADER: "h" }),
		).toMatchObject({ configured: true });
		// 变量的值不出现在说明里。
		const withValue = check(path, "acme/big", { ACME_KEY: "sk-do-not-echo", ACME_ORG: "" });
		expect(JSON.stringify(withValue)).not.toContain("do-not-echo");
	});

	it.each([
		["${} 里是密钥（含小写字母，像变量名）", "${SECRET9abc}", "SECRET9abc"],
		["字面的密钥里夹着 $，后面像变量名", "k3y$SECRET6xyz", "SECRET6xyz"],
		["Bearer 后面跟着 $密钥", "Bearer $sk9LiveABC", "sk9LiveABC"],
		["名字太长（超过 64 个字符）", `$${"A".repeat(65)}`, "A".repeat(65)],
		["不是大写的变量名", "${my_key}", "my_key"],
	])("密钥误写在 $ 后面又长得像变量名：说明里不写这个名字，只写位置和提示（%s）", (_name, apiKey, leaked) => {
		const path = file("leaky.json", provider({ apiKey }));
		const result = check(path, "acme/big", { SECRET9abc: "" });
		expect(result).toMatchObject({
			configured: false,
			reason: expect.stringContaining("providers.acme.apiKey"),
		});
		const reason = result.configured ? "" : result.reason;
		expect(reason).toContain("是不是把密钥本身写进了 $ 后面");
		expect(JSON.stringify(result)).not.toContain(leaked);
	});

	it("请求头里的值同样：位置写 headers 的哪一项，不写名字", () => {
		const path = file("leaky-header.json", provider({ headers: { "X-Key": "${SECRET9abc}" } }));
		const result = check(path, "acme/big", { ACME_KEY: "k" });
		expect(result).toMatchObject({
			configured: false,
			reason: expect.stringContaining("providers.acme.headers.X-Key"),
		});
		expect(JSON.stringify(result)).not.toContain("SECRET9abc");
	});

	it("引用 SFLY_ASSISTANT_ 开头的变量：启动 pi 时不会交给它，说成没配置（环境里有值也一样），写明换个名字", () => {
		const path = file("reserved.json", provider({ apiKey: "$SFLY_ASSISTANT_SECRET" }));
		const result = check(path, "acme/big", {
			SFLY_ASSISTANT_SECRET: "the-shared-secret-value-0123456789abcdef",
		});
		expect(result).toEqual({
			configured: false,
			reason:
				"模型文件里 providers.acme.apiKey 引用了环境变量 SFLY_ASSISTANT_SECRET：SFLY_ASSISTANT_ 开头的是助手服务自己的配置，不会交给 pi，换个名字",
		});
		expect(JSON.stringify(result)).not.toContain("the-shared-secret");
	});

	it("baseUrl 不是 http(s) 地址：配得不对", () => {
		const path = file("badurl.json", provider({ baseUrl: "ftp://x/v1" }));
		expect(check(path, "acme/big", { ACME_KEY: "k" })).toMatchObject({
			configured: false,
			reason: expect.stringContaining("baseUrl"),
		});
		const notUrl = file("notaurl.json", provider({ baseUrl: "not a url" }));
		expect(check(notUrl, "acme/big", { ACME_KEY: "k" })).toMatchObject({ configured: false });
	});
});

describe("部署文档「助手的模型」一节里的模板", () => {
	it("照着写出来的模型文件配得好：模板、环境变量的名字、SFLY_ASSISTANT_MODEL 的写法都对得上", () => {
		const readme = readFileSync(join(import.meta.dirname, "../../../README.md"), "utf8");
		const section = readme.slice(readme.indexOf("### 助手的模型"));
		const template = /```json\n([\s\S]*?)\n\s*```/.exec(section)?.[1];
		expect(template).toBeDefined();
		const dir = mkdtempSync(join(tmpdir(), "sfly-readme-models-"));
		try {
			const path = join(dir, "models.json");
			writeFileSync(path, template ?? "");
			// 文档里写：`SFLY_ASSISTANT_MODEL` 是 `<提供方>/<模型 id>`，密钥是环境变量 MODEL_API_KEY。
			expect(
				checkModels({ modelsFile: path, model: "gateway/<模型 id>", env: { MODEL_API_KEY: "k" } }),
			).toEqual({
				configured: true,
				endpoint: { host: "llm-gateway.internal", port: 443, tls: true },
			});
			expect(modelEnvRefs(template ?? "")).toMatchObject({
				names: ["MODEL_API_KEY"],
				problems: [],
			});
			// 没带变量时写明缺的是 MODEL_API_KEY。
			expect(checkModels({ modelsFile: path, model: "gateway/<模型 id>", env: {} })).toMatchObject({
				configured: false,
				reason: expect.stringContaining("MODEL_API_KEY"),
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
