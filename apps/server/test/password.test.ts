// 密码的存法（ADR 0029「认证的几处细节」）：Node 自带的 scrypt，盐和参数写进存储串，以后可以平滑调高。
import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SCRYPT,
	hashPassword,
	needsRehash,
	type ScryptParams,
	verifyPassword,
} from "../src/auth/password.js";

// 测试里用小参数，不然每次哈希要几百毫秒。
const LOW: ScryptParams = { logN: 10, r: 8, p: 1 };
const HIGH: ScryptParams = { logN: 11, r: 8, p: 1 };

describe("密码的存储串", () => {
	it("里面没有明文：存储串不含密码本身，也不含密码的 base64 或十六进制写法", async () => {
		const password = "correct horse battery staple";
		const stored = await hashPassword(password, LOW);
		expect(stored).not.toContain(password);
		expect(stored).not.toContain(Buffer.from(password).toString("base64"));
		expect(stored).not.toContain(Buffer.from(password).toString("hex"));
		expect(stored.startsWith("scrypt$")).toBe(true);
	});

	it("同一个密码两次的存储串不同（盐是随机的），但都验证得过", async () => {
		const first = await hashPassword("same-password", LOW);
		const second = await hashPassword("same-password", LOW);
		expect(first).not.toBe(second);
		expect(await verifyPassword("same-password", first)).toBe(true);
		expect(await verifyPassword("same-password", second)).toBe(true);
	});

	it("密码不对、大小写不同、多一个字符都验证不过", async () => {
		const stored = await hashPassword("Secret-123", LOW);
		for (const wrong of ["secret-123", "Secret-1234", "Secret-12", "", " Secret-123"]) {
			expect(await verifyPassword(wrong, stored), JSON.stringify(wrong)).toBe(false);
		}
	});

	it("参数和盐写在存储串里：用别的参数的哈希照样验证（调高参数后旧哈希仍然有效）", async () => {
		const old = await hashPassword("pw-long-enough", LOW);
		expect(old.split("$")[1]).toBe("ln=10,r=8,p=1");
		const upgraded = await hashPassword("pw-long-enough", HIGH);
		expect(upgraded.split("$")[1]).toBe("ln=11,r=8,p=1");
		expect(await verifyPassword("pw-long-enough", old)).toBe(true);
		expect(await verifyPassword("pw-long-enough", upgraded)).toBe(true);
	});

	it("参数比当前的低时需要升级，一样或更高时不用；认不出的存储串当作不需要（验证不过，由调用方处理）", async () => {
		const old = await hashPassword("pw-long-enough", LOW);
		expect(needsRehash(old, HIGH)).toBe(true);
		expect(needsRehash(old, LOW)).toBe(false);
		expect(needsRehash(await hashPassword("pw-long-enough", HIGH), LOW)).toBe(false);
		expect(needsRehash("scrypt$placeholder", HIGH)).toBe(false);
	});

	it("和 Node 的 scrypt 对得上：用存储串里的盐和参数自己算一遍，得到存储串里的哈希", async () => {
		const stored = await hashPassword("check-by-hand", LOW);
		const [, , salt, hash] = stored.split("$") as [string, string, string, string];
		const expected = scryptSync("check-by-hand", Buffer.from(salt, "base64url"), 32, {
			N: 2 ** LOW.logN,
			r: LOW.r,
			p: LOW.p,
		});
		expect(Buffer.from(hash, "base64url").equals(expected)).toBe(true);
	});

	it("存储串坏了、被截断、参数不合理时验证不过，不抛错", async () => {
		const stored = await hashPassword("pw-long-enough", LOW);
		const [scheme, params, salt, hash] = stored.split("$") as [string, string, string, string];
		const bad = [
			"",
			"scrypt$placeholder",
			"bcrypt$ln=10,r=8,p=1$c2FsdA$aGFzaA",
			`${scheme}$ln=99,r=8,p=1$${salt}$${hash}`,
			`${scheme}$ln=10,r=0,p=1$${salt}$${hash}`,
			`${scheme}$ln=x,r=8,p=1$${salt}$${hash}`,
			`${scheme}$${params}$${salt}`,
			`${scheme}$${params}$$${hash}`,
			`${scheme}$${params}$${salt}$`,
		];
		for (const value of bad) {
			expect(await verifyPassword("pw-long-enough", value), JSON.stringify(value)).toBe(false);
		}
	});

	it("默认参数不低于 OWASP 给的 scrypt 下限之一（N=2^16, r=8, p=2）", () => {
		expect(DEFAULT_SCRYPT.logN).toBeGreaterThanOrEqual(16);
		expect(DEFAULT_SCRYPT.r).toBeGreaterThanOrEqual(8);
		expect(DEFAULT_SCRYPT.p).toBeGreaterThanOrEqual(2);
	});
});
