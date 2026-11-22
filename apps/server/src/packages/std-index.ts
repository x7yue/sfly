import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { PUBLIC_PROJECT } from "../projects/project-id.js";
import type { PackageRepository } from "./package-repository.js";

/**
 * 标准节点包 sfly-std 在控制面的包索引里（#556，docs/ARCHITECTURE.md §4.4）。
 *
 * 一个节点包可以依赖平台自己的包 sfly-std（它不在 PyPI 上）：Agent 装节点包的依赖时把控制面的 `/simple/` 作为优先于
 * PyPI 镜像的索引（Welcome 的 `package_index_url`），开发机的 `sfly init` 项目也把 `sfly-std` 指向它。索引里的 sfly-std
 * 就是公共项目里已经发布的版本（ADR 0029：平台维护的包放在公共项目，只有平台管理员能发布），wheel 取自节点包归档
 * （`.sflypkg` 根目录里唯一的 wheel）。
 *
 * - **只有 sfly-std 这一个名字**，且只来自公共项目：别的项目里发布的 sfly-std 版本、公共项目里别的名字的包都不在索引里
 *   （索引不是「任意节点包的下载」）。
 * - **这个名字一直有回应**：公共项目里还没有 sfly-std 时，项目页是 200 和一个没有任何版本的页面，不是 404。uv 对一个名字只看
 *   第一个有回应的索引（first-index），404 才会转去下一个索引（PyPI）；所以没发布时依赖它的节点包装不上（uv 报「没有这个包的版本」），
 *   不会装上 PyPI 上有人放的同名包。
 * - 归档和 wheel 都不可变（`名字@版本` 不能覆盖），所以每个归档的 wheel 摘要算一次、按归档的 sha256 缓存。
 */
export const STD_PACKAGE = "sfly-std";

/** 索引里的一个 sfly-std wheel。 */
export interface StdWheel {
	version: string;
	filename: string;
	/** wheel 本身的 sha256（PEP 503 链接里的 `#sha256=`），不是归档的。 */
	sha256: string;
	requiresPython: string;
}

/** wheel 的文件名（PEP 427）里的发行版名：`sfly_std`。 */
const DISTRIBUTION = "sfly_std";

interface Cached {
	filename: string;
	sha256: string;
}

export function createStdIndex({
	packages,
	onSkipped,
}: {
	packages: PackageRepository;
	/** 某个版本因为归档读不出来、里面的 wheel 不是 sfly_std 的而没有列出：报告，不让整个索引失败。 */
	onSkipped: (version: string, reason: string) => void;
}) {
	// 键是归档的 sha256；归档不可变，缓存永远有效。
	const cache = new Map<string, Cached | null>();

	async function wheelOf(archive: { path: string; sha256: string }): Promise<Cached | undefined> {
		if (cache.has(archive.sha256)) return cache.get(archive.sha256) ?? undefined;
		const found = extractWheel(new Uint8Array(await readFile(archive.path)));
		const cached = found && { filename: found.filename, sha256: sha256(found.bytes) };
		cache.set(archive.sha256, cached ?? null);
		return cached;
	}

	/** 公共项目里已发布的 sfly-std 版本和它们的 wheel，按发布的先后；读不出 wheel 的版本跳过并报告。 */
	async function entries() {
		const found: Array<{ wheel: StdWheel; archive: { path: string } }> = [];
		for (const archive of await packages.archivesIn(PUBLIC_PROJECT, STD_PACKAGE)) {
			try {
				const wheel = await wheelOf(archive);
				if (!wheel?.filename.startsWith(`${DISTRIBUTION}-`)) {
					onSkipped(
						archive.version,
						`归档里的 wheel 不是 ${DISTRIBUTION} 的：${wheel?.filename ?? "没有 wheel"}`,
					);
					continue;
				}
				found.push({
					wheel: {
						version: archive.version,
						filename: wheel.filename,
						sha256: wheel.sha256,
						requiresPython: archive.requiresPython,
					},
					archive,
				});
			} catch (error) {
				onSkipped(archive.version, error instanceof Error ? error.message : String(error));
			}
		}
		return found;
	}

	return {
		/** 公共项目里已发布的 sfly-std 的 wheel，按发布的先后。 */
		async wheels(): Promise<StdWheel[]> {
			return (await entries()).map((e) => e.wheel);
		},

		/** 按文件名取一个 wheel 的内容；不在索引里（没有这个文件名，或属于别的项目）时返回 undefined。 */
		async read(filename: string): Promise<Uint8Array | undefined> {
			const found = (await entries()).find((e) => e.wheel.filename === filename);
			if (!found) return undefined;
			return extractWheel(new Uint8Array(await readFile(found.archive.path)))?.bytes;
		},
	};
}

export type StdIndex = ReturnType<typeof createStdIndex>;

/** 节点包归档根目录里唯一的 wheel（和 Agent 装包时取的一样，Agent 的 `extract_wheel`）。 */
function extractWheel(archive: Uint8Array): { filename: string; bytes: Uint8Array } | undefined {
	const entries = unzipSync(archive, {
		filter: (file) => !file.name.includes("/") && file.name.endsWith(".whl"),
	});
	const names = Object.keys(entries);
	const [name] = names;
	const bytes = name === undefined ? undefined : entries[name];
	return names.length === 1 && name !== undefined && bytes !== undefined
		? { filename: name, bytes }
		: undefined;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
