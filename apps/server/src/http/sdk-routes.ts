import { createReadStream } from "node:fs";
import { sdkApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { STD_PACKAGE, type StdIndex } from "../packages/std-index.js";
import type { PublicConfig } from "../public-config.js";
import { type SdkWheel, sdkWheelUrl } from "../sdk/sdk-wheels.js";
import { attachment } from "./content-disposition.js";
import { contractDownload, contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * SDK 运行时 wheel 的下载（Agent 安装进共享 venv，#1 评审；契约见 @sfly/schema 的 sdkApi）：
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/sdk/python` | `{ wheels: [{ version, filename, sha256, url }] }` |
 * | GET | `/sdk/python/:version/:filename` | 下载 wheel |
 * | GET | `/simple/` | 控制面的包索引（PEP 503）：`sfly` 和 `sfly-std` 两个项目 |
 * | GET | `/simple/sfly/` | 与控制面同版本的 wheel，链接带 `#sha256=` |
 * | GET | `/simple/sfly-std/` | 公共项目里已发布的 sfly-std 的 wheel（还没有发布时是没有版本的页面，不是 404） |
 * | GET | `/simple/sfly-std/files/:filename` | 下载其中一个 sfly-std wheel |
 * | GET | `/sdk/project-settings` | `sfly init` 写进新项目的版本、sfly 索引与镜像 |
 *
 * 索引只提供平台自己的两个包：不需要凭据（和 SDK wheel 的下载一样，ADR 0029 的「不属于项目」一类；理由见
 * docs/ARCHITECTURE.md §4.4「包索引」），经契约路由注册，启动守卫保证不会有绕过契约的入口。
 */
export function registerSdkRoutes(
	app: FastifyInstance,
	{
		wheels,
		publicConfig,
		stdIndex,
	}: { wheels: readonly SdkWheel[]; publicConfig: PublicConfig; stdIndex: StdIndex },
): void {
	const deps = {
		wheels,
		version: publicConfig.version,
		publicHttpUrl: publicConfig.httpUrl,
		mirrors: publicConfig.mirrors,
	};
	contractRoute(app, sdkApi.projectSettings, async () => {
		const githubRelease = deps.mirrors.githubRelease?.replace(/\/+$/, "");
		return {
			version: deps.version,
			sfly_index_url: `${deps.publicHttpUrl()}/simple/`,
			pypi_mirror: deps.mirrors.pypi || null,
			// 与 Agent（agent/src/environment.rs 的 Mirrors）和 install.sh 派生的地址相同。
			python_install_mirror: githubRelease
				? `${githubRelease}/astral-sh/python-build-standalone/`
				: null,
		};
	});

	contractRoute(app, sdkApi.wheels, async () => ({
		wheels: deps.wheels.map((w) => ({
			version: w.version,
			filename: w.filename,
			sha256: w.sha256,
			url: sdkWheelUrl(deps.publicHttpUrl(), w),
		})),
	}));

	contractDownload(app, sdkApi.wheel, async ({ params: { version, filename } }, reply) => {
		const wheel = deps.wheels.find((w) => w.version === version && w.filename === filename);
		if (!wheel) return sendError(reply, 404, "not_found", "SDK wheel not found");
		return reply
			.header("content-type", sdkApi.wheel.contentType)
			.header("content-disposition", attachment(wheel.filename))
			.send(createReadStream(wheel.file));
	});

	contractDownload(app, sdkApi.index, async (_request, reply) =>
		reply
			.header("content-type", sdkApi.index.contentType)
			.header("cache-control", "no-cache")
			.send(
				simplePage("控制面的包索引", [
					{ href: "sfly/", text: "sfly" },
					{ href: `${STD_PACKAGE}/`, text: STD_PACKAGE },
				]),
			),
	);

	contractDownload(app, sdkApi.indexProject, async ({ params }, reply) => {
		const name = normalizeProject(params.package);
		if (name !== "sfly" && name !== STD_PACKAGE) {
			return sendError(
				reply,
				404,
				"not_found",
				`控制面的包索引里只有 sfly 和 ${STD_PACKAGE}，没有 ${params.package}`,
			);
		}
		const links =
			name === "sfly"
				? // 只列出与控制面同版本的 wheel（ADR 0010：SDK 与控制面同版本）。
					deps.wheels
						.filter((w) => w.version === deps.version)
						.map((w) => ({
							href: `${sdkWheelUrl(deps.publicHttpUrl(), w)}#sha256=${w.sha256}`,
							text: w.filename,
						}))
				: (await stdIndex.wheels()).map((w) => ({
						href: `${stdWheelUrl(deps.publicHttpUrl(), w.filename)}#sha256=${w.sha256}`,
						text: w.filename,
						requiresPython: w.requiresPython,
					}));
		return reply
			.header("content-type", sdkApi.indexProject.contentType)
			.header("cache-control", "no-cache")
			.send(simplePage(name, links));
	});

	contractDownload(app, sdkApi.stdWheel, async ({ params: { filename } }, reply) => {
		const bytes = await stdIndex.read(filename);
		if (!bytes) {
			return sendError(reply, 404, "not_found", `包索引里没有 ${STD_PACKAGE} 的文件 ${filename}`);
		}
		return reply
			.header("content-type", sdkApi.stdWheel.contentType)
			.header("content-disposition", attachment(filename))
			.send(Buffer.from(bytes));
	});
}

/** sfly-std wheel 的下载地址（对 Agent 和开发机可见）。 */
const stdWheelUrl = (publicHttpUrl: string, filename: string) =>
	`${publicHttpUrl}/simple/${STD_PACKAGE}/files/${encodeURIComponent(filename)}`;

/** PEP 503 的项目名规范化。 */
const normalizeProject = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function simplePage(
	title: string,
	links: ReadonlyArray<{ href: string; text: string; requiresPython?: string }>,
): string {
	const body = links
		.map((l) => {
			// PEP 503：Requires-Python 写在 data-requires-python 里，uv 据此跳过 Python 版本不满足的 wheel。
			const requires =
				l.requiresPython === undefined
					? ""
					: ` data-requires-python="${escapeHtml(l.requiresPython)}"`;
			return `<a href="${escapeHtml(l.href)}"${requires}>${escapeHtml(l.text)}</a><br/>\n`;
		})
		.join("");
	return `<!DOCTYPE html>\n<html><head><meta name="pypi:repository-version" content="1.0"><title>${escapeHtml(title)}</title></head><body>\n${body}</body></html>\n`;
}
