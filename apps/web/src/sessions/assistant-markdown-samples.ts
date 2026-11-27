// 助手的话（Markdown）的写法样本：每一种里都放了三种有害字符（从右到左覆盖、零宽空格、转义字符）。`AssistantMarkdown.test.ts` 逐个断言渲染结果里
// 没有原样的有害字符，`AssistantMarkdown.structure.test.ts` 断言每个文字节点都在 `UntrustedText` 里。
export const ESC = "\u001b";
export const RLO = "‮"; // 从右到左覆盖：让文字倒着显示
export const ZWSP = "​"; // 零宽空格：藏内容
// 不放方括号：放进链接文字、图片说明里会改变 Markdown 的括号配对（样本要测的是文字，不是链接的语法）。
export const BAD = `${RLO}drowssap${ZWSP}x${ESC}31m`;

// 审查（#762）发现块级的 HTML（行首的 `<div>`、`<script>`、`<!--`）在不开 rehype-raw 时成了根上或引用里的文字节点，不经任何组件。
export const CONSTRUCTS: [name: string, text: string][] = [
	["段落", `前面的话 ${BAD} 后面的话`],
	["标题", `# 标题 ${BAD}`],
	["无序列表", `- 一 ${BAD}\n- 二`],
	["有序列表", `1. 一 ${BAD}\n2. 二`],
	["嵌套列表", `- 外层\n  - 内层 ${BAD}`],
	["引用", `> 引用里的话 ${BAD}`],
	["嵌套引用", `> 外层\n>\n> > 内层 ${BAD}`],
	["加粗", `**粗 ${BAD}**`],
	["强调", `*斜 ${BAD}*`],
	["删除线", `~~删 ${BAD}~~`],
	["行内代码", `\`code ${BAD}\``],
	["代码块", `\`\`\`\ncode ${BAD}\n\`\`\``],
	["链接文字", `[文字 ${BAD}](https://example.com/a)`],
	["链接文字（不可点的协议）", `[文字 ${BAD}](javascript:alert(1))`],
	["自动识别的链接", `见 https://example.com/${ZWSP}a`],
	["图片的说明", `![说明 ${BAD}](http://127.0.0.1:1/x.png)`],
	["表格的单元格", `| 列 ${BAD} |\n|---|\n| 值 ${BAD} |`],
	["脚注", `正文[^1]\n\n[^1]: 脚注的话 ${BAD}`],
	// 块级的 HTML：react-markdown 不开 rehype-raw 时把它们当文字，位置在根上、引用里、列表项里、表格外。
	["HTML 块（在根上）", `<div>${BAD}</div>`],
	["HTML 块：script", `<script>${BAD}</script>`],
	["HTML 块：注释", `<!-- ${BAD} -->`],
	["HTML 块（在引用里）", `> <div>${BAD}</div>`],
	["HTML 块（在嵌套引用里）", `> > <div>${BAD}</div>`],
	["HTML 块（在列表项里）", `- <div>${BAD}</div>`],
	["行内 HTML", `前 <b>${BAD}</b> 后`],
	["行内 HTML（自闭合）", `前 <br/> ${BAD}`],
	["HTML 实体", `前 &#x202E; 后 &amp; ${BAD}`],
];
