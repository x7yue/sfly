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
 * 数字段规范化成十进制字符串（去掉先行零）：不用 `Number`，超过 2^53 的数字段（`1.0.9007199254740993`）会丢精度，
 * 两个不同的版本被判成同一个。
 */
const digits = (text: string): string => BigInt(text).toString();

/**
 * 本地版本标识（`+` 后面）规范化：小写，分隔符 `-`、`_`、`.` 都当 `.`，全是数字的段按数字比较（`01` 和 `1` 相同），
 * 其余的段按字母（PEP 440 的本地版本比较规则；Python 的 `packaging` 也是这样）。
 */
const canonicalLocal = (local: string): string =>
	local
		.toLowerCase()
		.split(/[-_.]/)
		.map((part) => (/^[0-9]+$/.test(part) ? digits(part) : part))
		.join(".");

/**
 * 规范化后的版本号（比较用：发布段末尾的 0 去掉，`1.0` 和 `1.0.0` 是同一个版本）；不是合法的 PEP 440 版本号时返回 undefined。
 * 所有数字段都按字符串比较，没有大小限制。
 */
export function canonicalVersion(version: string): string | undefined {
	const groups = PEP440.exec(version)?.groups;
	if (!groups) return undefined;
	const release = (groups.release ?? "").split(".").map(digits);
	while (release.length > 1 && release[release.length - 1] === "0") release.pop();
	let text = release.join(".");
	const epoch = digits(groups.epoch ?? "0");
	if (epoch !== "0") text = `${epoch}!${text}`;
	if (groups.preLabel !== undefined) {
		text += `${PRE_LABEL[groups.preLabel.toLowerCase()]}${digits(groups.preNumber ?? "0")}`;
	}
	if (groups.post !== undefined) {
		text += `.post${digits(groups.postNumber1 ?? groups.postNumber2 ?? "0")}`;
	}
	if (groups.devLabel !== undefined) text += `.dev${digits(groups.devNumber ?? "0")}`;
	if (groups.local !== undefined) text += `+${canonicalLocal(groups.local)}`;
	return text;
}

/** 两个版本号是同一个版本（PEP 440 的写法差异不算）；任何一个不是合法的版本号都算不同。 */
export function sameVersion(a: string, b: string): boolean {
	const left = canonicalVersion(a);
	return left !== undefined && left === canonicalVersion(b);
}
