import type { ParamDeclView, PresetView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { initialPresetId, switchPreset, usablePreset } from "./preset-selection";

const decls: ParamDeclView[] = [
	{ name: "biz_date", type: "string", required: true },
	{ name: "steps", type: "number", default: 3 },
	{ name: "validate_ok", type: "boolean", default: true },
	{ name: "options", type: "json" },
	{ name: "api_token", type: "string", required: true, secret: true },
];

describe("切换运行预设时的字段", () => {
	/** 用户已经填过的表单（steps 和 options 的默认值都被改掉了）。 */
	const typed = {
		biz_date: "2026-11-05",
		steps: "9",
		validate_ok: false,
		options: '{"mode":"slow"}',
		api_token: "tok-typed",
	};
	const none = new Set<string>();

	it("原来锁定的敏感参数回到默认值时留空：默认值读不回来（占位符），不预填", () => {
		const withDefault: ParamDeclView[] = [
			{ name: "api_token", type: "string", secret: true, default: "******" },
		];
		expect(switchPreset(withDefault, { api_token: "x" }, new Set(["api_token"]), none)).toEqual({
			api_token: "",
		});
	});

	it("不使用预设改选预设：预设参数以外的字段保留已经填的值", () => {
		const next = switchPreset(decls, typed, none, new Set(["steps"]));
		expect(next).toMatchObject({
			biz_date: "2026-11-05",
			validate_ok: false,
			options: '{"mode":"slow"}',
			api_token: "tok-typed",
		});
	});

	it("预设改回不使用预设：原来锁定的字段回到默认值，secret 参数留空，其余保留", () => {
		const next = switchPreset(decls, typed, new Set(["biz_date", "steps", "api_token"]), none);
		expect(next).toEqual({
			biz_date: "",
			steps: "3",
			validate_ok: false,
			options: '{"mode":"slow"}',
			api_token: "",
		});
	});

	it("换成另一个预设：新旧预设都没有固定的字段保留，原来固定、现在解锁的字段回到默认值", () => {
		const next = switchPreset(
			decls,
			typed,
			new Set(["biz_date", "steps"]),
			new Set(["steps", "options"]),
		);
		expect(next.biz_date).toBe("");
		expect(next.validate_ok).toBe(false);
		expect(next.api_token).toBe("tok-typed");
	});

	it("锁定的字段在表单里始终是默认值，之后预设消失也不会露出以前填的值", () => {
		const locked = switchPreset(decls, typed, none, new Set(["steps", "options"]));
		expect(locked).toMatchObject({ steps: "3", options: "" });
		const unlocked = switchPreset(decls, locked, new Set(["steps", "options"]), none);
		expect(unlocked).toMatchObject({ steps: "3", options: "" });
	});

	it("预设没有变化时原样返回", () => {
		expect(switchPreset(decls, typed, none, none)).toEqual(typed);
	});
});

describe("打开抽屉时默认选哪个预设", () => {
	const preset = (id: string, status: PresetView["status"]): PresetView => ({
		id,
		name: id,
		description: "",
		params: [],
		status,
		problems:
			status === "ok" ? [] : [{ param: "host", reason: "missing", message: "参数 host 已不存在" }],
		updated_by: "tester",
		updated_at: "2026-11-05T08:00:00.000Z",
	});
	const presets = [preset("a", "ok"), preset("b", "invalid")];

	it("记住的预设可用：选中它", () => {
		expect(initialPresetId(presets, "a")).toBe("a");
	});

	it("记住的预设已删除、已失效，或者没有记住：不使用预设", () => {
		expect(initialPresetId(presets, "gone")).toBeNull();
		expect(initialPresetId(presets, "b")).toBeNull();
		expect(initialPresetId(presets, null)).toBeNull();
		expect(initialPresetId([], "a")).toBeNull();
	});

	describe("再次运行", () => {
		const ran = (id: string | null) => ({
			params: {},
			preset: id === null ? null : { id, name: `${id}（触发时的名称）`, params: [] },
		});

		it("上一次用的预设可用：选中它，优先于记住的预设", () => {
			const presets = [preset("a", "ok"), preset("c", "ok")];
			expect(initialPresetId(presets, "c", ran("a"))).toBe("a");
			expect(initialPresetId(presets, null, ran("a"))).toBe("a");
		});

		it("上一次没用预设：不使用预设，记住的预设不顶替", () => {
			expect(initialPresetId([preset("a", "ok")], "a", ran(null))).toBeNull();
		});

		it("上一次用的预设已删除或已失效：不使用预设，记住的预设不顶替", () => {
			const presets = [preset("b", "invalid"), preset("c", "ok")];
			expect(initialPresetId(presets, "c", ran("gone"))).toBeNull();
			expect(initialPresetId(presets, "c", ran("b"))).toBeNull();
		});

		it("按预设的 ID 对上，名称相同但 ID 不同的预设不算", () => {
			const other = { ...preset("other", "ok"), name: "a（触发时的名称）" };
			expect(initialPresetId([other], null, ran("a"))).toBeNull();
		});
	});

	it("只有可用的预设能选中", () => {
		expect(usablePreset(presets, "a")?.id).toBe("a");
		expect(usablePreset(presets, "b")).toBeUndefined();
		expect(usablePreset(presets, null)).toBeUndefined();
	});
});
