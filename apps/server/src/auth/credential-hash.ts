import { createHash } from "node:crypto";

/**
 * 凭据在库里只存哈希（ADR 0029）：令牌、Agent 凭据、登录 Cookie 的原值都是高熵随机串，用不着加盐或慢哈希，
 * 存 SHA-256（小写十六进制，64 个字符）就够：库里的值查不回原值，请求带来的原值算一次哈希就能按它查库。
 * 密码不走这里：密码是人记得住的低熵串，用 `crypto.scrypt`（#490）。
 */
export const hashCredential = (secret: string): string =>
	createHash("sha256").update(secret).digest("hex");
