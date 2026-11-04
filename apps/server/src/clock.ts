/** 时钟接口：控制面里所有"现在几点"都从这里取，测试时注入手动时钟。 */
export interface Clock {
	now(): Date;
}

export const systemClock: Clock = {
	now: () => new Date(),
};
