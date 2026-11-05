/**
 * 进程内按主题（例如编排 ID、运行 ID）的发布/订阅，供 SSE 路由订阅。
 * 发布是同步的；监听器抛出的异常不影响其他监听器。
 */
export class Topics<E> {
	readonly #listeners = new Map<string, Set<(event: E) => void>>();

	/** 订阅一个主题，返回取消订阅函数。 */
	subscribe(topic: string, listener: (event: E) => void): () => void {
		let set = this.#listeners.get(topic);
		if (!set) {
			set = new Set();
			this.#listeners.set(topic, set);
		}
		set.add(listener);
		return () => {
			const current = this.#listeners.get(topic);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.#listeners.delete(topic);
		};
	}

	publish(topic: string, event: E): void {
		for (const listener of [...(this.#listeners.get(topic) ?? [])]) {
			try {
				listener(event);
			} catch (error) {
				console.error(`topic ${topic} listener failed:`, error);
			}
		}
	}
}
