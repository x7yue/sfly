import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS, type StatusKind } from "#/components/status";
import { buttonVariants } from "#/components/ui/button";

/**
 * docs/DESIGN-SYSTEM.md 中能静态检查的规则：组件代码里不写色值（只有 styles/tokens.css 写），
 * 圆角只用 4 / 6 / 8 / 12 档（rounded-sm / md / lg / xl，另有 rounded-full；小于 12px 的指示元素用 2px）。
 */
const root = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

const offending = (pattern: RegExp) =>
	sources(root).flatMap((file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line, i) => (pattern.test(line) ? [`${relative(root, file)}:${i + 1}`] : [])),
	);

describe("设计规范", () => {
	it("组件里不写色值（rgb / hsl / oklch / 十六进制），用 token", () => {
		expect(offending(/rgba?\(|hsla?\(|oklch\(|["'[]#[0-9a-fA-F]{3,8}["'\]]|_rgb\(|rgb_\(/)).toEqual(
			[],
		);
	});

	it("组件不用 outline-none 去掉焦点环（只有 components/ui 的输入类控件改用描边 + 光晕）", () => {
		expect(offending(/\boutline-none\b/).filter((at) => !at.startsWith("components/ui/"))).toEqual(
			[],
		);
	});

	it("已跳过的淡灰只给圆圈，文字用辅助文字色", () => {
		expect(
			offending(/\btext-skipped\b/).filter((at) => !at.startsWith("components/status.tsx")),
		).toEqual([]);
	});

	it("文字三级在 bg 到 raised-2 的每个表面上对比度 ≥ 4.5:1", () => {
		const low = ["--fg-1", "--fg-2", "--fg-3"].flatMap((text) =>
			SURFACES.flatMap((surface) =>
				contrast(text, surface) < 4.5 ? [`${text} on ${surface}`] : [],
			),
		);
		expect(low).toEqual([]);
	});

	it("状态描边在 surface 上 ≥ 3:1，带文字的状态淡底只比 surface 亮一点（≈ 1.15:1）", () => {
		const lines = [
			"--signal-line",
			"--ok-line",
			"--warn-line",
			"--danger-line",
			"--canvas-subflow-line",
		];
		expect(lines.filter((t) => contrast(t, "--surface") < 3)).toEqual([]);
		const softs = ["--ok-soft", "--warn-soft", "--danger-soft"].map(
			(t) => Math.round(contrast(t, "--surface") * 100) / 100,
		);
		expect(softs.every((c) => c >= 1.1 && c <= 1.2)).toBe(true);
	});

	it("表单控件的边界在所在的表面上 ≥ 3:1，画布端口对画布 ≥ 3:1，滚动条滑块对面板 ≥ 3:1", () => {
		const low = ["--sunk", "--surface", "--raised"].flatMap((s) =>
			contrast("--border-control", s) < 3 ? [s] : [],
		);
		expect(low).toEqual([]);
		expect(contrast("--canvas-port", "--canvas-bg")).toBeGreaterThanOrEqual(3);
		expect(contrast("--scrollbar-thumb", "--surface")).toBeGreaterThanOrEqual(3);
	});

	it("文字选区是中性高亮，选中的正文仍然 ≥ 4.5:1", () => {
		const selection = over(resolve("--selection-bg"), rgbOf("--bg"));
		expect(ratio(rgbOf("--fg-1"), selection)).toBeGreaterThanOrEqual(4.5);
		expect(ratio(selection, rgbOf("--bg"))).toBeGreaterThanOrEqual(1.5);
	});

	it("实心按钮的文字在底色上 ≥ 4.5:1（静止、悬停、按下）", () => {
		const low = (["primary", "danger-solid"] as const).flatMap((variant) => {
			const classes = buttonVariants({ variant }).split(/\s+/);
			const text = token(classes, /^text-(.+)$/) ?? `${variant} 没有文字色`;
			return ["", "hover:", "active:not-disabled:"].flatMap((state) => {
				const bg = token(classes, new RegExp(`^${state}bg-(.+)$`));
				return bg && contrast(text, bg) < 4.5 ? [`${variant} ${state}${bg}`] : [];
			});
		});
		expect(low).toEqual([]);
	});

	it("圆角只用规定的档位（任意值只允许 2px）", () => {
		expect(offending(/rounded(-[a-z]+)?-\[(?!2px\])/)).toEqual([]);
	});
});

describe("状态语法（components/status 的 STATUS）", () => {
	const kinds = Object.keys(STATUS) as StatusKind[];

	it("每种状态一个标记形状；只有执行中能脉冲", () => {
		expect(new Set(kinds.map((k) => STATUS[k].mark)).size).toBe(kinds.length);
		expect(kinds.filter((k) => STATUS[k].pulse)).toEqual(["running"]);
	});

	it("状态文字在所有表面上 ≥ 4.5:1，标记与色块的颜色 ≥ 3:1", () => {
		const low = kinds.flatMap((k) => {
			const text = token(STATUS[k].text.split(" "), /^text-(.+)$/) ?? "";
			const tone = token(STATUS[k].tone.split(" "), /^text-(.+)$/) ?? "";
			return SURFACES.flatMap((s) => [
				...(contrast(text, s) < 4.5 ? [`${k} 文字 on ${s}`] : []),
				...(contrast(tone, s) < 3 ? [`${k} 标记 on ${s}`] : []),
			]);
		});
		expect(low).toEqual([]);
	});

	it("色块形状相同（高度、描边、斜纹）的两种状态，在三种色觉缺陷下色差也够大（OKLab ΔE ≥ 10）", () => {
		const surface = rgbOf("--surface");
		const shapeOf = (k: StatusKind, classes: string) => {
			const fill = token(classes.split(" "), /^(?:bg|fill)-([a-z][\w-]*)$/);
			const edge = /\bborder-dashed\b|stroke-dasharray/.test(classes)
				? "dashed"
				: /(^|\s)(border|stroke-[a-z])/.test(classes)
					? "solid"
					: "none";
			return {
				key: [
					STATUS[k].area.tall,
					edge,
					fill ? "filled" : "hollow",
					classes.includes("gradient"),
				].join(),
				color: fill ? over(resolve(fill), surface) : surface,
			};
		};
		const close = (["box", "svg"] as const).flatMap((view) =>
			kinds.flatMap((a, i) =>
				kinds.slice(i + 1).flatMap((b) => {
					const [x, y] = [shapeOf(a, STATUS[a].area[view]), shapeOf(b, STATUS[b].area[view])];
					if (x.key !== y.key) return [];
					const worst = Math.min(...VISION.map((see) => deltaE(see(x.color), see(y.color))));
					return worst < 10 ? [`${view}: ${a} / ${b} ΔE ${worst.toFixed(1)}`] : [];
				}),
			),
		);
		expect(close).toEqual([]);
	});
});

type Rgba = { rgb: [number, number, number]; alpha: number };

const SURFACES = ["--bg", "--surface", "--raised", "--raised-2"];

const tokensCss = readFileSync(join(root, "styles/tokens.css"), "utf8");
const rootBlock = tokensCss.slice(tokensCss.indexOf(":root {"), tokensCss.indexOf("@media"));
const tokens = new Map(
	[...rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
		m[1] as string,
		(m[2] as string)
			.replace(/\/\*.*$/, "")
			.replace(/\s+/g, " ")
			.replace(/\( | \)/g, (p) => p.trim())
			.trim(),
	]),
);

function resolve(name: string): Rgba {
	const value = tokens.get(name) ?? "";
	const ref = /^var\((--[\w-]+)\)$/.exec(value);
	if (ref) return resolve(ref[1] as string);
	const mix = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, transparent\)$/.exec(value);
	if (mix) return { ...resolve(mix[1] as string), alpha: Number(mix[2]) / 100 };
	const hex = /^#([0-9a-f]{6})$/i.exec(value);
	if (!hex) throw new Error(`${name}: 无法计算的色值 ${value}`);
	const [r = 0, g = 0, b = 0] = [0, 2, 4].map(
		(i) => Number.parseInt(value.slice(1 + i, 3 + i), 16) / 255,
	);
	return { rgb: [r, g, b], alpha: 1 };
}

const over = (top: Rgba, under: Rgba): Rgba => ({
	rgb: top.rgb.map((c, i) => c * top.alpha + (under.rgb[i] ?? 0) * (1 - top.alpha)) as Rgba["rgb"],
	alpha: 1,
});
const rgbOf = (name: string) => over(resolve(name), resolve("--surface"));

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ({ rgb }: Rgba) => {
	const [r, g, b] = rgb.map(linear) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgba, b: Rgba) => {
	const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};
const contrast = (fg: string, surface: string) =>
	ratio(over(resolve(fg), rgbOf(surface)), rgbOf(surface));

const colorToken = new Map(
	[
		...readFileSync(join(root, "styles/app.css"), "utf8").matchAll(
			/--color-([\w-]+): var\((--[\w-]+)\);/g,
		),
	].map((m) => [m[1] as string, m[2] as string]),
);

const token = (classes: string[], pattern: RegExp) => {
	for (const c of classes) {
		const name = pattern.exec(c)?.[1];
		const found = name && colorToken.get(name);
		if (found) return found;
	}
	return undefined;
};

const oklab = ({ rgb }: Rgba) => {
	const [r, g, b] = rgb.map(linear) as [number, number, number];
	const [l, m, s] = [
		0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
		0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
		0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
	].map(Math.cbrt) as [number, number, number];
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
};
const deltaE = (a: Rgba, b: Rgba) => {
	const [x, y] = [oklab(a), oklab(b)];
	return Math.hypot(...x.map((v, i) => v - (y[i] ?? 0))) * 100;
};

// Machado 2009 色觉缺陷模拟矩阵，严重度 1.0。
const MACHADO: Record<string, number[][]> = {
	protan: [
		[0.152286, 1.052583, -0.204868],
		[0.114503, 0.786281, 0.099216],
		[-0.003882, -0.048116, 1.051998],
	],
	deutan: [
		[0.367322, 0.860646, -0.227968],
		[0.280085, 0.672501, 0.047413],
		[-0.01182, 0.04294, 0.968881],
	],
	tritan: [
		[1.255528, -0.076749, -0.178779],
		[-0.078411, 0.930809, 0.147602],
		[0.004733, 0.691367, 0.3039],
	],
};
const unlinear = (c: number) => {
	const v = Math.min(1, Math.max(0, c));
	return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};
const simulate =
	(matrix: number[][]) =>
	(color: Rgba): Rgba => {
		const lin = color.rgb.map(linear);
		return {
			rgb: matrix.map((row) =>
				unlinear(row.reduce((sum, k, j) => sum + k * (lin[j] ?? 0), 0)),
			) as Rgba["rgb"],
			alpha: 1,
		};
	};
const VISION = [(c: Rgba) => c, ...Object.values(MACHADO).map(simulate)];
