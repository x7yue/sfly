import type { ParamDeclView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { draftErrors, emptyDraft, hasErrors, toggleParam, toPresetBody } from "./preset-form";

const decls: ParamDeclView[] = [
	{ name: "host", type: "string", required: true },
	{ name: "steps", type: "number", default: 3 },
	{ name: "dry_run", type: "boolean", default: true },
	{ name: "options", type: "json", default: { mode: "fast" } },
	{ name: "name", type: "string" },
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
			},
			decls,
		);
		expect(errors).toEqual({
			name: "名称不能超过 40 个字符",
			values: { host: "必填", steps: "需要一个数字", options: "不是合法的 JSON", name: "必填" },
		});
		const ok = { name: " 压测 A ", description: "", values: { steps: "50" } };
		expect(hasErrors(draftErrors(ok, decls))).toBe(false);
	});

	it("请求体：预设参数按声明顺序，值按类型换算", () => {
		expect(
			toPresetBody(
				{
					name: " 压测 A ",
					description: " A 集群 ",
					values: { options: '{"rounds":[1]}', host: "10.0.0.8", steps: "50", dry_run: false },
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
});
