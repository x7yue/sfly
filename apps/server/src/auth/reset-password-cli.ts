// 主机上的重置命令（ADR 0029「认证的几处细节」）：管理员忘了密码时，在控制面所在的主机上执行
//   node main.mjs reset-password <登录名>                       在终端里输入两遍新密码（不回显）
//   echo '新密码' | node main.mjs reset-password <登录名> --password-stdin
// 容器里：`docker exec -it <容器> node /app/main.mjs reset-password <登录名>`。能登录主机就已经是最高权限，所以不要求旧密码。
// 连的是 `DATABASE_URL` 指向的数据库，不需要控制面在运行（也不影响它）。
import { NewPassword } from "@sfly/schema";
import { systemClock } from "../clock.js";
import { openDatabase } from "../db/database.js";
import { AccountService } from "./accounts.js";
import type { ScryptParams } from "./password.js";

export interface ResetPasswordIo {
	databaseUrl: string;
	stdin: NodeJS.ReadableStream;
	stdinIsTty: boolean;
	stdout: NodeJS.WritableStream;
	stderr: NodeJS.WritableStream;
	/** 终端里不回显地读一行；不给时用标准输入的原始模式（{@link readHiddenFromTty}）。 */
	readHidden?: (prompt: string) => Promise<string>;
	/** 密码哈希的参数，默认 scrypt 的默认参数；测试里调小。 */
	scrypt?: ScryptParams;
}

const USAGE = [
	"用法：node main.mjs reset-password <登录名> [--password-stdin]",
	"  默认在终端里输入两遍新密码（不回显）；--password-stdin 从标准输入读一行，供脚本使用。",
	"  连的是 DATABASE_URL 指向的数据库。重置之后他的全部登录注销（令牌不受影响）。",
].join("\n");

/** 从标准输入读第一行（去掉行尾的换行）。 */
async function readFirstLine(stdin: NodeJS.ReadableStream): Promise<string> {
	let text = "";
	for await (const chunk of stdin) {
		text += String(chunk);
		if (text.includes("\n")) break;
	}
	return text.split(/\r?\n/)[0] ?? "";
}

/** 在真实终端里不回显地读一行（原始模式，退格能用，Ctrl-C 中止）。 */
export function readHiddenFromTty(prompt: string): Promise<string> {
	const stdin = process.stdin;
	return new Promise((resolve, reject) => {
		process.stdout.write(prompt);
		let value = "";
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		const finish = () => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off("data", onData);
			process.stdout.write("\n");
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n" || char === "\u0004") {
					finish();
					resolve(value);
					return;
				}
				if (char === "\u0003") {
					finish();
					reject(new Error("已取消"));
					return;
				}
				if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
				else value += char;
			}
		};
		stdin.on("data", onData);
	});
}

/** 命令的退出码：0 成功，1 失败（用户不存在、密码不合格、连不上数据库），2 用法不对。 */
export async function runResetPassword(argv: string[], io: ResetPasswordIo): Promise<number> {
	const say = (text: string) => io.stdout.write(`${text}\n`);
	const fail = (text: string) => io.stderr.write(`${text}\n`);
	const fromStdin = argv.includes("--password-stdin");
	const names = argv.filter((arg) => !arg.startsWith("--"));
	const unknown = argv.filter((arg) => arg.startsWith("--") && arg !== "--password-stdin");
	const loginName = names[0];
	if (loginName === undefined || names.length > 1 || unknown.length > 0) {
		fail(USAGE);
		return 2;
	}
	if (!fromStdin && !io.stdinIsTty) {
		fail(`标准输入不是终端，读不了密码：加 --password-stdin 从标准输入读一行。\n${USAGE}`);
		return 2;
	}

	let password: string;
	if (fromStdin) {
		password = await readFirstLine(io.stdin);
	} else {
		const read = io.readHidden ?? readHiddenFromTty;
		for (;;) {
			const first = await read("新密码：");
			const again = await read("再输入一遍：");
			if (first === again) {
				password = first;
				break;
			}
			fail("两次输入不一致，重新来。");
		}
	}
	const valid = NewPassword.safeParse(password);
	if (!valid.success) {
		fail(valid.error.issues.map((issue) => issue.message).join("；"));
		return 1;
	}

	const database = openDatabase(io.databaseUrl, () => {});
	try {
		const accounts = new AccountService({
			db: database.db,
			clock: systemClock,
			scrypt: io.scrypt,
		});
		let user: Awaited<ReturnType<AccountService["findByLoginName"]>>;
		try {
			user = await accounts.findByLoginName(loginName);
		} catch (error) {
			fail(
				`连不上数据库（DATABASE_URL）：${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		}
		if (user === undefined) {
			fail(`没有登录名是 ${loginName} 的用户`);
			return 1;
		}
		await accounts.resetPassword(user.id, password);
		say(`已重置 ${user.loginName} 的密码，他的全部登录已注销（令牌不受影响）。`);
		return 0;
	} finally {
		await database.close().catch(() => {});
	}
}
