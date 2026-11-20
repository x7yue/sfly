import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * 读取器：不依赖 React 的普通对象，一个读取器对应一组读取条件（任务、范围、级别……）。它持有读到的状态
 * （合并规则）并决定什么时候读哪一页、什么时候接上实时流、哪些结果作废（读取时序）；向下只依赖自己声明的
 * 「读一页」「订阅实时」两个口，生产里是契约调用和事件流订阅，测试里是内存里的假日志。
 * 对外是当前状态（`get`、`subscribe`）和几个读取命令；条件变了就换一个读取器，旧的 `dispose`。
 */
export interface Reader<S> {
	get(): S;
	subscribe(listener: () => void): () => void;
	/** 作废还在途中的读取、断开实时流；之后不再改变状态，也不再发请求。 */
	dispose(): void;
}

/** 读取器状态的一格：整份状态只在这里改，改完通知订阅者。 */
export function createStore<S extends object>(initial: S) {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		/** 覆盖其中几个字段。 */
		set(patch: Partial<S>) {
			state = { ...state, ...patch };
			for (const listener of [...listeners]) listener();
		},
	};
}

/**
 * 一组读取条件的 key：条件不同，key 一定不同。没给的条件（`undefined`、`null`）和内容正好是 "undefined" 的字符串
 * 也分得开，所以不直接拼字符串。
 */
export const readerKey = (
	...conditions: readonly (string | number | boolean | null | undefined)[]
) => JSON.stringify(conditions.map((c) => c ?? null));

const NEVER_CHANGES = () => () => {};

/**
 * 把读取器接到组件上：`key` 变了就换一个新的读取器（`make` 新建，旧的 `dispose`，在途的结果作废），
 * 组件卸载时 `dispose`。`make` 返回 null 表示这组条件下不读（例如面板收起了）。读取器建好之前——第一次渲染，
 * 以及 `key` 刚变、新的读取器还没建好的那一次渲染——和 `idle` 一样，没有读到任何东西，不会显示上一个读取器的状态。
 * `idle` 要传模块级的常量：没有读取器时它就是 `useSyncExternalStore` 的快照，每次渲染都新建一个会让组件不停重渲染。
 */
export function useReader<S, R extends Reader<S>>(
	make: () => R | null,
	key: string,
	idle: S,
): { state: S; reader: R | null } {
	const makeRef = useRef(make);
	makeRef.current = make;
	const [made, setMade] = useState<{ key: string; reader: R | null } | null>(null);
	// key 就是读取条件，变了要换读取器；make 每次渲染都是新的，只读 ref
	useEffect(() => {
		const next = makeRef.current();
		setMade({ key, reader: next });
		return () => next?.dispose();
	}, [key]);
	const reader = made?.key === key ? made.reader : null;
	const state = useSyncExternalStore(
		reader ? reader.subscribe : NEVER_CHANGES,
		reader ? reader.get : () => idle,
	);
	return { state, reader };
}
