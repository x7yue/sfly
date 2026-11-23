/**
 * 会出现在「经 …」、作者、命令行和日志里的名字（令牌的名称、用户的显示名、写操作的昵称）里不能有的字符：
 * - 控制字符（`\p{Cc}`：换行、制表、转义序列 ESC、DEL、NUL……）会把终端和日志弄乱，行分隔符、段分隔符（U+2028、U+2029）同理；
 * - 格式字符（`\p{Cf}`：零宽空格、零宽连接符、字节序标记、软连字符，以及双向文字的控制字符 U+202A–U+202E、U+2066–U+2069）
 *   看不见：两个看起来一模一样的名字可以同时有效，名字还能在控制台和终端里倒着显示。
 *
 * 代价：零宽连接符（U+200D）拼出来的组合 emoji（例如 👩‍💻）也被拒绝，单个的 emoji 不受影响。
 */
export const UNSAFE_NAME_CHARACTER = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** 名字里有没有上面说的字符。 */
export const hasUnsafeNameCharacter = (text: string): boolean => UNSAFE_NAME_CHARACTER.test(text);
