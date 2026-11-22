// 密码的存法（ADR 0029「认证的几处细节」）：Node 自带的 `crypto.scrypt`。控制面是 esbuild 打的单文件
// （scripts/bundle.ts），不能引入 argon2、bcrypt 这类原生模块。
//
// 存储串：`scrypt$ln=16,r=8,p=2$<盐 base64url>$<哈希 base64url>`：参数和盐写在串里，所以以后调高默认参数时旧的哈希仍然验证得过，
// 并在下一次登录成功时按新参数重新存（{@link needsRehash}）。`ln` 是 N 的以 2 为底的对数。
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** scrypt 的参数：N = 2^logN。 */
export interface ScryptParams {
	logN: number;
	r: number;
	p: number;
}

/**
 * 默认参数：N=2^16（64 MiB）、r=8、p=2，OWASP 密码存储备忘单给出的 scrypt 配置之一，一次约 0.2 秒。
 * 登录有限速（./login-throttle.ts），同时在算的哈希数不会很多。
 */
export const DEFAULT_SCRYPT: ScryptParams = { logN: 16, r: 8, p: 2 };

const SCHEME = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** 验证存储串时接受的参数上限：库里的值不该超过它，超过了当作坏串，免得一条坏数据让控制面算几分钟、吃光内存。 */
const MAX_LOG_N = 20;
const MAX_R = 32;
const MAX_P = 16;
/** scrypt 默认只许 32 MiB；按 N、r 算出需要的内存，再放宽一倍。 */
const maxmemFor = (params: ScryptParams) => 2 * 128 * 2 ** params.logN * params.r + 1024 * 1024;

const derive = (
	password: string,
	salt: Buffer,
	params: ScryptParams,
	length: number,
): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		scrypt(
			password.normalize("NFC"),
			salt,
			length,
			{ N: 2 ** params.logN, r: params.r, p: params.p, maxmem: maxmemFor(params) },
			(error, key) => (error ? reject(error) : resolve(key)),
		);
	});

const formatParams = ({ logN, r, p }: ScryptParams) => `ln=${logN},r=${r},p=${p}`;

function parseParams(text: string): ScryptParams | undefined {
	const match = /^ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})$/.exec(text);
	if (!match) return undefined;
	const [logN, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (logN < 1 || logN > MAX_LOG_N || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return undefined;
	return { logN, r, p };
}

interface Parsed {
	params: ScryptParams;
	salt: Buffer;
	hash: Buffer;
}

function parseStored(stored: string): Parsed | undefined {
	const [scheme, params, salt, hash, ...rest] = stored.split("$");
	if (scheme !== SCHEME || rest.length > 0 || !params || !salt || !hash) return undefined;
	const parsed = parseParams(params);
	if (!parsed) return undefined;
	const saltBytes = Buffer.from(salt, "base64url");
	const hashBytes = Buffer.from(hash, "base64url");
	if (saltBytes.length === 0 || hashBytes.length === 0) return undefined;
	return { params: parsed, salt: saltBytes, hash: hashBytes };
}

/** 密码的存储串：随机盐，参数和盐都写进串里。密码先规范成 NFC，同一个字符的不同写法得到同一个哈希。 */
export async function hashPassword(
	password: string,
	params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const hash = await derive(password, salt, params, KEY_BYTES);
	return [
		SCHEME,
		formatParams(params),
		salt.toString("base64url"),
		hash.toString("base64url"),
	].join("$");
}

/** 密码对不对。存储串坏了、认不出、参数不合理时返回 false，不抛错（登录按「密码不对」处理）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parsed = parseStored(stored);
	if (!parsed) return false;
	const actual = await derive(password, parsed.salt, parsed.params, parsed.hash.length);
	return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

/** 存储串用的参数比 `current` 低，登录成功时要按 `current` 重新存。认不出的存储串不需要（验证本来就过不了）。 */
export function needsRehash(stored: string, current: ScryptParams): boolean {
	const parsed = parseStored(stored);
	if (!parsed) return false;
	const { logN, r, p } = parsed.params;
	return logN < current.logN || r < current.r || p < current.p;
}
