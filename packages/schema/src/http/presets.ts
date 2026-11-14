import { z } from "zod";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 运行预设（GLOSSARY「运行预设」，ADR 0023）相关接口的契约（约定见 ./contract.ts）。
 *
 * 运行预设是场景的设置，和运行通知一样不属于场景版本：增删改立即生效，不产生新版本。
 * 每个预设固定入口节点的一部分参数（预设参数），按参数名称对照场景最新版本的入口参数声明。
 * 触发时带上预设的 ID（runsApi.trigger 的 `preset`），预设参数由控制面填入预设的值。
 */

/** 预设名称的长度上限（字符数，去掉首尾空白之后）。 */
export const PRESET_NAME_MAX = 40;
/** 预设说明的长度上限（字符数）。 */
export const PRESET_DESCRIPTION_MAX = 200;

/** 预设名称：去掉首尾空白后 1 到 {@link PRESET_NAME_MAX} 个字符，场景内唯一（区分大小写）。 */
export const PresetName = z
	.string()
	.trim()
	.min(1, "名称不能为空")
	.max(PRESET_NAME_MAX, `名称不能超过 ${PRESET_NAME_MAX} 个字符`);

/** 预设说明：不超过 {@link PRESET_DESCRIPTION_MAX} 个字符。 */
export const PresetDescription = z
	.string()
	.trim()
	.max(PRESET_DESCRIPTION_MAX, `说明不能超过 ${PRESET_DESCRIPTION_MAX} 个字符`);

/** 预设里的一个预设参数。 */
export const PresetParamView = z.object({
	name: z.string(),
	/** 最新版本里这个参数是不是 secret。 */
	secret: z.boolean(),
	/** 固定的值。 */
	value: z.unknown(),
});

export const PresetView = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	/** 预设参数，按最新版本入口参数的声明顺序。 */
	params: z.array(PresetParamView),
	/** 最后修改人的昵称。 */
	updated_by: z.string(),
	updated_at: Timestamp,
});

/** 新建预设时的一个预设参数：参数名和固定的值。 */
export const PresetParamInput = z.strictObject({ name: z.string(), value: z.unknown() });

const IdParams = z.object({ id: z.string().min(1) });

export const presetsApi = {
	/** 场景的运行预设，按名称排序。场景不存在时 404 `not_found`。 */
	list: endpoint({
		method: "GET",
		path: "/orchestrations/:id/presets",
		client: true,
		key: ["presets", "list"],
		params: IdParams,
		response: z.object({ presets: z.array(PresetView) }),
	}),
	/**
	 * 新建运行预设（201，需要昵称请求头，昵称记为最后修改人）。`params` 是预设参数的完整清单，
	 * 对照最新版本检查：参数已声明、不是 secret、值符合类型（不做类型转换，`json` 接受任何值）、字符串不为空，
	 * 至少一个参数，不能重复。不通过时 400 `invalid_preset`，details 是 zod 格式的问题清单（`path` 指出字段，
	 * `message` 写明原因）；入口节点没有声明参数（包括场景还没有版本）时同样是 `invalid_preset`。
	 * 名称在场景内已被占用时 409 `preset_name_taken`。场景不存在时 404 `not_found`。
	 */
	create: endpoint({
		method: "POST",
		path: "/orchestrations/:id/presets",
		client: true,
		key: ["presets", "create"],
		params: IdParams,
		body: z.strictObject({
			name: PresetName,
			description: PresetDescription.default(""),
			params: z.array(PresetParamInput),
		}),
		requestError: () => ({ code: "invalid_preset" }),
		response: PresetView,
	}),
};

export type PresetParamView = z.infer<typeof PresetParamView>;
export type PresetView = z.infer<typeof PresetView>;
export type PresetParamInput = z.infer<typeof PresetParamInput>;
