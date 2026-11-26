// 控制面公开的地方不带镜像地址里的用户名和密码（#755）：`publicAddress` 按单个地址去（http、https 的主机段到第一个 / \ ? # 为止，
// 最后一个 @ 之前的都是用户名和密码，不管它们长什么样），去完用 new URL() 兜底：还有用户名或密码、或者解析不了就不公开。
// 公开不公开只取决于「解析之后有没有用户名和密码」，不取决于密码长什么样。
import { describe, expect, it } from "vitest";
import { readEnvSettings } from "../src/config/env-settings.js";
import { publicMirrors } from "../src/public-config.js";
import { publicAddress } from "../src/userinfo.js";

/** 地址里的用户名和密码从解析器的角度看还剩什么。 */
const credentialsOf = (address: string) => {
	const url = new URL(address);
	return [url.username, url.password];
};

describe("publicAddress：单个地址去掉用户名和密码", () => {
	it("镜像地址：主机、端口、路径、查询留着，用户名和密码（含只有用户名、只有密码、密码里的 @、百分号转义）去掉", () => {
		for (const [address, shown] of [
			["https://user:pw@mirror.example/simple", "https://mirror.example/simple"],
			["https://token@mirror.example/simple/", "https://mirror.example/simple/"],
			["https://:pw@mirror.example/simple", "https://mirror.example/simple"],
			["https://u:@mirror.example/simple", "https://mirror.example/simple"],
			["https://u:p@ss@host:8080/x", "https://host:8080/x"],
			["https://u%40x:p%2Fw@host/x", "https://host/x"],
			["http://u:p@[::1]:3141/simple", "http://[::1]:3141/simple"],
			["https://u:p@host", "https://host"],
			["https://u:p@host?index=a@b#c@d", "https://host?index=a@b#c@d"],
			["HTTPS://u:p@Host/x", "HTTPS://Host/x"],
			// 没有凭据的原样：路径、查询里的 @，百分号编码的 @。
			["https://mirrors.ustc.edu.cn/pypi/simple", "https://mirrors.ustc.edu.cn/pypi/simple"],
			["https://host/pkg@1.0/x", "https://host/pkg@1.0/x"],
			["https://host?email=a@b", "https://host?email=a@b"],
			["https://host#a@b", "https://host#a@b"],
			["https://host/a%40b", "https://host/a%40b"],
		] as const) {
			expect(publicAddress(address), address).toBe(shown);
		}
	});

	it("查询里还有一个带凭据的地址：只动主机段，查询原样（不是在文字里找地址）", () => {
		expect(publicAddress("https://u:p@h/redirect?to=https://x:y@z/path")).toBe(
			"https://h/redirect?to=https://x:y@z/path",
		);
		expect(publicAddress("https://h/redirect?to=https://x:y@z/path")).toBe(
			"https://h/redirect?to=https://x:y@z/path",
		);
	});

	it('密码里有 " ` < > 空格、制表符、换行、不换行空格 U+00A0、全角空格 U+3000：照样整段去掉，结果里没有它们', () => {
		const passwords = [
			'Xy7"k',
			"Xy7`k",
			"Xy7<k",
			"Xy7>k",
			"Xy7 k",
			"Xy7\tk",
			"Xy7\nk",
			"Xy7\r\nk",
			"Xy7 k",
			"Xy7　k",
			"Xy7'k",
			"Xy7;k",
			"Xy7|k",
			"Xy7{k}",
			"Xy7@k",
			"Xy7:k",
			"Xy7%k",
			"Xy7é汉k",
			'a"b`c<d>e f',
			"​k",
		];
		for (const pw of passwords) {
			const address = `https://deploy:${pw}@pypi.internal:8443/simple`;
			// 启动检查放行它（解析器认），所以它是真的可以配出来的。
			expect(() => new URL(address), JSON.stringify(address)).not.toThrow();
			const shown = publicAddress(address);
			expect(shown, JSON.stringify(address)).toBe("https://pypi.internal:8443/simple");
			expect(credentialsOf(shown as string), JSON.stringify(address)).toEqual(["", ""]);
		}
	});

	it("所有单个字符放进密码里（解析器放行的）：公开出去的地址里没有用户名和密码，没有一个例外", () => {
		const chars: string[] = [];
		for (let code = 0x01; code <= 0x7f; code += 1) chars.push(String.fromCharCode(code));
		chars.push("\u0080", " ", " ", "　", "﻿", "é", "汉", "😀");
		let accepted = 0;
		for (const ch of chars) {
			const address = `https://deploy:a${ch}b@pypi.internal/simple`;
			try {
				new URL(address);
			} catch {
				continue; // 解析器不认的写法（/ \ ? # 等）：启动时就被拒，配不出来
			}
			accepted += 1;
			const shown = publicAddress(address);
			expect(shown, JSON.stringify(address)).toBe("https://pypi.internal/simple");
		}
		// 解析器放行的不少（排除了几个分隔字符之后），不是空转。
		expect(accepted).toBeGreaterThan(100);
	});

	it("密码里有 / \\ ? # 的地址（解析器不认、启动时就被拒）：去不干净就不公开，不留下半截", () => {
		for (const pw of ["a/b", "a\\b", "a?b", "a#b"]) {
			expect(publicAddress(`https://deploy:${pw}@pypi.internal/simple`), pw).toBeUndefined();
		}
	});

	it("兜底：认不出写法的地址（不是 http、https、file、绝对路径，或者解析不了）不公开，不会原样给出去", () => {
		for (const address of [
			"ftp://u:p@host/x",
			"//u:p@host/x",
			"u:p@host/x",
			"mirror.example/simple",
			"https://",
			"https://u:p@",
			"junk",
		]) {
			expect(publicAddress(address), address).toBeUndefined();
		}
	});

	it("没有用户名和密码位置的两种地址原样：本地目录的绝对路径、file:///", () => {
		for (const address of [
			"/mnt/mirror/pypi/simple",
			"/mnt/a@b/simple",
			"file:///mnt/mirror/github-release",
			"file:///mnt/a@b/simple",
			"",
		]) {
			expect(publicAddress(address), address).toBe(address);
		}
	});

	it("解析器先删掉的制表符、回车、换行：地址里有也先删，结果里没有", () => {
		expect(publicAddress("https://u:p@pypi.in\nternal/si\tmple\r")).toBe(
			"https://pypi.internal/simple",
		);
	});

	it("启动检查放行的写法都过得去：经 readEnvSettings 读出来的镜像再去凭据，要么没有凭据地公开、要么（认不出时）不公开", () => {
		for (const pw of ['Xy7"k', "Xy7<k", "Xy7`k", "Xy7 k", "Xy7\nk", "Xy7 k"]) {
			const raw = `https://deploy:${pw}@pypi.internal/simple`;
			const accepted = readEnvSettings({ SFLY_PYPI_MIRROR: raw }).pypiMirror;
			expect(accepted, JSON.stringify(pw)).toBeDefined();
			expect(publicAddress(accepted as string), JSON.stringify(pw)).toBe(
				"https://pypi.internal/simple",
			);
		}
	});
});

describe("publicMirrors", () => {
	it("两个镜像都去掉用户名和密码，没配的仍然没配", () => {
		expect(
			publicMirrors({
				pypi: "https://idxuser:idxpass@pypi.internal/simple",
				githubRelease: "https://ghuser:ghpass@gh.internal/github-release",
			}),
		).toEqual({
			mirrors: {
				pypi: "https://pypi.internal/simple",
				githubRelease: "https://gh.internal/github-release",
			},
			withheld: [],
		});
		expect(publicMirrors({})).toEqual({ mirrors: {}, withheld: [] });
		expect(publicMirrors({ pypi: "https://u:p@h/simple" })).toEqual({
			mirrors: { pypi: "https://h/simple" },
			withheld: [],
		});
		expect(publicMirrors({ pypi: "" })).toEqual({ mirrors: { pypi: "" }, withheld: [] });
	});

	it("去不干净的那个不公开、记在 withheld 里，另一个不受影响", () => {
		expect(
			publicMirrors({
				pypi: "https://deploy:pa\\ss@pypi.internal/simple",
				githubRelease: "https://ghuser:ghpass@gh.internal/github-release",
			}),
		).toEqual({
			mirrors: { githubRelease: "https://gh.internal/github-release" },
			withheld: ["pypi"],
		});
	});
});
