import { createReadStream } from "node:fs";
import { sdkApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
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
 * | GET | `/simple/` | sfly 简单索引（PEP 503）：只有 `sfly` 项目 |
 * | GET | `/simple/sfly/` | 与控制面同版本的 wheel，链接带 `#sha256=` |
 * | GET | `/sdk/project-settings` | `sfly init` 写进新项目的版本、sfly 索引与镜像 |
 */
export function registerSdkRoutes(
	app: FastifyInstance,
	{ wheels, publicConfig }: { wheels: readonly SdkWheel[]; publicConfig: PublicConfig },
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
			.send(simplePage("sfly 简单索引", [{ href: "sfly/", text: "sfly" }])),
	);

	contractDownload(app, sdkApi.indexProject, async ({ params: { project } }, reply) => {
		if (normalizeProject(project) !== "sfly") {
			return sendError(reply, 404, "not_found", `sfly 索引里只有 sfly 项目，没有 ${project}`);
		}
		// 只列出与控制面同版本的 wheel（ADR 0010：SDK 与控制面同版本）。
		const links = deps.wheels
			.filter((w) => w.version === deps.version)
			.map((w) => ({
				href: `${sdkWheelUrl(deps.publicHttpUrl(), w)}#sha256=${w.sha256}`,
				text: w.filename,
			}));
		return reply
			.header("content-type", sdkApi.indexProject.contentType)
			.header("cache-control", "no-cache")
			.send(simplePage("sfly", links));
	});
}

/** PEP 503 的项目名规范化。 */
const normalizeProject = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function simplePage(title: string, links: ReadonlyArray<{ href: string; text: string }>): string {
	const body = links
		.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.text)}</a><br/>\n`)
		.join("");
	return `<!DOCTYPE html>\n<html><head><meta name="pypi:repository-version" content="1.0"><title>${escapeHtml(title)}</title></head><body>\n${body}</body></html>\n`;
}
