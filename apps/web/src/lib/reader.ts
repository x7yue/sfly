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

const NEVER_CHANGES = () => () => {};

/**
 * 把读取器接到组件上：`key` 变了就换一个新的读取器（`make` 新建，旧的 `dispose`，在途的结果作废），
 * 组件卸载时 `dispose`。读取器建好之前（第一次渲染）和 `idle` 一样，没有读到任何东西。
 */
export function useReader<S, R extends Reader<S>>(
	make: () => R,
	key: string,
	idle: S,
): { state: S; reader: R | null } {
	const makeRef = useRef(make);
	makeRef.current = make;
	const [reader, setReader] = useState<R | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key 就是读取条件，变了要换读取器；make 每次渲染都是新的，只读 ref
	useEffect(() => {
		const next = makeRef.current();
		setReader(next);
		return () => next.dispose();
	}, [key]);
	const state = useSyncExternalStore(
		reader ? reader.subscribe : NEVER_CHANGES,
		reader ? reader.get : () => idle,
	);
	return { state, reader };
}
