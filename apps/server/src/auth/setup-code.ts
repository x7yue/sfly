// 初始化码（ADR 0029「认证的几处细节」）：控制面启动时没有任何用户，就生成一个一次性的初始化码，打印在日志里，
// 同时写进数据目录下一个只有属主可读的文件（`setup-code`）；`/setup` 页用它建第一个平台管理员，用过即失效，
// 重启后重新生成，直到有了用户。离线安装不依赖邮件，也不靠谁抢先打开页面。
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 数据目录里存初始化码的文件名。 */
export const SETUP_CODE_FILE = "setup-code";

// 去掉容易看错的字符（0/O、1/I/L），每 4 个一组，共 20 个字符，约 100 位。
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const GROUPS = 5;
const GROUP_SIZE = 4;

const normalize = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();
const digest = (code: string) => createHash("sha256").update(normalize(code)).digest();

function randomCode(): string {
	const groups: string[] = [];
	for (let g = 0; g < GROUPS; g++) {
		let group = "";
		for (let i = 0; i < GROUP_SIZE; i++) group += ALPHABET[randomInt(ALPHABET.length)];
		groups.push(group);
	}
	return groups.join("-");
}

export class SetupCode {
	#digest: Buffer | undefined;

	constructor(private readonly dataDir: string) {}

	get file(): string {
		return join(this.dataDir, SETUP_CODE_FILE);
	}

	/** 现在有没有可用的初始化码。 */
	get active(): boolean {
		return this.#digest !== undefined;
	}

	/** 生成新的初始化码（之前的作废），写进只有属主可读的文件，返回码本身。 */
	async issue(): Promise<string> {
		const code = randomCode();
		this.#digest = digest(code);
		// 先建成只有属主能读写的文件再写内容：不要在 umask 允许别人读的权限下短暂存在。
		await writeFile(this.file, `${code}\n`, { mode: 0o600 });
		await chmod(this.file, 0o600);
		return code;
	}

	/** 码对不对：大小写、连字符、空白不敏感；没有可用的码时一律不对。 */
	verify(candidate: string): boolean {
		if (this.#digest === undefined) return false;
		return timingSafeEqual(digest(candidate), this.#digest);
	}

	/** 作废并删掉文件：用过之后，或者启动时已经有用户了。 */
	async discard(): Promise<void> {
		this.#digest = undefined;
		await rm(this.file, { force: true });
	}
}
