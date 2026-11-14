import type { ParamDeclView, PresetView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	keepGone,
	problemsText,
	refilled,
	repairDraft,
	repairErrors,
	repairOf,
} from "./invalid-preset";

const decls: ParamDeclView[] = [
	{ name: "host", type: "string", required: true },
	{ name: "steps", type: "number", default: 3 },
	{ name: "dry_run", type: "boolean" },
];

const invalid: PresetView = {
	id: "p1",
	name: "压测 A",
	description: "",
	params: [
		{ name: "host", secret: false, value: "10.0.0.8" },
		{ name: "steps", secret: false, value: "五十" },
		{ name: "dry_run", secret: false, value: "yes" },
		{ name: "region", secret: false, value: "cn" },
		{ name: "zone", secret: false, value: { a: 1 } },
	],
	status: "invalid",
	problems: [
		{ param: "dry_run", reason: "type_mismatch" },
		{ param: "region", reason: "missing" },
		{ param: "steps", reason: "type_mismatch" },
		{ param: "zone", reason: "missing" },
	],
	updated_by: "小红",
	updated_at: "2026-01-01T00:00:00.000Z",
};

describe("失效的运行预设的原因", () => {
	it("每个问题写明是哪个参数、什么原因；类型不对时写明现在的类型", () => {
		expect(problemsText(invalid.problems, decls)).toBe(
			[
				"参数 dry_run 保存的值不符合现在的类型（boolean）",
				"参数 region 已不存在",
				"参数 steps 保存的值不符合现在的类型（number）",
				"参数 zone 已不存在",
			].join("；"),
		);
	});
});

describe("修复失效的运行预设", () => {
	it("已不存在的参数单独列出（名称和保存的值），值不符合类型的参数要求重新填写", () => {
		const repair = repairOf(invalid, decls);
		expect(repair.gone).toEqual([
			{ name: "region", value: "cn" },
			{ name: "zone", value: { a: 1 } },
		]);
		expect(repair.kept).toEqual(["region", "zone"]);
		expect(Object.keys(repair.refill)).toEqual(["steps", "dry_run"]);
		expect(repair.refill.steps).toContain("五十");
		expect(repair.refill.steps).toContain("（number）");
	});

	it("可用的预设没有要修的地方", () => {
		const ok: PresetView = { ...invalid, status: "ok", problems: [] };
		expect(repairOf(ok, decls)).toEqual({ gone: [], kept: [], refill: {} });
	});

	it("表单里：已不存在的参数不进表单，值不符合类型的参数留空要求重新填写，其余照常带着保存的值", () => {
		const draft = repairDraft(invalid, decls);
		expect(draft.values).toEqual({ host: "10.0.0.8", steps: "", dry_run: false });
	});

	it("保存前要取消勾选已不存在的参数；取消勾选以后可以再勾回来", () => {
		let repair = repairOf(invalid, decls);
		const draft = repairDraft(invalid, decls);
		expect(repairErrors(repair, draft).gone).toContain("region");
		repair = keepGone(repair, "region", false);
		expect(repairErrors(repair, draft).gone).toContain("zone");
		expect(repairErrors(repair, draft).gone).not.toContain("region");
		repair = keepGone(repair, "zone", false);
		expect(repairErrors(repair, draft).gone).toBeUndefined();
		expect(keepGone(repair, "zone", true).kept).toEqual(["zone"]);
	});

	it("重新填写以后不再提示；取消勾选的参数不再提示", () => {
		let repair = repairOf(invalid, decls);
		const draft = repairDraft(invalid, decls);
		expect(Object.keys(repairErrors(repair, draft).values)).toEqual(["steps", "dry_run"]);

		repair = refilled(repair, "steps");
		expect(Object.keys(repairErrors(repair, draft).values)).toEqual(["dry_run"]);

		const { dry_run: _, ...unchecked } = draft.values;
		expect(repairErrors(repair, { ...draft, values: unchecked }).values).toEqual({});
	});
});
