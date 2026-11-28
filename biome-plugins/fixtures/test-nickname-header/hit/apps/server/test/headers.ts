// 导入它也算。
// @hit
import { NICKNAME_HEADER } from "@sfly/schema";

export const keyed = {
	"content-type": "application/json",
	// @hit
	"x-sfly-nickname": "bob",
};
// @hit
export const upper = new Headers([["X-Sfly-Nickname", "bob"]]);
// @hit
export const computed = { [NICKNAME_HEADER]: "bob" };
