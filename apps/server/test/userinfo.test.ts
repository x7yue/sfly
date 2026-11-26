// 控制面公开的地方不带镜像地址里的用户名和密码（#755）：`withoutUserinfo` 和 Agent 的 `mask_userinfo`（agent/src/secret.rs）规则一样，
// 只认地址形状的 `用户名:密码@`。Agent 那一边把它换成 `***`、留着 `@`，这一边连 `@` 一起去掉。
// 两边的样例对齐的办法：直接读 Rust 测试里的那张表（`masks_the_username_and_password_of_every_address_in_a_text`），
// 每一条的输入在这里去掉用户名和密码，结果必须等于 Agent 的输出去掉 `***@`。两边改规则、改样例都会让这里红，不会悄悄各走各的。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicMirrors } from "../src/public-config.js";
import { withoutUserinfo } from "../src/userinfo.js";

/** Rust 测试里 `for (…) in [ … ] {` 那张表里按出现顺序的字符串字面量（普通的和 `r#"…"#` 的），跳过注释。 */
function rustTableStrings(source: string, fn: string): string[] {
	const start = source.indexOf(`fn ${fn}()`);
	if (start === -1) throw new Error(`agent/src/secret.rs 里没有 ${fn}`);
	const open = source.indexOf(" in [", start);
	const close = source.indexOf("] {", open);
	if (open === -1 || close === -1) throw new Error(`${fn} 里找不到表`);
	const table = source.slice(open + " in [".length, close);
	const strings: string[] = [];
	for (let i = 0; i < table.length; i += 1) {
		const c = table[i];
		if (c === "/" && table[i + 1] === "/") {
			while (i < table.length && table[i] !== "\n") i += 1;
		} else if (c === "r" && table.startsWith('r#"', i)) {
			const end = table.indexOf('"#', i + 3);
			strings.push(table.slice(i + 3, end));
			i = end + 1;
		} else if (c === '"') {
			let text = "";
			for (i += 1; table[i] !== '"'; i += 1) {
				if (table[i] === "\\") {
					i += 1;
					text += table[i] === "n" ? "\n" : (table[i] as string);
				} else {
					text += table[i];
				}
			}
			strings.push(text);
		}
	}
	return strings;
}

describe("withoutUserinfo", () => {
	it("和 Agent 的 mask_userinfo 的样例一一对齐：每一条输入去掉用户名和密码，等于 Agent 的输出去掉 `***@`", () => {
		const source = readFileSync(join(import.meta.dirname, "../../../agent/src/secret.rs"), "utf8");
		const strings = rustTableStrings(
			source,
			"masks_the_username_and_password_of_every_address_in_a_text",
		);
		// 每条两个字符串（输入、输出）。
		expect(strings.length).toBeGreaterThanOrEqual(40);
		expect(strings.length % 2).toBe(0);
		const pairs: Array<[string, string]> = [];
		for (let k = 0; k < strings.length; k += 2) {
			pairs.push([strings[k] as string, strings[k + 1] as string]);
		}
		for (const [text, masked] of pairs) {
			expect(withoutUserinfo(text), text).toBe(masked.replaceAll("***@", ""));
		}
		// 表里确实有带凭据的和没有凭据的两类（读错了表时这里会红）。
		expect(pairs.some(([text, masked]) => text !== masked)).toBe(true);
		expect(pairs.some(([text, masked]) => text === masked && text !== "")).toBe(true);
	});

	it("镜像地址：主机、端口、路径留着，用户名和密码（含只有用户名、密码里的 @、百分号转义）去掉", () => {
		for (const [address, shown] of [
			["https://user:pw@mirror.example/simple", "https://mirror.example/simple"],
			["https://token@mirror.example/simple/", "https://mirror.example/simple/"],
			["https://u:p@ss@host:8080/x", "https://host:8080/x"],
			["https://u%40x:p%2Fw@host/x", "https://host/x"],
			["http://u:p@[::1]:3141/simple", "http://[::1]:3141/simple"],
			["https://u:p@host", "https://host"],
			// 没有凭据的原样：路径、查询里的 @，file://，绝对路径。
			["https://mirrors.ustc.edu.cn/pypi/simple", "https://mirrors.ustc.edu.cn/pypi/simple"],
			["https://host/pkg@1.0/x", "https://host/pkg@1.0/x"],
			["https://host?email=a@b", "https://host?email=a@b"],
			["file:///mnt/mirror/pypi/simple", "file:///mnt/mirror/pypi/simple"],
			["file:///mnt/a@b/simple", "file:///mnt/a@b/simple"],
			["/mnt/mirror/pypi/simple", "/mnt/mirror/pypi/simple"],
		] as const) {
			expect(withoutUserinfo(address), address).toBe(shown);
		}
	});

	it("publicMirrors：两个镜像都去掉用户名和密码，没配的仍然没配", () => {
		expect(
			publicMirrors({
				pypi: "https://idxuser:idxpass@pypi.internal/simple",
				githubRelease: "https://ghuser:ghpass@gh.internal/github-release",
			}),
		).toEqual({
			pypi: "https://pypi.internal/simple",
			githubRelease: "https://gh.internal/github-release",
		});
		expect(publicMirrors({})).toEqual({});
		expect(publicMirrors({ pypi: "https://u:p@h/simple" })).toEqual({ pypi: "https://h/simple" });
		expect(publicMirrors({ pypi: "" })).toEqual({ pypi: "" });
	});
});
