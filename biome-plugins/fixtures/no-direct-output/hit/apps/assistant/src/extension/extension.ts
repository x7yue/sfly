// 跑在 pi 进程里的远程工具扩展也在范围里：它的标准错误由助手服务存下，同样只走统一的出口。
// @hit
const log = (line: string) => console.error(line);
export const say = (line: string) => log(line);
