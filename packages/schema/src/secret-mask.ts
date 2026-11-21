/**
 * secret 参数的值被打码之后换成的掩码（docs/SEMANTICS.md §2.1）：日志、运行视图、运行预设和场景版本里 secret 参数的
 * 默认值，所有读取接口返回的都是它。读取方靠它认出「这里有值，但读不到」。
 */
export const SECRET_MASK = "******";

/**
 * 场景文档里这个入口参数的默认值是不是读取接口给的占位符：secret 参数的默认值读出来是 {@link SECRET_MASK}，
 * 原样存回去（下载、修改、再上传）表示沿用上一个版本里同名参数的默认值。所以 secret 参数的默认值写不成 `******` 本身。
 * 普通参数没有打码，默认值恰好是 `******` 就是 `******`。
 */
export const isSecretDefaultPlaceholder = (param: {
	secret?: boolean | undefined;
	default?: unknown;
}): boolean => param.secret === true && param.default === SECRET_MASK;
