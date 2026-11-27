import { NICKNAME_HEADER } from "@sfly/schema";

// 产品代码不管：控制面要读这个请求头。
export const header = { [NICKNAME_HEADER]: "bob", other: "x-sfly-nickname-like" };
