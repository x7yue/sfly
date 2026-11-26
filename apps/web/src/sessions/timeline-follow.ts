import { createContext } from "react";

/**
 * 时间线的「跟随」：内容变高之后，在底部的人要跟到最新（`use-timeline-scroll.ts` 的 `follow`）。时间线自己知道的是**事件到了**
 * （最后一行的长度变了），但逐字出现的助手的话被节流，**真正画出来**晚 120 毫秒，让内容变高的是那一次延后的渲染：它在
 * 渲染提交之后调用这个函数，在底部（跟随状态）的才滚，往上翻看的人不动。没有时间线包着（单独渲染一条助手的话）时什么都不做。
 */
export const FollowContext = createContext<() => void>(() => undefined);
