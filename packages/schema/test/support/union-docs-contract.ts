import { z } from "zod";

// 联合里同名的字段说明各是各的（#636、#662）：给 union-member-docs.test.ts 用的一份小契约（和真正的契约分开，
// 好把「同名字段在不同成员里说明不同」「一个成员有说明、另一个没有」这些情形都摆出来）。

/** 三个成员：`ref` 三处都有，A 和 B 说明不同、C 没有；`note` 只有 A 有说明；`shared` 都没有说明。 */
export const Event = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("a"),
		/** A 的 ref。 */
		ref: z.string(),
		/** A 的 note。 */
		note: z.string().optional(),
		shared: z.string(),
	}),
	z.object({
		type: z.literal("b"),
		/** B 的 ref。 */
		ref: z.string().optional(),
		/** B 独有的。 */
		extra: z.number(),
		shared: z.string(),
	}),
	z.object({ type: z.literal("c"), ref: z.string(), note: z.string(), shared: z.string() }),
	z.object({
		type: z.enum(["e"]),
		/** E 的 ref（`z.enum` 只有一项的也是取值固定的）。 */
		ref: z.string(),
	}),
	z.object({
		type: z.literal("d"),
		/** D 的 ref（可选的字面量成员也认得：`kind` 只是可选）。 */
		ref: z.string(),
		kind: z.literal("x").optional(),
	}),
]);

/** 平台事件那样：几个成员的 `type` 一样，靠 `kind` 区分。 */
export const Platform = z.discriminatedUnion("kind", [
	z.object({
		type: z.literal("platform"),
		kind: z.literal("commit"),
		/** 提交的 hash。 */
		hash: z.string(),
	}),
	z.object({
		type: z.literal("platform"),
		kind: z.literal("version"),
		/** 版本的 hash（和提交的不同）。 */
		hash: z.string(),
	}),
]);

/** 事件在数组里、可空的对象（只有一个内联的对象成员，路径不加段）、`$ref` 的成员（有自己的说明）。 */
export const Holder = z.object({
	events: z.array(Event),
	platform: Platform,
	maybe: z
		.object({
			/** x 的说明。 */
			x: z.string(),
		})
		.nullable(),
});

/** 认不出成员的联合：两个成员都没有取值固定的字段，同名的 `id` 说明不同。 */
export const Ambiguous = z.union([
	z.object({
		/** 第一个的 id。 */
		id: z.string(),
	}),
	z.object({
		/** 第二个的 id。 */
		id: z.string(),
		other: z.number(),
	}),
]);

/** 认不出成员，但同名的字段说明一样：不冲突。 */
export const AmbiguousSame = z.union([
	z.object({
		/** 一样的说明。 */
		id: z.string(),
	}),
	z.object({
		/** 一样的说明。 */
		id: z.string(),
		other: z.number(),
	}),
]);

/** 有自己的 root 的类型（生成的类型里是 `$ref`）和一个内联的对象在同一个联合里：内联的只有一个，路径不加一段。 */
export const Named = z.object({
	/** Named 里的 id。 */
	id: z.string(),
});
export const WithNamed = z.object({
	item: z.union([
		Named,
		z.object({
			/** 内联的 id。 */
			id: z.string(),
		}),
	]),
});

/** 对象和数组在同一个联合里：数组不算内联的对象，对象只有一个，路径不加一段。 */
export const ObjOrArray = z.object({
	v: z.union([
		z.object({
			/** v 的 a。 */
			a: z.string(),
		}),
		z.array(z.string()),
	]),
});

/** 联合套联合：TypeScript 把它摊平，生成的一边也要摊平，三个成员各带自己的一段。 */
export const Nested = z.object({
	n: z.union([
		z.union([
			z.object({
				type: z.literal("p"),
				/** P 的 id。 */
				id: z.string(),
			}),
			z.object({
				type: z.literal("q"),
				/** Q 的 id。 */
				id: z.string(),
			}),
		]),
		z.object({
			type: z.literal("r"),
			/** R 的 id。 */
			id: z.string(),
		}),
	]),
});

export const httpApis = {};
