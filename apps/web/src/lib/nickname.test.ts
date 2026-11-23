// 昵称弹窗先用控制面同一张表校验（`@sfly/schema` 的 `hasUnsafeNameCharacter`）：不等每个写请求都被服务端 400。
import { describe, expect, it } from "vitest";
import { nicknameProblem } from "./nickname";

describe("昵称填得不合格的原因", () => {
	it("空的、只有空白：填写昵称", () => {
		expect(nicknameProblem("")).toBe("填写昵称");
		expect(nicknameProblem("   ")).toBe("填写昵称");
	});

	it("控制字符、双向控制字符、零宽空格：说明名字里不能有它们", () => {
		for (const bad of ["小\u200b明", "小\u202e明", "小\n明", "小\u0000明", "小\u0085明"]) {
			expect(nicknameProblem(bad), JSON.stringify(bad)).toContain("昵称里不能有控制字符");
		}
	});

	it("正常的名字放行：中日韩、组合表情、波斯文、子区域旗", () => {
		for (const ok of [
			"小明",
			"田中",
			"김철수",
			"👩\u200d💻",
			"می\u200cخواهم",
			"🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
		]) {
			expect(nicknameProblem(ok), ok).toBeUndefined();
		}
	});
});
