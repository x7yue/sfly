import type { ParamDeclView, PresetView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	draftErrors,
	draftFromFormValues,
	draftFromPreset,
	emptyDraft,
	hasErrors,
	replaceSecret,
	toggleParam,
	toPresetBody,
} from "./preset-form";

const decls: ParamDeclView[] = [
	{ name: "host", type: "string", required: true },
	{ name: "steps", type: "number", default: 3 },
	{ name: "dry_run", type: "boolean", default: true },
	{ name: "options", type: "json", default: { mode: "fast" } },
	{ name: "name", type: "string" },
	{ name: "token", type: "string", secret: true },
	{ name: "pin", type: "number", secret: true },
];
const param = (name: string) => decls.find((p) => p.name === name) as ParamDeclView;

describe("运行预设的编辑表单", () => {
	it("勾选参数时先填上默认值，取消勾选后不再是预设参数", () => {
		let draft = emptyDraft();
		for (const name of ["steps", "dry_run", "options", "host"]) {
			draft = toggleParam(draft, param(name), true);
		}
		expect(draft.values).toEqual({
			steps: "3",
			dry_run: true,
			options: '{"mode":"fast"}',
			host: "",
		});
		expect(toggleParam(draft, param("steps"), false).values).not.toHaveProperty("steps");
	});

	it("勾选敏感参数：它的默认值读不回来，表单里是空的，要重新输入（不把占位符填进去）", () => {
		const secret: ParamDeclView = {
			name: "token",
			type: "string",
			secret: true,
			default: "******",
		};
		const draft = toggleParam(emptyDraft(), secret, true);
		expect(draft.values).toEqual({ token: "" });
		expect(draftErrors(draft, [secret]).values).toEqual({ token: "必填" });
	});

	it("勾选敏感的布尔参数：没有可显示的值，是「没选」，要选 true 或 false；选了 false 也算选了", () => {
		const flag: ParamDeclView = { name: "flag", type: "boolean", secret: true, default: "******" };
		let draft = toggleParam({ ...emptyDraft(), name: "p" }, flag, true);
		expect(draft.values).toEqual({ flag: "" });
		expect(draftErrors(draft, [flag]).values).toEqual({ flag: "必填" });
		draft = { ...draft, values: { flag: false } };
		expect(draftErrors(draft, [flag]).values).toEqual({});
		expect(toPresetBody(draft, [flag]).params).toEqual([{ name: "flag", value: false }]);
		// 沿用原值的敏感布尔参数点「替换」后同样要选。
		const replaced = replaceSecret({ ...draft, keptSecrets: ["flag"] }, "flag");
		expect(draftErrors(replaced, [flag]).values).toEqual({ flag: "必填" });
	});

	it("名称必填且不超过 40 个字符，至少勾选一个参数，勾选的参数必须填值、格式正确", () => {
		expect(draftErrors(emptyDraft(), decls)).toEqual({
			name: "名称不能为空",
			params: "至少勾选一个参数",
			values: {},
		});
		const errors = draftErrors(
			{
				name: "名".repeat(41),
				description: "",
				values: { host: " ", steps: "三", options: "{", name: "" },
				keptSecrets: [],
			},
			decls,
		);
		expect(errors).toEqual({
			name: "名称不能超过 40 个字符",
			values: { host: "必填", steps: "需要一个数字", options: "不是合法的 JSON", name: "必填" },
		});
		const ok = { name: " 压测 A ", description: "", values: { steps: "50" }, keptSecrets: [] };
		expect(hasErrors(draftErrors(ok, decls))).toBe(false);
		const emoji = { ...ok, name: "🚀".repeat(40), description: "🚀".repeat(200) };
		expect(hasErrors(draftErrors(emoji, decls))).toBe(false);
		expect(draftErrors({ ...emoji, description: "🚀".repeat(201) }, decls).description).toBe(
			"说明不能超过 200 个字符",
		);
	});

	it("请求体：预设参数按声明顺序，值按类型换算", () => {
		expect(
			toPresetBody(
				{
					name: " 压测 A ",
					description: " A 集群 ",
					values: { options: '{"rounds":[1]}', host: "10.0.0.8", steps: "50", dry_run: false },
					keptSecrets: [],
				},
				decls,
			),
		).toEqual({
			name: "压测 A",
			description: "A 集群",
			params: [
				{ name: "host", value: "10.0.0.8" },
				{ name: "steps", value: 50 },
				{ name: "dry_run", value: false },
				{ name: "options", value: { rounds: [1] } },
			],
		});
	});

	describe("编辑已有的预设", () => {
		const preset: PresetView = {
			id: "p1",
			name: "压测 A",
			description: "A 集群",
			params: [
				{ name: "host", secret: false, value: "10.0.0.8" },
				{ name: "steps", secret: false, value: 50 },
				{ name: "dry_run", secret: false, value: true },
				{ name: "options", secret: false, value: { rounds: [1] } },
			],
			status: "ok",
			problems: [],
			updated_by: "小红",
			updated_at: "2026-01-01T00:00:00.000Z",
		};

		it("表单带着预设现在的名称、说明和预设参数，值换成表单里的写法；没固定的参数不勾选", () => {
			const draft = draftFromPreset(preset, decls);
			expect(draft).toEqual({
				name: "压测 A",
				description: "A 集群",
				values: {
					host: "10.0.0.8",
					steps: "50",
					dry_run: true,
					options: '{"rounds":[1]}',
				},
				keptSecrets: [],
			});
			expect(hasErrors(draftErrors(draft, decls))).toBe(false);
			// 原样保存：请求体和预设现在的内容一致。
			expect(toPresetBody(draft, decls)).toEqual({
				name: "压测 A",
				description: "A 集群",
				params: preset.params.map(({ name, value }) => ({ name, value })),
			});
		});

		describe("secret 参数", () => {
			const secretPreset: PresetView = {
				...preset,
				params: [
					{ name: "host", secret: false, value: "10.0.0.8" },
					{ name: "token", secret: true, value: "******" },
				],
			};

			it("预设里已有值的 secret 参数沿用原值：表单里是空的，勾选，不用重新输入就能通过校验", () => {
				const draft = draftFromPreset(secretPreset, decls);
				expect(draft.values).toEqual({ host: "10.0.0.8", token: "" });
				expect(draft.keptSecrets).toEqual(["token"]);
				expect(hasErrors(draftErrors(draft, decls))).toBe(false);
			});

			it("沿用原值的 secret 参数提交 keep，不带值；点「替换」后要重新填，提交新值", () => {
				const draft = draftFromPreset(secretPreset, decls);
				expect(toPresetBody(draft, decls).params).toEqual([
					{ name: "host", value: "10.0.0.8" },
					{ name: "token", keep: true },
				]);

				const replacing = replaceSecret(draft, "token");
				expect(replacing.keptSecrets).toEqual([]);
				expect(replacing.values.token).toBe("");
				expect(draftErrors(replacing, decls).values).toEqual({ token: "必填" });
				const typed = { ...replacing, values: { ...replacing.values, token: "tok-new" } };
				expect(hasErrors(draftErrors(typed, decls))).toBe(false);
				expect(toPresetBody(typed, decls).params).toContainEqual({
					name: "token",
					value: "tok-new",
				});
			});

			it("取消勾选再勾选，原值已经不在了：当作新勾选，要重新填；非字符串的 secret 参数按类型换算", () => {
				const draft = draftFromPreset(secretPreset, decls);
				const unchecked = toggleParam(draft, param("token"), false);
				expect(unchecked.keptSecrets).toEqual([]);
				expect(unchecked.values).not.toHaveProperty("token");
				const rechecked = toggleParam(unchecked, param("token"), true);
				expect(rechecked.keptSecrets).toEqual([]);
				expect(draftErrors(rechecked, decls).values).toEqual({ token: "必填" });

				const pin = toggleParam(emptyDraft(), param("pin"), true);
				const typed = { ...pin, values: { pin: "4242" } };
				expect(toPresetBody(typed, decls).params).toEqual([{ name: "pin", value: 4242 }]);
			});

			it("保存的值不符合现在类型的 secret 参数没有可沿用的值：表单里留空，要重新输入", () => {
				const invalid: PresetView = {
					...secretPreset,
					params: [
						{ name: "token", secret: true, value: "******" },
						{ name: "pin", secret: true, value: "******" },
					],
					status: "invalid",
					problems: [
						{
							param: "pin",
							reason: "type_mismatch",
							message: "参数 pin 保存的值不符合现在的类型（number）",
						},
					],
				};
				const draft = draftFromPreset(invalid, decls);
				expect(draft.keptSecrets).toEqual(["token"]);
				expect(draft.values).toEqual({ token: "", pin: "" });
				expect(draftErrors(draft, decls).values).toEqual({ pin: "必填" });
			});

			it("保存之后才变成 secret 的参数同样沿用原值；不再是 secret 的参数是普通参数，值带进表单", () => {
				const turned = draftFromPreset(
					{ ...preset, params: [{ name: "host", secret: true, value: "******" }] },
					decls.map((p) => (p.name === "host" ? { ...p, secret: true } : p)),
				);
				expect(turned.keptSecrets).toEqual(["host"]);
				const stopped = draftFromPreset(
					{ ...preset, params: [{ name: "token", secret: false, value: "visible" }] },
					decls.map((p) => (p.name === "token" ? { ...p, secret: false } : p)),
				);
				expect(stopped.keptSecrets).toEqual([]);
				expect(stopped.values).toEqual({ token: "visible" });
			});
		});

		it("预设里已经不在入口参数里的参数不进表单", () => {
			const old: PresetView = {
				...preset,
				params: [
					{ name: "gone", secret: false, value: 1 },
					{ name: "host", secret: false, value: "h" },
					{ name: "also_gone", secret: false, value: 2 },
				],
			};
			expect(Object.keys(draftFromPreset(old, decls).values)).toEqual(["host"]);
		});
	});
});

describe("把运行抽屉里填的值存为预设", () => {
	const filled = {
		host: "10.0.0.8",
		steps: "3",
		dry_run: false,
		options: '{"mode":"fast"}',
		name: "",
		token: "tok-typed",
		pin: "",
	};

	it("填了值的参数默认勾上，包括还是默认值、没动过的；留空的参数不勾", () => {
		const draft = draftFromFormValues(decls, filled);
		expect(Object.keys(draft.values).sort()).toEqual([
			"dry_run",
			"host",
			"options",
			"steps",
			"token",
		]);
		expect(draft.values.host).toBe("10.0.0.8");
		expect(draft.values.steps).toBe("3");
		expect(draft.values.options).toBe('{"mode":"fast"}');
		expect(draft.name).toBe("");
		expect(draft.description).toBe("");
	});

	it("布尔参数的开关总有一个值（开或关），都勾上", () => {
		expect(draftFromFormValues(decls, { ...filled, dry_run: false }).values.dry_run).toBe(false);
		expect(draftFromFormValues(decls, { ...filled, dry_run: true }).values.dry_run).toBe(true);
	});

	it("改过默认值的参数勾上，值带过来", () => {
		const draft = draftFromFormValues(decls, {
			...filled,
			steps: "50",
			options: '{"mode":"slow"}',
		});
		expect(draft.values.steps).toBe("50");
		expect(draft.values.options).toBe('{"mode":"slow"}');
	});

	it("secret 参数勾上但不带值，要重新输入", () => {
		const draft = draftFromFormValues(decls, filled);
		expect(draft.values.token).toBe("");
		expect(draft.keptSecrets).toEqual([]);
		expect(draftErrors(draft, decls).values).toEqual({ token: "必填" });
		const retyped = { ...draft, name: "压测 A", values: { ...draft.values, token: "tok-again" } };
		expect(hasErrors(draftErrors(retyped, decls))).toBe(false);
	});
});
