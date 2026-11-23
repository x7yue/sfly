// 模型文件里引用的环境变量：照 pi 的模板规则找（只把这些交给 pi），认不出的写法在启动时报出来。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { checkModelsFile, modelEnvRefs } from "../src/models.js";

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
		expect(refs).toEqual({ names: ["KEY_A", "KEY_B", "KEY_C", "ORG"], problems: [] });
	});

	it("要执行的命令（! 开头）、${} 里不是变量名：认不出，报出来", () => {
		const refs = modelEnvRefs(models({ apiKey: "!cat /secret", headers: { X: "${bad-name}" } }));
		expect(refs.names).toEqual([]);
		expect(refs.problems).toHaveLength(2);
		expect(refs.problems[0]).toContain("要执行的命令");
		expect(refs.problems[1]).toContain("${bad-name}");
	});

	it("启动时检查：没有模型文件、写法认不出时拒绝启动；引用的变量环境里没有时提醒", () => {
		const dir = mkdtempSync(join(tmpdir(), "sfly-models-"));
		try {
			expect(() => checkModelsFile(join(dir, "missing.json"), {})).toThrow(ConfigError);
			const bad = join(dir, "bad.json");
			writeFileSync(bad, models({ apiKey: "!echo k" }));
			expect(() => checkModelsFile(bad, {})).toThrow(/认不出的写法/);
			const ok = join(dir, "ok.json");
			writeFileSync(ok, models({ apiKey: "${KEY_A}" }));
			expect(checkModelsFile(ok, { KEY_A: "v" })).toEqual([]);
			expect(checkModelsFile(ok, {})).toEqual([expect.stringContaining("KEY_A")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
