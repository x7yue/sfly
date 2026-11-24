import type { Locator, Page } from "@playwright/test";
import { nameProblem, REJECTED_NAME_CHARACTER } from "@sfly/schema";

// 显示不可信文字的端到端检查共用（#699）：别人写的文字（Agent 报的、节点写的、节点包的元信息）里带着改变方向的控制字符、
// 零宽字符、转义字符，页面上不能有任何一个原样留下：**文字节点和属性值（`title`、`aria-label`……）里都不能有**，
// 只能是写出来的样子（`U+202E` 一小块、或纯文字的 `⟨U+202E⟩`）。字符表是 `@sfly/schema` 的 `text-safety.ts` 里那一张。

/** 带进各处的「恶意」写法：每个只有一个有害字符，旁边是正常的字。 */
export const HOSTILE = {
	/** 从右到左覆盖：后面的字倒着显示。 */
	bidi: "\u202E",
	/** 零宽空格：藏内容、让两个名字看起来一样。 */
	zeroWidth: "\u200B",
	/** 转义字符：终端控制序列的开头（页面上不起作用，但要写出来）。 */
	escape: "\u001B",
	/** 标签字符：能拼出一整句看不见的话。 */
	tag: "\u{E0049}",
} as const;

/** 一个名字：正常的字加一个有害字符加正常的字。 */
export const hostile = (label: string, kind: keyof typeof HOSTILE = "bidi") =>
	`${label}${HOSTILE[kind]}gpj.exe`;

interface Found {
	where: string;
	value: string;
}

/**
 * 页面上（或 `scope` 里）所有文字节点和属性值里，不合格的字符：表里的字符（换行和制表符不算：多行的正文里是排版），
 * 和位置不对的零宽连接符、零宽不连字符、变体选择符。没有问题时返回空数组。
 */
export async function unsafeTextOn(page: Page, scope?: Locator): Promise<Found[]> {
	const root = scope ?? page.locator("body");
	const candidates = await root.evaluate((element, pattern) => {
		// 先用一个宽的正则筛：表里的字符，加三种例外（要看位置，交给 Node 里的 nameProblem 判断）。
		const suspicious = new RegExp(`${pattern}|[\\u200C\\u200D\\uFE00-\\uFE0F]`, "u");
		const found: { where: string; value: string }[] = [];
		const describe = (node: Node): string => {
			const parts: string[] = [];
			for (
				let el: Element | null = node instanceof Element ? node : node.parentElement;
				el && el !== document.body;
				el = el.parentElement
			) {
				parts.unshift(
					el.tagName.toLowerCase() +
						(el.getAttribute("data-slot") ? `[${el.getAttribute("data-slot")}]` : ""),
				);
				if (parts.length >= 4) break;
			}
			return parts.join(">");
		};
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const parent = node.parentElement;
			if (parent && ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(parent.tagName)) continue;
			const value = node.textContent ?? "";
			if (suspicious.test(value)) found.push({ where: `text ${describe(node)}`, value });
		}
		for (const el of [element, ...element.querySelectorAll("*")]) {
			for (const attr of el.getAttributeNames()) {
				if (attr === "class" || attr === "style" || attr === "d" || attr === "points") continue;
				const value = el.getAttribute(attr) ?? "";
				if (suspicious.test(value)) found.push({ where: `attr ${attr} ${describe(el)}`, value });
			}
		}
		return found;
	}, REJECTED_NAME_CHARACTER.source);
	// 换行、制表符、换行前的回车是排版，不算；别的交给同一个 nameProblem 判断（表里的字符，和三种例外的位置）。
	return candidates.filter(({ value }) => {
		const problem = nameProblem(value.replace(/\r?\n|\t/g, " "));
		return problem?.kind === "rejected" || problem?.kind === "misplaced";
	});
}

/** 页面上（或 `scope` 里）没有不合格的字符；有的话在报错里列出在哪、是什么（最多 10 处）。 */
export async function expectNoUnsafeText(page: Page, scope?: Locator, message = "") {
	const found = await unsafeTextOn(page, scope);
	const shown = found.slice(0, 10).map(({ where, value }) => ({
		where,
		value: [...value]
			.map((c) =>
				REJECTED_NAME_CHARACTER.test(c) ? `\\u{${(c.codePointAt(0) as number).toString(16)}}` : c,
			)
			.join("")
			.slice(0, 120),
	}));
	if (found.length > 0) {
		throw new Error(
			`${message}页面上还有 ${found.length} 处不合格的字符：${JSON.stringify(shown, null, 2)}`,
		);
	}
}

/** 页面上（或 `scope` 里）写出来的字符（`U+202E` 一小块）有哪些，按出现的顺序。 */
export async function writtenOutOn(page: Page, scope?: Locator): Promise<string[]> {
	return (scope ?? page.locator("body"))
		.locator('[data-slot="hidden-character"]')
		.allTextContents();
}
