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

/**
 * 预设里的一个预设参数。secret 的值不会返回：`value` 是打码后的 `******`，要沿用它就在修改时写 `{name, keep: true}`
 * （{@link PresetParamInput}），要换掉它就重新给值。
 */
export const PresetParamView = z.object({
	name: z.string(),
	/**
	 * 值是不是打码的 secret：最新版本里这个参数声明为 secret，或者它已不在入口参数里
	 * （原来是不是 secret 无从判断，按 secret 处理）。以最新版本的声明为准，保存之后才变成 secret 的参数同样打码。
	 */
	secret: z.boolean(),
	/** 固定的值；secret 时是 `******`。 */
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

/**
 * 请求体里的一个预设参数：`{name, value}` 是参数名和固定的值；`{name, keep: true}` 沿用这个预设里这个 secret 参数原来的值
 * （接口不返回 secret 的原值，修改时不重新输入就写它），不能和 `value` 一起给。`keep` 只能用在最新版本里声明为 secret、
 * 并且这个预设里已经有值的参数上（所以新建时不能用）。两项都没有给时 400 `invalid_preset`，指出缺的是 `value`。
 */
export const PresetParamInput = z.strictObject({
	name: z.string(),
	value: z.unknown().optional(),
	keep: z.literal(true).optional(),
});

const IdParams = z.object({ id: z.string().min(1) });
const PresetIdParams = z.object({ id: z.string().min(1), presetId: z.string().min(1) });

/**
 * 修改预设的请求体：只写要改的项，至少一项。没有 `params` 就不改预设参数（只改名称或说明，失效的预设也可以改名）；
 * 给了 `params` 时它是预设参数的完整清单，和新建时按同样的规则检查。
 */
export const PresetChanges = z
	.strictObject({
		name: PresetName.optional(),
		description: PresetDescription.optional(),
		params: z.array(PresetParamInput).optional(),
	})
	.refine(
		(b) => b.name !== undefined || b.description !== undefined || b.params !== undefined,
		"没有要修改的字段",
	);

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
	 * 对照最新版本检查：参数已声明、值符合类型（不做类型转换，`json` 接受任何值）、字符串不为空，
	 * 至少一个参数，不能重复；secret 参数也能设为预设参数，值明文保存，所有响应里只返回打码后的值。
	 * 不通过时 400 `invalid_preset`，details 是 zod 格式的问题清单（`path` 指出字段，`message` 写明原因）；
	 * 入口节点没有声明参数（包括场景还没有版本）时同样是 `invalid_preset`；新建时没有原值可沿用，用 `keep` 也是 `invalid_preset`。
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
	/**
	 * 修改运行预设（需要昵称请求头，昵称和时间记为最后修改人）：立即生效，不产生新的场景版本；
	 * 两个人同时改时后保存的覆盖先保存的，不做冲突检测。请求体见 {@link PresetChanges}：没有 `params` 时只改名称和说明；
	 * 给了 `params` 时 400 `invalid_preset` 的规则同新建；其中 secret 参数不重新输入时写 `{name, keep: true}` 沿用原值，
	 * `keep` 用在非 secret 参数上，或者这个预设里原来没有值的参数上，同样是 `invalid_preset`。
	 * 请求体不符合要求（含没有任何要修改的字段）同样是 400 `invalid_preset`。
	 * 新名称被场景里别的预设占用时 409 `preset_name_taken`。预设不存在或不属于这个场景时 404 `preset_not_found`。
	 * 场景归档期间也能修改。
	 */
	update: endpoint({
		method: "PATCH",
		path: "/orchestrations/:id/presets/:presetId",
		client: true,
		key: ["presets", "update"],
		params: PresetIdParams,
		body: PresetChanges,
		requestError: () => ({ code: "invalid_preset" }),
		response: PresetView,
	}),
	/**
	 * 复制运行预设（201，需要昵称请求头）：在控制面复制，说明和预设参数（包括 secret 的值）不变，新的 ID，
	 * 请求体里是新名称（规则同新建），最后修改人记为复制的人。新名称已被占用时 409 `preset_name_taken`，
	 * 预设不存在或不属于这个场景时 404 `preset_not_found`。场景归档期间也能复制。
	 */
	copy: endpoint({
		method: "POST",
		path: "/orchestrations/:id/presets/:presetId/copy",
		client: true,
		key: ["presets", "copy"],
		params: PresetIdParams,
		body: z.strictObject({ name: PresetName }),
		requestError: () => ({ code: "invalid_preset" }),
		response: PresetView,
	}),
	/**
	 * 删除运行预设（204，需要昵称请求头）。已有运行上记下的预设 ID、名称和预设参数的名单不受影响。
	 * 预设不存在或不属于这个场景时 404 `preset_not_found`。场景归档期间也能删除。
	 */
	remove: endpoint({
		method: "DELETE",
		path: "/orchestrations/:id/presets/:presetId",
		client: true,
		key: ["presets", "remove"],
		params: PresetIdParams,
		response: z.undefined(),
	}),
};

export type PresetChanges = z.infer<typeof PresetChanges>;
export type PresetParamView = z.infer<typeof PresetParamView>;
export type PresetView = z.infer<typeof PresetView>;
export type PresetParamInput = z.infer<typeof PresetParamInput>;
