import type { ParamDeclView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { initialValues, paramsSchema, toParams } from "./trigger-form";

const decls: ParamDeclView[] = [
	{ name: "biz_date", type: "string", required: true },
	{ name: "steps", type: "number", default: 3 },
	{ name: "validate_ok", type: "boolean", default: true },
	{ name: "options", type: "json" },
	{ name: "api_token", type: "string", required: true, secret: true },
];

/** 校验失败时各字段的错误信息。 */
function errorsOf(values: Record<string, string | boolean>): Record<string, string> {
	const result = paramsSchema(decls).safeParse(values);
	if (result.success) return {};
	return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
}

describe("入口参数表单", () => {
	it("初始值取声明的默认值：布尔参数用开关，其余是输入框里的文本，没有默认值时为空", () => {
		expect(initialValues(decls)).toEqual({
			biz_date: "",
			steps: "3",
			validate_ok: true,
			options: "",
			api_token: "",
		});
	});

	it("再次运行时沿用上次的参数，敏感参数不沿用", () => {
		expect(
			initialValues(decls, {
				biz_date: "2026-11-05",
				steps: 3600,
				validate_ok: false,
				options: { mode: "fast" },
				api_token: "••••••",
			}),
		).toEqual({
			biz_date: "2026-11-05",
			steps: "3600",
			validate_ok: false,
			options: '{"mode":"fast"}',
			api_token: "",
		});
	});

	it("必填且没有默认值的参数留空时报「必填」；数字与 JSON 参数格式不对时指出原因", () => {
		expect(
			errorsOf({ biz_date: "", steps: "三", validate_ok: true, options: "{", api_token: "" }),
		).toEqual({
			biz_date: "必填",
			steps: "需要一个数字",
			options: "不是合法的 JSON",
			api_token: "必填",
		});
		expect(
			errorsOf({ biz_date: "d", steps: "", validate_ok: true, options: "", api_token: "t" }),
		).toEqual({});
	});

	it("转换成触发参数：数字与 JSON 按类型解析，留空的参数不传（由控制面按默认值填充）", () => {
		expect(
			toParams(decls, {
				biz_date: "2026-11-05",
				steps: "",
				validate_ok: false,
				options: '{"mode":"fast"}',
				api_token: "tok",
			}),
		).toEqual({
			biz_date: "2026-11-05",
			validate_ok: false,
			options: { mode: "fast" },
			api_token: "tok",
		});
		expect(toParams([{ name: "n", type: "number" }], { n: " 1.5 " })).toEqual({ n: 1.5 });
	});
});
