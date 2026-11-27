import type { ParamDeclView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	containsMask,
	defaultFieldValue,
	fieldSchema,
	hasHiddenDefault,
	initialValues,
	lockedValue,
	maskedRerunParams,
	paramsSchema,
	toParams,
} from "./trigger-form";

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

	it("再次运行时沿用上次的参数，secret 参数不沿用", () => {
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

	describe("secret 参数的默认值读不回来（控制面给的是占位符 ******）", () => {
		const secrets: ParamDeclView[] = [
			{ name: "token", type: "string", secret: true, default: "******" },
			{ name: "pin", type: "number", secret: true, default: "******" },
			{ name: "opts", type: "json", secret: true, default: "******" },
			{ name: "region", type: "string", default: "cn-east" },
		];

		it("表单里留空，不把占位符预填成值；普通参数的默认值照常预填", () => {
			expect(initialValues(secrets)).toEqual({ token: "", pin: "", opts: "", region: "cn-east" });
			expect(defaultFieldValue(secrets[0] as ParamDeclView)).toBe("");
			expect(defaultFieldValue(secrets[3] as ParamDeclView)).toBe("cn-east");
		});

		it("再次运行：secret 参数同样留空（上次运行的值是打码的，也不沿用）", () => {
			expect(initialValues(secrets, { token: "******", pin: "******", region: "us-west" })).toEqual(
				{
					token: "",
					pin: "",
					opts: "",
					region: "us-west",
				},
			);
		});

		it("留空的 secret 参数不进触发参数，由控制面按默认值填入；有默认值时必填的也能留空", () => {
			const required = secrets.map((p) => ({ ...p, required: true }));
			expect(paramsSchema(required).safeParse(initialValues(required)).success).toBe(true);
			expect(toParams(secrets, initialValues(secrets))).toEqual({ region: "cn-east" });
			expect(toParams(secrets, { ...initialValues(secrets), token: "test-secret-typed" })).toEqual({
				token: "test-secret-typed",
				region: "cn-east",
			});
		});
	});

	describe("secret 的布尔参数：「使用默认值」和「选了关」是两回事", () => {
		const flag: ParamDeclView = { name: "flag", type: "boolean", secret: true, default: "******" };
		const noDefault: ParamDeclView = { name: "quiet", type: "boolean", secret: true };

		it("有默认值时初始是「没选」（空串），不是关；没有默认值的 secret 布尔参数还是关", () => {
			expect(hasHiddenDefault(flag)).toBe(true);
			expect(hasHiddenDefault({ ...flag, default: null })).toBe(false);
			expect(hasHiddenDefault({ ...flag, secret: false })).toBe(false);
			expect(defaultFieldValue(flag)).toBe("");
			expect(initialValues([flag, noDefault])).toEqual({ flag: "", quiet: false });
		});

		it("没动过：不放进触发参数，控制面按默认值填入；选了开或关才传，false 也传", () => {
			const decls = [flag, noDefault];
			expect(toParams(decls, { flag: "", quiet: false })).toEqual({ quiet: false });
			expect(toParams(decls, { flag: true, quiet: false })).toEqual({ flag: true, quiet: false });
			expect(toParams(decls, { flag: false, quiet: false })).toEqual({ flag: false, quiet: false });
		});

		it("没选通过校验（触发时用默认值）；运行预设固定的值要选一个", () => {
			expect(paramsSchema([flag]).safeParse({ flag: "" }).success).toBe(true);
			expect(paramsSchema([flag]).safeParse({ flag: false }).success).toBe(true);
			expect(fieldSchema(flag, true).safeParse("").error?.issues[0]?.message).toBe("必填");
			expect(fieldSchema(flag, true).safeParse(false).success).toBe(true);
		});
	});

	it("没动过的 secret 参数不放进触发参数，不论类型：字符串、数字、json、布尔都由控制面按默认值填入", () => {
		const secrets: ParamDeclView[] = [
			{ name: "token", type: "string", secret: true, default: "******" },
			{ name: "pin", type: "number", secret: true, default: "******" },
			{ name: "opts", type: "json", secret: true, default: "******" },
			{ name: "flag", type: "boolean", secret: true, default: "******" },
			{ name: "region", type: "string", default: "cn-east" },
		];
		expect(toParams(secrets, initialValues(secrets))).toEqual({ region: "cn-east" });
	});

	it("预设锁定的参数：secret 参数显示接口返回的打码值，不按类型换算；其余按类型换算", () => {
		const find = (name: string) => decls.find((p) => p.name === name) as ParamDeclView;
		expect(lockedValue(find("api_token"), "******")).toBe("******");
		expect(lockedValue({ name: "pin", type: "number", secret: true }, "******")).toBe("******");
		expect(lockedValue({ name: "on", type: "boolean", secret: true }, "******")).toBe("******");
		expect(lockedValue({ name: "o", type: "json", secret: true }, "******")).toBe("******");
		expect(lockedValue(find("steps"), 50)).toBe("50");
		expect(lockedValue(find("validate_ok"), false)).toBe(false);
		expect(lockedValue(find("options"), { a: 1 })).toBe('{"a":1}');
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

describe("再次运行：值里含有掩码的普通参数不预填（#485）", () => {
	const rerun: ParamDeclView[] = [
		{ name: "url", type: "string", default: "https://example.test/" },
		{ name: "region", type: "string" },
		{ name: "options", type: "json", default: { retries: 1 } },
		{ name: "token", type: "string", secret: true, default: "******" },
	];
	const previous = {
		url: "https://example.test/?token=******",
		region: "eu-west",
		options: { headers: { auth: "Bearer ******" } },
		token: "******",
	};

	it("字符串里、JSON 的值和键里的掩码都认得出；数字、布尔、null 不算", () => {
		expect(containsMask("a******b")).toBe(true);
		expect(containsMask({ a: ["x", { b: "******" }] })).toBe(true);
		expect(containsMask({ "******": 1 })).toBe(true);
		expect(containsMask("*****")).toBe(false);
		expect(containsMask(6)).toBe(false);
		expect(containsMask(true)).toBe(false);
		expect(containsMask(null)).toBe(false);
	});

	it("含有掩码的普通参数用默认值，其余照常沿用；secret 参数本来就不预填，不算在里面", () => {
		expect(maskedRerunParams(rerun, previous)).toEqual(new Set(["url", "options"]));
		expect(initialValues(rerun, previous)).toEqual({
			url: "https://example.test/",
			region: "eu-west",
			options: '{"retries":1}',
			token: "",
		});
	});

	it("没有上一次的参数、上一次没有这个参数时，没有要提示的", () => {
		expect(maskedRerunParams(rerun)).toEqual(new Set());
		expect(maskedRerunParams(rerun, { region: "x" })).toEqual(new Set());
	});
});
