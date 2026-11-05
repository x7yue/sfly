/**
 * 进程内互斥锁：控制面是单实例，所有改变运行/任务/Agent 状态的操作都串行执行，
 * 每个操作内部再用一个数据库事务落库，避免并发事件（结果上报、Agent 上下线、触发）交错。
 */
export class Mutex {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(() => fn());
		this.#tail = result.catch(() => {});
		return result;
	}
}
