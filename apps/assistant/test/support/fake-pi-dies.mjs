// 一起动就退出的假 pi，留一个子进程拿着标准输出 2 秒：助手服务写 set_steering_mode、prompt 的那一刻，pi 已经没了、
// 助手服务还没收到它退出（#677 复审的探测 G-mode）。
import { spawn } from "node:child_process";

spawn("sleep", ["2"], { stdio: ["ignore", "inherit", "ignore"] }).unref();
process.stdout.write(`${JSON.stringify({ type: "fake_died_at_start" })}\n`);
setTimeout(() => process.exit(0), 5);
