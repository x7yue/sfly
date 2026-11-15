/**
 * 节点类型的说明（节点函数的文档字符串）分成段落：空行分段，段内的折行是写代码时换的行，并成一个空格。
 * 「添加节点」菜单、节点包管理页和检查器的「说明」页都用这一条规则。
 */
export const descriptionParagraphs = (description: string | undefined): string[] =>
	(description ?? "")
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
		.filter((paragraph) => paragraph !== "");

/** 说明的第一段：菜单和节点包管理页在标题下面显示它；全文在检查器的「说明」页。 */
export const firstParagraph = (description: string | undefined): string | undefined =>
	descriptionParagraphs(description)[0];
