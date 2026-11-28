import { NICKNAME_HEADER } from "@sfly/schema";

// 统一的辅助自己可以写。
export const actAs = (nickname: string) => ({ [NICKNAME_HEADER]: encodeURIComponent(nickname) });
export const literal = { "x-sfly-nickname": "bob" };
