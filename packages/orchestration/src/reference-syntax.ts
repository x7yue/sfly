/**
 * 引用语法（docs/SEMANTICS.md §2.2）：`${{ params.<name> }}` 和 `${{ nodes.<id>.outputs.<key> }}`。
 * 静态检查（references.ts）和派发时的解析（resolve.ts）共用这一份定义。
 */

/** 文本里的一个引用；捕获组 1 是引用路径。 */
export const REFERENCE = /\$\{\{\s*(.*?)\s*\}\}/g;
/** 整个值恰好是一个引用（整值引用保持原类型）。 */
export const WHOLE_REFERENCE = /^\$\{\{\s*(.*?)\s*\}\}$/;
/** `params.<name>`：捕获组 1 是参数名。 */
export const PARAM_PATH = /^params\.([A-Za-z_][A-Za-z0-9_]*)$/;
/** `nodes.<id>.outputs.<key>`：捕获组 1 是节点 ID，2 是输出键。 */
export const OUTPUT_PATH = /^nodes\.([^.\s]+)\.outputs\.([^.\s]+)$/;
