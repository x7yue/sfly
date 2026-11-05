/** 可推送的异步队列：作为 gRPC 服务端流的出站消息队列。end() 后迭代在取完剩余元素后结束。 */
export class AsyncQueue<T> implements AsyncIterable<T> {
	#items: T[] = [];
	#wake: (() => void) | undefined;
	#ended = false;

	get ended(): boolean {
		return this.#ended;
	}

	/** 队列已结束时返回 false（消息被丢弃）。 */
	push(item: T): boolean {
		if (this.#ended) return false;
		this.#items.push(item);
		this.#wake?.();
		return true;
	}

	end(): void {
		this.#ended = true;
		this.#wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			const item = this.#items.shift();
			if (item !== undefined) {
				yield item;
				continue;
			}
			if (this.#ended) return;
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
			});
			this.#wake = undefined;
		}
	}
}
