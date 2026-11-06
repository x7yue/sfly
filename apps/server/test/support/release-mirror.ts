import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * 本地 GitHub Release 镜像桩（ADR 0012），随机端口，不访问外网；与 Agent 测试的桩
 * （agent/tests/support/mirror.rs）结构相同，只提供 uv：
 *
 *   <镜像>/astral-sh/uv/LatestRelease/uv-installer.sh                         安装脚本的桩
 *   <镜像>/astral-sh/uv/LatestRelease/uv-<arch>-unknown-linux-gnu.tar.gz      测试机上的 uv 打成的发布包
 *
 * 安装脚本的桩遵守真实 `uv-installer.sh` 的约定：从 `$UV_DOWNLOAD_URL` 下载，装到 `$UV_INSTALL_DIR/uv`，
 * 没有 `UV_NO_MODIFY_PATH=1` 时拒绝安装。
 */
export interface ReleaseMirror {
	/** 控制面配置的 GitHub Release 镜像地址。 */
	readonly url: string;
	/** 收到的请求路径（按到达顺序）。 */
	readonly requests: string[];
	/** 安装脚本被下载的次数。 */
	uvInstalls(): number;
	close(): Promise<void>;
}

const INSTALLER = "/github-release/astral-sh/uv/LatestRelease/uv-installer.sh";

const INSTALLER_STUB = `#!/bin/sh
# uv-installer.sh 的测试桩：按真实安装脚本的约定从 $UV_DOWNLOAD_URL 下载 uv，装到 $UV_INSTALL_DIR。
set -eu
if [ "\${UV_NO_MODIFY_PATH:-0}" != 1 ]; then
    echo "stub installer: UV_NO_MODIFY_PATH=1 is required (would modify PATH)" >&2
    exit 1
fi
target="uv-$(uname -m)-unknown-linux-gnu"
tmp="$(mktemp -d)"
curl -fsSL "$UV_DOWNLOAD_URL/$target.tar.gz" -o "$tmp/uv.tar.gz"
tar -xzf "$tmp/uv.tar.gz" -C "$tmp"
mkdir -p "$UV_INSTALL_DIR"
cp "$tmp/$target/uv" "$UV_INSTALL_DIR/uv"
rm -rf "$tmp"
echo "everything's installed!"
`;

/** 测试机 PATH 上的 uv 打成的发布包：[文件名, 内容]。 */
async function uvRelease(): Promise<[string, Buffer]> {
	const run = promisify(execFile);
	// uv run 把自己的可执行文件路径放在 $UV 里；PATH 上的 uv 可能是版本管理器（mise 等）的 shim，
	// 换了 HOME 或复制到别处就不能用。
	const uv =
		(await run("uv", ["run", "--no-project", "--", "sh", "-c", 'printf %s "$UV"'])).stdout.trim() ||
		(await run("sh", ["-c", "command -v uv"])).stdout.trim();
	const target = `uv-${arch() === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
	const dir = await mkdtemp(join(tmpdir(), "sfly-uv-release-"));
	try {
		await mkdir(join(dir, target));
		await copyFile(uv, join(dir, target, "uv"));
		await run("tar", ["-czf", join(dir, "uv.tar.gz"), "-C", dir, target]);
		return [`${target}.tar.gz`, await readFile(join(dir, "uv.tar.gz"))];
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function startReleaseMirror(): Promise<ReleaseMirror> {
	const [name, archive] = await uvRelease();
	const files = new Map<string, Buffer>([
		[INSTALLER, Buffer.from(INSTALLER_STUB)],
		[`/github-release/astral-sh/uv/LatestRelease/${name}`, archive],
	]);
	const requests: string[] = [];
	const server = createServer((req, res) => {
		const path = (req.url ?? "/").split(/[?#]/)[0] ?? "/";
		requests.push(path);
		const body = files.get(path);
		if (body) res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
		else res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/github-release`,
		requests,
		uvInstalls: () => requests.filter((p) => p === INSTALLER).length,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
