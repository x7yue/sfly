import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

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
		const tokens = new Map(
			[
				...readFileSync(join(root, "styles/tokens.css"), "utf8").matchAll(
					/(--[\w-]+):\s*([^;]+);/g,
				),
			].map((m) => [m[1] as string, (m[2] as string).replace(/\/\*.*$/, "").trim()]),
		);
		const resolve = (name: string): string => {
			const value = tokens.get(name) ?? "";
			const ref = /^var\((--[\w-]+)\)$/.exec(value);
			return ref ? resolve(ref[1] as string) : value;
		};
		const luminance = (hex: string) => {
			const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
				const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const contrast = (a: string, b: string) => {
			const [hi = 0, lo = 0] = [luminance(resolve(a)), luminance(resolve(b))].sort((x, y) => y - x);
			return (hi + 0.05) / (lo + 0.05);
		};
		expect(resolve("--fg-3")).toMatch(/^#[0-9a-f]{6}$/);
		const low = ["--fg-1", "--fg-2", "--fg-3"].flatMap((text) =>
			["--bg", "--surface", "--raised", "--raised-2"].flatMap((surface) =>
				contrast(text, surface) < 4.5 ? [`${text} on ${surface}`] : [],
			),
		);
		expect(low).toEqual([]);
	});

	it("圆角只用规定的档位（任意值只允许 2px）", () => {
		expect(offending(/rounded(-[a-z]+)?-\[(?!2px\])/)).toEqual([]);
	});
});
