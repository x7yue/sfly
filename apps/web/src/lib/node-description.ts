/**
 * 节点类型说明的第一段：到第一个空行为止。段内的折行是写代码时换的行，显示时并成一个空格。
 * 菜单和节点包管理页在标题下面显示它；全文在检查器的「说明」页。
 */
export const firstParagraph = (description: string | undefined): string | undefined => {
	const first = description
		?.split(/\n\s*\n/, 1)[0]
		?.replace(/\s*\n\s*/g, " ")
		.trim();
	return first || undefined;
};
