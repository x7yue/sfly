/**
 * 便签正文怎么显示（ADR 0026，单测见 sticky-text.test.ts）：以 `- ` 开头的行是列表的一项，连续的几项是一个列表；
 * 其余的行是普通段落，空行分开段落；不支持别的格式，文字原样显示。
 */
export type StickyBlock = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

export function stickyBlocks(text: string): StickyBlock[] {
	const blocks: StickyBlock[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		const last = blocks.at(-1);
		if (/^-\s/.test(line)) {
			const item = line.replace(/^-\s+/, "");
			if (last?.kind === "list") last.items.push(item);
			else blocks.push({ kind: "list", items: [item] });
		} else if (line.trim() === "") {
			blocks.push({ kind: "paragraph", text: "" });
		} else if (last?.kind === "paragraph" && last.text !== "") {
			last.text = `${last.text}\n${line}`;
		} else {
			blocks.push({ kind: "paragraph", text: line });
		}
	}
	return blocks.filter((b) => b.kind === "list" || b.text !== "");
}

/** 缩小视图时只显示的一行：标题，没有标题时是正文的第一行（去掉列表的 `- `）。 */
export function stickyHeadline(note: { title?: string | undefined; text: string }): string {
	if (note.title?.trim()) return note.title.trim();
	const first = note.text.trim().split("\n")[0] ?? "";
	return first.replace(/^-\s+/, "").trim();
}
