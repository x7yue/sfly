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

	it("圆角只用规定的档位（任意值只允许 2px）", () => {
		expect(offending(/rounded(-[a-z]+)?-\[(?!2px\])/)).toEqual([]);
	});
});
