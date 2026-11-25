import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CheckRow } from "./checks";
import { CheckItem } from "./TriggerForm";

// 运行抽屉的检查清单（#699 的补充）：一行的标题取控制面的警告文字（`title: p.message`），说明是控制面拼的句子，
// 都可以是多行。按多行文字显示：换行保留（容器 `whitespace-pre-line`），不显示成「⟨U+000A⟩」那样的小块；
// 别人写的字符（这里是方向控制字符）照样写出来。

const row = (extra: Partial<CheckRow>): CheckRow => ({
	key: "version",
	state: "blocked",
	title: "标题",
	problems: [],
	...extra,
});
const html = (r: CheckRow) => renderToStaticMarkup(createElement(CheckItem, { row: r }));

describe("检查清单的标题和说明按多行文字显示", () => {
	it("换行保留，不写成小块", () => {
		const out = html(row({ title: "第一行\n第二行", detail: "原因：甲\n原因：乙" }));
		expect(out).toContain("第一行\n第二行");
		expect(out).toContain("原因：甲\n原因：乙");
		expect(out).not.toContain("U+000A");
	});

	it("容器保留换行（标题和说明各一个）", () => {
		const out = html(row({ title: "标题", detail: "说明" }));
		expect(out.match(/whitespace-pre-line/g)?.length).toBe(2);
	});

	it("方向控制字符仍写出来，不留在页面里", () => {
		const out = html(row({ title: "以‮结尾", detail: "说⁦明" }));
		expect(out).toContain("U+202E");
		expect(out).toContain("U+2066");
		expect(out).not.toContain("‮");
		expect(out).not.toContain("⁦");
	});
});
