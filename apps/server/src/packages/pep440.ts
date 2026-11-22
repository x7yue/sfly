/**
 * PEP 440 版本号的规范化和相等比较（附录 B 的正则）。包索引里的 wheel 文件名里的版本（构建工具规范化过的，
 * 例如 `0.4.0b1`）要和节点包归档登记的版本（pyproject.toml 里写的，例如 `0.4.0-beta.1`）比，写法不同也算同一个版本。
 */
const PEP440 =
	/^\s*v?(?:(?:(?<epoch>[0-9]+)!)?(?<release>[0-9]+(?:\.[0-9]+)*)(?<pre>[-_.]?(?<preLabel>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?<preNumber>[0-9]+)?)?(?<post>(?:-(?<postNumber1>[0-9]+))|(?:[-_.]?(?<postLabel>post|rev|r)[-_.]?(?<postNumber2>[0-9]+)?))?(?<dev>[-_.]?(?<devLabel>dev)[-_.]?(?<devNumber>[0-9]+)?)?)(?:\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

const PRE_LABEL: Record<string, string> = {
	alpha: "a",
	a: "a",
	beta: "b",
	b: "b",
	c: "rc",
	rc: "rc",
	pre: "rc",
	preview: "rc",
};

/**
 * 规范化后的版本号（比较用：发布段末尾的 0 去掉，`1.0` 和 `1.0.0` 是同一个版本）；不是合法的 PEP 440 版本号时返回 undefined。
 */
export function canonicalVersion(version: string): string | undefined {
	const groups = PEP440.exec(version)?.groups;
	if (!groups) return undefined;
	const release = (groups.release ?? "").split(".").map((part) => String(Number(part)));
	while (release.length > 1 && release[release.length - 1] === "0") release.pop();
	let text = release.join(".");
	const epoch = Number(groups.epoch ?? 0);
	if (epoch !== 0) text = `${epoch}!${text}`;
	if (groups.preLabel !== undefined) {
		text += `${PRE_LABEL[groups.preLabel.toLowerCase()]}${Number(groups.preNumber ?? 0)}`;
	}
	if (groups.post !== undefined) {
		text += `.post${Number(groups.postNumber1 ?? groups.postNumber2 ?? 0)}`;
	}
	if (groups.devLabel !== undefined) text += `.dev${Number(groups.devNumber ?? 0)}`;
	if (groups.local !== undefined) text += `+${groups.local.toLowerCase().replace(/[-_]/g, ".")}`;
	return text;
}

/** 两个版本号是同一个版本（PEP 440 的写法差异不算）；任何一个不是合法的版本号都算不同。 */
export function sameVersion(a: string, b: string): boolean {
	const left = canonicalVersion(a);
	return left !== undefined && left === canonicalVersion(b);
}
