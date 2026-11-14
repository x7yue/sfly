import type { ParamDeclaration, PresetParamView, PresetView } from "@sfly/schema";
import type { z } from "zod";
import type { runPresets } from "../db/schema.js";
import { presetProblems } from "./preset-validity.js";

type Declaration = z.infer<typeof ParamDeclaration>;
export type PresetRow = typeof runPresets.$inferSelect;

/**
 * 预设参数的名单，按最新版本入口参数的声明顺序；已不在声明里的排在后面，按名称排序。
 * 预设视图和运行上记的名单（runs.preset_params）都按这个顺序。
 */
export function presetParamNames(
	values: Record<string, unknown>,
	declarations: readonly Declaration[],
): string[] {
	const declared = declarations.map((d) => d.name).filter((name) => Object.hasOwn(values, name));
	const undeclared = Object.keys(values)
		.filter((name) => !declarations.some((d) => d.name === name))
		.sort();
	return [...declared, ...undeclared];
}

/**
 * 一个预设参数的视图。所有接口返回的预设都经过这里：secret 参数的值要在这里换成打码后的值，
 * 任何接口都不返回原值（ADR 0023「secret 预设参数」）。
 */
function paramView(name: string, value: unknown, decl: Declaration | undefined): PresetParamView {
	return { name, secret: decl?.secret === true, value };
}

/** 运行预设的视图（@sfly/schema 的 PresetView），对照最新版本入口参数的声明。 */
export function toPresetView(row: PresetRow, declarations: readonly Declaration[]): PresetView {
	const declared = new Map(declarations.map((d) => [d.name, d]));
	const problems = presetProblems(row.values, declarations);
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		params: presetParamNames(row.values, declarations).map((name) =>
			paramView(name, row.values[name], declared.get(name)),
		),
		status: problems.length === 0 ? "ok" : "invalid",
		problems,
		updated_by: row.updatedBy,
		updated_at: row.updatedAt.toISOString(),
	};
}
